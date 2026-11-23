import assert from "node:assert/strict";
import { test } from "node:test";
import {
  blankTopology,
  createDevice,
  connect,
} from "../src/network-studio/model.ts";
import {
  channelState,
  createPortChannel,
  setChannelGroup,
  removeChannelGroup,
  reconcilePortChannels,
  selectChannelMember,
  bridgePorts,
  forwardingLinks,
} from "../src/network-studio/etherChannel.ts";
import { configurationError, ping } from "../src/network-studio/engine.ts";
import { ping6 } from "../src/network-studio/ipv6Engine.ts";
import {
  createRuntime,
  bindRuntime,
} from "../src/network-studio/networkRuntime.ts";
import { spanningTree } from "../src/network-studio/spanningTree.ts";
import {
  interfaceMac,
  portMac,
  portOperational,
  transmitFrame,
  layer2Peers,
} from "../src/network-studio/ethernet.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
import {
  createSvi,
  removeDeviceInterface,
  packetInterfaces,
} from "../src/network-studio/vlanInterfaces.ts";
import {
  saveStartup,
  reloadDevice,
} from "../src/network-studio/deviceLifecycle.ts";
import {
  setSwitchport,
  setVtp,
  setVlan,
  materializeVlans,
} from "../src/network-studio/vlans.ts";
import { synchronizeVtp } from "../src/network-studio/vtp.ts";
import {
  synchronizeBpduGuard,
  operationalPortFast,
  effectiveBpduGuard,
} from "../src/network-studio/bpduGuard.ts";
import {
  defaultRouting,
  defaultServices,
} from "../src/network-studio/extensions.ts";
import { requestDhcp, httpRequest } from "../src/network-studio/services.ts";
import {
  routingNeighbors,
  learnedRoutes,
} from "../src/network-studio/routing.ts";
function wire(t, a, ap, b, bp) {
  return connect(
    t,
    { device: a.id, port: ap },
    { device: b.id, port: bp },
    "copper",
  );
}
function fixture(modes = ["active", "passive"], routed = false) {
  let a = createDevice("switch", 1),
    b = createDevice("switch", 2);
  for (let d of [a, b])
    for (const p of d.ports.slice(0, 2))
      Object.assign(p, {
        mode: "trunk",
        nativeVlan: 1,
        allowedVlans: [1, 10, 20],
      });
  a = setChannelGroup(a, ["p0", "p1"], 1, modes[0]);
  b = setChannelGroup(b, ["p0", "p1"], 2, modes[1]);
  if (routed) {
    for (const [i, d] of [a, b].entries()) {
      const po = d.ports.at(-1),
        before = structuredClone(d);
      const next = setSwitchport(d, po.id, false);
      next.ipRouting = true;
      next.ipv6Routing = true;
      Object.assign(next.ports.at(-1), {
        ip: "10.0.0." + (i + 1),
        prefix: 30,
        ipv6: "2001:db8:1::" + (i + 1),
        prefix6: 64,
      });
      const updated = reconcilePortChannels(before, next);
      if (i === 0) a = updated;
      else b = updated;
    }
  }
  const left = createDevice("pc", 1),
    right = createDevice("pc", 2);
  left.ports[0].ip = routed ? "192.168.10.10" : "192.168.1.10";
  right.ports[0].ip = routed ? "192.168.20.20" : "192.168.1.20";
  if (routed) {
    for (const [d, pc, n] of [
      [a, left, 10],
      [b, right, 20],
    ]) {
      Object.assign(d.ports[2], {
        routed: true,
        ip: "192.168." + n + ".1",
        prefix: 24,
        ipv6: "2001:db8:" + n + "::1",
        prefix6: 64,
      });
      delete d.ports[2].nativeVlan;
      Object.assign(pc.ports[0], {
        ipv6: "2001:db8:" + n + "::10",
        prefix6: 64,
      });
      pc.gateway = d.ports[2].ip;
      pc.gateway6 = d.ports[2].ipv6;
      const remote = n === 10 ? 20 : 10,
        hop = n === 10 ? 2 : 1;
      d.routes = [
        {
          network: "192.168." + remote + ".0",
          prefix: 24,
          nextHop: "10.0.0." + hop,
        },
      ];
      d.routes6 = [
        {
          network: "2001:db8:" + remote + "::",
          prefix: 64,
          nextHop: "2001:db8:1::" + hop,
        },
      ];
    }
  }
  let t = { ...blankTopology(), devices: [a, b, left, right] };
  t = wire(t, a, "p0", b, "p0");
  t = wire(t, a, "p1", b, "p1");
  t = wire(t, a, "p2", left, "p0");
  t = wire(t, b, "p2", right, "p0");
  return { t, a, b, left, right };
}
test("negotiation combinations collapse a bundle into one STP port and MAC entry", () => {
  for (const modes of [
    ["on", "on"],
    ["active", "active"],
    ["active", "passive"],
    ["desirable", "auto"],
    ["desirable", "desirable"],
  ]) {
    const { t, a, b, left, right } = fixture(modes);
    const r = createRuntime();
    assert.equal(channelState(t, a.id, 1, r).up, true);
    assert.equal(
      channelState(t, a.id, 1, r).members.filter((m) => m.status === "bundled")
        .length,
      2,
    );
    assert.equal(forwardingLinks(t, r).length, 3);
    const tree = spanningTree(t, 1, r);
    assert.equal(
      tree.filter((p) => p.device === a.id && ["p0", "p1"].includes(p.port))
        .length,
      0,
    );
    assert.equal(
      tree.filter((p) => p.device === a.id && p.port === "port-channel:1")
        .length,
      1,
    );
    assert.equal(ping(t, left.id, right.ports[0].ip, r).ok, true);
    assert.equal(
      r.mac.find(
        (m) => m.device === b.id && m.mac === interfaceMac(left.id, "p0"),
      ).port,
      "port-channel:2",
    );
    assert.ok(r.frames.some((f) => f.channelMembers?.length === 1));
    assert.ok(
      r.frames.every(
        (f) => !f.egress.includes("p0") && !f.egress.includes("p1"),
      ),
    );
  }
});
test("all passive/all auto negotiate no bundle and retain one safe STP path", () => {
  for (const mode of ["passive", "auto"]) {
    const { t, a, left, right } = fixture([mode, mode]);
    assert.equal(channelState(t, a.id, 1).up, false);
    assert.ok(
      channelState(t, a.id, 1).members.every((m) => m.status === "individual"),
    );
    assert.equal(
      spanningTree(t, 1).filter((p) => p.role === "alternate").length,
      1,
    );
    assert.equal(ping(t, left.id, right.ports[0].ip).ok, true);
  }
});
test("logical learning survives member failure and deterministic MAC hash selects live member", () => {
  const { t, a, b, left, right } = fixture();
  const r = createRuntime();
  ping(t, left.id, right.ports[0].ip, r);
  const source = interfaceMac(left.id, "p0"),
    dest = interfaceMac(right.id, "p0");
  const choice = selectChannelMember(
    t,
    a.id,
    "port-channel:1",
    source,
    dest,
    r,
  );
  assert.deepEqual(
    selectChannelMember(t, a.id, "port-channel:1", source, dest, r),
    choice,
  );
  assert.equal(
    new Set(
      Array.from(
        { length: 32 },
        (_, i) =>
          selectChannelMember(
            t,
            a.id,
            "port-channel:1",
            i.toString(16).padStart(12, "0"),
            dest,
            r,
          ).local.port,
      ),
    ).size,
    2,
  );
  a.ports.find((p) => p.id === choice.local.port).enabled = false;
  assert.notEqual(
    selectChannelMember(t, a.id, "port-channel:1", source, dest, r).local.port,
    choice.local.port,
  );
  assert.equal(ping(t, left.id, right.ports[0].ip, r).ok, true);
  assert.equal(
    r.mac.find((m) => m.device === b.id && m.mac === source).port,
    "port-channel:2",
  );
  a.ports[0].enabled = false;
  a.ports[1].enabled = false;
  assert.equal(channelState(t, a.id, 1, r).up, false);
  assert.equal(ping(t, left.id, right.ports[0].ip, r).ok, false);
});
test("Po edits propagate, member edits suspend only incompatible members, remote VLAN mismatch stays negotiated", () => {
  const { t, a, b, left, right } = fixture();
  a.ports[0].allowedVlans = [10];
  assert.equal(
    channelState(t, a.id, 1).members.find((m) => m.port === "p0").status,
    "suspended",
  );
  assert.equal(
    channelState(t, a.id, 1).members.find((m) => m.port === "p1").status,
    "bundled",
  );
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, true);
  let next = structuredClone(a);
  next.ports.at(-1).allowedVlans = [10, 20];
  next = reconcilePortChannels(a, next);
  t.devices[0] = next;
  assert.deepEqual(next.ports[0].allowedVlans, [10, 20]);
  assert.deepEqual(next.ports[1].allowedVlans, [10, 20]);
  assert.equal(channelState(t, a.id, 1).up, true);
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, false);
});
test("cross-wired bundles fail closed and incompatible static negotiation cannot leak frames", () => {
  const { t, a, b, left, right } = fixture(["on", "on"]);
  t.devices[1] = removeChannelGroup(b, ["p1"]);
  t.devices[1] = setChannelGroup(t.devices[1], ["p1"], 3, "on");
  assert.equal(channelState(t, a.id, 1).up, false);
  assert.ok(
    channelState(t, a.id, 1).members.every((m) => m.status === "suspended"),
  );
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, false);
});
test("routed Po supports dualstack forwarding and is the sole routed membership endpoint", () => {
  const { t, a, b, left, right } = fixture(undefined, true);
  const r = createRuntime();
  assert.equal(configurationError(a), null);
  assert.equal(
    packetInterfaces(a).some((p) => p.id === "p0" || p.id === "p1"),
    false,
  );
  assert.equal(ping(t, left.id, right.ports[0].ip, r).ok, true);
  assert.equal(ping6(t, left.id, right.ports[0].ipv6, undefined, r).ok, true);
  assert.equal(layer2Peers(t, { device: a.id, port: "p0" }).length, 0);
  for (const protocol of ["ospf", "rip"]) {
    for (const d of [a, b])
      d.routing = {
        ...defaultRouting(),
        protocol,
        networks: [{ network: "0.0.0.0", prefix: 0 }],
      };
    assert.equal(routingNeighbors(t, a.id, r).length, 1);
    assert.equal(routingNeighbors(t, a.id, r)[0].localPort, "port-channel:1");
    assert.ok(
      learnedRoutes(t, a.id, r).some(
        (route) => route.network === "192.168.20.0",
      ),
    );
  }
  a.ports[0].enabled = false;
  a.ports[1].enabled = false;
  assert.equal(ping6(t, left.id, right.ports[0].ipv6, undefined, r).ok, false);
  assert.equal(routingNeighbors(t, a.id, r).length, 0);
});
test("Po JSON/startup preserves mismatches, removal detaches members and cabling rejects virtual ports", () => {
  const { t, a } = fixture();
  a.ports[0].allowedVlans = [10];
  a.etherChannelLoadBalance = "src-dst-mac";
  t.devices[0] = saveStartup(a);
  const reopened = parseTopology(serializeTopology(t));
  assert.equal(channelState(reopened, a.id, 1).members[0].status, "suspended");
  assert.equal(
    reloadDevice(reopened.devices[0]).etherChannelLoadBalance,
    "src-dst-mac",
  );
  const removed = removeDeviceInterface(a, "port-channel:1");
  assert.ok(removed.ports.every((p) => !p.channelGroup));
  assert.throws(
    () => wire(t, a, "port-channel:1", t.devices[2], "p0"),
    /virtual|available/i,
  );
  assert.throws(() => setChannelGroup(a, ["p2"], 7, "active"));
  const bad = structuredClone(a);
  bad.ports[0].ip = "10.1.1.1";
  assert.match(configurationError(bad), /Port-channel/);
  bad.ports[0].ip = "";
  bad.ports[0].security = { maximum: 1, violation: "shutdown", addresses: [] };
  assert.match(configurationError(bad), /security|switchport/);
});
test("SVI autostate and VTP share channel state, while member BPDU Guard removes only affected carrier", () => {
  let { t, a, b } = fixture();
  a.ports.push(createSvi(a, 10));
  a.ports.at(-1).ip = "192.168.10.1";
  assert.equal(portOperational(t, a.id, "svi:10"), true);
  t.devices[0] = setVlan(
    setVtp(materializeVlans(a), { domain: "Bundle" }),
    30,
    { name: "Remote" },
  );
  t.devices[1] = setVtp(materializeVlans(b), {
    domain: "Bundle",
    mode: "client",
  });
  t = synchronizeVtp(t);
  assert.ok(t.devices[1].vlans.some((v) => v.id === 30));
  const r = createRuntime();
  t.devices[0].ports[0].bpduGuard = "enable";
  synchronizeBpduGuard(t, r);
  assert.equal(channelState(t, a.id, 1, r).members[0].status, "down");
  assert.equal(channelState(t, a.id, 1, r).up, true);
  assert.equal(portOperational(t, a.id, "svi:10", r), true);
  t.devices[0].ports[1].enabled = false;
  assert.equal(portOperational(t, a.id, "svi:10", r), false);
});

