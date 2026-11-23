import type { Topology, Vlan, VtpConfig } from "./types.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
import { forwardingLinks } from "./etherChannel.ts";
import { securityDown } from "./portSecurity.ts";
import { isSwitchport } from "./vlanInterfaces.ts";
import { defaultVtp, vlanDatabase } from "./vlans.ts";
import { operationalSwitchport } from "./dtp.ts";

type Advertisement = { vtp: VtpConfig; vlans: Vlan[] };
/** Immediate, bounded VTP advertisement convergence at explicit mutation/clock boundaries. */
export function synchronizeVtp(
  t: Topology,
  runtime?: NetworkRuntime,
): Topology {
  const switches = t.devices.filter((d) => d.kind === "switch" && d.powered);
  if (!switches.some((d) => d.vtp?.domain && d.vtp.mode !== "transparent"))
    return t;
  const neighbors = new Map<string, string[]>();
  for (const link of forwardingLinks(t, runtime)) {
    const a = switches.find((d) => d.id === link.a.device),
      b = switches.find((d) => d.id === link.b.device);
    if (!a || !b) continue;
    const ap = operationalSwitchport(
        t,
        a,
        a.ports.find((p) => p.id === link.a.port)!,
        runtime,
      ),
      bp = operationalSwitchport(
        t,
        b,
        b.ports.find((p) => p.id === link.b.port)!,
        runtime,
      );
    // VTP control exchanges do not depend on the data VLAN allow list or STP state.
    if (
      !isSwitchport(a, ap) ||
      !isSwitchport(b, bp) ||
      ap.mode !== "trunk" ||
      bp.mode !== "trunk" ||
      (runtime &&
        (securityDown(runtime, a.id, ap.id) ||
          securityDown(runtime, b.id, bp.id)))
    )
      continue;
    neighbors.set(a.id, [...(neighbors.get(a.id) ?? []), b.id]);
    neighbors.set(b.id, [...(neighbors.get(b.id) ?? []), a.id]);
  }
  const devices = new Map(t.devices.map((d) => [d.id, d]));
  let changed = false;
  const sources = [...switches].sort(
    (a, b) =>
      (b.vtp?.revision ?? 0) - (a.vtp?.revision ?? 0) ||
      a.id.localeCompare(b.id),
  );
  for (const initial of sources) {
    const source = devices.get(initial.id)!;
    const config = source.vtp ?? defaultVtp();
    if (!config.domain || config.mode === "transparent") continue;
    const message: Advertisement = {
      vtp: { ...config },
      vlans: vlanDatabase(source).filter((v) => v.id <= 1005),
    };
    const queue = [...(neighbors.get(source.id) ?? [])],
      seen = new Set([source.id]);
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      if (seen.has(id)) continue;
      seen.add(id);
      const d = devices.get(id)!,
        current = d.vtp ?? defaultVtp();
      // Packet Tracer transparent switches relay advertisements without adoption.
      if (current.mode !== "transparent") {
        if (
          (current.domain && current.domain !== message.vtp.domain) ||
          (current.password ?? "") !== (message.vtp.password ?? "")
        )
          continue;
        const learnedDomain = !current.domain;
        if (
          message.vtp.revision > current.revision ||
          learnedDomain ||
          current.version !== message.vtp.version
        ) {
          const vtp: VtpConfig = {
            ...current,
            domain: message.vtp.domain,
            version: message.vtp.version,
            revision: Math.max(current.revision, message.vtp.revision),
          };
          const vlans =
            message.vtp.revision > current.revision
              ? [
                  ...message.vlans.map((v) => ({ ...v })),
                  ...vlanDatabase(d).filter((v) => v.id > 1005),
                ]
              : vlanDatabase(d);
          devices.set(id, { ...d, vtp, vlans });
          changed = true;
        }
        if (current.revision > message.vtp.revision) continue;
      }
      queue.push(
        ...(neighbors.get(id) ?? []).filter((next) => !seen.has(next)),
      );
    }
  }
  return changed
    ? { ...t, devices: t.devices.map((d) => devices.get(d.id)!) }
    : t;
}
