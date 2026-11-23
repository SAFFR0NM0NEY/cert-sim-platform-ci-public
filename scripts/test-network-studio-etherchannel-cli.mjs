import assert from "node:assert/strict";
import { test } from "node:test";
import { command, prompt } from "../src/network-studio/cli.ts";
import { interfaceRange } from "../src/network-studio/etherChannelCli.ts";
import { channelState } from "../src/network-studio/etherChannel.ts";
import {
  blankTopology,
  createDevice,
  connect,
} from "../src/network-studio/model.ts";
import { createRuntime } from "../src/network-studio/networkRuntime.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";

function setup() {
  const a = createDevice("switch", 1),
    b = createDevice("switch", 2);
  let topology = { ...blankTopology(), devices: [a, b] };
  for (const port of ["p0", "p1"])
    topology = connect(
      topology,
      { device: a.id, port },
      { device: b.id, port },
      "copper",
    );
  const sessions = new Map(),
    runtime = createRuntime();
  return {
    a,
    b,
    runtime,
    get topology() {
      return topology;
    },
    device(id = a.id) {
      return topology.devices.find((d) => d.id === id);
    },
    session(id = a.id) {
      return sessions.get(id);
    },
    run(input, id = a.id, error = false) {
      const result = command(
        topology,
        id,
        sessions.get(id) ?? { mode: "user", portId: null },
        input,
        runtime,
      );
      topology = result.topology;
      sessions.set(id, result.session);
      if (error) assert.match(result.output, /^%/, input);
      else
        assert.ok(!result.output.startsWith("%"), input + ": " + result.output);
      return result;
    },
    config(id = a.id) {
      this.run("enable", id);
      this.run("configure terminal", id);
    },
    bundle(mode = "active", group = 1, id = a.id) {
      this.config(id);
      this.run("interface range Gi0/0 - 1", id);
      this.run(`channel-group ${group} mode ${mode}`, id);
      this.run("end", id);
    },
  };
}

test("interface ranges resolve abbreviations, explicit endpoints and commas with bounded validation", () => {
  const d = createDevice("switch", 1);
  assert.deepEqual(interfaceRange(d, "Gi0/0 - GigabitEthernet0/1, Gi0/1"), [
    "p0",
    "p1",
  ]);
  assert.throws(() => interfaceRange(d, "Gi0/1 - 0"), /ascending/);
  assert.throws(() => interfaceRange(d, "Gi0/0 - 1000000000"), /32/);
  assert.throws(() => interfaceRange(d, "Gi0/0 - Gi1/1"), /prefix/);
  assert.throws(() => interfaceRange(d, "Gi0/0, Gi0/99"), /Unknown/);
  assert.throws(() => interfaceRange(d, "Po1"), /physical/);
});

test("CLI builds LACP on a range, permits different local group IDs and reports logical interfaces", () => {
  const c = setup();
  c.bundle("active", 1);
  c.bundle("passive", 2, c.b.id);
  assert.equal(channelState(c.topology, c.a.id, 1).up, true);
  assert.match(
    c.run("show etherchannel summary").output,
    /Po1\(SU\).*LACP.*GigabitEthernet0\/0\(P\).*GigabitEthernet0\/1\(P\)/,
  );
  assert.match(c.run("show lacp neighbor").output, /passive\s+2/);
  assert.match(c.run("show etherchannel 1 detail").output, /Active members: 2/);
  assert.match(c.run("show interfaces po1").output, /Port-channel1 is up/);
  c.run("configure terminal");
  c.run("interface range Gi0/0-1");
  assert.match(prompt(c.device(), c.session()), /config-if-range/);
  c.run("exit");
  assert.equal(c.session().portIds, undefined);
  c.run("interface Po1");
  assert.match(prompt(c.device(), c.session()), /config-if\)#/);
});

test("CLI PAgP and static groups use matching protocol families and show neighbors", () => {
  for (const [local, remote, protocol] of [
    ["desirable", "auto", "PAgP"],
    ["on", "on", "static"],
  ]) {
    const c = setup();
    c.bundle(local);
    c.bundle(remote, 1, c.b.id);
    assert.equal(channelState(c.topology, c.a.id, 1).up, true);
    assert.match(
      c.run("show etherchannel detail").output.toLowerCase(),
      new RegExp(protocol.toLowerCase()),
    );
    if (local === "desirable")
      assert.match(c.run("show pagp neighbors").output, /auto/);
  }
});

test("passive/passive and auto/auto do not claim negotiated neighbors", () => {
  for (const [mode, protocol] of [
    ["passive", "lacp"],
    ["auto", "pagp"],
  ]) {
    const c = setup();
    c.bundle(mode);
    c.bundle(mode, 1, c.b.id);
    assert.equal(channelState(c.topology, c.a.id, 1).up, false);
    assert.match(
      c.run(`show ${protocol} neighbor`).output,
      /No negotiated neighbors/,
    );
    c.run("configure terminal");
    c.run("interface range Gi0/0 - 1");
    c.run(
      `channel-group 1 mode ${mode === "passive" ? "active" : "desirable"}`,
    );
    assert.equal(channelState(c.topology, c.a.id, 1).up, true);
  }
});

