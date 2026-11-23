import type { Device, Vlan, VtpConfig } from "./types.ts";
import { integer, list, object, text, unique } from "./validation.ts";
import { detachInterfaces, isSwitchport } from "./vlanInterfaces.ts";

const defaultNames = new Map<number, string>([
  [1, "default"],
  [1002, "fddi-default"],
  [1003, "token-ring-default"],
  [1004, "fddinet-default"],
  [1005, "trnet-default"],
]);
export const defaultVlans = (): Vlan[] =>
  [...defaultNames].map(([id, name]) => ({ id, name, state: "active" }));
export const defaultVtp = (): VtpConfig => ({
  mode: "server",
  domain: "",
  version: 1,
  revision: 0,
});
export const vlanName = (id: number) =>
  defaultNames.get(id) ?? "VLAN" + String(id).padStart(4, "0");
export const reservedVlan = (id: number) => defaultNames.has(id);

export function parseVlans(value: unknown): Vlan[] {
  const vlans = list(value, 4094).map((raw) => {
    const row = object(raw),
      id = integer(row.id, 1, 4094),
      name = text(row.name, 32);
    if (row.state !== "active" && row.state !== "suspended")
      throw Error("VLAN state must be active or suspended.");
    if (reservedVlan(id) && (name !== vlanName(id) || row.state !== "active"))
      throw Error("Default VLANs cannot be renamed or suspended.");
    return { id, name, state: row.state } as Vlan;
  });
  unique(vlans.map((v) => String(v.id)));
  return vlans;
}
export function parseVtp(value: unknown): VtpConfig {
  const v = object(value);
  if (!["server", "client", "transparent"].includes(String(v.mode)))
    throw Error("Select VTP server, client or transparent mode.");
  return {
    mode: v.mode as VtpConfig["mode"],
    domain: text(v.domain, 32, true),
    version: integer(v.version, 1, 2) as 1 | 2,
    revision: integer(v.revision, 0, 4294967295),
    ...(v.password === undefined
      ? {}
      : { password: text(v.password, 64, true) }),
  };
}
/** An omitted database retains version-one labs' implicit membership until managed. */
export function vlanDatabase(d: Device): Vlan[] {
  if (d.kind !== "switch") return [];
  const database = new Map(defaultVlans().map((v) => [v.id, v]));
  if (d.vlans) for (const v of d.vlans) database.set(v.id, { ...v });
  else {
    const ids = new Set<number>();
    for (const p of d.ports) {
      if (p.virtual?.kind === "svi") ids.add(p.virtual.vlan);
      if (!isSwitchport(d, p)) continue;
      if (p.mode !== "trunk") ids.add(p.vlan);
      if (p.mode !== "access") for (const vlan of p.allowedVlans) ids.add(vlan);
      if (p.voiceVlan) ids.add(p.voiceVlan);
      if (p.nativeVlan) ids.add(p.nativeVlan);
    }
    for (const id of ids)
      if (!database.has(id))
        database.set(id, { id, name: vlanName(id), state: "active" });
  }
  return [...database.values()].sort((a, b) => a.id - b.id);
}
export const vlanActive = (d: Device, id: number): boolean =>
  d.kind === "switch" &&
  (d.vlans === undefined ||
    reservedVlan(id) ||
    d.vlans.some((v) => v.id === id && v.state === "active"));
export function materializeVlans(d: Device): Device {
  if (d.kind !== "switch") throw Error("VLAN databases require a switch.");
  return { ...d, vlans: vlanDatabase(d) };
}
export const vlanMutable = (d: Device, id: number): boolean =>
  d.kind === "switch" &&
  Number.isInteger(id) &&
  id >= 1 &&
  id <= 4094 &&
  !reservedVlan(id) &&
  d.vtp?.mode !== "client" &&
  (id <= 1005 || d.vtp?.mode === "transparent");
