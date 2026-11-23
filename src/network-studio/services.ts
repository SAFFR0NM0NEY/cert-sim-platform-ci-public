import { ipv4Forwarding } from "./vlanInterfaces.ts";
import { applicationHost } from "./wireless.ts";
import type {
  Device,
  DhcpPool,
  Endpoint,
  Port,
  DnsAddressType,
  PacketEvent,
  PingResult,
  Topology,
} from "./types.ts";
import { configurationError, probeIPv4 } from "./engine.ts";
import { ipv4, ipString, sameSubnet, usableIp } from "./addressing.ts";
import { transmitFrame, interfaceMac } from "./ethernet.ts";
import type { L2Path } from "./ethernet.ts";
import { bindRuntime, createRuntime, adoptRuntime } from "./networkRuntime.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
import { reservedNatAddresses } from "./nat.ts";
import { DEFAULT_DHCP_LEASE, normalizeHost, validHost } from "./extensions.ts";

export interface ServiceResult extends PingResult {
  address?: string;
  addresses?: string[];
  ttl?: number;
  body?: string;
  status?: number;
}
export interface DhcpResult extends ServiceResult {
  topology: Topology;
}
function event(
  protocol: PacketEvent["protocol"],
  from: string,
  to: string,
  detail: string,
  phase: PacketEvent["phase"] = "request",
  layer: PacketEvent["layer"] = 7,
): PacketEvent {
  return { id: 0, protocol, from, to, detail, phase, layer, ttl: 32 };
}
function outcome(
  ok: boolean,
  message: string,
  events: PacketEvent[] = [],
  extra: Partial<ServiceResult> = {},
): ServiceResult {
  return {
    ok,
    message,
    events: events.map((e, id) => ({ ...e, id })),
    hops: [],
    ...extra,
  };
}
function invalidTopology(t: Topology): string | null {
  for (const d of t.devices) {
    const error = configurationError(d);
    if (error) return `${d.name}: ${error}`;
  }
  return null;
}
type DhcpTarget = { peer: L2Path; server: Device; serverIp: string };

function* dhcpTargets(t: Topology, peers: L2Path[]): Generator<DhcpTarget> {
  for (const peer of peers)
    if (peer.port.ip && peer.device.services?.dhcp.enabled)
      yield { peer, server: peer.device, serverIp: peer.port.ip };

  for (const peer of peers) {
    if (!ipv4Forwarding(peer.device) || !peer.port.ip) continue;
    for (const serverIp of peer.port.helperAddresses ?? []) {
      const server = addressedDevice(t, serverIp);
      if (server?.services?.dhcp.enabled) yield { peer, server, serverIp };
    }
  }
}

function dhcpExchange(
  t: Topology,
  origin: Endpoint,
  port: Port,
  target: DhcpTarget,
  pool: DhcpPool,
  address: string,
  runtime: NetworkRuntime,
  rebind: boolean,
): ServiceResult {
  const { peer, server, serverIp } = target;
  const relay = peer.device.id !== server.id;
  const via = { device: peer.device.id, port: peer.port.id };
  const events: PacketEvent[] = [];
  for (const [request, reply] of [
    ["DISCOVER", "OFFER"],
    ["REQUEST", "ACK"],
  ] as const) {
    if (rebind && request === "DISCOVER") continue;
    if (
      !rebind &&
      request === "REQUEST" &&
      !transmitFrame(t, origin, "ffffffffffff", runtime).some(
        (p) => p.device.id === via.device && p.port.id === via.port,
      )
    )
      return outcome(
        false,
        "The DHCP REQUEST could not reach the client-facing interface.",
        events,
      );
    events.push(
      event(
        "DHCP",
        origin.device,
        via.device,
        request === "DISCOVER"
          ? `DISCOVER on ${port.name}; broadcast-domain traversal.`
          : `REQUEST ${address}.`,
      ),
    );

    if (relay) {
      events.push(
        event(
          "DHCP",
          via.device,
          server.id,
          `Forward ${request} to ${serverIp} with giaddr ${peer.port.ip}.`,
        ),
      );
      const exchange = probeIPv4(
        t,
        via.device,
        serverIp,
        "udp",
        67,
        runtime,
        32,
        {
          ip: peer.port.ip,
          port: 67,
        },
      );
      events.push(...exchange.events);
      if (
        !exchange.ok ||
        exchange.destinationDevice !== server.id ||
        exchange.destinationPort !== 67
      )
        return outcome(
          false,
          `DHCP relay to ${serverIp} failed. ${exchange.message}`,
          events,
        );
    }
    const detail =
      reply === "OFFER"
        ? `OFFER ${address} from pool ${pool.name}.`
        : `ACK ${address}/${pool.prefix}; gateway ${pool.gateway || "none"}; DNS ${pool.dns || "none"}.`;
    if (relay)
      events.push(event("DHCP", server.id, via.device, detail, "reply"));
    if (
      !transmitFrame(
        t,
        via,
        interfaceMac(origin.device, origin.port),
        runtime,
      ).some((p) => p.device.id === origin.device && p.port.id === origin.port)
    )
      return outcome(
        false,
        `The DHCP ${reply} could not reach the client.`,
        events,
      );
    events.push(event("DHCP", via.device, origin.device, detail, "reply"));
  }
  return outcome(true, "", events);
}

