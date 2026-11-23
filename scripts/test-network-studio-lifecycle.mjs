import assert from "node:assert/strict";
import { test } from "node:test";
import { ping6 } from "../src/network-studio/ipv6Engine.ts";
import { routingNeighbors } from "../src/network-studio/routing.ts";
import { createRuntime } from "../src/network-studio/networkRuntime.ts";
import { serialRole, linkStatus } from "../src/network-studio/model.ts";
import {
  routingLab,
  servicesLab,
  serialWanLab,
} from "../src/network-studio/labs.ts";
import {
  saveStartup,
  reloadDevice,
  eraseStartup,
} from "../src/network-studio/deviceLifecycle.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
import { requestDhcp } from "../src/network-studio/services.ts";
import { command, INITIAL_CLI } from "../src/network-studio/cli.ts";
import {
  changeModule,
  automaticConnection,
} from "../src/network-studio/hardware.ts";
import { ping } from "../src/network-studio/engine.ts";
import { connect, createDevice } from "../src/network-studio/model.ts";
import { defaultServices } from "../src/network-studio/extensions.ts";
test("workspace byte budget covers startup copies and prevents exporting unreadable oversized state", () => {
  const t = { version: 1, name: "Capacity boundary", devices: [], links: [] };
  for (let i = 0; i < 8; i++) {
    const d = createDevice("server", i + 1);
    d.ports[0].ip = `10.0.0.${i + 1}`;
    d.services = defaultServices();
    d.services.http.pages = Array.from({ length: 16 }, (_, p) => ({
      path: `/p${p}`,
      body: "x".repeat(16384),
    }));
    t.devices.push(d);
  }
  const below = { ...t, devices: t.devices.slice(0, 7) };
  assert.deepEqual(parseTopology(serializeTopology(below)), below);
  assert.throws(() => serializeTopology(t), /2 MiB/);
  const copied = structuredClone(below);
  copied.devices[0] = saveStartup(copied.devices[0]);
  assert.throws(() => serializeTopology(copied), /2 MiB/);
});
test("startup snapshot is independent and reload preserves identity/hardware/position while restoring configuration", () => {
  const original = routingLab().devices[1],
    saved = saveStartup(original),
    edited = structuredClone(saved);
  edited.ports[0].ip = "10.9.0.1";
  edited.name = "Unsaved";
  edited.x = 980;
  edited.note = "Rack note";
  edited.powered = false;
  assert.equal(saved.startupConfig.ports[0].ip, "10.1.0.1");
  const loaded = reloadDevice(edited);
  assert.equal(loaded.name, original.name);
  assert.equal(loaded.ports[0].ip, "10.1.0.1");
  assert.equal(loaded.id, original.id);
  assert.equal(loaded.x, 980);
  assert.equal(loaded.note, "Rack note");
  assert.equal(loaded.powered, true);
  assert.deepEqual(
    loaded.ports.map((p) => [p.id, p.name, p.media]),
    original.ports.map((p) => [p.id, p.name, p.media]),
  );
  const factory = reloadDevice(eraseStartup(loaded));
  assert.equal(factory.ports[0].ip, "");
  assert.equal(factory.name, "Router");
  assert.equal(factory.routing, undefined);
  assert.equal(factory.id, original.id);
});
test("startup reload clears transient DHCP state, with the configured DHCP client mode preserved", () => {
  const lab = servicesLab(),
    leased = requestDhcp(lab, lab.devices[0].id).topology;
  const client = reloadDevice(saveStartup(leased.devices[0]));
  assert.equal(client.ports[0].addressMode, "dhcp");
  assert.equal(client.ports[0].ip, "");
  assert.equal(client.gateway, "");
  const server = leased.devices[3],
    saved = saveStartup(server);
  assert.equal(saved.startupConfig.services.dhcp.leases.length, 0);
  assert.equal(server.services.dhcp.leases.length, 1);
  assert.equal(reloadDevice(saved).services.dhcp.leases.length, 0);
});
test("startup files round-trip and reject nested snapshots, identity changes and hardware changes", () => {
  const t = routingLab();
  t.devices[1] = saveStartup(t.devices[1]);
  assert.deepEqual(parseTopology(serializeTopology(t)), t);
  for (const mutate of [
    (s) => (s.startupConfig = {}),
    (s) => (s.id = "injected"),
    (s) => (s.ports[0].media = "fiber"),
    (s) => (s.ports[0].id = "changed"),
    (s) => (s.ports[0].ip = "broken"),
  ]) {
    const raw = structuredClone(t);
    mutate(raw.devices[1].startupConfig);
    assert.throws(() => parseTopology(serializeTopology(raw)));
  }
});
test("privileged lifecycle CLI actually saves, restores and erases configurations", () => {
  let t = routingLab(),
    session = INITIAL_CLI;
  const id = t.devices[1].id;
  const run = (line) => {
    const r = command(t, id, session, line);
    t = r.topology;
    session = r.session;
    return r;
  };
  assert.equal(run("reload").changed, false);
  run("enable");
  assert.match(run("write memory").output, /\[OK\]/);
  run("configure terminal");
  run("hostname Unsaved");
  run("end");
  assert.match(run("reload").output, /startup configuration/);
  assert.equal(session.mode, "user");
  assert.equal(t.devices[1].name, "Router-1");
  run("enable");
  run("erase startup-config");
  run("reload");
  assert.equal(t.devices[1].name, "Router");
  assert.equal(t.devices[1].routing, undefined);
  assert.equal(t.devices[1].ports[0].ip, "");
});

