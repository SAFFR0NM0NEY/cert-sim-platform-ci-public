import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blankTopology,
  createDevice,
  connect,
} from "../src/network-studio/model.ts";
import { defaultRouting } from "../src/network-studio/extensions.ts";
import {
  EIGRP_INFINITY,
  eigrpMetric,
  eigrpTopology,
  interfaceMetric,
  learnedRoutes,
  routingNeighbors,
} from "../src/network-studio/routing.ts";
import { ping, configurationError } from "../src/network-studio/engine.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
import {
  saveStartup,
  reloadDevice,
} from "../src/network-studio/deviceLifecycle.ts";
import {
  createSubinterface,
  createSvi,
} from "../src/network-studio/vlanInterfaces.ts";
import {
  setChannelGroup,
  reconcilePortChannels,
} from "../src/network-studio/etherChannel.ts";
import { setSwitchport, setVlan } from "../src/network-studio/vlans.ts";
import { eigrpRepairLab } from "../src/network-studio/labs.ts";

function fixture(edges, destination = "D") {
  const ids = [...new Set(edges.flat())];
  const routers = new Map(
    ids.map((id, i) => {
      const d = createDevice("router", i + 1);
      d.id = d.name = id;
      for (const p of d.ports) p.media = "copper";
      d.routing = {
        ...defaultRouting(),
        protocol: "eigrp",
        processId: 10,
        networks: [{ network: "0.0.0.0", prefix: 0, area: 0 }],
      };
      return [id, d];
    }),
  );
  let t = { ...blankTopology(), devices: [...routers.values()] };
  const used = new Map(ids.map((id) => [id, 0]));
  const ports = new Map();
  for (const [i, [from, to]] of edges.entries()) {
    const a = routers.get(from),
      b = routers.get(to);
    const ap = a.ports[used.get(from)],
      bp = b.ports[used.get(to)];
    used.set(from, used.get(from) + 1);
    used.set(to, used.get(to) + 1);
    Object.assign(ap, { ip: `10.0.${i + 1}.1`, prefix: 30 });
    Object.assign(bp, { ip: `10.0.${i + 1}.2`, prefix: 30 });
    t = connect(
      t,
      { device: a.id, port: ap.id },
      { device: b.id, port: bp.id },
      "copper",
    );
    ports.set(from + to, ap);
    ports.set(to + from, bp);
  }
  const d = routers.get(destination),
    lan = d.ports[used.get(destination)];
  const pc = createDevice("pc", 1);
  pc.id = "host";
  pc.ports[0].ip = "192.168.7.10";
  pc.gateway = "192.168.7.1";
  Object.assign(lan, { ip: pc.gateway, prefix: 24 });
  t.devices.push(pc);
  t = connect(
    t,
    { device: d.id, port: lan.id },
    { device: pc.id, port: "p0" },
    "copper",
  );
  return { t, routers, ports, lan, pc };
}
const route = (t, id) =>
  eigrpTopology(t, id).find((r) => r.network === "192.168.7.0");
const metric = (p, bandwidth, delay) => Object.assign(p, { bandwidth, delay });

test("classic EIGRP learns internal routes, uses AS matching and withdraws immediately", () => {
  const { t, routers, ports, pc } = fixture([["A", "D"]]);
  assert.equal(routingNeighbors(t, "A").length, 1);
  assert.deepEqual(route(t, "A"), {
    network: "192.168.7.0",
    prefix: 24,
    nextHop: ports.get("DA").ip,
    localPort: ports.get("AD").id,
    learnedFrom: "D",
    protocol: "eigrp",
    distance: 90,
    metric: 3072,
    bandwidth: 1000000,
    delay: 2,
  });
  assert.equal(ping(t, "A", pc.ports[0].ip).ok, true);
  routers.get("D").routing.processId = 99;
  assert.deepEqual(routingNeighbors(t, "A"), []);
  assert.equal(route(t, "A"), undefined);
  assert.equal(ping(t, "A", pc.ports[0].ip).ok, false);
  routers.get("D").routing.processId = 10;
  ports.get("DA").enabled = false;
  assert.equal(route(t, "A"), undefined);
  ports.get("DA").enabled = true;
  routers.get("D").powered = false;
  assert.equal(route(t, "A"), undefined);
});