function acceptLease(
  t: Topology,
  client: Device,
  port: Port,
  server: Device,
  serverIp: string,
  pool: DhcpPool,
  address: string,
  events: PacketEvent[],
  runtime: NetworkRuntime,
): DhcpResult {
  const next = structuredClone(t),
    newClient = next.devices.find((d) => d.id === client.id)!,
    newPort = newClient.ports.find((p) => p.id === port.id)!;
  // Another server retains its timed reservation until it receives RELEASE or expires.
  for (const d of next.devices)
    if (d.services)
      d.services.dhcp.leases = d.services.dhcp.leases.filter(
        (l) =>
          !(
            l.client === client.id &&
            l.port === port.id &&
            (d.id === server.id || l.expires === undefined)
          ),
      );
  const duration = pool.leaseSeconds ?? DEFAULT_DHCP_LEASE;
  const now = t.dhcpTime ?? runtime.time;
  next.dhcpTime = now;
  delete newPort.dhcpRetryAt;
  newPort.dhcpLease = {
    ...(pool.tftp ? { tftp: pool.tftp } : {}),
    server: server.id,
    address,
    duration,
    expires: now + duration,
    nextAttempt: now + Math.floor(duration / 2),
    state: "bound",
  };
  next.devices
    .find((d) => d.id === server.id)!
    .services!.dhcp.leases.push({
      serverAddress: serverIp,
      expires: newPort.dhcpLease.expires,
      ...(pool.tftp ? { tftp: pool.tftp } : {}),
      pool: pool.id,
      client: client.id,
      port: port.id,
      ip: address,
    });
  newPort.ip = address;
  newPort.prefix = pool.prefix;
  newPort.addressMode = "dhcp";
  newClient.gateway = pool.gateway;
  newClient.dns = pool.dns;
  if (port.ip && port.ip !== address) {
    runtime.poolBindings = runtime.poolBindings.filter(
      (e) => e.insideIp !== port.ip,
    );
    runtime.hairpin = runtime.hairpin.filter(
      (e) => e.clientIp !== port.ip && e.serverIp !== port.ip,
    );
    runtime.nat = runtime.nat.filter((e) => e.insideIp !== port.ip);
  }
  adoptRuntime(runtime, next);
  return {
    ...outcome(
      true,
      `DHCP ACK: ${client.name} leased ${address}/${pool.prefix} from ${server.name}.`,
      events,
      { address },
    ),
    topology: next,
  };
}

function renewLease(
  t: Topology,
  client: Device,
  port: Port,
  runtime: NetworkRuntime,
): DhcpResult | undefined {
  if (!port.ip || port.addressMode !== "dhcp") return;
  for (const server of t.devices) {
    const service = server.services?.dhcp;
    if (
      !server.powered ||
      !service?.enabled ||
      (port.dhcpLease && port.dhcpLease.server !== server.id)
    )
      continue;
    const lease = service.leases.find(
      (l) => l.client === client.id && l.port === port.id && l.ip === port.ip,
    );
    if (!lease) continue;
    const pool = service.pools.find((p) => p.id === lease.pool);
    const serverIp =
      lease.serverAddress ?? server.ports.find((p) => p.enabled && p.ip)?.ip;
    if (!pool || !serverIp || reservedNatAddresses(t).has(port.ip)) continue;
    const transport = probeIPv4(
      t,
      client.id,
      serverIp,
      "udp",
      67,
      runtime,
      32,
      { ip: port.ip, port: 68 },
    );
    if (
      !transport.ok ||
      transport.destinationDevice !== server.id ||
      transport.destinationPort !== 67
    )
      continue;
    return acceptLease(
      t,
      client,
      port,
      server,
      serverIp,
      pool,
      port.ip,
      [
        event(
          "DHCP",
          client.id,
          server.id,
          `REQUEST renewal of ${port.ip} from ${serverIp}.`,
        ),
        ...transport.events,
        event(
          "DHCP",
          server.id,
          client.id,
          `ACK renewed ${port.ip}/${pool.prefix}.`,
          "reply",
        ),
      ],
      runtime,
    );
  }
}

