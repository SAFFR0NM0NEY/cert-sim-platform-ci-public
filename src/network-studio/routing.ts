import type { NetworkRuntime } from "./networkRuntime.ts";
import type { Device, LearnedRoute, Port, Topology } from "./types.ts";
import { ipv4Forwarding } from "./vlanInterfaces.ts";
import { ipv4, ipString, mask, sameSubnet } from "./addressing.ts";
import { layer2Peers, portOperational } from "./ethernet.ts";
import { channelState } from "./etherChannel.ts";

export interface InterfaceMetric {
  bandwidth: number;
  delay: number;
}

/** Informational interface metrics, independent of cable rate and serial clocking. */
export function interfaceMetric(
  t: Topology,
  d: Device,
  p: Port,
  runtime?: NetworkRuntime,
): InterfaceMetric {
  let defaults: InterfaceMetric;
  if (p.virtual?.kind === "subinterface") {
    const parentId = p.virtual.parent;
    const parent = d.ports.find(
      (entry) => entry.id === parentId && !entry.virtual,
    );
    defaults = parent
      ? interfaceMetric(t, d, parent, runtime)
      : { bandwidth: 1000000, delay: 1 };
  } else if (p.virtual?.kind === "portchannel") {
    // Inspector drafts can outlive an applied channel for one React render.
    // Only applied members have operational state; new/removed drafts use defaults.
    const group = p.virtual.group;
    const applied = t.devices.find((device) => device.id === d.id);
    const exists = applied?.ports.some(
      (port) =>
        port.virtual?.kind === "portchannel" && port.virtual.group === group,
    );
    const active = exists
      ? channelState(t, d.id, group, runtime)
          .members.filter((member) => member.status === "bundled")
          .map(
            (member) =>
              applied!.ports.find((entry) => entry.id === member.port)!,
          )
          .map((member) => interfaceMetric(t, applied!, member, runtime))
      : [];
    defaults = active.length
      ? {
          bandwidth: Math.min(
            2147483647,
            active.reduce((sum, member) => sum + member.bandwidth, 0),
          ),
          delay: Math.min(...active.map((member) => member.delay)),
        }
      : { bandwidth: 1000000, delay: 1 };
  } else if (p.media === "serial") {
    defaults = { bandwidth: 1544, delay: 2000 };
  } else if (/^FastEthernet/i.test(p.name)) {
    defaults = { bandwidth: 100000, delay: 10 };
  } else if (/^Ethernet/i.test(p.name)) {
    defaults = { bandwidth: 10000, delay: 100 };
  } else {
    // CertSim's generic Gigabit, fiber and SVI inventory uses a 1-Gbps baseline.
    defaults = { bandwidth: 1000000, delay: 1 };
  }
  return {
    bandwidth: p.bandwidth ?? defaults.bandwidth,
    delay: p.delay ?? defaults.delay,
  };
}

export const EIGRP_INFINITY = 4294967295;

/** Classic K1=K3=1 metric. Saturation means unreachable, never a wrapped metric. */
export function eigrpMetric(vector: InterfaceMetric): number {
  if (vector.bandwidth <= 0 || vector.delay < 0) return EIGRP_INFINITY;
  const value = 256 * (Math.floor(10000000 / vector.bandwidth) + vector.delay);
  return Number.isFinite(value) && value < EIGRP_INFINITY
    ? value
    : EIGRP_INFINITY;
}
export function routingParticipates(
  t: Topology,
  d: Device,
  p: Port,
  runtime?: NetworkRuntime,
): boolean {
  return !!(
    d.powered &&
    ipv4Forwarding(d) &&
    d.routing &&
    d.routing.protocol !== "none" &&
    p.enabled &&
    p.ip &&
    portOperational(t, d.id, p.id, runtime) &&
    d.routing.networks.some((n) => sameSubnet(n.network, p.ip, n.prefix))
  );
}
function routerIdentity(d: Device): string {
  return (
    d.routing?.routerId ||
    d.ports
      .filter((p) => p.enabled && p.ip)
      .map((p) => p.ip)
      .sort((a, b) => ipv4(b)! - ipv4(a)!)[0] ||
    ""
  );
}
export interface Neighbor {
  router: string;
  localPort: string;
  remotePort: string;
  nextHop: string;
  cost: number;
}
export function routingNeighbors(
  t: Topology,
  sourceId: string,
  runtime?: NetworkRuntime,
): Neighbor[] {
  const source = t.devices.find((d) => d.id === sourceId);
  if (!source?.routing || source.routing.protocol === "none") return [];
  const neighbors: Neighbor[] = [];
  for (const local of source.ports.filter(
    (p) =>
      routingParticipates(t, source, p, runtime) &&
      !source.routing!.passivePorts.includes(p.id),
  )) {
    for (const peer of layer2Peers(
      t,
      { device: source.id, port: local.id },
      undefined,
      runtime,
    )) {
      const remote = peer.device;
      if (
        !routingParticipates(t, remote, peer.port, runtime) ||
        remote.routing?.protocol !== source.routing.protocol ||
        remote.routing.passivePorts.includes(peer.port.id)
      )
        continue;
      if (
        !sameSubnet(local.ip, peer.port.ip, local.prefix) ||
        !sameSubnet(local.ip, peer.port.ip, peer.port.prefix)
      )
        continue;
      if (
        source.routing.protocol === "ospf" &&
        (local.prefix !== peer.port.prefix ||
          routerIdentity(source) === routerIdentity(remote))
      )
        continue;
      if (
        source.routing.protocol === "eigrp" &&
        source.routing.processId !== remote.routing.processId
      )
        continue;
      neighbors.push({
        router: remote.id,
        localPort: local.id,
        remotePort: peer.port.id,
        nextHop: peer.port.ip,
        cost:
          source.routing.protocol === "rip"
            ? 1
            : source.routing.protocol === "eigrp"
              ? eigrpMetric(interfaceMetric(t, source, local, runtime))
              : (local.cost ?? 1),
      });
    }
  }
  return neighbors.sort(
    (a, b) =>
      a.router.localeCompare(b.router) || a.nextHop.localeCompare(b.nextHop),
  );
}

