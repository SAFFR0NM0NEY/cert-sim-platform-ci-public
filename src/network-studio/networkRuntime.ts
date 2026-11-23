import {
  pruneBpduState,
  synchronizeBpduGuard,
  bpduGuardDeadline,
} from "./bpduGuard.ts";
import { activePdus } from "./scenarios.ts";
import { updateDiscovery, pruneNeighbors, type Neighbor } from "./discovery.ts";
import {
  ageSecureAddresses,
  recoveryDeadline,
  recoverSecurity,
} from "./portSecurity.ts";
import type {
  DnsAddressType,
  Topology,
  PingResult,
  Endpoint,
} from "./types.ts";
export interface MacEntry {
  device: string;
  vlan: number;
  mac: string;
  port: string;
  lastSeen: number;
}
export interface FrameDecision {
  channelMembers?: { channel: string; member: string; link: string }[];
  device: string;
  vlan: number;
  source: string;
  destination: string;
  ingress: string;
  egress: string[];
  action: "flood" | "forward" | "filter" | "security-drop";
  time: number;
}
export interface NatTranslation {
  router: string;
  outsidePort: string;
  protocol: "icmp" | "tcp" | "udp";
  insideIp: string;
  insidePort: number;
  globalIp: string;
  globalPort: number;
  remoteIp: string;
  remotePort: number;
  lastUsed: number;
  pool?: string;
}
export interface NatPoolBinding {
  router: string;
  pool: string;
  outsidePort: string;
  insideIp: string;
  globalIp: string;
  lastUsed: number;
}
export interface HairpinTranslation {
  router: string;
  insidePort: string;
  protocol: "icmp" | "tcp" | "udp";
  clientIp: string;
  clientPort: number;
  publicIp: string;
  publicPort: number;
  serverIp: string;
  serverPort: number;
  snatIp: string;
  snatPort: number;
  lastUsed: number;
}
export interface SecurePortState {
  shutdownAt?: number;
  sticky?: string[];
  learned?: Record<string, { created: number; lastSeen: number }>;
  device: string;
  port: string;
  addresses: string[];
  violations: number;
  shutdown: boolean;
  lastSource: string;
}
export interface Registration {
  phone: string;
  router: string;
  number: string;
  address: string;
  manager: string;
}
export interface LocalCall {
  caller: string;
  callee: string;
  state: "ringing" | "connected";
  started: number;
  lastNote?: { to: string; note: "Do" | "Re" | "Mi" };
}
export interface PhoneCheck {
  next: number;
  missed: number;
  message: string;
}
export interface AddressBinding {
  family: "ipv4" | "ipv6";
  device: string;
  port: string;
  address: string;
  mac: string;
  learned: number;
  expires: number;
}
export interface DnsAnswer {
  device: string;
  server: string;
  name: string;
  type: DnsAddressType;
  addresses: string[];
  expires: number;
}
export interface BpduPortState {
  device: string;
  port: string;
  edgeLost: boolean;
  shutdownAt?: number;
  violations: number;
  peer?: Endpoint;
  link?: string;
}
export interface NetworkRuntime {
  bpduPorts: BpduPortState[];
  dnsAnswers: DnsAnswer[];
  pduResults: Map<string, PingResult>;
  pduTimers: Map<
    string,
    { next?: number; remaining?: number; sent: number; last?: number }
  >;
  addressBindings: AddressBinding[];
  phoneChecks: Map<string, PhoneCheck>;
  registrations: Registration[];
  calls: LocalCall[];
  neighbors: Neighbor[];
  discoveryTick?: number;
  staticSecureTimers: Map<
    string,
    { created: number; lastSeen: number; expired: boolean }
  >;
  security: SecurePortState[];
  hairpin: HairpinTranslation[];
  time: number;
  fingerprint: string;
  mac: MacEntry[];
  frames: FrameDecision[];
  nat: NatTranslation[];
  poolBindings: NatPoolBinding[];
}
export const createRuntime = (): NetworkRuntime => ({
  bpduPorts: [],
  time: 0,
  phoneChecks: new Map(),
  pduResults: new Map(),
  pduTimers: new Map(),
  addressBindings: [],
  dnsAnswers: [],
  neighbors: [],
  registrations: [],
  calls: [],
  fingerprint: "",
  mac: [],
  frames: [],
  nat: [],
  poolBindings: [],
  hairpin: [],
  staticSecureTimers: new Map(),
  security: [],
});
function fingerprint(t: Topology): string {
  return JSON.stringify({
    devices: t.devices.map(
      ({
        id,
        kind,
        powered,
        ports,
        gateway,
        routes,
        routing,
        ipRouting,
        ipv6Routing,
        vlans,
        vtp,
        spanningTree,
        accessLists,
        cdp,
        lldp,
        managerAddress,
        callManager,
        wireless,
        x,
        y,
        securityRecovery,
        bpduGuardRecovery,
        nat,
        macAgingSeconds,
        staticMac,
      }) => ({
        ...(wireless ? { x, y } : {}),
        id,
        kind,
        powered,
        ports,
        gateway,
        routes,
        routing,
        ipRouting,
        ipv6Routing,
        vlans,
        vtp,
        spanningTree,
        accessLists,
        cdp,
        lldp,
        managerAddress,
        callManager,
        wireless,
        securityRecovery,
        bpduGuardRecovery,
        nat,
        macAgingSeconds,
        staticMac,
      }),
    ),
    links: t.links,
  });
}
function syncPduTimers(r: NetworkRuntime, t: Topology) {
  const scheduled = (t.pdus ?? []).filter((p) => p.schedule);
  for (const id of r.pduTimers.keys())
    if (!scheduled.some((p) => p.id === id)) r.pduTimers.delete(id);
  const active = new Set(activePdus(t).map((p) => p.id));
  for (const p of scheduled) {
    let timer = r.pduTimers.get(p.id);
    if (!timer) {
      timer = { sent: 0, remaining: p.schedule!.delay };
      r.pduTimers.set(p.id, timer);
    }
    if (active.has(p.id) && timer.remaining !== undefined) {
      timer.next = r.time + timer.remaining;
      delete timer.remaining;
    } else if (!active.has(p.id) && timer.next !== undefined) {
      timer.remaining = Math.max(0, timer.next - r.time);
      delete timer.next;
    }
  }
}
export function resetRuntime(
  r: NetworkRuntime,
  t?: Topology,
  options?: { preserveProtection?: boolean },
): void {
  if (!options?.preserveProtection) r.bpduPorts = [];
  if (t) pruneBpduState(t, r);
  if (t?.dhcpTime !== undefined && !options?.preserveProtection)
    r.time = t.dhcpTime;
  r.mac = [];
  r.neighbors = [];
  r.phoneChecks.clear();
  r.pduResults.clear();
  r.pduTimers.clear();
  r.addressBindings = [];
  r.dnsAnswers = [];
  r.registrations = [];
  r.calls = [];
  delete r.discoveryTick;
  r.frames = [];
  r.nat = [];
  r.hairpin = [];
  r.staticSecureTimers.clear();
  r.security = [];
  r.poolBindings = [];
  r.fingerprint = t ? fingerprint(t) : "";
  if (t) {
    syncPduTimers(r, t);
    updateDiscovery(t, r);
  }
}
export function adoptRuntime(r: NetworkRuntime, t: Topology): void {
  pruneBpduState(t, r);
  syncPduTimers(r, t);
  pruneNeighbors(t, r);
  for (const id of r.pduResults.keys())
    if (!t.pdus?.some((p) => p.id === id)) r.pduResults.delete(id);
  r.fingerprint = fingerprint(t);
}
export function bindRuntime(r: NetworkRuntime, t: Topology): void {
  const initializing = !r.fingerprint;
  const f = fingerprint(t);
  if (r.fingerprint && r.fingerprint !== f)
    resetRuntime(r, undefined, { preserveProtection: true });
  pruneBpduState(t, r);
  if (!r.fingerprint) {
    if (initializing && t.dhcpTime !== undefined) r.time = t.dhcpTime;
    syncPduTimers(r, t);
  }
  r.fingerprint = f;
  ageRuntime(r, t);
}
export function ageRuntime(r: NetworkRuntime, t: Topology): void {
  for (const state of r.security) {
    const due = recoveryDeadline(
      t.devices.find((d) => d.id === state.device),
      state,
    );
    if (due !== undefined && due <= r.time)
      recoverSecurity(r, state.device, state.port);
  }
  updateDiscovery(t, r);
  r.registrations = r.registrations.filter((reg) => {
    const phone = t.devices.find((d) => d.id === reg.phone);
    const router = t.devices.find((d) => d.id === reg.router);
    return (
      phone?.powered &&
      phone.ports[0].enabled &&
      phone.ports[0].ip === reg.address &&
      router?.powered &&
      router.callManager?.address === reg.manager
    );
  });
  const registered = new Set(r.registrations.map((reg) => reg.phone));
  r.calls = r.calls.filter(
    (call) =>
      registered.has(call.caller) &&
      registered.has(call.callee) &&
      (call.state === "connected" || r.time - call.started < 30),
  );
  r.dnsAnswers = r.dnsAnswers.filter((e) => e.expires > r.time);
  r.addressBindings = r.addressBindings.filter(
    (entry) => entry.expires > r.time,
  );
  ageSecureAddresses(r, t);
  r.mac = r.mac.filter((e) => {
    const d = t.devices.find((d) => d.id === e.device);
    return (
      d &&
      (d.macAgingSeconds === 0 ||
        r.time - e.lastSeen < (d.macAgingSeconds ?? 300))
    );
  });
  r.nat = r.nat.filter(
    (e) =>
      r.time - e.lastUsed <
      (e.protocol === "icmp" ? 30 : e.protocol === "udp" ? 60 : 300),
  );
  r.poolBindings = r.poolBindings.filter((e) => r.time - e.lastUsed < 300);
  r.hairpin = r.hairpin.filter(
    (e) =>
      r.time - e.lastUsed <
      (e.protocol === "icmp" ? 30 : e.protocol === "udp" ? 60 : 300),
  );
}
export function advanceRuntime(
  r: NetworkRuntime,
  t: Topology,
  seconds: number,
): void {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400)
    throw Error("Advance time by 0–86400 whole seconds.");
  bindRuntime(r, t);
  synchronizeBpduGuard(t, r);
  const end = r.time + seconds;
  // A large clock step can cross several outages. End each outage at its
  // deadline before sampling subsequent advertisements.
  const deadlines = new Set([
    ...r.security.map((state) =>
      recoveryDeadline(
        t.devices.find((d) => d.id === state.device),
        state,
      ),
    ),
    ...r.bpduPorts.map((state) =>
      bpduGuardDeadline(
        t.devices.find((d) => d.id === state.device),
        state,
      ),
    ),
  ]);
  for (const due of [...deadlines]
    .filter((n): n is number => n !== undefined && n > r.time && n <= end)
    .sort((a, b) => a - b)) {
    r.time = due - 1;
    updateDiscovery(t, r);
    r.time = due;
    synchronizeBpduGuard(t, r);
    ageRuntime(r, t);
  }
  r.time = end;
  synchronizeBpduGuard(t, r);
  ageRuntime(r, t);
}
export function flushDns(r: NetworkRuntime, device: string): void {
  r.dnsAnswers = r.dnsAnswers.filter((e) => e.device !== device);
}
export function clearMac(r: NetworkRuntime, device?: string): void {
  r.mac = device ? r.mac.filter((e) => e.device !== device) : [];
}
export function clearNat(r: NetworkRuntime, router?: string): void {
  r.hairpin = router ? r.hairpin.filter((e) => e.router !== router) : [];
  r.nat = router ? r.nat.filter((e) => e.router !== router) : [];
  r.poolBindings = router
    ? r.poolBindings.filter((e) => e.router !== router)
    : [];
}
export const natSize = (r: NetworkRuntime) =>
  r.nat.length + r.poolBindings.length + r.hairpin.length;
