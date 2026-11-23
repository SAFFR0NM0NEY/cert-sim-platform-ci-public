import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blankTopology,
  connect,
  createDevice,
} from "../src/network-studio/model.ts";
import { configurationError, ping } from "../src/network-studio/engine.ts";
import { ping6 } from "../src/network-studio/ipv6Engine.ts";
import {
  createRuntime,
  bindRuntime,
} from "../src/network-studio/networkRuntime.ts";
import {
  portOperational,
  interfaceMac,
} from "../src/network-studio/ethernet.ts";
import { spanningTree } from "../src/network-studio/spanningTree.ts";
import {
  createSvi,
  isRoutedInterface,
  isSwitchport,
  packetInterfaces,
} from "../src/network-studio/vlanInterfaces.ts";
import {
  materializeVlans,
  vlanDatabase,
  vlanActive,
  setVlan,
  deleteVlan,
  setVtp,
  setSwitchport,
  ensureAccessVlan,
  ensureSviVlan,
} from "../src/network-studio/vlans.ts";
import { synchronizeVtp } from "../src/network-studio/vtp.ts";
import {
  reloadDevice,
  saveStartup,
  eraseStartup,
} from "../src/network-studio/deviceLifecycle.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
import { advanceWorkspaceClock } from "../src/network-studio/workspaceClock.ts";
import { requestDhcp, httpRequest } from "../src/network-studio/services.ts";
import {
  multilayerSwitchLab,
  secureVlansLab,
} from "../src/network-studio/labs.ts";
import { defaultRouting } from "../src/network-studio/extensions.ts";
import {
  learnedRoutes,
  routingNeighbors,
} from "../src/network-studio/routing.ts";

function wire(t, a, ap, b, bp) {
  return connect(
    t,
    { device: a.id, port: ap },
    { device: b.id, port: bp },
    "copper",
  );
}
function update(t, d) {
  return { ...t, devices: t.devices.map((old) => (old.id === d.id ? d : old)) };
}
function switches(middle = false) {
  let a = materializeVlans(createDevice("switch", 1)),
    b = materializeVlans(createDevice("switch", 2));
  a = setVtp(a, { domain: "Campus" });
  a = setVlan(a, 10, { name: "Users" });
  b = setVtp(b, { mode: "client", domain: "Campus" });
  const left = createDevice("pc", 1),
    right = createDevice("pc", 2);
  left.ports[0].ip = "192.168.10.10";
  right.ports[0].ip = "192.168.10.20";
  for (const d of [a, b]) {
    d.ports[0].vlan = 10;
    Object.assign(d.ports[7], { mode: "trunk", allowedVlans: [10] });
  }
  let t = { ...blankTopology(), devices: [left, a, b, right] };
  t = wire(t, left, "p0", a, "p0");
  t = wire(t, right, "p0", b, "p0");
  let bridge;
  if (middle) {
    bridge = setVtp(materializeVlans(createDevice("switch", 3)), {
      mode: "transparent",
      domain: "Other",
      version: 1,
    });
    for (const p of bridge.ports.slice(0, 2))
      Object.assign(p, { mode: "trunk", allowedVlans: [10] });
    t.devices.push(bridge);
    t = wire(t, a, "p7", bridge, "p0");
    t = wire(t, bridge, "p1", b, "p7");
  } else t = wire(t, a, "p7", b, "p7");
  return { t, a, b, left, right, bridge };
}

test("legacy VLAN membership stays implicit until explicit management and JSON remains compatible", () => {
  const t = multilayerSwitchLab(),
    sw = t.devices[2];
  assert.equal(sw.vlans, undefined);
  assert.equal(vlanActive(sw, 10), true);
  assert.deepEqual(parseTopology(serializeTopology(t)), t);
  const managed = materializeVlans(sw);
  assert.ok(
    [1, 10, 20, 30, 1002, 1003, 1004, 1005].every((id) =>
      managed.vlans.some((v) => v.id === id),
    ),
  );
  assert.equal(sw.vlans, undefined, "materialization is immutable");
  const removed = deleteVlan(managed, 10);
  assert.equal(vlanActive(removed, 10), false);
  assert.equal(
    removed.ports.find((p) => p.virtual?.vlan === 10).virtual.vlan,
    10,
  );
  assert.equal(removed.ports[0].vlan, 10);
});

