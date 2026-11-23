import assert from "node:assert/strict";
import { test } from "node:test";
import { command } from "../src/network-studio/cli.ts";
import {
  blankTopology,
  connect,
  createDevice,
} from "../src/network-studio/model.ts";
import {
  configurationError,
  ping,
  probeIPv4,
} from "../src/network-studio/engine.ts";
import { ping6 } from "../src/network-studio/ipv6Engine.ts";
import {
  interfaceMac,
  layer2Peers,
  portMac,
  portOperational,
  transmitFrame,
} from "../src/network-studio/ethernet.ts";
import { createRuntime } from "../src/network-studio/networkRuntime.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
import {
  createSubinterface,
  devicePdus,
  createSvi,
  removeVirtualInterface,
} from "../src/network-studio/vlanInterfaces.ts";
import {
  saveStartup,
  reloadDevice,
} from "../src/network-studio/deviceLifecycle.ts";
import { changeModule } from "../src/network-studio/hardware.ts";
import {
  routerOnAStickLab,
  multilayerSwitchLab,
  natLab,
} from "../src/network-studio/labs.ts";
import { httpRequest, requestDhcp } from "../src/network-studio/services.ts";
import { defaultRouting } from "../src/network-studio/extensions.ts";
import {
  routingNeighbors,
  learnedRoutes,
} from "../src/network-studio/routing.ts";
import { spanningTree } from "../src/network-studio/spanningTree.ts";
import { runPdu } from "../src/network-studio/pdus.ts";

function wire(t, a, ap, b, bp) {
  return connect(
    t,
    { device: a.id, port: ap },
    { device: b.id, port: bp },
    "copper",
  );
}
function fixture(svi = false) {
  let t = svi ? multilayerSwitchLab() : routerOnAStickLab();
  const [client, peer, sw, server] = t.devices;
  const gateway = svi ? sw : t.devices[4];
  client.ports[0].addressMode = "static";
  client.ports[0].ip = "192.168.10.10";
  client.gateway = "192.168.10.1";
  for (const p of gateway.ports) delete p.inboundAcl;
  return {
    t,
    client,
    peer,
    sw,
    server,
    gateway,
    logical: gateway.ports.filter((p) => p.virtual),
  };
}

test("router subinterfaces route tagged VLANs over one cable with a shared parent MAC", () => {
  const { t, client, peer, sw, gateway, logical } = fixture();
  const runtime = createRuntime();
  const result = ping(t, client.id, peer.ports[0].ip, runtime);
  assert.equal(result.ok, true, result.message);
  assert.ok(result.hops.includes(gateway.id));
  assert.equal(portMac(gateway, logical[0]), interfaceMac(gateway.id, "p0"));
  assert.equal(portMac(gateway, logical[1]), portMac(gateway, logical[0]));
  assert.ok(
    runtime.mac.some(
      (e) =>
        e.device === sw.id &&
        e.vlan === 10 &&
        e.port === "p7" &&
        e.mac === portMac(gateway, logical[0]),
    ),
  );
  assert.ok(
    runtime.mac.some(
      (e) =>
        e.device === sw.id &&
        e.vlan === 20 &&
        e.port === "p7" &&
        e.mac === portMac(gateway, logical[1]),
    ),
  );
  assert.deepEqual(
    layer2Peers(t, { device: client.id, port: "p0" })
      .filter((p) => p.device.id === gateway.id)
      .map((p) => p.port.id),
    [logical[0].id],
  );
  assert.deepEqual(parseTopology(serializeTopology(t)), t);
});

test("router native subinterface and untagged physical parent deliver only their selected VLAN", () => {
  const { t, client, peer, sw, gateway, logical } = fixture();
  sw.ports[7].nativeVlan = 10;
  logical[0].virtual.native = true;
  assert.equal(ping(t, client.id, peer.ports[0].ip).ok, true);
  delete logical[0].virtual.native;
  assert.equal(
    ping(t, client.id, peer.ports[0].ip).ok,
    false,
    "native mismatch must fail",
  );
  gateway.ports[0].ip = logical[0].ip;
  gateway.ports = gateway.ports.filter((p) => p !== logical[0]);
  assert.equal(
    ping(t, client.id, peer.ports[0].ip).ok,
    true,
    "physical parent owns untagged VLAN",
  );
  assert.equal(configurationError(gateway), null);
});

