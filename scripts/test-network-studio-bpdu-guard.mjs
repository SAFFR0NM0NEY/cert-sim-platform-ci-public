import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blankTopology,
  connect,
  createDevice,
  linkStatus,
  linkUp,
} from "../src/network-studio/model.ts";
import { configurationError, ping } from "../src/network-studio/engine.ts";
import { ping6 } from "../src/network-studio/ipv6Engine.ts";
import {
  createRuntime,
  bindRuntime,
  resetRuntime,
  advanceRuntime,
} from "../src/network-studio/networkRuntime.ts";
import { advanceWorkspaceClock } from "../src/network-studio/workspaceClock.ts";
import {
  configuredPortFast,
  operationalPortFast,
  effectiveBpduGuard,
  bpduGuardDown,
  bpduGuardDeadline,
  synchronizeBpduGuard,
  clearBpduState,
} from "../src/network-studio/bpduGuard.ts";
import {
  portOperational,
  transmitFrame,
} from "../src/network-studio/ethernet.ts";
import { spanningTree } from "../src/network-studio/spanningTree.ts";
import { createSvi } from "../src/network-studio/vlanInterfaces.ts";
import {
  setSwitchport,
  setVlan,
  setVtp,
  materializeVlans,
  vlanActive,
} from "../src/network-studio/vlans.ts";
import { synchronizeVtp } from "../src/network-studio/vtp.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
import {
  saveStartup,
  reloadDevice,
} from "../src/network-studio/deviceLifecycle.ts";
import { multilayerSwitchLab } from "../src/network-studio/labs.ts";
import { defaultRouting } from "../src/network-studio/extensions.ts";
import {
  routingNeighbors,
  learnedRoutes,
} from "../src/network-studio/routing.ts";
import { requestDhcp } from "../src/network-studio/services.ts";

function wire(t, a, ap, b, bp) {
  return connect(
    t,
    { device: a.id, port: ap },
    { device: b.id, port: bp },
    "copper",
  );
}
function fixture(peerKind = "switch") {
  const core = createDevice("switch", 1),
    rogue = createDevice(peerKind, 2),
    host = createDevice("pc", 1),
    server = createDevice("server", 1);
  Object.assign(core.ports[7], { portFast: "enable", bpduGuard: "enable" });
  host.ports[0].ip = "192.168.10.10";
  server.ports[0].ip = "192.168.10.100";
  let t = { ...blankTopology(), devices: [core, rogue, host, server] };
  t = wire(t, core, "p0", host, "p0");
  t = wire(t, core, "p1", server, "p0");
  t = wire(t, core, "p7", rogue, "p0");
  const uplink = t.links.find((l) =>
    [l.a, l.b].some((e) => e.device === core.id && e.port === "p7"),
  );
  return { t, core, rogue, host, server, uplink, r: createRuntime() };
}
const state = (r, d, p = "p7") =>
  r.bpduPorts.find((s) => s.device === d.id && s.port === p);

test("packet execution detects direct switch BPDUs and isolates only the guarded branch", () => {
  const { t, core, rogue, host, server, uplink, r } = fixture();
  const before = structuredClone(t);
  bindRuntime(r, t);
  assert.equal(r.bpduPorts.length, 0, "binding is not BPDU reception");
  assert.equal(linkStatus(t, uplink, r).up, true);
  const result = ping(t, host.id, server.ports[0].ip, r);
  assert.equal(result.ok, true, result.message);
  assert.equal(bpduGuardDown(r, core.id, "p7"), true);
  assert.equal(linkUp(t, uplink, r), false);
  assert.match(linkStatus(t, uplink, r).reason, /BPDU Guard/);
  assert.equal(
    portOperational(t, rogue.id, "p0", r),
    false,
    "the remote physical endpoint sees the failed link",
  );
  assert.ok(
    spanningTree(t, 1, r)
      .filter((p) => p.device === core.id && p.port === "p7")
      .every((p) => p.state === "disabled"),
  );
  assert.deepEqual(
    t,
    before,
    "runtime protection never writes interface admin state",
  );
});

