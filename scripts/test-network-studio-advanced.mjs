import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceWorkspaceClock } from "../src/network-studio/workspaceClock.ts";
import {
  createRuntime,
  advanceRuntime,
} from "../src/network-studio/networkRuntime.ts";
import {
  servicesLab,
  dhcpRelayLab as readyDhcpRelayLab,
  routingLab,
  dualStackLab,
  wirelessLab,
  wirelessRepairLab,
} from "../src/network-studio/labs.ts";
import {
  dnsLookup,
  resolveHostname,
  httpRequest,
  requestDhcp,
  releaseDhcp,
} from "../src/network-studio/services.ts";
import {
  learnedRoutes,
  routingNeighbors,
} from "../src/network-studio/routing.ts";
import { ping, configurationError } from "../src/network-studio/engine.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
import { command, INITIAL_CLI } from "../src/network-studio/cli.ts";
import { createDevice, connect } from "../src/network-studio/model.ts";
import {
  captureActivity,
  resetActivity,
  checkActivity,
} from "../src/network-studio/activity.ts";
import { interfaceMac } from "../src/network-studio/ethernet.ts";
import {
  associatedAccessPoint,
  nearbyAccessPoints,
} from "../src/network-studio/wireless.ts";
import { ping6 } from "../src/network-studio/ipv6Engine.ts";
import { defaultRouting } from "../src/network-studio/extensions.ts";

test("DHCP DORA allocates distinct collision-free leases, renews stably and releases actual config", () => {
  let t = servicesLab();
  const [client, , other, server] = t.devices;
  const first = requestDhcp(t, client.id);
  assert.equal(first.ok, true);
  assert.equal(first.address, "192.168.10.50");
  assert.deepEqual(
    first.events.map((e) => e.detail.split(" ")[0]),
    ["DISCOVER", "OFFER", "REQUEST", "ACK"],
  );
  assert.equal(client.ports[0].ip, "192.168.10.10", "input remains immutable");
  t = first.topology;
  assert.equal(t.devices[0].dns, server.ports[0].ip);
  const renew = requestDhcp(t, client.id);
  assert.equal(renew.address, first.address);
  const second = requestDhcp(renew.topology, other.id);
  assert.equal(second.address, "192.168.10.51");
  const release = releaseDhcp(second.topology, client.id);
  assert.equal(release.ok, true);
  assert.equal(release.topology.devices[0].ports[0].ip, "");
  assert.equal(release.topology.devices[3].services.dhcp.leases.length, 1);
  assert.deepEqual(
    parseTopology(serializeTopology(second.topology)),
    second.topology,
  );
});
test("DHCP respects VLANs, disabled services, exhausted pools and static IP conflicts", () => {
  for (const kind of ["vlan", "disabled", "exhausted", "conflict"]) {
    let t = servicesLab();
    const client = t.devices[0],
      server = t.devices[3];
    if (kind === "vlan") t.devices[1].ports[0].vlan = 20;
    if (kind === "disabled") server.services.dhcp.enabled = false;
    if (kind === "conflict") {
      server.services.dhcp.pools[0].count = 1;
      t.devices[2].ports[0].ip = "192.168.10.50";
    }
    if (kind === "exhausted") {
      server.services.dhcp.pools[0].count = 1;
      t = requestDhcp(t, t.devices[2].id).topology;
    }
    const result = requestDhcp(t, client.id);
    assert.equal(result.ok, false, kind);
    assert.equal(result.topology, t);
  }
});
function dhcpRelayLab() {
  const t = routingLab();
  const [client, relay, , server] = t.devices;
  client.ports[0].ip = "";
  client.gateway = "";
  relay.ports[0].helperAddresses = ["10.2.0.99", server.ports[0].ip];
  server.services.dhcp = {
    enabled: true,
    leases: [],
    pools: [
      {
        id: "servers",
        name: "Servers",
        start: "10.2.0.50",
        count: 2,
        prefix: 24,
        gateway: "10.2.0.1",
        dns: "",
      },
      {
        id: "clients",
        name: "Clients",
        start: "10.1.0.50",
        count: 2,
        prefix: 24,
        gateway: "10.1.0.1",
        dns: "10.2.0.100",
        tftp: "10.1.0.1",
      },
    ],
  };
  return t;
}

test("DHCP relay selects the client-facing pool and routes both UDP/67 legs through OSPF", () => {
  const t = dhcpRelayLab();
  const [client, relay, transit, server] = t.devices;
  const result = requestDhcp(t, client.id);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.address, "10.1.0.50");
  assert.equal(result.topology.devices[0].gateway, relay.ports[0].ip);
  assert.equal(result.topology.devices[0].dns, server.ports[0].ip);
  assert.equal(
    result.topology.devices[3].services.dhcp.leases[0].tftp,
    relay.ports[0].ip,
  );
  for (const phase of ["request", "reply"]) {
    assert.ok(
      result.events.some(
        (e) =>
          e.protocol === "UDP" &&
          e.phase === phase &&
          e.to === transit.id &&
          e.detail.endsWith("port 67"),
      ),
    );
  }
  assert.deepEqual(
    result.events
      .filter((e) => e.detail.includes("giaddr"))
      .map((e) => e.detail),
    [
      "Forward DISCOVER to 10.2.0.100 with giaddr 10.1.0.1.",
      "Forward REQUEST to 10.2.0.100 with giaddr 10.1.0.1.",
    ],
  );
  const saved = parseTopology(serializeTopology(result.topology));
  delete saved.devices[1].ports[0].helperAddresses;
  const renewed = requestDhcp(saved, client.id);
  assert.equal(renewed.address, result.address);
  assert.ok(renewed.events.some((e) => e.detail.startsWith("REQUEST renewal")));
  const release = releaseDhcp(renewed.topology, client.id);
  assert.equal(release.topology.devices[3].services.dhcp.leases.length, 0);
  assert.equal(requestDhcp(release.topology, client.id).ok, false);
});

