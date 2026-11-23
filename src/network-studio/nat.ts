import type {
  Device,
  PacketContext,
  Port,
  Topology,
  NatPool,
} from "./types.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
import { aclDecision } from "./security.ts";
import { sameSubnet, ipv4, ipString, usableIp } from "./addressing.ts";
import { natSize } from "./networkRuntime.ts";
export type NatResult = {
  packet: PacketContext;
  detail?: string;
  error?: string;
  hairpin?: PacketContext;
};
export function natProxy(
  d: Device,
  p: Port,
  address: string,
  runtime?: NetworkRuntime,
): boolean {
  return (
    d.kind === "router" &&
    (p.natRole === "outside" || (p.natRole === "inside" && !!d.nat?.hairpin)) &&
    !!p.ip &&
    sameSubnet(p.ip, address, p.prefix) &&
    usableIp(address, p.prefix) &&
    (!!d.nat?.static.some((s) => s.outside === address) ||
      !!d.nat?.portForwards?.some((s) => s.outside === address) ||
      !!runtime?.poolBindings.some(
        (b) =>
          b.router === d.id &&
          (b.outsidePort === p.id || p.natRole === "inside") &&
          b.globalIp === address,
      ) ||
      !!runtime?.nat.some(
        (e) =>
          e.router === d.id &&
          p.natRole === "outside" &&
          e.outsidePort === p.id &&
          e.pool &&
          e.globalIp === address,
      ))
  );
}
export function natConflict(t: Topology): string | null {
  const seen = new Set(
    t.devices.flatMap((d) => d.ports.filter((p) => p.ip).map((p) => p.ip)),
  );
  for (const d of t.devices)
    for (const s of d.nat?.static ?? []) {
      if (seen.has(s.outside))
        return `Duplicate or conflicting NAT public address ${s.outside}.`;
      seen.add(s.outside);
    }
  const owners = new Map(
    t.devices.flatMap((d) =>
      d.ports.filter((p) => p.ip).map((p) => [p.ip, d.id] as const),
    ),
  );
  const fullStatic = new Set(
    t.devices.flatMap((d) => d.nat?.static.map((s) => s.outside) ?? []),
  );
  for (const d of t.devices)
    for (const f of d.nat?.portForwards ?? []) {
      if (
        fullStatic.has(f.outside) ||
        (owners.has(f.outside) && owners.get(f.outside) !== d.id)
      )
        return `Duplicate or conflicting NAT public address ${f.outside}.`;
      owners.set(f.outside, d.id);
    }
  let count = 0;
  for (const d of t.devices)
    for (const pool of d.nat?.pools ?? [])
      for (const ip of poolAddresses(pool)) {
        if (++count > 4096)
          return "Workspace supports at most 4096 NAT pool addresses.";
        if (fullStatic.has(ip) || owners.has(ip))
          return `Duplicate or conflicting NAT pool public address ${ip}.`;
        owners.set(ip, d.id);
      }
  return null;
}
export function natInbound(
  d: Device,
  ingress: Port,
  packet: PacketContext,
  r: NetworkRuntime,
): NatResult {
  if (!d.nat) return { packet };
  if (ingress.natRole === "inside" && d.nat.hairpin) {
    const reverse = r.hairpin.find(
      (e) =>
        e.router === d.id &&
        e.insidePort === ingress.id &&
        e.protocol === packet.protocol &&
        e.serverIp === packet.sourceIp &&
        e.snatIp === packet.destinationIp &&
        (packet.protocol === "icmp"
          ? e.snatPort === packet.sourcePort
          : e.serverPort === packet.sourcePort &&
            e.snatPort === packet.destinationPort),
    );
    if (reverse) {
      reverse.lastUsed = r.time;
      for (const b of r.poolBindings)
        if (
          b.router === d.id &&
          b.globalIp === reverse.publicIp &&
          b.insideIp === reverse.serverIp
        )
          b.lastUsed = r.time;
      return {
        packet: {
          ...packet,
          sourceIp: reverse.publicIp,
          destinationIp: reverse.clientIp,
          ...(packet.protocol === "icmp"
            ? { sourcePort: reverse.clientPort }
            : {
                sourcePort: reverse.publicPort,
                destinationPort: reverse.clientPort,
              }),
        },
        detail: "Hairpin reverse source and destination translation.",
      };
    }
    const forward = d.nat.portForwards?.find(
      (f) =>
        f.protocol === packet.protocol &&
        f.outside === packet.destinationIp &&
        f.outsidePort === packet.destinationPort,
    );
    const full = d.nat.static.find((s) => s.outside === packet.destinationIp);
    const binding = r.poolBindings.find(
      (b) => b.router === d.id && b.globalIp === packet.destinationIp,
    );
    const target = forward?.inside ?? full?.inside ?? binding?.insideIp;
    if (target) {
      if (binding) binding.lastUsed = r.time;
      return {
        packet: {
          ...packet,
          destinationIp: target,
          ...(forward ? { destinationPort: forward.insidePort } : {}),
        },
        hairpin: { ...packet },
        detail: "Hairpin destination translation to " + target + ".",
      };
    }
    const port =
      packet.protocol === "icmp" ? packet.sourcePort : packet.destinationPort;
    if (packet.destinationIp === ingress.ip && (port ?? 0) >= 20000)
      return {
        packet,
        error: "No active hairpin translation for this return tuple.",
      };
  }
  if (ingress.natRole !== "outside") return { packet };
  const forward = d.nat.portForwards?.find(
    (f) =>
      f.protocol === packet.protocol &&
      f.outside === packet.destinationIp &&
      f.outsidePort === packet.destinationPort,
  );
  if (forward)
    return {
      packet: {
        ...packet,
        destinationIp: forward.inside,
        destinationPort: forward.insidePort,
      },
      detail: `Static ${forward.protocol.toUpperCase()} destination ${forward.outside}:${forward.outsidePort} → ${forward.inside}:${forward.insidePort}.`,
    };
  const staticRule = d.nat.static.find(
    (s) => s.outside === packet.destinationIp,
  );
  if (staticRule)
    return {
      packet: { ...packet, destinationIp: staticRule.inside },
      detail: `Static destination ${staticRule.outside} → ${staticRule.inside}.`,
    };
  const publicPort =
    packet.protocol === "icmp" ? packet.sourcePort : packet.destinationPort;
  const binding = r.poolBindings.find(
    (e) =>
      e.router === d.id &&
      e.outsidePort === ingress.id &&
      e.globalIp === packet.destinationIp,
  );
  if (binding) {
    binding.lastUsed = r.time;
    return {
      packet: { ...packet, destinationIp: binding.insideIp },
      detail: `Pool ${binding.pool} destination ${binding.globalIp} → ${binding.insideIp}; ports preserved.`,
    };
  }
  const entry = r.nat.find(
    (e) =>
      e.router === d.id &&
      e.outsidePort === ingress.id &&
      e.protocol === packet.protocol &&
      e.globalIp === packet.destinationIp &&
      e.globalPort === publicPort &&
      e.remoteIp === packet.sourceIp &&
      (packet.protocol === "icmp" || e.remotePort === (packet.sourcePort ?? 0)),
  );
  if (entry) {
    entry.lastUsed = r.time;
    return {
      packet: {
        ...packet,
        destinationIp: entry.insideIp,
        ...(packet.protocol === "icmp"
          ? { sourcePort: entry.insidePort }
          : { destinationPort: entry.insidePort }),
      },
      detail: `PAT destination ${entry.globalIp}:${entry.globalPort} → ${entry.insideIp}:${entry.insidePort}.`,
    };
  }
  if (
    d.nat.pools?.some(
      (p) =>
        ipv4(packet.destinationIp)! >= ipv4(p.start)! &&
        ipv4(packet.destinationIp)! <= ipv4(p.end)!,
    )
  )
    return {
      packet,
      error:
        "No active NAT pool translation for this public address and tuple.",
    };
  if (
    packet.destinationIp === ingress.ip &&
    (publicPort ?? 0) >= 20000 &&
    d.nat.overload.some((o) => o.outsidePort === ingress.id)
  )
    return {
      packet,
      error:
        "No active NAT translation for this public tuple and remote endpoint.",
    };
  return { packet };
}
export function natOutbound(
  d: Device,
  ingress: Port | undefined,
  egress: Port,
  packet: PacketContext,
  r: NetworkRuntime,
  hairpin?: PacketContext,
): NatResult {
  if (hairpin) return reflect(d, ingress, egress, packet, r, hairpin);
  if (ingress?.natRole !== "inside" || egress.natRole !== "outside" || !d.nat)
    return { packet };
  const staticRule = d.nat.static.find((s) => s.inside === packet.sourceIp);
  const forward = d.nat.portForwards?.find(
    (f) =>
      f.protocol === packet.protocol &&
      f.inside === packet.sourceIp &&
      f.insidePort === packet.sourcePort,
  );
  if (forward)
    return {
      packet: {
        ...packet,
        sourceIp: forward.outside,
        sourcePort: forward.outsidePort,
      },
      detail: `Static ${forward.protocol.toUpperCase()} source ${forward.inside}:${forward.insidePort} → ${forward.outside}:${forward.outsidePort}.`,
    };
  if (staticRule)
    return {
      packet: { ...packet, sourceIp: staticRule.outside },
      detail: `Static source ${staticRule.inside} → ${staticRule.outside}.`,
    };
  const poolRule = d.nat.poolRules?.find(
    (o) =>
      aclDecision(d, { ...egress, inboundAcl: o.acl }, "in", packet)?.permit,
  );
  if (poolRule) {
    const pool = d.nat.pools?.find((p) => p.name === poolRule.pool);
    if (!pool) return { packet, error: "Selected NAT pool does not exist." };
    const addresses = poolAddresses(pool);
    if (poolRule.overload)
      return patTranslation(d, egress, packet, r, addresses, pool.name);
    let binding = r.poolBindings.find(
      (e) =>
        e.router === d.id &&
        e.pool === pool.name &&
        e.outsidePort === egress.id &&
        e.insideIp === packet.sourceIp,
    );
    if (!binding) {
      if (natSize(r) >= 4096)
        return { packet, error: "Dynamic NAT table exhausted (4096 entries)." };
      const used = new Set([
          ...r.poolBindings.map((e) => e.globalIp),
          ...r.nat.map((e) => e.globalIp),
        ]),
        address = addresses.find((ip) => !used.has(ip));
      if (!address)
        return {
          packet,
          error: `NAT pool ${pool.name} exhausted; no free public address.`,
        };
      binding = {
        router: d.id,
        pool: pool.name,
        outsidePort: egress.id,
        insideIp: packet.sourceIp,
        globalIp: address,
        lastUsed: r.time,
      };
      r.poolBindings.push(binding);
    }
    binding.lastUsed = r.time;
    return {
      packet: { ...packet, sourceIp: binding.globalIp },
      detail: `Pool ${pool.name} source ${binding.insideIp} → ${binding.globalIp}; ports preserved.`,
    };
  }
  const rule = d.nat.overload.find(
    (o) =>
      o.outsidePort === egress.id &&
      aclDecision(d, { ...egress, inboundAcl: o.acl }, "in", packet)?.permit,
  );
  if (!rule) return { packet };
  if (!egress.ip)
    return {
      packet,
      error: "NAT overload outside interface has no IPv4 address.",
    };
  return patTranslation(d, egress, packet, r, [egress.ip]);
}
function patTranslation(
  d: Device,
  egress: Port,
  packet: PacketContext,
  r: NetworkRuntime,
  addresses: string[],
  pool?: string,
): NatResult {
  const insidePort = packet.sourcePort ?? 1,
    remotePort = packet.destinationPort ?? 0;
  let entry = r.nat.find(
    (e) =>
      e.router === d.id &&
      e.outsidePort === egress.id &&
      e.protocol === packet.protocol &&
      e.pool === pool &&
      addresses.includes(e.globalIp) &&
      e.insideIp === packet.sourceIp &&
      e.insidePort === insidePort &&
      e.remoteIp === packet.destinationIp &&
      e.remotePort === remotePort,
  );
  if (!entry) {
    if (natSize(r) >= 4096)
      return { packet, error: "Dynamic NAT table exhausted (4096 entries)." };
    let globalIp: string | undefined,
      globalPort = 20000;
    for (const address of addresses) {
      if (r.poolBindings.some((b) => b.globalIp === address)) continue;
      const occupied = new Set(
        r.nat
          .filter(
            (e) => e.globalIp === address && e.protocol === packet.protocol,
          )
          .map((e) => e.globalPort),
      );
      for (const f of d.nat?.portForwards ?? [])
        if (f.outside === address && f.protocol === packet.protocol)
          occupied.add(f.outsidePort);
      let candidate = 20000;
      while (occupied.has(candidate) && candidate <= 60000) candidate++;
      if (candidate <= 60000) {
        globalIp = address;
        globalPort = candidate;
        break;
      }
    }
    if (!globalIp)
      return {
        packet,
        error: pool
          ? `NAT pool ${pool} exhausted; no free public tuple.`
          : "NAT overload public port/identifier range exhausted.",
      };
    entry = {
      router: d.id,
      outsidePort: egress.id,
      protocol: packet.protocol,
      insideIp: packet.sourceIp,
      insidePort,
      globalIp,
      globalPort,
      remoteIp: packet.destinationIp,
      remotePort,
      lastUsed: r.time,
      ...(pool ? { pool } : {}),
    };
    r.nat.push(entry);
  }
  entry.lastUsed = r.time;
  return {
    packet: {
      ...packet,
      sourceIp: entry.globalIp,
      sourcePort: entry.globalPort,
    },
    detail: `${pool ? `Pool ${pool} ` : ""}PAT source ${entry.insideIp}:${entry.insidePort} → ${entry.globalIp}:${entry.globalPort} (${entry.protocol}).`,
  };
}
export function poolAddresses(pool: NatPool): string[] {
  const first = ipv4(pool.start),
    last = ipv4(pool.end);
  return first === null || last === null || last < first || last - first >= 256
    ? []
    : Array.from({ length: last - first + 1 }, (_, i) => ipString(first + i));
}
export function reservedNatAddresses(t: Topology): Set<string> {
  return new Set(
    t.devices.flatMap((d) => [
      ...(d.nat?.static.map((s) => s.outside) ?? []),
      ...(d.nat?.portForwards?.map((f) => f.outside) ?? []),
      ...(d.nat?.pools?.flatMap(poolAddresses) ?? []),
    ]),
  );
}
function reflect(
  d: Device,
  ingress: Port | undefined,
  egress: Port,
  packet: PacketContext,
  r: NetworkRuntime,
  original: PacketContext,
): NatResult {
  if (
    !d.nat?.hairpin ||
    ingress?.natRole !== "inside" ||
    egress.natRole !== "inside" ||
    !egress.ip
  )
    return {
      packet,
      error:
        "Hairpin reflection requires inside ingress and egress interfaces.",
    };
  let entry = r.hairpin.find(
    (e) =>
      e.router === d.id &&
      e.insidePort === egress.id &&
      e.protocol === packet.protocol &&
      e.clientIp === original.sourceIp &&
      e.clientPort === (original.sourcePort ?? 1) &&
      e.publicIp === original.destinationIp &&
      e.publicPort === (original.destinationPort ?? 0) &&
      e.serverIp === packet.destinationIp &&
      e.serverPort === (packet.destinationPort ?? 0),
  );
  if (!entry) {
    if (natSize(r) >= 4096)
      return { packet, error: "Dynamic NAT table exhausted (4096 entries)." };
    const used = new Set(
      r.hairpin
        .filter(
          (e) =>
            e.router === d.id &&
            e.snatIp === egress.ip &&
            e.protocol === packet.protocol,
        )
        .map((e) => e.snatPort),
    );
    for (const f of d.nat.portForwards ?? [])
      if (f.outside === egress.ip && f.protocol === packet.protocol)
        used.add(f.outsidePort);
    let port = 20000;
    while (used.has(port) && port <= 60000) port++;
    if (port > 60000)
      return { packet, error: "Hairpin source tuple range exhausted." };
    entry = {
      router: d.id,
      insidePort: egress.id,
      protocol: packet.protocol,
      clientIp: original.sourceIp,
      clientPort: original.sourcePort ?? 1,
      publicIp: original.destinationIp,
      publicPort: original.destinationPort ?? 0,
      serverIp: packet.destinationIp,
      serverPort: packet.destinationPort ?? 0,
      snatIp: egress.ip,
      snatPort: port,
      lastUsed: r.time,
    };
    r.hairpin.push(entry);
  }
  entry.lastUsed = r.time;
  for (const b of r.poolBindings)
    if (
      b.router === d.id &&
      b.globalIp === entry.publicIp &&
      b.insideIp === entry.serverIp
    )
      b.lastUsed = r.time;
  return {
    packet: { ...packet, sourceIp: entry.snatIp, sourcePort: entry.snatPort },
    detail: `Hairpin source ${entry.clientIp}:${entry.clientPort} to ${entry.snatIp}:${entry.snatPort}.`,
  };
}
