import { adoptRuntime, type NetworkRuntime } from "./networkRuntime.ts";
import { requestDhcp } from "./services.ts";
import type { Port, Topology } from "./types.ts";

const DISCOVERY_INTERVAL = 60;

export function nextDhcpDelay(t: Topology, includeDiscovery = true): number {
  let next = Infinity;
  for (const device of t.devices) {
    for (const port of device.ports) {
      if (port.dhcpLease) next = Math.min(next, port.dhcpLease.nextAttempt);
      if (includeDiscovery && port.dhcpRetryAt !== undefined)
        next = Math.min(next, port.dhcpRetryAt);
    }
    for (const lease of device.services?.dhcp.leases ?? []) {
      if (lease.expires !== undefined) next = Math.min(next, lease.expires);
    }
  }
  return Math.max(0, next - (t.dhcpTime ?? 0));
}

function replacePort(t: Topology, deviceId: string, port: Port): Topology {
  return {
    ...t,
    devices: t.devices.map((d) =>
      d.id !== deviceId
        ? d
        : {
            ...d,
            ports: d.ports.map((p) => (p.id === port.id ? port : p)),
          },
    ),
  };
}

function expireReservations(t: Topology, now: number): Topology {
  let changed = false;
  const devices = t.devices.map((device) => {
    const service = device.services;
    if (
      !service?.dhcp.leases.some(
        (l) => l.expires !== undefined && l.expires <= now,
      )
    )
      return device;
    changed = true;
    return {
      ...device,
      services: {
        ...service,
        dhcp: {
          ...service.dhcp,
          leases: service.dhcp.leases.filter(
            (l) => l.expires === undefined || l.expires > now,
          ),
        },
      },
    };
  });
  return changed ? { ...t, devices } : t;
}

export function processDhcpTimers(
  t: Topology,
  r: NetworkRuntime,
  quietSeconds: number,
): Topology {
  const now = t.dhcpTime ?? 0;
  t = expireReservations(t, now);
  // A successful renewal can repeat at each T1 in a large jump. Skip those
  // identical exchanges only within a quiet interval on a stable forwarding path.
  const stable = !t.devices.some(
    (d) => d.nat || d.ports.some((p) => p.security),
  );
  for (const client of t.devices) {
    for (const port of client.ports) {
      if (port.dhcpRetryAt !== undefined && port.dhcpRetryAt <= now) {
        const pending = { ...port };
        delete pending.dhcpRetryAt;
        if (
          (client.kind === "pc" || client.kind === "laptop") &&
          port.addressMode === "dhcp" &&
          !port.ip
        ) {
          if (client.powered && port.enabled) {
            const attempt = requestDhcp(t, client.id, port.id, r);
            if (attempt.ok) {
              t = attempt.topology;
              continue;
            }
          }
          // An expiring reservation can free an address. Keep the first retry
          // at or after that change even when the user advances a full day.
          const offline = !t.devices.some(
            (d) => d.powered && d.services?.dhcp.enabled,
          );
          const quiet =
            stable || offline
              ? Math.min(quietSeconds, nextDhcpDelay(t, false))
              : 0;
          const intervals = Math.max(1, Math.ceil(quiet / DISCOVERY_INTERVAL));
          pending.dhcpRetryAt = now + DISCOVERY_INTERVAL * intervals;
        }
        t = replacePort(t, client.id, pending);
        adoptRuntime(r, t);
        continue;
      }
      const lease = port.dhcpLease;
      if (!lease || lease.nextAttempt > now) continue;
      const active = port.addressMode === "dhcp" && port.ip === lease.address;
      if (!active || now >= lease.expires) {
        const next = structuredClone(t);
        const device = next.devices.find((d) => d.id === client.id)!;
        const nic = device.ports.find((p) => p.id === port.id)!;
        delete nic.dhcpLease;
        if (active) {
          nic.ip = "";
          if (client.kind === "pc" || client.kind === "laptop")
            nic.dhcpRetryAt = now + DISCOVERY_INTERVAL;
          device.gateway = "";
          device.dns = "";
          r.dnsAnswers = r.dnsAnswers.filter(
            (entry) => entry.device !== device.id,
          );
          r.addressBindings = r.addressBindings.filter(
            (entry) =>
              entry.device !== device.id && entry.address !== lease.address,
          );
          r.nat = r.nat.filter((entry) => entry.insideIp !== lease.address);
          r.poolBindings = r.poolBindings.filter(
            (entry) => entry.insideIp !== lease.address,
          );
          r.hairpin = r.hairpin.filter(
            (entry) =>
              entry.clientIp !== lease.address &&
              entry.serverIp !== lease.address,
          );
        }
        adoptRuntime(r, next);
        t =
          active && device.powered && nic.enabled
            ? requestDhcp(next, device.id, nic.id, r).topology
            : next;
        continue;
      }

      const rebindAt =
        lease.expires - lease.duration + Math.floor((lease.duration * 7) / 8);
      const mode = now < rebindAt ? "renew" : "rebind";
      const attempt = requestDhcp(t, client.id, port.id, r, mode);
      if (!attempt.ok) {
        const boundary = mode === "renew" ? rebindAt : lease.expires;
        t = replacePort(t, client.id, {
          ...port,
          dhcpLease: {
            ...lease,
            state: mode === "renew" ? "renewing" : "rebinding",
            nextAttempt: Math.min(
              boundary,
              now + Math.max(60, Math.floor((boundary - now) / 2)),
            ),
          },
        });
        adoptRuntime(r, t);
        continue;
      }

      t = attempt.topology;
      if (mode !== "renew" || !stable) continue;
      const renewed = t.devices
        .find((d) => d.id === client.id)!
        .ports.find((p) => p.id === port.id)!.dhcpLease!;
      const step = Math.floor(renewed.duration / 2);
      const skip = Math.floor(quietSeconds / step) * step;
      if (!skip) continue;
      // acceptLease returned a fresh topology. Keep the reservation and its
      // client's deadline at the same last successful renewal.
      renewed.expires += skip;
      renewed.nextAttempt += skip;
      const reservation = t.devices
        .find((d) => d.id === renewed.server)
        ?.services?.dhcp.leases.find(
          (l) => l.client === client.id && l.port === port.id,
        );
      if (reservation) reservation.expires = renewed.expires;
      adoptRuntime(r, t);
    }
  }
  return t;
}
