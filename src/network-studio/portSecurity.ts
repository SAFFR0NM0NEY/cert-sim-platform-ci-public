import { isSwitchport } from "./vlanInterfaces.ts";
import type { Device, Port, PortSecurity, Topology } from "./types.ts";
import type { NetworkRuntime, SecurePortState } from "./networkRuntime.ts";
import { object, integer, list, text, bool } from "./validation.ts";
export function parsePortSecurity(value: unknown): PortSecurity {
  const c = object(value),
    maximum = integer(c.maximum, 1, 128),
    violation = c.violation;
  if (
    violation !== "protect" &&
    violation !== "restrict" &&
    violation !== "shutdown"
  )
    throw Error("Invalid port-security violation mode.");
  const addresses = list(c.addresses, 128).map((v) => text(v, 12));
  if (
    addresses.length > maximum ||
    new Set(addresses).size !== addresses.length ||
    addresses.some((mac) => !validSecureMac(mac))
  )
    throw Error("Port security needs unique unicast MACs within its maximum.");
  if (
    c.agingType !== undefined &&
    c.agingType !== "absolute" &&
    c.agingType !== "inactivity"
  )
    throw Error("Invalid secure aging type.");
  const bindings =
    c.bindings === undefined
      ? undefined
      : list(c.bindings, 128).map((v) => {
          const b = object(v);
          const mac = text(b.mac, 12);
          if (!validSecureMac(mac)) throw Error("Invalid secure binding MAC.");
          return {
            vlan: integer(b.vlan, 1, 4094),
            mac,
            sticky: bool(b.sticky),
          };
        });
  const vlanMaximums =
    c.vlanMaximums === undefined
      ? undefined
      : list(c.vlanMaximums, 128).map((v) => {
          const b = object(v);
          return {
            vlan: integer(b.vlan, 1, 4094),
            maximum: integer(b.maximum, 1, maximum),
          };
        });
  if (
    vlanMaximums &&
    new Set(vlanMaximums.map((b) => b.vlan)).size !== vlanMaximums.length
  )
    throw Error("Duplicate secure VLAN maximum.");
  return {
    ...(c.ageStatic === undefined ? {} : { ageStatic: bool(c.ageStatic) }),
    ...(c.sticky === undefined ? {} : { sticky: bool(c.sticky) }),
    ...(bindings ? { bindings } : {}),
    ...(vlanMaximums ? { vlanMaximums } : {}),
    maximum,
    violation,
    addresses,
    ...(c.agingMinutes === undefined
      ? {}
      : { agingMinutes: integer(c.agingMinutes, 0, 1440) }),
    ...(c.agingType === undefined ? {} : { agingType: c.agingType }),
  };
}
export const validSecureMac = (mac: string) =>
  /^[0-9a-f]{12}$/.test(mac) &&
  mac !== "000000000000" &&
  !(parseInt(mac.slice(0, 2), 16) & 1);
