import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blankTopology,
  createDevice,
  connect,
} from "../src/network-studio/model.ts";
import {
  switchportState,
  operationalSwitchport,
} from "../src/network-studio/dtp.ts";
import { configurationError, ping } from "../src/network-studio/engine.ts";
import { ping6 } from "../src/network-studio/ipv6Engine.ts";
import {
  createRuntime,
  bindRuntime,
} from "../src/network-studio/networkRuntime.ts";
import { spanningTree } from "../src/network-studio/spanningTree.ts";
import {
  portOperational,
  interfaceMac,
} from "../src/network-studio/ethernet.ts";
import { createSvi } from "../src/network-studio/vlanInterfaces.ts";
import { setVtp, setVlan, setSwitchport } from "../src/network-studio/vlans.ts";
import { synchronizeVtp } from "../src/network-studio/vtp.ts";
import {
  setChannelGroup,
  channelState,
  reconcilePortChannels,
} from "../src/network-studio/etherChannel.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
import {
  saveStartup,
  reloadDevice,
} from "../src/network-studio/deviceLifecycle.ts";
import {
  synchronizeBpduGuard,
  operationalPortFast,
  effectiveBpduGuard,
} from "../src/network-studio/bpduGuard.ts";

function wire(t, a, ap, b, bp) {
  return connect(
    t,
    { device: a.id, port: ap },
    { device: b.id, port: bp },
    "copper",
  );
}
function fixture(aMode = "dynamic-desirable", bMode = "dynamic-auto") {
  const a = createDevice("switch", 1),
    b = createDevice("switch", 2),
    left = createDevice("pc", 1),
    right = createDevice("pc", 2);
  for (const [sw, mode] of [
    [a, aMode],
    [b, bMode],
  ]) {
    Object.assign(sw.ports[0], {
      mode,
      vlan: 1,
      nativeVlan: 1,
      allowedVlans: [1, 10, 20],
    });
    sw.ports[1].vlan = 10;
  }
  for (const [i, host] of [left, right].entries())
    Object.assign(host.ports[0], {
      ip: `192.0.2.${i + 1}`,
      prefix: 24,
      ipv6: `2001:db8:10::${i + 1}`,
      prefix6: 64,
    });
  let t = { ...blankTopology(), devices: [a, b, left, right] };
  t = wire(t, a, "p0", b, "p0");
  t = wire(t, a, "p1", left, "p0");
  t = wire(t, b, "p1", right, "p0");
  return { t, a, b, left, right };
}

test("all DTP administrative combinations distinguish each end's operational mode", () => {
  const modes = ["access", "trunk", "dynamic-auto", "dynamic-desirable"];
  const expected = [
    ["access/access", "access/trunk", "access/access", "access/access"],
    ["trunk/access", "trunk/trunk", "trunk/trunk", "trunk/trunk"],
    ["access/access", "trunk/trunk", "access/access", "trunk/trunk"],
    ["access/access", "trunk/trunk", "trunk/trunk", "trunk/trunk"],
  ];
  for (const [i, am] of modes.entries())
    for (const [j, bm] of modes.entries()) {
      const { t, a, b } = fixture(am, bm),
        before = JSON.stringify(t);
      assert.equal(
        switchportState(t, a.id, "p0").operational +
          "/" +
          switchportState(t, b.id, "p0").operational,
        expected[i][j],
        `${am}/${bm}`,
      );
      assert.equal(JSON.stringify(t), before, "negotiation is observational");
    }
});

test("DTP establishes tagged IPv4 and IPv6 forwarding and learns the physical uplink", () => {
  const { t, a, b, left, right } = fixture(),
    r = createRuntime();
  assert.equal(ping(t, left.id, right.ports[0].ip, r).ok, true);
  assert.equal(ping6(t, left.id, right.ports[0].ipv6, undefined, r).ok, true);
  assert.equal(
    r.mac.find(
      (m) => m.device === b.id && m.mac === interfaceMac(left.id, "p0"),
    ).port,
    "p0",
  );
  assert.equal(a.ports[0].mode, "dynamic-desirable");
  assert.equal(b.ports[0].mode, "dynamic-auto");
});