test("DHCP relay requires the configured input interface, matching pool and reachable UDP return path", () => {
  for (const cause of [
    "wrong-interface",
    "wrong-pool",
    "link",
    "return",
    "policy",
    "exhausted",
  ]) {
    const t = dhcpRelayLab();
    const [client, relay, transit, server] = t.devices;
    if (cause === "wrong-interface") {
      relay.ports[1].helperAddresses = relay.ports[0].helperAddresses;
      delete relay.ports[0].helperAddresses;
    }
    if (cause === "wrong-pool") server.services.dhcp.pools.pop();
    if (cause === "link") t.links.splice(1, 1);
    if (cause === "return") server.gateway = "";
    if (cause === "exhausted") {
      server.services.dhcp.pools[1].start = "10.1.0.1";
      server.services.dhcp.pools[1].count = 1;
    }
    if (cause === "policy") {
      transit.accessLists = [
        {
          name: "block",
          rules: [
            {
              action: "deny",
              protocol: "udp",
              source: server.ports[0].ip,
              sourcePrefix: 32,
              destination: relay.ports[0].ip,
              destinationPrefix: 32,
              destinationPort: 67,
            },
          ],
        },
      ];
      transit.ports[0].inboundAcl = "block";
    }
    const result = requestDhcp(t, client.id);
    assert.equal(result.ok, false, cause);
    assert.equal(result.topology, t, cause);
    assert.equal(server.services.dhcp.leases.length, 0, cause);
    if (cause === "policy") assert.match(result.message, /block.*deny UDP/);
    if (cause === "return") assert.match(result.message, /reply failed/i);
  }
});

test("router helper commands persist across save and reload and validate individual unicast addresses", () => {
  let t = routingLab();
  const [, router] = t.devices;
  let session = INITIAL_CLI;
  const run = (line) => {
    const result = command(t, router.id, session, line);
    t = result.topology;
    session = result.session;
    return result;
  };
  for (const line of [
    "enable",
    "configure terminal",
    "interface GigabitEthernet0/0",
    "ip helper-address 10.2.0.100",
    "ip helper-address 10.2.0.101",
  ])
    run(line);
  assert.equal(run("ip helper-address 10.2.0.101").changed, false);
  assert.match(run("ip helper-address 224.0.0.1").output, /unicast/);
  run("no ip helper-address 10.2.0.101");
  run("end");
  assert.match(
    run("show running-config").output,
    /ip helper-address 10\.2\.0\.100/,
  );
  run("write memory");
  t = parseTopology(serializeTopology(t));
  run("reload");
  assert.deepEqual(t.devices[1].ports[0].helperAddresses, ["10.2.0.100"]);
  t.devices[0].ports[0].helperAddresses = ["10.2.0.100"];
  assert.throws(() => parseTopology(serializeTopology(t)), /router interface/);
});

test("direct and relayed leases renew at T1 and resume the same clock after JSON reload", () => {
  for (const build of [servicesLab, readyDhcpRelayLab]) {
    let t = build();
    let r = createRuntime();
    t.devices[3].services.dhcp.pools[0].leaseSeconds = 80;
    const id = t.devices[0].id;
    t = requestDhcp(t, id, undefined, r).topology;
    t = advanceWorkspaceClock(r, t, 39);
    let lease = t.devices[0].ports[0].dhcpLease;
    assert.equal(lease.state, "bound");
    assert.equal(lease.expires, 80);
    t = parseTopology(serializeTopology(t));
    r = createRuntime();
    t = advanceWorkspaceClock(r, t, 1);
    lease = t.devices[0].ports[0].dhcpLease;
    assert.equal(r.time, 40);
    assert.equal(t.dhcpTime, 40);
    assert.equal(lease.state, "bound");
    assert.equal(lease.nextAttempt, 80);
    assert.equal(lease.expires, 120);
    assert.equal(t.devices[3].services.dhcp.leases[0].expires, 120);
  }
});

