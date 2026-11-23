import { isSwitchport } from "./vlanInterfaces.ts";
import type { Device, Endpoint, Port, Topology } from "./types.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
import { linkUp } from "./model.ts";
import { bpduGuardDown } from "./portProtection.ts";
import { securityDown } from "./portSecurity.ts";

export type DiscoveryProtocol = "cdp" | "lldp";
export interface Neighbor {
  protocol: DiscoveryProtocol;
  local: Endpoint;
  remote: Endpoint;
  name: string;
  interfaceName: string;
  kind: Device["kind"];
  address: string;
  voiceVlan?: number;
  received: number;
  expires: number;
}
const protocols = ["cdp", "lldp"] as const;
const timing = {
  cdp: { period: 60, hold: 180 },
  lldp: { period: 30, hold: 120 },
};
export function discoveryCapable(d: Device) {
  return d.kind === "router" || d.kind === "switch" || d.kind === "phone";
}
export function discoveryEnabled(d: Device, protocol: DiscoveryProtocol) {
  return (
    discoveryCapable(d) &&
    (d[protocol] ?? (protocol === "cdp" || d.kind === "phone"))
  );
}
function canExchange(
  d: Device,
  p: Port,
  protocol: DiscoveryProtocol,
  transmit: boolean,
) {
  if (p.media === "serial" && protocol === "lldp") return false;
  if (!discoveryEnabled(d, protocol) || (d.kind === "phone" && p.id !== "p0"))
    return false;
  return protocol === "cdp"
    ? p.cdp !== false
    : (transmit ? p.lldpTransmit : p.lldpReceive) !== false;
}

// A virtual-clock jump can skip many intervals. Only the last advertisement
// in each direction matters for the current neighbor table.
export function updateDiscovery(t: Topology, r: NetworkRuntime) {
  if (r.discoveryTick === r.time) return;
  const previous = r.discoveryTick;
  r.discoveryTick = r.time;
  const devices = new Map(t.devices.map((d) => [d.id, d]));
  for (const link of t.links) {
    if (
      !linkUp(t, link, r) ||
      [link.a, link.b].some((e) => securityDown(r, e.device, e.port))
    )
      continue;
    for (const [local, remote] of [
      [link.a, link.b],
      [link.b, link.a],
    ]) {
      const receiver = devices.get(local.device)!,
        sender = devices.get(remote.device)!;
      const input = receiver.ports.find((p) => p.id === local.port)!,
        output = sender.ports.find((p) => p.id === remote.port)!;
      for (const protocol of protocols) {
        const { period, hold } = timing[protocol];
        if (
          !canExchange(receiver, input, protocol, false) ||
          !canExchange(sender, output, protocol, true)
        )
          continue;
        const received =
          previous === undefined
            ? r.time
            : Math.floor(r.time / period) * period;
        if (previous !== undefined && received <= previous) continue;
        const entry: Neighbor = {
          protocol,
          local,
          remote,
          name: sender.name,
          interfaceName: output.name,
          kind: sender.kind,
          address:
            output.ip || sender.ports.find((p) => p.enabled && p.ip)?.ip || "",
          received,
          expires: received + hold,
        };
        if (
          isSwitchport(sender, output) &&
          output.mode === "access" &&
          output.voiceVlan
        )
          entry.voiceVlan = output.voiceVlan;
        const index = r.neighbors.findIndex(
          (n) =>
            n.local.device === local.device &&
            n.local.port === local.port &&
            n.protocol === protocol,
        );
        if (index === -1) r.neighbors.push(entry);
        else r.neighbors[index] = entry;
      }
    }
  }
  pruneNeighbors(t, r);
}
export function pruneNeighbors(t: Topology, r: NetworkRuntime) {
  r.neighbors = r.neighbors.filter((n) => {
    const device = t.devices.find((d) => d.id === n.local.device);
    const port = device?.ports.find((p) => p.id === n.local.port);
    return (
      n.expires > r.time &&
      !bpduGuardDown(r, n.local.device, n.local.port) &&
      !bpduGuardDown(r, n.remote.device, n.remote.port) &&
      device?.powered &&
      port?.enabled &&
      canExchange(device, port, n.protocol, false)
    );
  });
}
export function phoneVoiceVlan(
  t: Topology,
  phone: Device,
  r?: NetworkRuntime,
): number | undefined {
  if (r) {
    for (const protocol of protocols) {
      const policy = r.neighbors.find(
        (n) =>
          n.local.device === phone.id &&
          n.local.port === "p0" &&
          n.protocol === protocol &&
          n.voiceVlan &&
          n.expires > r.time,
      );
      if (policy) return policy.voiceVlan;
    }
    return undefined;
  }
  // Structural routing queries have no clock. Use the policy the adjacent switch
  // can advertise; frame delivery independently enforces the received policy.
  const cable = t.links.find((l) =>
    [l.a, l.b].some((e) => e.device === phone.id && e.port === "p0"),
  );
  if (!cable || !linkUp(t, cable)) return undefined;
  const other = cable.a.device === phone.id ? cable.b : cable.a;
  const sw = t.devices.find((d) => d.id === other.device),
    port = sw?.ports.find((p) => p.id === other.port);
  if (!sw || !port || !isSwitchport(sw, port) || port.mode !== "access")
    return undefined;
  return protocols.some(
    (protocol) =>
      canExchange(sw, port, protocol, true) &&
      canExchange(phone, phone.ports[0], protocol, false),
  )
    ? port.voiceVlan
    : undefined;
}