test("passive LANs are advertised but passive transit and unmatched networks form no adjacency", () => {
  const { t, routers, ports, lan } = fixture([["A", "D"]]);
  routers.get("D").routing.passivePorts = [lan.id];
  assert.ok(route(t, "A"));
  routers.get("D").routing.passivePorts.push(ports.get("DA").id);
  assert.deepEqual(routingNeighbors(t, "A"), []);
  routers.get("D").routing.passivePorts = [];
  routers.get("D").routing.networks = [
    { network: "192.168.7.0", prefix: 24, area: 0 },
  ];
  assert.equal(route(t, "A"), undefined);
  routers.get("D").routing.networks = [
    { network: "10.0.1.0", prefix: 30, area: 0 },
  ];
  assert.equal(routingNeighbors(t, "A").length, 1);
  assert.equal(route(t, "A"), undefined);
});

test("a downstream bandwidth bottleneck reverses path preference without scalar-path pruning", () => {
  const { t, ports } = fixture([
    ["A", "B"],
    ["B", "M"],
    ["A", "C"],
    ["C", "M"],
    ["M", "D"],
  ]);
  metric(ports.get("AB"), 100000, 100);
  metric(ports.get("BM"), 100000, 100);
  metric(ports.get("AC"), 10000, 1);
  metric(ports.get("CM"), 10000, 1);
  assert.equal(route(t, "A").nextHop, ports.get("BA").ip);
  assert.equal(route(t, "A").metric, 256 * 302);
  metric(ports.get("MD"), 1000, 1);
  assert.equal(route(t, "A").nextHop, ports.get("CA").ip);
  assert.equal(route(t, "A").metric, 256 * 10004);
  ports.get("CM").enabled = false;
  assert.equal(route(t, "A").nextHop, ports.get("BA").ip);
  assert.equal(route(t, "A").metric, 256 * 10202);
});

test("metric vectors follow the next hop's actual chosen path, not an unusable global alternative", () => {
  const { t, ports } = fixture([
    ["S", "A"],
    ["A", "B"],
    ["B", "D"],
    ["A", "C"],
    ["C", "D"],
  ]);
  metric(ports.get("SA"), 1000, 1);
  metric(ports.get("AB"), 100000, 100);
  metric(ports.get("BD"), 100000, 100);
  metric(ports.get("AC"), 10000, 1);
  metric(ports.get("CD"), 10000, 1);
  const downstream = route(t, "A"),
    upstream = route(t, "S");
  assert.equal(downstream.nextHop, ports.get("BA").ip);
  assert.equal(downstream.delay, 201);
  assert.equal(upstream.delay, downstream.delay + 1);
  assert.equal(upstream.bandwidth, 1000);
  assert.equal(upstream.metric, 256 * 10202);
});

test("equal metrics are deterministic, remain loop free and exclude connected destinations", () => {
  const { t, ports } = fixture([
    ["A", "B"],
    ["B", "D"],
    ["A", "C"],
    ["C", "D"],
  ]);
  // Defensive handling of zero-delay vectors, although configuration requires delay >= 1.
  for (const d of t.devices) for (const p of d.ports) p.delay = 0;
  const first = route(t, "A");
  const reversed = {
    ...t,
    devices: [...t.devices].reverse(),
    links: [...t.links].reverse(),
  };
  assert.deepEqual(route(reversed, "A"), first);
  assert.equal(first.nextHop, ports.get("BA").ip);
  assert.equal(route(t, "D"), undefined);
  for (const start of ["A", "B", "C"]) {
    const visited = new Set();
    let id = start;
    while (id !== "D") {
      assert.equal(
        visited.has(id),
        false,
        "selected next hops must never form a loop",
      );
      visited.add(id);
      const selected = route(t, id);
      const neighbor = routingNeighbors(t, id).find(
        (n) =>
          n.localPort === selected.localPort && n.nextHop === selected.nextHop,
      );
      assert.ok(neighbor);
      id = neighbor.router;
    }
  }
});