test("legacy DHCP files without deadlines keep their binding and adopt the default duration on renewal", () => {
  const starting = servicesLab();
  const pc = starting.devices[0];
  const old = requestDhcp(starting, pc.id).topology;
  delete old.dhcpTime;
  delete old.devices[0].ports[0].dhcpLease;
  const reservation = old.devices[3].services.dhcp.leases[0];
  delete reservation.expires;
  delete reservation.serverAddress;
  const restored = parseTopology(serializeTopology(old));
  assert.deepEqual(restored, old);
  const renewal = requestDhcp(restored, pc.id);
  assert.equal(renewal.address, reservation.ip);
  assert.equal(renewal.topology.devices[0].ports[0].dhcpLease.duration, 86400);
  const invalid = structuredClone(renewal.topology);
  invalid.devices[0].ports[0].dhcpLease.nextAttempt = -1;
  assert.throws(() => parseTopology(serializeTopology(invalid)));
});
test("T2 broadcasts for the same lease when the issuing server is unavailable", () => {
  let t = servicesLab();
  const r = createRuntime();
  const [pc, sw, , primary] = t.devices;
  primary.services.dhcp.pools[0].leaseSeconds = 80;
  t = requestDhcp(t, pc.id, undefined, r).topology;
  const address = t.devices[0].ports[0].ip;
  const standby = createDevice("server", 2);
  standby.ports[0].ip = "192.168.10.101";
  standby.services = structuredClone(primary.services);
  standby.services.dhcp.pools[0].dns = standby.ports[0].ip;
  t.devices.push(standby);
  t = connect(
    t,
    { device: sw.id, port: "p5" },
    { device: standby.id, port: "p0" },
    "copper",
  );
  t.devices[3].powered = false;
  t = advanceWorkspaceClock(r, t, 40);
  assert.equal(t.devices[0].ports[0].dhcpLease.state, "renewing");
  assert.equal(t.devices[4].services.dhcp.leases.length, 0);
  t = advanceWorkspaceClock(r, t, 29);
  assert.equal(t.devices[0].ports[0].dhcpLease.server, primary.id);
  t = advanceWorkspaceClock(r, t, 1);
  assert.equal(t.devices[0].ports[0].ip, address);
  assert.equal(t.devices[0].ports[0].dhcpLease.server, standby.id);
  assert.equal(t.devices[0].dns, standby.ports[0].ip);
  assert.equal(t.devices[4].services.dhcp.leases[0].expires, 150);
  assert.equal(t.devices[3].services.dhcp.leases.length, 1);
  t = advanceWorkspaceClock(r, t, 10);
  assert.equal(t.devices[3].services.dhcp.leases.length, 0);
  assert.equal(t.devices[0].ports[0].dhcpLease.server, standby.id);
});

test("expired relayed clients clear address and options even if their server was removed; static overrides survive", () => {
  let t = readyDhcpRelayLab();
  const r = createRuntime();
  const pc = t.devices[0];
  t = requestDhcp(t, pc.id, undefined, r).topology;
  t.devices.pop();
  t.links.pop();
  t = advanceWorkspaceClock(r, t, 105);
  const active = t.devices[0].ports[0];
  assert.equal(active.dhcpLease.state, "rebinding");
  assert.equal(active.ip, "10.1.0.50");
  const overridden = structuredClone(t);
  Object.assign(overridden.devices[0].ports[0], {
    ip: "10.1.0.75",
    addressMode: "static",
  });
  const expired = advanceWorkspaceClock(r, t, 15);
  assert.equal(expired.devices[0].ports[0].ip, "");
  assert.equal(expired.devices[0].ports[0].addressMode, "dhcp");
  assert.equal(expired.devices[0].gateway, "");
  assert.equal(expired.devices[0].dns, "");
  const preserved = advanceWorkspaceClock(createRuntime(), overridden, 15);
  assert.equal(preserved.devices[0].ports[0].ip, "10.1.0.75");
  assert.equal(preserved.devices[0].ports[0].dhcpLease, undefined);
});

test("expired wired and wireless clients rediscover on the saved deadline when DHCP returns", () => {
  for (const build of [readyDhcpRelayLab, wirelessLab]) {
    let t = build();
    let r = createRuntime();
    const id = t.devices[0].id;
    t.devices[3].services.dhcp.pools[0].leaseSeconds = 8;
    t = requestDhcp(t, id, undefined, r).topology;
    const address = t.devices[0].ports[0].ip;
    t.devices[3].services.dhcp.enabled = false;
    t = advanceWorkspaceClock(r, t, 86400);
    const retryAt = t.devices[0].ports[0].dhcpRetryAt;
    assert.ok(retryAt > t.dhcpTime && retryAt <= t.dhcpTime + 60);
    assert.equal(t.devices[0].ports[0].ip, "");
    t = parseTopology(serializeTopology(t));
    r = createRuntime();
    t.devices[3].services.dhcp.enabled = true;
    t = advanceWorkspaceClock(r, t, retryAt - t.dhcpTime - 1);
    assert.equal(t.devices[0].ports[0].ip, "");
    const released = releaseDhcp(t, id).topology;
    assert.equal(
      advanceWorkspaceClock(createRuntime(), released, 60).devices[0].ports[0]
        .ip,
      "",
    );
    const manual = structuredClone(t);
    Object.assign(manual.devices[0].ports[0], {
      addressMode: "static",
      ip: "192.0.2.75",
    });
    const staticPort = advanceWorkspaceClock(createRuntime(), manual, 60)
      .devices[0].ports[0];
    assert.equal(staticPort.ip, "192.0.2.75");
    assert.equal(staticPort.dhcpRetryAt, undefined);
    t = advanceWorkspaceClock(r, t, 1);
    assert.equal(t.devices[0].ports[0].ip, address);
    assert.equal(t.devices[0].ports[0].dhcpLease.state, "bound");
    assert.equal(t.devices[0].ports[0].dhcpRetryAt, undefined);
  }
});

test("lost DHCPRELEASE retains the server reservation until expiry and short leases scale to day-sized jumps", () => {
  let t = servicesLab();
  const r = createRuntime();
  const pc = t.devices[0];
  t.devices[3].services.dhcp.pools[0].leaseSeconds = 8;
  t = requestDhcp(t, pc.id, undefined, r).topology;
  t = advanceWorkspaceClock(r, t, 86400);
  assert.equal(t.dhcpTime, 86400);
  assert.equal(t.devices[0].ports[0].dhcpLease.expires, 86408);
  t.devices[3].powered = false;
  const released = releaseDhcp(t, pc.id, undefined, r);
  assert.match(released.message, /retained until expiry/);
  t = released.topology;
  assert.equal(t.devices[0].ports[0].dhcpLease, undefined);
  assert.equal(t.devices[3].services.dhcp.leases.length, 1);
  t = advanceWorkspaceClock(r, t, 8);
  assert.equal(t.devices[3].services.dhcp.leases.length, 0);
});

