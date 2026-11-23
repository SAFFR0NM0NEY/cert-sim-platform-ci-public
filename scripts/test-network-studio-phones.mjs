import assert from "node:assert/strict";
import { advanceWorkspaceClock } from "../src/network-studio/workspaceClock.ts";
import { test } from "node:test";
import { connect } from "../src/network-studio/model.ts";
import { officePhoneLab } from "../src/network-studio/labs.ts";
import {
  createRuntime,
  bindRuntime,
  adoptRuntime,
  advanceRuntime,
} from "../src/network-studio/networkRuntime.ts";
import { phoneVoiceVlan } from "../src/network-studio/discovery.ts";
import { interfaceMac, transmitFrame } from "../src/network-studio/ethernet.ts";
import { ping } from "../src/network-studio/engine.ts";
import { ping6 } from "../src/network-studio/ipv6Engine.ts";
import { requestDhcp, releaseDhcp } from "../src/network-studio/services.ts";
import {
  registerPhone,
  dialPhone,
  answerPhone,
  sendPhoneNote,
  hangUp,
  phoneManager,
} from "../src/network-studio/telephony.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
import {
  reloadDevice,
  saveStartup,
} from "../src/network-studio/deviceLifecycle.ts";
import { command } from "../src/network-studio/cli.ts";
function setup() {
  const t = officePhoneLab(),
    r = createRuntime();
  const [a, pc, sw, b, data, server, router] = t.devices;
  bindRuntime(r, t);
  return { t, r, a, pc, sw, b, data, server, router };
}
test("a phone on a voice VLAN provisions option 150 through a DHCP relay", () => {
  let { t, r, a, pc, server, router } = setup();
  t.links = t.links.filter(
    (l) => l.a.device !== server.id && l.b.device !== server.id,
  );
  server.ports[0].ip = "198.51.100.2";
  server.gateway = "198.51.100.1";
  router.ports[1].ip = server.gateway;
  router.ports[0].helperAddresses = [server.ports[0].ip];
  t = connect(
    t,
    { device: router.id, port: "p1" },
    { device: server.id, port: "p0" },
    "copper",
  );
  a.managerAddress = "";
  a.ports[0].ip = "";
  const result = requestDhcp(t, a.id, "p0", r);
  assert.equal(result.ok, true, result.message);
  const handset = result.topology.devices.find((d) => d.id === a.id);
  assert.equal(handset.ports[0].ip, "192.168.20.50");
  assert.equal(
    phoneManager(result.topology, handset),
    router.callManager.address,
  );
  assert.equal(requestDhcp(result.topology, pc.id).ok, false);
});
test("an expired voice lease clears option 150 and registration while keeping DHCP mode", () => {
  let { t, r, a, server } = setup();
  a.managerAddress = "";
  server.services.dhcp.pools[0].leaseSeconds = 80;
  t = requestDhcp(t, a.id, "p0", r).topology;
  t = advanceWorkspaceClock(r, t, 10);
  assert.ok(r.registrations.some((entry) => entry.phone === a.id));
  t.devices.find((d) => d.id === server.id).powered = false;
  t = advanceWorkspaceClock(r, t, 70);
  const phone = t.devices.find((d) => d.id === a.id);
  assert.equal(phone.ports[0].ip, "");
  assert.equal(phone.ports[0].addressMode, "dhcp");
  assert.equal(phoneManager(t, phone), "");
  assert.ok(!r.registrations.some((entry) => entry.phone === a.id));
});
test("direct neighbor discovery does not traverse the phone bridge or switch", () => {
  const { r, a, pc, sw, router } = setup();
  assert.deepEqual(
    r.neighbors
      .filter((n) => n.local.device === a.id)
      .map((n) => [n.protocol, n.name, n.voiceVlan]),
    [
      ["cdp", sw.name, 20],
      ["lldp", sw.name, 20],
    ],
  );
  assert.ok(
    r.neighbors.every(
      (n) => n.remote.device !== pc.id && n.local.device !== pc.id,
    ),
  );
  assert.equal(
    r.neighbors.filter((n) => n.local.device === router.id).length,
    1,
  );
});
test("LLDP and CDP hold times expire independently; disabling local receive flushes at once", () => {
  const { t, r, sw, a } = setup();
  const p = sw.ports[0];
  p.lldpTransmit = false;
  p.cdp = false;
  adoptRuntime(r, t);
  const entries = () => r.neighbors.filter((n) => n.local.device === a.id);
  advanceRuntime(r, t, 119);
  assert.equal(entries().length, 2);
  advanceRuntime(r, t, 1);
  assert.deepEqual(
    entries().map((n) => n.protocol),
    ["cdp"],
  );
  assert.equal(phoneVoiceVlan(t, a, r), 20);
  advanceRuntime(r, t, 60);
  assert.equal(phoneVoiceVlan(t, a, r), undefined);
  p.lldpTransmit = true;
  adoptRuntime(r, t);
  advanceRuntime(r, t, 29);
  assert.equal(entries().length, 0);
  advanceRuntime(r, t, 1);
  assert.equal(entries()[0].expires, 330);
  a.ports[0].lldpReceive = false;
  adoptRuntime(r, t);
  assert.equal(entries().length, 0);
  assert.ok(
    r.neighbors.some(
      (n) =>
        n.local.device === sw.id &&
        n.remote.device === a.id &&
        n.protocol === "lldp",
    ),
  );
});
test("a shutdown latch stops advertisements until recovery and a new interval", () => {
  const { t, r, sw, a } = setup();
  r.security.push({
    device: sw.id,
    port: "p0",
    addresses: [],
    violations: 1,
    shutdown: true,
    lastSource: "",
  });
  advanceRuntime(r, t, 180);
  assert.equal(phoneVoiceVlan(t, a, r), undefined);
  r.security = [];
  advanceRuntime(r, t, 60);
  assert.equal(phoneVoiceVlan(t, a, r), 20);
});
test("switch discovery CLI modifies direction and preserves hold time, configuration and startup", () => {
  const { t, r, sw } = setup();
  const next = command(
    t,
    sw.id,
    { mode: "interface", portId: "p0" },
    "no lldp transmit",
    r,
  );
  assert.equal(next.preserveRuntime, true);
  const show = (s) =>
    command(next.topology, sw.id, { mode: "privileged", portId: null }, s, r)
      .output;
  assert.match(show("show running-config"), /no lldp transmit/);
  assert.match(show("show lldp neighbors detail"), /IP Phone-1/);
  assert.equal(
    reloadDevice(saveStartup(next.topology.devices[2])).ports[0].lldpTransmit,
    false,
  );
});
test("voice and data share a secured port with distinct source MACs and VLANs", () => {
  const { t, r, a, pc, sw, b, data, server } = setup();
  assert.ok(ping(t, a.id, b.ports[0].ip, r).ok);
  assert.ok(ping(t, pc.id, data.ports[0].ip, r).ok);
  const identity = (device, vlan) =>
    r.mac.some(
      (m) =>
        m.device === sw.id &&
        m.port === "p0" &&
        m.mac === interfaceMac(device.id, "p0") &&
        m.vlan === vlan,
    );
  assert.ok(identity(a, 20));
  assert.ok(identity(pc, 10));
  assert.equal(
    r.security.find((s) => s.device === sw.id && s.port === "p0").addresses
      .length,
    2,
  );
  const voiceFlood = transmitFrame(
    t,
    { device: a.id, port: "p0" },
    "ffffffffffff",
    r,
  );
  assert.ok(voiceFlood.some((p) => p.device.id === server.id));
  assert.ok(!voiceFlood.some((p) => [pc.id, data.id].includes(p.device.id)));
  pc.ports[0].taggedVlan = 20;
  assert.deepEqual(
    transmitFrame(t, { device: pc.id, port: "p0" }, "ffffffffffff", r),
    [],
  );
});
test("untagged local PC and handset can exchange frames while a disabled PC jack stops forwarding", () => {
  const { t, r, a, pc, data, sw } = setup();
  delete sw.ports[0].voiceVlan;
  delete sw.ports[0].security;
  a.ports[0].ip = "192.168.10.44";
  assert.ok(ping(t, a.id, pc.ports[0].ip, r).ok);
  assert.ok(ping(t, pc.id, a.ports[0].ip, r).ok);
  a.ports[1].enabled = false;
  assert.equal(ping(t, pc.id, data.ports[0].ip, r).ok, false);
  assert.ok(ping(t, a.id, data.ports[0].ip, r).ok);
});
test("IPv6 voice traffic uses the learned VLAN and DHCP option 150 follows the lease", () => {
  const { t, r, a, b, pc, router } = setup();
  for (const [i, d] of [a, b, pc].entries())
    Object.assign(d.ports[0], { ipv6: "2001:db8:20::" + (i + 1), prefix6: 64 });
  assert.ok(ping6(t, a.id, b.ports[0].ipv6, undefined, r).ok);
  assert.equal(ping6(t, pc.id, b.ports[0].ipv6, undefined, r).ok, false);
  delete a.managerAddress;
  const lease = requestDhcp(t, a.id, "p0", r);
  assert.equal(lease.ok, true);
  const leased = lease.topology.devices[0];
  assert.equal(
    phoneManager(lease.topology, leased),
    router.callManager.address,
  );
  assert.ok(registerPhone(lease.topology, r, leased.id).ok);
  const released = releaseDhcp(lease.topology, a.id, "p0");
  assert.equal(
    phoneManager(released.topology, released.topology.devices[0]),
    "",
  );
  assert.equal(requestDhcp(t, a.id, "p1", r).ok, false);
});
test("local calls require registration, recognize busy/unknown numbers and only the callee can answer", () => {
  const { t, r, a, b } = setup();
  assert.equal(dialPhone(t, r, a.id, "1002").ok, false);
  assert.ok(registerPhone(t, r, a.id).ok);
  assert.match(dialPhone(t, r, a.id, "999").message, /Unknown/);
  assert.match(dialPhone(t, r, a.id, "1002").message, /unregistered/);
  assert.ok(registerPhone(t, r, b.id).ok);
  assert.match(dialPhone(t, r, a.id, "1001").message, /busy/);
  assert.ok(dialPhone(t, r, a.id, "1002").ok);
  assert.match(dialPhone(t, r, b.id, "1001").message, /busy/);
  assert.equal(answerPhone(t, r, a.id).ok, false);
  assert.equal(sendPhoneNote(t, r, a.id, "Do").ok, false);
  assert.ok(answerPhone(t, r, b.id).ok);
  const media = sendPhoneNote(t, r, b.id, "Mi");
  assert.ok(media.ok);
  assert.equal(media.events.at(-1).protocol, "RTP");
  assert.deepEqual(r.calls[0].lastNote, { to: a.id, note: "Mi" });
  assert.ok(hangUp(t, r, b.id).ok);
  assert.equal(r.calls.length, 0);
});
test("unanswered calls expire on the virtual clock; active calls persist past the ringing deadline", () => {
  const { t, r, a, b } = setup();
  registerPhone(t, r, a.id);
  registerPhone(t, r, b.id);
  dialPhone(t, r, a.id, "1002");
  advanceRuntime(r, t, 29);
  assert.equal(r.calls.length, 1);
  advanceRuntime(r, t, 1);
  assert.equal(r.calls.length, 0);
  dialPhone(t, r, a.id, "1002");
  answerPhone(t, r, b.id);
  advanceRuntime(r, t, 300);
  assert.equal(r.calls.length, 1);
});
test("manager authorization and operational media both gate calls", () => {
  const { t, r, a, b, sw, router } = setup();
  router.callManager.lines.shift();
  assert.match(registerPhone(t, r, a.id).message, /no directory line/);
  router.callManager.lines.push({
    mac: interfaceMac(a.id, "p0"),
    number: "1001",
  });
  registerPhone(t, r, a.id);
  registerPhone(t, r, b.id);
  dialPhone(t, r, a.id, "1002");
  answerPhone(t, r, b.id);
  r.security.push({
    device: sw.id,
    port: "p4",
    addresses: [],
    violations: 1,
    shutdown: true,
    lastSource: "",
  });
  assert.ok(sendPhoneNote(t, r, a.id, "Do").ok);
  r.security.find((s) => s.device === sw.id && s.port === "p1").shutdown = true;
  assert.equal(sendPhoneNote(t, r, a.id, "Re").ok, false);
  assert.equal(r.calls[0].lastNote.note, "Do");
});
test("only configuration persists, and invalid phone hardware, discovery and directory data are rejected", () => {
  const { t, r, a, router } = setup();
  registerPhone(t, r, a.id);
  const saved = serializeTopology(t);
  assert.doesNotMatch(saved, /registrations|neighbors|lastNote/);
  const roundTrip = parseTopology(saved);
  assert.deepEqual(roundTrip.devices[6].callManager, router.callManager);
  assert.deepEqual(
    reloadDevice(saveStartup(router)).callManager,
    router.callManager,
  );
  for (const edit of [
    (t) => t.devices[0].ports.pop(),
    (t) => (t.devices[0].ports[1].ip = "192.168.0.1"),
    (t) => (t.devices[0].ports[1].lldpTransmit = true),
    (t) => (t.devices[1].cdp = true),
    (t) => (t.devices[2].lldp = "yes"),
    (t) => (t.devices[6].callManager.lines[1].number = "1001"),
    (t) => (t.devices[6].callManager.lines[0].mac = "ffffffffffff"),
    (t) => (t.devices[5].services.dhcp.pools[0].tftp = "abc"),
  ]) {
    const bad = structuredClone(t);
    edit(bad);
    assert.throws(() => parseTopology(JSON.stringify(bad)));
  }
});
test("timed security recovery clears only the failed port and allows another violation", () => {
  const { t, r, sw, a, pc, b } = setup();
  const p = sw.ports[0];
  p.security = {
    maximum: 2,
    violation: "shutdown",
    addresses: [],
    bindings: [{ vlan: 20, mac: interfaceMac(a.id, "p0"), sticky: true }],
  };
  sw.securityRecovery = { enabled: true, interval: 60 };
  const origin = { device: pc.id, port: "p0" };
  const send = (mac) => transmitFrame(t, origin, "ffffffffffff", r, mac);
  send();
  send("020000000001");
  assert.equal(
    r.security.find((x) => x.device === sw.id && x.port === "p0").shutdown,
    true,
  );
  transmitFrame(t, { device: b.id, port: "p0" }, "ffffffffffff", r);
  const other = r.security.find((x) => x.port === "p1");
  advanceRuntime(r, t, 59);
  assert.match(
    command(
      t,
      sw.id,
      { mode: "privileged", portId: null },
      "show errdisable recovery",
      r,
    ).output,
    /1s remaining/,
  );
  advanceRuntime(r, t, 1);
  assert.ok(!r.security.some((x) => x.port === "p0"));
  assert.ok(r.security.includes(other));
  assert.equal(p.security.bindings.length, 1);
  send();
  send("020000000001");
  assert.equal(r.security.find((x) => x.port === "p0").shutdownAt, 60);
});
test("recovery CLI enables a running outage timer, disabling preserves shutdown, file bounds are validated", () => {
  let { t, r, sw, a } = setup();
  const p = sw.ports[0];
  p.security = {
    maximum: 1,
    violation: "shutdown",
    addresses: [],
    bindings: [{ vlan: 20, mac: interfaceMac(a.id, "p0"), sticky: false }],
  };
  transmitFrame(
    t,
    { device: a.id, port: "p0" },
    "ffffffffffff",
    r,
    "020000000001",
  );
  const configure = (line) => {
    const out = command(t, sw.id, { mode: "config", portId: null }, line, r);
    t = out.topology;
    return out;
  };
  advanceRuntime(r, t, 15);
  assert.equal(
    configure("errdisable recovery cause psecure-violation").preserveRuntime,
    true,
  );
  configure("errdisable recovery interval 30");
  assert.equal(configure("errdisable recovery interval 29").changed, false);
  configure("no errdisable recovery cause psecure-violation");
  advanceRuntime(r, t, 45);
  assert.ok(r.security[0].shutdown);
  configure("errdisable recovery cause psecure-violation");
  advanceRuntime(r, t, 0);
  assert.ok(!r.security.some((s) => s.shutdown));
  const saved = parseTopology(serializeTopology(t)).devices[2];
  assert.deepEqual(reloadDevice(saveStartup(saved)).securityRecovery, {
    enabled: true,
    interval: 30,
  });
  configure("no errdisable recovery interval");
  assert.equal(t.devices[2].securityRecovery.interval, 300);
});
test("discovery after a clock jump cannot advertise retroactively while the switch was shut down", () => {
  const { t, r, sw, a } = setup();
  sw.securityRecovery = { enabled: true, interval: 185 };
  bindRuntime(r, t);
  r.security.push({
    device: sw.id,
    port: "p0",
    addresses: [],
    violations: 1,
    shutdown: true,
    shutdownAt: 0,
    lastSource: "",
  });
  advanceRuntime(r, t, 200);
  assert.equal(phoneVoiceVlan(t, a, r), undefined);
  advanceRuntime(r, t, 10);
  assert.ok(
    r.neighbors.some(
      (n) =>
        n.local.device === a.id &&
        n.remote.device === sw.id &&
        n.protocol === "lldp" &&
        n.received === 210,
    ),
  );
});
test("virtual boot provisions two DHCP phones through option 150 and registers only at the retry deadline", () => {
  const { t, r, a, b, router } = setup();
  for (const phone of [a, b]) {
    phone.ports[0].ip = "";
    phone.ports[0].addressMode = "dhcp";
    delete phone.managerAddress;
  }
  assert.equal(advanceWorkspaceClock(r, t, 9), t);
  assert.equal(r.registrations.length, 0);
  const after = advanceWorkspaceClock(r, t, 1);
  assert.notEqual(after, t);
  assert.equal(a.ports[0].ip, "");
  assert.equal(r.registrations.length, 2);
  assert.deepEqual(
    after.devices[5].services.dhcp.leases.map((l) => l.tftp),
    [router.callManager.address, router.callManager.address],
  );
  assert.ok(dialPhone(after, r, a.id, "1002").ok);
  assert.ok(answerPhone(after, r, b.id).ok);
  assert.equal(
    parseTopology(serializeTopology(after)).devices[0].ports[0].ip,
    "192.168.20.50",
  );
  advanceWorkspaceClock(r, after, 30);
  assert.equal(r.calls[0].state, "connected");
  assert.equal(r.phoneChecks.get(a.id).missed, 0);
});
test("failed automatic registration retries after recovery, and two missed keepalives release a connected call", () => {
  const { t, r, a, b, sw } = setup();
  const block = {
    device: sw.id,
    port: "p4",
    addresses: [],
    violations: 1,
    shutdown: true,
    shutdownAt: 0,
    lastSource: "",
  };
  r.security.push(block);
  advanceWorkspaceClock(r, t, 10);
  assert.equal(r.registrations.length, 0);
  assert.equal(r.phoneChecks.get(a.id).next, 20);
  r.security = r.security.filter((s) => s !== block);
  advanceWorkspaceClock(r, t, 9);
  assert.equal(r.registrations.length, 0);
  advanceWorkspaceClock(r, t, 1);
  assert.equal(r.registrations.length, 2);
  dialPhone(t, r, a.id, "1002");
  answerPhone(t, r, b.id);
  r.security.push(block);
  advanceWorkspaceClock(r, t, 30);
  assert.equal(r.phoneChecks.get(a.id).missed, 1);
  assert.equal(r.calls.length, 1);
  advanceWorkspaceClock(r, t, 29);
  assert.equal(r.registrations.length, 2);
  advanceWorkspaceClock(r, t, 1);
  assert.equal(r.calls.length, 0);
  assert.equal(r.registrations.length, 0);
  r.security = r.security.filter((s) => s !== block);
  advanceWorkspaceClock(r, t, 10);
  assert.equal(r.registrations.length, 2);
});
test("powered-off phones and a static addressless phone cannot acquire an automatic lease", () => {
  const { t, r, a, b } = setup();
  a.ports[0].ip = "";
  a.ports[0].addressMode = "static";
  b.powered = false;
  assert.equal(advanceWorkspaceClock(r, t, 100), t);
  assert.equal(r.registrations.length, 0);
  assert.equal(r.phoneChecks.has(b.id), false);
  assert.equal(t.devices[5].services.dhcp.leases.length, 0);
});
