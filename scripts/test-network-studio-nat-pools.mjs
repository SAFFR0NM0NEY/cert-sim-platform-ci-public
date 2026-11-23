import assert from "node:assert/strict";
import { test } from "node:test";
import { natPoolsLab, servicesLab } from "../src/network-studio/labs.ts";
import { ping, probeIPv4 } from "../src/network-studio/engine.ts";
import { httpRequest, requestDhcp } from "../src/network-studio/services.ts";
import {
  createRuntime,
  advanceRuntime,
  clearNat,
} from "../src/network-studio/networkRuntime.ts";
import { natProxy, natConflict } from "../src/network-studio/nat.ts";
import { createDevice, connect } from "../src/network-studio/model.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
import { command } from "../src/network-studio/cli.ts";
import {
  saveStartup,
  reloadDevice,
} from "../src/network-studio/deviceLifecycle.ts";
test("one-to-one pool binds distinct public addresses and preserves ports across protocols", () => {
  const t = natPoolsLab(),
    r = createRuntime();
  for (const client of t.devices.slice(0, 2)) {
    const result = ping(t, client.id, "203.0.113.200", r);
    assert.equal(result.ok, true, result.message);
    assert.ok(
      result.events.some(
        (e) => e.protocol === "NAT" && e.detail.includes("ports preserved"),
      ),
    );
  }
  assert.deepEqual(
    r.poolBindings.map((b) => b.globalIp),
    ["203.0.113.10", "203.0.113.11"],
  );
  assert.equal(r.nat.length, 0);
  assert.equal(
    httpRequest(t, t.devices[0].id, "http://203.0.113.200/", r).ok,
    true,
  );
  assert.equal(r.poolBindings.length, 2);
  const segment = probeIPv4(
    t,
    t.devices[0].id,
    "203.0.113.200",
    "tcp",
    80,
    r,
  ).events.find(
    (e) =>
      e.protocol === "TCP" &&
      e.phase === "request" &&
      e.from === t.devices[4].id,
  );
  assert.match(segment.detail, /203\.0\.113\.10/);
});
test("selected exhausted pool fails without interface-PAT fallback; clear and exact expiry release addresses", () => {
  const t = natPoolsLab(),
    router = t.devices[4],
    r = createRuntime();
  router.nat.pools[0].end = "203.0.113.10";
  router.nat.overload = [{ acl: "inside", outsidePort: "p1" }];
  assert.equal(ping(t, t.devices[0].id, "203.0.113.200", r).ok, true);
  const exhausted = ping(t, t.devices[1].id, "203.0.113.200", r);
  assert.equal(exhausted.ok, false);
  assert.match(exhausted.message, /pool public exhausted/);
  assert.equal(r.nat.length, 0);
  advanceRuntime(r, t, 299);
  assert.equal(r.poolBindings.length, 1);
  advanceRuntime(r, t, 1);
  assert.equal(r.poolBindings.length, 0);
  assert.equal(ping(t, t.devices[1].id, "203.0.113.200", r).ok, true);
  clearNat(r, router.id);
  assert.equal(r.poolBindings.length, 0);
  assert.equal(ping(t, t.devices[0].id, "203.0.113.200", r).ok, true);
});
test("pool overload shares addresses with distinct tuples and respects one-to-one reservations", () => {
  const t = natPoolsLab(),
    router = t.devices[4],
    r = createRuntime();
  router.nat.poolRules[0].overload = true;
  for (const client of t.devices.slice(0, 2))
    assert.equal(ping(t, client.id, "203.0.113.200", r).ok, true);
  assert.equal(r.nat.length, 2);
  assert.equal(new Set(r.nat.map((e) => e.globalIp)).size, 1);
  assert.equal(new Set(r.nat.map((e) => e.globalPort)).size, 2);
  router.accessLists.push({
    name: "first",
    rules: [
      {
        action: "permit",
        protocol: "ip",
        source: "192.168.50.10",
        sourcePrefix: 32,
        destination: "0.0.0.0",
        destinationPrefix: 0,
      },
    ],
  });
  router.nat.poolRules = [
    { acl: "first", pool: "public", overload: false },
    { acl: "inside", pool: "public", overload: true },
  ];
  assert.equal(ping(t, t.devices[0].id, "203.0.113.200", r).ok, true);
  assert.equal(ping(t, t.devices[1].id, "203.0.113.200", r).ok, true);
  assert.equal(r.poolBindings[0].globalIp, "203.0.113.10");
  assert.equal(r.nat[0].globalIp, "203.0.113.11");
});
test("only active on-link allocations proxy ARP, and off-link pools require outside return routes", () => {
  const t = natPoolsLab(),
    router = t.devices[4],
    port = router.ports[1],
    r = createRuntime();
  assert.equal(natProxy(router, port, "203.0.113.10", r), false);
  ping(t, t.devices[0].id, "203.0.113.200", r);
  assert.equal(natProxy(router, port, "203.0.113.10", r), true);
  clearNat(r);
  assert.equal(natProxy(router, port, "203.0.113.10", r), false);
  router.nat.pools[0] = {
    name: "public",
    start: "198.51.100.10",
    end: "198.51.100.11",
    prefix: 24,
  };
  const result = ping(t, t.devices[0].id, "203.0.113.200", r);
  assert.equal(result.ok, false);
  assert.match(result.message, /reply failed/);
});
test("pool selector denial leaves traffic untranslated and outbound ACL sees allocated public address", () => {
  const t = natPoolsLab(),
    router = t.devices[4];
  router.accessLists[0].rules[0].action = "deny";
  assert.equal(ping(t, t.devices[0].id, "203.0.113.200").ok, false);
  router.accessLists[0].rules[0].action = "permit";
  router.accessLists.push({
    name: "public-out",
    rules: [
      {
        action: "permit",
        protocol: "ip",
        source: "203.0.113.10",
        sourcePrefix: 32,
        destination: "0.0.0.0",
        destinationPrefix: 0,
      },
    ],
  });
  router.ports[1].outboundAcl = "public-out";
  assert.equal(ping(t, t.devices[0].id, "203.0.113.200").ok, true);
  router.accessLists[1].rules[0].source = "192.168.50.10";
  assert.equal(ping(t, t.devices[0].id, "203.0.113.200").ok, false);
});
test("pool JSON/startup round trip, invalid ranges/references/ownership reject atomically", () => {
  const t = natPoolsLab(),
    wire = serializeTopology(t);
  assert.deepEqual(parseTopology(wire).devices[4].nat, t.devices[4].nat);
  assert.equal(
    reloadDevice(saveStartup(t.devices[4])).nat.pools[0].name,
    "public",
  );
  for (const mutate of [
    (t) => (t.devices[4].nat.pools[0].end = "203.0.113.9"),
    (t) => (t.devices[4].nat.pools[0].end = "203.0.114.11"),
    (t) => (t.devices[4].nat.pools[0].start = "203.0.113.0"),
    (t) => (t.devices[4].nat.poolRules[0].pool = "missing"),
    (t) => (t.devices[4].nat.poolRules[0].acl = "missing"),
    (t) => (t.devices[4].nat.pools[0].start = "203.0.113.1"),
    (t) => (t.devices[4].nat.pools[0].end = "203.0.113.200"),
    (t) =>
      t.devices[4].nat.pools.push({
        ...t.devices[4].nat.pools[0],
        name: "overlap",
      }),
  ]) {
    const bad = JSON.parse(wire);
    mutate(bad);
    assert.throws(() => parseTopology(JSON.stringify(bad)));
  }
  assert.equal(serializeTopology(t), wire);
  const other = createDevice("router", 2, 500, 500);
  other.nat = {
    static: [],
    overload: [],
    pools: [
      { name: "clash", start: "203.0.113.10", end: "203.0.113.12", prefix: 24 },
    ],
  };
  assert.match(
    natConflict({ ...t, devices: [...t.devices, other] }),
    /conflicting NAT pool/,
  );
});
test("DHCP skips pool-reserved NAT public addresses even before a NAT binding exists", () => {
  let t = servicesLab();
  const router = createDevice("router", 1, 500, 500);
  router.nat = {
    static: [],
    overload: [],
    pools: [
      {
        name: "reserved",
        start: "192.168.10.50",
        end: "192.168.10.50",
        prefix: 24,
      },
    ],
  };
  t = { ...t, devices: [...t.devices, router] };
  const result = requestDhcp(t, t.devices[0].id);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.address, "192.168.10.51");
});
test("CLI pool/rule commands drive real bindings, show/clear and reject deleting a referenced pool", () => {
  let t = natPoolsLab(),
    id = t.devices[4].id,
    r = createRuntime(),
    session = { mode: "config", portId: null };
  t.devices[4].nat.pools = [];
  t.devices[4].nat.poolRules = [];
  const run = (line) => {
    const out = command(t, id, session, line, r);
    t = out.topology;
    session = out.session;
    return out;
  };
  assert.equal(
    run("ip nat pool WAN 203.0.113.10 203.0.113.10 netmask 255.255.255.0")
      .changed,
    true,
  );
  assert.equal(run("ip nat inside source list inside pool WAN").changed, true);
  assert.equal(run("no ip nat pool WAN").changed, false);
  run("end");
  assert.equal(ping(t, t.devices[0].id, "203.0.113.200", r).ok, true);
  assert.match(run("show ip nat translations").output, /pool WAN/);
  run("clear ip nat translation *");
  assert.equal(r.poolBindings.length, 0);
  run("configure terminal");
  assert.equal(
    run("no ip nat inside source list inside pool WAN").changed,
    true,
  );
  assert.equal(run("no ip nat pool WAN").changed, true);
});
