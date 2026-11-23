import assert from "node:assert/strict";
import { test } from "node:test";
import { command } from "../src/network-studio/cli.ts";
import {
  blankTopology,
  connect,
  createDevice,
} from "../src/network-studio/model.ts";
import { createRuntime } from "../src/network-studio/networkRuntime.ts";
import { switchportState } from "../src/network-studio/dtp.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";

function setup() {
  const a = createDevice("switch", 1),
    b = createDevice("switch", 2);
  let topology = connect(
    { ...blankTopology(), devices: [a, b] },
    { device: a.id, port: "p0" },
    { device: b.id, port: "p0" },
    "copper",
  );
  const runtime = createRuntime(),
    sessions = new Map();
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
      this.run("interface Gi0/0", id);
    },
  };
}

test("DTP CLI keeps configured dynamic modes and reports negotiated trunks", () => {
  const c = setup();
  c.config();
  c.run("switchport mode dynamic auto");
  c.run("end");
  c.config(c.b.id);
  c.run("switchport mode dynamic auto", c.b.id);
  c.run("end", c.b.id);
  assert.match(
    c.run("show interfaces gi0/0 switchport").output,
    /Administrative Mode: dynamic auto\nOperational Mode: access/,
  );
  assert.match(c.run("show interfaces trunk").output, /No operational trunks/);
  c.run("configure terminal", c.b.id);
  c.run("interface Gi0/0", c.b.id);
  c.run("switchport mode dynamic desirable", c.b.id);
  c.run("end", c.b.id);
  assert.equal(c.device().ports[0].mode, "dynamic-auto");
  assert.match(
    c.run("show interfaces trunk").output,
    /GigabitEthernet0\/0\s+dynamic auto\s+trunking/,
  );
  assert.match(
    c.run("show dtp interface gi0/0").output,
    /Operational Mode: trunk/,
  );
  assert.match(
    c.run("show dtp interface gi0/0").output,
    /Neighbor: .*GigabitEthernet0\/0/,
  );
  c.run("configure terminal");
  c.run("interface Gi0/0");
  c.run("shutdown");
  c.run("end");
  assert.match(c.run("show interfaces trunk").output, /No operational trunks/);
  assert.match(
    c.run("show interfaces gi0/0 switchport").output,
    /Operational Mode: down/,
  );
});

test("nonegotiate prevents a dynamic peer trunk and incompatible edits are atomic", () => {
  const c = setup();
  c.config();
  c.run("switchport mode trunk");
  c.run("switchport nonegotiate");
  c.run("end");
  c.config(c.b.id);
  c.run("switchport mode dynamic desirable", c.b.id);
  c.run("end", c.b.id);
  assert.equal(
    switchportState(c.topology, c.a.id, "p0", c.runtime).operational,
    "trunk",
  );
  assert.equal(
    switchportState(c.topology, c.b.id, "p0", c.runtime).operational,
    "access",
  );
  c.run("configure terminal");
  c.run("interface Gi0/0");
  const before = serializeTopology(c.topology);
  c.run("switchport mode dynamic auto", c.a.id, true);
  assert.equal(serializeTopology(c.topology), before);
  c.run("no switchport nonegotiate");
  c.run("switchport mode dynamic auto");
  c.run("switchport nonegotiate", c.a.id, true);
  assert.equal(
    switchportState(c.topology, c.a.id, "p0", c.runtime).operational,
    "trunk",
  );
});

