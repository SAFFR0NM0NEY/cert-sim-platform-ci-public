import { ipv4Forwarding, isRoutedInterface } from "./vlanInterfaces.ts";
import { addressable } from "./wireless.ts";
import type {
  Device,
  PacketEvent,
  PingResult,
  Port,
  Topology,
  PacketContext,
} from "./types.ts";
import { l2Reach, portOperational } from "./ethernet.ts";
import { ipv4, mask, sameSubnet, usableIp } from "./addressing.ts";
import { parseDeviceExtensions } from "./extensions.ts";
import { learnedRoutes } from "./routing.ts";
import { aclDecision } from "./security.ts";
import { synchronizeBpduGuard } from "./bpduGuard.ts";
import { bindRuntime, createRuntime } from "./networkRuntime.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
import { validatePortSecurity } from "./portSecurity.ts";
import { natInbound, natOutbound, natConflict } from "./nat.ts";
export {
  ipv4,
  ipString,
  mask,
  prefixFromMask,
  sameSubnet,
  usableIp,
} from "./addressing.ts";

export function configurationError(device: Device): string | null {
  try {
    validatePortSecurity(device);
    parseDeviceExtensions(
      device as unknown as Record<string, unknown>,
      device.kind,
      device.ports,
    );
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "Invalid extended configuration.";
  }
  if (
    !device.name.trim() ||
    device.name.length > 48 ||
    !/^[\w .-]+$/.test(device.name)
  )
    return "Use a device name of 1–48 letters, numbers, spaces, dots or hyphens.";
  if (device.gateway && !usableIp(device.gateway, 32))
    return "Enter a valid unicast IPv4 gateway.";
  for (const p of device.ports) {
    if (!Number.isInteger(p.prefix) || p.prefix < 1 || p.prefix > 32)
      return "Interface prefix length must be between 1 and 32.";
    if (p.ip && !usableIp(p.ip, p.prefix))
      return `${p.name}: enter a valid host IPv4 address and prefix (1–32).`;
    if (device.kind === "switch" && p.ip && !isRoutedInterface(device, p))
      return "Configure switch IP addresses on VLAN interfaces or routed ports.";
    if (!Number.isInteger(p.vlan) || p.vlan < 1 || p.vlan > 4094)
      return "VLAN must be between 1 and 4094.";
    if (
      !p.allowedVlans.length ||
      p.allowedVlans.length > 128 ||
      p.allowedVlans.some((v) => !Number.isInteger(v) || v < 1 || v > 4094)
    )
      return "Trunk VLAN list must contain 1–128 VLAN IDs from 1 to 4094.";
  }
  for (const r of device.routes) {
    const network = ipv4(r.network);
    if (
      network === null ||
      !Number.isInteger(r.prefix) ||
      r.prefix < 0 ||
      r.prefix > 32 ||
      (network & mask(r.prefix)) >>> 0 !== network ||
      !usableIp(r.nextHop, 32)
    )
      return "Static routes need a network address, prefix (0–32), and valid next hop.";
  }
  return null;
}