export function validatePortSecurity(d: Device): void {
  const owners = new Map<string, string>();
  for (const p of d.ports) {
    if (
      p.voiceVlan !== undefined &&
      (!isSwitchport(d, p) ||
        p.mode !== "access" ||
        !Number.isInteger(p.voiceVlan) ||
        p.voiceVlan < 1 ||
        p.voiceVlan > 4094 ||
        p.voiceVlan === p.vlan)
    )
      throw Error("Voice VLAN needs a distinct VLAN on a switch access port.");
    if (
      p.taggedVlan !== undefined &&
      (!["pc", "server"].includes(d.kind) ||
        !Number.isInteger(p.taggedVlan) ||
        p.taggedVlan < 1 ||
        p.taggedVlan > 4094)
    )
      throw Error(
        "Tagged endpoint VLAN needs a workstation/server NIC and VLAN 1–4094.",
      );
    if (!p.security) continue;
    if (!isSwitchport(d, p) || p.virtual || p.channelGroup)
      throw Error("Port security requires a physical Layer 2 switchport.");
    if (p.mode !== "access" && p.mode !== "trunk")
      throw Error("Port security requires a static access or trunk mode.");
    const c = parsePortSecurity(p.security),
      bindings = configuredBindings(p);
    if (bindings.length > c.maximum)
      throw Error("Configured secure bindings exceed the port maximum.");
    for (const limit of c.vlanMaximums ?? [])
      if (
        !securityCarries(p, limit.vlan) ||
        bindings.filter((b) => b.vlan === limit.vlan).length > limit.maximum
      )
        throw Error("Invalid or exceeded secure VLAN maximum.");
    for (const b of bindings) {
      const key = `${b.vlan}/${b.mac}`;
      if (
        !securityCarries(p, b.vlan) ||
        owners.has(key) ||
        d.staticMac?.some(
          (e) => e.vlan === b.vlan && e.mac === b.mac && e.port !== p.id,
        )
      )
        throw Error("Conflicting secure MAC ownership or unsupported VLAN.");
      if (b.sticky && !c.sticky)
        throw Error("Sticky bindings require sticky learning enabled.");
      owners.set(key, p.id);
    }
  }
}
export function securityDown(
  r: NetworkRuntime,
  device: string,
  port: string,
): boolean {
  return !!r.security.find((s) => s.device === device && s.port === port)
    ?.shutdown;
}
export function recoveryDeadline(
  d: Device | undefined,
  state: SecurePortState | undefined,
): number | undefined {
  return d?.securityRecovery?.enabled &&
    state?.shutdown &&
    state.shutdownAt !== undefined
    ? state.shutdownAt + d.securityRecovery.interval
    : undefined;
}
export function recoverSecurity(
  r: NetworkRuntime,
  device: string,
  port: string,
): void {
  r.security = r.security.filter((s) => s.device !== device || s.port !== port);
  r.mac = r.mac.filter((e) => e.device !== device || e.port !== port);
}
const staticTimerKey = (
  device: string,
  port: string,
  vlan: number,
  mac: string,
) => JSON.stringify([device, port, vlan, mac]);

function activeConfiguredBindings(d: Device, p: Port, r: NetworkRuntime) {
  return configuredBindings(p).filter(
    (b) =>
      b.sticky ||
      !r.staticSecureTimers.get(staticTimerKey(d.id, p.id, b.vlan, b.mac))
        ?.expired,
  );
}