test("trunk allowed lists, shutdown, missing encapsulation and physical carrier affect virtual routes", () => {
  for (const failure of [
    "allowed",
    "parent",
    "child",
    "encapsulation",
    "link",
  ]) {
    const { t, client, peer, sw, gateway, logical } = fixture();
    if (failure === "allowed") sw.ports[7].allowedVlans = [10, 30];
    if (failure === "parent") gateway.ports[0].enabled = false;
    if (failure === "child") logical[1].enabled = false;
    if (failure === "encapsulation") delete logical[1].virtual.vlan;
    if (failure === "link")
      t.links = t.links.filter(
        (l) => l.a.device !== gateway.id && l.b.device !== gateway.id,
      );
    assert.equal(ping(t, client.id, peer.ports[0].ip).ok, false, failure);
    if (failure !== "allowed")
      assert.equal(
        portOperational(t, gateway.id, logical[1].id),
        false,
        failure,
      );
  }
});

test("overlapping endpoint subnets on different VLANs never share L2 peers or ARP resolution", () => {
  for (const svi of [false, true]) {
    const { t, client, peer, gateway, logical } = fixture(svi);
    peer.ports[0].ip = "192.168.10.20";
    peer.gateway = "";
    logical[1].ip = "";
    const peers = layer2Peers(t, { device: client.id, port: "p0" });
    assert.ok(!peers.some((p) => p.device.id === peer.id));
    assert.ok(
      !peers.some(
        (p) => p.device.id === gateway.id && p.port.id === logical[1].id,
      ),
    );
    assert.equal(ping(t, client.id, peer.ports[0].ip).ok, false);
  }
});

test("SVIs retain L2 bridging and local management when switch IP routing is disabled", () => {
  let { t, client, peer, sw, logical } = fixture(true);
  sw.ipRouting = false;
  const sameVlan = createDevice("pc", 3);
  sameVlan.ports[0].ip = "192.168.10.30";
  sw.ports[3].vlan = 10;
  t.devices.push(sameVlan);
  t = wire(t, sameVlan, "p0", sw, "p3");
  const runtime = createRuntime();
  assert.equal(ping(t, client.id, logical[0].ip, runtime).ok, true);
  assert.equal(ping(t, sw.id, client.ports[0].ip, runtime).ok, true);
  assert.equal(ping(t, client.id, sameVlan.ports[0].ip, runtime).ok, true);
  assert.equal(ping(t, client.id, peer.ports[0].ip, runtime).ok, false);
  assert.ok(
    runtime.mac.some(
      (e) => e.device === sw.id && e.port === "p0" && e.vlan === 10,
    ),
  );
  sw.ipRouting = true;
  assert.equal(ping(t, client.id, peer.ports[0].ip, runtime).ok, true);
  assert.ok(
    runtime.frames.some(
      (e) =>
        e.device === sw.id &&
        e.ingress === logical[1].id &&
        e.action === "forward" &&
        e.egress.includes("p1"),
    ),
  );
});

