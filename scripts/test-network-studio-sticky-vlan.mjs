import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDevice,
  connect,
  exampleTopology,
} from "../src/network-studio/model.ts";
import {
  createRuntime,
  advanceRuntime,
  adoptRuntime,
} from "../src/network-studio/networkRuntime.ts";
import { interfaceMac, transmitFrame } from "../src/network-studio/ethernet.ts";
import {
  materializeSticky,
  transitionSticky,
} from "../src/network-studio/portSecurity.ts";
import { ping, configurationError } from "../src/network-studio/engine.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
import {
  saveStartup,
  reloadDevice,
} from "../src/network-studio/deviceLifecycle.ts";
import { command } from "../src/network-studio/cli.ts";
test("sticky learns into immutable running config, excludes aging and changes startup only on save", () => {
  let t = exampleTopology();
  const [a, s, b] = t.devices,
    r = createRuntime();
  s.ports[0].security = {
    maximum: 1,
    violation: "restrict",
    addresses: [],
    sticky: true,
    agingMinutes: 1,
  };
  t.devices[1] = saveStartup(s);
  assert.equal(ping(t, a.id, b.ports[0].ip, r).ok, true);
  const original = JSON.stringify(t);
  const next = materializeSticky(t, r);
  assert.notEqual(next, t);
  assert.equal(JSON.stringify(t), original);
  adoptRuntime(r, next);
  assert.equal(
    next.devices[1].ports[0].security.bindings[0].mac,
    interfaceMac(a.id, "p0"),
  );
  assert.equal(
    reloadDevice(next.devices[1]).ports[0].security.bindings,
    undefined,
  );
  advanceRuntime(r, next, 3600);
  assert.equal(r.security[0].addresses.length, 1);
  assert.equal(
    parseTopology(serializeTopology(next)).devices[1].ports[0].security.bindings
      .length,
    1,
  );
  assert.equal(
    reloadDevice(saveStartup(next.devices[1])).ports[0].security.bindings
      .length,
    1,
  );
});
test("sticky CLI converts dynamic on enable and back to transient on disable", () => {
  let t = exampleTopology();
  const r = createRuntime(),
    id = t.devices[1].id;
  let session = { mode: "interface", portId: "p0" };
  t.devices[1].ports[0].security = {
    maximum: 1,
    violation: "restrict",
    addresses: [],
  };
  ping(t, t.devices[0].id, t.devices[2].ports[0].ip, r);
  const run = (line) => {
    const o = command(t, id, session, line, r);
    t = o.topology;
    session = o.session;
    return o;
  };
  assert.equal(
    run("switchport port-security mac-address sticky").preserveRuntime,
    true,
  );
  run("end");
  assert.match(
    run("show running-config").output,
    /mac-address sticky [0-9a-f]+ vlan 1/,
  );
  run("configure terminal");
  run("interface GigabitEthernet0/0");
  assert.equal(
    run("no switchport port-security mac-address sticky").preserveRuntime,
    true,
  );
  assert.deepEqual(t.devices[1].ports[0].security.bindings, []);
  assert.equal(r.security[0].addresses.length, 1);
  assert.deepEqual(r.security[0].sticky, []);
});
function taggedLab() {
  const a = createDevice("pc", 1),
    b = createDevice("pc", 2),
    sw = createDevice("switch", 1),
    edge = createDevice("switch", 2),
    dest = createDevice("server", 1);
  a.ports[0].taggedVlan = 20;
  a.ports[0].ip = "192.168.20.10";
  b.ports[0].ip = "192.168.10.10";
  dest.ports[0].taggedVlan = 20;
  dest.ports[0].ip = "192.168.20.20";
  sw.ports[0].vlan = 10;
  sw.ports[0].voiceVlan = 20;
  sw.ports[1].vlan = 10;
  for (const p of [sw.ports[2], edge.ports[0]]) {
    p.mode = "trunk";
    p.allowedVlans = [10, 20];
  }
  edge.ports[1].vlan = 20;
  // tagged destination uses an access voice port to exercise tagging in both directions
  edge.ports[1].vlan = 10;
  edge.ports[1].voiceVlan = 20;
  sw.ports[2].security = {
    maximum: 2,
    violation: "restrict",
    addresses: [],
    vlanMaximums: [{ vlan: 20, maximum: 1 }],
  };
  let t = {
    version: 1,
    name: "Synthetic secure VLANs",
    devices: [a, b, sw, edge, dest],
    links: [],
  };
  for (const [l, lp, r, rp] of [
    [a, "p0", sw, "p0"],
    [b, "p0", sw, "p1"],
    [sw, "p2", edge, "p0"],
    [edge, "p1", dest, "p0"],
  ])
    t = connect(
      t,
      { device: l.id, port: lp },
      { device: r.id, port: rp },
      "copper",
    );
  return { t, a, b, sw, edge, dest };
}
test("voice VLAN tagged endpoint reaches tagged peer over secure trunk and cannot enter data VLAN", () => {
  const { t, a, b, sw, dest } = taggedLab(),
    r = createRuntime();
  assert.equal(ping(t, a.id, dest.ports[0].ip, r).ok, true);
  assert.ok(
    r.security
      .find((s) => s.device === sw.id)
      .addresses.every((k) => k.startsWith("20/")),
  );
  assert.equal(ping(t, b.id, dest.ports[0].ip, r).ok, false);
  t.devices[0].ports[0].taggedVlan = 30;
  assert.equal(ping(t, a.id, dest.ports[0].ip, r).ok, false);
});
test("secure trunk per-VLAN limit rejects a second source while another VLAN retains capacity", () => {
  const { t, a, sw, dest } = taggedLab(),
    r = createRuntime();
  const from = { device: dest.id, port: "p0" };
  transmitFrame(t, from, "ffffffffffff", r);
  const first = r.security.find((s) => s.device === sw.id);
  assert.equal(first.addresses.length, 1);
  transmitFrame(t, from, "ffffffffffff", r, "020000000001");
  assert.equal(first.violations, 1);
  assert.equal(first.addresses.length, 1);
  // same MAC on a separate VLAN is a distinct identity
  dest.ports[0].taggedVlan = 10;
  const p = t.devices.find((d) => d.kind === "switch" && d.id !== sw.id)
    .ports[1];
  p.voiceVlan = 10;
  p.vlan = 30;
  adoptRuntime(r, t);
  transmitFrame(t, { device: dest.id, port: "p0" }, "ffffffffffff", r);
  assert.equal(first.addresses.length, 2);
  assert.equal(first.violations, 1);
});
test("VLAN security validates ownership, capacities, tags and file/startup round trips", () => {
  const { t, sw } = taggedLab();
  sw.ports[2].security.sticky = true;
  sw.ports[2].security.bindings = [
    { vlan: 20, mac: "020000000001", sticky: true },
  ];
  assert.equal(configurationError(sw), null);
  assert.equal(
    parseTopology(serializeTopology(t)).devices[2].ports[2].security.bindings[0]
      .vlan,
    20,
  );
  for (const change of [
    (s) =>
      s.ports[2].security.bindings.push({
        vlan: 20,
        mac: "020000000001",
        sticky: true,
      }),
    (s) => (s.ports[2].security.bindings[0].vlan = 30),
    (s) => (s.ports[2].security.vlanMaximums = [{ vlan: 30, maximum: 1 }]),
    (s) => (s.ports[0].voiceVlan = 10),
  ]) {
    const copy = structuredClone(t);
    change(copy.devices[2]);
    assert.throws(() => parseTopology(JSON.stringify(copy)));
  }
});
test("CLI supports voice VLAN, per-VLAN maxima and explicit sticky binding grammar", () => {
  let t = exampleTopology(),
    session = { mode: "interface", portId: "p0" };
  const r = createRuntime(),
    id = t.devices[1].id;
  const run = (line) => {
    const o = command(t, id, session, line, r);
    t = o.topology;
    session = o.session;
    return o;
  };
  assert.equal(run("switchport voice vlan 20").changed, true);
  run("switchport port-security maximum 2");
  assert.equal(
    run("switchport port-security maximum 1 vlan voice").changed,
    true,
  );
  assert.equal(
    run("switchport port-security mac-address sticky 0200.0000.0001 vlan voice")
      .changed,
    true,
  );
  run("end");
  assert.match(run("show port-security").output, /20\/020000000001 sticky/);
});
import { ping6 } from "../src/network-studio/ipv6Engine.ts";
import { defaultServices } from "../src/network-studio/extensions.ts";
import { httpRequest, requestDhcp } from "../src/network-studio/services.ts";
test("tagged voice IPv6 and HTTP share secure trunk forwarding; DHCP remains VLAN isolated", () => {
  const { t, a, b, dest } = taggedLab(),
    r = createRuntime();
  a.ports[0].ipv6 = "2001:db8:20::10";
  a.ports[0].prefix6 = 64;
  dest.ports[0].ipv6 = "2001:db8:20::20";
  dest.ports[0].prefix6 = 64;
  assert.equal(ping6(t, a.id, "2001:db8:20::20", undefined, r).ok, true);
  dest.services = defaultServices();
  dest.services.http.enabled = true;
  assert.equal(httpRequest(t, a.id, "http://192.168.20.20/", r).ok, true);
  dest.services.dhcp = {
    enabled: true,
    pools: [
      {
        id: "voice",
        name: "voice",
        start: "192.168.20.50",
        prefix: 24,
        count: 8,
        gateway: "",
        dns: "",
      },
    ],
    leases: [],
  };
  const lease = requestDhcp(t, a.id, undefined, r);
  assert.equal(lease.ok, true, lease.message);
  assert.equal(lease.address, "192.168.20.50");
  assert.equal(requestDhcp(t, b.id, undefined, r).ok, false);
});
test("wrong sticky no-form cannot erase a configured static binding", () => {
  let t = exampleTopology(),
    session = { mode: "interface", portId: "p0" };
  const r = createRuntime(),
    id = t.devices[1].id;
  const run = (line) => {
    const o = command(t, id, session, line, r);
    t = o.topology;
    session = o.session;
    return o;
  };
  run("switchport port-security mac-address 020000000001");
  run("no switchport port-security mac-address sticky 020000000001");
  assert.equal(t.devices[1].ports[0].security.bindings[0].sticky, false);
  assert.equal(
    run("switchport port-security mac-address sticky 020000000001").changed,
    false,
  );
});