test("DHCP relay, ACL and HTTP share routed bundle forwarding and failover", () => {
  const { t, a, b, left, right } = fixture(undefined, true);
  right.kind = "server";
  right.services = defaultServices();
  right.services.http.enabled = true;
  right.services.dhcp = {
    enabled: true,
    leases: [],
    pools: [
      {
        id: "users",
        name: "Users",
        start: "192.168.10.100",
        prefix: 24,
        count: 10,
        gateway: "192.168.10.1",
        dns: "",
        leaseSeconds: 60,
      },
    ],
  };
  a.ports[2].helperAddresses = [right.ports[0].ip];
  left.ports[0].addressMode = "dhcp";
  left.ports[0].ip = "";
  left.gateway = "";
  const r = createRuntime();
  let lease = requestDhcp(t, left.id, undefined, r);
  assert.equal(lease.ok, true);
  assert.equal(lease.topology.devices[2].ports[0].ip, "192.168.10.100");
  assert.equal(
    httpRequest(lease.topology, left.id, "http://" + right.ports[0].ip + "/", r)
      .ok,
    true,
  );
  let live = lease.topology;
  live.devices[0].ports[0].enabled = false;
  assert.equal(
    httpRequest(live, left.id, "http://" + right.ports[0].ip + "/", r).ok,
    true,
  );
  assert.ok(
    r.frames.some(
      (f) =>
        f.device === a.id &&
        f.channelMembers?.[0]?.channel === "port-channel:1",
    ),
  );
  const acl = {
    name: "NO-WEB",
    rules: [
      {
        action: "deny",
        protocol: "tcp",
        source: "0.0.0.0",
        sourcePrefix: 0,
        destination: "0.0.0.0",
        destinationPrefix: 0,
        destinationPort: 80,
      },
      {
        action: "permit",
        protocol: "ip",
        source: "0.0.0.0",
        sourcePrefix: 0,
        destination: "0.0.0.0",
        destinationPrefix: 0,
      },
    ],
  };
  live.devices[0].accessLists = [acl];
  live.devices[0].ports.at(-1).outboundAcl = acl.name;
  assert.equal(
    httpRequest(live, left.id, "http://" + right.ports[0].ip + "/", r).ok,
    false,
  );
  assert.equal(ping(live, left.id, right.ports[0].ip, r).ok, true);
  live.devices[0].ports[1].enabled = false;
  assert.equal(requestDhcp(live, left.id, undefined, r).ok, false);
  live.devices[0].ports[1].enabled = true;
  live.devices[1].routes = [];
  assert.equal(
    requestDhcp(live, left.id, undefined, r).ok,
    false,
    "server reply needs a return route",
  );
});
test("aggregate STP cost follows live members and explicit override", () => {
  const { t, a } = fixture();
  const row = () =>
    spanningTree(t, 1).find(
      (p) => p.device === a.id && p.port === "port-channel:1",
    );
  assert.equal(row().cost, 2);
  a.ports[0].enabled = false;
  assert.equal(row().cost, 4);
  a.ports.at(-1).spanningTreeCost = 7;
  assert.equal(row().cost, 7);
});
test("static MAC references require logical ports and hash policy is persistent", () => {
  const { t, a, left, right } = fixture();
  a.staticMac = [{ port: "p0", vlan: 1, mac: interfaceMac(right.id, "p0") }];
  assert.match(configurationError(a), /static|MAC/i);
  a.staticMac[0].port = "port-channel:1";
  assert.equal(configurationError(a), null);
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, true);
  a.etherChannelLoadBalance = "dst-mac";
  const dst = interfaceMac(right.id, "p0");
  assert.equal(
    selectChannelMember(t, a.id, "port-channel:1", "020000000001", dst).linkId,
    selectChannelMember(t, a.id, "port-channel:1", "020000000002", dst).linkId,
  );
  assert.equal(
    parseTopology(serializeTopology(t)).devices[0].etherChannelLoadBalance,
    "dst-mac",
  );
});