test("SVI autostate follows forwarding member ports, link power and secure shutdown", () => {
  const { t, client, sw, logical } = fixture(true);
  assert.equal(portOperational(t, sw.id, logical[0].id), true);
  client.powered = false;
  assert.equal(portOperational(t, sw.id, logical[0].id), false);
  client.powered = true;
  sw.ports[0].vlan = 20;
  assert.equal(portOperational(t, sw.id, logical[0].id), false);
  sw.ports[0].vlan = 10;
  sw.ports[0].security = {
    maximum: 1,
    violation: "shutdown",
    addresses: ["020000000001"],
  };
  const runtime = createRuntime();
  assert.equal(ping(t, client.id, logical[0].ip, runtime).ok, false);
  assert.equal(portOperational(t, sw.id, logical[0].id, runtime), false);
  const session = { mode: "privileged", portId: null };
  assert.match(
    command(t, sw.id, session, "show ip interface brief", runtime).output,
    /Vlan10.*down.*down/,
  );
  assert.doesNotMatch(
    command(t, sw.id, session, "show ip route", runtime).output,
    /C 192\.168\.10\.0/,
  );
  assert.ok(runtime.frames.some((e) => e.action === "security-drop"));
  assert.equal(
    runtime.mac.some((e) => e.mac === interfaceMac(client.id, "p0")),
    false,
  );
});

test("SVI originated frames respect static and secure MAC egress ownership", () => {
  for (const secure of [false, true]) {
    const { t, client, sw, logical } = fixture(true);
    sw.ports[3].vlan = 10;
    const mac = interfaceMac(client.id, "p0");
    if (secure)
      sw.ports[3].security = {
        maximum: 1,
        violation: "protect",
        addresses: [mac],
      };
    else sw.staticMac = [{ vlan: 10, mac, port: "p3" }];
    const result = ping(t, sw.id, client.ports[0].ip, createRuntime());
    assert.equal(
      result.ok,
      false,
      "SVI reply must follow the configured MAC egress",
    );
    assert.equal(portOperational(t, sw.id, logical[0].id), true);
  }
});

test("blocked-only VLAN members cannot bring an SVI up", () => {
  const root = createDevice("switch", 1),
    edge = createDevice("switch", 2);
  root.spanningTree = { priorities: [{ vlan: 10, priority: 0 }] };
  edge.spanningTree = { priorities: [{ vlan: 10, priority: 32768 }] };
  for (const d of [root, edge])
    for (const p of d.ports.slice(0, 2))
      Object.assign(p, { mode: "trunk", allowedVlans: [10], nativeVlan: 1 });
  let t = { ...blankTopology(), devices: [root, edge] };
  t = wire(t, root, "p0", edge, "p0");
  t = wire(t, root, "p1", edge, "p1");
  edge.ports.push(createSvi(edge, 10));
  const states = spanningTree(t, 10).filter((p) => p.device === edge.id);
  const blocked = states.find((p) => p.state === "blocking");
  assert.ok(blocked);
  assert.equal(portOperational(t, edge.id, "svi:10"), true);
  for (const p of root.ports.slice(0, 2)) p.nativeVlan = 10;
  assert.equal(
    portOperational(t, edge.id, "svi:10"),
    false,
    "live but VLAN-inconsistent members do not satisfy autostate",
  );
  for (const p of root.ports.slice(0, 2)) p.nativeVlan = 1;
  // A VLAN SVI never participates as a bridge link or an STP candidate.
  assert.ok(states.every((p) => !p.port.startsWith("svi:")));
  const live = states.find(
    (p) => p.state === "forwarding" && p.port !== blocked.port,
  );
  assert.ok(live);
  edge.ports.find((p) => p.id === live.port).enabled = false;
  // The alternate physical path reconverges; the logical interface stays up.
  assert.equal(portOperational(t, edge.id, "svi:10"), true);
  edge.ports.find((p) => p.id === blocked.port).enabled = false;
  assert.equal(portOperational(t, edge.id, "svi:10"), false);
});

test("both VLAN examples relay DHCP across scopes and apply ACLs on the logical ingress", () => {
  for (const build of [routerOnAStickLab, multilayerSwitchLab]) {
    const original = build();
    const [client, peer] = original.devices;
    const runtime = createRuntime();
    const lease = requestDhcp(original, client.id, undefined, runtime);
    assert.equal(lease.ok, true, lease.message);
    assert.equal(lease.topology.devices[0].ports[0].ip, "192.168.10.50");
    const http = httpRequest(
      lease.topology,
      client.id,
      "http://certsim.lab/",
      runtime,
    );
    assert.equal(http.ok, true, http.message);
    const denied = ping(lease.topology, client.id, peer.ports[0].ip, runtime);
    assert.equal(denied.ok, false);
    assert.ok(denied.events.some((e) => e.protocol === "ACL"));
    if (build === multilayerSwitchLab) {
      original.devices[2].ipRouting = false;
      assert.equal(requestDhcp(original, client.id).ok, false);
    }
  }
});