test("auto/auto carries only its configured access VLAN and repairs after a peer change", () => {
  const { t, a, b, left, right } = fixture("dynamic-auto", "dynamic-auto"),
    r = createRuntime();
  assert.equal(ping(t, left.id, right.ports[0].ip, r).ok, false);
  a.ports[0].vlan = b.ports[0].vlan = 10;
  assert.equal(ping(t, left.id, right.ports[0].ip, r).ok, true);
  a.ports[0].vlan = b.ports[0].vlan = 1;
  b.ports[0].mode = "dynamic-desirable";
  assert.equal(ping(t, left.id, right.ports[0].ip, r).ok, true);
  b.ports[0].mode = "dynamic-auto";
  assert.equal(ping(t, left.id, right.ports[0].ip, r).ok, false);
});

test("nonegotiate keeps fixed trunks but prevents a dynamic peer from trunking", () => {
  const { t, a, b, left, right } = fixture("trunk", "dynamic-auto");
  a.ports[0].nonegotiate = true;
  assert.equal(switchportState(t, a.id, "p0").mode, "trunk");
  assert.equal(switchportState(t, a.id, "p0").negotiation, false);
  assert.match(switchportState(t, b.id, "p0").reason, /disabled DTP/);
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, false);
  b.ports[0].mode = "trunk";
  b.ports[0].nonegotiate = true;
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, true);
  delete a.ports[0].nonegotiate;
  b.ports[0].mode = "dynamic-auto";
  delete b.ports[0].nonegotiate;
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, true);
});

test("DTP requires matching VTP domains without changing saved domain or mode", () => {
  const { t, a, b, left, right } = fixture(),
    r = createRuntime();
  a.vtp = { mode: "transparent", domain: "Alpha", version: 2, revision: 0 };
  b.vtp = { mode: "transparent", domain: "Beta", version: 2, revision: 0 };
  assert.match(switchportState(t, a.id, "p0").reason, /domains differ/);
  assert.equal(ping(t, left.id, right.ports[0].ip, r).ok, false);
  b.vtp.domain = "Alpha";
  assert.equal(ping(t, left.id, right.ports[0].ip, r).ok, true);
  b.vtp.domain = "alpha";
  assert.equal(ping(t, left.id, right.ports[0].ip, r).ok, false);
  b.vtp.domain = "";
  assert.equal(switchportState(t, a.id, "p0").mode, "access");
  assert.equal(b.vtp.domain, "");
});

test("a dynamic switchport connected to a host or routed peer falls back to access", () => {
  const sw = createDevice("switch", 1),
    pc = createDevice("pc", 1);
  sw.ports[0].mode = "dynamic-desirable";
  let t = wire({ ...blankTopology(), devices: [sw, pc] }, sw, "p0", pc, "p0");
  assert.equal(switchportState(t, sw.id, "p0").mode, "access");
  assert.match(switchportState(t, sw.id, "p0").reason, /No DTP-capable/);
  const { t: routed, a, b } = fixture();
  routed.devices[1] = setSwitchport(b, "p0", false);
  assert.equal(switchportState(routed, a.id, "p0").mode, "access");
  assert.equal(switchportState(routed, b.id, "p0").operational, "routed");
});

test("carrier, remote power and protection changes immediately remove negotiated trunks", () => {
  const { t, a, b } = fixture(),
    r = createRuntime();
  assert.equal(switchportState(t, a.id, "p0", r).operational, "trunk");
  b.powered = false;
  assert.equal(switchportState(t, a.id, "p0", r).operational, "down");
  b.powered = true;
  b.ports[0].enabled = false;
  assert.equal(switchportState(t, a.id, "p0", r).up, false);
  b.ports[0].enabled = true;
  r.security.push({
    device: b.id,
    port: "p0",
    violations: 1,
    shutdown: true,
    shutdownAt: 0,
  });
  assert.equal(switchportState(t, a.id, "p0", r).operational, "down");
  r.security = [];
  r.bpduPorts.push({
    device: b.id,
    port: "p0",
    violations: 1,
    edgeLost: true,
    shutdownAt: 0,
  });
  assert.equal(switchportState(t, a.id, "p0", r).operational, "down");
  r.bpduPorts = [];
  assert.equal(switchportState(t, a.id, "p0", r).operational, "trunk");
  t.links = t.links.slice(1);
  assert.equal(switchportState(t, a.id, "p0", r).operational, "down");
  assert.equal(switchportState(t, a.id, "p0", r).mode, "access");
});

test("negotiated trunks retain native-VLAN and VLAN-allow-list enforcement", () => {
  const { t, a, b, left, right } = fixture();
  b.ports[0].allowedVlans = [1];
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, false);
  b.ports[0].allowedVlans = [1, 10];
  a.ports[0].nativeVlan = 10;
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, false);
  assert.ok(spanningTree(t, 10).some((p) => p.role === "inconsistent"));
  b.ports[0].nativeVlan = 10;
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, true);
});

