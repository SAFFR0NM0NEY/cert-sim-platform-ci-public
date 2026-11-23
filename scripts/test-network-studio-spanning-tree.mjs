import assert from "node:assert/strict";
import { test } from "node:test";
import { redundantLab, servicesLab } from "../src/network-studio/labs.ts";
import { spanningTree, bridgeMac } from "../src/network-studio/spanningTree.ts";
import { ping } from "../src/network-studio/engine.ts";
import { ping6 } from "../src/network-studio/ipv6Engine.ts";
import { connect, createDevice } from "../src/network-studio/model.ts";
import { requestDhcp } from "../src/network-studio/services.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
import { command, INITIAL_CLI } from "../src/network-studio/cli.ts";
import {
  saveStartup,
  reloadDevice,
} from "../src/network-studio/deviceLifecycle.ts";
test("redundant triangle elects configured root and blocks one alternate while delivering IPv4/IPv6", () => {
  const t = redundantLab(),
    [a, b, s1, s2, s3] = t.devices,
    rows = spanningTree(t, 1);
  assert.equal(new Set(rows.map((r) => r.root)).size, 1);
  assert.equal(rows[0].root, s1.id);
  assert.equal(rows.filter((r) => r.role === "alternate").length, 1);
  assert.equal(
    rows.find((r) => r.device === s3.id && r.port === "p2").state,
    "blocking",
  );
  const p = ping(t, a.id, b.ports[0].ip);
  assert.equal(p.ok, true, p.message);
  assert.ok(!p.hops.includes(s3.id));
  assert.equal(ping6(t, a.id, b.ports[0].ipv6).ok, true);
  assert.equal(
    rows.find((r) => r.device === s2.id && r.port === "p1").role,
    "root",
  );
});
test("link failure recomputes forwarding and uses the formerly blocked redundant path", () => {
  const t = redundantLab(),
    [a, b, s1, s2, s3] = t.devices;
  s1.ports[1].enabled = false;
  const p = ping(t, a.id, b.ports[0].ip);
  assert.equal(p.ok, true, p.message);
  assert.ok(p.hops.includes(s3.id));
  assert.equal(
    spanningTree(t, 1).find((r) => r.device === s3.id && r.port === "p2").state,
    "forwarding",
  );
  s3.powered = false;
  assert.equal(ping(t, a.id, b.ports[0].ip).ok, false);
  s1.ports[1].enabled = true;
  assert.equal(ping(t, a.id, b.ports[0].ip).ok, true);
});
test("per-VLAN root priorities, receive costs and deterministic bridge identities affect port selection", () => {
  const t = redundantLab(),
    s = t.devices.slice(2);
  for (const d of s) {
    d.spanningTree = {
      priorities: [{ vlan: 10, priority: d === s[2] ? 0 : 32768 }],
    };
    for (const p of d.ports) {
      p.mode = "trunk";
      p.allowedVlans = [1, 10];
    }
  }
  assert.equal(
    spanningTree(t, 10).find((r) => r.device === s[0].id).root,
    s[2].id,
  );
  const root1 = [...s].sort((a, b) =>
    bridgeMac(a.id).localeCompare(bridgeMac(b.id)),
  )[0];
  assert.equal(spanningTree(t, 1)[0].root, root1.id);
  s[0].spanningTree = { priorities: [{ vlan: 1, priority: 0 }] };
  s[1].ports[1].spanningTreeCost = 100;
  assert.equal(
    spanningTree(t, 1).find((r) => r.device === s[1].id && r.port === "p2")
      .role,
    "root",
  );
  assert.equal(bridgeMac(s[0].id), bridgeMac(s[0].id));
});
test("parallel links choose one root port; VLAN/tagging mismatch is blocked without changing carrier", () => {
  let t = redundantLab();
  t = connect(
    t,
    { device: t.devices[2].id, port: "p3" },
    { device: t.devices[3].id, port: "p3" },
    "copper",
  );
  const rows = spanningTree(t, 1).filter((r) => r.device === t.devices[3].id);
  assert.equal(rows.filter((r) => r.role === "root").length, 1);
  assert.equal(rows.find((r) => r.port === "p3").role, "alternate");
  t.devices[2].ports[0].mode = "trunk";
  assert.equal(ping(t, t.devices[0].id, t.devices[1].ports[0].ip).ok, true);
  t.devices[2].ports[0].nativeVlan = 10;
  assert.equal(ping(t, t.devices[0].id, t.devices[1].ports[0].ip).ok, false);
  const u = redundantLab();
  u.devices[2].ports[1].vlan = 10;
  assert.equal(
    spanningTree(u, 1).find(
      (r) => r.device === u.devices[3].id && r.port === "p1",
    ).role,
    "inconsistent",
  );
});
test("DHCP and service connectivity use the same spanning-tree forwarding graph", () => {
  let t = servicesLab();
  const extra = createDevice("switch", 2, 800, 500);
  const sw = t.devices.find((d) => d.kind === "switch");
  t = { ...t, devices: [...t.devices, extra] };
  t = connect(
    t,
    { device: sw.id, port: "p3" },
    { device: extra.id, port: "p0" },
    "copper",
  );
  t = connect(
    t,
    { device: sw.id, port: "p4" },
    { device: extra.id, port: "p1" },
    "copper",
  );
  const r = requestDhcp(t, t.devices[0].id, t.devices[0].ports[0].id);
  assert.equal(r.ok, true, r.message);
  assert.equal(
    spanningTree(t, 1).filter((p) => p.role === "alternate").length,
    1,
  );
});
test("spanning-tree JSON/CLI and startup preserve configuration; invalid settings reject", () => {
  let t = redundantLab(),
    id = t.devices[2].id,
    session = INITIAL_CLI;
  const run = (line) => {
    const r = command(t, id, session, line);
    t = r.topology;
    session = r.session;
    return r;
  };
  run("enable");
  run("configure terminal");
  assert.equal(run("spanning-tree vlan 10 priority 8192").changed, true);
  assert.equal(run("spanning-tree vlan 10 priority 8193").changed, false);
  run("interface GigabitEthernet0/1"); // switch interfaces use actual name below
  const port = t.devices[2].ports[1];
  run("end");
  run("configure terminal");
  run(`interface ${port.name}`);
  assert.equal(run("spanning-tree cost 30").changed, true);
  run("end");
  assert.match(
    run("show spanning-tree vlan 10").output,
    /No spanning tree instance/,
  );
  assert.match(run("show spanning-tree vlan 1").output, /Root: Switch-1/);
  assert.match(run("show spanning-tree vlan 1").output, /4097\.[0-9a-f]{12}/);
  assert.match(
    run("show spanning-tree vlan 1").output,
    /priority 4096 sys-id-ext 1/,
  );
  assert.match(run("show running-config").output, /spanning-tree cost 30/);
  const copy = parseTopology(serializeTopology(t));
  assert.equal(copy.devices[2].ports[1].spanningTreeCost, 30);
  const saved = saveStartup(copy.devices[2]);
  saved.spanningTree = { priorities: [] };
  assert.equal(
    reloadDevice(saved).spanningTree.priorities.find((p) => p.vlan === 10)
      .priority,
    8192,
  );
  for (const mutate of [
    (w) => w.devices[2].spanningTree.priorities.push({ vlan: 1, priority: 1 }),
    (w) => (w.devices[2].ports[1].spanningTreeCost = 0),
    (w) => (w.devices[0].spanningTree = { priorities: [] }),
  ]) {
    const wire = JSON.parse(serializeTopology(t));
    mutate(wire);
    assert.throws(() => parseTopology(JSON.stringify(wire)));
  }
});
test("forwarding links form a connected acyclic tree across varied positive-cost topologies", () => {
  for (let trial = 0; trial < 24; trial++) {
    const switches = Array.from({ length: 6 }, (_, i) => ({
      ...createDevice("switch", i + 1, 100 + i * 100, 200),
      id: `trial-${trial}-switch-${i}`,
    }));
    let t = {
      version: 1,
      name: "Synthetic spanning tree",
      devices: switches,
      links: [],
    };
    const used = Array(6).fill(0);
    const add = (i, j) => {
      const a = switches[i],
        b = switches[j],
        ap = a.ports[used[i]++],
        bp = b.ports[used[j]++];
      ap.spanningTreeCost = 1 + ((trial * 7 + i * 13 + j * 3) % 50);
      bp.spanningTreeCost = 1 + ((trial * 3 + i * 7 + j * 11) % 50);
      t = connect(
        t,
        { device: a.id, port: ap.id },
        { device: b.id, port: bp.id },
        "copper",
      );
    };
    for (let i = 0; i < 5; i++) add(i, i + 1);
    add(0, 5);
    add(0, 3);
    add(1, 4);
    add(2, 5);
    const rows = spanningTree(t, 1),
      forward = t.links.filter((l) =>
        [l.a, l.b].every(
          (e) =>
            rows.find((r) => r.device === e.device && r.port === e.port)
              .state === "forwarding",
        ),
      );
    assert.equal(forward.length, 5);
    const visited = new Set([switches[0].id]);
    for (let pass = 0; pass < 6; pass++)
      for (const l of forward) {
        if (visited.has(l.a.device)) visited.add(l.b.device);
        if (visited.has(l.b.device)) visited.add(l.a.device);
      }
    assert.equal(visited.size, 6);
  }
});
