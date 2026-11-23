import type { CliSession, Device, Topology } from "./types.ts";
import type { CommandResult } from "./cli.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
import { clearNat } from "./networkRuntime.ts";
import { prefixFromMask } from "./addressing.ts";
export function natCommand(
  _t: Topology,
  d: Device,
  s: CliSession,
  line: string,
  r: NetworkRuntime,
  mutate: (edit: (d: Device) => void) => CommandResult,
  unchanged: (text: string) => CommandResult,
): CommandResult | null {
  if (d.kind !== "router") return null;
  const raw = line.trim().split(/\s+/),
    w = raw.map((s) => s.toLowerCase()),
    lower = w.join(" ");
  if (
    ["user", "privileged"].includes(s.mode) &&
    lower === "show ip nat translations"
  ) {
    const rows = [
      ...r.hairpin
        .filter((e) => e.router === d.id)
        .map(
          (e) =>
            `hairpin ${e.protocol} ${e.publicIp}:${e.publicPort} ${e.serverIp}:${e.serverPort} client ${e.clientIp}:${e.clientPort} via ${e.snatIp}:${e.snatPort}`,
        ),
      ...r.poolBindings
        .filter((e) => e.router === d.id)
        .map((e) => `--- ${e.globalIp} ${e.insideIp} --- --- (pool ${e.pool})`),
      ...(d.nat?.static ?? []).map(
        (e) => `--- ${e.outside} ${e.inside} --- ---`,
      ),
      ...(d.nat?.portForwards ?? []).map(
        (f) =>
          `${f.protocol} ${f.outside}:${f.outsidePort} ${f.inside}:${f.insidePort} --- ---`,
      ),
      ...r.nat
        .filter((e) => e.router === d.id)
        .map(
          (e) =>
            `${e.protocol} ${e.globalIp}:${e.globalPort} ${e.insideIp}:${e.insidePort} ${e.remoteIp}:${e.remotePort} ${e.remoteIp}:${e.remotePort}${e.pool ? ` (pool ${e.pool})` : ""}`,
        ),
    ].join("\n");
    return unchanged(
      rows
        ? "Pro Inside global Inside local Outside local Outside global\n" + rows
        : "",
    );
  }
  if (
    ["user", "privileged"].includes(s.mode) &&
    lower === "show ip nat statistics"
  )
    return unchanged(
      `Static mappings: ${(d.nat?.static.length ?? 0) + (d.nat?.portForwards?.length ?? 0)}\nActive dynamic translations: ${r.hairpin.filter((e) => e.router === d.id).length + r.nat.filter((e) => e.router === d.id).length + r.poolBindings.filter((e) => e.router === d.id).length}\nPool address bindings: ${r.poolBindings.filter((e) => e.router === d.id).length}\nVirtual clock: ${r.time}s; bounded educational NAT model.`,
    );
  if (s.mode === "privileged" && lower === "clear ip nat translation *") {
    clearNat(r, d.id);
    return unchanged(
      "Dynamic NAT translations cleared; static configuration retained.",
    );
  }
  if (s.mode === "interface" && s.portId) {
    if (lower === "ip nat inside" || lower === "ip nat outside")
      return mutate((d) => {
        d.ports.find((p) => p.id === s.portId)!.natRole = w[2] as
          "inside" | "outside";
      });
    if (lower === "no ip nat inside" || lower === "no ip nat outside")
      return mutate((d) => {
        const p = d.ports.find((p) => p.id === s.portId)!;
        if (p.natRole === w[3]) delete p.natRole;
      });
  }
  if (s.mode === "config") {
    if (
      lower === "ip nat hairpin enable" ||
      lower === "no ip nat hairpin enable"
    )
      return mutate((d) => {
        d.nat ??= { static: [], overload: [] };
        d.nat.hairpin = !lower.startsWith("no ");
      });
    if (/^ip nat pool \S+ \S+ \S+ (netmask|prefix-length) \S+$/.test(lower))
      return mutate((d) => {
        const prefix = w[6] === "netmask" ? prefixFromMask(w[7]) : Number(w[7]);
        d.nat ??= { static: [], overload: [] };
        d.nat.pools = [
          ...(d.nat.pools ?? []).filter((p) => p.name !== raw[3]),
          { name: raw[3], start: w[4], end: w[5], prefix: prefix ?? -1 },
        ];
      });
    if (/^no ip nat pool \S+$/.test(lower))
      return mutate((d) => {
        if (d.nat) d.nat.pools = d.nat.pools?.filter((p) => p.name !== raw[4]);
      });
    if (/^ip nat inside source list \S+ pool \S+( overload)?$/.test(lower))
      return mutate((d) => {
        d.nat ??= { static: [], overload: [] };
        d.nat.poolRules ??= [];
        d.nat.poolRules.push({
          acl: raw[5],
          pool: raw[7],
          overload: w[8] === "overload",
        });
      });
    if (/^no ip nat inside source list \S+ pool \S+( overload)?$/.test(lower))
      return mutate((d) => {
        if (d.nat)
          d.nat.poolRules = d.nat.poolRules?.filter(
            (r) =>
              r.acl !== raw[6] ||
              r.pool !== raw[8] ||
              r.overload !== (w[9] === "overload"),
          );
      });
    if (/^ip nat inside source static (tcp|udp) \S+ \d+ \S+ \d+$/.test(lower))
      return mutate((d) => {
        d.nat ??= { static: [], overload: [] };
        d.nat.portForwards ??= [];
        d.nat.portForwards.push({
          protocol: w[5] as "tcp" | "udp",
          inside: w[6],
          insidePort: Number(w[7]),
          outside: w[8],
          outsidePort: Number(w[9]),
        });
      });
    if (
      /^no ip nat inside source static (tcp|udp) \S+ \d+ \S+ \d+$/.test(lower)
    )
      return mutate((d) => {
        if (d.nat)
          d.nat.portForwards = d.nat.portForwards?.filter(
            (f) =>
              f.protocol !== w[6] ||
              f.inside !== w[7] ||
              f.insidePort !== Number(w[8]) ||
              f.outside !== w[9] ||
              f.outsidePort !== Number(w[10]),
          );
      });
    if (/^ip nat inside source static \S+ \S+$/.test(lower))
      return mutate((d) => {
        d.nat ??= { static: [], overload: [] };
        d.nat.static.push({ inside: w[5], outside: w[6] });
      });
    if (/^no ip nat inside source static \S+ \S+$/.test(lower))
      return mutate((d) => {
        if (d.nat)
          d.nat.static = d.nat.static.filter(
            (e) => e.inside !== w[6] || e.outside !== w[7],
          );
      });
    if (/^ip nat inside source list \S+ interface \S+ overload$/.test(lower)) {
      const port = d.ports.find((p) => p.name.toLowerCase() === w[7]);
      if (!port) return unchanged("% Unknown NAT interface.");
      return mutate((d) => {
        d.nat ??= { static: [], overload: [] };
        d.nat.overload.push({ acl: raw[5], outsidePort: port.id });
      });
    }
    if (
      /^no ip nat inside source list \S+ interface \S+ overload$/.test(lower)
    ) {
      const port = d.ports.find((p) => p.name.toLowerCase() === w[8]);
      return mutate((d) => {
        if (d.nat)
          d.nat.overload = d.nat.overload.filter(
            (e) => e.acl !== raw[6] || e.outsidePort !== port?.id,
          );
      });
    }
  }
  return null;
}