test("hosts, routers, phones and forged source MACs do not generate switch BPDUs", () => {
  for (const peerKind of ["pc", "router", "phone", "ap"]) {
    const { t, core, rogue, r } = fixture(peerKind);
    synchronizeBpduGuard(t, r);
    assert.equal(bpduGuardDown(r, core.id, "p7"), false, peerKind);
    transmitFrame(
      t,
      { device: rogue.id, port: "p0" },
      "ffffffffffff",
      r,
      "020000000001",
    );
    assert.equal(
      bpduGuardDown(r, core.id, "p7"),
      false,
      "data frame MAC is not a BPDU",
    );
  }
});

test("PortFast eligibility distinguishes inherited access, explicit trunk and disabled modes", () => {
  const d = createDevice("switch", 1),
    p = d.ports[0];
  assert.equal(configuredPortFast(d, p), false);
  d.spanningTree = {
    priorities: [],
    portFastDefault: true,
    bpduGuardDefault: true,
  };
  assert.equal(configuredPortFast(d, p), true);
  p.mode = "trunk";
  assert.equal(configuredPortFast(d, p), false);
  p.portFast = "enable";
  assert.equal(configuredPortFast(d, p), false);
  p.portFast = "trunk";
  assert.equal(configuredPortFast(d, p), true);
  p.portFast = "disable";
  assert.equal(configuredPortFast(d, p), false);
  p.mode = "access";
  p.portFast = "default";
  p.bpduGuard = "disable";
  assert.equal(
    effectiveBpduGuard(d, p),
    false,
    "explicit disable is the documented IOS-style simulator override",
  );
  p.portFast = "disable";
  p.bpduGuard = "enable";
  assert.equal(
    effectiveBpduGuard(d, p),
    true,
    "interface guard does not require PortFast",
  );
});

test("global guard applies only to operational PortFast and voice VLAN does not autoenable it", () => {
  for (const scenario of [
    "edge",
    "trunk",
    "ordinary-trunk",
    "disabled",
    "voice",
  ]) {
    const { t, core, r } = fixture();
    core.spanningTree = {
      priorities: [],
      portFastDefault: false,
      bpduGuardDefault: true,
    };
    core.ports[7].bpduGuard = "default";
    if (scenario === "trunk")
      Object.assign(core.ports[7], { mode: "trunk", portFast: "trunk" });
    if (scenario === "ordinary-trunk") core.ports[7].mode = "trunk";
    if (scenario === "disabled") core.ports[7].portFast = "disable";
    if (scenario === "voice")
      Object.assign(core.ports[7], { portFast: "default", voiceVlan: 20 });
    synchronizeBpduGuard(t, r);
    assert.equal(
      bpduGuardDown(r, core.id, "p7"),
      ["edge", "trunk"].includes(scenario),
      scenario,
    );
  }
});

test("unguarded switch BPDUs remove operational edge status until a link or local admin reset", () => {
  const { t, core, r, uplink } = fixture();
  core.ports[7].bpduGuard = "disable";
  assert.equal(operationalPortFast(core, core.ports[7], r), true);
  synchronizeBpduGuard(t, r);
  assert.equal(configuredPortFast(core, core.ports[7]), true);
  assert.equal(operationalPortFast(core, core.ports[7], r), false);
  assert.equal(state(r, core).edgeLost, true);
  assert.equal(state(r, core).shutdownAt, undefined);
  const disconnected = {
    ...t,
    links: t.links.filter((l) => l.id !== uplink.id),
  };
  synchronizeBpduGuard(disconnected, r);
  assert.equal(
    operationalPortFast(core, core.ports[7], r),
    true,
    "edge eligibility resets on a physical link change",
  );
});

