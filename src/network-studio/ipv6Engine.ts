import { addressable } from "./wireless.ts";
import type {
  Device,
  PacketEvent,
  PingResult,
  Port,
  Topology,
} from "./types.ts";
import {
  ipv6,
  formatIPv6,
  linkLocal6,
  sameSubnet6,
  usableIPv6,
} from "./ipv6Address.ts";
import { layer2Peers, portOperational, resolveFrame } from "./ethernet.ts";
import { synchronizeBpduGuard } from "./bpduGuard.ts";
import { bindRuntime, createRuntime } from "./networkRuntime.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
import { configurationError } from "./engine.ts";
function peers(
  t: Topology,
  d: Device,
  p: Port,
  address: string,
  runtime?: NetworkRuntime,
) {
  return layer2Peers(
    t,
    { device: d.id, port: p.id },
    undefined,
    runtime,
  ).filter((peer) => peer.port.ipv6 && ipv6(peer.port.ipv6) === ipv6(address));
}
function egress6(
  t: Topology,
  d: Device,
  destination: string,
  selected?: string,
  runtime?: NetworkRuntime,
): { port?: Port; nextHop: string; error?: string } {
  const live = d.ports.filter(
    (p) =>
      p.enabled &&
      p.ipv6 &&
      portOperational(t, d.id, p.id, runtime) &&
      (!selected || selected === p.id),
  );
  if (linkLocal6(destination)) {
    const candidates = live.filter(
      (p) => peers(t, d, p, destination, runtime).length,
    );
    return candidates.length > 1
      ? {
          nextHop: destination,
          error: "Ambiguous link-local destination; select a source interface.",
        }
      : { port: candidates[0], nextHop: destination };
  }
  let port = live
    .filter((p) => sameSubnet6(p.ipv6!, destination, p.prefix6 ?? 64))
    .sort((a, b) => (b.prefix6 ?? 64) - (a.prefix6 ?? 64))[0] as
    | Port
    | undefined;
  let nextHop = destination;
  const route =
    d.kind === "router" || d.kind === "switch"
      ? d.routes6
          ?.filter((r) => sameSubnet6(r.network, destination, r.prefix))
          .sort((a, b) => b.prefix - a.prefix)
          .find((r) => !port || r.prefix > (port.prefix6 ?? 64))
      : undefined;
  if (route || (!port && d.kind !== "router" && !d.ipv6Routing && d.gateway6)) {
    nextHop = route?.nextHop ?? d.gateway6!;
    const candidates = live.filter(
      (p) =>
        (!route?.interface || route.interface === p.id) &&
        (linkLocal6(nextHop)
          ? peers(t, d, p, nextHop, runtime).length > 0
          : sameSubnet6(p.ipv6!, nextHop, p.prefix6 ?? 64)),
    );
    if (linkLocal6(nextHop) && candidates.length > 1)
      return {
        nextHop,
        error: "Ambiguous link-local next hop; bind the route to an interface.",
      };
    port = candidates.sort((a, b) => (b.prefix6 ?? 64) - (a.prefix6 ?? 64))[0];
  }
  return { port, nextHop };
}
function leg(
  t: Topology,
  source: Device,
  destination: string,
  sourceIp: string,
  phase: "request" | "reply",
  selected?: string,
  runtime: NetworkRuntime = createRuntime(),
  limit = 32,
): PingResult & { deliveredInterface?: string } {
  const events: PacketEvent[] = [],
    hops = [source.id],
    visited = new Set<string>();
  let current = source,
    ttl = limit;
  const fail = (message: string): PingResult => ({
    ok: false,
    message,
    hops,
    events: [
      ...events,
      {
        id: 0,
        protocol: "DROP",
        from: current.id,
        to: current.id,
        detail: message,
        phase,
        ttl,
        layer: 3,
      },
    ],
  });
  while (ttl > 0) {
    if (!current.powered) return fail(`${current.name} is powered off.`);
    const local = current.ports.find(
      (p) =>
        p.enabled &&
        p.ipv6 &&
        ipv6(p.ipv6) === ipv6(destination) &&
        (!p.virtual || portOperational(t, current.id, p.id, runtime)) &&
        (!selected || current.id !== source.id || p.id === selected),
    );
    if (local)
      return {
        ok: true,
        message: "Delivered",
        events,
        hops,
        deliveredInterface: local.id,
      };
    if (current.id !== source.id && !current.ipv6Routing)
      return fail(`IPv6 forwarding is disabled on ${current.name}.`);
    if (hops.length > 1 && --ttl === 0)
      return fail("IPv6 hop limit expired on " + current.name + ".");
    if (visited.has(current.id))
      return fail(`IPv6 routing loop at ${current.name}.`);
    visited.add(current.id);
    const { port, nextHop, error } = egress6(
      t,
      current,
      destination,
      current.id === source.id ? selected : undefined,
      runtime,
    );
    if (error) return fail(error);
    if (!port)
      return fail(`No usable IPv6 route to ${destination} on ${current.name}.`);
    if (ipv6(port.ipv6!) === ipv6(nextHop))
      return fail("IPv6 next hop is the sending interface itself.");
    const resolved = peers(t, current, port, nextHop, runtime);
    if (resolved.length !== 1)
      return fail(
        resolved.length
          ? "Duplicate IPv6 neighbors on the same link."
          : `Neighbor discovery unresolved for ${nextHop}.`,
      );
    const peer = resolveFrame(
      t,
      { device: current.id, port: port.id },
      resolved[0],
      runtime,
      "ipv6",
      nextHop,
    );
    if (!peer) return fail("IPv6 Ethernet delivery failed.");
    if (peer.resolutionSent)
      events.push(
        {
          id: 0,
          protocol: "NDP",
          ...(peer.resolutionRequestLink
            ? { link: peer.resolutionRequestLink }
            : {}),
          from: current.id,
          to: peer.device.id,
          detail: `Neighbor solicitation for ${nextHop} on ${port.name}.`,
          phase,
          ttl,
          layer: 3,
        },
        {
          id: 0,
          protocol: "NDP",
          ...(peer.resolutionReplyLink
            ? { link: peer.resolutionReplyLink }
            : {}),
          from: peer.device.id,
          to: current.id,
          detail: `Neighbor advertisement from ${nextHop}.`,
          phase,
          ttl,
          layer: 3,
        },
      );
    for (const hop of peer.hops) {
      events.push({
        id: 0,
        protocol: "ICMPv6",
        ...hop,
        detail: `Echo ${phase}: ${sourceIp} → ${destination}`,
        phase,
        ttl,
        layer: 3,
      });
      hops.push(hop.to);
    }
    if (peer.port.ipv6 && ipv6(peer.port.ipv6) === ipv6(destination))
      return {
        ok: true,
        message: "Delivered",
        events,
        hops,
        deliveredInterface: peer.port.id,
      };
    if (peer.device.kind !== "router" && peer.device.kind !== "switch")
      return fail(`${peer.device.name} does not forward IPv6.`);
    current = peer.device;
  }
  return fail("IPv6 hop limit expired.");
}
export function ping6(
  t: Topology,
  sourceId: string,
  destination: string,
  sourceInterface?: string,
  runtime: NetworkRuntime = createRuntime(),
  limit = 32,
): PingResult {
  bindRuntime(runtime, t);
  synchronizeBpduGuard(t, runtime);
  const fail = (message: string): PingResult => ({
    ok: false,
    message,
    events: [],
    hops: [],
  });
  if (!Number.isInteger(limit) || limit < 1 || limit > 255)
    return fail("Hop limit must be 1–255.");
  const source = t.devices.find((d) => d.id === sourceId);
  if (!source || !addressable(source.kind) || !source.powered)
    return fail("Select a powered IPv6 host or router.");
  if (!usableIPv6(destination))
    return fail("Enter a valid unicast IPv6 destination.");
  for (const d of t.devices) {
    const error = configurationError(d);
    if (error) return fail(`${d.name}: ${error}`);
  }
  const global = new Set<bigint>();
  for (const d of t.devices)
    for (const p of d.ports.filter((p) => p.ipv6 && !linkLocal6(p.ipv6))) {
      const n = ipv6(p.ipv6!)!;
      if (global.has(n))
        return fail(`Duplicate global IPv6 address ${formatIPv6(n)}.`);
      global.add(n);
    }
  if (sourceInterface && !source.ports.some((p) => p.id === sourceInterface))
    return fail("Source IPv6 interface does not exist.");
  const candidate = egress6(t, source, destination, sourceInterface, runtime);
  if (candidate.error) return fail(candidate.error);
  const sourcePort =
    source.ports.find(
      (p) =>
        p.enabled &&
        p.ipv6 &&
        ipv6(p.ipv6) === ipv6(destination) &&
        (!p.virtual || portOperational(t, source.id, p.id, runtime)) &&
        (!sourceInterface || p.id === sourceInterface),
    ) ??
    candidate.port ??
    source.ports.find(
      (p) =>
        p.enabled &&
        p.ipv6 &&
        (!p.virtual || portOperational(t, source.id, p.id, runtime)) &&
        (!sourceInterface || p.id === sourceInterface),
    );
  if (!sourcePort?.ipv6)
    return fail(
      "Source has no enabled IPv6 address on the selected interface.",
    );
  const outbound = leg(
    t,
    source,
    destination,
    sourcePort.ipv6,
    "request",
    sourceInterface,
    runtime,
    limit,
  );
  let events = outbound.events,
    ok = outbound.ok,
    message = outbound.message;
  const target = t.devices.find(
    (d) =>
      d.id === outbound.hops[outbound.hops.length - 1] &&
      d.powered &&
      d.ports.some(
        (p) => p.enabled && p.ipv6 && ipv6(p.ipv6) === ipv6(destination),
      ),
  );
  if (ok && target) {
    const inbound = leg(
      t,
      target,
      sourcePort.ipv6,
      destination,
      "reply",
      linkLocal6(sourcePort.ipv6) ? outbound.deliveredInterface : undefined,
      runtime,
    );
    events = [...events, ...inbound.events];
    ok = inbound.ok && inbound.hops.at(-1) === source.id;
    message = ok
      ? `Reply from ${formatIPv6(ipv6(destination)!)}: IPv6 echo request and reply delivered.`
      : `IPv6 request delivered; reply failed: ${inbound.ok ? "reply reached a different endpoint" : inbound.message}`;
  }
  return {
    ok,
    message,
    events: events.map((e, id) => ({ ...e, id })),
    hops: outbound.hops,
    ...(outbound.ok && target
      ? {
          destinationDevice: target.id,
          destinationAddress: formatIPv6(ipv6(destination)!),
        }
      : {}),
  };
}
