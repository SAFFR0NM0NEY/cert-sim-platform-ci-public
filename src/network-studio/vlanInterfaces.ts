import type {
  Device,
  DeviceConfiguration,
  DeviceKind,
  Port,
  Topology,
  UserPdu,
} from "./types.ts";
import { integer, unique } from "./validation.ts";

export const ipv4Forwarding = (d: Device): boolean =>
  d.kind === "router" || (d.kind === "switch" && d.ipRouting === true);

export const isSwitchport = (d: Pick<Device, "kind">, p: Port): boolean =>
  d.kind === "switch" &&
  (!p.virtual || p.virtual.kind === "portchannel") &&
  !p.routed;

export const isPhysicalSwitchport = (
  d: Pick<Device, "kind">,
  p: Port,
): boolean => isSwitchport(d, p) && !p.virtual;

export const isRoutedInterface = (d: Pick<Device, "kind">, p: Port): boolean =>
  !p.channelGroup &&
  (d.kind === "router" ||
    (d.kind === "switch" && (p.virtual?.kind === "svi" || p.routed === true)));

export const packetInterfaces = (d: Device): Port[] =>
  d.ports.filter((p) =>
    d.kind === "switch"
      ? isRoutedInterface(d, p)
      : !p.channelGroup && (d.kind !== "phone" || p.id === "p0"),
  );

export const isPacketEndpoint = (d: Device): boolean =>
  d.kind !== "ap" && (d.kind !== "switch" || packetInterfaces(d).length > 0);

export function validateVirtualInterfaces(
  kind: DeviceKind,
  ports: Port[],
): void {
  const vlans: string[] = [];
  const nativeParents: string[] = [];
  for (const p of ports) {
    const v = p.virtual;
    if (p.routed !== undefined) {
      if (
        typeof p.routed !== "boolean" ||
        kind !== "switch" ||
        (v && v.kind !== "portchannel") ||
        !["copper", "fiber"].includes(p.media)
      )
        throw Error(
          "Routed ports require a physical switch Ethernet interface.",
        );
      if (
        p.routed &&
        (p.mode !== "access" ||
          p.vlan !== 1 ||
          p.nativeVlan !== undefined ||
          p.voiceVlan !== undefined ||
          p.security ||
          p.spanningTreeCost !== undefined)
      )
        throw Error(
          "Routed ports cannot retain VLAN, STP or port-security configuration.",
        );
    }
    if (!v) continue;
    if (v.kind === "portchannel") {
      integer(v.group, 1, 6);
      if (
        kind !== "switch" ||
        p.name !== "Port-channel" + v.group ||
        p.slot !== undefined ||
        !["copper", "fiber"].includes(p.media) ||
        p.security ||
        p.voiceVlan !== undefined ||
        p.channelGroup ||
        p.channelProtocol ||
        p.cdp !== undefined ||
        p.lldpReceive !== undefined ||
        p.lldpTransmit !== undefined ||
        p.taggedVlan !== undefined
      )
        throw Error(
          "Port-channels require a switch aggregate interface without physical-only settings.",
        );
      vlans.push("portchannel/" + v.group);
      continue;
    }
    if (
      p.slot !== undefined ||
      p.media === "serial" ||
      p.media === "radio" ||
      p.taggedVlan !== undefined ||
      p.voiceVlan !== undefined ||
      p.security ||
      p.spanningTreeCost !== undefined ||
      p.cdp !== undefined ||
      p.lldpReceive !== undefined ||
      p.lldpTransmit !== undefined ||
      p.mode !== "access" ||
      p.vlan !== 1
    )
      throw Error(
        "Virtual interfaces use routed settings without physical switching or discovery configuration.",
      );
    if (v.kind === "svi") {
      if (
        kind !== "switch" ||
        p.media !== "copper" ||
        p.name !== "Vlan" + v.vlan
      )
        throw Error(
          "A switch VLAN interface must be named Vlan followed by its VLAN number.",
        );
      integer(v.vlan, 1, 4094);
      vlans.push("svi/" + v.vlan);
      continue;
    }
    if (kind !== "router" || v.kind !== "subinterface")
      throw Error("Ethernet subinterfaces require a router.");
    const parent = ports.find((entry) => entry.id === v.parent);
    if (
      !parent ||
      parent.virtual ||
      !["copper", "fiber"].includes(parent.media) ||
      p.media !== parent.media
    )
      throw Error("A subinterface needs an existing physical Ethernet parent.");
    const number = p.name.slice(parent.name.length + 1);
    if (!p.name.startsWith(parent.name + ".") || !/^\d+$/.test(number))
      throw Error(
        "Name a subinterface with its physical parent and a numeric suffix.",
      );
    integer(Number(number), 0, 4294967295);
    if (v.vlan !== undefined) {
      integer(v.vlan, 1, 4094);
      vlans.push(v.parent + "/" + v.vlan);
    }
    if (v.native !== undefined && typeof v.native !== "boolean")
      throw Error("Invalid native VLAN option.");
    if (v.native) {
      if (v.vlan === undefined)
        throw Error("Set a VLAN before selecting native encapsulation.");
      nativeParents.push(v.parent);
      if (parent.ip || parent.ipv6)
        throw Error(
          "Move the parent's IP addresses to its native subinterface.",
        );
    }
  }
  unique(vlans);
  unique(nativeParents);
}

