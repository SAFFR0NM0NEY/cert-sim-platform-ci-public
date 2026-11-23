import assert from "node:assert/strict";
import { test } from "node:test";
import { exampleTopology } from "../src/network-studio/model.ts";
import {
  createRuntime,
  clearMac,
  advanceRuntime,
  resetRuntime,
} from "../src/network-studio/networkRuntime.ts";
import { transmitFrame, interfaceMac } from "../src/network-studio/ethernet.ts";
import { ping, configurationError } from "../src/network-studio/engine.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
import {
  recoverSecurity,
  secureDestination,
  materializeSecurity,
} from "../src/network-studio/portSecurity.ts";
import {
  saveStartup,
  reloadDevice,
} from "../src/network-studio/deviceLifecycle.ts";
import { command } from "../src/network-studio/cli.ts";
function setup(mode = "shutdown") {
  const t = exampleTopology(),
    [a, s, b] = t.devices,
    r = createRuntime();
  s.ports[0].security = { maximum: 1, violation: mode, addresses: [] };
  return {
    t,
    a,
    s,
    b,
    r,
    send: (mac) =>
      transmitFrame(t, { device: a.id, port: "p0" }, "ffffffffffff", r, mac),
  };
}
test("protect and restrict reject before learning while retaining legitimate traffic", () => {
  for (const mode of ["protect", "restrict"]) {
    const { t, a, s, b, r, send } = setup(mode);
    send();
    assert.equal(r.security[0].addresses.length, 1);
    assert.ok(send("020000000001").length === 0);
    assert.ok(!r.mac.some((e) => e.mac === "020000000001"));
    assert.equal(r.security[0].violations, mode === "protect" ? 0 : 1);
    assert.equal(r.frames.at(-1).action, "security-drop");
    assert.equal(ping(t, a.id, b.ports[0].ip, r).ok, true);
  }
});
test("shutdown blocks ingress and egress until explicit recovery; MAC clear does not recover", () => {
  const { t, a, s, b, r, send } = setup();
  send();
  send("020000000001");
  assert.equal(r.security[0].shutdown, true);
  clearMac(r);
  assert.equal(ping(t, a.id, b.ports[0].ip, r).ok, false);
  assert.equal(
    transmitFrame(t, { device: b.id, port: "p0" }, "ffffffffffff", r).some(
      (e) => e.device.id === a.id,
    ),
    false,
  );
  recoverSecurity(r, s.id, "p0");
  assert.equal(ping(t, a.id, b.ports[0].ip, r).ok, true);
  assert.equal(r.security[0].violations, 0);
});
test("secure bindings survive normal aging and clear and remain destination forwarding authority", () => {
  const { t, a, s, b, r, send } = setup("restrict");
  send();
  advanceRuntime(r, t, 301);
  clearMac(r);
  assert.equal(r.security[0].addresses.length, 1);
  transmitFrame(t, { device: b.id, port: "p0" }, interfaceMac(a.id, "p0"), r);
  assert.equal(r.frames.at(-1).action, "forward");
  assert.deepEqual(r.frames.at(-1).egress, ["p0"]);
  assert.equal(send("020000000001").length, 0);
});
test("secure MAC moves on another secure access port violate without stealing ownership", () => {
  const { t, a, s, b, r, send } = setup("restrict");
  s.ports[1].security = { maximum: 2, violation: "restrict", addresses: [] };
  send();
  transmitFrame(
    t,
    { device: b.id, port: "p0" },
    "ffffffffffff",
    r,
    interfaceMac(a.id, "p0"),
  );
  assert.equal(r.security.find((e) => e.port === "p1").violations, 1);
  assert.equal(
    r.mac.find((e) => e.mac === interfaceMac(a.id, "p0")).port,
    "p0",
  );
});
test("configured secure addresses reserve capacity and persist; transient states never serialize", () => {
  const { t, a, s, r, send } = setup();
  s.ports[0].security.addresses = ["020000000001"];
  assert.equal(send().length, 0);
  assert.equal(r.security[0].shutdown, true);
  const text = serializeTopology(t),
    parsed = parseTopology(text);
  assert.deepEqual(parsed.devices[1].ports[0].security, s.ports[0].security);
  assert.ok(!text.includes("violations"));
  assert.deepEqual(
    reloadDevice(saveStartup(s)).ports[0].security,
    s.ports[0].security,
  );
  resetRuntime(r, t);
  assert.equal(r.security.length, 0);
});
test("malformed/unsupported-VLAN/host/duplicate/static-conflicting security imports reject atomically", () => {
  for (const change of [
    (s) => (s.ports[0].security.maximum = 0),
    (s) => (s.ports[0].security.addresses = ["ffffffffffff"]),
    (s) => {
      s.ports[0].mode = "trunk";
      s.ports[0].allowedVlans = [20];
    },
    (s) =>
      (s.ports[1].security = {
        maximum: 1,
        violation: "restrict",
        addresses: ["020000000001"],
      }),
    (s) => (s.staticMac = [{ mac: "020000000001", vlan: 1, port: "p1" }]),
  ]) {
    const { t, s } = setup();
    s.ports[0].security.addresses = ["020000000001"];
    change(s);
    assert.ok(configurationError(s));
    assert.throws(() => parseTopology(JSON.stringify(t)));
  }
  const { t, a } = setup();
  a.ports[0].security = { maximum: 1, violation: "protect", addresses: [] };
  assert.throws(() => parseTopology(JSON.stringify(t)));
});
test("CLI configures actual security, rejects invalid capacity, shows and removes configuration", () => {
  let t = exampleTopology(),
    session = { mode: "config", portId: null };
  const id = t.devices[1].id,
    r = createRuntime();
  const run = (line) => {
    const out = command(t, id, session, line, r);
    t = out.topology;
    session = out.session;
    return out;
  };
  run("interface GigabitEthernet0/0");
  assert.equal(run("switchport port-security").changed, true);
  assert.equal(run("switchport port-security maximum 0").changed, false);
  run("switchport port-security violation restrict");
  run("switchport port-security mac-address 0200.0000.0001");
  run("end");
  assert.equal(ping(t, t.devices[0].id, t.devices[2].ports[0].ip, r).ok, false);
  assert.match(
    run("show port-security interface GigabitEthernet0/0").output,
    /violations: 1/,
  );
  assert.match(run("show running-config").output, /switchport port-security/);
  run("configure terminal");
  run("interface GigabitEthernet0/0");
  run("no switchport port-security");
  assert.equal(ping(t, t.devices[0].id, t.devices[2].ports[0].ip, r).ok, true);
});
import { servicesLab } from "../src/network-studio/labs.ts";
import { requestDhcp } from "../src/network-studio/services.ts";
import { ping6 } from "../src/network-studio/ipv6Engine.ts";
test("IPv6 and DHCP use secure ingress and shutdown without bypasses", () => {
  const { t, a, s, b, r } = setup("restrict");
  a.ports[0].ipv6 = "2001:db8::10";
  b.ports[0].ipv6 = "2001:db8::20";
  a.ports[0].prefix6 = b.ports[0].prefix6 = 64;
  s.ports[0].security.addresses = ["020000000001"];
  assert.equal(ping6(t, a.id, "2001:db8::20", undefined, r).ok, false);
  delete s.ports[0].security;
  assert.equal(ping6(t, a.id, "2001:db8::20", undefined, r).ok, true);
  const dhcp = servicesLab(),
    runtime = createRuntime();
  dhcp.devices[1].ports[0].security = {
    maximum: 1,
    violation: "shutdown",
    addresses: ["020000000001"],
  };
  const denied = requestDhcp(dhcp, dhcp.devices[0].id, undefined, runtime);
  assert.equal(denied.ok, false);
  assert.equal(runtime.security[0].shutdown, true);
  assert.equal(dhcp.devices[3].services.dhcp.leases.length, 0);
});
test("global dynamic secure resource bound fails closed without evicting existing bindings", () => {
  const { r, send } = setup("restrict");
  r.security = Array.from({ length: 32 }, (_, i) => ({
    device: "other",
    port: String(i),
    addresses: Array.from(
      { length: 128 },
      (_, j) => `02${(i * 128 + j).toString(16).padStart(10, "0")}`,
    ),
    violations: 0,
    shutdown: false,
    lastSource: "",
  }));
  assert.equal(send().length, 0);
  assert.equal(
    r.security.reduce((n, e) => n + e.addresses.length, 0),
    4096,
  );
  assert.equal(r.security.at(-1).violations, 1);
});
test("a source on an unsecured port cannot move a reserved secure destination entry", () => {
  const { a, b, r, send, t } = setup("restrict");
  send();
  transmitFrame(
    t,
    { device: b.id, port: "p0" },
    "ffffffffffff",
    r,
    interfaceMac(a.id, "p0"),
  );
  assert.equal(
    r.mac.find((e) => e.mac === interfaceMac(a.id, "p0")).port,
    "p0",
  );
});
test("absolute secure aging expires at the exact boundary despite active source traffic", () => {
  const { t, a, s, r, send } = setup("restrict");
  s.ports[0].security.agingMinutes = 1;
  s.ports[0].security.agingType = "absolute";
  send();
  advanceRuntime(r, t, 59);
  send();
  advanceRuntime(r, t, 1);
  assert.equal(r.security[0].addresses.length, 0);
  assert.ok(!r.mac.some((e) => e.mac === interfaceMac(a.id, "p0")));
  assert.ok(send("020000000001").length > 0);
});
test("inactivity secure aging refreshes only source activity and never ages configured addresses", () => {
  const { t, a, b, s, r, send } = setup("restrict");
  s.ports[0].security.maximum = 2;
  s.ports[0].security.addresses = ["020000000001"];
  s.ports[0].security.agingMinutes = 1;
  s.ports[0].security.agingType = "inactivity";
  send();
  advanceRuntime(r, t, 59);
  send();
  advanceRuntime(r, t, 59);
  transmitFrame(t, { device: b.id, port: "p0" }, interfaceMac(a.id, "p0"), r);
  advanceRuntime(r, t, 1);
  assert.equal(r.security[0].addresses.length, 0);
  assert.deepEqual(s.ports[0].security.addresses, ["020000000001"]);
  assert.ok(send("020000000001").length > 0);
});
test("secure aging does not recover a latched security shutdown", () => {
  const { t, s, r, send } = setup();
  s.ports[0].security.agingMinutes = 1;
  send();
  send("020000000001");
  advanceRuntime(r, t, 60);
  assert.equal(r.security[0].addresses.length, 0);
  assert.equal(r.security[0].shutdown, true);
  assert.equal(send().length, 0);
});
test("secure aging CLI and persistence validate minutes/types and preserve startup", () => {
  let t = exampleTopology(),
    session = { mode: "interface", portId: "p0" };
  const id = t.devices[1].id,
    r = createRuntime();
  const run = (line) => {
    const o = command(t, id, session, line, r);
    t = o.topology;
    session = o.session;
    return o;
  };
  run("switchport port-security");
  assert.equal(run("switchport port-security aging time 1").changed, true);
  assert.equal(
    run("switchport port-security aging type inactivity").changed,
    true,
  );
  assert.equal(run("switchport port-security aging time 1441").changed, false);
  assert.equal(
    run("switchport port-security aging type invalid").changed,
    false,
  );
  const parsed = parseTopology(serializeTopology(t));
  assert.equal(
    reloadDevice(saveStartup(parsed.devices[1])).ports[0].security.agingType,
    "inactivity",
  );
  run("end");
  assert.match(run("show port-security").output, /1 minutes inactivity/);
  run("configure terminal");
  run("interface GigabitEthernet0/0");
  assert.equal(run("no switchport port-security aging time").changed, true);
  assert.equal(t.devices[1].ports[0].security.agingMinutes, 0);
});