test("explicit active/suspended/deleted VLAN state controls bridging, DHCP, SVI and MAC learning", () => {
  for (const state of ["suspended", "deleted"]) {
    const t = multilayerSwitchLab(),
      client = t.devices[0],
      sw = t.devices[2];
    t.devices[2] =
      state === "deleted"
        ? deleteVlan(materializeVlans(sw), 10)
        : setVlan(sw, 10, { state: "suspended" });
    const runtime = createRuntime();
    assert.equal(portOperational(t, sw.id, "svi:10", runtime), false);
    assert.equal(portOperational(t, sw.id, "p0", runtime), false);
    assert.equal(requestDhcp(t, client.id, undefined, runtime).ok, false);
    assert.ok(
      spanningTree(t, 10)
        .filter((p) => p.device === sw.id)
        .every((p) => p.state === "disabled"),
    );
    assert.equal(
      runtime.mac.some((e) => e.device === sw.id && e.vlan === 10),
      false,
    );
    t.devices[2] = setVlan(t.devices[2], 10, { state: "active" });
    const leased = requestDhcp(t, client.id, undefined, runtime);
    assert.equal(leased.ok, true, leased.message);
    assert.equal(
      httpRequest(leased.topology, client.id, "http://certsim.lab/", runtime)
        .ok,
      true,
    );
  }
});

test("normal and voice VLAN suspension respects tagged security boundaries", () => {
  const t = secureVlansLab(),
    [voice, data, sw, , server] = t.devices;
  const normal = ping(t, voice.id, server.ports[0].ip, createRuntime());
  assert.equal(normal.ok, true, normal.message);
  t.devices[2] = setVlan(sw, 20, { state: "suspended" });
  const runtime = createRuntime();
  assert.equal(ping(t, voice.id, server.ports[0].ip, runtime).ok, false);
  assert.equal(
    runtime.mac.some((e) => e.vlan === 20),
    false,
  );
  assert.ok(vlanActive(t.devices[2], 10));
  assert.equal(data.ports[0].ip, "192.168.10.10");
});

test("VTP higher revisions synchronize and delete VLANs without changing port assignments", () => {
  const { t, a, b, left, right } = switches();
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, false);
  const next = synchronizeVtp(t);
  assert.equal(
    t.devices.find((d) => d.id === b.id).vlans.some((v) => v.id === 10),
    false,
  );
  const client = next.devices.find((d) => d.id === b.id);
  assert.equal(client.vtp.revision, a.vtp.revision);
  assert.equal(client.vlans.find((v) => v.id === 10).name, "Users");
  assert.equal(ping(next, left.id, right.ports[0].ip).ok, true);
  const deleted = synchronizeVtp(update(next, deleteVlan(a, 10)));
  assert.equal(
    vlanActive(
      deleted.devices.find((d) => d.id === b.id),
      10,
    ),
    false,
  );
  assert.equal(deleted.devices.find((d) => d.id === b.id).ports[0].vlan, 10);
  assert.equal(ping(deleted, left.id, right.ports[0].ip).ok, false);
  assert.equal(
    synchronizeVtp(deleted),
    deleted,
    "stable convergence returns the same topology",
  );
});

test("a higher-revision client can replace a server database; equal/lower data does not overwrite", () => {
  const { t, a, b } = switches();
  b.vtp.revision = 20;
  b.vlans.push({ id: 20, name: "Client-restored", state: "active" });
  const next = synchronizeVtp(t),
    server = next.devices.find((d) => d.id === a.id);
  assert.equal(server.vtp.revision, 20);
  assert.equal(vlanActive(server, 10), false);
  assert.ok(server.vlans.some((v) => v.id === 20));
  for (const revision of [19, 20]) {
    const local = structuredClone(server);
    local.vlans.push({ id: 40, name: "Local", state: "active" });
    const peer = structuredClone(next.devices.find((d) => d.id === b.id));
    peer.vtp.revision = revision;
    const retained = synchronizeVtp({
      ...next,
      devices: next.devices.map((d) =>
        d.id === a.id ? local : d.id === b.id ? peer : d,
      ),
    });
    assert.ok(
      retained.devices
        .find((d) => d.id === a.id)
        .vlans.some((v) => v.id === 40),
    );
  }
});

