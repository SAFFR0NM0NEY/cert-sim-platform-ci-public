import type { NetworkRuntime } from "./networkRuntime.ts";
import type { Device, Port, Topology } from "./types.ts";
import { vlanActive } from "./vlans.ts";
import { isSwitchport } from "./vlanInterfaces.ts";
import { getPort } from "./model.ts";
import { bridgePorts, forwardingLinks } from "./etherChannel.ts";
import { operationalSwitchport } from "./dtp.ts";
export type StpPort = {
  device: string;
  port: string;
  root: string;
  rootCost: number;
  role: "root" | "designated" | "alternate" | "inconsistent" | "disabled";
  state: "forwarding" | "blocking" | "disabled";
  cost: number;
};
export function bridgeMac(id: string): string {
  let a = 2166136261,
    b = 0x9e3779b9;
  for (const c of id) {
    a = Math.imul(a ^ c.charCodeAt(0), 16777619);
    b = Math.imul(b ^ c.charCodeAt(0), 2246822519);
  }
  return (
    "02" +
    (a >>> 0).toString(16).padStart(8, "0") +
    (b >>> 24).toString(16).padStart(2, "0")
  );
}
export const stpPriority = (d: Device, vlan: number) =>
  d.spanningTree?.priorities.find((p) => p.vlan === vlan)?.priority ?? 32768;
export const carriesVlan = (p: Port, vlan: number) =>
  (!p.virtual || p.virtual.kind === "portchannel") &&
  !p.routed &&
  (p.mode !== "trunk"
    ? p.vlan === vlan || p.voiceVlan === vlan
    : p.allowedVlans.includes(vlan));
function compatiblePorts(a: Port, b: Port, vlan: number) {
  if (a.mode !== b.mode || !carriesVlan(a, vlan) || !carriesVlan(b, vlan))
    return false;
  const untagged = (p: Port) =>
    (p.mode === "access" ? p.vlan : p.nativeVlan) === vlan;
  return untagged(a) === untagged(b);
}
function compare(a: Device, b: Device, vlan: number) {
  return (
    stpPriority(a, vlan) - stpPriority(b, vlan) ||
    bridgeMac(a.id).localeCompare(bridgeMac(b.id)) ||
    a.id.localeCompare(b.id)
  );
}
type Edge = { a: Device; ap: Port; b: Device; bp: Port };
export function spanningTree(
  t: Topology,
  vlan: number,
  runtime?: NetworkRuntime,
): StpPort[] {
  const switches = t.devices.filter(
      (d) => d.kind === "switch" && d.powered && vlanActive(d, vlan),
    ),
    edges: Edge[] = [];
  const links = forwardingLinks(t, runtime);
  const cost = (d: Device, p: Port) =>
    p.spanningTreeCost ??
    (p.virtual?.kind === "portchannel"
      ? Math.max(
          1,
          Math.floor(
            4 /
              (links.find((l) =>
                [l.a, l.b].some((e) => e.device === d.id && e.port === p.id),
              )?.members.length ?? 1),
          ),
        )
      : 4);
  for (const link of links) {
    const a = switches.find((d) => d.id === link.a.device),
      b = switches.find((d) => d.id === link.b.device);
    if (!a || !b) continue;
    const ap = operationalSwitchport(t, a, getPort(t, link.a)!, runtime),
      bp = operationalSwitchport(t, b, getPort(t, link.b)!, runtime);
    if (compatiblePorts(ap, bp, vlan)) edges.push({ a, ap, b, bp });
  }
  const roots = new Map<string, Device>(),
    dist = new Map<string, number>(),
    parents = new Map<string, string>();
  for (const seed of switches) {
    if (roots.has(seed.id)) continue;
    const component = [seed];
    const seen = new Set([seed.id]);
    for (let i = 0; i < component.length; i++)
      for (const e of edges) {
        const other =
          e.a.id === component[i].id
            ? e.b
            : e.b.id === component[i].id
              ? e.a
              : null;
        if (other && !seen.has(other.id)) {
          seen.add(other.id);
          component.push(other);
        }
      }
    const root = [...component].sort((a, b) => compare(a, b, vlan))[0];
    for (const d of component) {
      roots.set(d.id, root);
      dist.set(d.id, d.id === root.id ? 0 : Infinity);
    }
    for (let i = 0; i < component.length; i++) {
      let changed = false;
      for (const e of edges) {
        if (!seen.has(e.a.id)) continue;
        for (const [local, lp, remote] of [
          [e.a, e.ap, e.b],
          [e.b, e.bp, e.a],
        ] as [Device, Port, Device][]) {
          const value = dist.get(remote.id)! + cost(local, lp);
          if (value < dist.get(local.id)!) {
            dist.set(local.id, value);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    for (const d of component) {
      if (d.id === root.id) continue;
      const candidates = edges
        .flatMap((e) =>
          e.a.id === d.id
            ? [{ local: e.ap, remote: e.b, rp: e.bp }]
            : e.b.id === d.id
              ? [{ local: e.bp, remote: e.a, rp: e.ap }]
              : [],
        )
        .filter(
          (e) => dist.get(e.remote.id)! + cost(d, e.local) === dist.get(d.id),
        );
      candidates.sort(
        (a, b) =>
          compare(a.remote, b.remote, vlan) ||
          a.remote.ports.indexOf(a.rp) - b.remote.ports.indexOf(b.rp) ||
          d.ports.indexOf(a.local) - d.ports.indexOf(b.local),
      );
      if (candidates[0]) parents.set(d.id, candidates[0].local.id);
    }
  }
  const result: StpPort[] = [];
  for (const d of t.devices.filter((d) => d.kind === "switch"))
    for (const p of bridgePorts(t, d, runtime)
      .map((p) => operationalSwitchport(t, d, p, runtime))
      .filter((p) => carriesVlan(p, vlan))) {
      const link = links.find((l) =>
          [l.a, l.b].some((e) => e.device === d.id && e.port === p.id),
        ),
        root = roots.get(d.id) ?? d;
      let role: StpPort["role"] = "designated";
      if (!link || !vlanActive(d, vlan)) role = "disabled";
      else {
        const other = link.a.device === d.id ? link.b : link.a,
          remote = t.devices.find((n) => n.id === other.device)!,
          rp = operationalSwitchport(t, remote, getPort(t, other)!, runtime);
        if (isSwitchport(remote, rp) && vlanActive(remote, vlan)) {
          if (!compatiblePorts(p, rp, vlan)) role = "inconsistent";
          else if (parents.get(d.id) === p.id) role = "root";
          else if (
            dist.get(d.id)! - dist.get(remote.id)! > 0 ||
            (dist.get(d.id) === dist.get(remote.id) &&
              compare(d, remote, vlan) > 0)
          )
            role = "alternate";
        }
      }
      result.push({
        device: d.id,
        port: p.id,
        root: root.id,
        rootCost: dist.get(d.id) ?? 0,
        role,
        state:
          role === "disabled"
            ? "disabled"
            : ["alternate", "inconsistent"].includes(role)
              ? "blocking"
              : "forwarding",
        cost: cost(d, p),
      });
    }
  return result;
}