test("parsed aggregate protection inherits without rewriting snapshot and member override is local", () => {
  let { t, a } = fixture();
  const po = a.ports.at(-1);
  po.portFast = "trunk";
  po.bpduGuard = "enable";
  a.ports[1].bpduGuard = "disable";
  const raw = serializeTopology(t);
  t = parseTopology(raw);
  const parsed = serializeTopology(t);
  a = t.devices[0];
  const r = createRuntime();
  assert.equal(effectiveBpduGuard(a, a.ports[0], r), true);
  assert.equal(effectiveBpduGuard(a, a.ports[1], r), false);
  synchronizeBpduGuard(t, r);
  assert.equal(channelState(t, a.id, 1, r).members[0].status, "down");
  assert.equal(channelState(t, a.id, 1, r).members[1].status, "bundled");
  assert.equal(channelState(t, a.id, 1, r).up, true);
  assert.equal(operationalPortFast(a, a.ports.at(-1), r), false);
  assert.ok(
    serializeTopology(t) === parsed,
    "BPDU synchronization must not rewrite parsed configuration.",
  );
  a.ports.at(-1).enabled = false;
  synchronizeBpduGuard(t, r);
  assert.equal(
    r.bpduPorts.some((s) => s.device === a.id),
    false,
    "aggregate shutdown resets member guard latches",
  );
  assert.equal(channelState(t, a.id, 1, r).up, false);
});
test("mixed media excludes only incompatible member and enrollment of empty fiber Po seeds media", () => {
  const { t, a, b, left, right } = fixture();
  a.ports[1].media = "fiber";
  b.ports[1].media = "fiber";
  t.links.find((l) => l.a.device === a.id && l.a.port === "p1").cable = "fiber";
  assert.equal(channelState(t, a.id, 1).members[0].status, "bundled");
  assert.equal(channelState(t, a.id, 1).members[1].status, "suspended");
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, true);
  let fresh = createDevice("switch", 4);
  fresh.ports[0].media = "fiber";
  fresh.ports.push(createPortChannel(fresh, 1));
  fresh = setChannelGroup(fresh, ["p0"], 1, "active");
  assert.equal(fresh.ports.at(-1).media, "fiber");
});