test("32-bit metric infinity saturates and withdraws unusable advertisements", () => {
  const { t, ports, lan } = fixture([["A", "D"]]);
  assert.equal(eigrpMetric({ bandwidth: 1, delay: 16777215 }), EIGRP_INFINITY);
  assert.equal(eigrpMetric({ bandwidth: 0, delay: 1 }), EIGRP_INFINITY);
  metric(lan, 1000000, 16777215);
  assert.equal(route(t, "A"), undefined);
  metric(lan, 1000000, 16777200);
  assert.ok(route(t, "A"));
  metric(ports.get("AD"), 1000000, 10);
  assert.equal(route(t, "A"), undefined);
});

test("learned routes retain the actual egress when connected subnets overlap; static routes win", () => {
  const { t, ports, routers, pc } = fixture([
    ["A", "D"],
    ["A", "B"],
  ]);
  Object.assign(ports.get("AD"), { ip: "10.0.0.10", prefix: 24 });
  Object.assign(ports.get("DA"), { ip: "10.0.0.2", prefix: 24 });
  Object.assign(ports.get("AB"), { ip: "10.0.0.1", prefix: 29 });
  Object.assign(ports.get("BA"), { ip: "10.0.0.3", prefix: 29 });
  assert.equal(route(t, "A").localPort, ports.get("AD").id);
  assert.equal(ping(t, "A", pc.ports[0].ip).ok, true);
  routers
    .get("A")
    .routes.push({ network: "192.168.7.0", prefix: 24, nextHop: "10.0.0.6" });
  assert.equal(
    ping(t, "A", pc.ports[0].ip).ok,
    false,
    "the lower-distance static route takes precedence",
  );
});

test("interface defaults and subinterface overrides stay separate from link clock and OSPF cost", () => {
  const { t, routers, ports } = fixture([["A", "D"]]);
  const d = routers.get("A"),
    p = ports.get("AD");
  assert.deepEqual(interfaceMetric(t, d, p), { bandwidth: 1000000, delay: 1 });
  assert.deepEqual(interfaceMetric(t, d, { ...p, name: "FastEthernet0/0" }), {
    bandwidth: 100000,
    delay: 10,
  });
  assert.deepEqual(interfaceMetric(t, d, { ...p, name: "Ethernet0" }), {
    bandwidth: 10000,
    delay: 100,
  });
  assert.deepEqual(
    interfaceMetric(t, d, { ...p, media: "serial", clockRate: 64000 }),
    { bandwidth: 1544, delay: 2000 },
  );
  metric(p, 50000, 50);
  const sub = createSubinterface(d, p.id, 10, 10);
  d.ports.push(sub);
  assert.deepEqual(interfaceMetric(t, d, sub), { bandwidth: 50000, delay: 50 });
  sub.delay = 70;
  assert.deepEqual(interfaceMetric(t, d, sub), { bandwidth: 50000, delay: 70 });
  p.cost = 65535;
  assert.equal(route(t, "A").metric, 256 * 251);
  const sw = createDevice("switch", 1),
    svi = createSvi(sw, 10);
  assert.deepEqual(interfaceMetric(t, sw, svi), {
    bandwidth: 1000000,
    delay: 1,
  });
});

test("metric previews tolerate new and removed Port-channel drafts", () => {
  const original = createDevice("switch", 1);
  const draft = setChannelGroup(original, ["p0", "p1"], 1, "active");
  const po = draft.ports.at(-1);
  const before = { ...blankTopology(), devices: [original] };
  assert.deepEqual(interfaceMetric(before, draft, po), {
    bandwidth: 1000000,
    delay: 1,
  });
  // An applied removal reaches the parent before its draft-reset effect runs.
  const removed = {
    ...draft,
    ports: draft.ports
      .filter((p) => p.id !== po.id)
      .map((p) => {
        const port = { ...p };
        delete port.channelGroup;
        return port;
      }),
  };
  assert.deepEqual(
    interfaceMetric({ ...before, devices: [removed] }, draft, po),
    { bandwidth: 1000000, delay: 1 },
  );
  assert.deepEqual(
    interfaceMetric(before, draft, { ...po, bandwidth: 50000, delay: 30 }),
    { bandwidth: 50000, delay: 30 },
  );
});