test("DNS handles case-insensitive A/CNAME, NXDOMAIN, cycles, disabled service and missing resolver", () => {
  const t = servicesLab(),
    client = t.devices[0],
    server = t.devices[3];
  assert.equal(
    dnsLookup(t, client.id, "WWW.CERTSIM.LAB.").address,
    "192.168.10.100",
  );
  assert.match(dnsLookup(t, client.id, "absent.lab").message, /NXDOMAIN/);
  server.services.dns.records.push(
    { name: "a.lab", type: "CNAME", value: "b.lab" },
    { name: "b.lab", type: "CNAME", value: "a.lab" },
  );
  assert.match(dnsLookup(t, client.id, "a.lab").message, /cycle/);
  server.services.dns.enabled = false;
  assert.equal(dnsLookup(t, client.id, "certsim.lab").ok, false);
  client.dns = "";
  assert.match(
    dnsLookup(t, client.id, "certsim.lab").message,
    /Configure a DNS/,
  );
});
test("HTTP resolves DNS, checks routed TCP and returns only configured page bodies/status", () => {
  const t = servicesLab(),
    client = t.devices[0];
  const result = httpRequest(t, client.id, "http://www.certsim.lab/status");
  assert.equal(result.ok, true);
  assert.equal(result.body, "Lab server: online");
  assert.equal(result.status, 200);
  assert.ok(result.events.some((e) => e.protocol === "DNS"));
  assert.ok(result.events.some((e) => e.protocol === "TCP"));
  assert.ok(result.events.some((e) => e.protocol === "HTTP"));
  assert.equal(
    httpRequest(t, client.id, "http://certsim.lab/absent").status,
    404,
  );
  for (const url of [
    "https://certsim.lab/",
    "http://user:pass@certsim.lab/",
    "http://certsim.lab:8080/",
    "javascript:alert(1)",
  ])
    assert.equal(httpRequest(t, client.id, url).ok, false);
  t.links = [];
  assert.equal(httpRequest(t, client.id, "http://192.168.10.100/").ok, false);
});
test("HTTP root and index aliases preserve explicitly configured pages", () => {
  const t = servicesLab(),
    client = t.devices[0],
    server = t.devices.find((d) => d.kind === "server");
  const request = (path) => httpRequest(t, client.id, "http://certsim.lab" + path);
  server.services.http.pages = [{ path: "/", body: "Root page" }];
  assert.equal(request("/index.html").body, "Root page");
  server.services.http.pages = [{ path: "/index.html", body: "Index page" }];
  assert.equal(request("/").body, "Index page");
  server.services.http.pages.push({ path: "/", body: "Explicit root" });
  assert.equal(request("/").body, "Explicit root");
  assert.equal(request("/index.html").body, "Index page");
  assert.equal(request("/missing").status, 404);
  assert.equal(request("/nested/").status, 404);
});
test("OSPF derives useful routes with no static routes and withdraws them on link or power failure", () => {
  const t = routingLab(),
    [client, r1, r2, server] = t.devices;
  assert.equal(r1.routes.length, 0);
  assert.equal(routingNeighbors(t, r1.id).length, 1);
  assert.equal(
    learnedRoutes(t, r1.id).find((r) => r.network === "10.2.0.0").nextHop,
    "172.16.0.2",
  );
  assert.equal(ping(t, client.id, server.ports[0].ip).ok, true);
  assert.equal(httpRequest(t, client.id, "http://certsim.lab/").ok, true);
  r2.powered = false;
  assert.equal(learnedRoutes(t, r1.id).length, 0);
  assert.equal(ping(t, client.id, server.ports[0].ip).ok, false);
  r2.powered = true;
  r1.ports[1].enabled = false;
  assert.equal(learnedRoutes(t, r1.id).length, 0);
});
test("RIPv2 learns routes; passive, protocol, subnet and duplicate OSPF ID mismatches prevent adjacencies", () => {
  for (const protocol of ["rip", "ospf"]) {
    const t = routingLab(),
      [client, r1, r2, server] = t.devices;
    r1.routing.protocol = protocol;
    r2.routing.protocol = protocol;
    assert.equal(ping(t, client.id, server.ports[0].ip).ok, true);
    r2.routing.passivePorts.push("p1");
    assert.equal(routingNeighbors(t, r1.id).length, 0);
    r2.routing.passivePorts = ["p0"];
    r2.routing.protocol = "none";
    assert.equal(routingNeighbors(t, r1.id).length, 0);
    r2.routing.protocol = protocol;
    if (protocol === "ospf") {
      r1.routing.routerId = "1.1.1.1";
      r2.routing.routerId = "1.1.1.1";
      assert.equal(routingNeighbors(t, r1.id).length, 0);
    }
  }
});
test("equal-prefix static routes outrank learned routes without fallback through a broken configured next hop", () => {
  const t = routingLab(),
    [client, r1, , server] = t.devices;
  r1.routes = [{ network: "10.2.0.0", prefix: 24, nextHop: "172.16.0.3" }];
  assert.equal(ping(t, client.id, server.ports[0].ip).ok, false);
  r1.routes = [];
  assert.equal(ping(t, client.id, server.ports[0].ip).ok, true);
});
test("RIP hop limit excludes a 16-hop destination that the OSPF model can reach", () => {
  const devices = Array.from({ length: 17 }, (_, i) =>
    createDevice("router", i + 1),
  );
  for (const d of devices)
    d.routing = {
      ...defaultRouting(),
      protocol: "rip",
      networks: [{ network: "0.0.0.0", prefix: 0, area: 0 }],
    };
  let t = { version: 1, name: "Hop bound", devices, links: [] };
  for (let i = 0; i < 16; i++) {
    devices[i].ports[1].ip = `172.16.${i}.1`;
    devices[i].ports[1].prefix = 30;
    devices[i + 1].ports[0].ip = `172.16.${i}.2`;
    devices[i + 1].ports[0].prefix = 30;
    t = connect(
      t,
      { device: devices[i].id, port: "p1" },
      { device: devices[i + 1].id, port: "p0" },
      "copper",
    );
  }
  devices[16].ports[1].ip = "10.99.0.1";
  const endpoint = createDevice("pc", 18);
  endpoint.ports[0].ip = "10.99.0.2";
  t.devices.push(endpoint);
  t = connect(
    t,
    { device: devices[16].id, port: "p1" },
    { device: endpoint.id, port: "p0" },
    "copper",
  );
  assert.equal(
    learnedRoutes(t, devices[0].id).some((r) => r.network === "10.99.0.0"),
    false,
  );
  for (const d of devices.filter((d) => d.kind === "router"))
    d.routing.protocol = "ospf";
  assert.equal(
    learnedRoutes(t, devices[0].id).find((r) => r.network === "10.99.0.0")
      .metric,
    17,
  );
});
function permitAll() {
  return {
    action: "permit",
    protocol: "ip",
    source: "0.0.0.0",
    sourcePrefix: 0,
    destination: "0.0.0.0",
    destinationPrefix: 0,
  };
}
test("ACLs honor order/implicit deny and application probes do not depend on ICMP permission", () => {
  const t = routingLab(),
    [client, r1, , server] = t.devices;
  r1.accessLists = [
    {
      name: "edge",
      rules: [
        { ...permitAll(), action: "deny", protocol: "icmp" },
        permitAll(),
      ],
    },
  ];
  r1.ports[0].inboundAcl = "edge";
  assert.equal(ping(t, client.id, server.ports[0].ip).ok, false);
  const http = httpRequest(t, client.id, "http://certsim.lab/");
  assert.equal(http.ok, true);
  assert.ok(http.events.some((e) => e.protocol === "ACL"));
  r1.accessLists[0].rules = [
    permitAll(),
    { ...permitAll(), action: "deny", protocol: "icmp" },
  ];
  assert.equal(ping(t, client.id, server.ports[0].ip).ok, true);
  r1.accessLists[0].rules = [];
  assert.match(ping(t, client.id, server.ports[0].ip).message, /implicit deny/);
});
test("stateless ACLs independently filter response ports; outbound attachments affect forwarding", () => {
  const t = routingLab(),
    [client, r1] = t.devices;
  r1.accessLists = [
    {
      name: "only-http-destination",
      rules: [{ ...permitAll(), protocol: "tcp", destinationPort: 80 }],
    },
  ];
  r1.ports[0].inboundAcl = "only-http-destination";
  assert.equal(httpRequest(t, client.id, "http://10.2.0.100/").ok, true);
  r1.ports[1].inboundAcl = "only-http-destination";
  assert.match(
    httpRequest(t, client.id, "http://10.2.0.100/").message,
    /reply failed/,
  );
  r1.ports[1].inboundAcl = "";
  r1.ports[1].outboundAcl = "only-http-destination";
  assert.equal(dnsLookup(t, client.id, "certsim.lab").ok, false);
});
test("extended JSON validates and preserves operational state; invalid extensions fail atomically", () => {
  const t = routingLab();
  t.devices[1].accessLists = [{ name: "safe", rules: [permitAll()] }];
  t.devices[1].ports[0].inboundAcl = "safe";
  assert.deepEqual(parseTopology(serializeTopology(t)), t);
  const mutations = [
    (d) => (d.routing.protocol = "bgp"),
    (d) => (d.routing.networks[0].area = 1),
    (d) => (d.ports[0].cost = -1),
    (d) => (d.ports[0].inboundAcl = "absent"),
    (d) => (d.accessLists[0].rules[0].sourcePrefix = 33),
  ];
  for (const mutate of mutations) {
    const next = structuredClone(t);
    mutate(next.devices[1]);
    assert.throws(() => parseTopology(serializeTopology(next)));
  }
  const s = servicesLab();
  s.devices[3].services.dhcp.pools[0].count = 999;
  assert.throws(() => parseTopology(serializeTopology(s)));
  assert.equal(configurationError(t.devices[1]), null);
});
test("CLI configures real OSPF networks/passive ports, ACL binding and DHCP/DNS host actions", () => {
  let t = routingLab();
  const id = t.devices[1].id;
  t.devices[1].routing = undefined;
  let session = INITIAL_CLI;
  const run = (line) => {
    const r = command(t, id, session, line);
    t = r.topology;
    session = r.session;
    return r;
  };
  run("enable");
  run("configure terminal");
  run("router ospf 1");
  assert.equal(session.mode, "routing");
  assert.equal(run("network 0.0.0.0 255.255.255.255 area 0").changed, true);
  run("passive-interface GigabitEthernet0/0");
  run("end");
  assert.match(run("show ip route").output, /O 10\.2\.0\.0/);
  run("configure terminal");
  run("no router rip");
  assert.equal(t.devices[1].routing.protocol, "ospf");
  run("no router ospf 2");
  assert.equal(t.devices[1].routing.protocol, "ospf");
  run("access-list edge deny icmp any any");
  run("access-list edge permit ip any any");
  run("interface GigabitEthernet0/0");
  assert.equal(run("ip access-group edge in").changed, true);
  run("end");
  assert.equal(ping(t, t.devices[0].id, "10.2.0.100").ok, false);
  assert.match(run("show access-lists").output, /deny icmp/);
  run("configure terminal");
  run("no router ospf 1");
  assert.equal(t.devices[1].routing.protocol, "none");
  run("end");
  assert.match(run("show ip ospf neighbor").output, /not enabled/);
  const local = servicesLab(),
    pc = local.devices[0];
  const renew = command(local, pc.id, INITIAL_CLI, "ipconfig /renew");
  assert.equal(renew.changed, true);
  assert.match(
    command(renew.topology, pc.id, INITIAL_CLI, "nslookup certsim.lab").output,
    /192.168.10.100/,
  );
});

