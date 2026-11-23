import {
  advanceRuntime,
  bindRuntime,
  adoptRuntime,
  type NetworkRuntime,
} from "./networkRuntime.ts";
import { vlanActive } from "./vlans.ts";
import { synchronizeBpduGuard } from "./bpduGuard.ts";
import { synchronizeVtp } from "./vtp.ts";
import { activePdus } from "./scenarios.ts";
import { runPdu } from "./pdus.ts";
import { nextDhcpDelay, processDhcpTimers } from "./dhcpClock.ts";
import { requestDhcp } from "./services.ts";
import { registerPhone, checkRegisteredPhone } from "./telephony.ts";
import type { Device, Topology } from "./types.ts";

// This is the workspace clock entry point. Protocol probes use bindRuntime
// internally, so provisioning is scheduled here instead of inside packet aging.
function checkPhone(t: Topology, r: NetworkRuntime, phone: Device): Topology {
  const id = phone.id,
    reg = r.registrations.find((reg) => reg.phone === id);
  if (reg) {
    const result = checkRegisteredPhone(t, r, reg);
    const missed = result.ok ? 0 : (r.phoneChecks.get(id)?.missed ?? 0) + 1;
    if (missed < 2) {
      r.phoneChecks.set(id, {
        next: r.time + 30,
        missed,
        message: result.ok
          ? "Call manager reachable."
          : "Call manager missed one keepalive.",
      });
      return t;
    }
    r.registrations = r.registrations.filter((reg) => reg.phone !== id);
    r.calls = r.calls.filter((c) => c.caller !== id && c.callee !== id);
    r.phoneChecks.set(id, {
      next: r.time + 10,
      missed: 0,
      message: "Registration expired after two missed keepalives.",
    });
    return t;
  }
  const nic = phone.ports[0];
  if (!nic.ip && nic.addressMode === "dhcp") {
    const lease = requestDhcp(t, id, nic.id, r);
    if (!lease.ok) {
      r.phoneChecks.set(id, {
        next: r.time + 10,
        missed: 0,
        message: lease.message,
      });
      return t;
    }
    t = lease.topology;
  }
  const result = registerPhone(t, r, id);
  if (!result.ok)
    r.phoneChecks.set(id, {
      next: r.time + 10,
      missed: 0,
      message: result.message,
    });
  return t;
}
function synchronizeClockVtp(r: NetworkRuntime, t: Topology): Topology {
  const converged = synchronizeVtp(t, r);
  if (converged === t) return t;
  // Background convergence preserves schedules and secure shutdown state.
  r.mac = r.mac.filter((entry) => {
    const d = converged.devices.find((d) => d.id === entry.device);
    return d && vlanActive(d, entry.vlan);
  });
  r.addressBindings = [];
  adoptRuntime(r, converged);
  bindRuntime(r, converged);
  return converged;
}
function advanceProtocolTime(
  r: NetworkRuntime,
  t: Topology,
  seconds: number,
): Topology {
  const shutdowns =
    r.security.filter((s) => s.shutdown).length +
    r.bpduPorts.filter((s) => s.shutdownAt !== undefined).length;
  advanceRuntime(r, t, seconds);
  return r.security.filter((s) => s.shutdown).length +
    r.bpduPorts.filter((s) => s.shutdownAt !== undefined).length <
    shutdowns
    ? synchronizeClockVtp(r, t)
    : t;
}

export function advanceWorkspaceClock(
  r: NetworkRuntime,
  t: Topology,
  seconds: number,
): Topology {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400)
    throw Error("Advance time by 0–86400 whole seconds.");
  bindRuntime(r, t);
  synchronizeBpduGuard(t, r);
  t = synchronizeClockVtp(r, t);
  const end = r.time + seconds;
  const phones = t.devices.filter(
    (d) => d.kind === "phone" && d.powered && d.ports[0].enabled,
  );
  for (const phone of phones) {
    if (!r.phoneChecks.has(phone.id))
      r.phoneChecks.set(phone.id, {
        next: r.time + 10,
        missed: 0,
        message: "Awaiting provisioning.",
      });
  }
  const schedules = activePdus(t).filter((p) => p.schedule);
  while (true) {
    const nextOther = Math.min(
      ...phones.map((d) => r.phoneChecks.get(d.id)!.next),
      ...schedules.map((p) => r.pduTimers.get(p.id)?.next ?? Infinity),
    );
    const leaseDelay = nextDhcpDelay(t);
    const next = Math.min(nextOther, r.time + leaseDelay);
    if (next > end) break;
    const step = Math.max(0, next - r.time);
    t = advanceProtocolTime(r, t, step);
    if (step && (t.dhcpTime !== undefined || Number.isFinite(leaseDelay)))
      t = { ...t, dhcpTime: (t.dhcpTime ?? 0) + step };
    if (step >= leaseDelay)
      t = processDhcpTimers(
        t,
        r,
        Math.max(0, Math.min(end, nextOther) - r.time),
      );
    for (const phone of phones) {
      if (r.phoneChecks.get(phone.id)!.next <= r.time)
        t = checkPhone(t, r, t.devices.find((d) => d.id === phone.id)!);
    }
    for (const p of schedules) {
      const timer = r.pduTimers.get(p.id);
      if (timer?.next === undefined || timer.next > r.time) continue;
      runPdu(t, p, r);
      timer.sent++;
      timer.last = r.time;
      timer.next =
        p.schedule!.interval === undefined
          ? undefined
          : r.time + p.schedule!.interval;
    }
  }
  const remaining = end - r.time;
  t = advanceProtocolTime(r, t, remaining);
  if (
    remaining &&
    (t.dhcpTime !== undefined || Number.isFinite(nextDhcpDelay(t)))
  )
    t = { ...t, dhcpTime: (t.dhcpTime ?? 0) + remaining };
  return t;
}