test("dynamic CLI persists both fallback access and trunk settings through startup and JSON", () => {
  const c = setup();
  c.config();
  c.run("switchport mode dynamic desirable");
  c.run("switchport access vlan 20");
  c.run("switchport trunk native vlan 10");
  c.run("switchport trunk allowed vlan 10,20");
  c.run("end");
  const running = c.run("show running-config").output;
  assert.match(running, /switchport mode dynamic desirable/);
  assert.match(running, /switchport access vlan 20/);
  assert.match(running, /switchport trunk native vlan 10/);
  assert.match(running, /switchport trunk allowed vlan 10,20/);
  c.run("write memory");
  c.run("configure terminal");
  c.run("interface Gi0/0");
  c.run("switchport mode access");
  c.run("end");
  c.run("reload");
  const saved = parseTopology(serializeTopology(c.topology)).devices.find(
    (d) => d.id === c.a.id,
  ).ports[0];
  assert.equal(saved.mode, "dynamic-desirable");
  assert.equal(saved.vlan, 20);
  assert.equal(saved.nativeVlan, 10);
  assert.deepEqual(saved.allowedVlans, [10, 20]);
});

test("interface ranges roll back when any member forbids a dynamic mode", () => {
  const c = setup();
  c.config();
  c.run("switchport mode access");
  c.run("interface Gi0/1");
  c.run("switchport nonegotiate");
  c.run("interface range Gi0/0 - 1");
  const before = serializeTopology(c.topology);
  c.run("switchport mode dynamic desirable", c.a.id, true);
  assert.equal(serializeTopology(c.topology), before);
  c.run("no switchport nonegotiate");
  c.run("switchport mode dynamic desirable");
  assert.ok(
    c
      .device()
      .ports.slice(0, 2)
      .every((p) => p.mode === "dynamic-desirable"),
  );
});

test("port security and routed interfaces reject DTP configuration without losing settings", () => {
  const c = setup();
  c.config();
  c.run("switchport port-security");
  const before = serializeTopology(c.topology);
  c.run("switchport mode dynamic auto", c.a.id, true);
  assert.equal(serializeTopology(c.topology), before);
  c.run("interface Gi0/1");
  c.run("switchport mode dynamic desirable");
  c.run("switchport port-security", c.a.id, true);
  c.run("no switchport");
  c.run("switchport mode dynamic auto", c.a.id, true);
  c.run("switchport nonegotiate", c.a.id, true);
  c.run("end");
  assert.match(
    c.run("show interfaces gi0/1 switchport").output,
    /Switchport: Disabled/,
  );
});

test("no switchport mode restores dynamic auto and DTP diagnostics report domain mismatch", () => {
  const c = setup();
  c.config();
  c.run("switchport mode trunk");
  c.run("no switchport mode");
  assert.equal(c.device().ports[0].mode, "dynamic-auto");
  c.run("vtp domain BLUE");
  c.run("end");
  c.config(c.b.id);
  c.run("switchport mode dynamic desirable", c.b.id);
  c.run("vtp domain RED", c.b.id);
  c.run("end", c.b.id);
  assert.match(
    c.run("show dtp interface gi0/0").output,
    /Operational Mode: access/,
  );
  assert.match(c.run("show dtp interface gi0/0").output, /domain/i);
  assert.match(
    c.run("show interfaces gi0/99 switchport", c.a.id, true).output,
    /Unknown/,
  );
});

test("Port-channel DTP commands propagate and survive member failure", () => {
  const c = setup();
  for (const [id, protocol, mode] of [
    [c.a.id, "active", "auto"],
    [c.b.id, "passive", "desirable"],
  ]) {
    c.config(id);
    c.run("channel-group 1 mode " + protocol, id);
    c.run("interface po1", id);
    c.run("switchport mode dynamic " + mode, id);
    c.run("end", id);
  }
  assert.equal(
    switchportState(c.topology, c.a.id, "port-channel:1", c.runtime)
      .operational,
    "trunk",
  );
  assert.equal(c.device().ports[0].mode, "dynamic-auto");
  assert.match(
    c.run("show interfaces po1 switchport").output,
    /Operational Mode: trunk/,
  );
  c.run("configure terminal");
  c.run("interface Gi0/0");
  c.run("shutdown");
  c.run("end");
  assert.equal(
    switchportState(c.topology, c.a.id, "port-channel:1", c.runtime)
      .operational,
    "down",
  );
});
