import assert from "node:assert/strict";
import { test } from "node:test";
import { command } from "../src/network-studio/cli.ts";
import { eigrpRepairLab } from "../src/network-studio/labs.ts";
import { eigrpTopology } from "../src/network-studio/routing.ts";
import { ping } from "../src/network-studio/engine.ts";

function setup() {
  let topology = eigrpRepairLab();
  const routers = topology.devices.filter((d) => d.kind === "router");
  const west = routers.find((d) => d.name === "EIGRP-West").id,
    east = routers.find((d) => d.name === "EIGRP-East").id;
  const sessions = new Map();
  return {
    west,
    east,
    get topology() {
      return topology;
    },
    device(id = west) {
      return topology.devices.find((d) => d.id === id);
    },
    run(input, id = west, error = false) {
      const result = command(
        topology,
        id,
        sessions.get(id) ?? { mode: "user", portId: null },
        input,
      );
      topology = result.topology;
      sessions.set(id, result.session);
      if (error) assert.match(result.output, /^%/, input);
      else
        assert.ok(!result.output.startsWith("%"), input + ": " + result.output);
      return result;
    },
    config(id = west) {
      const mode = sessions.get(id)?.mode ?? "user";
      if (mode === "user") this.run("enable", id);
      else if (mode !== "privileged") this.run("end", id);
      this.run("configure terminal", id);
    },
  };
}

test("EIGRP CLI repairs AS mismatch and exposes operational neighbors, interfaces and D routes", () => {
  const c = setup();
  c.run("enable");
  assert.match(c.run("show ip protocols").output, /eigrp AS 10/);
  c.config(c.east);
  c.run("router eigrp 10", c.east);
  c.run("no auto-summary", c.east);
  c.run("end", c.east);
  assert.match(c.run("show ip eigrp neighbors").output, /EIGRP IPv4 AS 10/);
  assert.match(c.run("show ip eigrp interfaces").output, /Kbit\/s/);
  assert.match(c.run("show ip eigrp topology").output, /minimum BW/);
  assert.match(c.run("show ip route").output, /D .*\[90\/\d+\]/);
  const pcs = c.topology.devices.filter((d) => d.kind === "pc");
  assert.equal(ping(c.topology, pcs[0].id, pcs[1].ports[0].ip).ok, true);
});

test("EIGRP network wildcard, passive interface, router ID and process removal roundtrip through CLI", () => {
  const c = setup();
  c.config();
  c.run("router eigrp 77");
  c.run("network 172.16.10.9 0.0.0.255");
  c.run("network 192.168.7.1");
  c.run("network 203.0.113.9 0.0.0.0");
  c.run("eigrp router-id 1.2.3.4");
  const name = c.device().ports[0].name;
  c.run("passive-interface " + name);
  c.run("end");
  const config = c.run("show running-config").output;
  assert.match(config, /router eigrp 77/);
  assert.match(config, /network 172\.16\.10\.0 0\.0\.0\.255/);
  assert.match(config, /network 192\.168\.7\.0 0\.0\.0\.255/);
  assert.match(config, /network 203\.0\.113\.9 0\.0\.0\.0/);
  assert.match(config, /eigrp router-id 1\.2\.3\.4/);
  c.config();
  c.run("router eigrp 77");
  c.run("no passive-interface " + name);
  c.run("no eigrp router-id");
  c.run("no network 203.0.113.9 0.0.0.0");
  assert.equal(
    c.device().routing.passivePorts.includes(c.device().ports[0].id),
    false,
  );
  assert.equal(c.device().routing.routerId, "");
  assert.ok(
    !c.device().routing.networks.some((n) => n.network === "203.0.113.9"),
  );
  c.run("exit");
  c.run("no router eigrp 76");
  assert.equal(c.device().routing.protocol, "eigrp");
  c.run("no router eigrp 77");
  assert.equal(c.device().routing.protocol, "none");
  c.run("end");
  assert.equal(c.run("show ip eigrp topology").output, "EIGRP is not enabled.");
});

test("EIGRP CLI rejects invalid AS, wildcard, custom K and unsupported summarization atomically", () => {
  const c = setup();
  c.config();
  let before = JSON.stringify(c.topology);
  for (const as of ["0", "65536"]) {
    c.run("router eigrp " + as, c.west, true);
    assert.equal(JSON.stringify(c.topology), before);
  }
  c.run("router eigrp 10");
  before = JSON.stringify(c.topology);
  for (const input of [
    "network 10.1.1.1 0.255.0.255",
    "eigrp router-id 999.1.1.1",
    "auto-summary",
    "metric weights 0 1 1 1 0 0",
  ]) {
    c.run(input, c.west, true);
    assert.equal(JSON.stringify(c.topology), before, input);
  }
  c.run("metric weights 0 1 0 1 0 0");
});

test("interface metrics are bounded, persist in running/startup configuration and reset to defaults", () => {
  const c = setup();
  c.config();
  c.run("interface " + c.device().ports[1].name);
  c.run("bandwidth 10000");
  c.run("delay 250");
  const before = JSON.stringify(c.topology);
  for (const input of [
    "bandwidth 0",
    "bandwidth 2147483648",
    "delay 0",
    "delay 16777216",
    "delay 1.5",
  ]) {
    c.run(input, c.west, true);
    assert.equal(JSON.stringify(c.topology), before, input);
  }
  c.run("end");
  assert.match(
    c.run("show running-config").output,
    /bandwidth 10000\n delay 250/,
  );
  c.run("write memory");
  c.config();
  c.run("interface " + c.device().ports[1].name);
  c.run("no bandwidth");
  c.run("no delay");
  assert.equal(c.device().ports[1].bandwidth, undefined);
  assert.equal(c.device().ports[1].delay, undefined);
  c.run("end");
  c.run("reload");
  assert.equal(c.device().ports[1].bandwidth, 10000);
  assert.equal(c.device().ports[1].delay, 250);
});

test("passive transit removes neighbors and learned routes while passive LAN remains advertised", () => {
  const c = setup();
  c.config(c.east);
  c.run("router eigrp 10", c.east);
  c.run("passive-interface " + c.device(c.east).ports[0].name, c.east);
  assert.ok(eigrpTopology(c.topology, c.west).length);
  c.config();
  c.run("router eigrp 10");
  for (const port of c.device().ports.slice(1))
    c.run("passive-interface " + port.name);
  c.run("end");
  assert.match(c.run("show ip eigrp neighbors").output, /No EIGRP neighbors/);
  assert.equal(eigrpTopology(c.topology, c.west).length, 0);
});