test("blocked STP ports still receive BPDUs and simultaneous guard endpoints latch together", () => {
  const a = createDevice("switch", 1),
    b = createDevice("switch", 2);
  let t = wire({ ...blankTopology(), devices: [a, b] }, a, "p0", b, "p0");
  t = wire(t, a, "p1", b, "p1");
  const blocked = spanningTree(t, 1).find((p) => p.state === "blocking");
  assert.ok(blocked);
  const owner = t.devices.find((d) => d.id === blocked.device);
  owner.ports.find((p) => p.id === blocked.port).bpduGuard = "enable";
  const r = createRuntime();
  synchronizeBpduGuard(t, r);
  assert.equal(bpduGuardDown(r, blocked.device, blocked.port), true);
  const pair = fixture();
  pair.rogue.ports[0].bpduGuard = "enable";
  synchronizeBpduGuard(pair.t, pair.r);
  assert.equal(bpduGuardDown(pair.r, pair.core.id, "p7"), true);
  assert.equal(bpduGuardDown(pair.r, pair.rogue.id, "p0"), true);
});

test("guard latches survive unrelated edits, neighbor removal, guard disable and preserved resets", () => {
  const { t, core, rogue, uplink, r } = fixture();
  bindRuntime(r, t);
  synchronizeBpduGuard(t, r);
  let next = structuredClone(t);
  next.devices[0].ports[6].cdp = false;
  bindRuntime(r, next);
  assert.equal(bpduGuardDown(r, core.id, "p7"), true);
  next.devices[1].powered = false;
  resetRuntime(r, next, { preserveProtection: true });
  assert.equal(bpduGuardDown(r, core.id, "p7"), true);
  next.links = next.links.filter((l) => l.id !== uplink.id);
  next.devices[0].ports[7].bpduGuard = "disable";
  synchronizeBpduGuard(next, r);
  assert.equal(bpduGuardDown(r, core.id, "p7"), true);
  next.devices[0].ports[7].enabled = false;
  synchronizeBpduGuard(next, r);
  assert.equal(bpduGuardDown(r, core.id, "p7"), false);
  assert.equal(next.devices.find((d) => d.id === rogue.id).powered, false);
});

test("local power-off and explicit reload/reset clear protection; guard retrips after a bounce", () => {
  const { t, core, r } = fixture();
  synchronizeBpduGuard(t, r);
  core.powered = false;
  resetRuntime(r, t, { preserveProtection: true });
  assert.equal(bpduGuardDown(r, core.id, "p7"), false);
  core.powered = true;
  synchronizeBpduGuard(t, r);
  assert.equal(bpduGuardDown(r, core.id, "p7"), true);
  clearBpduState(r, core.id, "p7");
  assert.equal(bpduGuardDown(r, core.id, "p7"), false);
  synchronizeBpduGuard(t, r);
  assert.equal(bpduGuardDown(r, core.id, "p7"), true);
  resetRuntime(r, t);
  assert.equal(r.bpduPorts.length, 0);
});

test("automatic guard recovery uses the shared interval and never enables port-security recovery", () => {
  const { t, core, rogue, uplink, r } = fixture();
  core.bpduGuardRecovery = true;
  core.securityRecovery = { enabled: false, interval: 30 };
  synchronizeBpduGuard(t, r);
  assert.equal(bpduGuardDeadline(core, state(r, core)), 30);
  const replacement = createDevice("pc", 4);
  let next = {
    ...t,
    devices: [...t.devices.filter((d) => d.id !== rogue.id), replacement],
    links: t.links.filter((l) => l.id !== uplink.id),
  };
  next = wire(next, core, "p7", replacement, "p0");
  bindRuntime(r, t);
  advanceWorkspaceClock(r, next, 29);
  assert.equal(bpduGuardDown(r, core.id, "p7"), true);
  advanceWorkspaceClock(r, next, 1);
  assert.equal(bpduGuardDown(r, core.id, "p7"), false);
  assert.equal(portOperational(next, core.id, "p7", r), true);
  assert.equal(core.securityRecovery.enabled, false);
});

test("persistent BPDU sources retrip recovery with bounded state during a day-long clock jump", () => {
  const { t, core, r } = fixture();
  core.bpduGuardRecovery = true;
  core.securityRecovery = { enabled: false, interval: 30 };
  advanceRuntime(r, t, 86400);
  assert.equal(r.time, 86400);
  assert.equal(bpduGuardDown(r, core.id, "p7"), true);
  assert.equal(state(r, core).shutdownAt, 86400);
  assert.equal(state(r, core).violations, 2881);
  assert.equal(bpduGuardDeadline(core, state(r, core)), 86430);
  assert.ok(r.bpduPorts.length <= 2);
});

