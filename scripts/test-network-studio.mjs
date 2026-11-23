import assert from "node:assert/strict";
import { advanceWorkspaceClock } from "../src/network-studio/workspaceClock.ts";
import { adoptRuntime } from "../src/network-studio/networkRuntime.ts";
import { activePdus, removeScenario } from "../src/network-studio/scenarios.ts";
import { runPdu } from "../src/network-studio/pdus.ts";
import { createRuntime } from "../src/network-studio/networkRuntime.ts";
import { removeDevice } from "../src/network-studio/model.ts";
import { test } from "node:test";
import {
  blankTopology,
  connect,
  createDevice,
  exampleTopology,
  linkUp,
} from "../src/network-studio/model.ts";
import {
  configurationError,
  ipv4,
  mask,
  ping,
  prefixFromMask,
  usableIp,
} from "../src/network-studio/engine.ts";
import { command, INITIAL_CLI } from "../src/network-studio/cli.ts";
import {
  MAX_FILE_BYTES,
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";

function wire(t, a, ap, b, bp, media = "copper") {
  return connect(
    t,
    { device: a.id, port: ap },
    { device: b.id, port: bp },
    media,
  );
}
function routed() {
  const left = createDevice("pc", 1),
    r1 = createDevice("router", 1),
    r2 = createDevice("router", 2),
    right = createDevice("pc", 2);
  left.ports[0].ip = "10.1.0.10";
  left.gateway = "10.1.0.1";
  r1.ports[0].ip = "10.1.0.1";
  r1.ports[1].ip = "172.16.0.1";
  r1.ports[1].prefix = 30;
  r2.ports[0].ip = "10.2.0.1";
  r2.ports[1].ip = "172.16.0.2";
  r2.ports[1].prefix = 30;
  right.ports[0].ip = "10.2.0.20";
  right.gateway = "10.2.0.1";
  r1.routes = [{ network: "10.2.0.0", prefix: 24, nextHop: "172.16.0.2" }];
  r2.routes = [{ network: "10.1.0.0", prefix: 24, nextHop: "172.16.0.1" }];
  let t = { ...blankTopology(), devices: [left, r1, r2, right] };
  t = wire(t, left, "p0", r1, "p0");
  t = wire(t, r1, "p1", r2, "p1");
  t = wire(t, right, "p0", r2, "p0");
  return { t, left, r1, r2, right };
}
test("router-originated ICMP uses the selected egress interface as its source address", () => {
  const { t, r1, r2, right } = routed();
  // No route back to r1's LAN is needed when the ping originates on its transit interface.
  r2.routes = [];
  const result = ping(t, r1.id, right.ports[0].ip);
  assert.equal(result.ok, true);
  assert.match(
    result.events.find((e) => e.protocol === "ICMP" && e.phase === "request")
      .detail,
    /172\.16\.0\.1/,
  );
});
test("a local echo to an enabled own interface succeeds without a cable; disabled sources fail", () => {
  const d = createDevice("pc", 1);
  d.ports[0].ip = "10.0.0.1";
  const t = { ...blankTopology(), devices: [d] };
  assert.equal(ping(t, d.id, "10.0.0.1").ok, true);
  d.ports[0].enabled = false;
  assert.equal(ping(t, d.id, "10.0.0.1").ok, false);
});
test("strict IPv4 and contiguous masks, host/broadcast and point-to-point boundaries", () => {
  assert.equal(ipv4("192.168.1.1"), 3232235777);
  for (const ip of ["01.2.3.4", "256.1.1.1", "1.2.3", "-1.2.3.4", "1.2.3.4 "])
    assert.equal(ipv4(ip), null);
  assert.equal(prefixFromMask("255.255.255.0"), 24);
  assert.equal(prefixFromMask("255.0.255.0"), null);
  assert.equal(mask(0), 0);
  for (const ip of ["10.0.0.0", "10.0.0.255", "224.0.0.1", "127.0.0.1"])
    assert.equal(usableIp(ip, 24), false);
  assert.equal(usableIp("10.0.0.0", 31), true);
  assert.equal(usableIp("10.0.0.1", 32), true);
});
test("example LAN has bidirectional ICMP and explicit ARP abstraction", () => {
  const t = exampleTopology(),
    source = t.devices[0],
    dest = t.devices[2];
  const result = ping(t, source.id, dest.ports[0].ip);
  assert.equal(result.ok, true);
  assert.ok(
    result.events.some((e) => e.protocol === "ICMP" && e.phase === "reply"),
  );
  assert.deepEqual(result.hops, [source.id, t.devices[1].id, dest.id]);
  assert.equal(result.events.filter((e) => e.protocol === "ARP").length, 4);
});
test("disconnected, powered-off and administratively disabled destinations fail", () => {
  for (const mutation of ["links", "power", "interface"]) {
    const t = exampleTopology(),
      dest = t.devices[2];
    if (mutation === "links")
      t.links = t.links.filter(
        (l) => l.a.device !== dest.id && l.b.device !== dest.id,
      );
    if (mutation === "power") dest.powered = false;
    if (mutation === "interface") dest.ports[0].enabled = false;
    assert.equal(
      ping(t, t.devices[0].id, dest.ports[0].ip).ok,
      false,
      mutation,
    );
  }
});
test("different access VLANs isolate otherwise wired hosts", () => {
  const t = exampleTopology();
  t.devices[1].ports[1].vlan = 20;
  assert.equal(ping(t, t.devices[0].id, t.devices[2].ports[0].ip).ok, false);
  t.devices[1].ports[0].vlan = 20;
  assert.equal(ping(t, t.devices[0].id, t.devices[2].ports[0].ip).ok, true);
});
test("tagged trunks require matching allowed VLANs and never silently negotiate native VLANs", () => {
  const a = createDevice("pc", 1),
    b = createDevice("pc", 2),
    s1 = createDevice("switch", 1),
    s2 = createDevice("switch", 2);
  a.ports[0].ip = "10.0.0.1";
  b.ports[0].ip = "10.0.0.2";
  for (const s of [s1, s2]) {
    s.ports[0].vlan = 10;
    s.ports[1].mode = "trunk";
    s.ports[1].allowedVlans = [10];
  }
  let t = { ...blankTopology(), devices: [a, b, s1, s2] };
  t = wire(t, a, "p0", s1, "p0");
  t = wire(t, s1, "p1", s2, "p1");
  t = wire(t, s2, "p0", b, "p0");
  assert.equal(ping(t, a.id, b.ports[0].ip).ok, true);
  s2.ports[1].allowedVlans = [20];
  assert.equal(ping(t, a.id, b.ports[0].ip).ok, false);
  s2.ports[1].allowedVlans = [10];
  s2.ports[1].mode = "access";
  assert.equal(ping(t, a.id, b.ports[0].ip).ok, false);
});
test("two routers deliver requests and independent replies using static routes", () => {
  const { t, left, right } = routed();
  const result = ping(t, left.id, right.ports[0].ip);
  assert.equal(result.ok, true);
  assert.equal(
    result.events.filter((e) => e.protocol === "ICMP" && e.phase === "request")
      .length,
    3,
  );
});
test("missing host gateway, forward route, unreachable next hop and missing return route fail", () => {
  for (const mutation of ["gateway", "forward", "nextHop", "return"]) {
    const { t, left, right, r1, r2 } = routed();
    if (mutation === "gateway") left.gateway = "";
    if (mutation === "forward") r1.routes = [];
    if (mutation === "nextHop") r1.routes[0].nextHop = "172.16.0.3";
    if (mutation === "return") r2.routes = [];
    const result = ping(t, left.id, right.ports[0].ip);
    assert.equal(result.ok, false, mutation);
    if (mutation === "return")
      assert.match(result.message, /Request delivered; reply failed/);
  }
});
test("longest-prefix route overrides a default route independently of insertion order", () => {
  const { t, left, right, r1 } = routed();
  r1.routes.unshift({ network: "0.0.0.0", prefix: 0, nextHop: "172.16.0.3" });
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, true);
});
test("routing loops terminate with an explicit failure", () => {
  const { t, left, r1, r2 } = routed();
  r1.routes = [{ network: "0.0.0.0", prefix: 0, nextHop: "172.16.0.2" }];
  r2.routes = [{ network: "0.0.0.0", prefix: 0, nextHop: "172.16.0.1" }];
  const result = ping(t, left.id, "192.0.2.10");
  assert.equal(result.ok, false);
  assert.match(result.message, /loop/);
  assert.ok(result.events.length < 40);
});
test("duplicate IPs, invalid masks and malformed routes fail closed", () => {
  const t = exampleTopology();
  t.devices[2].ports[0].ip = t.devices[0].ports[0].ip;
  assert.match(ping(t, t.devices[0].id, "192.168.10.100").message, /Duplicate/);
  const r = createDevice("router", 1);
  r.ports[0].prefix = 0;
  assert.match(configurationError(r), /prefix/);
  r.ports[0].prefix = 24;
  r.routes = [{ network: "10.0.0.5", prefix: 24, nextHop: "10.0.0.1" }];
  assert.match(configurationError(r), /Static routes/);
});
test("cabling forbids occupied ports, self-loops, missing endpoints and mismatched media", () => {
  const t = exampleTopology(),
    a = t.devices[0],
    b = t.devices[2];
  assert.throws(() => wire(t, a, "p0", b, "p0"), /already/);
  assert.throws(() => wire(t, a, "missing", b, "p0"), /existing/);
  assert.throws(() => wire(t, a, "p0", a, "p0"), /different/);
  const r1 = createDevice("router", 1),
    r2 = createDevice("router", 2),
    rt = { ...blankTopology(), devices: [r1, r2] };
  assert.throws(() => wire(rt, r1, "p2", r2, "p2"), /media/);
  const fiber = wire(rt, r1, "p2", r2, "p2", "fiber");
  assert.equal(linkUp(fiber, fiber.links[0]), true);
});
test("versioned JSON round-trip preserves topology and drops unknown fields", () => {
  const t = exampleTopology();
  assert.deepEqual(parseTopology(serializeTopology(t)), t);
  const raw = JSON.parse(serializeTopology(t));
  raw.script = "untrusted";
  raw.devices[0].secret = "untrusted";
  const restored = parseTopology(JSON.stringify(raw));
  assert.equal("script" in restored, false);
  assert.equal("secret" in restored.devices[0], false);
});
test("import rejects unsupported versions, identifiers, missing endpoints, excessive counts and file sizes", () => {
  const variants = [
    (t) => {
      t.version = 9;
    },
    (t) => {
      t.devices[1].id = t.devices[0].id;
    },
    (t) => {
      t.links[0].a.device = "absent";
    },
    (t) => {
      t.links.push(t.links[0]);
    },
    (t) => {
      t.devices[0].ports[0].enabled = "true";
    },
    (t) => {
      t.devices[0].x = Infinity;
    },
    (t) => {
      t.devices[0].ports[0].prefix = 33;
    },
    (t) => {
      t.devices = Array(129).fill(t.devices[0]);
    },
  ];
  for (const mutate of variants) {
    const t = exampleTopology();
    mutate(t);
    assert.throws(() => parseTopology(JSON.stringify(t)));
  }
  assert.throws(() => parseTopology(" ".repeat(MAX_FILE_BYTES + 1)), /limit/);
  for (const raw of ["null", "[]", "{}", "{broken"])
    assert.throws(() => parseTopology(raw));
});
test("CLI enforces context, changes actual topology and does not accept unimplemented commands", () => {
  const router = createDevice("router", 1);
  let t = { ...blankTopology(), devices: [router] },
    s = INITIAL_CLI;
  const run = (line) => {
    const result = command(t, router.id, s, line);
    t = result.topology;
    s = result.session;
    return result;
  };
  assert.equal(run("end").changed, false);
  assert.equal(s.mode, "user");
  assert.match(run("configure terminal").output, /Unsupported/);
  run("enable");
  run("configure terminal");
  run("interface GigabitEthernet0/0");
  assert.equal(s.mode, "interface");
  assert.equal(run("ip address 10.0.0.1 255.255.255.0").changed, true);
  assert.equal(t.devices[0].ports[0].ip, "10.0.0.1");
  assert.equal(run("ip address 10.0.0.2 255.0.255.0").changed, false);
  run("shutdown");
  assert.equal(t.devices[0].ports[0].enabled, false);
  run("no shutdown");
  run("end");
  assert.match(run("show ip interface brief").output, /10.0.0.1/);
  assert.match(run("router ospf 1").output, /Unsupported/);
  assert.match(run("copy running-config startup-config").output, /\[OK\]/);
  assert.equal(t.devices[0].startupConfig.ports[0].ip, "10.0.0.1");
  assert.equal(router.ports[0].ip, "", "original object was not mutated");
});
test("CLI adds/removes static routes and switch access/trunk configuration", () => {
  for (const kind of ["router", "switch"]) {
    const d = createDevice(kind, 1);
    let t = { ...blankTopology(), devices: [d] },
      s = { mode: "config", portId: null };
    const run = (input) => {
      const r = command(t, d.id, s, input);
      t = r.topology;
      s = r.session;
      return r;
    };
    if (kind === "router") {
      assert.equal(run("ip route 0.0.0.0 0.0.0.0 10.0.0.1").changed, true);
      assert.equal(t.devices[0].routes.length, 1);
      run("no ip route 0.0.0.0 0.0.0.0 10.0.0.1");
      assert.equal(t.devices[0].routes.length, 0);
    } else {
      run("interface GigabitEthernet0/0");
      run("switchport access vlan 10");
      assert.equal(t.devices[0].ports[0].vlan, 10);
      run("switchport mode trunk");
      run("switchport trunk allowed vlan 10,20");
      assert.deepEqual(t.devices[0].ports[0].allowedVlans, [10, 20]);
      assert.equal(run("switchport access vlan 5000").changed, false);
    }
  }
});
test("native trunk ingress and egress share the allowed list with tagged frames", () => {
  const t = exampleTopology(),
    [client, sw, peer] = t.devices;
  const uplink = sw.ports[0];
  uplink.mode = "trunk";
  uplink.allowedVlans = [10, 20];
  uplink.nativeVlan = 10;
  sw.ports[1].vlan = 10;
  assert.ok(ping(t, client.id, peer.ports[0].ip).ok);
  uplink.allowedVlans = [20];
  assert.equal(ping(t, client.id, peer.ports[0].ip).ok, false);
  client.ports[0].taggedVlan = 20;
  sw.ports[1].vlan = 20;
  assert.ok(ping(t, client.id, peer.ports[0].ip).ok);
  delete client.ports[0].taggedVlan;
  delete uplink.nativeVlan;
  uplink.allowedVlans = [1, 10, 20];
  sw.ports[1].vlan = 1;
  const oldFile = parseTopology(serializeTopology(t));
  assert.equal(oldFile.devices[1].ports[0].nativeVlan, undefined);
  assert.equal(ping(oldFile, client.id, peer.ports[0].ip).ok, false);
  uplink.nativeVlan = 1;
  assert.ok(ping(t, client.id, peer.ports[0].ip).ok);
});
test("trunk native mismatch blocks only the inconsistent VLAN and config CLI restores VLAN 1", () => {
  const sw = createDevice("switch", 1),
    edge = createDevice("switch", 2),
    a = createDevice("pc", 1),
    b = createDevice("pc", 2);
  a.ports[0].ip = "10.0.0.1";
  b.ports[0].ip = "10.0.0.2";
  for (const s of [sw, edge]) {
    s.ports[1].mode = "trunk";
    s.ports[1].allowedVlans = [10, 20];
    s.ports[0].vlan = 10;
  }
  sw.ports[1].nativeVlan = 10;
  edge.ports[1].nativeVlan = 30;
  let t = { ...blankTopology(), devices: [sw, edge, a, b] };
  t = wire(t, a, "p0", sw, "p0");
  t = wire(t, sw, "p1", edge, "p1");
  t = wire(t, edge, "p0", b, "p0");
  assert.equal(ping(t, a.id, b.ports[0].ip).ok, false);
  for (const s of [sw, edge]) s.ports[0].vlan = 20;
  assert.equal(ping(t, a.id, b.ports[0].ip).ok, true);
  const config = (line) =>
    command(t, edge.id, { mode: "interface", portId: "p1" }, line);
  let out = config("switchport trunk native vlan 10");
  assert.ok(out.changed);
  t = out.topology;
  t.devices[0].ports[0].vlan = 10;
  t.devices[1].ports[0].vlan = 10;
  assert.equal(ping(t, a.id, b.ports[0].ip).ok, true);
  assert.match(
    command(
      t,
      edge.id,
      { mode: "privileged", portId: null },
      "show interfaces trunk",
    ).output,
    /GigabitEthernet0\/1  trunk  trunking  10  10,20/,
  );
  assert.match(
    command(
      t,
      edge.id,
      { mode: "privileged", portId: null },
      "show running-config",
    ).output,
    /switchport trunk native vlan 10/,
  );
  assert.equal(config("switchport trunk native vlan 4095").changed, false);
  assert.equal(
    config("no switchport trunk native vlan").topology.devices[1].ports[1]
      .nativeVlan,
    1,
  );
  const invalid = structuredClone(t);
  invalid.devices[2].ports[0].nativeVlan = 10;
  assert.throws(() => parseTopology(serializeTopology(invalid)));
});
test("user-created ICMP/TCP/UDP probes preserve only definitions and rerun against current addresses", () => {
  const t = exampleTopology(),
    [src, sw, dst] = t.devices,
    r = createRuntime();
  t.pdus = ["icmp", "tcp", "udp"].map((protocol) => ({
    id: protocol,
    source: src.id,
    target: dst.id,
    port: "p0",
    protocol,
    ...(protocol === "icmp" ? {} : { destinationPort: 9000 }),
  }));
  for (const pdu of t.pdus) {
    const out = runPdu(t, pdu, r);
    assert.ok(out.ok);
    assert.ok(
      out.events.some((e) => e.protocol === pdu.protocol.toUpperCase()),
    );
    assert.equal(r.pduResults.get(pdu.id), out);
  }
  const file = serializeTopology(t);
  assert.deepEqual(parseTopology(file).pdus, t.pdus);
  assert.doesNotMatch(file, /pduResults|Delivered/);
  dst.ports[0].ip = "192.168.10.99";
  assert.equal(runPdu(t, t.pdus[0], r).destinationAddress, "192.168.10.99");
  dst.powered = false;
  assert.equal(runPdu(t, t.pdus[0], r).ok, false);
  assert.deepEqual(removeDevice(t, dst.id).pdus, []);
  assert.deepEqual(removeDevice(t, sw.id).pdus, t.pdus);
});
test("PDU file validation rejects unknown devices, invalid ports, duplicate IDs and oversized lists", () => {
  const t = exampleTopology(),
    [src, sw, dst] = t.devices;
  const p = {
    id: "pdu-1",
    source: src.id,
    target: dst.id,
    port: "p0",
    protocol: "icmp",
  };
  for (const pdus of [
    [{ ...p, target: "missing" }],
    [{ ...p, source: sw.id }],
    [{ ...p, port: "missing" }],
    [{ ...p, protocol: "bad" }],
    [{ ...p, destinationPort: 80 }],
    [{ ...p, protocol: "tcp", destinationPort: 0 }],
    [p, p],
    Array.from({ length: 65 }, (_, i) => ({ ...p, id: String(i) })),
  ]) {
    assert.throws(() => parseTopology(JSON.stringify({ ...t, pdus })));
  }
});
test("scheduled PDUs honor exact due times, run each period and keep manual sends independent", () => {
  const t = exampleTopology(),
    [a, , b] = t.devices,
    r = createRuntime();
  const base = { source: a.id, target: b.id, port: "p0", protocol: "icmp" };
  t.pdus = [
    { ...base, id: "once", schedule: { delay: 10 } },
    { ...base, id: "repeat", schedule: { delay: 5, interval: 3 } },
  ];
  advanceWorkspaceClock(r, t, 4);
  assert.equal(r.pduResults.size, 0);
  advanceWorkspaceClock(r, t, 1);
  assert.equal(r.pduTimers.get("repeat").last, 5);
  runPdu(t, t.pdus[1], r);
  assert.equal(r.pduTimers.get("repeat").next, 8);
  advanceWorkspaceClock(r, t, 7);
  assert.deepEqual(r.pduTimers.get("repeat"), { sent: 3, last: 11, next: 14 });
  assert.deepEqual(r.pduTimers.get("once"), {
    sent: 1,
    last: 10,
    next: undefined,
  });
  assert.ok(r.pduResults.get("once").ok);
  advanceWorkspaceClock(r, t, 0);
  assert.equal(r.pduTimers.get("once").sent, 1);
  const reloaded = parseTopology(serializeTopology(t)),
    fresh = createRuntime();
  advanceWorkspaceClock(fresh, reloaded, 0);
  assert.equal(fresh.pduTimers.get("once").next, 10);
  assert.equal(fresh.pduResults.size, 0);
  const deleted = removeDevice(t, b.id);
  adoptRuntime(r, deleted);
  assert.equal(r.pduTimers.size, 0);
  assert.equal(r.pduResults.size, 0);
});
test("zero-delay PDUs run at the current tick and malformed schedules are rejected", () => {
  const t = exampleTopology(),
    r = createRuntime(),
    [a, , b] = t.devices;
  const p = {
    id: "probe",
    source: a.id,
    target: b.id,
    port: "p0",
    protocol: "tcp",
    destinationPort: 443,
    schedule: { delay: 0 },
  };
  advanceWorkspaceClock(r, t, 17);
  t.pdus = [p];
  adoptRuntime(r, t);
  advanceWorkspaceClock(r, t, 0);
  assert.equal(r.pduTimers.get("probe").last, 17);
  for (const schedule of [
    { delay: -1 },
    { delay: 0, interval: 0 },
    { delay: 1.5 },
    { delay: 0, interval: 86401 },
  ])
    assert.throws(() =>
      parseTopology(JSON.stringify({ ...t, pdus: [{ ...p, schedule }] })),
    );
});
test("named scenarios pause clocks separately, resume the remaining delay and release deleted PDU runtime", () => {
  let t = exampleTopology();
  const r = createRuntime(),
    [a, , b] = t.devices;
  t.scenarios = [
    { id: "default", name: "Baseline", description: "Standard path" },
    { id: "voice", name: "Voice", description: "Network traffic" },
  ];
  const pdu = {
    source: a.id,
    target: b.id,
    port: "p0",
    protocol: "icmp",
    schedule: { delay: 10, interval: 10 },
  };
  t.pdus = [
    { ...pdu, id: "baseline" },
    { ...pdu, id: "test", scenario: "voice" },
  ];
  advanceWorkspaceClock(r, t, 4);
  assert.equal(r.pduResults.size, 0);
  t = { ...t, activeScenario: "voice" };
  adoptRuntime(r, t);
  advanceWorkspaceClock(r, t, 12);
  assert.equal(r.pduTimers.get("test").sent, 1);
  assert.equal(r.pduTimers.get("baseline").remaining, 6);
  const saved = parseTopology(serializeTopology(t));
  assert.deepEqual(
    activePdus(saved).map((p) => p.id),
    ["test"],
  );
  t = { ...t, activeScenario: "default" };
  adoptRuntime(r, t);
  advanceWorkspaceClock(r, t, 5);
  assert.equal(r.pduTimers.get("baseline").sent, 0);
  advanceWorkspaceClock(r, t, 1);
  assert.equal(r.pduTimers.get("baseline").last, 22);
  t = removeScenario(t, "voice");
  adoptRuntime(r, t);
  assert.equal(r.pduTimers.has("test"), false);
  assert.equal(r.pduResults.has("test"), false);
  assert.equal(removeScenario(t, "default"), t);
});
test("legacy packet lists belong to Scenario 0 and malformed scenario references fail import", () => {
  const t = exampleTopology(),
    [a, , b] = t.devices;
  const p = {
    source: a.id,
    target: b.id,
    port: "p0",
    id: "probe",
    protocol: "icmp",
  };
  assert.deepEqual(
    activePdus(parseTopology(serializeTopology({ ...t, pdus: [p] }))),
    [p],
  );
  const first = { id: "default", name: "Baseline", description: "" };
  for (const fields of [
    { scenarios: [] },
    { activeScenario: "absent" },
    { pdus: [{ ...p, scenario: "absent" }] },
    { scenarios: [first, { ...first, id: "x", name: "baseline" }] },
    { scenarios: [{ ...first, description: "x".repeat(301) }] },
  ])
    assert.throws(() => parseTopology(JSON.stringify({ ...t, ...fields })));
});

