import { parseActivity } from "./activity.ts";
import { parseScenarios, scenariosFor } from "./scenarios.ts";
import { parsePdus } from "./pdus.ts";
import { parsePortSecurity } from "./portSecurity.ts";
import { object, text, integer, bool, list, unique } from "./validation.ts";
import { leaseDuration, parseDeviceExtensions } from "./extensions.ts";
import { parsePhysical, setCableLength } from "./physical.ts";
import { configurationSnapshot } from "./deviceLifecycle.ts";
import { parseAnnotations } from "./annotations.ts";
import { natConflict } from "./nat.ts";
import type {
  Device,
  DeviceKind,
  Endpoint,
  Port,
  PackageResource,
  Route,
  Topology,
} from "./types.ts";
import { configurationError, usableIp } from "./engine.ts";
import { connect, MAX_DEVICES, MAX_LINKS } from "./model.ts";

export const STORAGE_KEY = "certsim.network-studio.practice.v1";
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
function packageResource(raw: unknown): PackageResource {
  const value = object(raw);
  return {
    name: text(value.name, 1024),
    size: integer(value.size, 0, Number.MAX_SAFE_INTEGER),
  };
}

function attachmentKey(value: unknown) {
  const key = text(value, 64);
  if (!/^[0-9a-f]{64}$/.test(key))
    throw Error("Invalid native file reference.");
  return key;
}

function parseBackground(value: unknown) {
  const background = object(value);
  return { name: text(background.name, 1024), tiled: bool(background.tiled) };
}