function bump(vtp: VtpConfig): VtpConfig {
  if (vtp.revision === 4294967295)
    throw Error("VTP revision is exhausted; change the domain to reset it.");
  return { ...vtp, revision: vtp.revision + 1 };
}
function databaseChange(d: Device, vlans: Vlan[], id: number): Device {
  const vtp = d.vtp ?? defaultVtp();
  return {
    ...d,
    vlans,
    ...(vtp.mode === "server" && id <= 1005 ? { vtp: bump(vtp) } : {}),
  };
}
function checkVlanEdit(d: Device, id: number) {
  integer(id, 1, 4094);
  if (d.kind !== "switch") throw Error("VLAN databases require a switch.");
  if (d.vtp?.mode === "client")
    throw Error("VTP clients cannot create, change or delete VLANs.");
  if (reservedVlan(id))
    throw Error("Default VLANs cannot be changed or deleted.");
  if (id > 1005 && d.vtp?.mode !== "transparent")
    throw Error("Extended VLANs require VTP transparent mode.");
}
export function setVlan(
  d: Device,
  id: number,
  patch: Partial<Pick<Vlan, "name" | "state">> = {},
): Device {
  const next = materializeVlans(d);
  if (d.vtp?.mode === "client")
    throw Error("VTP clients cannot create, change or delete VLANs.");
  const old = next.vlans!.find((v) => v.id === id);
  if (
    old &&
    (patch.name === undefined || patch.name === old.name) &&
    (patch.state === undefined || patch.state === old.state)
  )
    return next;
  checkVlanEdit(d, id);
  const row = parseVlans([
    {
      id,
      name: patch.name ?? old?.name ?? vlanName(id),
      state: patch.state ?? old?.state ?? "active",
    },
  ])[0];
  const vlans = [...next.vlans!.filter((v) => v.id !== id), row].sort(
    (a, b) => a.id - b.id,
  );
  return databaseChange(next, vlans, id);
}
export function ensureAccessVlan(d: Device, id: number): Device {
  integer(id, 1, 4094);
  if (vlanDatabase(d).some((v) => v.id === id) || d.vtp?.mode === "client")
    return d;
  return setVlan(d, id);
}
/** Packet Tracer creates a database row for a newly declared SVI, even in client mode. */
export function ensureSviVlan(d: Device, id: number): Device {
  integer(id, 1, 4094);
  if (vlanDatabase(d).some((v) => v.id === id)) return d;
  if (d.vtp?.mode !== "client") return setVlan(d, id);
  if (id > 1005) throw Error("Extended VLANs require VTP transparent mode.");
  const next = materializeVlans(d);
  return {
    ...next,
    vlans: [
      ...next.vlans!,
      { id, name: vlanName(id), state: "active" as const },
    ].sort((a, b) => a.id - b.id),
  };
}

export function deleteVlan(d: Device, id: number): Device {
  checkVlanEdit(d, id);
  const next = materializeVlans(d);
  if (!next.vlans!.some((v) => v.id === id)) return next;
  return databaseChange(
    next,
    next.vlans!.filter((v) => v.id !== id),
    id,
  );
}
export function setVtp(
  d: Device,
  patch: Partial<Omit<VtpConfig, "revision">>,
): Device {
  const next = materializeVlans(d),
    old = d.vtp ?? defaultVtp();
  let vtp = parseVtp({ ...old, ...patch });
  if (vtp.mode !== "transparent" && next.vlans!.some((v) => v.id > 1005))
    throw Error(
      "Remove extended VLANs before enabling VTP server or client mode.",
    );
  if (vtp.domain !== old.domain || vtp.mode === "transparent") vtp.revision = 0;
  else if (vtp.version !== old.version && vtp.mode === "server")
    vtp = bump(vtp);
  return { ...next, vtp };
}
export function setSwitchport(
  d: Device,
  portId: string,
  enabled: boolean,
): Device {
  const old = d.ports.find((p) => p.id === portId);
  if (
    d.kind !== "switch" ||
    !old ||
    (old.virtual && old.virtual.kind !== "portchannel") ||
    !["copper", "fiber"].includes(old.media)
  )
    throw Error("Select a switch Ethernet port or Port-channel.");
  if (isSwitchport(d, old) === enabled) return d;
  const next = structuredClone(d),
    port = next.ports.find((p) => p.id === portId)!;
  // Conversion keeps the physical inventory and discovery but resets L2/L3-specific settings.
  detachInterfaces(next, new Set([portId]));
  next.ports = d.ports.map((p) =>
    p.id === portId ? port : structuredClone(p),
  );
  for (const key of [
    "ipv6",
    "prefix6",
    "helperAddresses",
    "inboundAcl",
    "outboundAcl",
    "cost",
    "natRole",
    "voiceVlan",
    "nonegotiate",
    "portFast",
    "bpduGuard",
    "security",
    "spanningTreeCost",
    "taggedVlan",
    "dhcpLease",
    "dhcpRetryAt",
    "addressMode",
  ] as const)
    delete port[key];
  Object.assign(port, {
    mode: "access",
    vlan: 1,
    allowedVlans: [1],
    ip: "",
    prefix: 24,
  });
  if (enabled) {
    delete port.routed;
    port.nativeVlan = 1;
  } else {
    port.routed = true;
    delete port.nativeVlan;
  }
  return next;
}