test("router subinterface CLI stages encapsulation, preserves startup config and removes logical interfaces", () => {
  const router = createDevice("router", 1);
  let topology = { ...blankTopology(), devices: [router] };
  let session = { mode: "config", portId: null };
  const run = (line) => {
    const result = command(topology, router.id, session, line);
    topology = result.topology;
    session = result.session;
    return result;
  };
  assert.equal(run("interface gi0/0.10").changed, true);
  const portId = session.portId;
  assert.equal(topology.devices[0].ports.at(-1).virtual.vlan, undefined);
  assert.match(
    run("ip address 192.168.10.1 255.255.255.0").output,
    /encapsulation/,
  );
  assert.equal(run("encapsulation dot1Q 10").changed, true);
  assert.equal(run("ip address 192.168.10.1 255.255.255.0").changed, true);
  assert.equal(run("ip helper-address 198.51.100.5").changed, true);
  assert.equal(run("switchport mode trunk").changed, false);
  run("interface Gi0/0.20");
  const duplicate = run("encapsulation dot1Q 10");
  assert.equal(duplicate.changed, false);
  run("encapsulation dot1Q 20 native");
  run("end");
  const config = run("show running-config").output;
  assert.match(
    config,
    /interface GigabitEthernet0\/0\.10\n encapsulation dot1Q 10\n ip address 192\.168\.10\.1/,
  );
  assert.match(config, /encapsulation dot1Q 20 native/);
  assert.match(
    run("show ip interface brief").output,
    /GigabitEthernet0\/0\.10.*down.*down/,
  );
  run("copy running-config startup-config");
  run("configure terminal");
  run("no interface gi0/0.10");
  assert.equal(
    topology.devices[0].ports.some((p) => p.id === portId),
    false,
  );
  run("end");
  run("reload");
  assert.equal(
    topology.devices[0].ports.find((p) => p.id === portId).ip,
    "192.168.10.1",
  );
  assert.equal(
    parseTopology(serializeTopology(topology)).devices[0].ports.find(
      (p) => p.id === portId,
    ).virtual.vlan,
    10,
  );
  assert.equal(router.ports.length, 3);
});