test("parallel dynamic links converge to one forwarding STP path per VLAN", () => {
  const f = fixture(),
    { a, b, left, right } = f;
  for (const d of [a, b])
    Object.assign(d.ports[2], {
      ...d.ports[0],
      id: "p2",
      name: "GigabitEthernet0/2",
    });
  const t = wire(f.t, a, "p2", b, "p2");
  assert.equal(
    spanningTree(t, 10).filter((p) => p.role === "alternate").length,
    1,
  );
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, true);
});

test("SVI autostate follows operational VLAN membership, not dynamic administrative spelling", () => {
  const { t, a, b } = fixture();
  a.ports[1].enabled = b.ports[1].enabled = false;
  a.ports.push(createSvi(a, 10));
  assert.equal(portOperational(t, a.id, "svi:10"), true);
  a.ports[0].mode = "dynamic-auto";
  assert.equal(portOperational(t, a.id, "svi:10"), false);
  a.ports[0].vlan = b.ports[0].vlan = 10;
  assert.equal(portOperational(t, a.id, "svi:10"), true);
});

test("VTP advertisements cross negotiated trunks and stop after dynamic downgrade", () => {
  const { t, a, b } = fixture();
  t.devices[0] = setVtp(setVtp(a, { domain: "Campus" }), { mode: "server" });
  t.devices[1] = setVtp(setVtp(b, { domain: "Campus" }), { mode: "client" });
  t.devices[0] = setVlan(t.devices[0], 20, { name: "Engineering" });
  const synced = synchronizeVtp(t);
  assert.ok(
    synced.devices[1].vlans.some(
      (v) => v.id === 20 && v.name === "Engineering",
    ),
  );
  synced.devices[0].ports[0].mode = "dynamic-auto";
  synced.devices[0] = setVlan(synced.devices[0], 30, { name: "Research" });
  assert.ok(!synchronizeVtp(synced).devices[1].vlans.some((v) => v.id === 30));
});

function bundleFixture() {
  const f = fixture();
  for (const d of [f.a, f.b])
    Object.assign(d.ports[2], {
      ...d.ports[0],
      id: "p2",
      name: "GigabitEthernet0/2",
    });
  f.t = wire(f.t, f.a, "p2", f.b, "p2");
  f.a = setChannelGroup(f.a, ["p0", "p2"], 1, "active");
  f.b = setChannelGroup(f.b, ["p0", "p2"], 2, "passive");
  f.t.devices[0] = f.a;
  f.t.devices[1] = f.b;
  return f;
}

test("DTP negotiates logical EtherChannel trunks and retains traffic after a member failure", () => {
  const { t, a, b, left, right } = bundleFixture(),
    r = createRuntime();
  assert.equal(channelState(t, a.id, 1, r).up, true);
  assert.equal(
    switchportState(t, a.id, "port-channel:1", r).operational,
    "trunk",
  );
  assert.equal(ping(t, left.id, right.ports[0].ip, r).ok, true);
  assert.equal(
    r.mac.find(
      (m) => m.device === b.id && m.mac === interfaceMac(left.id, "p0"),
    ).port,
    "port-channel:2",
  );
  a.ports[0].enabled = false;
  assert.equal(ping(t, left.id, right.ports[0].ip, r).ok, true);
  assert.equal(ping6(t, left.id, right.ports[0].ipv6, undefined, r).ok, true);
  a.ports[2].enabled = false;
  assert.equal(
    switchportState(t, a.id, "port-channel:1", r).operational,
    "down",
  );
  assert.equal(ping(t, left.id, right.ports[0].ip, r).ok, false);
});

test("Port-channel edits propagate DTP policy and mismatched members suspend safely", () => {
  const { t, a, b, left, right } = bundleFixture();
  const next = structuredClone(a);
  next.ports.at(-1).mode = "trunk";
  next.ports.at(-1).nonegotiate = true;
  t.devices[0] = reconcilePortChannels(a, next);
  assert.ok(
    t.devices[0].ports
      .filter((p) => p.channelGroup)
      .every((p) => p.mode === "trunk" && p.nonegotiate),
  );
  assert.equal(switchportState(t, b.id, "port-channel:2").mode, "access");
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, false);
  t.devices[0].ports[0].nonegotiate = false;
  assert.equal(
    channelState(t, a.id, 1).members.find((m) => m.port === "p0").status,
    "suspended",
  );
});