function endpoint(value: unknown): Endpoint {
  const e = object(value);
  return { device: text(e.device, 80), port: text(e.port, 80) };
}
function clientLease(value: unknown): NonNullable<Port["dhcpLease"]> {
  const l = object(value);
  const address = text(l.address, 15);
  if (!usableIp(address, 32)) throw Error("Invalid DHCP lease address.");
  const duration = leaseDuration(l.duration);
  const expires = integer(l.expires, duration, Number.MAX_SAFE_INTEGER);
  const nextAttempt = integer(l.nextAttempt, expires - duration + 1, expires);
  if (l.state !== "bound" && l.state !== "renewing" && l.state !== "rebinding")
    throw Error("Invalid DHCP lease state.");
  const tftp = l.tftp === undefined ? undefined : text(l.tftp, 15);
  if (tftp && !usableIp(tftp, 32)) throw Error("Invalid DHCP TFTP address.");
  return {
    ...(tftp ? { tftp } : {}),
    server: text(l.server, 80),
    address,
    duration,
    expires,
    nextAttempt,
    state: l.state,
  };
}
function virtualInterface(value: unknown): NonNullable<Port["virtual"]> {
  const v = object(value);
  if (v.kind === "portchannel")
    return { kind: "portchannel", group: integer(v.group, 1, 6) };
  if (v.kind === "svi") return { kind: "svi", vlan: integer(v.vlan, 1, 4094) };
  if (v.kind !== "subinterface") throw Error("Unsupported virtual interface.");
  return {
    kind: "subinterface",
    parent: text(v.parent, 80),
    ...(v.vlan === undefined ? {} : { vlan: integer(v.vlan, 1, 4094) }),
    ...(v.native === undefined ? {} : { native: bool(v.native) }),
  };
}
function port(value: unknown): Port {
  const p = object(value);
  if (
    p.media !== "copper" &&
    p.media !== "fiber" &&
    p.media !== "serial" &&
    p.media !== "radio"
  )
    throw new Error("Unsupported port media.");
  if (
    !["access", "trunk", "dynamic-auto", "dynamic-desirable"].includes(
      String(p.mode),
    )
  )
    throw new Error("Unsupported switch port mode.");
  return {
    ...(p.nonegotiate === undefined
      ? {}
      : { nonegotiate: bool(p.nonegotiate) }),
    ...(p.channelGroup === undefined
      ? {}
      : {
          channelGroup: {
            id: integer(object(p.channelGroup).id, 1, 6),
            mode: text(object(p.channelGroup).mode, 16) as NonNullable<
              Port["channelGroup"]
            >["mode"],
          },
        }),
    ...(p.channelProtocol === undefined
      ? {}
      : {
          channelProtocol: text(
            p.channelProtocol,
            8,
          ) as Port["channelProtocol"],
        }),
    ...(p.portFast === undefined
      ? {}
      : { portFast: text(p.portFast, 16) as Port["portFast"] }),
    ...(p.bpduGuard === undefined
      ? {}
      : { bpduGuard: text(p.bpduGuard, 16) as Port["bpduGuard"] }),
    ...(p.routed === undefined ? {} : { routed: bool(p.routed) }),
    ...(p.virtual === undefined
      ? {}
      : { virtual: virtualInterface(p.virtual) }),
    ...(p.dhcpRetryAt === undefined
      ? {}
      : { dhcpRetryAt: integer(p.dhcpRetryAt, 0, Number.MAX_SAFE_INTEGER) }),
    ...(p.dhcpLease === undefined
      ? {}
      : { dhcpLease: clientLease(p.dhcpLease) }),
    ...(p.security === undefined
      ? {}
      : { security: parsePortSecurity(p.security) }),
    ...(p.cdp === undefined ? {} : { cdp: bool(p.cdp) }),
    ...(p.lldpTransmit === undefined
      ? {}
      : { lldpTransmit: bool(p.lldpTransmit) }),
    ...(p.lldpReceive === undefined
      ? {}
      : { lldpReceive: bool(p.lldpReceive) }),
    ...(p.nativeVlan === undefined
      ? {}
      : { nativeVlan: integer(p.nativeVlan, 1, 4094) }),
    ...(p.voiceVlan === undefined
      ? {}
      : { voiceVlan: integer(p.voiceVlan, 1, 4094) }),
    ...(p.taggedVlan === undefined
      ? {}
      : { taggedVlan: integer(p.taggedVlan, 1, 4094) }),
    id: text(p.id, 80),
    name: text(p.name, 48),
    media: p.media,
    ...(p.clockRate === undefined
      ? {}
      : { clockRate: integer(p.clockRate, 1, 4000000) }),
    ...(p.slot === undefined ? {} : { slot: integer(p.slot, 1, 2) as 1 | 2 }),
    enabled: bool(p.enabled),
    ip: text(p.ip, 15, true),
    prefix: integer(p.prefix, 1, 32),
    vlan: integer(p.vlan, 1, 4094),
    mode: p.mode as Port["mode"],
    allowedVlans: list(p.allowedVlans, 128).map((v) => integer(v, 1, 4094)),
    ...(p.ipv6 === undefined ? {} : { ipv6: text(p.ipv6, 45, true) }),
    ...(p.prefix6 === undefined ? {} : { prefix6: integer(p.prefix6, 1, 128) }),
    ...(p.addressMode === undefined
      ? {}
      : {
          addressMode:
            p.addressMode === "static" || p.addressMode === "dhcp"
              ? p.addressMode
              : (() => {
                  throw new Error("Invalid address mode.");
                })(),
        }),
    ...(p.helperAddresses === undefined
      ? {}
      : {
          helperAddresses: list(p.helperAddresses, 64).map((a) => text(a, 15)),
        }),
    ...(p.inboundAcl === undefined
      ? {}
      : { inboundAcl: text(p.inboundAcl, 32, true) }),
    ...(p.outboundAcl === undefined
      ? {}
      : { outboundAcl: text(p.outboundAcl, 32, true) }),
    ...(p.cost === undefined ? {} : { cost: integer(p.cost, 1, 65535) }),
    ...(p.bandwidth === undefined
      ? {}
      : { bandwidth: integer(p.bandwidth, 1, 2147483647) }),
    ...(p.delay === undefined ? {} : { delay: integer(p.delay, 1, 16777215) }),
    ...(p.natRole === undefined
      ? {}
      : {
          natRole:
            p.natRole === "inside" || p.natRole === "outside"
              ? p.natRole
              : (() => {
                  throw Error("Invalid NAT interface role.");
                })(),
        }),
    ...(p.spanningTreeCost === undefined
      ? {}
      : { spanningTreeCost: integer(p.spanningTreeCost, 1, 200000000) }),
  };
}
export function route(value: unknown): Route {
  const r = object(value);
  return {
    network: text(r.network, 15),
    prefix: integer(r.prefix, 0, 32),
    nextHop: text(r.nextHop, 15),
  };
}
function device(value: unknown): Device {
  const d = object(value);
  if (
    !["router", "switch", "pc", "server", "phone", "ap", "laptop"].includes(
      String(d.kind),
    )
  )
    throw new Error("Unsupported device type.");
  const result: Device = {
    id: text(d.id, 80),
    name: text(d.name, 48),
    kind: d.kind as DeviceKind,
    x: integer(d.x, 40, 1080),
    y: integer(d.y, 50, 650),
    powered: bool(d.powered),
    gateway: text(d.gateway, 15, true),
    note: text(d.note, 300, true),
    ports: list(d.ports, 32).map(port),
    routes: list(d.routes, 128).map(route),
  };
  if (!result.ports.length) throw new Error("Devices need at least one port.");
  if (!["router", "switch"].includes(result.kind) && result.routes.length)
    throw new Error("Static routes require a router or switch.");
  if (
    result.kind !== "switch" &&
    result.ports.some((p) => p.mode !== "access" || p.vlan !== 1)
  )
    throw new Error("Host and router ports use routed interface settings.");
  unique(result.ports.map((p) => p.id));
  unique(result.ports.map((p) => p.name));
  Object.assign(result, parseDeviceExtensions(d, result.kind, result.ports));
  const error = configurationError(result);
  if (error) throw new Error(error);
  if (d.startupConfig !== undefined) {
    const raw = object(d.startupConfig);
    if (
      ["id", "kind", "x", "y", "note", "powered", "startupConfig"].some(
        (key) => key in raw,
      )
    )
      throw new Error(
        "Startup snapshot must contain configuration only and cannot nest snapshots.",
      );
    const snapshot = device({
      ...raw,
      id: result.id,
      kind: result.kind,
      x: result.x,
      y: result.y,
      note: result.note,
      powered: true,
    });
    if (
      snapshot.ports.filter((p) => !p.virtual).length !==
        result.ports.filter((p) => !p.virtual).length ||
      snapshot.ports
        .filter((p) => !p.virtual)
        .some(
          (p) =>
            !result.ports.some(
              (original) =>
                !original.virtual &&
                p.id === original.id &&
                p.name === original.name &&
                p.media === original.media &&
                p.slot === original.slot,
            ),
        )
    )
      throw new Error(
        "Startup snapshot cannot change the hardware interface inventory.",
      );
    result.startupConfig = configurationSnapshot(snapshot);
  }
  return result;
}
export function parseTopology(json: string): Topology {
  if (new TextEncoder().encode(json).length > MAX_FILE_BYTES)
    throw new Error("Workspace exceeds the 2 MiB limit.");
  return parseWorkspace(object(JSON.parse(json)), true);
}
function parseWorkspace(
  raw: Record<string, unknown>,
  allowActivity: boolean,
): Topology {
  if (!allowActivity && raw.activity !== undefined)
    throw Error("A starting network cannot contain an activity.");
  if (raw.version !== 1)
    throw new Error(
      "Unsupported workspace version. Import a CertSim Network Studio JSON file (version 1).",
    );
  const devices = list(raw.devices, MAX_DEVICES).map(device);
  unique(devices.map((d) => d.id));
  let result: Topology = {
    version: 1,
    ...(raw.dhcpTime === undefined
      ? {}
      : {
          dhcpTime: integer(
            raw.dhcpTime,
            0,
            Number.MAX_SAFE_INTEGER - 31536000 - 86400,
          ),
        }),
    name: text(raw.name, 80),
    devices,
    links: [],
  };
  for (const entry of list(raw.links, MAX_LINKS)) {
    const l = object(entry),
      id = text(l.id, 80);
    if (l.cable !== "copper" && l.cable !== "fiber" && l.cable !== "serial")
      throw new Error("Unsupported cable type.");
    if (l.dce !== undefined && l.dce !== "a" && l.dce !== "b")
      throw Error("Invalid serial cable DCE end.");
    result = connect(result, endpoint(l.a), endpoint(l.b), l.cable, l.dce);
    result.links[result.links.length - 1].id = id;
    if (l.lengthMeters !== undefined) {
      if (typeof l.lengthMeters !== "number")
        throw new Error("Cable length must be numeric.");
      result = setCableLength(result, id, l.lengthMeters);
    }
  }
  unique(result.links.map((l) => l.id));
  if (raw.nativeFile !== undefined) {
    const file = object(raw.nativeFile);
    const key = attachmentKey(file.key);
    const pages = list(file.pages, 24).map((p) => {
      if (typeof p !== "string" || p.length > 12000)
        throw Error("Invalid native instructions.");
      return p;
    });
    const original = { key, name: text(file.name, 80), pages };
    if (file.format === "pkt" || file.format === "pka") {
      result.nativeFile = { ...original, format: file.format };
    } else if (
      file.format === "pkz" &&
      (file.documentFormat === "pkt" || file.documentFormat === "pka")
    ) {
      const resources = list(file.resources, 255).map(packageResource);
      unique(resources.map((resource) => resource.name));
      result.nativeFile = {
        ...original,
        format: "pkz",
        documentFormat: file.documentFormat,
        resources,
        ...(file.background !== undefined && {
          background: parseBackground(file.background),
        }),
      };
    } else {
      throw Error("Invalid native file reference.");
    }
  }
  if (raw.packageEdits !== undefined) {
    const edits = object(raw.packageEdits);
    const add = list(edits.add, 255).map((entry) => ({
      ...packageResource(entry),
      key: attachmentKey(object(entry).key),
    }));
    const remove = list(edits.remove, 255).map((name) => text(name, 1024));
    unique(add.map((file) => file.name));
    unique(remove);
    result.packageEdits = {
      add,
      remove,
      ...(edits.background !== undefined && {
        background:
          edits.background === null ? null : parseBackground(edits.background),
      }),
    };
  }
  if (raw.annotations !== undefined)
    result.annotations = parseAnnotations(raw.annotations);
  if (raw.scenarios !== undefined)
    result.scenarios = parseScenarios(raw.scenarios);
  const scenarios = scenariosFor(result).map((s) => s.id);
  if (raw.activeScenario !== undefined) {
    result.activeScenario = text(raw.activeScenario, 80);
    if (!scenarios.includes(result.activeScenario))
      throw Error("Unknown active scenario.");
  }
  if (raw.pdus !== undefined)
    result.pdus = parsePdus(raw.pdus, devices, scenarios);
  if (raw.physical !== undefined)
    result.physical = parsePhysical(raw.physical, result.devices);
  if (raw.activity !== undefined) {
    const activity = object(raw.activity);
    const initial = parseWorkspace(object(activity.initial), false);
    result.activity = parseActivity(activity, initial);
  }
  const conflict = natConflict(result);
  if (conflict) throw Error(conflict);
  serializeTopology(result);
  return result;
}
export function serializeTopology(t: Topology): string {
  const json = JSON.stringify(t, null, 2);
  if (new TextEncoder().encode(json).length > MAX_FILE_BYTES)
    throw new Error(
      "Workspace exceeds the 2 MiB limit. Reduce page bodies, saved startup copies or unused devices.",
    );
  return json;
}