test("application cache uses the shortest alias or RRset TTL and ignores diagnostic queries", () => {
  const t = servicesLab(),
    [client, , other, server] = t.devices;
  const r = createRuntime(),
    name = "www.certsim.lab";
  server.services.dns.records[1].ttl = 10;
  server.services.dns.records.push({
    name: "certsim.lab",
    type: "A",
    value: "192.168.10.101",
    ttl: 45,
  });
  const first = httpRequest(t, client.id, "http://" + name, r);
  assert.equal(first.status, 200);
  assert.ok(first.events.some((e) => e.protocol === "DNS"));
  assert.deepEqual(r.dnsAnswers[0].addresses, [
    "192.168.10.100",
    "192.168.10.101",
  ]);
  server.services.dns.enabled = false;
  advanceRuntime(r, t, 9);
  assert.equal(httpRequest(t, client.id, "http://" + name, r).status, 200);
  assert.deepEqual(resolveHostname(t, client.id, name, "A", r).events, []);
  assert.equal(resolveHostname(t, other.id, name, "A", r).ok, false);
  assert.equal(dnsLookup(t, client.id, name, undefined, r).ok, false);
  advanceRuntime(r, t, 1);
  assert.equal(httpRequest(t, client.id, "http://" + name, r).ok, false);
  server.services.dns.enabled = true;
  server.services.dns.records[1].ttl = 0;
  assert.equal(resolveHostname(t, client.id, name, "A", r).ttl, 0);
  assert.equal(r.dnsAnswers.length, 0);
});

