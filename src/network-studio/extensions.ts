import type {
  AccessList,
  AccessRule,
  Device,
  DeviceKind,
  DnsRecord,
  DhcpPool,
  Port,
  RoutingConfig,
  ServerServices,
} from "./types.ts";
import {
  isRoutedInterface,
  isSwitchport,
  validateVirtualInterfaces,
} from "./vlanInterfaces.ts";
import { validateChannels } from "./etherChannel.ts";
import { validateDtp } from "./dtp.ts";
import { parseVlans, parseVtp } from "./vlans.ts";
import { ipv4, mask, sameSubnet, usableIp } from "./addressing.ts";
import { parseWireless } from "./wireless.ts";
import { serialRates } from "./model.ts";
import { validSecureMac } from "./portSecurity.ts";
import { bool, integer, list, object, text, unique } from "./validation.ts";
import { formatIPv6, ipv6, mask6, usableIPv6 } from "./ipv6Address.ts";

export function defaultServices(): ServerServices {
  return {
    dhcp: { enabled: false, pools: [], leases: [] },
    dns: { enabled: false, records: [] },
    http: {
      enabled: false,
      pages: [{ path: "/", body: "Welcome to your CertSim lab server." }],
    },
  };
}
export function defaultRouting(): RoutingConfig {
  return {
    protocol: "none",
    processId: 1,
    routerId: "",
    networks: [],
    passivePorts: [],
  };
}
export function normalizeHost(name: string): string {
  return name.toLowerCase().replace(/\.$/, "");
}
export function validHost(name: string): boolean {
  return (
    name.length <= 253 &&
    normalizeHost(name)
      .split(".")
      .every((s) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(s))
  );
}
function ip(value: unknown, empty = false): string {
  const valueText = text(value, 15, empty);
  if (valueText && !usableIp(valueText, 32))
    throw new Error("Expected a unicast IPv4 address.");
  return valueText;
}
function network(value: unknown, prefix: number): string {
  const valueText = text(value, 15),
    n = ipv4(valueText);
  if (n === null || (n & mask(prefix)) >>> 0 !== n)
    throw new Error("Expected an aligned IPv4 network address.");
  return valueText;
}
export const DEFAULT_DHCP_LEASE = 86400;
export function leaseDuration(value: unknown) {
  return integer(value, 8, 31536000);
}
export function parsePool(value: unknown): DhcpPool {
  const p = object(value),
    prefix = integer(p.prefix, 1, 30),
    start = ip(p.start),
    count = integer(p.count, 1, 256);
  const last = ipv4(start)! + count - 1;
  if (
    last > 0xffffffff ||
    !usableIp(start, prefix) ||
    (last & mask(prefix)) >>> 0 !== (ipv4(start)! & mask(prefix)) >>> 0 ||
    (last & ~mask(prefix)) === ~mask(prefix) >>> 0
  )
    throw new Error("DHCP pool must remain within usable hosts in one subnet.");
  const gateway = ip(p.gateway, true),
    dns = ip(p.dns, true);
  if (gateway && !sameSubnet(start, gateway, prefix))
    throw new Error("DHCP gateway must be on the pool subnet.");
  return {
    ...(p.leaseSeconds === undefined
      ? {}
      : { leaseSeconds: leaseDuration(p.leaseSeconds) }),
    ...(p.tftp === undefined ? {} : { tftp: ip(p.tftp, true) }),
    id: text(p.id, 80),
    name: text(p.name, 48),
    start,
    prefix,
    count,
    gateway,
    dns,
  };
}
function parseServices(value: unknown): ServerServices {
  const s = object(value),
    dhcp = object(s.dhcp),
    dns = object(s.dns),
    http = object(s.http);
  const pools = list(dhcp.pools, 16).map(parsePool);
  unique(pools.map((p) => p.id));
  unique(pools.map((p) => p.name));
  const leases = list(dhcp.leases, 4096).map((value) => {
    const l = object(value),
      pool = text(l.pool, 80),
      address = ip(l.ip);
    const config = pools.find((p) => p.id === pool);
    if (
      !config ||
      ipv4(address)! < ipv4(config.start)! ||
      ipv4(address)! >= ipv4(config.start)! + config.count
    )
      throw new Error("DHCP lease is outside its pool.");
    return {
      pool,
      ...(l.expires === undefined
        ? {}
        : { expires: integer(l.expires, 0, Number.MAX_SAFE_INTEGER) }),
      ...(l.serverAddress === undefined
        ? {}
        : { serverAddress: ip(l.serverAddress) }),
      ...(l.tftp === undefined ? {} : { tftp: ip(l.tftp) }),
      client: text(l.client, 80),
      port: text(l.port, 80),
      ip: address,
    };
  });
  unique(leases.map((l) => `${l.client}/${l.port}`));
  unique(leases.map((l) => l.ip));
  const records = list(dns.records, 128).map((value): DnsRecord => {
    const r = object(value),
      name = text(r.name, 253),
      valueText = text(r.value, 253);
    if (
      !validHost(name) ||
      (r.type !== "A" && r.type !== "AAAA" && r.type !== "CNAME")
    )
      throw new Error(
        "DNS records require a valid host name and an A, AAAA or CNAME type.",
      );
    if (
      r.type === "A"
        ? !usableIp(valueText, 32)
        : r.type === "AAAA"
          ? !usableIPv6(valueText)
          : !validHost(valueText)
    )
      throw new Error("Invalid DNS record value.");
    return {
      name: normalizeHost(name),
      type: r.type,
      ...(r.ttl === undefined ? {} : { ttl: integer(r.ttl, 0, 2147483647) }),
      value:
        r.type === "CNAME"
          ? normalizeHost(valueText)
          : r.type === "AAAA"
            ? formatIPv6(ipv6(valueText)!)
            : valueText,
    };
  });
  unique(records.map((r) => [r.name, r.type, r.value].join("/")));
  for (const alias of records.filter((r) => r.type === "CNAME"))
    if (records.some((r) => r !== alias && r.name === alias.name))
      throw Error("A CNAME must be the only record for its name.");
  const pages = list(http.pages, 16).map((value) => {
    const p = object(value),
      path = text(p.path, 180);
    if (!/^\/[A-Za-z0-9_.~/-]*$/.test(path) || path.split("/").includes(".."))
      throw new Error(
        "Use an absolute HTTP page path without traversal segments.",
      );
    if (
      typeof p.body !== "string" ||
      new TextEncoder().encode(p.body).length > 16384 ||
      p.body.includes("\0")
    )
      throw new Error("HTTP page body exceeds 16 KiB or contains NUL.");
    return { path, body: p.body };
  });
  unique(pages.map((p) => p.path));
  return {
    dhcp: { enabled: bool(dhcp.enabled), pools, leases },
    dns: { enabled: bool(dns.enabled), records },
    http: { enabled: bool(http.enabled), pages },
  };
}
export function parseRule(value: unknown): AccessRule {
  const r = object(value);
  if (r.action !== "permit" && r.action !== "deny")
    throw new Error("ACL action must be permit or deny.");
  if (!["ip", "icmp", "tcp", "udp"].includes(String(r.protocol)))
    throw new Error("Unsupported ACL protocol.");
  const sourcePrefix = integer(r.sourcePrefix, 0, 32),
    destinationPrefix = integer(r.destinationPrefix, 0, 32);
  const result: AccessRule = {
    action: r.action,
    protocol: r.protocol as AccessRule["protocol"],
    source: network(r.source, sourcePrefix),
    sourcePrefix,
    destination: network(r.destination, destinationPrefix),
    destinationPrefix,
  };
  if (r.destinationPort !== undefined) {
    if (r.protocol !== "tcp" && r.protocol !== "udp")
      throw new Error("Only TCP/UDP ACL rules support a destination port.");
    result.destinationPort = integer(r.destinationPort, 1, 65535);
  }
  return result;
}
export function parseDeviceExtensions(
  raw: Record<string, unknown>,
  kind: DeviceKind,
  ports: Port[],
): Partial<Device> {
  const out: Partial<Device> = {};
  validateVirtualInterfaces(kind, ports);
  validateDtp({ kind, ports });
  if (raw.etherChannelLoadBalance !== undefined)
    out.etherChannelLoadBalance = text(
      raw.etherChannelLoadBalance,
      16,
    ) as Device["etherChannelLoadBalance"];
  validateChannels({
    kind,
    ports,
    etherChannelLoadBalance: out.etherChannelLoadBalance,
  });
  for (const p of ports) {
    if (
      (p.portFast !== undefined || p.bpduGuard !== undefined) &&
      !isSwitchport({ kind }, p)
    )
      throw Error(
        "PortFast and BPDU Guard require a physical Layer 2 switchport.",
      );
    if (
      p.portFast !== undefined &&
      !["default", "enable", "trunk", "disable"].includes(p.portFast)
    )
      throw Error("Unsupported PortFast mode.");
    if (
      p.bpduGuard !== undefined &&
      !["default", "enable", "disable"].includes(p.bpduGuard)
    )
      throw Error("Unsupported BPDU Guard mode.");
  }
  if (raw.bpduGuardRecovery !== undefined) {
    if (kind !== "switch")
      throw Error("BPDU Guard recovery requires a switch.");
    out.bpduGuardRecovery = bool(raw.bpduGuardRecovery);
  }
  if (raw.vlans !== undefined || raw.vtp !== undefined) {
    if (kind !== "switch")
      throw Error("VLAN and VTP configuration require a switch.");
    if (raw.vlans !== undefined) out.vlans = parseVlans(raw.vlans);
    if (raw.vtp !== undefined) out.vtp = parseVtp(raw.vtp);
  }
  if (raw.ipRouting !== undefined) {
    if (kind !== "switch")
      throw Error("The IPv4 routing toggle belongs to switches.");
    out.ipRouting = bool(raw.ipRouting);
  }
  const wireless = parseWireless(raw.wireless, kind, ports);
  if (wireless) out.wireless = wireless;
  for (const p of ports) {
    if (p.media === "serial" && kind !== "router")
      throw Error("Serial interfaces require a router.");
    if (
      p.clockRate !== undefined &&
      (p.media !== "serial" ||
        !serialRates.some((rate) => rate === p.clockRate))
    )
      throw Error("Select a supported serial interface clock rate.");
  }
  const expansion = ports.filter((p) => p.slot !== undefined);
  if (expansion.length) {
    if (kind !== "router" && kind !== "switch")
      throw Error("Only routers and switches support expansion slots.");
    if (expansion.length === ports.length)
      throw Error("The chassis requires a built-in interface.");
    for (const p of expansion) {
      integer(p.slot, 1, 2);
      if (
        p.id !== "module-" + p.slot ||
        p.name !==
          (p.media === "serial" ? "Serial" : "GigabitEthernet") + p.slot + "/0"
      )
        throw Error("The expansion port does not match its slot.");
    }
    unique(expansion.map((p) => String(p.slot)));
  }
  if (raw.managerAddress !== undefined) {
    if (kind !== "phone")
      throw Error("Only phones support a call manager address.");
    out.managerAddress = ip(raw.managerAddress, true);
  }
  if (raw.securityRecovery !== undefined) {
    if (kind !== "switch")
      throw Error("Port-security recovery requires a switch.");
    const recovery = object(raw.securityRecovery);
    out.securityRecovery = {
      enabled: bool(recovery.enabled),
      interval: integer(recovery.interval, 30, 86400),
    };
  }
  if (raw.callManager !== undefined) {
    if (kind !== "router") throw Error("Only routers can host a call manager.");
    const manager = object(raw.callManager),
      address = ip(manager.address);
    if (!ports.some((p) => p.ip === address))
      throw Error(
        "Select a configured router interface address for the call manager.",
      );
    const lines = list(manager.lines, 128).map((value) => {
      const line = object(value),
        mac = text(line.mac, 12),
        number = text(line.number, 12);
      if (!validSecureMac(mac))
        throw Error("Use a 12-digit unicast phone MAC.");
      if (!/^\d{1,12}$/.test(number))
        throw Error("Use a 1–12 digit extension.");
      return { mac, number };
    });
    unique(lines.map((line) => line.mac));
    unique(lines.map((line) => line.number));
    out.callManager = { address, lines };
  }
  for (const p of ports)
    if (p.nativeVlan !== undefined) {
      if (!isSwitchport({ kind }, p))
        throw Error("Only physical switchports have a native VLAN.");
      integer(p.nativeVlan, 1, 4094);
    }
  const supportsDiscovery = ["switch", "router", "phone"].includes(kind);
  for (const key of ["cdp", "lldp"] as const)
    if (raw[key] !== undefined) {
      if (!supportsDiscovery)
        throw Error("Discovery requires a router, switch or phone.");
      out[key] = bool(raw[key]);
    }
  for (const p of ports)
    for (const key of ["cdp", "lldpTransmit", "lldpReceive"] as const)
      if (p[key] !== undefined) {
        if (!supportsDiscovery || (kind === "phone" && p.id !== "p0"))
          throw Error("Unsupported discovery interface.");
        bool(p[key]);
      }
  if (kind === "phone") {
    if (
      ports.length !== 2 ||
      ports[0].id !== "p0" ||
      ports[1].id !== "p1" ||
      ports.some((p) => p.media !== "copper")
    )
      throw Error("IP phones require Network and PC copper ports.");
    if (ports[1].ip || ports[1].ipv6 || ports[1].addressMode === "dhcp")
      throw Error("Configure phone addressing on the Network port.");
  }
  if (raw.nat !== undefined) {
    if (kind !== "router") throw Error("Only routers support NAT.");
    const n = object(raw.nat),
      statics = list(n.static, 128).map((value) => {
        const s = object(value),
          inside = ip(s.inside),
          outside = ip(s.outside);
        if (inside === outside || ports.some((p) => p.ip === outside))
          throw Error(
            "Static NAT needs distinct local/global addresses and cannot use a router interface address.",
          );
        return { inside, outside };
      });
    unique(statics.map((s) => s.inside));
    unique(statics.map((s) => s.outside));
    const overload = list(n.overload, 16).map((value) => {
      const o = object(value),
        acl = text(o.acl, 32),
        outsidePort = text(o.outsidePort, 80);
      if (!ports.some((p) => p.id === outsidePort))
        throw Error("NAT overload interface does not exist.");
      return { acl, outsidePort };
    });
    unique(overload.map((o) => `${o.acl}/${o.outsidePort}`));
    const portForwards =
      n.portForwards === undefined
        ? undefined
        : list(n.portForwards, 128).map((value) => {
            const f = object(value);
            if (f.protocol !== "tcp" && f.protocol !== "udp")
              throw Error("Port translation supports TCP/UDP.");
            return {
              protocol: f.protocol as "tcp" | "udp",
              inside: ip(f.inside),
              insidePort: integer(f.insidePort, 1, 65535),
              outside: ip(f.outside),
              outsidePort: integer(f.outsidePort, 1, 65535),
            };
          });
    if (portForwards) {
      unique(
        portForwards.map((f) => `${f.protocol}/${f.inside}/${f.insidePort}`),
      );
      unique(
        portForwards.map((f) => `${f.protocol}/${f.outside}/${f.outsidePort}`),
      );
      if (
        portForwards.some((f) =>
          statics.some((s) => s.inside === f.inside || s.outside === f.outside),
        )
      )
        throw Error(
          "Ambiguous full-address and port-specific static NAT mappings.",
        );
    }
    const pools =
      n.pools === undefined
        ? undefined
        : list(n.pools, 16).map((value) => {
            const p = object(value),
              name = text(p.name, 32),
              prefix = integer(p.prefix, 1, 32),
              start = ip(p.start),
              end = ip(p.end);
            if (
              !/^[A-Za-z0-9_-]+$/.test(name) ||
              ipv4(end)! < ipv4(start)! ||
              ipv4(end)! - ipv4(start)! >= 256 ||
              !sameSubnet(start, end, prefix) ||
              !usableIp(start, prefix) ||
              !usableIp(end, prefix)
            )
              throw Error(
                "NAT pools need a name and 1–256 usable addresses in one subnet.",
              );
            return { name, start, end, prefix };
          });
    if (pools) {
      unique(pools.map((p) => p.name));
      for (let i = 0; i < pools.length; i++) {
        const p = pools[i],
          first = ipv4(p.start)!,
          last = ipv4(p.end)!;
        if (
          pools
            .slice(i + 1)
            .some((q) => first <= ipv4(q.end)! && last >= ipv4(q.start)!)
        )
          throw Error("NAT pool ranges overlap.");
        if (
          [
            ...ports.map((p) => p.ip),
            ...statics.map((s) => s.outside),
            ...(portForwards ?? []).map((f) => f.outside),
          ].some((ip) => ip && ipv4(ip)! >= first && ipv4(ip)! <= last)
        )
          throw Error(
            "NAT pool overlaps a configured interface or static public address.",
          );
      }
    }
    const poolRules =
      n.poolRules === undefined
        ? undefined
        : list(n.poolRules, 16).map((value) => {
            const r = object(value),
              acl = text(r.acl, 32),
              pool = text(r.pool, 32),
              overload = bool(r.overload);
            if (!pools?.some((p) => p.name === pool))
              throw Error("NAT pool rule references a missing pool.");
            return { acl, pool, overload };
          });
    if (poolRules)
      unique(poolRules.map((r) => `${r.acl}/${r.pool}/${r.overload}`));
    out.nat = {
      static: statics,
      ...(n.hairpin === undefined ? {} : { hairpin: bool(n.hairpin) }),
      overload,
      ...(portForwards ? { portForwards } : {}),
      ...(pools ? { pools } : {}),
      ...(poolRules ? { poolRules } : {}),
    };
  }
  if (raw.macAgingSeconds !== undefined) {
    if (kind !== "switch") throw Error("Only switches configure MAC aging.");
    out.macAgingSeconds = integer(raw.macAgingSeconds, 0, 1000000);
    if (out.macAgingSeconds > 0 && out.macAgingSeconds < 10)
      throw Error("MAC aging must be 0 (disabled), or 10–1000000 seconds.");
  }
  if (raw.staticMac !== undefined) {
    if (kind !== "switch")
      throw Error("Only switches support static MAC entries.");
    out.staticMac = list(raw.staticMac, 256).map((value) => {
      const e = object(value),
        mac = text(e.mac, 12),
        vlan = integer(e.vlan, 1, 4094),
        port = text(e.port, 80);
      if (
        !/^[0-9a-f]{12}$/.test(mac) ||
        parseInt(mac.slice(0, 2), 16) & 1 ||
        !ports.some(
          (p) => p.id === port && isSwitchport({ kind }, p) && !p.channelGroup,
        )
      )
        throw Error(
          "Static MAC entries need a unicast MAC and existing interface.",
        );
      return { mac, vlan, port };
    });
    unique(out.staticMac.map((e) => `${e.vlan}/${e.mac}`));
  }
  if (raw.spanningTree !== undefined) {
    if (kind !== "switch")
      throw new Error("Only switches support spanning tree.");
    const priorities = list(object(raw.spanningTree).priorities, 128).map(
      (value) => {
        const entry = object(value),
          vlan = integer(entry.vlan, 1, 4094),
          priority = integer(entry.priority, 0, 61440);
        if (priority % 4096)
          throw new Error("Spanning-tree priority must be a multiple of 4096.");
        return { vlan, priority };
      },
    );
    unique(priorities.map((p) => String(p.vlan)));
    const settings = object(raw.spanningTree);
    out.spanningTree = {
      priorities,
      ...(settings.portFastDefault === undefined
        ? {}
        : { portFastDefault: bool(settings.portFastDefault) }),
      ...(settings.bpduGuardDefault === undefined
        ? {}
        : { bpduGuardDefault: bool(settings.bpduGuardDefault) }),
    };
  }
  for (const port of ports)
    if (port.spanningTreeCost !== undefined) {
      if (!isSwitchport({ kind }, port))
        throw new Error(
          "Only physical switchports support spanning-tree cost.",
        );
      integer(port.spanningTreeCost, 1, 200000000);
    }
  if (raw.gateway6 !== undefined) {
    out.gateway6 = text(raw.gateway6, 45, true);
    if (out.gateway6 && !usableIPv6(out.gateway6))
      throw new Error("Invalid IPv6 gateway.");
  }
  if (raw.ipv6Routing !== undefined) {
    if (kind !== "router" && kind !== "switch")
      throw new Error("IPv6 forwarding requires a router or switch.");
    out.ipv6Routing = bool(raw.ipv6Routing);
  }
  if (raw.routes6 !== undefined) {
    if (kind !== "router" && kind !== "switch")
      throw new Error("IPv6 routes require a router or switch.");
    out.routes6 = list(raw.routes6, 128).map((value) => {
      const r = object(value),
        network = text(r.network, 45),
        prefix = integer(r.prefix, 0, 128),
        nextHop = text(r.nextHop, 45),
        n = ipv6(network);
      if (n === null || (n & mask6(prefix)) !== n || !usableIPv6(nextHop))
        throw new Error(
          "IPv6 routes need an aligned network, prefix and unicast next hop.",
        );
      const result = {
        network,
        prefix,
        nextHop,
        ...(r.interface === undefined
          ? {}
          : { interface: text(r.interface, 80, true) }),
      };
      if (result.interface && !ports.some((p) => p.id === result.interface))
        throw new Error("IPv6 route interface does not exist.");
      return result;
    });
  }
  if (raw.dns !== undefined) out.dns = ip(raw.dns, true);
  if (raw.services !== undefined) {
    if (kind !== "server")
      throw new Error("Only server devices provide application services.");
    out.services = parseServices(raw.services);
  }
  if (raw.routing !== undefined) {
    if (kind !== "router" && kind !== "switch")
      throw new Error("Routing protocols require a router or switch.");
    const r = object(raw.routing);
    if (!["none", "rip", "ospf", "eigrp"].includes(String(r.protocol)))
      throw new Error("Unsupported routing protocol.");
    if (r.protocol === "eigrp" && r.routerId === "0.0.0.0")
      throw new Error("EIGRP router ID must be a nonzero IPv4 address.");
    const networks = list(r.networks, 32).map((value) => {
      const n = object(value),
        prefix = integer(n.prefix, 0, 32);
      return {
        network: network(n.network, prefix),
        prefix,
        area: integer(n.area, 0, 0),
      };
    });
    const passivePorts = list(r.passivePorts, 32).map((p) => text(p, 80));
    unique(passivePorts);
    if (passivePorts.some((id) => !ports.some((p) => p.id === id)))
      throw new Error("Routing passive interface does not exist.");
    out.routing = {
      protocol: r.protocol as RoutingConfig["protocol"],
      processId: integer(r.processId, 1, 65535),
      routerId: ip(r.routerId, true),
      networks,
      passivePorts,
    };
  }
  if (raw.accessLists !== undefined) {
    if (kind !== "router" && kind !== "switch")
      throw new Error("Interface ACLs require a router or switch.");
    out.accessLists = list(raw.accessLists, 16).map((value) => {
      const acl = object(value),
        name = text(acl.name, 32);
      if (!/^[A-Za-z0-9_-]+$/.test(name))
        throw new Error(
          "ACL names use letters, numbers, underscores or hyphens.",
        );
      return { name, rules: list(acl.rules, 128).map(parseRule) } as AccessList;
    });
    unique(out.accessLists.map((acl) => acl.name));
  }
  for (const port of ports) {
    if (
      port.natRole !== undefined &&
      (kind !== "router" || !["inside", "outside"].includes(port.natRole))
    )
      throw Error("NAT roles require router interfaces.");
    if (port.helperAddresses !== undefined) {
      if (!isRoutedInterface({ kind }, port))
        throw Error("DHCP helper addresses require a router interface or SVI.");
      const helpers = list(port.helperAddresses, 64).map((address) =>
        ip(address),
      );
      unique(helpers);
    }
    if (port.ipv6 !== undefined && port.ipv6 && !usableIPv6(port.ipv6))
      throw new Error("Invalid unicast IPv6 interface address.");
    if (port.prefix6 !== undefined) integer(port.prefix6, 1, 128);
    if (kind === "switch" && port.ipv6 && !isRoutedInterface({ kind }, port))
      throw new Error(
        "Configure IPv6 on a VLAN interface or routed switch port.",
      );
    if (port.cost !== undefined) integer(port.cost, 1, 65535);
    if (port.bandwidth !== undefined) integer(port.bandwidth, 1, 2147483647);
    if (port.delay !== undefined) integer(port.delay, 1, 16777215);
    if (
      port.addressMode !== undefined &&
      !["static", "dhcp"].includes(port.addressMode)
    )
      throw new Error("Invalid address mode.");
  }
  for (const port of ports)
    for (const name of [port.inboundAcl, port.outboundAcl]) {
      if (
        name &&
        (!isRoutedInterface({ kind }, port) ||
          !out.accessLists?.some((acl) => acl.name === name))
      )
        throw new Error("Interface references a missing ACL.");
    }
  for (const rule of [
    ...(out.nat?.overload ?? []),
    ...(out.nat?.poolRules ?? []),
  ])
    if (!out.accessLists?.some((a) => a.name === rule.acl))
      throw Error("NAT rule references a missing ACL.");
  return out;
}