test("SVI CLI supports switch routing, helpers, ACLs and management without inventing physical ports", () => {
  const sw = createDevice("switch", 1);
  let topology = { ...blankTopology(), devices: [sw] };
  let session = { mode: "config", portId: null };
  const run = (line) => {
    const result = command(topology, sw.id, session, line);
    topology = result.topology;
    session = result.session;
    return result;
  };
  run("ip default-gateway 192.168.10.254");
  assert.equal(run("interface vlan 10").changed, true);
  assert.equal(run("ip address 192.168.10.1 255.255.255.0").changed, true);
  assert.equal(run("ip helper-address 198.51.100.5").changed, true);
  assert.equal(run("switchport access vlan 20").changed, false);
  run("exit");
  run("ip routing");
  assert.equal(topology.devices[0].ipRouting, true);
  run("access-list CLIENTS permit ip any any");
  run("interface Vlan10");
  assert.equal(run("ip access-group CLIENTS in").changed, true);
  run("exit");
  assert.equal(run("ip route 0.0.0.0 0.0.0.0 192.168.10.254").changed, true);
  assert.equal(run("router ospf 1").changed, true);
  run("network 192.168.10.0 0.0.0.255 area 0");
  run("end");
  const config = run("show running-config").output;
  assert.match(config, /ip routing\nip default-gateway 192\.168\.10\.254/);
  const stanza = config.split("interface Vlan10\n")[1].split("\nip route ")[0];
  assert.doesNotMatch(stanza, /switchport/);
  assert.match(stanza, /ip helper-address 198\.51\.100\.5/);
  run("configure terminal");
  run("no ip routing");
  run("end");
  assert.match(run("show ip route").output, /IP routing is disabled/);
  run("configure terminal");
  assert.equal(run("no interface vlan 10").changed, true);
  assert.equal(topology.devices[0].ports.length, sw.ports.length);
  assert.equal(
    parseTopology(serializeTopology(topology)).devices[0].ports.length,
    8,
  );
});

