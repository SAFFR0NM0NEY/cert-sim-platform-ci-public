import assert from "node:assert/strict";
import { test } from "node:test";
import { natLab } from "../src/network-studio/labs.ts";
import { ping, probeIPv4 } from "../src/network-studio/engine.ts";
import { httpRequest, dnsLookup } from "../src/network-studio/services.ts";
import {
  createRuntime,
  advanceRuntime,
} from "../src/network-studio/networkRuntime.ts";
import { natInbound } from "../src/network-studio/nat.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
import { command, INITIAL_CLI } from "../src/network-studio/cli.ts";
import {
  saveStartup,
  reloadDevice,
} from "../src/network-studio/deviceLifecycle.ts";
test("PAT separates identical client tuples and routes replies through the public address", () => {
  const t = natLab(),
    r = createRuntime();
  for (const d of t.devices.slice(0, 2)) {
    const p = ping(t, d.id, "203.0.113.200", r);
    assert.equal(p.ok, true, p.message);
    assert.ok(
      p.events.some(
        (e) => e.protocol === "NAT" && e.detail.includes("PAT source"),
      ),
    );
    assert.ok(
      p.events.some(
        (e) => e.protocol === "NAT" && e.detail.includes("PAT destination"),
      ),
    );
  }
  assert.equal(r.nat.length, 2);
  assert.equal(new Set(r.nat.map((e) => e.globalPort)).size, 2);
  assert.equal(r.nat[0].insidePort, 1);
  assert.equal(r.nat[0].globalIp, "203.0.113.1");
  assert.equal(ping(t, t.devices[0].id, "203.0.113.200", r).ok, true);
  assert.equal(r.nat.length, 2);
});
test("static NAT proxy ARP delivers outside HTTP to the actual private server and translates its reply", () => {
  const t = natLab(),
    r = createRuntime(),
    outside = t.devices[5],
    inside = t.devices[2];
  const p = probeIPv4(t, outside.id, "203.0.113.100", "tcp", 80, r);
  assert.equal(p.ok, true, p.message);
  assert.equal(p.destinationDevice, inside.id);
  assert.equal(p.destinationAddress, "192.168.50.100");
  assert.ok(
    p.events.some(
      (e) => e.protocol === "NAT" && e.detail.includes("Static source"),
    ),
  );
  const http = httpRequest(t, outside.id, "http://203.0.113.100/", r);
  assert.equal(http.ok, true, http.message);
  assert.match(http.body, /private server/);
  assert.equal(r.nat.length, 0);
  const reverse = httpRequest(t, inside.id, "http://203.0.113.200/", r);
  assert.equal(reverse.ok, true, reverse.message);
  assert.equal(r.nat.length, 0);
});
test("DNS and HTTP work through UDP/TCP overload and use independent translated flows", () => {
  const t = natLab(),
    r = createRuntime(),
    client = t.devices[0];
  const dns = dnsLookup(t, client.id, "public.certsim.lab", undefined, r);
  assert.equal(dns.ok, true, dns.message);
  const response = httpRequest(t, client.id, "http://public.certsim.lab/", r);
  assert.equal(response.ok, true, response.message);
  assert.match(response.body, /public server/);
  assert.deepEqual(
    new Set(r.nat.map((e) => e.protocol)),
    new Set(["udp", "tcp"]),
  );
});
test("roles, selector ACL denial and missing return gateway produce real failures", () => {
  for (const breakConfig of [
    (t) => delete t.devices[4].ports[0].natRole,
    (t) => delete t.devices[4].ports[1].natRole,
    (t) => (t.devices[4].accessLists[0].rules[0].action = "deny"),
  ]) {
    const t = natLab();
    breakConfig(t);
    const p = ping(t, t.devices[0].id, "203.0.113.200");
    assert.equal(p.ok, false, p.message);
  }
  const t = natLab();
  t.devices[2].gateway = "";
  assert.equal(
    httpRequest(t, t.devices[5].id, "http://203.0.113.100/").ok,
    false,
  );
});
test("ACLs inspect arrival tuples before destination NAT and output tuples after source NAT", () => {
  const t = natLab(),
    router = t.devices[4];
  const rule = (source, sourcePrefix, destination, destinationPrefix) => ({
    action: "permit",
    protocol: "ip",
    source,
    sourcePrefix,
    destination,
    destinationPrefix,
  });
  router.accessLists.push({
    name: "out",
    rules: [rule("203.0.113.1", 32, "0.0.0.0", 0)],
  });
  router.ports[1].outboundAcl = "out";
  assert.equal(ping(t, t.devices[0].id, "203.0.113.200").ok, true);
  router.accessLists[1].rules[0].source = "192.168.50.10";
  assert.equal(ping(t, t.devices[0].id, "203.0.113.200").ok, false);
  delete router.ports[1].outboundAcl;
  router.accessLists[1].rules = [rule("0.0.0.0", 0, "203.0.113.100", 32)];
  router.ports[1].inboundAcl = "out";
  assert.equal(
    httpRequest(t, t.devices[5].id, "http://203.0.113.100/").ok,
    true,
  );
  router.accessLists[1].rules[0].destination = "192.168.50.100";
  assert.equal(
    httpRequest(t, t.devices[5].id, "http://203.0.113.100/").ok,
    false,
  );
});
test("dynamic translations expire on protocol-specific boundaries and reject unmatched remote endpoints", () => {
  for (const [protocol, seconds, port] of [
    ["icmp", 30, undefined],
    ["udp", 60, 53],
    ["tcp", 300, 80],
  ]) {
    const t = natLab(),
      r = createRuntime();
    assert.equal(
      probeIPv4(t, t.devices[0].id, "203.0.113.200", protocol, port, r).ok,
      true,
    );
    const e = r.nat[0];
    const packet = {
      protocol,
      sourceIp: e.remoteIp,
      destinationIp: e.globalIp,
      sourcePort: protocol === "icmp" ? e.globalPort : e.remotePort,
      destinationPort: protocol === "icmp" ? undefined : e.globalPort,
    };
    assert.match(
      natInbound(
        t.devices[4],
        t.devices[4].ports[1],
        { ...packet, sourceIp: "203.0.113.201" },
        r,
      ).error,
      /No active/,
    );
    advanceRuntime(r, t, seconds - 1);
    assert.equal(r.nat.length, 1);
    advanceRuntime(r, t, 1);
    assert.equal(r.nat.length, 0);
    assert.match(
      natInbound(t.devices[4], t.devices[4].ports[1], packet, r).error,
      /No active/,
    );
  }
});
test("NAT config/startup round-trip but malformed aliases/roles/ACL references fail atomically", () => {
  const t = natLab(),
    wire = serializeTopology(t),
    copy = parseTopology(wire);
  assert.deepEqual(copy.devices[4].nat, t.devices[4].nat);
  assert.equal(reloadDevice(saveStartup(copy.devices[4])).nat.static.length, 1);
  for (const breakConfig of [
    (t) => (t.devices[4].nat.static[0].outside = "203.0.113.200"),
    (t) => t.devices[4].nat.static.push({ ...t.devices[4].nat.static[0] }),
    (t) => (t.devices[4].nat.overload[0].acl = "missing"),
    (t) => (t.devices[4].nat.overload[0].outsidePort = "missing"),
    (t) => (t.devices[4].ports[1].natRole = "invalid"),
    (t) => (t.devices[0].nat = { static: [], overload: [] }),
  ]) {
    const bad = JSON.parse(wire);
    breakConfig(bad);
    assert.throws(() => parseTopology(JSON.stringify(bad)));
  }
  assert.equal(serializeTopology(t), wire);
});
test("CLI configures real static/PAT selectors and roles, and clears only dynamic translations", () => {
  let t = natLab();
  const router = t.devices[4],
    id = router.id,
    r = createRuntime();
  router.nat = undefined;
  router.accessLists = [];
  delete router.ports[0].natRole;
  delete router.ports[1].natRole;
  let session = INITIAL_CLI;
  const run = (line) => {
    const out = command(t, id, session, line, r);
    t = out.topology;
    session = out.session;
    return out;
  };
  run("enable");
  run("configure terminal");
  assert.equal(
    run("access-list 1 permit 192.168.50.0 0.0.0.255").changed,
    true,
  );
  assert.equal(
    run("ip nat inside source list 1 interface GigabitEthernet0/1 overload")
      .changed,
    true,
  );
  assert.equal(
    run("ip nat inside source static 192.168.50.100 203.0.113.100").changed,
    true,
  );
  run("interface GigabitEthernet0/0");
  run("ip nat inside");
  run("exit");
  run("interface GigabitEthernet0/1");
  run("ip nat outside");
  run("end");
  assert.equal(ping(t, t.devices[0].id, "203.0.113.200", r).ok, true);
  assert.match(run("show ip nat translations").output, /icmp/);
  run("clear ip nat translation *");
  assert.equal(r.nat.length, 0);
  assert.equal(t.devices[4].nat.static.length, 1);
  assert.match(
    run("show running-config").output,
    /ip nat inside source list 1/,
  );
});
test("static port NAT exposes HTTP on a public alternate port and reverse-translates the complete reply tuple", () => {
  const t = natLab(),
    router = t.devices[4];
  router.nat.static = [];
  router.nat.portForwards = [
    {
      protocol: "tcp",
      inside: "192.168.50.100",
      insidePort: 80,
      outside: "203.0.113.1",
      outsidePort: 8080,
    },
  ];
  const response = httpRequest(t, t.devices[5].id, "http://203.0.113.1:8080/");
  assert.equal(response.ok, true, response.message);
  assert.match(response.body, /private server/);
  assert.ok(
    response.events.some(
      (e) => e.protocol === "NAT" && e.detail.includes(":8080"),
    ),
  );
  router.nat.portForwards[0].insidePort = 443;
  assert.equal(
    httpRequest(t, t.devices[5].id, "http://203.0.113.1:8080/").ok,
    false,
  );
});
test("port forwards reserve PAT tuples, reject ambiguous overlaps and persist with CLI control", () => {
  let t = natLab(),
    router = t.devices[4];
  router.nat.static = [];
  router.nat.portForwards = [
    {
      protocol: "tcp",
      inside: "192.168.50.100",
      insidePort: 80,
      outside: "203.0.113.1",
      outsidePort: 20000,
    },
    {
      protocol: "udp",
      inside: "192.168.50.100",
      insidePort: 53,
      outside: "203.0.113.1",
      outsidePort: 5353,
    },
  ];
  const r = createRuntime();
  assert.equal(
    probeIPv4(t, t.devices[0].id, "203.0.113.200", "tcp", 80, r).ok,
    true,
  );
  assert.equal(r.nat[0].globalPort, 20001);
  assert.equal(
    probeIPv4(t, t.devices[5].id, "203.0.113.1", "udp", 5353, r).ok,
    true,
  );
  const copy = parseTopology(serializeTopology(t));
  assert.deepEqual(copy.devices[4].nat.portForwards, router.nat.portForwards);
  const wire = JSON.parse(serializeTopology(t));
  wire.devices[4].nat.portForwards.push({
    ...wire.devices[4].nat.portForwards[0],
    outsidePort: 8080,
  });
  assert.throws(() => parseTopology(JSON.stringify(wire)));
  let s = { mode: "config", portId: null };
  const run = (line) => {
    const out = command(t, router.id, s, line, r);
    t = out.topology;
    s = out.session;
    return out;
  };
  run("no ip nat inside source static tcp 192.168.50.100 80 203.0.113.1 20000");
  assert.equal(t.devices[4].nat.portForwards.length, 1);
  assert.equal(
    run("ip nat inside source static tcp 192.168.50.100 80 203.0.113.1 8080")
      .changed,
    true,
  );
  assert.equal(
    httpRequest(t, t.devices[5].id, "http://203.0.113.1:8080/").ok,
    true,
  );
});
test("static port-forward imports reject bad ports, foreign public ownership and full-address overlap", () => {
  const t = natLab();
  t.devices[4].nat.static = [];
  t.devices[4].nat.portForwards = [
    {
      protocol: "tcp",
      inside: "192.168.50.100",
      insidePort: 80,
      outside: "203.0.113.1",
      outsidePort: 8080,
    },
  ];
  for (const patch of [
    { insidePort: 0 },
    { outsidePort: 65536 },
    { protocol: "icmp" },
    { outside: "203.0.113.200" },
  ]) {
    const wire = JSON.parse(serializeTopology(t));
    Object.assign(wire.devices[4].nat.portForwards[0], patch);
    assert.throws(() => parseTopology(JSON.stringify(wire)));
  }
  const wire = JSON.parse(serializeTopology(t));
  wire.devices[4].nat.static = [
    { inside: "192.168.50.100", outside: "203.0.113.100" },
  ];
  assert.throws(() => parseTopology(JSON.stringify(wire)));
});
test("DNS service selection follows the translated UDP port rather than just the delivered device", () => {
  const t = natLab(),
    router = t.devices[4],
    internal = t.devices[2];
  router.nat.static = [];
  router.nat.portForwards = [
    {
      protocol: "udp",
      inside: "192.168.50.100",
      insidePort: 5353,
      outside: "203.0.113.1",
      outsidePort: 53,
    },
  ];
  internal.services.dns = {
    enabled: true,
    records: [{ name: "private.test", type: "A", value: "192.168.50.100" }],
  };
  assert.equal(
    dnsLookup(t, t.devices[5].id, "private.test", "203.0.113.1").ok,
    false,
  );
  router.nat.portForwards[0].insidePort = 53;
  assert.equal(
    dnsLookup(t, t.devices[5].id, "private.test", "203.0.113.1").ok,
    true,
  );
});
