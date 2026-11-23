import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addLocation,
  parsePhysical,
  placeDevice,
  removeLocation,
  setCableLength,
} from "../src/network-studio/physical.ts";
import {
  exampleTopology,
  createDevice,
  connect,
  linkUp,
  linkStatus,
  removeDevice,
} from "../src/network-studio/model.ts";
import { dualStackLab, servicesLab } from "../src/network-studio/labs.ts";
import { learnedRoutes } from "../src/network-studio/routing.ts";
import { ping } from "../src/network-studio/engine.ts";
import { ping6 } from "../src/network-studio/ipv6Engine.ts";
import { requestDhcp } from "../src/network-studio/services.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
function closet(t) {
  t = addLocation(t, "City", null);
  const city = t.physical.locations.at(-1).id;
  t = addLocation(t, "Building", city);
  const building = t.physical.locations.at(-1).id;
  t = addLocation(t, "Closet A", building);
  return { t, city, building, location: t.physical.locations.at(-1).id };
}
test("physical hierarchy and rack/floor placement persist without changing logical identity", () => {
  let { t, location } = closet(exampleTopology());
  const original = t.devices[0];
  t = placeDevice(t, original.id, location, 1);
  t = placeDevice(t, t.devices[3].id, location, 0);
  assert.equal(t.devices[0], original);
  assert.equal(t.physical.placements.length, 2);
  assert.equal(ping(t, original.id, t.devices[2].ports[0].ip).ok, true);
  assert.deepEqual(parseTopology(serializeTopology(t)), t);
});
test("rack occupancy, hierarchy and occupied-location removal reject changes atomically", () => {
  let { t, location, city } = closet(exampleTopology());
  t = placeDevice(t, t.devices[0].id, location, 1);
  assert.throws(
    () => placeDevice(t, t.devices[1].id, location, 1),
    /already occupied/,
  );
  assert.equal(t.physical.placements.length, 1);
  assert.throws(() => removeLocation(t, location), /Move devices/);
  assert.throws(() => addLocation(t, "Impossible child", location), /Closets/);
  const malformed = structuredClone(t.physical);
  malformed.locations[0].parent = location;
  assert.throws(() => parsePhysical(malformed, t.devices), /hierarchy/);
  assert.throws(() => placeDevice(t, t.devices[1].id, city, 0), /closet/);
  for (const unit of [-1, 43, 1.5])
    assert.throws(() => placeDevice(t, t.devices[1].id, location, unit));
});
test("moving a device preserves its IP and deletion cleans placement, cables and DHCP lease bindings", () => {
  let { t, building, location } = closet(servicesLab());
  const id = t.devices[0].id;
  t = requestDhcp(t, id).topology;
  t = placeDevice(t, id, location, 1);
  const before = t;
  t = addLocation(t, "Closet B", building);
  const other = t.physical.locations.at(-1).id;
  t = placeDevice(t, id, other, 2);
  assert.equal(before.physical.placements[0].location, location);
  assert.equal(t.physical.placements[0].location, other);
  const removed = removeDevice(t, id);
  assert.equal(removed.physical.placements.length, 0);
  assert.equal(removed.links.length, 2);
  assert.equal(
    removed.devices.find((d) => d.kind === "server").services.dhcp.leases
      .length,
    0,
  );
  assert.deepEqual(parseTopology(serializeTopology(removed)), removed);
});
test("copper/fiber media budgets have exact operational boundaries and observable reasons", () => {
  let t = exampleTopology();
  const id = t.links[0].id;
  t = setCableLength(t, id, 100);
  assert.equal(linkUp(t, t.links[0]), true);
  t = setCableLength(t, id, 100.01);
  assert.equal(linkUp(t, t.links[0]), false);
  assert.match(linkStatus(t, t.links[0]).reason, /exceeds/);
  t = setCableLength(t, id);
  assert.equal("lengthMeters" in t.links[0], false);
  assert.equal(linkUp(t, t.links[0]), true);
  const a = createDevice("router", 1),
    b = createDevice("router", 2);
  let f = connect(
    { version: 1, name: "Fiber", devices: [a, b], links: [] },
    { device: a.id, port: "p2" },
    { device: b.id, port: "p2" },
    "fiber",
  );
  f = setCableLength(f, f.links[0].id, 10000);
  assert.equal(linkUp(f, f.links[0]), true);
  f = setCableLength(f, f.links[0].id, 10000.01);
  assert.equal(linkUp(f, f.links[0]), false);
  assert.deepEqual(parseTopology(serializeTopology(f)), f);
});
test("overlength links affect IPv4, IPv6, DHCP and learned routing through the shared Ethernet graph", () => {
  let t = dualStackLab();
  t = setCableLength(t, t.links[1].id, 101);
  assert.equal(ping(t, t.devices[0].id, "10.2.0.100").ok, false);
  assert.equal(ping6(t, t.devices[0].id, "2001:db8:20::100").ok, false);
  assert.equal(learnedRoutes(t, t.devices[1].id).length, 0);
  let s = servicesLab();
  s = setCableLength(s, s.links[0].id, 101);
  assert.equal(requestDhcp(s, s.devices[0].id).ok, false);
});
test("invalid physical references and cable lengths cannot enter from files", () => {
  const { t } = closet(exampleTopology());
  for (const value of [-1, Infinity, NaN, 1000001, "100", null]) {
    const raw = structuredClone(t);
    raw.links[0].lengthMeters = value;
    assert.throws(() => parseTopology(JSON.stringify(raw)));
  }
  const raw = structuredClone(t);
  raw.physical.placements = [
    { device: "unknown", location: raw.physical.locations.at(-1).id, unit: 0 },
  ];
  assert.throws(() => parseTopology(JSON.stringify(raw)), /existing device/);
});