test("VTP domain and password mismatches isolate; blank domain and matching digest learn version", () => {
  for (const mismatch of ["domain", "password"]) {
    const { t, b } = switches();
    if (mismatch === "domain") b.vtp.domain = "campus";
    else b.vtp.password = "different";
    assert.equal(
      vlanActive(
        synchronizeVtp(t).devices.find((d) => d.id === b.id),
        10,
      ),
      false,
    );
  }
  const { t, a, b } = switches();
  a.vtp.version = 2;
  b.vtp.domain = "";
  let next = synchronizeVtp(t),
    client = next.devices.find((d) => d.id === b.id);
  assert.equal(client.vtp.domain, "Campus");
  assert.equal(client.vtp.version, 2);
  assert.ok(vlanActive(client, 10));
  b.vtp.domain = "Campus";
  next = synchronizeVtp(t);
  assert.equal(
    next.devices.find((d) => d.id === b.id).vtp.version,
    2,
    "PT adopts advertised version across 1/2",
  );
});

test("transparent VTP relays across other domains and versions without adopting or carrying absent data VLANs", () => {
  const { t, a, b, bridge, left, right } = switches(true);
  a.vtp.version = 2;
  let next = synchronizeVtp(t),
    transparent = next.devices.find((d) => d.id === bridge.id);
  assert.equal(
    vlanActive(
      next.devices.find((d) => d.id === b.id),
      10,
    ),
    true,
  );
  assert.equal(transparent.vtp.domain, "Other");
  assert.equal(transparent.vtp.version, 1);
  assert.equal(transparent.vtp.revision, 0);
  assert.equal(vlanActive(transparent, 10), false);
  assert.equal(ping(next, left.id, right.ports[0].ip).ok, false);
  next = update(next, setVlan(transparent, 10, { name: "Local-only" }));
  const result = ping(next, left.id, right.ports[0].ip);
  assert.equal(result.ok, true, result.message);
  assert.equal(
    next.devices.find((d) => d.id === b.id).vlans.find((v) => v.id === 10).name,
    "Users",
  );
});

test("VTP control ignores VLAN allow lists but needs a live Layer 2 trunk and secure carrier", () => {
  for (const failure of ["access", "shutdown", "power", "routed", "security"]) {
    let { t, a, b } = switches();
    const runtime = createRuntime();
    if (failure === "access") b.ports[7].mode = "access";
    if (failure === "shutdown") b.ports[7].enabled = false;
    if (failure === "power") b.powered = false;
    if (failure === "routed") t = update(t, setSwitchport(b, "p7", false));
    if (failure === "security")
      runtime.security.push({
        device: b.id,
        port: "p7",
        shutdown: true,
        addresses: [],
        violations: 1,
      });
    assert.equal(
      vlanActive(
        synchronizeVtp(t, runtime).devices.find((d) => d.id === b.id),
        10,
      ),
      false,
      failure,
    );
  }
  const { t, a, b } = switches();
  a.ports[7].allowedVlans = b.ports[7].allowedVlans = [20];
  const next = synchronizeVtp(t);
  assert.equal(
    vlanActive(
      next.devices.find((d) => d.id === b.id),
      10,
    ),
    true,
  );
});