function egress(
  current: Device,
  destinationIp: string,
  topology?: Topology,
  runtime?: NetworkRuntime,
): { port: Port | undefined; nextHop: string } {
  const live = current.ports.filter(
    (p) =>
      p.enabled &&
      p.ip &&
      usableIp(p.ip, p.prefix) &&
      (!topology || portOperational(topology, current.id, p.id, runtime)),
  );
  let port = live
    .filter((p) => sameSubnet(p.ip, destinationIp, p.prefix))
    .sort((a, b) => b.prefix - a.prefix)[0] as Port | undefined;
  let nextHop = destinationIp;
  if (ipv4Forwarding(current)) {
    const route = [
      ...current.routes.map((r) => ({ ...r, distance: 1, metric: 0 })),
      ...(topology ? learnedRoutes(topology, current.id, runtime) : []),
    ]
      .filter((r) => sameSubnet(r.network, destinationIp, r.prefix))
      .sort(
        (a, b) =>
          b.prefix - a.prefix || a.distance - b.distance || a.metric - b.metric,
      )
      .find((r) => !port || r.prefix > port.prefix);
    if (route) {
      nextHop = route.nextHop;
      port = live
        .filter((p) =>
          "localPort" in route && route.localPort
            ? p.id === route.localPort
            : sameSubnet(p.ip, nextHop, p.prefix),
        )
        .sort((a, b) => b.prefix - a.prefix)[0];
    }
  } else if (!port && current.gateway) {
    nextHop = current.gateway;
    port = live.find((p) => sameSubnet(p.ip, nextHop, p.prefix));
  }
  return { port, nextHop };
}
interface Leg {
  ok: boolean;
  message: string;
  events: Omit<PacketEvent, "id">[];
  hops: string[];
  packet: PacketContext;
  delivered?: { device: string; port: string };
}
function routeLeg(
  t: Topology,
  source: Device,
  initialPacket: PacketContext,
  phase: "request" | "reply",
  runtime: NetworkRuntime,
  limit = 32,
): Leg {
  let current = source,
    packet = { ...initialPacket },
    ingress: Port | undefined,
    ttl = limit;
  const events: Omit<PacketEvent, "id">[] = [],
    hops = [source.id],
    visited = new Set<string>();
  const emit = (
    protocol: PacketEvent["protocol"],
    detail: string,
    layer: PacketEvent["layer"] = 3,
  ) =>
    events.push({
      protocol,
      from: current.id,
      to: current.id,
      detail,
      phase,
      ttl,
      layer,
    });
  const fail = (message: string): Leg => {
    emit("DROP", message);
    return { ok: false, message, events, hops, packet };
  };
  while (ttl > 0) {
    if (!current.powered) return fail(`${current.name} is powered off.`);
    let translatedInbound = false;
    let hairpin: PacketContext | undefined;
    if (ingress) {
      const policy = aclDecision(current, ingress, "in", packet);
      if (policy) {
        emit("ACL", policy.detail);
        if (!policy.permit) return fail(policy.detail);
      }
      const translated = natInbound(current, ingress, packet, runtime);
      if (translated.error) return fail(translated.error);
      packet = translated.packet;
      hairpin = translated.hairpin;
      if (translated.detail) {
        emit("NAT", translated.detail);
        translatedInbound = true;
      }
    }
    const local = current.ports.find(
      (p) =>
        p.enabled &&
        p.ip === packet.destinationIp &&
        (!p.virtual || portOperational(t, current.id, p.id, runtime)),
    );
    if (local)
      return {
        ok: true,
        message: "Delivered",
        events,
        hops,
        packet,
        delivered: { device: current.id, port: local.id },
      };
    if (!ipv4Forwarding(current) && current.id !== source.id)
      return fail(`${current.name} is not a forwarding router.`);
    if (ingress && ipv4Forwarding(current) && --ttl === 0)
      return fail("TTL expired on " + current.name + ".");
    if (visited.has(current.id))
      return fail(`Routing loop detected at ${current.name}.`);
    visited.add(current.id);
    const { port, nextHop } = egress(current, packet.destinationIp, t, runtime);
    if (!port)
      return fail(
        `No usable route to ${packet.destinationIp} on ${current.name}. Check gateway, routes and interface status.`,
      );
    if (port.ip === nextHop)
      return fail(`${current.name}: the next hop is its own interface.`);
    if (translatedInbound && port.natRole !== "inside")
      return fail(
        "NAT destination translation requires an inside egress interface.",
      );
    const translated = natOutbound(
      current,
      ingress,
      port,
      packet,
      runtime,
      hairpin,
    );
    if (translated.error) return fail(translated.error);
    packet = translated.packet;
    if (translated.detail) emit("NAT", translated.detail);
    const policy = aclDecision(current, port, "out", packet);
    if (policy) {
      emit("ACL", policy.detail);
      if (!policy.permit) return fail(policy.detail);
    }
    const reachable = l2Reach(
      t,
      { device: current.id, port: port.id },
      nextHop,
      runtime,
    );
    if (!reachable)
      return fail(
        port.media === "serial"
          ? `Serial peer ${nextHop} is unreachable from ${current.name}.`
          : `ARP unresolved for ${nextHop} from ${current.name}. Check cables, power, interfaces and VLANs.`,
      );
    if (reachable.resolutionSent)
      events.push(
        {
          protocol: "ARP",
          ...(reachable.resolutionRequestLink
            ? { link: reachable.resolutionRequestLink }
            : {}),
          from: current.id,
          to: reachable.device.id,
          detail: `Resolve ${nextHop} on ${port.name} after an ARP cache miss.`,
          phase,
          ttl,
          layer: 2,
        },
        {
          protocol: "ARP",
          ...(reachable.resolutionReplyLink
            ? { link: reachable.resolutionReplyLink }
            : {}),
          from: reachable.device.id,
          to: current.id,
          detail: `${nextHop} is reachable on this broadcast domain.`,
          phase,
          ttl,
          layer: 2,
        },
      );
    for (const hop of reachable.hops) {
      events.push({
        protocol:
          packet.protocol === "icmp"
            ? "ICMP"
            : packet.protocol === "tcp"
              ? "TCP"
              : "UDP",
        ...hop,
        detail: `${packet.protocol === "icmp" ? "Echo" : packet.protocol.toUpperCase()} ${phase}: ${packet.sourceIp} → ${packet.destinationIp}${packet.destinationPort ? ` port ${packet.destinationPort}` : ""}`,
        phase,
        ttl,
        layer: packet.protocol === "icmp" ? 3 : 4,
      });
      hops.push(hop.to);
    }
    current = reachable.device;
    ingress = reachable.port;
  }
  return fail("TTL expired.");
}
export function probeIPv4(
  t: Topology,
  sourceId: string,
  destinationIp: string,
  protocol: PacketContext["protocol"] = "icmp",
  destinationPort?: number,
  runtime: NetworkRuntime = createRuntime(),
  limit = 32,
  sourceBinding?: { ip: string; port: number; oneWay?: boolean },
): PingResult {
  bindRuntime(runtime, t);
  synchronizeBpduGuard(t, runtime);
  const source = t.devices.find((d) => d.id === sourceId),
    fail = (message: string): PingResult => ({
      ok: false,
      message,
      events: [],
      hops: [],
    });
  if (!Number.isInteger(limit) || limit < 1 || limit > 255)
    return fail("TTL must be 1–255.");
  if (!source || !addressable(source.kind))
    return fail("Select a host or router as the source.");
  if (!usableIp(destinationIp, 32))
    return fail("Enter a valid unicast destination IPv4 address.");
  if (!source.powered) return fail("Source device is powered off.");
  for (const d of t.devices) {
    const error = configurationError(d);
    if (error) return fail(`${d.name}: ${error}`);
  }
  const seen = new Set<string>();
  for (const d of t.devices)
    for (const p of d.ports.filter((p) => p.ip)) {
      if (seen.has(p.ip))
        return fail(
          `Duplicate IPv4 address ${p.ip}; resolve the conflict first.`,
        );
      seen.add(p.ip);
    }
  const conflict = natConflict(t);
  if (conflict) return fail(conflict);
  const live = source.ports.filter(
      (p) =>
        p.enabled &&
        p.ip &&
        (!p.virtual || portOperational(t, source.id, p.id, runtime)),
    ),
    sourcePort = sourceBinding
      ? live.find((p) => p.ip === sourceBinding.ip)
      : (live.find((p) => p.ip === destinationIp) ??
        egress(source, destinationIp, t, runtime).port ??
        live[0]);
  if (!sourcePort) return fail("Source has no enabled IPv4 interface.");
  const packet: PacketContext = {
    protocol,
    sourceIp: sourcePort.ip,
    destinationIp,
    sourcePort: sourceBinding?.port ?? (protocol === "icmp" ? 1 : 49152),
    destinationPort,
  };
  const outbound = routeLeg(t, source, packet, "request", runtime, limit);
  let events = outbound.events,
    ok = outbound.ok,
    message = outbound.message;
  const target = t.devices.find((d) => d.id === outbound.delivered?.device);
  if (ok && target && !sourceBinding?.oneWay) {
    const observed = outbound.packet;
    const inbound = routeLeg(
      t,
      target,
      {
        protocol,
        sourceIp: observed.destinationIp,
        destinationIp: observed.sourceIp,
        sourcePort:
          protocol === "icmp" ? observed.sourcePort : observed.destinationPort,
        destinationPort: protocol === "icmp" ? undefined : observed.sourcePort,
      },
      "reply",
      runtime,
    );
    events = [...events, ...inbound.events];
    ok =
      inbound.ok &&
      inbound.delivered?.device === source.id &&
      inbound.packet.destinationIp === sourcePort.ip &&
      inbound.packet.sourceIp === destinationIp &&
      (protocol === "icmp" ||
        inbound.packet.sourcePort === packet.destinationPort) &&
      (protocol === "icmp"
        ? inbound.packet.sourcePort === packet.sourcePort
        : inbound.packet.destinationPort === packet.sourcePort);
    message = ok
      ? `Reply from ${destinationIp}: ${protocol === "icmp" ? "echo" : protocol.toUpperCase()} request and reply delivered.`
      : `Request delivered; reply failed: ${inbound.ok ? "reply reached a different endpoint or tuple." : inbound.message}`;
  }
  return {
    ok,
    message,
    events: events.map((e, id) => ({ ...e, id })),
    hops: outbound.hops,
    ...(outbound.delivered
      ? {
          destinationDevice: outbound.delivered.device,
          destinationAddress: outbound.packet.destinationIp,
          destinationPort: outbound.packet.destinationPort,
        }
      : {}),
  };
}
export function ping(
  t: Topology,
  sourceId: string,
  destinationIp: string,
  runtime?: NetworkRuntime,
): PingResult {
  return probeIPv4(t, sourceId, destinationIp, "icmp", undefined, runtime);
}
