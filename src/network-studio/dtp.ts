import type { Device, Endpoint, Port, Topology } from "./types.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
import { isSwitchport } from "./vlanInterfaces.ts";
import { linkUp } from "./model.ts";
import { securityDown } from "./portSecurity.ts";
import { forwardingLinks } from "./etherChannel.ts";

export const dynamicSwitchport = (p: Port): boolean =>
  p.mode === "dynamic-auto" || p.mode === "dynamic-desirable";

export function validateDtp(d: Pick<Device, "kind" | "ports">): void {
  for (const p of d.ports) {
    if (
      !["access", "trunk", "dynamic-auto", "dynamic-desirable"].includes(p.mode)
    )
      throw Error("Unsupported switch port mode.");
    if (
      (dynamicSwitchport(p) || p.nonegotiate !== undefined) &&
      (!isSwitchport(d, p) || !["copper", "fiber"].includes(p.media))
    )
      throw Error("DTP settings require a Layer 2 switch Ethernet interface.");
    if (p.nonegotiate !== undefined && typeof p.nonegotiate !== "boolean")
      throw Error("Invalid DTP negotiation setting.");
    if (dynamicSwitchport(p) && p.nonegotiate)
      throw Error("Dynamic switchports cannot disable DTP negotiation.");
    if (dynamicSwitchport(p) && p.security)
      throw Error("Port security requires a static access or trunk mode.");
  }
}

/** Local administrative policy plus the directly received peer advertisement. */
export function negotiatedSwitchport(
  d: Device,
  p: Port,
  peer?: Device,
  remote?: Port,
): { mode: "access" | "trunk"; reason: string } {
  if (!dynamicSwitchport(p))
    return {
      mode: p.mode === "trunk" ? "trunk" : "access",
      reason:
        p.mode === "trunk"
          ? "Administratively forced trunk."
          : "Administratively forced access.",
    };
  if (!peer || !remote || !isSwitchport(peer, remote))
    return {
      mode: "access",
      reason: "No DTP-capable switch peer; using the access VLAN.",
    };
  if (remote.nonegotiate)
    return {
      mode: "access",
      reason: "Peer disabled DTP negotiation; using the access VLAN.",
    };
  if ((d.vtp?.domain ?? "") !== (peer.vtp?.domain ?? ""))
    return {
      mode: "access",
      reason: "VTP domains differ; DTP cannot negotiate a trunk.",
    };
  if (remote.mode === "access")
    return {
      mode: "access",
      reason: "Peer is administratively access; using the access VLAN.",
    };
  if (p.mode === "dynamic-auto" && remote.mode === "dynamic-auto")
    return {
      mode: "access",
      reason: "Both peers are dynamic auto; neither initiates trunking.",
    };
  return {
    mode: "trunk",
    reason: "Compatible DTP advertisements negotiated an 802.1Q trunk.",
  };
}

export type SwitchportState = {
  administrative: Port["mode"];
  operational: "access" | "trunk" | "down" | "routed";
  mode: "access" | "trunk";
  up: boolean;
  negotiation: boolean;
  peer?: Endpoint;
  reason: string;
};

/** Derived on demand: peer, domain, carrier and protection changes cannot leave stale state. */
export function switchportState(
  t: Topology,
  deviceId: string,
  portId: string,
  r?: NetworkRuntime,
): SwitchportState {
  const d = t.devices.find((d) => d.id === deviceId),
    p = d?.ports.find((p) => p.id === portId);
  if (!d || !p) throw Error("Switch interface does not exist.");
  const switching = isSwitchport(d, p);
  const base = {
    administrative: p.mode,
    mode: p.mode === "trunk" ? ("trunk" as const) : ("access" as const),
    negotiation: switching && !p.nonegotiate,
  };
  // Channel membership depends on administrative compatibility, not this view,
  // so resolving a logical peer cannot recurse through operational trunk state.
  const link =
    p.virtual?.kind === "portchannel"
      ? forwardingLinks(t, r).find((l) =>
          [l.a, l.b].some((e) => e.device === deviceId && e.port === portId),
        )
      : t.links.find((l) =>
          [l.a, l.b].some((e) => e.device === deviceId && e.port === portId),
        );
  const peer =
    link &&
    (link.a.device === deviceId && link.a.port === portId ? link.b : link.a);
  const remoteDevice = peer && t.devices.find((d) => d.id === peer.device),
    remotePort = remoteDevice?.ports.find((p) => p.id === peer!.port);
  const up = !!(
    d.powered &&
    p.enabled &&
    link &&
    (p.virtual?.kind === "portchannel" ||
      ("cable" in link && linkUp(t, link, r))) &&
    (!r ||
      (!securityDown(r, deviceId, portId) &&
        (!peer || !securityDown(r, peer.device, peer.port))))
  );
  if (!up)
    return {
      ...base,
      ...(peer ? { peer } : {}),
      up: false,
      operational: "down",
      reason: "No operational link.",
    };
  if (!switching)
    return {
      ...base,
      peer,
      up,
      negotiation: false,
      operational: "routed",
      reason: "Routed interface; DTP is inactive.",
    };
  const result = negotiatedSwitchport(d, p, remoteDevice, remotePort);
  return { ...base, ...result, peer, up, operational: result.mode };
}

/** An ephemeral forwarding view. Stored administrative settings remain untouched. */
export function operationalSwitchport(
  t: Topology,
  d: Device,
  p: Port,
  r?: NetworkRuntime,
): Port {
  if (!dynamicSwitchport(p) || !isSwitchport(d, p)) return p;
  return { ...p, mode: switchportState(t, d.id, p.id, r).mode };
}