test("routed Port-channel metric derives from active members and reconverges after member failure", () => {
  const switches = [1, 2].map((n) => {
    let d = setChannelGroup(
      createDevice("switch", n),
      ["p0", "p1"],
      1,
      "active",
    );
    const before = structuredClone(d),
      po = d.ports.at(-1);
    d = setSwitchport(d, po.id, false);
    d.ipRouting = true;
    Object.assign(d.ports.at(-1), { ip: "10.0.0." + n, prefix: 30 });
    d = reconcilePortChannels(before, d);
    d.routing = {
      ...defaultRouting(),
      protocol: "eigrp",
      processId: 10,
      networks: [{ network: "0.0.0.0", prefix: 0, area: 0 }],
    };
    return d;
  });
  const [a, b] = switches;
  const pc = createDevice("pc", 1);
  Object.assign(pc.ports[0], { ip: "192.168.7.10", prefix: 24 });
  pc.gateway = "192.168.7.1";
  Object.assign(b.ports[2], {
    ip: pc.gateway,
    routed: true,
    bandwidth: 2000000,
  });
  delete b.ports[2].nativeVlan;
  let t = { ...blankTopology(), devices: [...switches, pc] };
  for (const id of ["p0", "p1"])
    t = connect(
      t,
      { device: a.id, port: id },
      { device: b.id, port: id },
      "copper",
    );
  t = connect(
    t,
    { device: b.id, port: "p2" },
    { device: pc.id, port: "p0" },
    "copper",
  );
  const po = a.ports.at(-1);
  assert.equal(routingNeighbors(t, a.id).length, 1);
  assert.deepEqual(interfaceMetric(t, a, po), { bandwidth: 2000000, delay: 1 });
  assert.equal(route(t, a.id).localPort, po.id);
  assert.equal(route(t, a.id).metric, 1792);
  assert.equal(ping(t, a.id, pc.ports[0].ip).ok, true);
  b.ports[0].enabled = false;
  assert.deepEqual(interfaceMetric(t, a, po), { bandwidth: 1000000, delay: 1 });
  assert.equal(route(t, a.id).metric, 3072);
  assert.equal(routingNeighbors(t, a.id).length, 1);
  b.ports[1].enabled = false;
  assert.deepEqual(routingNeighbors(t, a.id), []);
  assert.equal(route(t, a.id), undefined);
});

test("router subinterfaces use inherited metrics and withdraw when their parent goes down", () => {
  const setup = fixture([["A", "D"]]);
  let { t } = setup;
  const a = setup.routers.get("A"),
    d = setup.routers.get("D"),
    parent = a.ports[0];
  metric(parent, 50000, 50);
  const sub = createSubinterface(a, parent.id, 10, 10);
  Object.assign(sub, { ip: parent.ip, prefix: parent.prefix });
  parent.ip = "";
  a.ports.push(sub);
  const sw = setVlan(createDevice("switch", 1), 10);
  Object.assign(sw.ports[0], { mode: "trunk", allowedVlans: [1, 10] });
  sw.ports[1].vlan = 10;
  t.devices.push(sw);
  t.links = t.links.filter((l) => l.a.device !== a.id && l.b.device !== a.id);
  t = connect(
    t,
    { device: a.id, port: "p0" },
    { device: sw.id, port: "p0" },
    "copper",
  );
  t = connect(
    t,
    { device: d.id, port: "p0" },
    { device: sw.id, port: "p1" },
    "copper",
  );
  assert.equal(route(t, a.id).localPort, sub.id);
  assert.equal(route(t, a.id).metric, 64256);
  assert.equal(ping(t, a.id, setup.pc.ports[0].ip).ok, true);
  parent.enabled = false;
  assert.equal(route(t, a.id), undefined);
});

