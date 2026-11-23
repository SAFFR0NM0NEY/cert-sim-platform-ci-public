import assert from "node:assert/strict";
import { test } from "node:test";
import {
  exampleTopology,
  connect,
  createDevice,
} from "../src/network-studio/model.ts";
import {
  createRuntime,
  advanceRuntime,
} from "../src/network-studio/networkRuntime.ts";
import { interfaceMac, transmitFrame } from "../src/network-studio/ethernet.ts";
import { ping } from "../src/network-studio/engine.ts";
import { ping6 } from "../src/network-studio/ipv6Engine.ts";
import { redundantLab, servicesLab } from "../src/network-studio/labs.ts";
import { requestDhcp } from "../src/network-studio/services.ts";
import { command, INITIAL_CLI } from "../src/network-studio/cli.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
test("unknown unicast floods, source learns, reply learns and subsequent known unicast chooses one port", () => {
  const t = exampleTopology(),
    [a, s, b] = t.devices,
    r = createRuntime(),
    from = { device: a.id, port: a.ports[0].id },
    to = { device: b.id, port: b.ports[0].id };
  transmitFrame(t, from, interfaceMac(b.id, to.port), r);
  assert.equal(r.frames.at(-1).action, "flood");
  assert.equal(r.mac.length, 1);
  transmitFrame(t, to, interfaceMac(a.id, from.port), r);
  assert.equal(r.frames.at(-1).action, "forward");
  assert.equal(r.mac.length, 2);
  transmitFrame(t, from, interfaceMac(b.id, to.port), r);
  assert.equal(r.frames.at(-1).action, "forward");
  assert.deepEqual(r.frames.at(-1).egress, [s.ports[1].id]);
  transmitFrame(t, from, interfaceMac(a.id, from.port), r);
  assert.equal(r.frames.at(-1).action, "filter");
});
test("learned entries age at their exact virtual boundary and traffic refreshes only its source", () => {
  const t = exampleTopology(),
    [a, s, b] = t.devices,
    r = createRuntime();
  s.macAgingSeconds = 20;
  const send = (d) =>
    transmitFrame(t, { device: d.id, port: d.ports[0].id }, "ffffffffffff", r);
  send(a);
  advanceRuntime(r, t, 10);
  send(b);
  advanceRuntime(r, t, 9);
  assert.equal(r.mac.length, 2);
  advanceRuntime(r, t, 1);
  assert.equal(r.mac.length, 1);
  assert.equal(r.mac[0].mac, interfaceMac(b.id, b.ports[0].id));
  advanceRuntime(r, t, 10);
  assert.equal(r.mac.length, 0);
});
test("MAC moves are learned on new ingress; VLANs and STP constrain forwarding", () => {
  let t = exampleTopology();
  const [a, s, b] = t.devices,
    r = createRuntime(),
    aMac = interfaceMac(a.id, "p0");
  transmitFrame(t, { device: a.id, port: "p0" }, "ffffffffffff", r);
  transmitFrame(t, { device: b.id, port: "p0" }, "ffffffffffff", r, aMac);
  assert.equal(r.mac[0].port, "p1");
  s.ports[1].vlan = 10;
  transmitFrame(t, { device: b.id, port: "p0" }, "ffffffffffff", r, aMac);
  assert.equal(r.mac[0].vlan, 10); // config fingerprint flushes stale learning
  t = redundantLab();
  const rr = createRuntime();
  ping(t, t.devices[0].id, t.devices[1].ports[0].ip, rr);
  assert.equal(
    rr.mac.some((e) => e.device === t.devices[4].id && e.port === "p2"),
    false,
  );
});
test("IPv4, IPv6 and DHCP operations populate real MAC state without serializing learned data", () => {
  const t = redundantLab(),
    r = createRuntime();
  assert.equal(ping(t, t.devices[0].id, t.devices[1].ports[0].ip, r).ok, true);
  assert.ok(r.mac.length > 0);
  r.mac = [];
  assert.equal(
    ping6(t, t.devices[0].id, t.devices[1].ports[0].ipv6, undefined, r).ok,
    true,
  );
  assert.ok(r.mac.length > 0);
  const services = servicesLab(),
    dhcp = createRuntime();
  assert.equal(
    requestDhcp(services, services.devices[0].id, undefined, dhcp).ok,
    true,
  );
  assert.ok(dhcp.mac.length > 0);
  const json = serializeTopology(t);
  assert.equal("mac" in JSON.parse(json), false);
  assert.equal(parseTopology(json).devices.length, t.devices.length);
});
test("link changes invalidate stale tables and a disconnected ingress cannot learn", () => {
  const t = exampleTopology(),
    [a, s] = t.devices,
    r = createRuntime();
  ping(t, a.id, t.devices[2].ports[0].ip, r);
  s.ports[0].enabled = false;
  transmitFrame(t, { device: a.id, port: "p0" }, "ffffffffffff", r);
  assert.equal(r.mac.length, 0);
  assert.equal(r.frames.length, 0);
});
test("CLI MAC tables show learned interfaces and privileged clear/config affect actual runtime", () => {
  let t = exampleTopology();
  const r = createRuntime(),
    id = t.devices[1].id;
  ping(t, t.devices[0].id, t.devices[2].ports[0].ip, r);
  let session = INITIAL_CLI;
  const run = (line) => {
    const out = command(t, id, session, line, r);
    session = out.session;
    t = out.topology;
    return out;
  };
  assert.match(run("show mac address-table").output, /DYNAMIC/);
  run("enable");
  run("clear mac address-table dynamic");
  assert.equal(r.mac.length, 0);
  run("configure terminal");
  assert.equal(run("mac address-table aging-time 15").changed, true);
  assert.equal(run("mac address-table aging-time 1").changed, false);
  assert.equal(t.devices[1].macAgingSeconds, 15);
});
test("static MAC entries override dynamic forwarding, survive clear/aging and support disabled aging", () => {
  const t = exampleTopology(),
    [a, s, b] = t.devices,
    r = createRuntime(),
    mac = interfaceMac(b.id, "p0");
  s.staticMac = [{ vlan: 1, mac, port: "p3" }];
  assert.equal(ping(t, a.id, b.ports[0].ip, r).ok, false);
  s.staticMac[0].port = "p1";
  assert.equal(ping(t, a.id, b.ports[0].ip, r).ok, true);
  assert.equal(
    r.mac.some((e) => e.mac === mac),
    false,
  );
  s.macAgingSeconds = 0;
  ping(t, a.id, b.ports[0].ip, r);
  advanceRuntime(r, t, 86400);
  assert.ok(r.mac.length > 0);
  const copy = parseTopology(serializeTopology(t));
  assert.deepEqual(copy.devices[1].staticMac, s.staticMac);
  let session = { mode: "privileged", portId: null };
  let result = command(t, s.id, session, "clear mac address-table dynamic", r);
  assert.equal(r.mac.length, 0);
  assert.match(
    command(t, s.id, session, "show mac address-table", r).output,
    /STATIC/,
  );
  assert.match(
    command(t, s.id, session, "show mac address-table dynamic", r).output,
    /No learned/,
  );
});
test("static MAC imports reject multicast, missing interfaces and duplicate VLAN/MAC keys", () => {
  const t = exampleTopology(),
    [a, s] = t.devices,
    mac = interfaceMac(a.id, "p0");
  for (const entries of [
    [{ mac: "ffffffffffff", vlan: 1, port: "p0" }],
    [{ mac, vlan: 1, port: "missing" }],
    [
      { mac, vlan: 1, port: "p0" },
      { mac, vlan: 1, port: "p1" },
    ],
  ]) {
    const wire = JSON.parse(serializeTopology(t));
    wire.devices[1].staticMac = entries;
    assert.throws(() => parseTopology(JSON.stringify(wire)));
  }
  let session = { mode: "config", portId: null },
    next = t;
  const run = (line) => {
    const result = command(next, s.id, session, line);
    next = result.topology;
    session = result.session;
    return result;
  };
  assert.equal(
    run(`mac address-table static ${mac} vlan 1 interface ${s.ports[0].name}`)
      .changed,
    true,
  );
  assert.equal(next.devices[1].staticMac.length, 1);
  run(`no mac address-table static ${mac} vlan 1`);
  assert.equal(next.devices[1].staticMac.length, 0);
});
test("warm ARP skips request and reply frames but still enforces port security", () => {
  const t = exampleTopology(),
    [a, sw, b] = t.devices,
    r = createRuntime();
  sw.ports[1].security = { maximum: 1, violation: "shutdown", addresses: [] };
  const send = () => ping(t, a.id, b.ports[0].ip, r);
  assert.equal(send().events.filter((e) => e.protocol === "ARP").length, 4);
  assert.equal(r.addressBindings.length, 2);
  r.frames = [];
  const warm = send();
  assert.ok(warm.ok);
  assert.equal(warm.events.filter((e) => e.protocol === "ARP").length, 0);
  assert.ok(!r.frames.some((f) => f.destination === "ffffffffffff"));
  assert.match(
    command(t, a.id, INITIAL_CLI, "arp -a", r).output,
    new RegExp(interfaceMac(b.id, "p0")),
  );
  transmitFrame(
    t,
    { device: b.id, port: "p0" },
    "ffffffffffff",
    r,
    "020000000001",
  );
  assert.equal(send().ok, false);
});
test("ARP cache per-device clear and expiry return actual discovery events", () => {
  const t = exampleTopology(),
    [a, , b] = t.devices,
    r = createRuntime();
  const send = () =>
    ping(t, a.id, b.ports[0].ip, r).events.filter((e) => e.protocol === "ARP");
  send();
  command(t, a.id, INITIAL_CLI, "clear arp-cache", r);
  assert.equal(r.addressBindings.length, 1);
  assert.equal(send().length, 2);
  advanceRuntime(r, t, 14399);
  assert.equal(send().length, 0);
  advanceRuntime(r, t, 1);
  assert.equal(r.addressBindings.length, 0);
  assert.equal(send().length, 4);
  assert.doesNotMatch(serializeTopology(t), /addressBindings/);
});
test("link-local cache identities include interface scope and equivalent IPv6 spellings match", () => {
  const r = createDevice("router", 1),
    a = createDevice("pc", 1),
    b = createDevice("pc", 2),
    cache = createRuntime();
  r.ports[0].ipv6 = r.ports[1].ipv6 = "fe80::a";
  a.ports[0].ipv6 = b.ports[0].ipv6 = "fe80::b";
  let t = { version: 1, name: "Scoped cache", devices: [r, a, b], links: [] };
  for (const [i, host] of [a, b].entries())
    t = connect(
      t,
      { device: r.id, port: "p" + i },
      { device: host.id, port: "p0" },
      "copper",
    );
  const send = (ip, port) => ping6(t, r.id, ip, port, cache);
  assert.ok(send("fe80::b", "p0").ok);
  assert.ok(send("fe80::b", "p1").ok);
  const entries = cache.addressBindings.filter((e) => e.device === r.id);
  assert.equal(entries.length, 2);
  assert.notEqual(entries[0].mac, entries[1].mac);
  assert.ok(
    !send("fe80:0:0:0:0:0:0:b", "p0").events.some((e) => e.protocol === "NDP"),
  );
  advanceRuntime(cache, t, 30);
  assert.equal(cache.addressBindings.length, 0);
  assert.ok(send("fe80::b", "p1").events.some((e) => e.protocol === "NDP"));
});