test("configured secure addresses release capacity at the absolute deadline and reload from startup", () => {
  const { t, a, s, r, send } = setup("restrict");
  const port = s.ports[0],
    configured = interfaceMac(a.id, "p0"),
    other = "020000000001";
  Object.assign(port.security, {
    addresses: [configured],
    ageStatic: true,
    agingMinutes: 1,
  });
  t.devices[1] = saveStartup(s);
  assert.ok(send().length);
  advanceRuntime(r, t, 59);
  assert.ok(send().length);
  assert.equal(send(other).length, 0);
  advanceRuntime(r, t, 1);
  assert.equal(secureDestination(s, port.vlan, configured, r), undefined);
  assert.ok(!r.mac.some((e) => e.mac === configured));
  assert.ok(send(other).length);
  const result = command(
    t,
    s.id,
    { mode: "privileged" },
    "show running-config",
    r,
  );
  assert.ok(result.changed && result.preserveRuntime);
  assert.match(result.output, /switchport port-security aging static/);
  assert.ok(!result.output.includes("mac-address " + configured));
  const [, saved] = parseTopology(serializeTopology(result.topology)).devices;
  assert.deepEqual(saved.ports[0].security.addresses, []);
  assert.deepEqual(reloadDevice(saved).ports[0].security.addresses, [
    configured,
  ]);
  assert.deepEqual(port.security.addresses, [configured]);
});