test("dual-stack hostname ping, typed lookups, cache inspection and flush use the same resolver", () => {
  const t = dualStackLab(),
    [client, , , server] = t.devices,
    r = createRuntime();
  server.services.dns.records.push({
    name: "alias.lab",
    type: "CNAME",
    value: "certsim.lab",
  });
  const run = (input) => command(t, client.id, INITIAL_CLI, input, r).output;
  assert.match(run("nslookup -type=aaaa alias.lab"), /2001:db8:20::100/);
  assert.match(run("ipconfig /displaydns"), /No cached DNS/);
  assert.match(run("ping -6 alias.lab"), /Success/);
  assert.match(run("ping alias.lab"), /Success/);
  assert.match(run("ipconfig /displaydns"), /alias.lab  AAAA/);
  assert.equal(r.dnsAnswers.length, 2);
  assert.match(run("ipconfig /flushdns"), /cleared/);
  assert.equal(r.dnsAnswers.length, 0);
  assert.match(run("nslookup -type=TXT alias.lab"), /Use nslookup/);
  assert.match(run("nslookup -type=A alias.lab 10.2.0.100"), /10.2.0.100/);
});

test("DNS accepts address sets and distinct families and rejects conflicting aliases and invalid TTLs", () => {
  const t = dualStackLab(),
    [client, , , server] = t.devices;
  const records = server.services.dns.records;
  records.push({
    name: "certsim.lab",
    type: "AAAA",
    value: "2001:db8:20::101",
    ttl: 120,
  });
  const answer = dnsLookup(
    t,
    client.id,
    "CERTSIM.LAB.",
    undefined,
    createRuntime(),
    "AAAA",
  );
  assert.deepEqual(answer.addresses, ["2001:db8:20::100", "2001:db8:20::101"]);
  assert.equal(answer.ttl, 120);
  assert.deepEqual(parseTopology(serializeTopology(t)), t);
  records.push({ name: "only4.lab", type: "A", value: "10.2.0.100" });
  assert.match(
    dnsLookup(t, client.id, "only4.lab", undefined, createRuntime(), "AAAA")
      .message,
    /No AAAA/,
  );
  for (const record of [
    { name: "certsim.lab", type: "CNAME", value: "only4.lab" },
    { name: "certsim.lab", type: "AAAA", value: "2001:0db8:20::101" },
    { name: "invalid.lab", type: "AAAA", value: "bad" },
    { name: "invalid.lab", type: "A", value: "10.0.0.1", ttl: -1 },
  ]) {
    records.push(record);
    assert.throws(() => parseTopology(JSON.stringify(t)));
    records.pop();
  }
});