test("expansion ports carry traffic, keep startup settings separate and detach their dependencies", () => {
  const t = routingLab(),
    [left, router, peer] = t.devices;
  assert.throws(() => changeModule(t, router.id, 1, "fiber"), /Power off/);
  t.devices[1] = saveStartup(router);
  t.devices[1].powered = false;
  let changed = changeModule(t, router.id, 1, "fiber");
  const installed = changed.devices[1].ports.at(-1);
  assert.equal(installed.media, "fiber");
  assert.equal(t.devices[1].ports.length, 3);
  changed.devices[1].powered = true;
  installed.ip = "198.51.100.1";
  changed.devices[2].ports[2].ip = "198.51.100.2";
  const other = { device: peer.id, port: "p2" };
  changed = connect(
    changed,
    { device: router.id, port: installed.id },
    other,
    "fiber",
  );
  assert.equal(
    ping(changed, router.id, changed.devices[2].ports[2].ip).ok,
    true,
  );
  assert.equal(reloadDevice(changed.devices[1]).ports.at(-1).ip, "");
  assert.equal(
    reloadDevice(eraseStartup(changed.devices[1])).ports.at(-1).slot,
    1,
  );
  const device = changed.devices[1];
  device.callManager = { address: installed.ip, lines: [] };
  device.routing.passivePorts.push(installed.id);
  changed.devices[1] = saveStartup(device);
  changed.devices[1].powered = false;
  changed.pdus = [
    {
      id: "probe",
      source: left.id,
      target: device.id,
      port: installed.id,
      protocol: "icmp",
    },
  ];
  const reconstructed = parseTopology(serializeTopology(changed));
  assert.deepEqual(reconstructed, changed);
  const removed = changeModule(reconstructed, router.id, 1, null);
  const after = removed.devices[1];
  assert.equal(removed.links.length, 3);
  assert.equal(removed.pdus.length, 0);
  assert.equal(after.startupConfig.callManager, undefined);
  assert.equal(after.callManager, undefined);
  assert.ok(!after.routing.passivePorts.includes(installed.id));
  assert.equal(after.startupConfig.ports.length, 3);
  assert.equal(after.startupConfig.ports[0].ip, router.ports[0].ip);
  assert.deepEqual(parseTopology(serializeTopology(removed)), removed);
  const broken = structuredClone(changed);
  delete broken.devices[1].startupConfig.ports.at(-1).slot;
  assert.throws(() => parseTopology(JSON.stringify(broken)), /hardware/);
  const tampered = structuredClone(changed);
  tampered.devices[1].ports.at(-1).slot = 9;
  assert.throws(() => parseTopology(JSON.stringify(tampered)));
});