test("IPv6 NDP and routing operate on subinterfaces and SVIs independently of IPv4 forwarding", () => {
  for (const svi of [false, true]) {
    const { t, client, peer, gateway, logical } = fixture(svi);
    gateway.ipv6Routing = true;
    gateway.ipRouting = svi ? false : undefined;
    client.ports[0].ipv6 = "2001:db8:10::10";
    client.gateway6 = "2001:db8:10::1";
    peer.ports[0].ipv6 = "2001:db8:20::20";
    peer.gateway6 = "2001:db8:20::1";
    logical[0].ipv6 = client.gateway6;
    logical[1].ipv6 = peer.gateway6;
    const result = ping6(
      t,
      client.id,
      peer.ports[0].ipv6,
      undefined,
      createRuntime(),
    );
    assert.equal(result.ok, true, result.message);
    assert.ok(result.events.some((e) => e.protocol === "NDP"));
    gateway.ipv6Routing = false;
    assert.equal(ping6(t, client.id, peer.ports[0].ipv6).ok, false);
    assert.equal(
      ping6(t, client.id, logical[0].ipv6).ok,
      true,
      "local SVI management remains available",
    );
  }
});

test("router subinterfaces preserve static NAT and PAT return paths", () => {
  const t = natLab(),
    [client, , inside, sw, router, outside] = t.devices;
  for (const index of [0, 1]) {
    const physical = router.ports[index];
    const virtual = createSubinterface(
      router,
      physical.id,
      index + 50,
      index + 50,
    );
    virtual.ip = physical.ip;
    virtual.natRole = physical.natRole;
    physical.ip = "";
    delete physical.natRole;
    router.ports.push(virtual);
    if (index === 1) router.nat.overload[0].outsidePort = virtual.id;
  }
  for (const p of sw.ports.slice(0, 3)) p.vlan = 50;
  Object.assign(sw.ports[3], { mode: "trunk", allowedVlans: [50] });
  outside.ports[0].taggedVlan = 51;
  assert.equal(configurationError(router), null);
  const runtime = createRuntime();
  const outbound = ping(t, client.id, outside.ports[0].ip, runtime);
  assert.equal(outbound.ok, true, outbound.message);
  assert.equal(runtime.nat[0].globalIp, "203.0.113.1");
  const inbound = probeIPv4(t, outside.id, "203.0.113.100", "tcp", 80, runtime);
  assert.equal(inbound.ok, true, inbound.message);
  assert.equal(inbound.destinationDevice, inside.id);
});

test("RIP/OSPF adjacency and learned routes use router subinterfaces and switch SVIs", () => {
  for (const protocol of ["rip", "ospf"]) {
    const { t, client, sw, gateway, logical } = fixture(true);
    const router = createDevice("router", 2),
      remote = createDevice("pc", 3);
    sw.ports[4].vlan = 40;
    const svi = createSvi(sw, 40);
    svi.ip = "172.16.40.1";
    sw.ports.push(svi);
    const subif = createSubinterface(router, "p0", 40, 40, true);
    subif.ip = "172.16.40.2";
    router.ports.push(subif);
    router.ports[1].ip = "10.99.0.1";
    remote.ports[0].ip = "10.99.0.10";
    remote.gateway = "10.99.0.1";
    for (const d of [gateway, router])
      d.routing = {
        ...defaultRouting(),
        protocol,
        networks: d.ports
          .filter((p) => p.ip)
          .map((p) => ({
            network: p.ip.replace(/\d+$/, "0"),
            prefix: 24,
            area: 0,
          })),
      };
    let linked = { ...t, devices: [...t.devices, router, remote] };
    linked = wire(linked, sw, "p4", router, "p0");
    linked = wire(linked, router, "p1", remote, "p0");
    assert.equal(routingNeighbors(linked, sw.id)[0].localPort, svi.id);
    assert.ok(
      learnedRoutes(linked, sw.id).some((r) => r.network === "10.99.0.0"),
    );
    const result = ping(linked, client.id, remote.ports[0].ip);
    assert.equal(result.ok, true, result.message);
    sw.ipRouting = false;
    assert.equal(learnedRoutes(linked, sw.id).length, 0);
    assert.equal(routingNeighbors(linked, sw.id).length, 0);
  }
});

