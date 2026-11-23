import type { Device, Endpoint, Port, Topology } from "./types.ts";
import type { BpduPortState, NetworkRuntime } from "./networkRuntime.ts";
import { isSwitchport } from "./vlanInterfaces.ts";
import { linkStatus } from "./model.ts";
import { securityDown } from "./portSecurity.ts";
import { bpduGuardDown } from "./portProtection.ts";
import { operationalSwitchport } from "./dtp.ts";
export { bpduGuardDown } from "./portProtection.ts";

function protectionSettings(d: Device, p: Port): Port {
  if (!p.channelGroup) return p;
  const po = d.ports.find(
    (candidate) =>
      candidate.virtual?.kind === "portchannel" &&
      candidate.virtual.group === p.channelGroup!.id,
  );
  return po
    ? {
        ...p,
        portFast: p.portFast ?? po.portFast,
        bpduGuard: p.bpduGuard ?? po.bpduGuard,
      }
    : p;
}
export function configuredPortFast(
  d: Device,
  p: Port,
  t?: Topology,
  r?: NetworkRuntime,
): boolean {
  p = protectionSettings(d, p);
  if (t) p = operationalSwitchport(t, d, p, r);
  if (!isSwitchport(d, p) || p.portFast === "disable") return false;
  if (p.portFast === "trunk") return true;
  return (
    p.mode === "access" &&
    (p.portFast === "enable" || !!d.spanningTree?.portFastDefault)
  );
}
/** Operational edge eligibility; callers display physical carrier separately. */
export function operationalPortFast(
  d: Device,
  p: Port,
  r?: NetworkRuntime,
  t?: Topology,
): boolean {
  return (
    d.powered &&
    p.enabled &&
    configuredPortFast(d, p, t, r) &&
    (!r ||
      (!bpduGuardDown(r, d.id, p.id) &&
        !securityDown(r, d.id, p.id) &&
        !r.bpduPorts.some(
          (s) =>
            s.device === d.id &&
            s.edgeLost &&
            (s.port === p.id ||
              (p.virtual?.kind === "portchannel" &&
                d.ports.some(
                  (member) =>
                    member.id === s.port &&
                    member.channelGroup?.id ===
                      (p.virtual?.kind === "portchannel"
                        ? p.virtual.group
                        : undefined),
                ))),
        )))
  );
}
export function effectiveBpduGuard(
  d: Device,
  p: Port,
  r?: NetworkRuntime,
  t?: Topology,
): boolean {
  p = protectionSettings(d, p);
  if (!isSwitchport(d, p) || p.bpduGuard === "disable") return false;
  return (
    p.bpduGuard === "enable" ||
    (!!d.spanningTree?.bpduGuardDefault && operationalPortFast(d, p, r, t))
  );
}
export function bpduGuardDeadline(
  d: Device | undefined,
  state: BpduPortState | undefined,
): number | undefined {
  return d?.bpduGuardRecovery && state?.shutdownAt !== undefined
    ? state.shutdownAt + (d.securityRecovery?.interval ?? 300)
    : undefined;
}
export function clearBpduState(
  r: NetworkRuntime,
  deviceId?: string,
  portId?: string,
): void {
  r.bpduPorts = r.bpduPorts.filter(
    (s) =>
      (deviceId !== undefined && s.device !== deviceId) ||
      (portId !== undefined && s.port !== portId),
  );
}
function localLink(
  t: Topology,
  device: string,
  port: string,
): string | undefined {
  const link = t.links.find((l) =>
    [l.a, l.b].some((e) => e.device === device && e.port === port),
  );
  return link?.id;
}
/** Local shutdown/power/routed conversion clears protection; remote changes do not clear a latch. */
export function pruneBpduState(t: Topology, r: NetworkRuntime): void {
  r.bpduPorts = r.bpduPorts.filter((s) => {
    const d = t.devices.find((d) => d.id === s.device),
      p = d?.ports.find((p) => p.id === s.port);
    if (!d?.powered || !p?.enabled || !isSwitchport(d, p)) return false;
    if (
      p.channelGroup &&
      d.ports.some(
        (po) =>
          po.virtual?.kind === "portchannel" &&
          po.virtual.group === p.channelGroup!.id &&
          !po.enabled,
      )
    )
      return false;
    if (s.shutdownAt === undefined && s.link !== localLink(t, s.device, s.port))
      return false;
    return true;
  });
}
export function synchronizeBpduGuard(t: Topology, r: NetworkRuntime): void {
  pruneBpduState(t, r);
  const recovered = new Map<
    string,
    { at: number; cycles: number; previous: number }
  >();
  for (const s of r.bpduPorts) {
    const d = t.devices.find((d) => d.id === s.device),
      due = bpduGuardDeadline(d, s);
    if (due === undefined || due > r.time) continue;
    const interval = d!.securityRecovery?.interval ?? 300;
    const cycles = Math.floor((r.time - s.shutdownAt!) / interval);
    recovered.set(s.device + "/" + s.port, {
      at: s.shutdownAt! + cycles * interval,
      cycles,
      previous: s.shutdownAt!,
    });
    delete s.shutdownAt;
    s.edgeLost = false;
  }
  // Snapshot direct switch BPDUs before applying any latch, including blocked STP ports.
  const arrivals: {
    device: Device;
    port: Port;
    peer: Endpoint;
    link: string;
  }[] = [];
  for (const link of t.links) {
    if (
      !linkStatus(t, link, r).up ||
      securityDown(r, link.a.device, link.a.port) ||
      securityDown(r, link.b.device, link.b.port)
    )
      continue;
    const a = t.devices.find((d) => d.id === link.a.device),
      b = t.devices.find((d) => d.id === link.b.device);
    const ap = a?.ports.find((p) => p.id === link.a.port),
      bp = b?.ports.find((p) => p.id === link.b.port);
    if (!a || !b || !ap || !bp || !isSwitchport(a, ap) || !isSwitchport(b, bp))
      continue;
    arrivals.push(
      { device: a, port: ap, peer: link.b, link: link.id },
      { device: b, port: bp, peer: link.a, link: link.id },
    );
  }
  const protectedPorts = new Set(
    arrivals
      .filter(({ device, port }) => effectiveBpduGuard(device, port, r, t))
      .map(({ device, port }) => device.id + "/" + port.id),
  );
  for (const { device: d, port: p, peer, link } of arrivals) {
    let s = r.bpduPorts.find((s) => s.device === d.id && s.port === p.id);
    if (!s) {
      s = { device: d.id, port: p.id, edgeLost: false, violations: 0 };
      r.bpduPorts.push(s);
    }
    s.peer = { ...peer };
    s.link = link;
    if (protectedPorts.has(d.id + "/" + p.id)) {
      const recovery = recovered.get(d.id + "/" + p.id);
      const peerRecovery = recovered.get(peer.device + "/" + peer.port);
      let at = recovery?.at ?? r.time,
        cycles = recovery?.cycles ?? 1;
      if (recovery && peerRecovery) {
        // Both ends must recover before another BPDU can cross this physical link.
        const localInterval = d.securityRecovery?.interval ?? 300;
        const remoteInterval =
          t.devices.find((d) => d.id === peer.device)?.securityRecovery
            ?.interval ?? 300;
        const first = Math.max(
          recovery.previous + localInterval,
          peerRecovery.previous + remoteInterval,
        );
        const period = protectedPorts.has(peer.device + "/" + peer.port)
          ? Math.max(localInterval, remoteInterval)
          : localInterval;
        cycles = 1 + Math.floor((r.time - first) / period);
        at = first + (cycles - 1) * period;
      }
      s.shutdownAt = at;
      s.violations = Math.min(Number.MAX_SAFE_INTEGER, s.violations + cycles);
      r.neighbors = r.neighbors.filter(
        (n) =>
          ![n.local, n.remote].some(
            (e) => e.device === d.id && e.port === p.id,
          ),
      );
      r.mac = r.mac.filter((e) => e.device !== d.id || e.port !== p.id);
      r.addressBindings = r.addressBindings.filter(
        (e) => e.device !== d.id || e.port !== p.id,
      );
    }
    s.edgeLost = true;
  }
}