test("SVI adjacency follows VLAN autostate and requires IP routing", () => {
  const setup = fixture([["A", "D"]]);
  let { t } = setup;
  const old = setup.routers.get("A"),
    d = setup.routers.get("D");
  const sw = setVlan(createDevice("switch", 1), 10);
  sw.id = old.id;
  sw.ipRouting = true;
  sw.routing = old.routing;
  sw.ports[0].vlan = 10;
  const svi = createSvi(sw, 10);
  Object.assign(svi, {
    ip: old.ports[0].ip,
    prefix: old.ports[0].prefix,
    delay: 20,
  });
  sw.ports.push(svi);
  t.devices = t.devices.map((entry) => (entry.id === old.id ? sw : entry));
  assert.equal(route(t, sw.id).localPort, svi.id);
  assert.equal(route(t, sw.id).metric, 7936);
  assert.equal(ping(t, sw.id, setup.pc.ports[0].ip).ok, true);
  sw.ipRouting = false;
  assert.equal(route(t, sw.id), undefined);
  sw.ipRouting = true;
  t.devices = t.devices.map((entry) =>
    entry.id === sw.id ? setVlan(sw, 10, { state: "suspended" }) : entry,
  );
  assert.equal(route(t, sw.id), undefined);
  assert.deepEqual(routingNeighbors(t, d.id), []);
});

test("EIGRP and metric overrides round-trip, validate bounds and restore saved startup", () => {
  const { t, routers, ports } = fixture([["A", "D"]]);
  metric(ports.get("AD"), 2147483647, 16777215);
  assert.deepEqual(parseTopology(serializeTopology(t)), t);
  assert.equal(
    "bandwidth" in parseTopology(serializeTopology(t)).devices[1].ports[0],
    false,
  );
  const saved = saveStartup(routers.get("A"));
  saved.routing.processId = 99;
  saved.ports[0].bandwidth = 1;
  assert.equal(reloadDevice(saved).routing.processId, 10);
  assert.equal(reloadDevice(saved).ports[0].bandwidth, 2147483647);
  for (const [field, value] of [
    ["bandwidth", 0],
    ["bandwidth", 2147483648],
    ["delay", 0],
    ["delay", 16777216],
    ["delay", 1.5],
  ]) {
    const bad = structuredClone(t);
    bad.devices[0].ports[0][field] = value;
    assert.throws(
      () => parseTopology(JSON.stringify(bad)),
      undefined,
      `${field}=${value}`,
    );
    assert.ok(configurationError(bad.devices[0]));
  }
  const badRouterId = structuredClone(t);
  badRouterId.devices[0].routing.routerId = "0.0.0.0";
  assert.throws(
    () => parseTopology(JSON.stringify(badRouterId)),
    /nonzero IPv4/,
  );
  assert.match(configurationError(badRouterId.devices[0]), /nonzero IPv4/);
});

test("RIP and OSPF retain their existing metric and distance behavior", () => {
  const { t, routers } = fixture([["A", "D"]]);
  for (const [protocol, distance, expected] of [
    ["rip", 120, 1],
    ["ospf", 110, 2],
  ]) {
    for (const d of routers.values()) d.routing.protocol = protocol;
    const selected = learnedRoutes(t, "A").find(
      (r) => r.network === "192.168.7.0",
    );
    assert.equal(selected.protocol, protocol);
    assert.equal(selected.distance, distance);
    assert.equal(selected.metric, expected);
  }
});

test("the repair lab changes routes after AS repair, delay tuning and link withdrawal", () => {
  const t = eigrpRepairLab();
  const west = t.devices.find((d) => d.name === "EIGRP-West");
  const east = t.devices.find((d) => d.name === "EIGRP-East");
  const selected = () =>
    learnedRoutes(t, west.id).find((r) => r.network === "10.20.20.0");
  assert.ok(west && east);
  assert.equal(selected(), undefined);
  east.routing.processId = 10;
  assert.equal(selected().nextHop, "192.0.2.2");
  west.ports.find((p) => p.id === "p1").delay = 1000;
  assert.equal(selected().nextHop, "192.0.2.10");
  west.ports.find((p) => p.id === "p2").enabled = false;
  assert.equal(selected().nextHop, "192.0.2.2");
  assert.deepEqual(parseTopology(serializeTopology(t)), t);
});