test("all-tagged member differs from native VLAN 1 and cannot enter a logical native bundle", () => {
  const { t, a, left, right } = fixture();
  delete a.ports[0].nativeVlan;
  assert.equal(channelState(t, a.id, 1).members[0].status, "suspended");
  assert.equal(channelState(t, a.id, 1).members[1].status, "bundled");
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, true);
  a.ports[1].enabled = false;
  assert.equal(channelState(t, a.id, 1).up, false);
  assert.equal(ping(t, left.id, right.ports[0].ip).ok, false);
  let fresh = createDevice("switch", 8);
  Object.assign(fresh.ports[0], { mode: "trunk", allowedVlans: [1, 10] });
  delete fresh.ports[0].nativeVlan;
  fresh = setChannelGroup(fresh, ["p0"], 1, "active");
  assert.equal(
    fresh.ports.at(-1).nativeVlan,
    undefined,
    "auto-created Po preserves all-tagged encapsulation",
  );
});

test("inactive switching fields do not suspend access, trunk or routed bundles", () => {
  const trunk = fixture();
  trunk.a.ports[0].vlan = 23;
  assert.equal(
    channelState(trunk.t, trunk.a.id, 1).members[0].status,
    "bundled",
    "stored access VLAN has no effect on trunk membership",
  );
  for (const d of [trunk.a, trunk.b])
    for (const p of [d.ports[0], d.ports[1], d.ports.at(-1)]) {
      p.mode = "access";
      p.vlan = 1;
    }
  trunk.a.ports[0].nativeVlan = 23;
  trunk.a.ports[0].allowedVlans = [23];
  assert.equal(
    channelState(trunk.t, trunk.a.id, 1).members[0].status,
    "bundled",
    "stored trunk fields have no effect on access membership",
  );
  assert.equal(ping(trunk.t, trunk.left.id, trunk.right.ports[0].ip).ok, true);
  const routed = fixture(undefined, true);
  routed.a.ports[0].allowedVlans = [23];
  assert.equal(configurationError(routed.a), null);
  assert.equal(
    channelState(routed.t, routed.a.id, 1).members[0].status,
    "bundled",
  );
  assert.equal(
    ping(routed.t, routed.left.id, routed.right.ports[0].ip).ok,
    true,
  );
});