export interface EigrpTopologyEntry extends LearnedRoute, InterfaceMetric {
  protocol: "eigrp";
  localPort: string;
}

type EigrpPath = InterfaceMetric & {
  metric: number;
  nextHop: string;
  localPort: string;
  learnedFrom: string;
  hops: number;
};
const comparePath = (a: EigrpPath, b: EigrpPath) =>
  a.metric - b.metric ||
  a.hops - b.hops ||
  a.nextHop.localeCompare(b.nextHop) ||
  a.localPort.localeCompare(b.localPort) ||
  a.learnedFrom.localeCompare(b.learnedFrom);

/**
 * Selected internal routes after immediate convergence, not a DUAL state machine.
 * Work backwards from each advertised prefix, carrying the full metric vector.
 * A next hop must already have a selected route, so every metric describes the
 * actual forwarding chain. Scalar source-side Dijkstra is invalid: a later
 * bandwidth bottleneck can reverse the preference between two partial paths.
 * Fixed connected roots and settled next hops also prevent loops on metric ties.
 */
export function eigrpTopology(
  t: Topology,
  sourceId: string,
  runtime?: NetworkRuntime,
): EigrpTopologyEntry[] {
  const source = t.devices.find((d) => d.id === sourceId);
  if (
    !source?.powered ||
    !ipv4Forwarding(source) ||
    source.routing?.protocol !== "eigrp"
  )
    return [];
  const routers = t.devices.filter(
    (d) =>
      d.powered &&
      ipv4Forwarding(d) &&
      d.routing?.protocol === "eigrp" &&
      d.routing.processId === source.routing!.processId,
  );
  const incoming = new Map<
    string,
    { router: string; neighbor: Neighbor; vector: InterfaceMetric }[]
  >();
  const prefixes = new Map<
    string,
    { network: string; prefix: number; roots: Map<string, EigrpPath> }
  >();
  const connected = new Map<string, Set<string>>();
  for (const d of routers) {
    const live = d.ports.filter(
      (p) => p.enabled && p.ip && portOperational(t, d.id, p.id, runtime),
    );
    const own = new Set<string>();
    connected.set(d.id, own);
    const metrics = new Map<string, InterfaceMetric>();
    for (const p of live) {
      const network = ipString((ipv4(p.ip)! & mask(p.prefix)) >>> 0),
        key = `${network}/${p.prefix}`;
      own.add(key);
      if (!routingParticipates(t, d, p, runtime)) continue;
      const vector = interfaceMetric(t, d, p, runtime);
      metrics.set(p.id, vector);
      const root: EigrpPath = {
        ...vector,
        metric: eigrpMetric(vector),
        nextHop: "",
        localPort: p.id,
        learnedFrom: d.id,
        hops: 0,
      };
      const entry = prefixes.get(key) ?? {
        network,
        prefix: p.prefix,
        roots: new Map<string, EigrpPath>(),
      };
      const old = entry.roots.get(d.id);
      if (!old || comparePath(root, old) < 0) entry.roots.set(d.id, root);
      prefixes.set(key, entry);
    }
    for (const neighbor of routingNeighbors(t, d.id, runtime)) {
      const vector = metrics.get(neighbor.localPort)!;
      const edges = incoming.get(neighbor.router) ?? [];
      edges.push({ router: d.id, neighbor, vector });
      incoming.set(neighbor.router, edges);
    }
  }
  const routes: EigrpTopologyEntry[] = [];
  for (const [key, prefix] of prefixes) {
    if (connected.get(sourceId)?.has(key)) continue;
    const selected = new Map(prefix.roots);
    // All connected owners are fixed, even when their interface is not advertised.
    const settled = new Set(
      routers.filter((d) => connected.get(d.id)!.has(key)).map((d) => d.id),
    );
    const pending = new Set<string>();
    const extend = (id: string, path: EigrpPath) => {
      if (path.metric >= EIGRP_INFINITY) return;
      for (const edge of incoming.get(id) ?? []) {
        if (settled.has(edge.router)) continue;
        const vector = {
          bandwidth: Math.min(edge.vector.bandwidth, path.bandwidth),
          delay: edge.vector.delay + path.delay,
        };
        const candidate: EigrpPath = {
          ...vector,
          metric: eigrpMetric(vector),
          nextHop: edge.neighbor.nextHop,
          localPort: edge.neighbor.localPort,
          learnedFrom: path.learnedFrom,
          hops: path.hops + 1,
        };
        if (candidate.metric >= EIGRP_INFINITY) continue;
        const previous = selected.get(edge.router);
        if (!previous || comparePath(candidate, previous) < 0) {
          selected.set(edge.router, candidate);
          pending.add(edge.router);
        }
      }
    };
    for (const [id, root] of prefix.roots) extend(id, root);
    while (pending.size) {
      // O(V² + E) per prefix; no enumeration of all paths or protocol timers.
      let id: string | undefined;
      for (const candidate of pending) {
        if (
          id === undefined ||
          comparePath(selected.get(candidate)!, selected.get(id)!) < 0 ||
          (comparePath(selected.get(candidate)!, selected.get(id)!) === 0 &&
            candidate < id)
        )
          id = candidate;
      }
      pending.delete(id!);
      settled.add(id!);
      if (id === sourceId) break;
      extend(id!, selected.get(id!)!);
    }
    const path = selected.get(sourceId);
    if (path && path.metric < EIGRP_INFINITY) {
      routes.push({
        network: prefix.network,
        prefix: prefix.prefix,
        protocol: "eigrp",
        distance: 90,
        metric: path.metric,
        nextHop: path.nextHop,
        localPort: path.localPort,
        learnedFrom: path.learnedFrom,
        bandwidth: path.bandwidth,
        delay: path.delay,
      });
    }
  }
  return routes.sort(
    (a, b) => a.network.localeCompare(b.network) || b.prefix - a.prefix,
  );
}
/** Immediate convergence over live adjacencies, not protocol timers or update packets. */
export function learnedRoutes(
  t: Topology,
  sourceId: string,
  runtime?: NetworkRuntime,
): LearnedRoute[] {
  const source = t.devices.find((d) => d.id === sourceId),
    protocol = source?.routing?.protocol;
  if (
    !source ||
    !source.powered ||
    !ipv4Forwarding(source) ||
    !protocol ||
    protocol === "none"
  )
    return [];
  if (protocol === "eigrp") return eigrpTopology(t, sourceId, runtime);
  const distances = new Map<string, { metric: number; nextHop: string }>([
    [sourceId, { metric: 0, nextHop: "" }],
  ]);
  const pending = new Set<string>([sourceId]),
    settled = new Set<string>();
  while (pending.size) {
    const id = [...pending].sort(
      (a, b) =>
        distances.get(a)!.metric - distances.get(b)!.metric ||
        a.localeCompare(b),
    )[0];
    pending.delete(id);
    settled.add(id);
    const current = distances.get(id)!;
    for (const n of routingNeighbors(t, id, runtime)) {
      if (settled.has(n.router)) continue;
      const metric = current.metric + n.cost;
      if (protocol === "rip" && metric > 15) continue;
      const previous = distances.get(n.router),
        nextHop = id === sourceId ? n.nextHop : current.nextHop;
      if (
        !previous ||
        metric < previous.metric ||
        (metric === previous.metric && nextHop < previous.nextHop)
      ) {
        distances.set(n.router, { metric, nextHop });
        pending.add(n.router);
      }
    }
  }
  const routes = new Map<string, LearnedRoute>();
  for (const d of t.devices) {
    if (d.id === sourceId) continue;
    const path = distances.get(d.id);
    if (!path) continue;
    for (const p of d.ports.filter((p) =>
      routingParticipates(t, d, p, runtime),
    )) {
      const network = ipString((ipv4(p.ip)! & mask(p.prefix)) >>> 0),
        key = `${network}/${p.prefix}`;
      if (
        source.ports.some(
          (local) =>
            local.enabled &&
            portOperational(t, source.id, local.id, runtime) &&
            local.ip &&
            local.prefix === p.prefix &&
            sameSubnet(local.ip, network, p.prefix),
        )
      )
        continue;
      const candidate: LearnedRoute = {
        network,
        prefix: p.prefix,
        nextHop: path.nextHop,
        metric: path.metric + (protocol === "ospf" ? (p.cost ?? 1) : 0),
        distance: protocol === "rip" ? 120 : 110,
        protocol,
        learnedFrom: d.id,
      };
      const previous = routes.get(key);
      if (
        !previous ||
        candidate.metric < previous.metric ||
        (candidate.metric === previous.metric &&
          candidate.nextHop < previous.nextHop)
      )
        routes.set(key, candidate);
    }
  }
  return [...routes.values()].sort(
    (a, b) => a.network.localeCompare(b.network) || b.prefix - a.prefix,
  );
}