test("CLI reload prunes PDUs whose logical interface or switch source no longer exists", () => {
  for (const kind of ["router", "switch"]) {
    const device = createDevice(kind, 1);
    const pc = createDevice("pc", 1);
    pc.ports[0].ip = "192.168.10.10";
    let topology = { ...blankTopology(), devices: [device, pc] };
    let result = command(
      topology,
      device.id,
      { mode: "config", portId: null },
      kind === "router" ? "interface Gi0/0.10" : "interface Vlan10",
    );
    const logical = result.session.portId;
    topology = result.topology;
    topology.pdus = [
      {
        id: "explicit",
        source: device.id,
        sourceInterface: logical,
        target: pc.id,
        port: "p0",
        protocol: "icmpv6",
      },
      {
        id: "destination",
        source: pc.id,
        target: device.id,
        port: logical,
        protocol: "icmp",
      },
      {
        id: "implicit",
        source: device.id,
        target: pc.id,
        port: "p0",
        protocol: "icmp",
      },
    ];
    assert.doesNotThrow(() => parseTopology(serializeTopology(topology)));
    result = command(
      topology,
      device.id,
      { mode: "privileged", portId: null },
      "reload",
    );
    assert.equal(result.changed, true);
    assert.deepEqual(
      result.topology.pdus.map((p) => p.id),
      kind === "switch" ? [] : ["implicit"],
    );
    assert.doesNotThrow(() =>
      parseTopology(serializeTopology(result.topology)),
    );
  }
});
