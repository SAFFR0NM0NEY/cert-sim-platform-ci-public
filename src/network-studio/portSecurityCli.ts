import type { CliSession, Device } from "./types.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
import type { CommandResult } from "./cli.ts";
import {
  configuredBindings,
  recoveryDeadline,
  transitionSticky,
  decodeSecureKey,
} from "./portSecurity.ts";
import { isSwitchport, isPhysicalSwitchport } from "./vlanInterfaces.ts";
import { ensureAccessVlan } from "./vlans.ts";
import { bpduGuardDeadline } from "./bpduGuard.ts";
import { adoptRuntime } from "./networkRuntime.ts";
export function portSecurityCommand(
  d: Device,
  s: CliSession,
  line: string,
  r: NetworkRuntime,
  mutate: (edit: (d: Device) => Device | void) => CommandResult,
  unchanged: (text: string) => CommandResult,
): CommandResult | null {
  if (d.kind !== "switch") return null;
  const w = line.toLowerCase().trim().split(/\s+/),
    lower = w.join(" ");
  if (
    ["user", "privileged"].includes(s.mode) &&
    lower === "show errdisable recovery"
  ) {
    const config = d.securityRecovery ?? { enabled: false, interval: 300 };
    const pending = d.ports.flatMap((p) => {
      const state = r.security.find(
          (s) => s.device === d.id && s.port === p.id,
        ),
        due = recoveryDeadline(d, state);
      return due === undefined
        ? []
        : [p.name + " · " + Math.max(0, due - r.time) + "s remaining"];
    });
    const guardPending = d.ports.flatMap((p) => {
      const state = r.bpduPorts.find(
        (s) => s.device === d.id && s.port === p.id,
      );
      const due = bpduGuardDeadline(d, state);
      return due === undefined
        ? []
        : [
            p.name +
              " · bpduguard · " +
              Math.max(0, due - r.time) +
              "s remaining",
          ];
    });
    return unchanged(
      [
        "psecure-violation " + (config.enabled ? "Enabled" : "Disabled"),
        "bpduguard " +
          (d.bpduGuardRecovery ? "Enabled (CertSim extension)" : "Disabled"),
        "Interval " + config.interval + "s",
        ...pending,
        ...guardPending,
      ].join("\n"),
    );
  }
  if (s.mode === "config" && /^(?:no )?errdisable recovery /.test(lower)) {
    const enable = !lower.startsWith("no "),
      positive = lower.replace(/^no /, "");
    if (
      ![
        "errdisable recovery cause psecure-violation",
        "errdisable recovery cause bpduguard",
      ].includes(positive) &&
      !(enable
        ? /^errdisable recovery interval \d+$/.test(positive)
        : positive === "errdisable recovery interval")
    )
      return unchanged(
        "% Use errdisable recovery cause psecure-violation|bpduguard or interval 30–86400.",
      );
    const out = mutate((d) => {
      d.securityRecovery ??= { enabled: false, interval: 300 };
      if (positive.endsWith(" cause bpduguard")) d.bpduGuardRecovery = enable;
      else if (positive.includes(" cause "))
        d.securityRecovery.enabled = enable;
      else d.securityRecovery.interval = enable ? Number(w.at(-1)) : 300;
    });
    if (out.changed) {
      adoptRuntime(r, out.topology);
      out.preserveRuntime = true;
    }
    return out;
  }
  if (
    ["user", "privileged"].includes(s.mode) &&
    /^show port-security(?: interface \S+)?$/.test(lower)
  ) {
    const ports =
      w.length === 4
        ? d.ports.filter(
            (p) =>
              isPhysicalSwitchport(d, p) &&
              !p.channelGroup &&
              p.name.toLowerCase() === w[3],
          )
        : d.ports.filter((p) => isPhysicalSwitchport(d, p) && !p.channelGroup);
    if (!ports.length) return unchanged("% Unknown interface.");
    return unchanged(
      ports
        .map((p) => {
          const st = r.security.find(
            (e) => e.device === d.id && e.port === p.id,
          );
          return `${p.name}: ${!p.security ? "Disabled" : st?.shutdown ? "Secure-shutdown" : "Secure-up"}\nMaximum: ${p.security?.maximum ?? 1}; mode: ${p.security?.violation ?? "shutdown"}; violations: ${st?.violations ?? 0}\nSecure aging: ${p.security?.agingMinutes ?? 0} minutes ${p.security?.agingType ?? "absolute"}\nStatic aging: ${p.security?.ageStatic ? "Enabled" : "Disabled"}\nConfigured: ${
            configuredBindings(p)
              .map((b) => `${b.vlan}/${b.mac}${b.sticky ? " sticky" : ""}`)
              .join(", ") || "none"
          }\nDynamic secure: ${
            st?.addresses
              .map((key) => {
                const b = decodeSecureKey(p, key);
                return `${b.vlan}/${b.mac}`;
              })
              .join(", ") || "none"
          }`;
        })
        .join("\n"),
    );
  }
  if (s.mode !== "interface" || !s.portId) return null;
  const remove = w[0] === "no",
    a = remove ? w.slice(1) : w,
    p = d.ports.find((p) => p.id === s.portId)!;
  if (!p || !isSwitchport(d, p)) return null;
  const vlan = (v: string) =>
    v === "access" ? p.vlan : v === "voice" ? (p.voiceVlan ?? 0) : Number(v);
  if (
    a[0] === "switchport" &&
    a[1] === "voice" &&
    a[2] === "vlan" &&
    (a.length === 4 || (remove && a.length === 3))
  )
    return mutate((d) => {
      const next = remove ? d : ensureAccessVlan(d, Number(a[3]));
      const p = next.ports.find((p) => p.id === s.portId)!;
      if (remove) delete p.voiceVlan;
      else p.voiceVlan = Number(a[3]);
      return next;
    });
  if (a[0] !== "switchport" || a[1] !== "port-security") return null;
  if (p.virtual || p.channelGroup)
    return unchanged(
      "% Port security requires a physical interface outside an EtherChannel.",
    );
  if (a.length === 4 && a[2] === "mac-address" && a[3] === "sticky") {
    const out = mutate((d) => {
      const q = d.ports.find((p) => p.id === s.portId)!;
      q.security ??= { maximum: 1, violation: "shutdown", addresses: [] };
      q.security.sticky = !remove;
      if (remove)
        q.security.bindings = q.security.bindings?.filter((b) => !b.sticky);
    });
    if (out.changed) {
      transitionSticky(r, d, p.id, !remove);
      adoptRuntime(r, out.topology);
      out.preserveRuntime = true;
    }
    return out;
  }
  const sticky = a[2] === "mac-address" && a[3] === "sticky",
    mi = sticky ? 4 : 3;
  if (
    a[2] === "mac-address" &&
    (a.length === mi + 1 || (a.length === mi + 3 && a[mi + 1] === "vlan"))
  )
    return mutate((d) => {
      const q = d.ports.find((p) => p.id === s.portId)!;
      q.security ??= { maximum: 1, violation: "shutdown", addresses: [] };
      const mac = a[mi].replace(/[.:-]/g, ""),
        v = a.length === mi + 3 ? vlan(a[mi + 2]) : q.vlan;
      q.security.bindings = q.security.bindings?.filter(
        (b) => b.mac !== mac || b.vlan !== v || b.sticky !== sticky,
      );
      if (!sticky && v === q.vlan)
        q.security.addresses = q.security.addresses.filter((b) => b !== mac);
      if (!remove) {
        q.security.bindings ??= [];
        q.security.bindings.push({ vlan: v, mac, sticky });
        if (sticky) q.security.sticky = true;
      }
    });
  if (a[2] === "maximum" && a[4] === "vlan" && a.length === 6)
    return mutate((d) => {
      const q = d.ports.find((p) => p.id === s.portId)!;
      q.security ??= { maximum: 1, violation: "shutdown", addresses: [] };
      const v = vlan(a[5]);
      q.security.vlanMaximums =
        q.security.vlanMaximums?.filter((b) => b.vlan !== v) ?? [];
      if (!remove)
        q.security.vlanMaximums.push({ vlan: v, maximum: Number(a[3]) });
    });
  if (!(
    a.length === 2 ||
    (a.length === 4 && ["maximum", "violation"].includes(a[2])) ||
    (a[2] === "aging" && a[3] === "static" && a.length === 4) ||
    (a[2] === "aging" &&
      ["time", "type"].includes(a[3]) &&
      (a.length === 5 || (remove && a.length === 4)))
  ))
    return unchanged("% Unsupported port-security syntax.");
  return mutate((d) => {
    const q = d.ports.find((p) => p.id === s.portId)!;
    if (a.length === 2) {
      if (remove) delete q.security;
      else q.security ??= { maximum: 1, violation: "shutdown", addresses: [] };
      return;
    }
    q.security ??= { maximum: 1, violation: "shutdown", addresses: [] };
    if (a[2] === "maximum") q.security.maximum = remove ? 1 : Number(a[3]);
    if (a[2] === "violation")
      q.security.violation = remove ? "shutdown" : (a[3] as "shutdown");
    if (a[2] === "aging") {
      if (a[3] === "static") q.security.ageStatic = !remove;
      else if (a[3] === "time")
        q.security.agingMinutes = remove ? 0 : Number(a[4]);
      else q.security.agingType = remove ? "absolute" : (a[4] as "absolute");
    }
  });
}
