import assert from "node:assert/strict";
import { test } from "node:test";
import { runPdu } from "../src/network-studio/pdus.ts";
import { createRuntime } from "../src/network-studio/networkRuntime.ts";
import { advanceWorkspaceClock } from "../src/network-studio/workspaceClock.ts";
import { dualStackLab, servicesLab } from "../src/network-studio/labs.ts";
import {
  formatIPv6,
  ipv6,
  linkLocal6,
  sameSubnet6,
  usableIPv6,
} from "../src/network-studio/ipv6Address.ts";
import { ping6 } from "../src/network-studio/ipv6Engine.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
import { createDevice, connect } from "../src/network-studio/model.ts";
import { command, INITIAL_CLI } from "../src/network-studio/cli.ts";
test("IPv6 canonicalization, IPv4-embedded forms, prefix matching and malformed syntax", () => {
  assert.equal(
    formatIPv6(ipv6("2001:0DB8:0000:0000:0001:0000:0000:0001")),
    "2001:db8::1:0:0:1",
  );
  assert.equal(formatIPv6(ipv6("::")), "::");
  assert.equal(formatIPv6(ipv6("::ffff:192.0.2.1")), "::ffff:c000:201");
  assert.equal(sameSubnet6("2001:db8:10::1", "2001:db8:10::ffff", 64), true);
  assert.equal(sameSubnet6("2001:db8:10::1", "2001:db8:11::1", 64), false);
  for (const value of [
    "1:2:3",
    "2001:::1",
    "::1::2",
    "12345::1",
    "fe80::1%eth0",
    "[2001:db8::1]",
    "::ffff:999.1.1.1",
  ])
    assert.equal(ipv6(value), null, value);
  for (const value of ["::", "::1", "ff02::1", "::ffff:192.0.2.1"])
    assert.equal(usableIPv6(value), false);
  assert.equal(linkLocal6("fe80::1"), true);
  assert.equal(linkLocal6("2001:db8::1"), false);
});
test("dual-stack IPv6 unicast traces NDP and both ICMPv6 directions over static routes", () => {
  const t = dualStackLab(),
    [client, r1, r2, server] = t.devices,
    result = ping6(t, client.id, server.ports[0].ipv6);
  assert.equal(result.ok, true);
  assert.deepEqual(result.hops, [client.id, r1.id, r2.id, server.id]);
  assert.ok(result.events.some((e) => e.protocol === "NDP"));
  assert.ok(
    result.events.some((e) => e.protocol === "ICMPv6" && e.phase === "reply"),
  );
  assert.deepEqual(parseTopology(serializeTopology(t)), t);
});
test("IPv6 forwarding switch, host gateway, return routes and disabled interfaces affect real delivery", () => {
  for (const cause of ["forwarding", "gateway", "return", "interface"]) {
    const t = dualStackLab(),
      [client, r1, r2, server] = t.devices;
    if (cause === "forwarding") r1.ipv6Routing = false;
    if (cause === "gateway") client.gateway6 = "";
    if (cause === "return") r2.routes6 = [];
    if (cause === "interface") r1.ports[1].enabled = false;
    const result = ping6(t, client.id, server.ports[0].ipv6);
    assert.equal(result.ok, false, cause);
    if (cause === "return")
      assert.match(result.message, /request delivered; reply failed/);
  }
});
test("IPv6 VLAN isolation and canonical global duplicate detection fail closed", () => {
  const t = servicesLab(),
    [a, sw, b] = t.devices;
  a.ports[0].ipv6 = "2001:db8::10";
  b.ports[0].ipv6 = "2001:db8::20";
  assert.equal(ping6(t, a.id, b.ports[0].ipv6).ok, true);
  sw.ports[1].vlan = 10;
  assert.equal(ping6(t, a.id, b.ports[0].ipv6).ok, false);
  b.ports[0].ipv6 = "2001:0db8:0:0:0:0:0:10";
  assert.match(ping6(t, a.id, "2001:db8::10").message, /Duplicate global/);
});
test("identical link-local destinations on different links require scope and reply from the selected peer", () => {
  const r = createDevice("router", 1),
    a = createDevice("pc", 1),
    b = createDevice("pc", 2);
  r.ports[0].ipv6 = r.ports[1].ipv6 = "fe80::a";
  a.ports[0].ipv6 = b.ports[0].ipv6 = "fe80::b";
  let t = { version: 1, name: "IPv6 scope", devices: [r, a, b], links: [] };
  t = connect(
    t,
    { device: r.id, port: "p0" },
    { device: a.id, port: "p0" },
    "copper",
  );
  t = connect(
    t,
    { device: r.id, port: "p1" },
    { device: b.id, port: "p0" },
    "copper",
  );
  assert.match(ping6(t, r.id, "fe80::b").message, /Ambiguous link-local/);
  const scoped = ping6(t, r.id, "fe80::b", "p1");
  assert.equal(scoped.ok, true);
  assert.ok(
    scoped.events.some(
      (e) => e.protocol === "ICMPv6" && e.phase === "reply" && e.from === b.id,
    ),
  );
  assert.ok(!scoped.events.some((e) => e.from === a.id || e.to === a.id));
  const pdu = {
    id: "scoped",
    source: r.id,
    target: b.id,
    port: "p0",
    protocol: "icmpv6",
    sourceInterface: "p1",
  };
  assert.equal(runPdu(t, pdu, createRuntime()).ok, true);
  assert.match(
    runPdu(t, { ...pdu, sourceInterface: "p0" }, createRuntime()).message,
    /another endpoint/,
  );
});
test("IPv6 routing loops terminate and malformed IPv6 extensions cannot be imported", () => {
  const t = dualStackLab(),
    [client, r1, r2] = t.devices;
  r1.routes6 = [{ network: "::", prefix: 0, nextHop: "2001:db8:ff::2" }];
  r2.routes6 = [{ network: "::", prefix: 0, nextHop: "2001:db8:ff::1" }];
  assert.match(ping6(t, client.id, "2001:db8:99::1").message, /routing loop/);
  for (const mutate of [
    (d) => (d.ports[0].ipv6 = "broken"),
    (d) => (d.ports[0].prefix6 = 129),
    (d) => (d.routes6[0].network = "2001:db8::1"),
    (d) => (d.routes6[0].interface = "missing"),
  ]) {
    const broken = structuredClone(t);
    mutate(broken.devices[1]);
    assert.throws(() => parseTopology(serializeTopology(broken)));
  }
});
test("IPv6 CLI updates model state and respects config mode and forwarding", () => {
  let t = dualStackLab(),
    session = INITIAL_CLI;
  const routerId = t.devices[1].id;
  const run = (line) => {
    const result = command(t, routerId, session, line);
    t = result.topology;
    session = result.session;
    return result;
  };
  assert.match(run("show ipv6 route").output, /2001:db8:20::/);
  run("enable");
  run("configure terminal");
  run("no ipv6 unicast-routing");
  assert.equal(t.devices[1].ipv6Routing, false);
  run("ipv6 unicast-routing");
  run("interface GigabitEthernet0/0");
  assert.equal(run("ipv6 address 2001:db8:10::1/64").changed, true);
  assert.equal(run("ipv6 address broken/999").changed, false);
  run("end");
  assert.match(run("ping ipv6 2001:db8:20::100").output, /Success/);
  assert.match(
    command(t, t.devices[0].id, INITIAL_CLI, "ipv6config").output,
    /2001:db8:10::10/,
  );
});