test("client access assignment stays inactive; new SVI creates its VLAN without raising revision", () => {
  let d = setVtp(materializeVlans(createDevice("switch", 1)), {
    mode: "client",
    domain: "Campus",
  });
  d = ensureAccessVlan(d, 10);
  d.ports[0].vlan = 10;
  assert.equal(vlanActive(d, 10), false);
  assert.throws(() => setVlan(d, 10), /clients/i);
  d = ensureSviVlan(d, 10);
  d.ports.push(createSvi(d, 10));
  assert.equal(vlanActive(d, 10), true);
  assert.equal(d.vtp.revision, 0);
  d = setVtp(d, { mode: "server" });
  d = deleteVlan(d, 10);
  assert.equal(
    d.ports.some((p) => p.virtual?.vlan === 10),
    true,
  );
  assert.equal(vlanActive(d, 10), false);
});

test("reserved VLANs and extended range permissions fail closed without modifying input", () => {
  const d = materializeVlans(createDevice("switch", 1)),
    original = structuredClone(d);
  for (const id of [1, 1002, 1003, 1004, 1005]) {
    assert.throws(() => deleteVlan(d, id), /Default VLAN/);
    assert.throws(() => setVlan(d, id, { name: "Changed" }), /Default VLAN/);
  }
  assert.throws(() => setVlan(d, 2000), /transparent/);
  const extended = setVlan(setVtp(d, { mode: "transparent" }), 4094, {
    name: "Extended",
  });
  assert.equal(vlanActive(extended, 4094), true);
  assert.equal(extended.vtp.revision, 0);
  assert.throws(() => setVtp(extended, { mode: "server" }), /extended VLAN/);
  assert.deepEqual(d, original);
});

test("server/client VLAN database persists apart from startup; transparent uses saved configuration", () => {
  for (const mode of ["server", "client"]) {
    let d = setVtp(materializeVlans(createDevice("switch", 1)), {
      domain: "Campus",
    });
    d = ensureSviVlan(d, 10);
    d.ports.push(createSvi(d, 10));
    d = saveStartup(d);
    d = setVlan(d, 20, { name: "Not-in-startup" });
    d = deleteVlan(d, 10);
    d = setVtp(d, { mode });
    const reloaded = reloadDevice(d);
    assert.equal(vlanActive(reloaded, 20), true);
    assert.equal(
      vlanActive(reloaded, 10),
      true,
      "startup SVI replay recreates deleted row",
    );
    assert.equal(reloaded.vtp.mode, mode);
    assert.equal(reloaded.vtp.domain, "Campus");
    assert.equal(vlanActive(reloadDevice(eraseStartup(d)), 20), true);
  }
  let transparent = setVtp(materializeVlans(createDevice("switch", 2)), {
    mode: "transparent",
    domain: "Local",
  });
  transparent = saveStartup(setVlan(transparent, 10));
  transparent = setVlan(transparent, 20);
  assert.equal(vlanActive(reloadDevice(transparent), 10), true);
  assert.equal(vlanActive(reloadDevice(transparent), 20), false);
});

test("VTP clock convergence is persistent but parsing and connectivity probes never mutate VLAN state", () => {
  const { t, b, left, right } = switches();
  const before = structuredClone(t);
  const parsed = parseTopology(serializeTopology(t));
  assert.equal(
    vlanActive(
      parsed.devices.find((d) => d.id === b.id),
      10,
    ),
    false,
  );
  ping(t, left.id, right.ports[0].ip);
  assert.deepEqual(t, before);
  const next = advanceWorkspaceClock(createRuntime(), t, 0);
  assert.ok(
    vlanActive(
      next.devices.find((d) => d.id === b.id),
      10,
    ),
  );
  assert.deepEqual(parseTopology(serializeTopology(next)), next);
});