export function secureDestination(
  d: Device,
  vlan: number,
  mac: string,
  r: NetworkRuntime,
): { port: string } | undefined {
  const p = d.ports.find(
    (p) =>
      p.security &&
      securityCarries(p, vlan) &&
      (activeConfiguredBindings(d, p, r).some(
        (b) => b.vlan === vlan && b.mac === mac,
      ) ||
        r.security
          .find((s) => s.device === d.id && s.port === p.id)
          ?.addresses.includes(secureKey(p, vlan, mac))),
  );
  return p ? { port: p.id } : undefined;
}
export function admitSecureSource(
  d: Device,
  p: Port,
  mac: string,
  r: NetworkRuntime,
  vlan = p.vlan,
): boolean {
  if (!p.security) return true;
  let s = r.security.find((s) => s.device === d.id && s.port === p.id);
  if (!s) {
    s = {
      device: d.id,
      port: p.id,
      addresses: [],
      violations: 0,
      shutdown: false,
      lastSource: "",
    };
    r.security.push(s);
  }
  if (s.shutdown) return false;
  const key = secureKey(p, vlan, mac),
    configured = activeConfiguredBindings(d, p, r),
    dynamic = s.addresses.filter(
      (k) => !configured.some((b) => secureKey(p, b.vlan, b.mac) === k),
    );
  const owner = secureDestination(d, vlan, mac, r);
  const conflict =
    (owner && owner.port !== p.id) ||
    d.staticMac?.some(
      (e) => e.vlan === vlan && e.mac === mac && e.port !== p.id,
    );
  if (
    !conflict &&
    (configured.some((b) => b.vlan === vlan && b.mac === mac) ||
      s.addresses.includes(key))
  ) {
    const timer = r.staticSecureTimers.get(
      staticTimerKey(d.id, p.id, vlan, mac),
    );
    if (timer && !timer.expired) timer.lastSeen = r.time;
    if (s.addresses.includes(key)) {
      s.learned ??= {};
      s.learned[key] ??= { created: r.time, lastSeen: r.time };
      s.learned[key].lastSeen = r.time;
    }
    return true;
  }
  const full =
    configured.length + dynamic.length >= p.security.maximum ||
    configured.filter((b) => b.vlan === vlan).length +
      dynamic.filter((k) => decodeSecureKey(p, k).vlan === vlan).length >=
      (p.security.vlanMaximums?.find((b) => b.vlan === vlan)?.maximum ??
        p.security.maximum) ||
    r.security.reduce((n, s) => n + s.addresses.length, 0) >= 4096;
  if (!conflict && !full) {
    s.addresses.push(key);
    if (p.security.sticky) {
      s.sticky ??= [];
      s.sticky.push(key);
    }
    s.learned ??= {};
    s.learned[key] = { created: r.time, lastSeen: r.time };
    return true;
  }
  if (p.security.violation !== "protect") {
    s.violations = Math.min(Number.MAX_SAFE_INTEGER, s.violations + 1);
    s.lastSource = key;
  }
  if (p.security.violation === "shutdown") {
    s.shutdown = true;
    s.shutdownAt = r.time;
  }
  return false;
}
function ageStaticBindings(r: NetworkRuntime, t: Topology): void {
  const present = new Set<string>();
  for (const d of t.devices) {
    for (const p of d.ports) {
      const policy = p.security;
      if (!policy?.ageStatic || !policy.agingMinutes) continue;
      for (const b of configuredBindings(p)) {
        if (b.sticky) continue;
        const key = staticTimerKey(d.id, p.id, b.vlan, b.mac);
        present.add(key);
        const timer = r.staticSecureTimers.get(key);
        if (!timer) {
          r.staticSecureTimers.set(key, {
            created: r.time,
            lastSeen: r.time,
            expired: false,
          });
          continue;
        }
        const since =
          policy.agingType === "inactivity" ? timer.lastSeen : timer.created;
        if (timer.expired || r.time - since < policy.agingMinutes * 60)
          continue;
        timer.expired = true;
        r.mac = r.mac.filter(
          (e) =>
            e.device !== d.id ||
            e.port !== p.id ||
            e.vlan !== b.vlan ||
            e.mac !== b.mac,
        );
      }
    }
  }
  for (const key of r.staticSecureTimers.keys())
    if (!present.has(key)) r.staticSecureTimers.delete(key);
}
export function ageSecureAddresses(r: NetworkRuntime, t: Topology): void {
  ageStaticBindings(r, t);
  for (const s of r.security) {
    const d = t.devices.find((d) => d.id === s.device);
    const p = d?.ports.find((p) => p.id === s.port);
    const minutes = p?.security?.agingMinutes ?? 0;
    if (!d || !p || !minutes) continue;
    const configured = activeConfiguredBindings(d, p, r),
      removed = new Set(
        s.addresses.filter((key) => {
          if (
            s.sticky?.includes(key) ||
            configured.some((b) => secureKey(p, b.vlan, b.mac) === key)
          )
            return false;
          const times = s.learned?.[key];
          return (
            times &&
            r.time -
              (p.security?.agingType === "inactivity"
                ? times.lastSeen
                : times.created) >=
              minutes * 60
          );
        }),
      );
    s.addresses = s.addresses.filter((key) => !removed.has(key));
    for (const key of removed) if (s.learned) delete s.learned[key];
    r.mac = r.mac.filter(
      (e) =>
        e.device !== s.device ||
        e.port !== s.port ||
        !removed.has(secureKey(p, e.vlan, e.mac)),
    );
  }
}
export const securityCarries = (p: Port, vlan: number) =>
  !p.virtual &&
  !p.routed &&
  (p.mode === "trunk"
    ? p.allowedVlans.includes(vlan)
    : p.vlan === vlan || p.voiceVlan === vlan);
