import assert from "node:assert/strict";
import { test } from "node:test";
import { command } from "../src/network-studio/cli.ts";
import {
  blankTopology,
  createDevice,
  connect,
} from "../src/network-studio/model.ts";
import { createRuntime } from "../src/network-studio/networkRuntime.ts";
import { bpduGuardDown } from "../src/network-studio/bpduGuard.ts";
import { advanceWorkspaceClock } from "../src/network-studio/workspaceClock.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";

function setup(defaults = false) {
  const local = createDevice("switch", 1),
    peer = createDevice("switch", 2);
  if (defaults)
    local.spanningTree = {
      priorities: [],
      portFastDefault: true,
      bpduGuardDefault: true,
    };
  let topology = connect(
    { ...blankTopology(), devices: [local, peer] },
    { device: local.id, port: "p0" },
    { device: peer.id, port: "p0" },
    "copper",
  );
  let session = { mode: "user", portId: null };
  const runtime = createRuntime();
  return {
    local,
    peer,
    runtime,
    run(input, error = false) {
      const result = command(topology, local.id, session, input, runtime);
      topology = result.topology;
      session = result.session;
      if (error) assert.match(result.output, /^%/, input);
      else
        assert.ok(!result.output.startsWith("%"), input + ": " + result.output);
      return result;
    },
    config() {
      this.run("enable");
      this.run("configure terminal");
    },
    get topology() {
      return topology;
    },
    set topology(value) {
      topology = value;
    },
    device() {
      return topology.devices.find((d) => d.id === local.id);
    },
    down() {
      return bpduGuardDown(runtime, local.id, "p0");
    },
  };
}
test("BPDU CLI show commands do not process incoming control packets", () => {
  const c = setup(true),
    before = serializeTopology(c.topology);
  assert.match(c.run("show spanning-tree summary").output, /Default: Enabled/);
  c.run("show spanning-tree interface Gi0/0 detail");
  assert.match(
    c.run("show interfaces status err-disabled").output,
    /No err-disabled/,
  );
  assert.deepEqual(c.runtime.bpduPorts, []);
  assert.equal(serializeTopology(c.topology), before);
  c.config();
  c.run("interface Gi0/0");
  c.run("no shutdown");
  assert.equal(c.down(), true);
  c.run("end");
  assert.match(
    c.run("show interfaces status err-disabled").output,
    /GigabitEthernet0\/0.*bpduguard/,
  );
  assert.match(
    c.run("show spanning-tree interface Gi0/0 detail").output,
    /err-disabled \(bpduguard\)/,
  );
  assert.match(c.run("show ip interface brief").output, /err-disabled/);
});
test("BPDU CLI latch survives unrelated edits, disconnect and guard removal until administrative restart", () => {
  const c = setup();
  c.config();
  c.run("interface Gi0/0");
  c.run("spanning-tree bpduguard enable");
  assert.equal(c.down(), true);
  c.run("exit");
  c.run("hostname Guarded");
  assert.equal(c.down(), true);
  c.topology = { ...c.topology, links: [] };
  c.run("interface Gi0/0");
  c.run("no spanning-tree bpduguard");
  assert.equal(c.down(), true);
  c.run("shutdown");
  assert.equal(c.down(), false);
  c.run("no shutdown");
  assert.equal(c.down(), false);
  assert.equal(c.device().ports[0].enabled, true);
});
test("BPDU CLI explicit protection works without PortFast and re-trips while the peer remains", () => {
  const c = setup();
  c.config();
  c.run("interface Gi0/0");
  c.run("spanning-tree portfast disable");
  c.run("spanning-tree bpduguard enable");
  assert.equal(c.down(), true);
  c.run("shutdown");
  assert.equal(c.down(), false);
  c.run("no shutdown");
  assert.equal(c.down(), true);
  c.run("spanning-tree bpduguard disable");
  assert.equal(
    c.down(),
    true,
    "disabling protection does not recover an existing latch",
  );
  c.run("shutdown");
  c.run("no shutdown");
  assert.equal(c.down(), false);
  c.run("end");
  assert.match(
    c.run("show spanning-tree interface Gi0/0 detail").output,
    /BPDU Guard effective: Disabled/,
  );
});
test("PortFast and guard settings retain per-VLAN priorities, startup configuration and JSON", () => {
  const c = setup();
  c.topology = { ...c.topology, links: [] };
  c.config();
  c.run("spanning-tree portfast default");
  c.run("spanning-tree portfast bpduguard default");
  c.run("spanning-tree vlan 10 priority 4096");
  c.run("interface Gi0/1");
  c.run("spanning-tree portfast trunk");
  c.run("spanning-tree bpduguard enable");
  c.run("spanning-tree cost 19");
  c.run("end");
  c.run("write memory");
  const cfg = c.run("show running-config").output;
  assert.match(cfg, /spanning-tree portfast default/);
  assert.match(cfg, /spanning-tree portfast bpduguard default/);
  assert.match(cfg, /spanning-tree portfast trunk/);
  assert.match(cfg, /spanning-tree bpduguard enable/);
  c.run("configure terminal");
  c.run("no spanning-tree portfast default");
  c.run("no spanning-tree vlan 10 priority");
  assert.equal(c.device().spanningTree.bpduGuardDefault, true);
  c.run("end");
  c.run("reload");
  assert.equal(c.device().spanningTree.portFastDefault, true);
  assert.deepEqual(c.device().spanningTree.priorities, [
    { vlan: 10, priority: 4096 },
  ]);
  const restored = parseTopology(serializeTopology(c.topology)).devices.find(
    (d) => d.id === c.local.id,
  );
  assert.equal(restored.ports[1].portFast, "trunk");
  assert.equal(restored.ports[1].bpduGuard, "enable");
});
test("shared errdisable recovery interval preserves independently enabled security causes", () => {
  const c = setup();
  c.config();
  c.run("errdisable recovery cause psecure-violation");
  c.run("errdisable recovery cause bpduguard");
  c.run("errdisable recovery interval 30");
  c.run("interface Gi0/0");
  c.run("spanning-tree bpduguard enable");
  assert.equal(c.down(), true);
  c.run("end");
  const output = c.run("show errdisable recovery").output;
  assert.match(output, /psecure-violation Enabled/);
  assert.match(output, /bpduguard Enabled/);
  assert.match(output, /30s remaining/);
  c.topology = { ...c.topology, links: [] };
  c.topology = advanceWorkspaceClock(c.runtime, c.topology, 30);
  assert.equal(c.down(), false);
  c.run("configure terminal");
  c.run("no errdisable recovery cause bpduguard");
  assert.equal(c.device().securityRecovery.enabled, true);
  assert.equal(c.device().securityRecovery.interval, 30);
  assert.equal(c.device().bpduGuardRecovery, false);
});
test("BPDU CLI rejects invalid settings atomically and clears Layer2 protection on routed conversion", () => {
  const c = setup();
  c.config();
  c.run("interface Gi0/0");
  c.run("spanning-tree bpduguard enable");
  const snapshot = JSON.stringify(c.runtime.bpduPorts),
    before = serializeTopology(c.topology);
  c.run("spanning-tree cost 0", true);
  assert.equal(JSON.stringify(c.runtime.bpduPorts), snapshot);
  assert.equal(serializeTopology(c.topology), before);
  c.run("no switchport");
  assert.equal(c.down(), false);
  assert.equal(c.device().ports[0].bpduGuard, undefined);
  c.run("spanning-tree bpduguard enable", true);
  c.run("interface vlan10");
  c.run("spanning-tree portfast", true);
});
test("reloading one guarded switch clears its runtime while preserving a different switch latch", () => {
  const c = setup();
  c.topology.devices[1].ports[0].bpduGuard = "enable";
  c.config();
  c.run("interface Gi0/0");
  c.run("spanning-tree bpduguard enable");
  assert.equal(c.down(), true);
  assert.equal(bpduGuardDown(c.runtime, c.peer.id, "p0"), true);
  c.topology = { ...c.topology, links: [] };
  c.run("end");
  c.run("reload");
  assert.equal(c.down(), false);
  assert.equal(bpduGuardDown(c.runtime, c.peer.id, "p0"), true);
});