test("routed switchports provide dual-stack forwarding, local management, and no L2 bridging", () => {
  const left = createDevice("pc", 1),
    right = createDevice("pc", 2),
    l2 = createDevice("pc", 3);
  let sw = createDevice("switch", 1);
  sw = setSwitchport(setSwitchport(sw, "p0", false), "p1", false);
  Object.assign(left.ports[0], { ip: "10.10.0.10", ipv6: "2001:db8:10::10" });
  Object.assign(right.ports[0], { ip: "10.20.0.20", ipv6: "2001:db8:20::20" });
  Object.assign(sw.ports[0], { ip: "10.10.0.1", ipv6: "2001:db8:10::1" });
  Object.assign(sw.ports[1], { ip: "10.20.0.1", ipv6: "2001:db8:20::1" });
  left.gateway = "10.10.0.1";
  right.gateway = "10.20.0.1";
  left.gateway6 = "2001:db8:10::1";
  right.gateway6 = "2001:db8:20::1";
  l2.ports[0].ip = "10.10.0.30";
  sw.ipRouting = sw.ipv6Routing = true;
  let t = { ...blankTopology(), devices: [left, sw, right, l2] };
  t = wire(t, left, "p0", sw, "p0");
  t = wire(t, right, "p0", sw, "p1");
  t = wire(t, l2, "p0", sw, "p2");
  const runtime = createRuntime();
  assert.equal(configurationError(sw), null);
  assert.equal(isRoutedInterface(sw, sw.ports[0]), true);
  assert.equal(isSwitchport(sw, sw.ports[0]), false);
  assert.equal(packetInterfaces(sw).length, 2);
  assert.equal(ping(t, left.id, right.ports[0].ip, runtime).ok, true);
  assert.equal(
    ping6(t, left.id, right.ports[0].ipv6, undefined, runtime).ok,
    true,
  );
  assert.equal(ping(t, left.id, l2.ports[0].ip, runtime).ok, false);
  assert.equal(
    runtime.mac.some(
      (e) => e.device === sw.id && ["p0", "p1"].includes(e.port),
    ),
    false,
  );
  assert.ok(spanningTree(t, 1).every((p) => !["p0", "p1"].includes(p.port)));
  sw.ipRouting = sw.ipv6Routing = false;
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, false);
  assert.equal(ping6(t, left.id, right.ports[0].ipv6).ok, false);
  assert.equal(ping(t, left.id, sw.ports[0].ip).ok, true);
  sw.ports[0].natRole = "inside";
  assert.match(configurationError(sw), /NAT roles/);
});

test("physical routed conversion cleans incompatible settings and survives startup and JSON", () => {
  let sw = createDevice("switch", 1);
  sw.ports[0].vlan = 10;
  sw.ports[0].voiceVlan = 20;
  sw.ports[0].security = {
    maximum: 1,
    violation: "protect",
    addresses: ["020000000001"],
  };
  sw.ports[0].spanningTreeCost = 10;
  sw.staticMac = [{ vlan: 10, port: "p0", mac: "020000000002" }];
  const initial = structuredClone(sw);
  sw = setSwitchport(sw, "p0", false);
  assert.equal(configurationError(sw), null);
  assert.equal(sw.staticMac.length, 0);
  assert.equal(sw.ports[0].security, undefined);
  assert.equal(initial.ports[0].security.maximum, 1);
  Object.assign(sw.ports[0], {
    ip: "10.0.0.1",
    ipv6: "2001:db8::1",
    helperAddresses: ["10.0.0.5"],
  });
  sw.routing = { ...defaultRouting(), passivePorts: ["p0"] };
  sw.routes6 = [
    { network: "::", prefix: 0, nextHop: "fe80::2", interface: "p0" },
  ];
  const saved = saveStartup(sw),
    switched = setSwitchport(saved, "p0", true);
  assert.equal(switched.ports[0].ip, "");
  assert.equal(switched.ports[0].ipv6, undefined);
  assert.equal(switched.ports[0].helperAddresses, undefined);
  assert.deepEqual(switched.routing.passivePorts, []);
  assert.deepEqual(switched.routes6, []);
  const restored = reloadDevice(switched);
  assert.equal(restored.ports[0].routed, true);
  const topology = { ...blankTopology(), devices: [restored] };
  assert.deepEqual(parseTopology(serializeTopology(topology)), topology);
});