test("inactivity timers for static, sticky and tagged bindings are independent", () => {
  const { t, a, b, s, r, send } = setup("restrict");
  const p = s.ports[0],
    active = interfaceMac(a.id, "p0"),
    sticky = "020000000002";
  p.voiceVlan = 20;
  Object.assign(p.security, {
    addresses: [active],
    ageStatic: true,
    agingMinutes: 1,
    agingType: "inactivity",
    maximum: 3,
    sticky: true,
    bindings: [
      { vlan: 20, mac: active, sticky: false },
      { vlan: 20, mac: sticky, sticky: true },
    ],
  });
  assert.ok(send().length);
  advanceRuntime(r, t, 45);
  assert.ok(send().length);
  advanceRuntime(r, t, 15);
  assert.equal(secureDestination(s, 20, active, r), undefined);
  assert.deepEqual(secureDestination(s, p.vlan, active, r), { port: p.id });
  transmitFrame(t, { device: b.id, port: "p0" }, active, r);
  advanceRuntime(r, t, 45);
  assert.equal(secureDestination(s, p.vlan, active, r), undefined);
  assert.deepEqual(secureDestination(s, 20, sticky, r), { port: p.id });
  const next = materializeSecurity(t, r);
  assert.deepEqual(next.devices[1].ports[0].security.bindings, [
    { vlan: 20, mac: sticky, sticky: true },
  ]);
});

test("CLI enables and disables static aging, and import rejects non-boolean settings", () => {
  const { t, s, r } = setup();
  const session = { mode: "interface", portId: "p0" };
  const on = command(
    t,
    s.id,
    session,
    "switchport port-security aging static",
    r,
  );
  assert.equal(on.topology.devices[1].ports[0].security.ageStatic, true);
  const display = command(
    on.topology,
    s.id,
    { mode: "privileged" },
    "show port-security interface GigabitEthernet0/0",
    r,
  );
  assert.match(display.output, /Static aging: Enabled/);
  const off = command(
    on.topology,
    s.id,
    session,
    "no switchport port-security aging static",
    r,
  );
  assert.equal(off.topology.devices[1].ports[0].security.ageStatic, false);
  s.ports[0].security.ageStatic = "yes";
  assert.throws(() => parseTopology(JSON.stringify(t)));
});