test("IPv4 and IPv6 packet events identify the transmitted member and follow failover", () => {
  for (const routed of [false, true]) {
    const { t, a, b, left, right } = fixture(undefined, routed);
    a.etherChannelLoadBalance = "dst-mac";
    if (!routed) {
      left.ports[0].ipv6 = "2001:db8:9::10";
      right.ports[0].ipv6 = "2001:db8:9::20";
      left.ports[0].prefix6 = right.ports[0].prefix6 = 64;
    }
    const source = routed
      ? portMac(a, a.ports.at(-1))
      : portMac(left, left.ports[0]);
    const destination = routed
      ? portMac(b, b.ports.at(-1))
      : portMac(right, right.ports[0]);
    const expected = selectChannelMember(
      t,
      a.id,
      "port-channel:1",
      source,
      destination,
    );
    for (const protocol of ["ICMP", "ICMPv6"]) {
      const r = createRuntime();
      const result =
        protocol === "ICMP"
          ? ping(t, left.id, right.ports[0].ip, r)
          : ping6(t, left.id, right.ports[0].ipv6, undefined, r);
      assert.equal(result.ok, true);
      const traversals = result.events.filter(
        (e) =>
          e.protocol === protocol &&
          e.phase === "request" &&
          e.from === a.id &&
          e.to === b.id,
      );
      assert.equal(traversals.length, 1);
      assert.equal(traversals[0].link, expected.linkId);
      if (routed) {
        const resolution = result.events.find(
          (e) =>
            e.protocol === (protocol === "ICMP" ? "ARP" : "NDP") &&
            e.phase === "request" &&
            e.from === a.id &&
            e.to === b.id,
        );
        assert.equal(
          resolution.link,
          selectChannelMember(t, a.id, "port-channel:1", source, "ffffffffffff")
            .linkId,
          "resolution uses its transmitted broadcast hash, not the payload or topology lookup hash",
        );
      }
    }
    a.ports.find((p) => p.id === expected.local.port).enabled = false;
    const failover = ping(t, left.id, right.ports[0].ip);
    assert.equal(failover.ok, true);
    const surviving = failover.events.find(
      (e) =>
        e.protocol === "ICMP" &&
        e.phase === "request" &&
        e.from === a.id &&
        e.to === b.id,
    );
    assert.ok(surviving.link);
    assert.notEqual(surviving.link, expected.linkId);
    assert.ok(failover.events.every((e) => e.link !== expected.linkId));
  }
});