test("routed switchport DHCP relay, inbound ACLs and RIP/OSPF adjacency use the physical interface", () => {
  for (const protocol of ["rip", "ospf"]) {
    let t = multilayerSwitchLab();
    let sw = setSwitchport(t.devices[2], "p0", false);
    Object.assign(sw.ports[0], {
      ip: "192.168.10.1",
      helperAddresses: ["192.168.30.100"],
      inboundAcl: "VLAN10-IN",
    });
    sw.ports = sw.ports.filter((p) => p.id !== "svi:10");
    t = update(t, sw);
    const lease = requestDhcp(t, t.devices[0].id);
    assert.equal(lease.ok, true, lease.message);
    assert.equal(
      httpRequest(lease.topology, t.devices[0].id, "http://certsim.lab/").ok,
      true,
    );
    assert.equal(
      ping(lease.topology, t.devices[0].id, t.devices[1].ports[0].ip).ok,
      false,
    );
    const router = createDevice("router", 2),
      remote = createDevice("pc", 3);
    sw = setSwitchport(sw, "p4", false);
    sw.ports[4].ip = "172.16.40.1";
    router.ports[0].ip = "172.16.40.2";
    router.ports[1].ip = "10.99.0.1";
    remote.ports[0].ip = "10.99.0.10";
    remote.gateway = "10.99.0.1";
    for (const d of [sw, router])
      d.routing = {
        ...defaultRouting(),
        protocol,
        networks: [{ network: "0.0.0.0", prefix: 0, area: 0 }],
      };
    t = update(lease.topology, sw);
    t.devices.push(router, remote);
    t = wire(t, sw, "p4", router, "p0");
    t = wire(t, router, "p1", remote, "p0");
    assert.equal(routingNeighbors(t, sw.id)[0].localPort, "p4");
    assert.ok(learnedRoutes(t, sw.id).some((r) => r.network === "10.99.0.0"));
    const result = ping(t, t.devices[0].id, remote.ports[0].ip);
    assert.equal(result.ok, true, result.message);
    sw.ports[4].enabled = false;
    assert.equal(routingNeighbors(t, sw.id).length, 0);
  }
});

test("malformed VLAN, VTP and routed port files are rejected while valid explicit databases round-trip", () => {
  const { t } = switches();
  assert.deepEqual(parseTopology(serializeTopology(t)), t);
  for (const mutate of [
    (d) => d.vlans.push({ ...d.vlans[0] }),
    (d) => (d.vlans[0].state = "invalid"),
    (d) => (d.vlans[0].name = "renamed-default"),
    (d) => d.vlans.push({ id: 4095, name: "Invalid", state: "active" }),
    (d) => (d.vtp.mode = "off"),
    (d) => (d.vtp.version = 3),
    (d) => (d.vtp.revision = -1),
    (d) => {
      d.ports[0].routed = true;
    },
  ]) {
    const copy = structuredClone(t);
    mutate(copy.devices[1]);
    assert.throws(() => parseTopology(serializeTopology(copy)));
  }
});

test("a remote server VLAN or return gateway failure prevents relayed DHCP allocation", () => {
  for (const failure of ["server-vlan", "return-gateway", "ip-routing"]) {
    let t = multilayerSwitchLab();
    if (failure === "server-vlan")
      t.devices[2] = deleteVlan(materializeVlans(t.devices[2]), 30);
    if (failure === "return-gateway") t.devices[3].gateway = "";
    if (failure === "ip-routing") t.devices[2].ipRouting = false;
    const result = requestDhcp(t, t.devices[0].id);
    assert.equal(result.ok, false, failure);
    assert.equal(result.topology.devices[3].services.dhcp.leases.length, 0);
    assert.equal(result.topology.devices[0].ports[0].ip, "");
  }
});