test("wireless clients reach wired services, use their own MACs on the access switch and lose association at the range boundary", () => {
  const t = wirelessLab(),
    [client, ap, sw, server] = t.devices,
    r = createRuntime();
  assert.equal(associatedAccessPoint(t, client).id, ap.id);
  assert.deepEqual(parseTopology(serializeTopology(t)), t);
  const lease = requestDhcp(t, client.id, undefined, r);
  assert.equal(lease.ok, true, lease.message);
  assert.equal(
    httpRequest(lease.topology, client.id, "http://certsim.lab", r).status,
    200,
  );
  assert.ok(
    ping6(lease.topology, client.id, server.ports[0].ipv6, undefined, r).ok,
  );
  assert.ok(
    r.mac.some(
      (e) =>
        e.device === sw.id &&
        e.port === "p0" &&
        e.mac === interfaceMac(client.id, "p0"),
    ),
  );
  for (const edit of [
    (w) => {
      w.devices[0].wireless.key = "different-key";
    },
    (w) => {
      w.devices[0].wireless.security = "open";
      delete w.devices[0].wireless.key;
    },
    (w) => {
      w.devices[0].wireless.ssid = "Other";
    },
    (w) => {
      w.devices[1].ports[1].enabled = false;
    },
    (w) => {
      w.devices[1].powered = false;
    },
    (w) => {
      w.devices[0].x = 1000;
    },
  ]) {
    const next = structuredClone(t);
    edit(next);
    assert.equal(associatedAccessPoint(next, next.devices[0]), undefined);
    assert.equal(requestDhcp(next, client.id, undefined, r).ok, false);
    assert.equal(ping(next, client.id, server.ports[0].ip, r).ok, false);
  }
  ap.wireless.range = 200;
  assert.ok(associatedAccessPoint(t, client));
  ap.wireless.range = 199;
  assert.equal(associatedAccessPoint(t, client), undefined);
});

test("stations bridge on the same radio and roam to a closer matching access point", () => {
  const t = wirelessLab(),
    [a, ap, sw, server] = t.devices;
  const b = createDevice("laptop", 2, 180, 220);
  b.wireless = structuredClone(a.wireless);
  b.ports[0].ip = "192.168.10.22";
  t.devices.push(b);
  assert.deepEqual(ping(t, a.id, b.ports[0].ip).hops, [a.id, ap.id, b.id]);
  ap.ports[0].enabled = false;
  assert.equal(ping(t, a.id, b.ports[0].ip).ok, true);
  assert.equal(ping(t, a.id, server.ports[0].ip).ok, false);
  const second = createDevice("ap", 2, 150, 230);
  second.wireless = { ...ap.wireless, channel: 11, broadcast: false };
  t.devices.push(second);
  const wired = connect(
    t,
    { device: second.id, port: "p0" },
    { device: sw.id, port: "p1" },
    "copper",
  );
  assert.equal(
    nearbyAccessPoints(wired, a).filter((n) => n.ap.wireless.broadcast).length,
    1,
  );
  assert.equal(associatedAccessPoint(wired, a).id, second.id);
  assert.deepEqual(ping(wired, a.id, server.ports[0].ip).hops, [
    a.id,
    second.id,
    sw.id,
    server.id,
  ]);
  second.wireless.key = "incompatible";
  assert.equal(associatedAccessPoint(wired, a).id, ap.id);
});

test("wireless profile and wireless NIC imports reject invalid keys, channels and cable endpoints", () => {
  for (const update of [
    (t) => {
      t.devices[0].wireless.key = "short";
    },
    (t) => {
      t.devices[0].wireless.ssid = "a".repeat(33);
    },
    (t) => {
      t.devices[1].wireless.channel = 15;
    },
    (t) => {
      t.devices[1].ports[1].ip = "10.0.0.4";
    },
    (t) => {
      t.devices[0].ports[0].media = "copper";
    },
    (t) => {
      t.links[0].a = { device: t.devices[0].id, port: "p0" };
    },
    (t) => {
      t.devices[3].wireless = t.devices[1].wireless;
    },
  ]) {
    const t = wirelessLab();
    update(t);
    assert.throws(() => parseTopology(JSON.stringify(t)));
  }
});

test("wireless roaming selects a compatible band and PHY before distance", () => {
  const t = wirelessLab();
  const [client, office] = t.devices;
  const near = createDevice("ap", 2, client.x + 10, client.y);
  near.wireless = { ...office.wireless, band: "5", mode: "ac", channel: 44 };
  t.devices.push(near);
  assert.equal(associatedAccessPoint(t, client).id, near.id);
  Object.assign(client.wireless, { band: "2.4", mode: "n" });
  assert.deepEqual(
    nearbyAccessPoints(t, client).map((row) => row.ap.id),
    [office.id],
  );
  assert.equal(associatedAccessPoint(t, client).id, office.id);
  client.wireless.band = "5";
  assert.equal(associatedAccessPoint(t, client), undefined);
  near.wireless.mode = "mixed";
  assert.equal(associatedAccessPoint(t, client).id, near.id);
  delete client.wireless.band;
  near.wireless.mode = "a";
  assert.equal(associatedAccessPoint(t, client).id, office.id);
  client.wireless.mode = "a";
  assert.equal(associatedAccessPoint(t, client).id, near.id);
  assert.deepEqual(parseTopology(serializeTopology(t)), t);
});