function virtualPort(
  d: Device,
  id: string,
  name: string,
  media: Port["media"],
  virtual: NonNullable<Port["virtual"]>,
): Port {
  if (d.ports.length >= 32)
    throw Error("This device supports up to 32 interfaces.");
  if (
    d.ports.some(
      (p) => p.id === id || p.name.toLowerCase() === name.toLowerCase(),
    )
  )
    throw Error("That interface already exists.");
  const port: Port = {
    id,
    name,
    media,
    virtual,
    enabled: true,
    ip: "",
    prefix: 24,
    vlan: 1,
    mode: "access",
    allowedVlans: [1],
  };
  validateVirtualInterfaces(d.kind, [...d.ports, port]);
  return port;
}

export function createSubinterface(
  d: Device,
  parentId: string,
  number: number,
  vlan?: number,
  native?: boolean,
): Port {
  integer(number, 0, 4294967295);
  const parent = d.ports.find((p) => p.id === parentId);
  if (!parent) throw Error("Select an existing physical Ethernet parent.");
  return virtualPort(
    d,
    "subinterface:" + parentId + ":" + number,
    parent.name + "." + number,
    parent.media,
    {
      kind: "subinterface",
      parent: parentId,
      ...(vlan === undefined ? {} : { vlan }),
      ...(native ? { native } : {}),
    },
  );
}

export function createSvi(d: Device, vlan: number): Port {
  integer(vlan, 1, 4094);
  return virtualPort(d, "svi:" + vlan, "Vlan" + vlan, "copper", {
    kind: "svi",
    vlan,
  });
}

// Shared by virtual interface removal and physical module removal.
export function detachInterfaces(
  config: DeviceConfiguration,
  removed: Set<string>,
): void {
  const oldPorts = config.ports.filter((p) => removed.has(p.id));
  config.ports = config.ports.filter((p) => !removed.has(p.id));
  const removedGroups = new Set(
    oldPorts.flatMap((p) =>
      p.virtual?.kind === "portchannel" ? [p.virtual.group] : [],
    ),
  );
  for (const p of config.ports)
    if (p.channelGroup && removedGroups.has(p.channelGroup.id))
      delete p.channelGroup;
  if (config.staticMac)
    config.staticMac = config.staticMac.filter((m) => !removed.has(m.port));
  if (config.routing)
    config.routing.passivePorts = config.routing.passivePorts.filter(
      (id) => !removed.has(id),
    );
  if (config.nat)
    config.nat.overload = config.nat.overload.filter(
      (r) => !removed.has(r.outsidePort),
    );
  if (config.routes6)
    config.routes6 = config.routes6.filter(
      (r) => !r.interface || !removed.has(r.interface),
    );
  if (
    oldPorts.some((p) => p.ip && p.ip === config.callManager?.address) &&
    !config.ports.some((p) => p.ip === config.callManager?.address)
  )
    delete config.callManager;
}

export function removeDeviceInterface(d: Device, portId: string): Device {
  if (!d.ports.find((p) => p.id === portId)?.virtual)
    throw Error("Select a virtual interface to remove.");
  const next = structuredClone(d);
  detachInterfaces(next, new Set([portId]));
  return next;
}

/** Keep packet definitions valid after a staged configuration edit or reload. */
export function devicePdus(t: Topology, next: Device): UserPdu[] | undefined {
  const validPort = (id: string) =>
    packetInterfaces(next).some((p) => p.id === id);
  const validSource = isPacketEndpoint(next);
  return t.pdus?.filter(
    (p) =>
      (p.target !== next.id || validPort(p.port)) &&
      (p.source !== next.id ||
        (validSource && (!p.sourceInterface || validPort(p.sourceInterface)))),
  );
}

export function removeVirtualInterface(
  t: Topology,
  deviceId: string,
  portId: string,
): Topology {
  const d = t.devices.find((d) => d.id === deviceId);
  if (!d) throw Error("Device no longer exists.");
  const next = removeDeviceInterface(d, portId);
  return {
    ...t,
    devices: t.devices.map((entry) => (entry.id === deviceId ? next : entry)),
    ...(t.pdus ? { pdus: devicePdus(t, next) } : {}),
  };
}