test("virtual inventories survive JSON/startup and virtual removal cleans dependent references", () => {
  const { t, client, gateway, logical } = fixture();
  gateway.routing = { ...defaultRouting(), passivePorts: [logical[0].id] };
  gateway.routes6 = [
    { network: "::", prefix: 0, nextHop: "fe80::2", interface: logical[0].id },
  ];
  t.pdus = [
    {
      id: "vlan-echo",
      source: client.id,
      target: gateway.id,
      port: logical[0].id,
      protocol: "icmp",
    },
  ];
  const saved = saveStartup(gateway);
  t.devices = t.devices.map((d) => (d.id === gateway.id ? saved : d));
  const removed = removeVirtualInterface(t, gateway.id, logical[0].id);
  const next = removed.devices.find((d) => d.id === gateway.id);
  assert.equal(
    next.ports.some((p) => p.id === logical[0].id),
    false,
  );
  assert.equal(next.routing.passivePorts.length, 0);
  assert.equal(next.routes6.length, 0);
  assert.equal(removed.pdus.length, 0);
  const restored = reloadDevice(
    parseTopology(serializeTopology(removed)).devices.find(
      (d) => d.id === gateway.id,
    ),
  );
  assert.ok(restored.ports.some((p) => p.id === logical[0].id));
  assert.ok(reloadDevice(gateway).ports.every((p) => !p.virtual));
  assert.throws(
    () =>
      connect(
        t,
        { device: gateway.id, port: logical[0].id },
        { device: client.id, port: "p0" },
        "copper",
      ),
    /physical/i,
  );
});

test("module removal removes child interfaces from running and startup inventories", () => {
  const router = createDevice("router", 1);
  router.powered = false;
  let t = changeModule(
    { ...blankTopology(), devices: [router] },
    router.id,
    1,
    "copper",
  );
  let d = t.devices[0];
  const subif = createSubinterface(d, "module-1", 10, 10);
  subif.ip = "10.10.0.1";
  d.ports.push(subif);
  d.routes6 = [
    { network: "::", prefix: 0, nextHop: "fe80::2", interface: subif.id },
  ];
  t.devices[0] = saveStartup(d);
  t = changeModule(t, router.id, 1, null);
  d = t.devices[0];
  for (const config of [d, d.startupConfig]) {
    assert.ok(
      config.ports.every((p) => p.id !== subif.id && p.id !== "module-1"),
    );
    assert.equal(config.routes6.length, 0);
  }
  assert.doesNotThrow(() => parseTopology(serializeTopology(t)));
});

test("malformed virtual metadata and switch physical PDU targets are rejected", () => {
  for (const mutate of [
    (d) =>
      d.ports.push({
        ...d.ports.find((p) => p.virtual),
        id: "duplicate-vlan",
        name: "GigabitEthernet0/0.999",
      }),
    (d) => (d.ports.find((p) => p.virtual).virtual.parent = "missing"),
    (d) => (d.ports.find((p) => p.virtual).virtual.vlan = 4095),
    (d) => {
      d.ports[0].ip = "10.10.0.1";
      d.ports.find((p) => p.virtual).virtual.native = true;
    },
    (d) => (d.ports.find((p) => p.virtual).mode = "trunk"),
  ]) {
    const { t, gateway } = fixture();
    mutate(gateway);
    assert.throws(() => parseTopology(serializeTopology(t)));
  }
  const { t, client, sw, logical } = fixture(true);
  t.pdus = [
    {
      id: "svi",
      source: client.id,
      target: sw.id,
      port: logical[0].id,
      protocol: "icmp",
    },
  ];
  const parsed = parseTopology(serializeTopology(t));
  assert.equal(runPdu(parsed, parsed.pdus[0], createRuntime()).ok, true);
  t.pdus[0].port = "p0";
  assert.throws(() => parseTopology(serializeTopology(t)));
});

