import assert from "node:assert/strict";
import { test } from "node:test";
import { natLab, natPoolsLab } from "../src/network-studio/labs.ts";
import { ping } from "../src/network-studio/engine.ts";
import { httpRequest } from "../src/network-studio/services.ts";
import {
  createRuntime,
  advanceRuntime,
  clearNat,
} from "../src/network-studio/networkRuntime.ts";
import { natInbound } from "../src/network-studio/nat.ts";
import {
  parseTopology,
  serializeTopology,
} from "../src/network-studio/persistence.ts";
import {
  saveStartup,
  reloadDevice,
} from "../src/network-studio/deviceLifecycle.ts";
function lab() {
  const t = natLab();
  t.devices[4].nat.hairpin = true;
  return t;
}
test("hairpin same-LAN static ICMP and HTTP restore original public tuple", () => {
  const t = lab(),
    r = createRuntime();
  t.devices[2].gateway = "";
  for (const ip of ["203.0.113.100"]) {
    const result = ping(t, t.devices[0].id, ip, r);
    assert.equal(result.ok, true, result.message);
    const http = httpRequest(t, t.devices[0].id, `http://${ip}/`, r);
    assert.equal(http.ok, true, JSON.stringify(http));
  }
  assert.equal(r.hairpin.length, 2);
  assert.equal(r.hairpin[0].snatIp, "192.168.50.1");
});
test("hairpin is opt-in and requires inside target egress", () => {
  const t = natLab(),
    r = createRuntime();
  assert.equal(ping(t, t.devices[0].id, "203.0.113.100", r).ok, false);
  t.devices[4].nat.hairpin = true;
  t.devices[4].ports[0].natRole = "outside";
  assert.equal(ping(t, t.devices[0].id, "203.0.113.100", r).ok, false);
});
test("hairpin port forwarding, two clients, own public alias and idle expiry", () => {
  const t = lab(),
    r = createRuntime(),
    d = t.devices[4];
  d.nat.static = [];
  d.nat.portForwards = [
    {
      protocol: "tcp",
      inside: "192.168.50.100",
      insidePort: 80,
      outside: "203.0.113.100",
      outsidePort: 8080,
    },
  ];
  for (const client of [t.devices[0], t.devices[1], t.devices[2]]) {
    const result = httpRequest(t, client.id, "http://203.0.113.100:8080/", r);
    assert.equal(result.ok, true, JSON.stringify(result));
  }
  assert.equal(new Set(r.hairpin.map((e) => e.snatPort)).size, 3);
  advanceRuntime(r, t, 299);
  assert.equal(r.hairpin.length, 3);
  advanceRuntime(r, t, 1);
  assert.equal(r.hairpin.length, 0);
  const stale = natInbound(
    d,
    d.ports[0],
    {
      protocol: "tcp",
      sourceIp: "192.168.50.100",
      sourcePort: 80,
      destinationIp: "192.168.50.1",
      destinationPort: 20000,
    },
    r,
  );
  assert.match(stale.error, /No active hairpin/);
});
test("hairpin one-to-one pool aliases require an active address binding", () => {
  const t = natPoolsLab(),
    r = createRuntime(),
    d = t.devices[4];
  d.nat.hairpin = true;
  d.nat.static = [];
  assert.equal(ping(t, t.devices[0].id, "203.0.113.10", r).ok, false);
  clearNat(r);
  assert.equal(ping(t, t.devices[2].id, "203.0.113.200", r).ok, true);
  const result = httpRequest(t, t.devices[0].id, "http://203.0.113.10/", r);
  assert.equal(result.ok, true, JSON.stringify(result));
  advanceRuntime(r, t, 299);
  httpRequest(t, t.devices[0].id, "http://203.0.113.10/", r);
  advanceRuntime(r, t, 2);
  assert.equal(r.poolBindings.length, 1);
  clearNat(r, d.id);
  assert.equal(r.hairpin.length, 0);
  assert.equal(r.poolBindings.length, 0);
});
test("hairpin configuration round-trips and runtime never persists", () => {
  const t = lab(),
    r = createRuntime();
  ping(t, t.devices[0].id, "203.0.113.100", r);
  const text = serializeTopology(t);
  assert.equal(parseTopology(text).devices[4].nat.hairpin, true);
  assert.ok(!text.includes("snatPort"));
  const bad = structuredClone(t);
  bad.devices[4].nat.hairpin = "yes";
  assert.throws(() => parseTopology(JSON.stringify(bad)));
  const saved = saveStartup(t.devices[4]);
  assert.equal(reloadDevice(saved).nat.hairpin, true);
});
import { probeIPv4 } from "../src/network-studio/engine.ts";
import { command } from "../src/network-studio/cli.ts";
test("hairpin across different inside LANs uses server-facing source and survives outside link down", () => {
  const t = lab(),
    r = createRuntime(),
    d = t.devices[4],
    server = t.devices[2];
  t.links = t.links.filter(
    (l) => l.a.device !== server.id && l.b.device !== server.id,
  );
  server.ports[0].ip = "192.168.60.100";
  server.gateway = "";
  d.ports[2].ip = "192.168.60.1";
  d.ports[2].natRole = "inside";
  d.ports[2].media = "copper";
  d.nat.static[0].inside = server.ports[0].ip;
  d.ports[1].enabled = false;
  t.links.push({
    id: "hairpin-direct",
    a: { device: d.id, port: d.ports[2].id },
    b: { device: server.id, port: server.ports[0].id },
    cable: "copper",
  });
  const result = httpRequest(t, t.devices[0].id, "http://203.0.113.100/", r);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(r.hairpin[0].snatIp, "192.168.60.1");
});
test("hairpin UDP expires at 60 seconds; forged reverse endpoints are rejected", () => {
  const t = lab(),
    r = createRuntime(),
    d = t.devices[4];
  const result = probeIPv4(t, t.devices[0].id, "203.0.113.100", "udp", 53, r);
  assert.equal(result.ok, true, result.message);
  const session = r.hairpin[0];
  assert.ok(session);
  const wrong = natInbound(
    d,
    d.ports[0],
    {
      protocol: "udp",
      sourceIp: "192.168.50.11",
      sourcePort: 53,
      destinationIp: session.snatIp,
      destinationPort: session.snatPort,
    },
    r,
  );
  assert.match(wrong.error, /No active/);
  advanceRuntime(r, t, 59);
  assert.equal(r.hairpin.length, 1);
  advanceRuntime(r, t, 1);
  assert.equal(r.hairpin.length, 0);
});
test("hairpin output ACL sees translated source and target; input ACL sees public target", () => {
  const t = lab(),
    r = createRuntime(),
    d = t.devices[4];
  d.accessLists.push({
    name: "block-reflected",
    rules: [
      {
        action: "deny",
        protocol: "ip",
        source: "192.168.50.1",
        sourcePrefix: 32,
        destination: "192.168.50.100",
        destinationPrefix: 32,
      },
    ],
  });
  d.ports[0].outboundAcl = "block-reflected";
  const denied = ping(t, t.devices[0].id, "203.0.113.100", r);
  assert.equal(denied.ok, false);
  assert.ok(
    denied.events.some(
      (e) => e.protocol === "ACL" && e.detail.includes("deny"),
    ),
  );
  delete d.ports[0].outboundAcl;
  d.ports[0].inboundAcl = "block-public";
  d.accessLists.push({
    name: "block-public",
    rules: [
      {
        action: "deny",
        protocol: "ip",
        source: "192.168.50.10",
        sourcePrefix: 32,
        destination: "203.0.113.100",
        destinationPrefix: 32,
      },
    ],
  });
  const inbound = ping(t, t.devices[0].id, "203.0.113.100", r);
  assert.equal(inbound.ok, false);
  assert.ok(!inbound.events.some((e) => e.protocol === "NAT"));
});

test("hairpin CLI extension configures, reports and clears real translations", () => {
  let t = natLab(),
    session = { mode: "config", portId: null };
  const r = createRuntime(),
    id = t.devices[4].id;
  const run = (line) => {
    const out = command(t, id, session, line, r);
    t = out.topology;
    session = out.session;
    return out;
  };
  assert.equal(run("ip nat hairpin enable").changed, true);
  run("end");
  assert.equal(ping(t, t.devices[0].id, "203.0.113.100", r).ok, true);
  assert.match(run("show ip nat translations").output, /hairpin icmp/);
  assert.match(
    run("show ip nat statistics").output,
    /Active dynamic translations: 1/,
  );
  run("clear ip nat translation *");
  assert.equal(r.hairpin.length, 0);
  run("configure terminal");
  assert.equal(run("no ip nat hairpin enable").changed, true);
  assert.equal(t.devices[4].nat.hairpin, false);
});