export function requestDhcp(
  t: Topology,
  clientId: string,
  portId?: string,
  runtime: NetworkRuntime = createRuntime(),
  mode: "request" | "renew" | "rebind" = "request",
): DhcpResult {
  const fail = (message: string, events: PacketEvent[] = []): DhcpResult => ({
    ...outcome(false, message, events),
    topology: t,
  });
  const validation = invalidTopology(t);
  if (validation) return fail(validation);
  const client = t.devices.find((d) => d.id === clientId),
    port = client?.ports.find((p) => p.id === (portId ?? client.ports[0].id));
  if (
    !client ||
    !port ||
    (client.kind === "phone" && port.id !== "p0") ||
    !applicationHost(client.kind)
  )
    return fail(
      "Select an addressable workstation, server or phone interface.",
    );
  if (!client.powered || !port.enabled)
    return fail("DHCP client or interface is disabled.");
  if (mode !== "rebind") {
    const renewed = renewLease(t, client, port, runtime);
    if (renewed) return renewed;
    if (mode === "renew")
      return fail("The issuing DHCP server did not acknowledge renewal.");
  }
  const origin = { device: client.id, port: port.id };
  const peers = transmitFrame(t, origin, "ffffffffffff", runtime);
  let foundPool = false;
  let deliveryFailure: ServiceResult | undefined;
  for (const target of dhcpTargets(t, peers)) {
    const { peer, server } = target,
      service = server.services!.dhcp;
    for (const pool of service.pools) {
      if (
        (server.id === peer.device.id && peer.port.prefix !== pool.prefix) ||
        !sameSubnet(pool.start, peer.port.ip, pool.prefix)
      )
        continue;
      foundPool = true;
      const existing = service.leases.find(
        (l) =>
          l.client === client.id && l.port === port.id && l.pool === pool.id,
      );
      const used = new Set(
        t.devices.flatMap((d) =>
          d.ports
            .filter((p) => p.ip && !(d.id === client.id && p.id === port.id))
            .map((p) => p.ip),
        ),
      );
      for (const ip of reservedNatAddresses(t)) used.add(ip);
      for (const lease of service.leases)
        if (lease.client !== client.id || lease.port !== port.id)
          used.add(lease.ip);
      const candidates = existing
        ? [
            existing.ip,
            ...Array.from({ length: pool.count }, (_, i) =>
              ipString(ipv4(pool.start)! + i),
            ),
          ]
        : Array.from({ length: pool.count }, (_, i) =>
            ipString(ipv4(pool.start)! + i),
          );
      const address = candidates.find(
        (ip) =>
          (mode !== "rebind" || ip === port.ip) &&
          !used.has(ip) &&
          ip !== pool.gateway &&
          ip !== peer.port.ip,
      );
      if (!address) continue;
      const exchange = dhcpExchange(
        t,
        origin,
        port,
        target,
        pool,
        address,
        runtime,
        mode === "rebind",
      );
      if (!exchange.ok) {
        deliveryFailure = exchange;
        continue;
      }
      return acceptLease(
        t,
        client,
        port,
        server,
        target.serverIp,
        pool,
        address,
        exchange.events,
        runtime,
      );
    }
  }
  if (deliveryFailure)
    return fail(deliveryFailure.message, deliveryFailure.events);
  return fail(
    foundPool
      ? "DHCP pool exhausted or every offered address conflicts with a configured device."
      : "No eligible DHCP server or pool for the client subnet. Check VLANs, cabling and router helper addresses.",
    [
      event(
        "DHCP",
        client.id,
        client.id,
        "DISCOVER broadcast; no usable offer received.",
      ),
    ],
  );
}
export function releaseDhcp(
  t: Topology,
  clientId: string,
  portId?: string,
  runtime: NetworkRuntime = createRuntime(),
): DhcpResult {
  const client = t.devices.find((d) => d.id === clientId),
    port = client?.ports.find((p) => p.id === (portId ?? client.ports[0].id));
  if (!client || !port || port.addressMode !== "dhcp")
    return {
      ...outcome(false, "The selected interface has no DHCP lease."),
      topology: t,
    };
  const next = structuredClone(t),
    newClient = next.devices.find((d) => d.id === clientId)!;
  const newPort = newClient.ports.find((p) => p.id === port.id)!;
  newPort.ip = "";
  newPort.addressMode = "static";
  delete newPort.dhcpLease;
  delete newPort.dhcpRetryAt;
  newClient.gateway = "";
  newClient.dns = "";
  const events: PacketEvent[] = [];
  let delivered = false;
  for (const server of next.devices) {
    const service = server.services?.dhcp;
    const lease = service?.leases.find(
      (l) => l.client === clientId && l.port === port.id && l.ip === port.ip,
    );
    if (
      !service ||
      !lease ||
      (port.dhcpLease && port.dhcpLease.server !== server.id)
    )
      continue;
    const serverIp =
      lease.serverAddress ?? server.ports.find((p) => p.enabled && p.ip)?.ip;
    if (!serverIp) continue;
    events.push(
      event("DHCP", clientId, server.id, `RELEASE ${port.ip} to ${serverIp}.`),
    );
    const delivery = probeIPv4(t, clientId, serverIp, "udp", 67, runtime, 32, {
      ip: port.ip,
      port: 68,
      oneWay: true,
    });
    events.push(...delivery.events);
    if (
      delivery.ok &&
      delivery.destinationDevice === server.id &&
      delivery.destinationPort === 67 &&
      service.enabled
    ) {
      service.leases = service.leases.filter((l) => l !== lease);
      delivered = true;
    } else if (lease.expires === undefined) {
      lease.expires = (t.dhcpTime ?? 0) + DEFAULT_DHCP_LEASE;
    }
  }
  adoptRuntime(runtime, next);
  return {
    ...outcome(
      true,
      port.ip
        ? `Released ${port.ip} on ${client.name}.${events.length && !delivered ? " Server reservation retained until expiry." : ""}`
        : `Cancelled DHCP discovery on ${client.name}.`,
      events,
    ),
    topology: next,
  };
}
function addressedDevice(t: Topology, address: string): Device | undefined {
  return t.devices.find(
    (d) => d.powered && d.ports.some((p) => p.enabled && p.ip === address),
  );
}
export function dnsLookup(
  t: Topology,
  clientId: string,
  name: string,
  explicitServer?: string,
  runtime: NetworkRuntime = createRuntime(),
  type: DnsAddressType = "A",
): ServiceResult {
  const client = t.devices.find((d) => d.id === clientId),
    serverIp = explicitServer ?? client?.dns ?? "";
  if (!validHost(name)) return outcome(false, "Enter a valid DNS host name.");
  if (!usableIp(serverIp, 32))
    return outcome(false, "Configure a DNS server IPv4 address on the client.");
  const transport = probeIPv4(t, clientId, serverIp, "udp", 53, runtime);
  if (!transport.ok)
    return outcome(
      false,
      `DNS transport failed: ${transport.message}`,
      transport.events,
    );
  const server =
      t.devices.find((d) => d.id === transport.destinationDevice) ??
      addressedDevice(t, serverIp),
    events = [...transport.events];
  if (!server?.services?.dns.enabled || transport.destinationPort !== 53)
    return outcome(false, "Destination is not an enabled DNS server.", [
      ...events,
      event(
        "DROP",
        server?.id ?? clientId,
        clientId,
        "DNS service unavailable.",
        "reply",
      ),
    ]);
  events.push(
    event(
      "DNS",
      clientId,
      server.id,
      `Query ${type} ${normalizeHost(name)} over UDP/53.`,
    ),
  );
  let current = normalizeHost(name);
  let ttl = Infinity;
  const seen = new Set<string>();
  for (let depth = 0; depth < 16; depth++) {
    if (seen.has(current))
      return outcome(false, "DNS CNAME cycle detected.", [
        ...events,
        event("DNS", server.id, clientId, "SERVFAIL: CNAME cycle.", "reply"),
      ]);
    seen.add(current);
    const records = server.services.dns.records.filter(
      (r) => normalizeHost(r.name) === current,
    );
    if (!records.length)
      return outcome(false, `DNS NXDOMAIN: ${current}.`, [
        ...events,
        event("DNS", server.id, clientId, `NXDOMAIN ${current}.`, "reply"),
      ]);
    const answers = records.filter((r) => r.type === type);
    if (answers.length) {
      const addresses = answers.map((r) => r.value);
      ttl = Math.min(ttl, ...answers.map((r) => r.ttl ?? 300));
      return outcome(
        true,
        `${normalizeHost(name)} resolves to ${addresses.join(", ")}.`,
        [
          ...events,
          event(
            "DNS",
            server.id,
            clientId,
            `${type} ${current} = ${addresses.join(", ")}. TTL ${ttl}s.`,
            "reply",
          ),
        ],
        { address: addresses[0], addresses, ttl },
      );
    }
    const record = records.find((r) => r.type === "CNAME");
    if (!record)
      return outcome(false, `No ${type} records for ${current}.`, [
        ...events,
        event(
          "DNS",
          server.id,
          clientId,
          `NOERROR, empty ${type} answer for ${current}.`,
          "reply",
        ),
      ]);
    ttl = Math.min(ttl, record.ttl ?? 300);
    events.push(
      event(
        "DNS",
        server.id,
        clientId,
        `CNAME ${current} → ${record.value}.`,
        "reply",
      ),
    );
    current = normalizeHost(record.value);
  }
  return outcome(false, "DNS alias depth exceeds 16.", events);
}
export function resolveHostname(
  t: Topology,
  clientId: string,
  name: string,
  type: DnsAddressType,
  runtime: NetworkRuntime = createRuntime(),
): ServiceResult {
  bindRuntime(runtime, t);
  const client = t.devices.find((d) => d.id === clientId);
  if (!client?.powered)
    return outcome(false, "Resolver client is unavailable.");
  const normalized = normalizeHost(name);
  const entry = runtime.dnsAnswers.find(
    (e) =>
      e.device === clientId &&
      e.server === client.dns &&
      e.name === normalized &&
      e.type === type,
  );
  if (entry)
    return outcome(
      true,
      `${normalized} resolves to ${entry.addresses.join(", ")} from cache.`,
      [],
      {
        address: entry.addresses[0],
        addresses: [...entry.addresses],
        ttl: entry.expires - runtime.time,
      },
    );
  const result = dnsLookup(t, clientId, name, client.dns, runtime, type);
  if (result.ok && result.addresses && result.ttl && client.dns) {
    if (runtime.dnsAnswers.length >= 4096) runtime.dnsAnswers.shift();
    runtime.dnsAnswers.push({
      device: clientId,
      server: client.dns,
      name: normalized,
      type,
      addresses: [...result.addresses],
      expires: runtime.time + result.ttl,
    });
  }
  return result;
}
/** An in-model HTTP request. Never performs host networking or evaluates page content. */
export function httpRequest(
  t: Topology,
  clientId: string,
  input: string,
  runtime: NetworkRuntime = createRuntime(),
): ServiceResult {
  let url: URL;
  try {
    if (input.length > 2048) throw new Error();
    url = new URL(input.includes("://") ? input : `http://${input}`);
    if (
      url.protocol !== "http:" ||
      (url.port && Number(url.port) < 1) ||
      url.username ||
      url.password
    )
      throw new Error();
  } catch {
    return outcome(
      false,
      "Use a simulated http://host[:port]/path URL without credentials.",
    );
  }
  const events: PacketEvent[] = [];
  let address = url.hostname;
  if (ipv4(address) === null) {
    const lookup = resolveHostname(t, clientId, address, "A", runtime);
    events.push(...lookup.events);
    if (!lookup.ok || !lookup.address)
      return outcome(false, lookup.message, events);
    address = lookup.address;
  }
  const transport = probeIPv4(
    t,
    clientId,
    address,
    "tcp",
    Number(url.port) || 80,
    runtime,
  );
  events.push(...transport.events);
  if (!transport.ok)
    return outcome(
      false,
      `HTTP transport failed: ${transport.message}`,
      events,
    );
  const server =
    t.devices.find((d) => d.id === transport.destinationDevice) ??
    addressedDevice(t, address);
  if (!server?.services?.http.enabled || transport.destinationPort !== 80)
    return outcome(
      false,
      `Delivered TCP/${transport.destinationPort} has no enabled HTTP service.`,
      [
        ...events,
        event(
          "DROP",
          server?.id ?? clientId,
          clientId,
          "HTTP service unavailable.",
          "reply",
        ),
      ],
    );
  events.push(
    event(
      "HTTP",
      clientId,
      server.id,
      `GET ${url.pathname || "/"} HTTP/1.1; Host: ${url.host}.`,
    ),
  );
  const path = url.pathname || "/";
  const indexAlias =
    path === "/" ? "/index.html" : path === "/index.html" ? "/" : undefined;
  const page =
    server.services.http.pages.find((p) => p.path === path) ??
    server.services.http.pages.find((p) => p.path === indexAlias);
  const status = page ? 200 : 404,
    body = page?.body ?? "404 — Page not found";
  events.push(
    event(
      "HTTP",
      server.id,
      clientId,
      `HTTP/1.1 ${status}; ${new TextEncoder().encode(body).length} response bytes.`,
      "reply",
    ),
  );
  return outcome(
    !!page,
    `HTTP ${status} from ${server.name}${page ? "" : ": page not found"}.`,
    events,
    { address, body, status },
  );
}