test("VTP converges through redundant trunks without changing STP data forwarding", () => {
  const { t, a, b, left, right } = switches();
  let third = setVtp(materializeVlans(createDevice("switch", 3)), {
    mode: "client",
    domain: "Campus",
  });
  for (const p of [a.ports[6], b.ports[6], third.ports[6], third.ports[7]])
    Object.assign(p, { mode: "trunk", allowedVlans: [10] });
  t.devices.push(third);
  let linked = wire(t, a, "p6", third, "p6");
  linked = wire(linked, b, "p6", third, "p7");
  const next = synchronizeVtp(linked);
  assert.ok(
    next.devices
      .filter((d) => d.kind === "switch")
      .every((d) => vlanActive(d, 10)),
  );
  assert.equal(
    spanningTree(next, 10).filter((p) => p.state === "blocking").length,
    1,
  );
  const result = ping(next, left.id, right.ports[0].ip);
  assert.equal(result.ok, true, result.message);
});

test("VTP clock adoption preserves packet schedules and secure shutdown state", () => {
  const { t, a, b, left, right } = switches();
  t.pdus = [
    {
      id: "periodic",
      source: left.id,
      target: right.id,
      port: "p0",
      protocol: "icmp",
      schedule: { delay: 30, interval: 30 },
    },
  ];
  const runtime = createRuntime();
  bindRuntime(runtime, t);
  runtime.time = 10;
  runtime.pduTimers.get("periodic").sent = 7;
  runtime.security.push({
    device: a.id,
    port: "p2",
    shutdown: true,
    addresses: [],
    violations: 1,
  });
  const next = advanceWorkspaceClock(runtime, t, 10);
  assert.equal(
    vlanActive(
      next.devices.find((d) => d.id === b.id),
      10,
    ),
    true,
  );
  assert.equal(runtime.time, 20);
  assert.equal(runtime.pduTimers.get("periodic").sent, 7);
  assert.equal(runtime.pduTimers.get("periodic").next, 30);
  assert.equal(runtime.security[0].shutdown, true);
  const fresh = createRuntime();
  advanceWorkspaceClock(fresh, { ...t, dhcpTime: 1000 }, 0);
  assert.equal(
    fresh.time,
    1000,
    "initial VTP adoption preserves the saved protocol clock",
  );
});

test("VTP resumes at the same clock boundary where a secure trunk recovers", () => {
  const { t, b } = switches();
  b.securityRecovery = { enabled: true, interval: 30 };
  b.ports[7].security = { maximum: 1, violation: "shutdown", addresses: [] };
  const runtime = createRuntime();
  bindRuntime(runtime, t);
  runtime.security.push({
    device: b.id,
    port: "p7",
    shutdown: true,
    shutdownAt: 0,
    addresses: [],
    violations: 1,
  });
  let next = advanceWorkspaceClock(runtime, t, 29);
  assert.equal(
    vlanActive(
      next.devices.find((d) => d.id === b.id),
      10,
    ),
    false,
  );
  next = advanceWorkspaceClock(runtime, next, 1);
  assert.equal(runtime.time, 30);
  assert.equal(
    vlanActive(
      next.devices.find((d) => d.id === b.id),
      10,
    ),
    true,
  );
});

test("an active voice VLAN keeps its SVI operational when the data VLAN is absent", () => {
  let sw = setVlan(materializeVlans(createDevice("switch", 1)), 20);
  Object.assign(sw.ports[0], { vlan: 10, voiceVlan: 20 });
  const svi = createSvi(sw, 20);
  svi.ip = "192.168.20.1";
  sw.ports.push(svi);
  const phone = createDevice("pc", 1);
  Object.assign(phone.ports[0], { taggedVlan: 20, ip: "192.168.20.10" });
  let t = wire(
    { ...blankTopology(), devices: [sw, phone] },
    sw,
    "p0",
    phone,
    "p0",
  );
  assert.equal(vlanActive(sw, 10), false);
  assert.equal(portOperational(t, sw.id, "p0"), true);
  assert.equal(portOperational(t, sw.id, svi.id), true);
  const result = ping(t, phone.id, svi.ip);
  assert.equal(result.ok, true, result.message);
  t = update(t, deleteVlan(sw, 20));
  assert.equal(portOperational(t, sw.id, "p0"), false);
  assert.equal(portOperational(t, sw.id, svi.id), false);
  assert.equal(ping(t, phone.id, svi.ip).ok, false);
});