test("auto-connect finds common unoccupied media, prefers enabled ports and reports exhaustion", () => {
  const t = routingLab(),
    [, a, b] = t.devices;
  assert.deepEqual(automaticConnection(t, a, b), {
    a: { device: a.id, port: "p2" },
    b: { device: b.id, port: "p2" },
    cable: "fiber",
  });
  const wired = connect(
    t,
    { device: a.id, port: "p2" },
    { device: b.id, port: "p2" },
    "fiber",
  );
  assert.equal(automaticConnection(wired, a, b), null);
  const fresh = { ...t, links: [] };
  a.ports[0].enabled = false;
  assert.equal(automaticConnection(fresh, a, b).a.port, "p1");
  assert.equal(automaticConnection(fresh, a, a), null);
  a.powered = false;
  const expanded = changeModule(fresh, a.id, 1, "copper");
  assert.throws(() => changeModule(expanded, a.id, 1, "fiber"), /installed/);
});

test("serial DCE supplies the line clock and routes both address families without Ethernet resolution", () => {
  const t = serialWanLab(),
    [client, a, b, server] = t.devices,
    link = t.links.find((l) => l.cable === "serial"),
    r = createRuntime();
  assert.deepEqual(parseTopology(serializeTopology(t)), t);
  const sender = (protocol) =>
    protocol === "ipv4"
      ? ping(t, client.id, server.ports[0].ip, r)
      : ping6(t, client.id, server.ports[0].ipv6, undefined, r);
  for (const family of ["ipv4", "ipv6"]) {
    const result = sender(family);
    assert.equal(result.ok, true, result.message);
    assert.ok(
      result.events.some(
        (e) =>
          e.from === a.id &&
          e.to === b.id &&
          (e.protocol === "ICMP" || e.protocol === "ICMPv6"),
      ),
    );
    assert.ok(
      !result.events.some(
        (e) =>
          e.from === a.id &&
          e.to === b.id &&
          (e.protocol === "ARP" || e.protocol === "NDP"),
      ),
    );
  }
  assert.equal(
    r.addressBindings.some((e) => e.port === "module-1"),
    false,
  );
  assert.equal(routingNeighbors(t, a.id).length, 1);
  assert.equal(serialRole(t, a.id, link.a.port), "DCE");
  assert.match(
    command(t, b.id, INITIAL_CLI, "show controllers Serial1/0").output,
    /DTE[\s\S]*64000/,
  );
  link.dce = "b";
  assert.equal(linkStatus(t, link).up, false);
  assert.equal(routingNeighbors(t, a.id).length, 0);
  assert.equal(sender("ipv4").ok, false);
  const port = { mode: "interface", portId: "module-1" };
  assert.equal(command(t, b.id, port, "clock rate 123").changed, false);
  const next = command(t, b.id, port, "clock rate 128000").topology;
  assert.equal(linkStatus(next, next.links.at(-1)).up, true);
  assert.ok(ping(next, client.id, server.ports[0].ip).ok);
  assert.match(
    command(
      next,
      b.id,
      { mode: "privileged", portId: null },
      "show running-config",
    ).output,
    /clock rate 128000/,
  );
  assert.equal(
    ping(
      command(next, b.id, port, "no clock rate").topology,
      client.id,
      server.ports[0].ip,
    ).ok,
    false,
  );
  const off = structuredClone(next);
  off.devices[2].powered = false;
  assert.equal(linkStatus(off, link).up, false);
});

test("serial clock, cable orientation and hardware model are validated before import", () => {
  for (const mutate of [
    (t) => {
      t.links[0].dce = "b";
    },
    (t) => {
      t.links.at(-1).dce = "middle";
    },
    (t) => {
      t.devices[1].ports[0].clockRate = 64000;
    },
    (t) => {
      t.devices[1].ports.at(-1).clockRate = 0;
    },
    (t) => {
      t.devices[0].ports[0].media = "serial";
    },
  ]) {
    const t = serialWanLab();
    mutate(t);
    assert.throws(() => parseTopology(JSON.stringify(t)));
  }
});
