import type { Device, DeviceConfiguration } from "./types.ts";
import {
  defaultVlans,
  defaultVtp,
  vlanDatabase,
  ensureSviVlan,
} from "./vlans.ts";
import { createDevice, DEVICE_LABELS } from "./model.ts";
export function configurationSnapshot(d: Device): DeviceConfiguration {
  const {
    id: _id,
    kind: _kind,
    x: _x,
    y: _y,
    note: _note,
    powered: _powered,
    startupConfig: _startup,
    ...config
  } = structuredClone(d);
  if (config.services) config.services.dhcp.leases = [];
  for (const port of config.ports) {
    delete port.dhcpLease;
    delete port.dhcpRetryAt;
  }
  return config;
}
export function saveStartup(d: Device): Device {
  return { ...d, startupConfig: configurationSnapshot(d) };
}
export function eraseStartup(d: Device): Device {
  const next = { ...d };
  delete next.startupConfig;
  return next;
}
export function reloadDevice(d: Device): Device {
  const factory = createDevice(d.kind, 1, d.x, d.y),
    template = factory.ports[0];
  const next: Device = {
    ...factory,
    id: d.id,
    name: DEVICE_LABELS[d.kind],
    note: d.note,
    ports: d.ports
      .filter((p) => !p.virtual)
      .map((p) => ({
        ...(factory.ports.find((f) => f.id === p.id) ?? template),
        id: p.id,
        name: p.name,
        media: p.media,
        ...(p.slot === undefined ? {} : { slot: p.slot }),
      })),
    ...(d.startupConfig
      ? {
          ...structuredClone(d.startupConfig),
          startupConfig: structuredClone(d.startupConfig),
        }
      : {}),
    powered: true,
  };
  if (d.kind === "switch" && (d.vlans !== undefined || d.vtp !== undefined)) {
    const vtp = d.vtp ?? defaultVtp();
    if (vtp.mode === "server" || vtp.mode === "client") {
      next.vlans = vlanDatabase(d);
      next.vtp = structuredClone(vtp);
    } else {
      next.vlans = d.startupConfig?.vlans
        ? structuredClone(d.startupConfig.vlans)
        : defaultVlans();
      next.vtp = d.startupConfig?.vtp
        ? structuredClone(d.startupConfig.vtp)
        : defaultVtp();
    }
  }
  if (d.kind === "switch" && d.startupConfig && next.vlans !== undefined)
    for (const p of next.ports)
      if (p.virtual?.kind === "svi")
        Object.assign(next, ensureSviVlan(next, p.virtual.vlan));
  if (next.services) next.services.dhcp.leases = [];
  if (next.ports.some((p) => p.addressMode === "dhcp")) {
    for (const p of next.ports)
      if (p.addressMode === "dhcp") {
        p.ip = "";
        delete p.dhcpLease;
        delete p.dhcpRetryAt;
      }
    next.gateway = "";
    next.dns = "";
  }
  return next;
}