test("removal and staged replacement keep only valid implicit and explicit SVI PDU sources", () => {
  const { t, client, sw, logical } = fixture(true);
  t.pdus = [
    {
      id: "auto",
      source: sw.id,
      target: client.id,
      port: "p0",
      protocol: "icmp",
    },
    {
      id: "explicit",
      source: sw.id,
      sourceInterface: logical[0].id,
      target: client.id,
      port: "p0",
      protocol: "icmpv6",
    },
  ];
  let next = t;
  for (const port of logical)
    next = removeVirtualInterface(next, sw.id, port.id);
  assert.deepEqual(next.pdus, []);
  assert.doesNotThrow(() => parseTopology(serializeTopology(next)));
  const final = structuredClone(next.devices.find((d) => d.id === sw.id));
  final.ports.push(createSvi(final, 99));
  assert.deepEqual(
    devicePdus(t, final).map((p) => p.id),
    ["auto"],
  );
  assert.equal(devicePdus({ ...t, pdus: undefined }, final), undefined);
});

test("static IPv4 and IPv6 routes traverse an SVI and a native router subinterface", () => {
  const { t, client, sw, logical } = fixture(true);
  const router = createDevice("router", 2),
    remote = createDevice("pc", 3);
  sw.ports[4].vlan = 40;
  const svi = createSvi(sw, 40);
  Object.assign(svi, { ip: "172.16.40.1", ipv6: "2001:db8:40::1" });
  sw.ports.push(svi);
  const subif = createSubinterface(router, "p0", 40, 40, true);
  Object.assign(subif, { ip: "172.16.40.2", ipv6: "2001:db8:40::2" });
  router.ports.push(subif);
  Object.assign(router.ports[1], { ip: "10.99.0.1", ipv6: "2001:db8:99::1" });
  Object.assign(remote.ports[0], { ip: "10.99.0.10", ipv6: "2001:db8:99::10" });
  remote.gateway = "10.99.0.1";
  remote.gateway6 = "2001:db8:99::1";
  client.ports[0].ipv6 = "2001:db8:10::10";
  client.gateway6 = logical[0].ipv6 = "2001:db8:10::1";
  sw.ipv6Routing = router.ipv6Routing = true;
  sw.routes = [{ network: "10.99.0.0", prefix: 24, nextHop: subif.ip }];
  router.routes = [{ network: "192.168.10.0", prefix: 24, nextHop: svi.ip }];
  sw.routes6 = [{ network: "2001:db8:99::", prefix: 64, nextHop: subif.ipv6 }];
  router.routes6 = [
    { network: "2001:db8:10::", prefix: 64, nextHop: svi.ipv6 },
  ];
  let linked = { ...t, devices: [...t.devices, router, remote] };
  linked = wire(linked, sw, "p4", router, "p0");
  linked = wire(linked, router, "p1", remote, "p0");
  const v4 = ping(linked, client.id, remote.ports[0].ip);
  const v6 = ping6(linked, client.id, remote.ports[0].ipv6);
  assert.equal(v4.ok, true, v4.message);
  assert.equal(v6.ok, true, v6.message);
  router.routes = [];
  router.routes6 = [];
  assert.equal(ping(linked, client.id, remote.ports[0].ip).ok, false);
  assert.equal(ping6(linked, client.id, remote.ports[0].ipv6).ok, false);
});