test("aggregate VLAN edits propagate while a physical mismatch only excludes that member", () => {
  const c = setup();
  c.bundle();
  c.bundle("passive", 1, c.b.id);
  c.run("configure terminal");
  c.run("interface Port-channel 1");
  c.run("switchport mode trunk");
  c.run("switchport trunk allowed vlan 1,10");
  assert.ok(
    c
      .device()
      .ports.filter((p) => p.channelGroup)
      .every((p) => p.mode === "trunk" && p.allowedVlans.includes(10)),
  );
  c.run("interface Gi0/0");
  c.run("switchport mode access");
  assert.equal(
    c.device().ports.find((p) => p.virtual?.kind === "portchannel").mode,
    "trunk",
  );
  assert.notEqual(
    channelState(c.topology, c.a.id, 1).members.find((m) => m.port === "p0")
      .status,
    "bundled",
  );
  c.run("end");
  assert.match(
    c.run("show interfaces po1 switchport").output,
    /Administrative Mode: trunk/,
  );
});

test("range failure leaves every member and protection runtime unchanged", () => {
  const c = setup();
  c.config();
  c.run("interface Gi0/1");
  c.run("switchport port-security");
  c.run("interface range Gi0/0-1");
  const before = serializeTopology(c.topology),
    protection = structuredClone(c.runtime.bpduPorts);
  c.run("channel-group 1 mode active", c.a.id, true);
  assert.equal(serializeTopology(c.topology), before);
  assert.deepEqual(c.runtime.bpduPorts, protection);
  assert.ok(
    c
      .device()
      .ports.every((p) => !p.channelGroup && p.virtual?.kind !== "portchannel"),
  );
});

test("membership rejects protocol conflicts and security without committing partial state", () => {
  const c = setup();
  c.config();
  c.run("interface range Gi0/0-1");
  c.run("channel-protocol lacp");
  const before = serializeTopology(c.topology);
  c.run("channel-group 1 mode desirable", c.a.id, true);
  assert.equal(serializeTopology(c.topology), before);
  c.run("channel-group 1 mode active");
  c.run("switchport port-security", c.a.id, true);
  c.run("channel-protocol pagp", c.a.id, true);
  c.run("interface Po1");
  c.run("switchport port-security", c.a.id, true);
  c.run("cdp enable", c.a.id, true);
});

test("hash, membership and logical configuration survive JSON and startup reload without repairing mismatches", () => {
  const c = setup();
  c.bundle();
  c.run("configure terminal");
  c.run("port-channel load-balance src-dst-mac");
  c.run("interface Gi0/0");
  c.run("switchport mode trunk");
  c.run("end");
  c.run("write memory");
  const saved = structuredClone(c.device().ports);
  const round = parseTopology(serializeTopology(c.topology));
  assert.deepEqual(round.devices[0].ports, saved);
  assert.equal(round.devices[0].etherChannelLoadBalance, "src-dst-mac");
  c.run("configure terminal");
  c.run("interface Po1");
  c.run("switchport mode trunk");
  c.run("no port-channel load-balance");
  c.run("end");
  c.run("reload");
  assert.deepEqual(c.device().ports, saved);
  assert.equal(c.device().etherChannelLoadBalance, "src-dst-mac");
  c.run("enable");
  const running = c.run("show running-config").output;
  assert.match(running, /channel-group 1 mode active/);
  assert.match(running, /interface Port-channel1/);
  assert.match(running, /port-channel load-balance src-dst-mac/);
});

test("removing members retains an empty aggregate and removing the aggregate releases cables", () => {
  const c = setup();
  c.bundle();
  c.run("configure terminal");
  c.run("interface range Gi0/0-1");
  c.run("no channel-group");
  assert.equal(channelState(c.topology, c.a.id, 1).members.length, 0);
  c.run("channel-group 1 mode active");
  c.run("no interface Port-channel1");
  assert.ok(
    c
      .device()
      .ports.every((p) => !p.channelGroup && p.virtual?.kind !== "portchannel"),
  );
  assert.equal(c.topology.links.length, 2);
  assert.equal(c.session().mode, "config");
});

test("routed Port-channel owns L3 addresses and restores switchport mode cleanly", () => {
  const c = setup();
  c.bundle();
  c.run("configure terminal");
  c.run("interface Po1");
  c.run("no switchport");
  c.run("ip address 10.45.0.1 255.255.255.252");
  const po = c.device().ports.find((p) => p.virtual?.kind === "portchannel");
  assert.equal(po.ip, "10.45.0.1");
  assert.equal(po.routed, true);
  assert.ok(
    c
      .device()
      .ports.filter((p) => p.channelGroup)
      .every((p) => p.routed && !p.ip),
  );
  c.run("interface Gi0/0");
  c.run("ip address 10.45.0.2 255.255.255.252", c.a.id, true);
  c.run("interface Po1");
  c.run("switchport");
  assert.equal(c.device().ports.find((p) => p.id === po.id).ip, "");
  assert.ok(
    c
      .device()
      .ports.filter((p) => p.channelGroup)
      .every((p) => !p.routed),
  );
});
