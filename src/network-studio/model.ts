import type {
  Cable,
  Device,
  DeviceKind,
  Endpoint,
  Link,
  Port,
  Topology,
} from "./types.ts";

import type { NetworkRuntime } from "./networkRuntime.ts";
import { bpduGuardDown } from "./portProtection.ts";
import { defaultWireless, isWireless } from "./wireless.ts";
export const DEVICE_LABELS: Record<DeviceKind, string> = {
  router: "Router",
  switch: "Switch",
  ap: "Access point",
  laptop: "Laptop",
  phone: "IP Phone",
  pc: "Workstation",
  server: "Server",
};
export const MAX_DEVICES = 128;
export const MAX_LINKS = 256;
export function createDevice(
  kind: DeviceKind,
  index: number,
  x = 160,
  y = 160,
): Device {
  const count =
    kind === "switch"
      ? 8
      : kind === "router"
        ? 3
        : kind === "phone" || kind === "ap"
          ? 2
          : 1;
  return {
    id: crypto.randomUUID(),
    name: `${DEVICE_LABELS[kind]}-${index}`,
    kind,
    ...(kind === "ap" || kind === "laptop"
      ? { wireless: defaultWireless(kind) }
      : {}),
    x,
    y,
    powered: true,
    gateway: "",
    routes: [],
    note: "",
    ports: Array.from(
      { length: count },
      (_, n): Port => ({
        id: `p${n}`,
        name: isWireless(kind)
          ? kind === "ap" && n === 0
            ? "Ethernet0"
            : "Wireless0"
          : kind === "phone"
            ? n === 0
              ? "Network"
              : "PC"
            : `GigabitEthernet0/${n}`,
        media:
          kind === "laptop" || (kind === "ap" && n === 1)
            ? "radio"
            : n === 2 && kind === "router"
              ? "fiber"
              : "copper",
        ...((kind === "phone" && n === 0) || kind === "laptop"
          ? { addressMode: "dhcp" as const }
          : {}),
        ...(kind === "switch" ? { nativeVlan: 1 } : {}),
        enabled: true,
        ip: "",
        prefix: 24,
        vlan: 1,
        mode: "access",
        allowedVlans: [1],
      }),
    ),
  };
}
export const serialRates = [
  1200, 2400, 4800, 9600, 19200, 38400, 56000, 64000, 72000, 125000, 128000,
  148000, 250000, 500000, 800000, 1000000, 1300000, 2000000, 4000000,
] as const;
export function serialRole(
  t: Topology,
  device: string,
  port: string,
): "DCE" | "DTE" | undefined {
  const matches = (e: Endpoint) => e.device === device && e.port === port;
  const link = t.links.find(
    (l) => l.cable === "serial" && (matches(l.a) || matches(l.b)),
  );
  return link ? (matches(link[link.dce ?? "a"]) ? "DCE" : "DTE") : undefined;
}
export function getPort(t: Topology, endpoint: Endpoint): Port | undefined {
  return t.devices
    .find((d) => d.id === endpoint.device)
    ?.ports.find((p) => p.id === endpoint.port);
}
export function isOccupied(t: Topology, e: Endpoint): boolean {
  return t.links.some((l) =>
    [l.a, l.b].some((p) => p.device === e.device && p.port === e.port),
  );
}
export function linkError(
  t: Topology,
  a: Endpoint,
  b: Endpoint,
  cable: Cable,
): string | null {
  if (t.links.length >= MAX_LINKS)
    return "This workspace supports up to 256 cables.";
  const ap = getPort(t, a),
    bp = getPort(t, b);
  if (!ap || !bp) return "Select two existing ports.";
  if (ap.virtual || bp.virtual)
    return "Connect the physical interface that carries this virtual interface.";
  if (a.device === b.device) return "Connect two different devices.";
  if (isOccupied(t, a) || isOccupied(t, b))
    return "A selected port already has a cable.";
  if (ap.media === "radio" || bp.media === "radio")
    return "Wireless radios associate through Wireless settings.";
  if (ap.media !== cable || bp.media !== cable)
    return "Cable media must match both ports.";
  return null;
}
export function connect(
  t: Topology,
  a: Endpoint,
  b: Endpoint,
  cable: Cable,
  dce?: "a" | "b",
): Topology {
  if (dce !== undefined && (cable !== "serial" || (dce !== "a" && dce !== "b")))
    throw Error("Select a DCE end on a serial cable.");
  const error = linkError(t, a, b, cable);
  if (error) throw new Error(error);
  return {
    ...t,
    links: [
      ...t.links,
      {
        id: crypto.randomUUID(),
        a,
        b,
        cable,
        ...(cable === "serial" ? { dce: dce ?? "a" } : {}),
      },
    ],
  };
}
export function linkUp(
  t: Topology,
  l: Link,
  runtime?: NetworkRuntime,
): boolean {
  return linkStatus(t, l, runtime).up;
}
export function cableBudget(cable: Cable): number {
  return cable === "serial" ? 15 : cable === "copper" ? 100 : 10000;
}
export function linkStatus(
  t: Topology,
  l: Link,
  runtime?: NetworkRuntime,
): { up: boolean; reason: string } {
  if (
    l.lengthMeters !== undefined &&
    (!Number.isFinite(l.lengthMeters) ||
      l.lengthMeters < 0 ||
      l.lengthMeters > cableBudget(l.cable))
  )
    return {
      up: false,
      reason: `Cable length ${l.lengthMeters} m exceeds the ${cableBudget(l.cable)} m ${l.cable} lab profile or is invalid.`,
    };
  for (const endpoint of [l.a, l.b]) {
    const device = t.devices.find((d) => d.id === endpoint.device),
      port = getPort(t, endpoint);
    if (!device || !port)
      return { up: false, reason: "Cable endpoint is missing." };
    if (port.virtual)
      return {
        up: false,
        reason: "Virtual interfaces cannot be cable endpoints.",
      };
    if (!device.powered)
      return { up: false, reason: `${device.name} is powered off.` };
    if (!port.enabled)
      return { up: false, reason: `${device.name} ${port.name} is disabled.` };
    if (
      port.channelGroup &&
      device.ports.some(
        (po) =>
          po.virtual?.kind === "portchannel" &&
          po.virtual.group === port.channelGroup!.id &&
          !po.enabled,
      )
    )
      return {
        up: false,
        reason:
          device.name +
          " Port-channel" +
          port.channelGroup.id +
          " is disabled.",
      };
    if (runtime && bpduGuardDown(runtime, device.id, port.id))
      return {
        up: false,
        reason:
          device.name + " " + port.name + " is err-disabled (BPDU Guard).",
      };
    if (port.media !== l.cable)
      return { up: false, reason: "Cable media does not match the interface." };
  }
  if (l.cable === "serial" && !getPort(t, l[l.dce ?? "a"])?.clockRate)
    return {
      up: false,
      reason:
        "Serial line protocol down. Set a clock rate on the DCE interface.",
    };
  return {
    up: true,
    reason: `Link up${l.lengthMeters === undefined ? " · unmeasured cable" : ` · ${l.lengthMeters} m`}.`,
  };
}
export function removeDevice(t: Topology, id: string): Topology {
  return {
    ...t,
    devices: t.devices
      .filter((d) => d.id !== id)
      .map((d) =>
        !d.services?.dhcp.leases.some((l) => l.client === id)
          ? d
          : {
              ...d,
              services: {
                ...d.services,
                dhcp: {
                  ...d.services.dhcp,
                  leases: d.services.dhcp.leases.filter((l) => l.client !== id),
                },
              },
            },
      ),
    links: t.links.filter((l) => l.a.device !== id && l.b.device !== id),
    ...(t.pdus
      ? { pdus: t.pdus.filter((p) => p.source !== id && p.target !== id) }
      : {}),
    ...(t.physical
      ? {
          physical: {
            ...t.physical,
            placements: t.physical.placements.filter((p) => p.device !== id),
          },
        }
      : {}),
  };
}
export function blankTopology(): Topology {
  return { version: 1, name: "Untitled network", devices: [], links: [] };
}
export function exampleTopology(): Topology {
  const left = createDevice("pc", 1, 130, 220);
  const sw = createDevice("switch", 1, 370, 220);
  const right = createDevice("pc", 2, 610, 120);
  const server = createDevice("server", 1, 610, 340);
  left.ports[0].ip = "192.168.10.10";
  right.ports[0].ip = "192.168.10.20";
  server.ports[0].ip = "192.168.10.100";
  let topology: Topology = {
    version: 1,
    name: "First LAN",
    devices: [left, sw, right, server],
    links: [],
  };
  for (const [d, p] of [
    [left, "p0"],
    [right, "p1"],
    [server, "p2"],
  ] as const)
    topology = connect(
      topology,
      { device: d.id, port: "p0" },
      { device: sw.id, port: p },
      "copper",
    );
  return topology;
}