test("saved IPv4 and IPv6 probes consume one hop per transit router and keep independent replies", () => {
  const t = dualStackLab(),
    [client, r1, r2, server] = t.devices;
  for (const protocol of ["icmp", "icmpv6", "tcp", "udp"]) {
    const base = {
      id: "limited",
      source: client.id,
      target: server.id,
      port: "p0",
      protocol,
      ...(protocol === "tcp" || protocol === "udp"
        ? { destinationPort: 53 }
        : {}),
    };
    const r = createRuntime();
    for (const [ttl, name] of [
      [1, r1.name],
      [2, r2.name],
    ]) {
      const blocked = runPdu(t, { ...base, ttl }, r);
      assert.equal(blocked.ok, false);
      assert.ok(blocked.message.includes(name), blocked.message);
      assert.equal(blocked.events.at(-1).ttl, 0);
    }
    assert.equal(runPdu(t, { ...base, ttl: 3 }, r).ok, true);
    assert.equal(runPdu(t, { ...base, target: r1.id, ttl: 1 }, r).ok, true);
  }
  const packet = {
    id: "v6",
    source: client.id,
    target: server.id,
    port: "p0",
    protocol: "icmpv6",
    ttl: 3,
    sourceInterface: "p0",
    schedule: { delay: 2, interval: 4 },
  };
  t.pdus = [packet];
  const saved = parseTopology(serializeTopology(t)),
    r = createRuntime();
  advanceWorkspaceClock(r, saved, 6);
  assert.equal(r.pduTimers.get("v6").sent, 2);
  assert.equal(r.pduResults.get("v6").destinationDevice, server.id);
  for (const bad of [
    { ttl: 0 },
    { ttl: 256 },
    { sourceInterface: "missing" },
    { destinationPort: 6 },
    { protocol: "icmp" },
  ])
    assert.throws(() =>
      parseTopology(JSON.stringify({ ...t, pdus: [{ ...packet, ...bad }] })),
    );
});