test("preserving protection also preserves its clock when saved DHCP time is stale", () => {
  const { t, core, r } = fixture();
  t.dhcpTime = 0;
  bindRuntime(r, t);
  r.time = 60;
  core.bpduGuardRecovery = true;
  core.securityRecovery = { enabled: false, interval: 30 };
  synchronizeBpduGuard(t, r);
  assert.equal(state(r, core).shutdownAt, 60);
  resetRuntime(r, t, { preserveProtection: true });
  assert.equal(r.time, 60);
  t.devices[0].ports[6].cdp = false;
  bindRuntime(r, t);
  assert.equal(r.time, 60);
  assert.equal(bpduGuardDeadline(core, state(r, core)), 90);
});

test("binding, serialization, link/STP reads and route inspection do not receive BPDUs", () => {
  const { t, core, uplink, r } = fixture();
  const before = structuredClone(t);
  bindRuntime(r, t);
  parseTopology(serializeTopology(t));
  linkStatus(t, uplink, r);
  spanningTree(t, 1, r);
  routingNeighbors(t, core.id, r);
  learnedRoutes(t, core.id, r);
  assert.deepEqual(r.bpduPorts, []);
  assert.deepEqual(t, before);
});

test("guarded trunks stop VTP and discovery advertisements until explicit recovery", () => {
  const { t, core, rogue, r } = fixture();
  let a = setVtp(materializeVlans(core), { domain: "GuardLab" });
  a = setVlan(a, 10);
  const b = setVtp(materializeVlans(rogue), {
    mode: "client",
    domain: "GuardLab",
  });
  Object.assign(a.ports[7], {
    mode: "trunk",
    allowedVlans: [10],
    portFast: "trunk",
  });
  Object.assign(b.ports[0], { mode: "trunk", allowedVlans: [10] });
  let next = {
    ...t,
    devices: t.devices.map((d) => (d.id === a.id ? a : d.id === b.id ? b : d)),
  };
  bindRuntime(r, next);
  assert.ok(r.neighbors.some((n) => n.remote.device === b.id));
  synchronizeBpduGuard(next, r);
  assert.equal(
    r.neighbors.some((n) => n.remote.device === b.id),
    false,
  );
  next = synchronizeVtp(next, r);
  assert.equal(
    vlanActive(
      next.devices.find((d) => d.id === b.id),
      10,
    ),
    false,
  );
  a.ports[7].bpduGuard = "disable";
  clearBpduState(r, a.id, "p7");
  next = synchronizeVtp(next, r);
  assert.equal(
    vlanActive(
      next.devices.find((d) => d.id === b.id),
      10,
    ),
    true,
  );
});

test("guard physical down withdraws SVI adjacency and RIP/OSPF routes and blocks remote DHCP", () => {
  for (const protocol of ["rip", "ospf"]) {
    let t = multilayerSwitchLab();
    const [client, , core, server] = t.devices,
      edge = createDevice("switch", 2),
      remote = createDevice("pc", 3);
    t.links = t.links.filter(
      (l) => ![l.a, l.b].some((e) => e.device === server.id),
    );
    Object.assign(core.ports[2], { mode: "trunk", allowedVlans: [30] });
    Object.assign(edge.ports[7], { mode: "trunk", allowedVlans: [30] });
    edge.ports[0].vlan = 30;
    edge.ports[1].vlan = 40;
    for (const vlan of [30, 40]) {
      const p = createSvi(edge, vlan);
      p.ip = "192.168." + vlan + ".2";
      edge.ports.push(p);
    }
    edge.ipRouting = true;
    remote.ports[0].ip = "192.168.40.10";
    remote.gateway = "192.168.40.2";
    for (const d of [core, edge])
      d.routing = {
        ...defaultRouting(),
        protocol,
        networks: [{ network: "0.0.0.0", prefix: 0, area: 0 }],
      };
    t.devices.push(edge, remote);
    t = wire(t, core, "p2", edge, "p7");
    t = wire(t, edge, "p0", server, "p0");
    t = wire(t, edge, "p1", remote, "p0");
    const r = createRuntime();
    assert.equal(requestDhcp(t, client.id, undefined, r).ok, true);
    assert.equal(routingNeighbors(t, core.id, r).length, 1);
    assert.ok(
      learnedRoutes(t, core.id, r).some(
        (route) => route.network === "192.168.40.0",
      ),
    );
    core.ports[2].bpduGuard = "enable";
    synchronizeBpduGuard(t, r);
    assert.equal(portOperational(t, core.id, "svi:30", r), false);
    assert.equal(routingNeighbors(t, core.id, r).length, 0);
    assert.equal(learnedRoutes(t, core.id, r).length, 0);
    assert.equal(requestDhcp(t, client.id, undefined, r).ok, false);
  }
});

