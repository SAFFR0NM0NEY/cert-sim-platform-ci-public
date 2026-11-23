import { captureActivity } from "./activity.ts";
import { modulePort } from "./hardware.ts";
import { interfaceMac } from "./ethernet.ts";
import { connect, createDevice, exampleTopology } from "./model.ts";
import { defaultRouting, defaultServices } from "./extensions.ts";
import type { Topology } from "./types.ts";
import { createSubinterface, createSvi } from "./vlanInterfaces.ts";
import { materializeVlans, setSwitchport, setVlan, setVtp } from "./vlans.ts";
import { synchronizeVtp } from "./vtp.ts";
import { setChannelGroup } from "./etherChannel.ts";

export function nativePolicyLab(): Topology {
  const client = createDevice("pc", 1, 160, 220);
  client.name = "Lease-Client";
  client.gateway = "10.1.0.1";
  client.ports[0].ip = "10.1.0.10";
  client.note =
    "Request a DHCP lease, then ping 10.2.0.100. The router allows DHCP but initially blocks this ping.";
  const router = createDevice("router", 1, 500, 220);
  router.name = "Policy-Router";
  router.ports = router.ports.slice(0, 2);
  Object.assign(router.ports[0], {
    ip: "10.1.0.1",
    helperAddresses: ["10.2.0.100"],
    inboundAcl: "CLIENT-POLICY",
  });
  Object.assign(router.ports[1], {
    ip: "10.2.0.1",
    outboundAcl: "CLIENT-POLICY",
  });
  router.accessLists = [
    {
      name: "CLIENT-POLICY",
      rules: [
        {
          action: "deny",
          protocol: "icmp",
          source: "10.1.0.0",
          sourcePrefix: 24,
          destination: "10.2.0.100",
          destinationPrefix: 32,
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
    },
  ];
  router.note =
    "Open Policy and move rule 2 above rule 1, then Apply policy. Repeat the ping to see how rule order changes forwarding. Save and reopen a native copy to retain the policy.";
  const server = createDevice("server", 1, 840, 220);
  server.name = "DHCP-Server";
  server.gateway = "10.2.0.1";
  server.ports[0].ip = "10.2.0.100";
  server.services = {
    dhcp: {
      enabled: true,
      pools: [
        {
          id: "pool-clients",
          name: "Clients",
          start: "10.1.0.50",
          prefix: 24,
          count: 8,
          gateway: "10.1.0.1",
          dns: "",
        },
      ],
      leases: [],
    },
    dns: { enabled: false, records: [] },
    http: { enabled: false, pages: [] },
  };
  server.note =
    "Services contains the relayed client pool. Change its starting address to 10.1.0.60 and request another lease. Native copies retain pool settings; runtime lease history starts fresh.";
  let topology: Topology = {
    version: 1,
    name: "DHCP and ACL · native file practice",
    devices: [client, router, server],
    links: [],
  };
  topology = connect(
    topology,
    { device: client.id, port: "p0" },
    { device: router.id, port: "p0" },
    "copper",
  );
  return connect(
    topology,
    { device: router.id, port: "p1" },
    { device: server.id, port: "p0" },
    "copper",
  );
}

export function etherChannelLab(): Topology {
  let left = setVlan(
    setVlan(createDevice("switch", 1, 360, 260), 10, { name: "Students" }),
    20,
    { name: "Staff" },
  );
  let right = setVlan(
    setVlan(createDevice("switch", 2, 740, 260), 10, { name: "Students" }),
    20,
    { name: "Staff" },
  );
  left.name = "Channel-West";
  right.name = "Channel-East";
  left.spanningTree = {
    priorities: [
      { vlan: 10, priority: 0 },
      { vlan: 20, priority: 0 },
    ],
  };
  const hosts = [
    createDevice("pc", 1, 130, 130),
    createDevice("pc", 2, 970, 130),
    createDevice("pc", 3, 130, 420),
    createDevice("pc", 4, 970, 420),
  ];
  for (const [i, host] of hosts.entries()) {
    host.name = ["Student-West", "Student-East", "Staff-West", "Staff-East"][i];
    host.ports[0].ip = `192.168.${i < 2 ? 10 : 20}.${(i % 2) + 10}`;
  }
  for (const sw of [left, right]) {
    sw.ports[0].vlan = 10;
    sw.ports[1].vlan = 20;
    for (const p of sw.ports.slice(6, 8))
      Object.assign(p, { mode: "trunk", allowedVlans: [10, 20] });
    sw.note =
      "Two VLANs share a two-member LACP trunk. Disable one member, then ping the peer again. Configure VLANs on Port-channel1; cables remain on GigabitEthernet0/6 and 0/7.";
  }
  left = setChannelGroup(left, ["p6", "p7"], 1, "active");
  right = setChannelGroup(right, ["p6", "p7"], 1, "passive");
  let t: Topology = {
    version: 1,
    name: "EtherChannel · LACP and failover",
    devices: [left, right, ...hosts],
    links: [],
  };
  for (const port of ["p6", "p7"])
    t = connect(
      t,
      { device: left.id, port },
      { device: right.id, port },
      "copper",
    );
  for (const [i, host] of hosts.entries())
    t = connect(
      t,
      { device: host.id, port: "p0" },
      { device: i % 2 ? right.id : left.id, port: i < 2 ? "p0" : "p1" },
      "copper",
    );
  return t;
}

export function etherChannelRepairLab(): Topology {
  const t = etherChannelLab();
  t.name = "Repair EtherChannel · PAgP negotiation";
  t.devices = t.devices.map((d) =>
    d.kind !== "switch"
      ? d
      : {
          ...d,
          ports: d.ports.map((p) =>
            p.channelGroup
              ? {
                  ...p,
                  channelGroup: { ...p.channelGroup, mode: "auto" as const },
                }
              : p,
          ),
          note: "Both ends use PAgP auto, so neither initiates negotiation. Change both members on one switch to desirable, apply, and inspect the bundle. Check forwarding before and after repair.",
        },
  );
  return t;
}

export function dtpRepairLab(): Topology {
  const left = setVlan(createDevice("switch", 1, 360, 260), 10, {
    name: "Students",
  });
  const right = setVlan(createDevice("switch", 2, 740, 260), 10, {
    name: "Students",
  });
  left.name = "DTP-West";
  right.name = "DTP-East";
  const hosts = [
    createDevice("pc", 1, 130, 260),
    createDevice("pc", 2, 970, 260),
  ];
  for (const [i, host] of hosts.entries()) {
    host.name = i ? "Student-East" : "Student-West";
    host.ports[0].ip = `192.168.10.${10 + i}`;
  }
  for (const sw of [left, right]) {
    sw.ports[0].vlan = 10;
    Object.assign(sw.ports[6], {
      mode: "dynamic-auto",
      allowedVlans: [1, 10],
      nativeVlan: 1,
    });
    sw.note =
      "Both uplinks use dynamic auto, so VLAN 10 cannot cross the access link. Select GigabitEthernet0/6 and change one side to Dynamic desirable. Apply, inspect the negotiated trunk and ping the other student again. The access VLAN remains 1.";
  }
  let topology: Topology = {
    version: 1,
    name: "Repair DTP · Dynamic trunk negotiation",
    devices: [left, right, ...hosts],
    links: [],
  };
  topology = connect(
    topology,
    { device: left.id, port: "p6" },
    { device: right.id, port: "p6" },
    "copper",
  );
  for (const [i, host] of hosts.entries())
    topology = connect(
      topology,
      { device: host.id, port: "p0" },
      { device: i ? right.id : left.id, port: "p0" },
      "copper",
    );
  return topology;
}

export function eigrpRepairLab(): Topology {
  const west = createDevice("router", 1, 330, 270);
  const east = createDevice("router", 2, 800, 270);
  const upper = createDevice("router", 3, 565, 100);
  const lower = createDevice("router", 4, 565, 440);
  const hosts = [
    createDevice("pc", 1, 110, 270),
    createDevice("pc", 2, 1020, 270),
  ];
  for (const [i, router] of [west, east, upper, lower].entries()) {
    router.name = ["EIGRP-West", "EIGRP-East", "EIGRP-Upper", "EIGRP-Lower"][i];
    router.routing = {
      ...defaultRouting(),
      protocol: "eigrp",
      processId: router === east ? 99 : 10,
      networks: [
        { network: "10.0.0.0", prefix: 8, area: 0 },
        { network: "192.0.2.0", prefix: 24, area: 0 },
      ],
      passivePorts: router === west || router === east ? ["p0"] : [],
    };
  }
  for (const [i, host] of hosts.entries()) {
    host.name = i ? "Student-East" : "Student-West";
    host.ports[0].ip = `10.${i ? 20 : 10}.${i ? 20 : 10}.10`;
    host.gateway = `10.${i ? 20 : 10}.${i ? 20 : 10}.1`;
    host.note =
      "Ping the student on the other LAN before and after repairing the EIGRP autonomous system mismatch.";
  }
  west.ports[0].ip = hosts[0].gateway;
  east.ports[0].ip = hosts[1].gateway;
  const transits = [
    [west, 1, "192.0.2.1", 10],
    [upper, 0, "192.0.2.2", 10],
    [upper, 2, "192.0.2.5", 10],
    [east, 2, "192.0.2.6", 10],
    [west, 2, "192.0.2.9", 100],
    [lower, 2, "192.0.2.10", 100],
    [lower, 0, "192.0.2.13", 100],
    [east, 1, "192.0.2.14", 100],
  ] as const;
  for (const [router, index, ip, delay] of transits)
    Object.assign(router.ports[index], {
      ip,
      prefix: 30,
      bandwidth: 1_000_000,
      delay,
    });
  east.note =
    "Repair: the other routers use EIGRP AS 10. Open Routing, change Autonomous system (AS) from 99 to 10 and Apply routing. Ping Student-East at 10.20.20.10 from Student-West.";
  west.note =
    "After AS repair, inspect 10.20.20.0/24. Set delay to 1000 (10 µs units) on 192.0.2.1 to prefer the lower path. Disable fiber interface 192.0.2.9 to fail over to the upper path. Find ports by IP; native chassis use different interface names.";
  upper.note =
    "Upper path: both transit interfaces use bandwidth 1000000 Kbit/s and delay 10 (10 µs units). EIGRP uses the minimum path bandwidth and cumulative delay.";
  lower.note =
    "Backup path: both transit interfaces use bandwidth 1000000 Kbit/s and delay 100 (10 µs units). Change an interface metric or link state, then inspect the selected route on EIGRP-West.";
  let topology: Topology = {
    version: 1,
    name: "Repair EIGRP · AS, metrics and failover",
    devices: [east, west, upper, lower, ...hosts],
    links: [],
  };
  for (const [a, ap, b, bp, cable] of [
    [west, "p1", upper, "p0", "copper"],
    [upper, "p2", east, "p2", "fiber"],
    [west, "p2", lower, "p2", "fiber"],
    [lower, "p0", east, "p1", "copper"],
    [west, "p0", hosts[0], "p0", "copper"],
    [east, "p0", hosts[1], "p0", "copper"],
  ] as const)
    topology = connect(
      topology,
      { device: a.id, port: ap },
      { device: b.id, port: bp },
      cable,
    );
  return topology;
}

function vlanRoutingLab(multilayer: boolean): Topology {
  const client = createDevice("pc", 1, 140, 130);
  const peer = createDevice("pc", 2, 140, 380);
  const sw = createDevice("switch", 1, 460, 260);
  const server = createDevice("server", 1, 850, 420);
  const router = createDevice("router", 1, 850, 130);
  const gateway = multilayer ? sw : router;
  client.ports[0].addressMode = "dhcp";
  client.note = "VLAN 10. Request a DHCP lease, then browse certsim.lab.";
  peer.ports[0].ip = "192.168.20.20";
  peer.gateway = "192.168.20.1";
  peer.note = "VLAN 20. The client policy blocks ICMP from VLAN 10.";
  server.ports[0].ip = "192.168.30.100";
  server.gateway = "192.168.30.1";
  server.services = defaultServices();
  server.services.dhcp = {
    enabled: true,
    leases: [],
    pools: [
      {
        id: "vlan10",
        name: "VLAN 10 clients",
        start: "192.168.10.50",
        prefix: 24,
        count: 20,
        gateway: "192.168.10.1",
        dns: server.ports[0].ip,
      },
    ],
  };
  server.services.dns = {
    enabled: true,
    records: [{ name: "certsim.lab", type: "A", value: server.ports[0].ip }],
  };
  server.services.http = {
    enabled: true,
    pages: [
      { path: "/", body: "Inter-VLAN routing and DHCP relay are working." },
    ],
  };
  if (multilayer) sw.ipRouting = true;
  for (const vlan of [10, 20, 30]) {
    const port = multilayer
      ? createSvi(sw, vlan)
      : createSubinterface(router, "p0", vlan, vlan);
    port.ip = "192.168." + vlan + ".1";
    if (vlan === 10) {
      port.helperAddresses = [server.ports[0].ip];
      port.inboundAcl = "VLAN10-IN";
    }
    gateway.ports.push(port);
  }
  gateway.note =
    "VLANs 10, 20 and 30. VLAN 10 uses DHCP relay and an inbound ACL.";
  gateway.accessLists = [
    {
      name: "VLAN10-IN",
      rules: [
        {
          action: "deny",
          protocol: "icmp",
          source: "192.168.10.0",
          sourcePrefix: 24,
          destination: "192.168.20.0",
          destinationPrefix: 24,
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
    },
  ];
  for (const [index, vlan] of [10, 20, 30].entries())
    sw.ports[index].vlan = vlan;
  if (!multilayer)
    Object.assign(sw.ports[7], { mode: "trunk", allowedVlans: [10, 20, 30] });
  let topology: Topology = {
    version: 1,
    name: multilayer
      ? "Multilayer switch · VLAN routing"
      : "Router-on-a-stick · 802.1Q",
    devices: [client, peer, sw, server, ...(multilayer ? [] : [router])],
    links: [],
  };
  for (const [endpoint, port] of [
    [client, "p0"],
    [peer, "p1"],
    [server, "p2"],
  ] as const)
    topology = connect(
      topology,
      { device: endpoint.id, port: "p0" },
      { device: sw.id, port },
      "copper",
    );
  if (!multilayer)
    topology = connect(
      topology,
      { device: router.id, port: "p0" },
      { device: sw.id, port: "p7" },
      "copper",
    );
  return topology;
}

export const routerOnAStickLab = () => vlanRoutingLab(false);
export const multilayerSwitchLab = () => vlanRoutingLab(true);

export function vtpCampusLab(): Topology {
  const [client, peer, original, server] = multilayerSwitchLab().devices;
  let core = setSwitchport(
    {
      ...original,
      ports: original.ports.filter(
        (p) => p.virtual?.kind !== "svi" || p.virtual.vlan !== 30,
      ),
    },
    "p2",
    false,
  );
  core.name = "Campus-Core";
  core.x = 580;
  core.y = 180;
  core.note =
    "VTP server. VLANs 10 and 20 cross the trunk; GigabitEthernet0/2 is a routed uplink.";
  core = setVtp(core, {
    domain: "CERTSIM",
    mode: "server",
    version: 2,
    password: "campus-lab",
  });
  core = setVlan(core, 10, { name: "Students" });
  core = setVlan(core, 20, { name: "Staff" });
  Object.assign(core.ports.find((p) => p.id === "p2")!, {
    ip: "172.16.0.1",
    prefix: 30,
  });
  Object.assign(core.ports.find((p) => p.id === "p7")!, {
    mode: "trunk",
    allowedVlans: [10, 20],
  });
  core.routes = [{ network: "0.0.0.0", prefix: 0, nextHop: "172.16.0.2" }];
  let edge = materializeVlans(createDevice("switch", 2, 360, 360));
  edge.name = "Campus-Access";
  edge.note =
    "VTP client. VLAN names and states are learned from Campus-Core across the trunk.";
  edge = setVtp(edge, {
    domain: "CERTSIM",
    mode: "client",
    version: 2,
    password: "campus-lab",
  });
  edge.ports[0].vlan = 10;
  edge.ports[1].vlan = 20;
  Object.assign(edge.ports[7], { mode: "trunk", allowedVlans: [10, 20] });
  const router = createDevice("router", 1, 830, 180);
  router.ports[0].ip = "172.16.0.2";
  router.ports[0].prefix = 30;
  router.ports[1].ip = "192.168.30.1";
  router.routes = [10, 20].map((vlan) => ({
    network: "192.168." + vlan + ".0",
    prefix: 24,
    nextHop: "172.16.0.1",
  }));
  server.x = 1030;
  server.y = 410;
  server.services!.http.pages[0].body =
    "Campus VTP, inter-VLAN routing and the routed uplink are working.";
  let topology: Topology = {
    version: 1,
    name: "VTP campus · routed uplink",
    devices: [client, peer, core, edge, router, server],
    links: [],
  };
  for (const [left, lp, right, rp] of [
    [client, "p0", edge, "p0"],
    [peer, "p0", edge, "p1"],
    [edge, "p7", core, "p7"],
    [core, "p2", router, "p0"],
    [router, "p1", server, "p0"],
  ] as const)
    topology = connect(
      topology,
      { device: left.id, port: lp },
      { device: right.id, port: rp },
      "copper",
    );
  return synchronizeVtp(topology);
}

export function dualStackLab(): Topology {
  const t = routingLab();
  t.name = "Dual-stack campus · IPv6";
  const [client, r1, r2, server] = t.devices;
  client.ports[0].ipv6 = "2001:db8:10::10";
  client.ports[0].prefix6 = 64;
  client.gateway6 = "2001:db8:10::1";
  r1.ports[0].ipv6 = "2001:db8:10::1";
  r1.ports[1].ipv6 = "2001:db8:ff::1";
  r1.ports[0].prefix6 = r1.ports[1].prefix6 = 64;
  r1.ipv6Routing = true;
  r2.ports[0].ipv6 = "2001:db8:20::1";
  r2.ports[1].ipv6 = "2001:db8:ff::2";
  r2.ports[0].prefix6 = r2.ports[1].prefix6 = 64;
  r2.ipv6Routing = true;
  r1.routes6 = [
    { network: "2001:db8:20::", prefix: 64, nextHop: "2001:db8:ff::2" },
  ];
  r2.routes6 = [
    { network: "2001:db8:10::", prefix: 64, nextHop: "2001:db8:ff::1" },
  ];
  server.ports[0].ipv6 = "2001:db8:20::100";
  server.services!.dns.records.push({
    name: "certsim.lab",
    type: "AAAA",
    value: server.ports[0].ipv6,
  });
  server.ports[0].prefix6 = 64;
  server.gateway6 = "2001:db8:20::1";
  return t;
}
export function wirelessLab(): Topology {
  const t = servicesLab();
  t.name = "Wireless office";
  const [pc, sw, , server] = t.devices;
  const client = createDevice("laptop", 1, 140, 230);
  const ap = createDevice("ap", 1, 340, 230);
  sw.x = 580;
  sw.y = 230;
  server.x = 830;
  server.y = 230;
  const profile = {
    ssid: "CertSim Office",
    security: "wpa2-personal" as const,
    key: "practice-wifi",
  };
  client.wireless = { ...profile };
  ap.wireless = { ...ap.wireless!, ...profile };
  client.ports[0].ip = pc.ports[0].ip;
  client.ports[0].addressMode = "static";
  client.dns = server.ports[0].ip;
  client.ports[0].ipv6 = "2001:db8:10::10";
  server.ports[0].ipv6 = "2001:db8:10::100";
  server.services!.dns.records.push({
    name: "certsim.lab",
    type: "AAAA",
    value: server.ports[0].ipv6,
  });
  t.devices = [client, ap, sw, server];
  t.links = t.links.filter(
    (l) => l.a.device === server.id || l.b.device === server.id,
  );
  return connect(
    t,
    { device: ap.id, port: "p0" },
    { device: sw.id, port: "p0" },
    "copper",
  );
}
export function wirelessRepairLab(): Topology {
  const t = wirelessLab();
  const [client, ap, , server] = t.devices;
  t.name = "Wireless troubleshooting";
  Object.assign(ap.wireless!, { band: "5", mode: "ac", channel: 44 });
  Object.assign(client.wireless!, { band: "2.4", mode: "g" });
  t.pdus = [
    {
      id: "wireless-echo",
      source: client.id,
      target: server.id,
      port: "p0",
      protocol: "icmp",
    },
  ];
  t.activity = captureActivity(
    t,
    "Restore the wireless link",
    "Laptop-1 cannot reach Server-1. The access point operates on 5 GHz channel 44. Inspect the laptop and access point radios, restore association, then check connectivity.",
    [{ probe: t.pdus[0], deliver: true }],
    [
      {
        device: client.id,
        port: client.ports[0].id,
        field: "band",
        expected: "5",
      },
    ],
  );
  return t;
}
export function serialWanLab(): Topology {
  const t = dualStackLab();
  t.name = "Serial WAN";
  const [, first, second] = t.devices;
  // Keep campus LANs; move the addressed transit interfaces into WAN modules.
  for (const router of [first, second]) {
    const old = router.ports[1],
      serial = modulePort(1, "serial", false);
    Object.assign(serial, {
      ip: old.ip,
      prefix: old.prefix,
      ipv6: old.ipv6,
      prefix6: old.prefix6,
    });
    old.ip = "";
    delete old.ipv6;
    if (router === first) serial.clockRate = 64000;
    router.ports.push(serial);
  }
  t.links = t.links.filter(
    (l) => !(l.a.device === first.id && l.b.device === second.id),
  );
  return connect(
    t,
    { device: first.id, port: "module-1" },
    { device: second.id, port: "module-1" },
    "serial",
    "a",
  );
}
export function servicesLab(): Topology {
  const t = exampleTopology();
  t.name = "Services · DHCP, DNS and HTTP";
  const server = t.devices.find((d) => d.kind === "server")!,
    ip = server.ports[0].ip;
  server.services = defaultServices();
  server.services.dhcp = {
    enabled: true,
    pools: [
      {
        id: "lan-pool",
        name: "LAN clients",
        start: "192.168.10.50",
        prefix: 24,
        count: 32,
        gateway: "",
        dns: ip,
      },
    ],
    leases: [],
  };
  server.services.dns = {
    enabled: true,
    records: [
      { name: "certsim.lab", type: "A", value: ip },
      { name: "www.certsim.lab", type: "CNAME", value: "certsim.lab" },
    ],
  };
  server.services.http = {
    enabled: true,
    pages: [
      {
        path: "/",
        body: "Welcome to CertSim Network Studio.\nYour DHCP, DNS and HTTP services are working.",
      },
      { path: "/status", body: "Lab server: online" },
    ],
  };
  for (const d of t.devices.filter((d) => d.kind === "pc")) d.dns = ip;
  return t;
}
export function dhcpRelayLab(): Topology {
  const t = routingLab();
  t.name = "DHCP relay · routed campus";
  const [client, relay, , server] = t.devices;
  client.ports[0].ip = "";
  client.ports[0].addressMode = "dhcp";
  client.gateway = "";
  client.dns = "";
  relay.ports[0].helperAddresses = [server.ports[0].ip];
  server.services!.dhcp = {
    enabled: true,
    leases: [],
    pools: [
      {
        id: "campus",
        name: "Campus workstations",
        start: "10.1.0.50",
        count: 20,
        prefix: 24,
        gateway: relay.ports[0].ip,
        dns: server.ports[0].ip,
        leaseSeconds: 120,
      },
    ],
  };
  return t;
}
export function routingLab(): Topology {
  const a = createDevice("pc", 1, 110, 260),
    r1 = createDevice("router", 1, 390, 260),
    r2 = createDevice("router", 2, 670, 260),
    server = createDevice("server", 1, 950, 260);
  a.ports[0].ip = "10.1.0.10";
  a.gateway = "10.1.0.1";
  a.dns = "10.2.0.100";
  r1.ports[0].ip = "10.1.0.1";
  r1.ports[1].ip = "172.16.0.1";
  r1.ports[1].prefix = 30;
  r2.ports[0].ip = "10.2.0.1";
  r2.ports[1].ip = "172.16.0.2";
  r2.ports[1].prefix = 30;
  server.ports[0].ip = "10.2.0.100";
  server.gateway = "10.2.0.1";
  server.services = defaultServices();
  server.services.dns = {
    enabled: true,
    records: [{ name: "certsim.lab", type: "A", value: "10.2.0.100" }],
  };
  server.services.http.enabled = true;
  for (const r of [r1, r2])
    r.routing = {
      ...defaultRouting(),
      protocol: "ospf",
      networks: [{ network: "0.0.0.0", prefix: 0, area: 0 }],
      passivePorts: ["p0"],
    };
  let t: Topology = {
    version: 1,
    name: "Routed campus · OSPF",
    devices: [a, r1, r2, server],
    links: [],
  };
  for (const [left, lp, right, rp] of [
    [a, "p0", r1, "p0"],
    [r1, "p1", r2, "p1"],
    [r2, "p0", server, "p0"],
  ] as const)
    t = connect(
      t,
      { device: left.id, port: lp },
      { device: right.id, port: rp },
      "copper",
    );
  return t;
}
export function redundantLab(): Topology {
  const a = createDevice("pc", 1, 130, 340),
    b = createDevice("pc", 2, 940, 340),
    s1 = createDevice("switch", 1, 360, 210),
    s2 = createDevice("switch", 2, 730, 210),
    s3 = createDevice("switch", 3, 540, 510);
  a.ports[0].ip = "192.168.30.10";
  b.ports[0].ip = "192.168.30.20";
  a.ports[0].ipv6 = "2001:db8:30::10";
  b.ports[0].ipv6 = "2001:db8:30::20";
  a.ports[0].prefix6 = b.ports[0].prefix6 = 64;
  [s1, s2, s3].forEach((s, i) => {
    s.spanningTree = { priorities: [{ vlan: 1, priority: 4096 * (i + 1) }] };
  });
  let t: Topology = {
    version: 1,
    name: "Redundant LAN · Spanning tree",
    devices: [a, b, s1, s2, s3],
    links: [],
  };
  for (const [l, lp, r, rp] of [
    [a, "p0", s1, "p0"],
    [b, "p0", s2, "p0"],
    [s1, "p1", s2, "p1"],
    [s1, "p2", s3, "p1"],
    [s2, "p2", s3, "p2"],
  ] as const)
    t = connect(
      t,
      { device: l.id, port: lp },
      { device: r.id, port: rp },
      "copper",
    );
  return t;
}
export function bpduGuardLab(): Topology {
  const trusted = createDevice("pc", 1, 130, 140),
    server = createDevice("server", 1, 890, 140),
    edge = materializeVlans(createDevice("switch", 1, 500, 235)),
    rogue = materializeVlans(createDevice("switch", 2, 500, 470)),
    branch = createDevice("pc", 2, 890, 470);
  trusted.name = "Trusted-PC";
  trusted.ports[0].ip = "192.168.44.10";
  trusted.note =
    "Ping Lab-Server at 192.168.44.100. This guarded host port remains operational.";
  server.name = "Lab-Server";
  server.ports[0].ip = "192.168.44.100";
  edge.name = "Edge-Access";
  edge.spanningTree = {
    priorities: [{ vlan: 1, priority: 4096 }],
    portFastDefault: true,
    bpduGuardDefault: true,
  };
  edge.note =
    "Inspect GigabitEthernet0/2 in Spanning tree. Remove the unapproved switch, then recover the guarded port before connecting a host.";
  rogue.name = "Unapproved-Switch";
  rogue.note =
    "This switch sends a BPDU to an edge port. Power it off or disconnect it before recovering Edge-Access GigabitEthernet0/2.";
  branch.name = "Branch-PC";
  branch.ports[0].ip = "192.168.44.20";
  branch.note =
    "The unapproved switch is behind a BPDU Guard shutdown. Move this workstation directly to the recovered edge port.";
  let topology: Topology = {
    version: 1,
    name: "BPDU Guard · Edge protection",
    devices: [trusted, server, edge, rogue, branch],
    links: [],
  };
  for (const [a, ap, b, bp] of [
    [trusted, "p0", edge, "p0"],
    [server, "p0", edge, "p1"],
    [edge, "p2", rogue, "p0"],
    [rogue, "p1", branch, "p0"],
  ] as const)
    topology = connect(
      topology,
      { device: a.id, port: ap },
      { device: b.id, port: bp },
      "copper",
    );
  return topology;
}
export function natLab(): Topology {
  const a = createDevice("pc", 1, 130, 140),
    b = createDevice("pc", 2, 130, 400),
    internal = createDevice("server", 1, 350, 530),
    sw = createDevice("switch", 1, 370, 280),
    router = createDevice("router", 1, 650, 280),
    external = createDevice("server", 2, 950, 280);
  for (const [d, ip] of [
    [a, "192.168.50.10"],
    [b, "192.168.50.11"],
    [internal, "192.168.50.100"],
  ] as const) {
    d.ports[0].ip = ip;
    d.gateway = "192.168.50.1";
    d.dns = "203.0.113.200";
  }
  router.ports[0].ip = "192.168.50.1";
  router.ports[0].natRole = "inside";
  router.ports[1].ip = "203.0.113.1";
  router.ports[1].natRole = "outside";
  external.ports[0].ip = "203.0.113.200";
  router.accessLists = [
    {
      name: "inside",
      rules: [
        {
          action: "permit",
          protocol: "ip",
          source: "192.168.50.0",
          sourcePrefix: 24,
          destination: "0.0.0.0",
          destinationPrefix: 0,
        },
      ],
    },
  ];
  router.nat = {
    static: [{ inside: "192.168.50.100", outside: "203.0.113.100" }],
    overload: [{ acl: "inside", outsidePort: "p1" }],
  };
  internal.services = defaultServices();
  internal.services.http = {
    enabled: true,
    pages: [
      { path: "/", body: "CertSim private server reached through static NAT." },
    ],
  };
  external.services = defaultServices();
  external.services.http = {
    enabled: true,
    pages: [
      {
        path: "/",
        body: "CertSim public server reached through interface overload.",
      },
    ],
  };
  external.services.dns = {
    enabled: true,
    records: [
      { name: "public.certsim.lab", type: "A", value: "203.0.113.200" },
      { name: "private.certsim.lab", type: "A", value: "203.0.113.100" },
    ],
  };
  let t: Topology = {
    version: 1,
    name: "NAT edge · Static and PAT",
    devices: [a, b, internal, sw, router, external],
    links: [],
  };
  for (const [l, lp, r, rp] of [
    [a, "p0", sw, "p0"],
    [b, "p0", sw, "p1"],
    [internal, "p0", sw, "p2"],
    [sw, "p3", router, "p0"],
    [router, "p1", external, "p0"],
  ] as const)
    t = connect(
      t,
      { device: l.id, port: lp },
      { device: r.id, port: rp },
      "copper",
    );
  return t;
}
export function natPoolsLab(): Topology {
  const t = natLab(),
    router = t.devices[4];
  t.name = "NAT pools · Address allocation";
  router.nat!.overload = [];
  router.nat!.pools = [
    { name: "public", start: "203.0.113.10", end: "203.0.113.11", prefix: 24 },
  ];
  router.nat!.poolRules = [{ acl: "inside", pool: "public", overload: false }];
  return t;
}
export function secureVlansLab(): Topology {
  const voice = createDevice("pc", 1, 100, 140),
    data = createDevice("pc", 2, 100, 440),
    sw = createDevice("switch", 1, 350, 280),
    edge = createDevice("switch", 2, 680, 280),
    server = createDevice("server", 1, 960, 140),
    peer = createDevice("pc", 3, 960, 440);
  voice.ports[0].taggedVlan = 20;
  voice.ports[0].ip = "192.168.20.10";
  data.ports[0].ip = "192.168.10.10";
  server.ports[0].taggedVlan = 20;
  server.ports[0].ip = "192.168.20.20";
  peer.ports[0].ip = "192.168.10.20";
  for (const [s, port] of [
    [sw, 0],
    [edge, 1],
  ] as const) {
    s.ports[port].vlan = 10;
    s.ports[port].voiceVlan = 20;
  }
  sw.ports[1].vlan = 10;
  edge.ports[2].vlan = 10;
  for (const p of [sw.ports[2], edge.ports[0]]) {
    p.mode = "trunk";
    p.allowedVlans = [10, 20];
    p.security = {
      maximum: 2,
      violation: "restrict",
      addresses: [],
      sticky: true,
      vlanMaximums: [
        { vlan: 10, maximum: 1 },
        { vlan: 20, maximum: 1 },
      ],
    };
  }
  let t: Topology = {
    version: 1,
    name: "Secure VLANs · Sticky voice and data",
    devices: [voice, data, sw, edge, server, peer],
    links: [],
  };
  for (const [l, lp, r, rp] of [
    [voice, "p0", sw, "p0"],
    [data, "p0", sw, "p1"],
    [sw, "p2", edge, "p0"],
    [edge, "p1", server, "p0"],
    [edge, "p2", peer, "p0"],
  ] as const)
    t = connect(
      t,
      { device: l.id, port: lp },
      { device: r.id, port: rp },
      "copper",
    );
  return t;
}
export function officePhoneLab(): Topology {
  const phone = createDevice("phone", 1, 250, 175),
    pc = createDevice("pc", 1, 75, 340),
    sw = createDevice("switch", 1, 485, 260);
  const peer = createDevice("phone", 2, 750, 125),
    data = createDevice("pc", 2, 970, 400),
    server = createDevice("server", 1, 750, 420);
  phone.ports[0].addressMode = "static";
  phone.ports[0].ip = "192.168.20.10";
  peer.ports[0].addressMode = "static";
  peer.ports[0].ip = "192.168.20.11";
  pc.ports[0].ip = "192.168.10.10";
  data.ports[0].ip = "192.168.10.20";
  server.ports[0].ip = "192.168.20.20";
  const manager = createDevice("router", 1, 505, 520);
  manager.ports[0].ip = "192.168.20.1";
  manager.callManager = {
    address: "192.168.20.1",
    lines: [
      { mac: interfaceMac(phone.id, "p0"), number: "1001" },
      { mac: interfaceMac(peer.id, "p0"), number: "1002" },
    ],
  };
  phone.managerAddress = manager.callManager.address;
  peer.managerAddress = manager.callManager.address;
  sw.ports[4].vlan = 20;
  sw.lldp = true;
  for (const port of sw.ports.slice(0, 2)) {
    port.vlan = 10;
    port.voiceVlan = 20;
    port.security = {
      maximum: 2,
      violation: "restrict",
      addresses: [],
      vlanMaximums: [
        { vlan: 10, maximum: 1 },
        { vlan: 20, maximum: 1 },
      ],
    };
  }
  sw.ports[2].vlan = 10;
  sw.ports[3].vlan = 20;
  server.services = defaultServices();
  server.services.dhcp = {
    enabled: true,
    leases: [],
    pools: [
      {
        id: "phones",
        name: "Phones",
        tftp: manager.callManager.address,
        start: "192.168.20.50",
        count: 20,
        prefix: 24,
        gateway: "",
        dns: "",
      },
    ],
  };
  let topology: Topology = {
    version: 1,
    name: "Office phones",
    devices: [phone, pc, sw, peer, data, server, manager],
    links: [],
  };
  for (const [a, ap, b, bp] of [
    [pc, "p0", phone, "p1"],
    [phone, "p0", sw, "p0"],
    [peer, "p0", sw, "p1"],
    [data, "p0", sw, "p2"],
    [server, "p0", sw, "p3"],
    [manager, "p0", sw, "p4"],
  ] as const) {
    topology = connect(
      topology,
      { device: a.id, port: ap },
      { device: b.id, port: bp },
      "copper",
    );
  }
  return topology;
}