export const configuredBindings = (p: Port) => [
  ...(p.security?.addresses.map((mac) => ({
    vlan: p.vlan,
    mac,
    sticky: false,
  })) ?? []),
  ...(p.security?.bindings ?? []),
];
export const secureKey = (p: Port, vlan: number, mac: string) =>
  vlan === p.vlan ? mac : `${vlan}/${mac}`;
export const decodeSecureKey = (p: Port, key: string) =>
  key.includes("/")
    ? { vlan: Number(key.split("/")[0]), mac: key.split("/")[1] }
    : { vlan: p.vlan, mac: key };
export function materializeSecurity(t: Topology, r: NetworkRuntime): Topology {
  let next = t;
  if ([...r.staticSecureTimers.values()].some((timer) => timer.expired)) {
    const devices = t.devices.map((d) => {
      let changed = false;
      const ports = d.ports.map((p) => {
        const c = p.security;
        if (!c?.ageStatic) return p;
        const expired = (vlan: number, mac: string) =>
          r.staticSecureTimers.get(staticTimerKey(d.id, p.id, vlan, mac))
            ?.expired;
        const addresses = c.addresses.filter((mac) => !expired(p.vlan, mac));
        const bindings = c.bindings?.filter(
          (b) => b.sticky || !expired(b.vlan, b.mac),
        );
        if (
          addresses.length === c.addresses.length &&
          bindings?.length === c.bindings?.length
        )
          return p;
        changed = true;
        return {
          ...p,
          security: { ...c, addresses, ...(bindings ? { bindings } : {}) },
        };
      });
      return changed ? { ...d, ports } : d;
    });
    if (devices.some((d, i) => d !== t.devices[i])) next = { ...t, devices };
  }
  return materializeSticky(next, r);
}
export function materializeSticky(t: Topology, r: NetworkRuntime): Topology {
  let next = t;
  for (const s of r.security) {
    const d = next.devices.find((d) => d.id === s.device),
      p = d?.ports.find((p) => p.id === s.port);
    if (!p?.security?.sticky) continue;
    const missing = (s.sticky ?? [])
      .map((key) => decodeSecureKey(p, key))
      .filter(
        (b) =>
          !configuredBindings(p).some(
            (c) => c.vlan === b.vlan && c.mac === b.mac,
          ),
      );
    if (!missing.length) continue;
    if (next === t) next = structuredClone(t);
    const port = next.devices
      .find((d) => d.id === s.device)!
      .ports.find((p) => p.id === s.port)!;
    port.security!.bindings = [
      ...(port.security!.bindings ?? []),
      ...missing.map((b) => ({ ...b, sticky: true })),
    ];
  }
  return next;
}
export function transitionSticky(
  r: NetworkRuntime,
  d: Device,
  port: string,
  enabled: boolean,
): void {
  const p = d.ports.find((p) => p.id === port)!;
  let s = r.security.find((s) => s.device === d.id && s.port === port);
  if (!s) {
    s = {
      device: d.id,
      port,
      addresses: [],
      violations: 0,
      shutdown: false,
      lastSource: "",
    };
    r.security.push(s);
  }
  if (enabled) {
    s.sticky = [...s.addresses];
  } else {
    for (const b of p.security?.bindings?.filter((b) => b.sticky) ?? []) {
      const key = secureKey(p, b.vlan, b.mac);
      if (!s.addresses.includes(key)) s.addresses.push(key);
      s.learned ??= {};
      s.learned[key] = { created: r.time, lastSeen: r.time };
    }
    s.sticky = [];
  }
}