test("guard physical down blocks IPv6 while local unguarded SVI management remains available", () => {
  const { t, core, rogue, host, r } = fixture();
  core.ports[7].bpduGuard = "disable";
  const a = createSvi(core, 1),
    b = createSvi(rogue, 1);
  a.ipv6 = "2001:db8::1";
  b.ipv6 = "2001:db8::2";
  core.ports.push(a);
  rogue.ports.push(b);
  host.ports[0].ipv6 = "2001:db8::10";
  assert.equal(ping6(t, host.id, b.ipv6, undefined, r).ok, true);
  core.ports[7].bpduGuard = "enable";
  assert.equal(ping6(t, host.id, b.ipv6, undefined, r).ok, false);
  assert.equal(ping6(t, host.id, a.ipv6, undefined, r).ok, true);
});

test("new protection settings round-trip and restore from startup; routed ports reject and clear them", () => {
  let d = createDevice("switch", 1);
  d.spanningTree = {
    priorities: [],
    portFastDefault: true,
    bpduGuardDefault: true,
  };
  d.bpduGuardRecovery = true;
  d.securityRecovery = { enabled: false, interval: 45 };
  Object.assign(d.ports[0], { portFast: "trunk", bpduGuard: "disable" });
  const saved = saveStartup(d),
    restored = reloadDevice(saved);
  assert.deepEqual(restored.spanningTree, d.spanningTree);
  assert.equal(restored.ports[0].bpduGuard, "disable");
  const t = { ...blankTopology(), devices: [restored] };
  assert.deepEqual(parseTopology(serializeTopology(t)), t);
  d = setSwitchport(d, "p0", false);
  assert.equal(d.ports[0].portFast, undefined);
  assert.equal(d.ports[0].bpduGuard, undefined);
  d.ports[0].bpduGuard = "enable";
  assert.match(configurationError(d), /Layer 2/);
  for (const mutate of [
    (d) => (d.ports[1].portFast = "rapid"),
    (d) => (d.spanningTree.bpduGuardDefault = "yes"),
    (d) => (d.bpduGuardRecovery = "yes"),
  ]) {
    const copy = structuredClone(t);
    mutate(copy.devices[0]);
    assert.throws(() => parseTopology(serializeTopology(copy)));
  }
});

test("two guarded ends coalesce repeated recovery at the slower shared link cycle", () => {
  const { t, core, rogue, r } = fixture();
  core.bpduGuardRecovery = rogue.bpduGuardRecovery = true;
  core.securityRecovery = { enabled: false, interval: 30 };
  rogue.securityRecovery = { enabled: false, interval: 60 };
  rogue.ports[0].bpduGuard = "enable";
  advanceRuntime(r, t, 86400);
  assert.equal(state(r, core).violations, 1441);
  assert.equal(state(r, rogue, "p0").violations, 1441);
  assert.equal(state(r, core).shutdownAt, 86400);
  assert.equal(state(r, rogue, "p0").shutdownAt, 86400);
  assert.equal(bpduGuardDown(r, core.id, "p7"), true);
  assert.equal(bpduGuardDown(r, rogue.id, "p0"), true);
});