test("passive EtherChannel members retain independent DTP and STP operation", () => {
  const { t, a, b, left, right } = bundleFixture();
  for (const d of [a, b])
    for (const p of d.ports.filter((p) => p.channelGroup))
      p.channelGroup.mode = "passive";
  assert.equal(channelState(t, a.id, 1).up, false);
  assert.ok(
    channelState(t, a.id, 1).members.every((m) => m.status === "individual"),
  );
  assert.equal(switchportState(t, a.id, "p0").mode, "trunk");
  assert.equal(
    spanningTree(t, 10).filter((p) => p.role === "alternate").length,
    1,
  );
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, true);
});

test("PortFast and default BPDU Guard follow negotiated access versus trunk state", () => {
  const { t, a, b } = fixture("dynamic-auto", "dynamic-auto"),
    r = createRuntime();
  a.spanningTree = {
    priorities: [],
    portFastDefault: true,
    bpduGuardDefault: true,
  };
  assert.equal(operationalPortFast(a, a.ports[0], r, t), true);
  assert.equal(effectiveBpduGuard(a, a.ports[0], r, t), true);
  b.ports[0].mode = "dynamic-desirable";
  assert.equal(operationalPortFast(a, a.ports[0], r, t), false);
  assert.equal(effectiveBpduGuard(a, a.ports[0], r, t), false);
  synchronizeBpduGuard(t, r);
  assert.equal(
    r.bpduPorts.find((p) => p.device === a.id && p.port === "p0").shutdownAt,
    undefined,
  );
  a.ports[0].bpduGuard = "enable";
  synchronizeBpduGuard(t, r);
  assert.equal(
    r.bpduPorts.find((p) => p.device === a.id && p.port === "p0").shutdownAt,
    0,
  );
  assert.equal(switchportState(t, a.id, "p0", r).operational, "down");
});

test("dynamic modes and disabled negotiation survive JSON and startup without materializing state", () => {
  const { t, a, b } = fixture();
  a.ports[3].nonegotiate = true;
  t.devices[0] = saveStartup(a);
  t.devices[1] = saveStartup(b);
  const reopened = parseTopology(serializeTopology(t));
  assert.equal(reopened.devices[0].ports[0].mode, "dynamic-desirable");
  assert.equal(reopened.devices[1].ports[0].mode, "dynamic-auto");
  assert.equal(reopened.devices[0].ports[3].nonegotiate, true);
  assert.equal(
    operationalSwitchport(
      reopened,
      reopened.devices[0],
      reopened.devices[0].ports[0],
    ).mode,
    "trunk",
  );
  assert.equal(reopened.devices[0].ports[0].mode, "dynamic-desirable");
  reopened.devices[0].ports[0].mode = "access";
  assert.equal(
    reloadDevice(reopened.devices[0]).ports[0].mode,
    "dynamic-desirable",
  );
});

test("DTP validation rejects illegal media, routing, nonegotiate and security combinations", () => {
  const { a } = fixture();
  a.ports[0].nonegotiate = true;
  assert.match(configurationError(a), /cannot disable DTP/);
  delete a.ports[0].nonegotiate;
  a.ports[0].security = { maximum: 1, violation: "shutdown", addresses: [] };
  assert.match(configurationError(a), /static access or trunk/);
  delete a.ports[0].security;
  const routed = setSwitchport(a, "p0", false);
  routed.ports[0].nonegotiate = true;
  assert.match(configurationError(routed), /DTP settings require/);
  const host = createDevice("pc", 1);
  host.ports[0].mode = "dynamic-auto";
  assert.match(configurationError(host), /DTP settings require/);
  a.ports[0].mode = "invalid";
  assert.match(configurationError(a), /Unsupported switch port mode/);
});

test("routed conversion removes negotiation settings and runtime invalidation includes peer domains", () => {
  const { t, a, b, left, right } = fixture("trunk", "dynamic-auto"),
    r = createRuntime();
  a.ports[0].nonegotiate = true;
  const routed = setSwitchport(a, "p0", false);
  assert.equal(routed.ports[0].nonegotiate, undefined);
  assert.equal(routed.ports[0].mode, "access");
  delete a.ports[0].nonegotiate;
  assert.equal(ping(t, left.id, right.ports[0].ip, r).ok, true);
  assert.ok(r.addressBindings.length > 0);
  b.vtp = { domain: "Other", mode: "transparent", version: 2, revision: 0 };
  bindRuntime(r, t);
  assert.equal(r.addressBindings.length, 0);
  assert.equal(r.mac.length, 0);
  assert.equal(ping(t, left.id, right.ports[0].ip, r).ok, false);
});
