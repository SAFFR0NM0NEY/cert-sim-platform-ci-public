import { detachInterfaces } from "./vlanInterfaces.ts";
import { isOccupied, MAX_LINKS } from "./model.ts";
import type {
  Cable,
  Device,
  DeviceConfiguration,
  Endpoint,
  Port,
  Topology,
} from "./types.ts";

export const moduleSlots = [1, 2] as const;
export type ModuleSlot = (typeof moduleSlots)[number];

export function modulePort(
  slot: ModuleSlot,
  media: Cable,
  switching: boolean,
): Port {
  return {
    id: "module-" + slot,
    name: (media === "serial" ? "Serial" : "GigabitEthernet") + slot + "/0",
    slot,
    media,
    enabled: true,
    ip: "",
    prefix: 24,
    mode: "access",
    vlan: 1,
    allowedVlans: [1],
    ...(switching ? { nativeVlan: 1 } : {}),
  };
}

export function changeModule(
  t: Topology,
  id: string,
  slot: ModuleSlot,
  media: Cable | null,
): Topology {
  const device = t.devices.find((d) => d.id === id);
  if (!device || (device.kind !== "switch" && device.kind !== "router"))
    throw Error("Select a modular router or switch.");
  if (device.powered) throw Error("Power off the device to change a module.");
  if (
    !moduleSlots.includes(slot) ||
    (media !== null &&
      media !== "copper" &&
      media !== "fiber" &&
      media !== "serial")
  )
    throw Error("Select an available slot and interface module.");
  if (media === "serial" && device.kind !== "router")
    throw Error("Serial modules require a router.");
  const installed = device.ports.find((p) => p.slot === slot);
  if (!installed && !media) return t;
  if (installed && media)
    throw Error("Remove the installed module before using the slot.");
  const nextDevice = structuredClone(device);
  const configs: DeviceConfiguration[] = [nextDevice];
  if (nextDevice.startupConfig) configs.push(nextDevice.startupConfig);
  if (media) {
    const port = modulePort(slot, media, device.kind === "switch");
    if (
      device.ports.length >= 32 ||
      device.ports.some(
        (p) =>
          p.id === port.id || p.name.toLowerCase() === port.name.toLowerCase(),
      )
    )
      throw Error("The slot conflicts with the existing interface inventory.");
    for (const config of configs) config.ports.push(structuredClone(port));
  } else if (installed) {
    for (const config of configs)
      detachInterfaces(
        config,
        new Set(
          config.ports
            .filter(
              (p) =>
                p.id === installed.id ||
                (p.virtual?.kind === "subinterface" &&
                  p.virtual.parent === installed.id),
            )
            .map((p) => p.id),
        ),
      );
  }
  const next = {
    ...t,
    devices: t.devices.map((d) => (d.id === id ? nextDevice : d)),
  };
  if (installed) {
    const matches = (ep: Endpoint) =>
      ep.device === id && ep.port === installed.id;
    next.links = t.links.filter((l) => !matches(l.a) && !matches(l.b));
    if (t.pdus)
      next.pdus = t.pdus.filter(
        (p) =>
          !(
            p.target === id &&
            !nextDevice.ports.some((port) => port.id === p.port)
          ) &&
          !(
            p.source === id &&
            p.sourceInterface &&
            !nextDevice.ports.some((port) => port.id === p.sourceInterface)
          ),
      );
  }
  return next;
}

export function automaticConnection(
  t: Topology,
  a: Device,
  b: Device,
): { a: Endpoint; b: Endpoint; cable: Cable } | null {
  if (a.id === b.id || t.links.length >= MAX_LINKS) return null;
  const available = (d: Device) =>
    d.ports.filter((p) => !isOccupied(t, { device: d.id, port: p.id }));
  const left = available(a),
    right = available(b);
  // Prefer a live pair, then permit cabling an administratively down port.
  for (const enabledOnly of [true, false]) {
    for (const ap of left) {
      if (ap.media === "radio") continue;
      const bp = right.find(
        (p) =>
          p.media === ap.media && (!enabledOnly || (ap.enabled && p.enabled)),
      );
      if (bp)
        return {
          a: { device: a.id, port: ap.id },
          b: { device: b.id, port: bp.id },
          cable: ap.media,
        };
    }
  }
  return null;
}
