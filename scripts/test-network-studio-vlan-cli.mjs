import assert from "node:assert/strict";
import { test } from "node:test";
import { command, prompt } from "../src/network-studio/cli.ts";
import {
  createDevice,
  blankTopology,
  connect,
} from "../src/network-studio/model.ts";
import { createRuntime } from "../src/network-studio/networkRuntime.ts";
import { materializeVlans, vlanDatabase } from "../src/network-studio/vlans.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";

function shell(topology, deviceId) {
  let t = topology,
    s = { mode: "user", portId: null };
  const r = createRuntime();
  return {
    run(input, expectedError = false) {
      const result = command(t, deviceId, s, input, r);
      t = result.topology;
      s = result.session;
      if (!expectedError)
        assert.ok(!result.output.startsWith("%"), input + ": " + result.output);
      else assert.match(result.output, /^%/, input);
      return result;
    },
    config() {
      this.run("enable");
      this.run("configure terminal");
    },
    device() {
      return t.devices.find((d) => d.id === deviceId);
    },
    get topology() {
      return t;
    },
    get session() {
      return s;
    },
  };
}
function setup() {
  const d = materializeVlans(createDevice("switch", 1));
  return shell({ ...blankTopology(), devices: [d] }, d.id);
}
test("VLAN CLI ranges, names, suspension, reserved VLAN guards and context transitions", () => {
  const c = setup();
  c.config();
  c.run("vlan 10,20-22");
  assert.equal(c.session.mode, "vlan");
  assert.match(prompt(c.device(), c.session), /\(config-vlan\)#$/);
  c.run("name Learners");
  assert.equal(c.device().vlans.filter((v) => v.name === "Learners").length, 4);
  c.run("state suspend");
  assert.equal(c.device().vlans.find((v) => v.id === 10).state, "suspended");
  c.run("exit");
  assert.equal(c.session.mode, "config");
  c.run("no vlan 20-22");
  assert.ok(!c.device().vlans.some((v) => v.id === 21));
  const before = serializeTopology(c.topology);
  c.run("vlan 30,4095", true);
  assert.equal(serializeTopology(c.topology), before);
  c.run("no vlan 1", true);
  c.run("vlan 1");
  c.run("name Custom", true);
  c.run("vlan 2000", true);
  c.run("vtp mode transparent");
  c.run("vlan 2000");
  c.run("name Extended");
  c.run("end");
  assert.equal(c.session.mode, "privileged");
  assert.match(c.run("show vlan id 2000").output, /Extended/);
  assert.match(
    c.run("show running-config").output,
    /vlan 2000\n name Extended/,
  );
  assert.equal(
    parseTopology(serializeTopology(c.topology)).devices[0].vlans.find(
      (v) => v.id === 2000,
    ).name,
    "Extended",
  );
});
test("VTP clients deny manual VLAN edits while access and new SVI commands follow Packet Tracer behavior", () => {
  const c = setup();
  c.config();
  c.run("vtp domain CertSim");
  c.run("vtp mode client");
  c.run("vlan 40", true);
  c.run("no vlan 1", true);
  c.run("interface GigabitEthernet0/0");
  c.run("switchport access vlan 40");
  c.run("switchport voice vlan 42");
  assert.ok(!vlanDatabase(c.device()).some((v) => v.id === 40 || v.id === 42));
  c.run("interface vlan 41");
  assert.ok(vlanDatabase(c.device()).some((v) => v.id === 41));
  c.run("vtp mode server");
  c.run("no vlan 41");
  c.run("interface vlan41");
  assert.ok(
    !vlanDatabase(c.device()).some((v) => v.id === 41),
    "selecting an existing SVI must not recreate a deleted VLAN",
  );
  c.run("interface vlan43");
  assert.ok(vlanDatabase(c.device()).some((v) => v.id === 43));
});
test("access and voice declarations create VLANs, while trunk allow lists do not", () => {
  const c = setup();
  c.config();
  c.run("interface GigabitEthernet0/0");
  c.run("switchport access vlan 31");
  c.run("switchport voice vlan 32");
  c.run("interface GigabitEthernet0/1");
  c.run("switchport mode trunk");
  c.run("switchport trunk allowed vlan 34");
  assert.ok(vlanDatabase(c.device()).some((v) => v.id === 31));
  assert.ok(vlanDatabase(c.device()).some((v) => v.id === 32));
  assert.ok(!vlanDatabase(c.device()).some((v) => v.id === 34));
  c.run("end");
  assert.match(c.run("show vlan brief").output, /VLAN0032/);
});
test("routed physical CLI resets incompatible state, preserves idempotent addressing, and restores Layer 2", () => {
  const c = setup();
  c.config();
  c.run("interface GigabitEthernet0/0");
  c.run("switchport voice vlan 20");
  c.run("switchport port-security");
  c.run("spanning-tree cost 12");
  c.run("no switchport");
  c.run("ip address 10.0.0.1 255.255.255.0");
  c.run("ip helper-address 192.0.2.5");
  c.run("ipv6 address 2001:db8::1/64");
  c.run("no switchport");
  const p = c.device().ports[0];
  assert.equal(p.routed, true);
  assert.equal(p.ip, "10.0.0.1");
  assert.equal(p.security, undefined);
  assert.equal(p.voiceVlan, undefined);
  assert.equal(p.spanningTreeCost, undefined);
  c.run("switchport access vlan 10", true);
  c.run("spanning-tree cost 4", true);
  c.run("end");
  assert.match(
    c.run("show interfaces GigabitEthernet0/0 switchport").output,
    /Switchport: Disabled/,
  );
  assert.match(c.run("show running-config").output, /no switchport/);
  c.run("configure terminal");
  c.run("interface GigabitEthernet0/0");
  c.run("switchport");
  const restored = c.device().ports[0];
  assert.equal(restored.routed, undefined);
  assert.equal(restored.ip, "");
  assert.equal(restored.ipv6, undefined);
  assert.equal(restored.helperAddresses, undefined);
  assert.equal(restored.vlan, 1);
});
test("committed CLI VLAN changes propagate through a VTP trunk; show commands remain observational", () => {
  const a = materializeVlans(createDevice("switch", 1)),
    b = materializeVlans(createDevice("switch", 2));
  for (const d of [a, b]) {
    d.ports[0].mode = "trunk";
    d.vtp = {
      domain: "CertSim",
      version: 2,
      mode: d === a ? "server" : "client",
      revision: 0,
    };
  }
  const t = connect(
    { ...blankTopology(), devices: [a, b] },
    { device: a.id, port: "p0" },
    { device: b.id, port: "p0" },
    "copper",
  );
  const c = shell(t, a.id);
  const before = serializeTopology(c.topology);
  c.run("show vtp status");
  assert.equal(serializeTopology(c.topology), before);
  c.config();
  c.run("vlan 10");
  c.run("name Users");
  const remote = c.topology.devices.find((d) => d.id === b.id);
  assert.equal(remote.vlans.find((v) => v.id === 10).name, "Users");
  assert.equal(remote.vtp.revision, c.device().vtp.revision);
  c.run("vtp domain NewDomain");
  assert.equal(c.device().vtp.revision, 0);
  c.run("vtp password CaseSensitive");
  c.run("end");
  assert.match(c.run("show vtp password").output, /CaseSensitive/);
});
test("write memory and reload restore routed interfaces and the persistent VLAN database", () => {
  const c = setup();
  c.config();
  c.run("vlan 10");
  c.run("name Persistent");
  c.run("interface GigabitEthernet0/0");
  c.run("no switchport");
  c.run("ip address 10.0.0.1 255.255.255.0");
  c.run("end");
  c.run("write memory");
  c.run("configure terminal");
  c.run("vlan 20");
  c.run("name Later");
  c.run("interface GigabitEthernet0/0");
  c.run("switchport");
  c.run("end");
  c.run("reload");
  assert.equal(c.device().ports[0].ip, "10.0.0.1");
  assert.equal(c.device().ports[0].routed, true);
  assert.ok(
    vlanDatabase(c.device()).some((v) => v.id === 20),
    "server VLAN database persists independently of startup",
  );
});