test("import validates PHY and channels against their selected band", () => {
  for (const [index, profile] of [
    [1, { band: "5", channel: 6 }],
    [1, { band: "2.4", channel: 44 }],
    [1, { mode: "ac" }],
    [1, { band: "5", mode: "b", channel: 36 }],
    [0, { band: "6" }],
    [0, { mode: "unknown" }],
    [0, { band: "5", mode: "g" }],
  ]) {
    const t = wirelessLab();
    Object.assign(t.devices[index].wireless, profile);
    assert.throws(() => parseTopology(JSON.stringify(t)));
  }
  const t = wirelessLab();
  Object.assign(t.devices[1].wireless, { band: "5", mode: "ac", channel: 36 });
  assert.deepEqual(parseTopology(serializeTopology(t)), t);
});

test("wireless practice activity runs from actual network state, survives edits and resets to a separate snapshot", () => {
  const t = wirelessRepairLab(),
    runtime = createRuntime();
  const before = structuredClone(runtime);
  assert.deepEqual(
    checkActivity(t, runtime).map((c) => c.ok),
    [false, false],
  );
  assert.deepEqual(runtime, before);
  Object.assign(t.devices[0].wireless, { band: "5", mode: "ac" });
  t.pdus = [];
  assert.deepEqual(
    checkActivity(t, runtime).map((c) => c.ok),
    [true, true],
  );
  assert.deepEqual(runtime, before);
  assert.deepEqual(parseTopology(serializeTopology(t)), t);
  const initial = resetActivity(t);
  assert.deepEqual(
    checkActivity(initial).map((c) => c.ok),
    [false, false],
  );
  initial.devices[0].name = "Edited initial";
  assert.equal(t.activity.initial.devices[0].name, "Laptop-1");
  assert.equal(t.devices[0].name, "Laptop-1");
});

test("activity authoring captures probes across scenarios and missing endpoints cannot satisfy a failure check", () => {
  const t = wirelessRepairLab(),
    p = {
      ...t.pdus[0],
      id: "restricted",
      scenario: "scenario-x",
      schedule: { delay: 10 },
    };
  t.activity = captureActivity(t, "Dual checks", "First line\nSecond line", [
    { probe: p, deliver: false },
  ]);
  assert.equal(t.activity.initial.activity, undefined);
  assert.deepEqual(t.activity.checks[0].probe, {
    ...t.pdus[0],
    id: "restricted",
  });
  assert.ok(checkActivity(t)[0].ok);
  t.devices[3].ports[0].ip = "";
  assert.equal(checkActivity(t)[0].ok, false);
  t.devices.pop();
  assert.equal(checkActivity(t)[0].ok, false);
});

test("activity imports reject recursive, malformed, duplicate or oversized checks and invalid initial links", () => {
  for (const edit of [
    (a) => {
      a.initial.activity = {};
    },
    (a) => {
      a.checks = [];
      a.interfaceChecks = [];
    },
    (a) => {
      a.checks.push(a.checks[0]);
    },
    (a) => {
      a.initial.links[0].a.port = "missing";
    },
    (a) => {
      a.checks[0].probe.target = "missing";
    },
    (a) => {
      a.checks[0].deliver = 1;
    },
    (a) => {
      a.instructions = "a".repeat(4001);
    },
    (a) => {
      a.checks[0].probe.schedule = { delay: 0 };
    },
    (a) => {
      a.title = " ";
    },
    (a) => {
      a.interfaceChecks[0].expected = "6";
    },
    (a) => {
      a.interfaceChecks[0].field = "constructor";
    },
    (a) => {
      a.interfaceChecks[0].device = "absent";
    },
    (a) => {
      a.interfaceChecks.push(a.interfaceChecks[0]);
    },
    (a) => {
      a.interfaceChecks[0].field = "ipv4";
      a.interfaceChecks[0].expected = "10.0.0.1/33";
    },
    (a) => {
      a.checks = Array.from({ length: 17 }, (_, i) => ({
        ...a.checks[0],
        probe: { ...a.checks[0].probe, id: String(i) },
      }));
    },
  ]) {
    const t = wirelessRepairLab();
    edit(t.activity);
    assert.throws(() => parseTopology(JSON.stringify(t)));
  }
});

test("interface-only activities preserve the initial network while capturing a repaired answer", () => {
  const t = wirelessRepairLab(),
    [client, , sw, server] = t.devices;
  Object.assign(client.wireless, { band: "5", mode: "ac" });
  const checks = [
    { device: client.id, port: "p0", field: "band", expected: "5" },
    {
      device: sw.id,
      port: "p0",
      field: "vlan",
      expected: String(sw.ports[0].vlan),
    },
    {
      device: server.id,
      port: "p0",
      field: "ipv4",
      expected: server.ports[0].ip + "/" + server.ports[0].prefix,
    },
    { device: server.id, port: "p0", field: "enabled", expected: "up" },
  ];
  t.activity = captureActivity(
    t,
    "Repair the LAN",
    "Restore the interface settings.",
    [],
    checks,
    true,
  );
  assert.deepEqual(
    checkActivity(t).map((r) => r.ok),
    [true, true, true, true],
  );
  assert.deepEqual(
    checkActivity(resetActivity(t)).map((r) => r.ok),
    [false, true, true, true],
  );
  sw.ports[0].mode = "trunk";
  server.ports[0].enabled = false;
  server.ports[0].prefix = 25;
  assert.deepEqual(
    checkActivity(t).map((r) => r.ok),
    [true, false, false, false],
  );
  assert.deepEqual(parseTopology(serializeTopology(t)).activity, t.activity);
});
