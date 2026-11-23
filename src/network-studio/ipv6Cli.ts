import type { CliSession, Device, Topology } from "./types.ts";
import type { CommandResult } from "./cli.ts";
import { formatIPv6, ipv6, mask6, usableIPv6 } from "./ipv6Address.ts";
import { resolveHostname } from "./services.ts";
import { isRoutedInterface } from "./vlanInterfaces.ts";
import { ping6 } from "./ipv6Engine.ts";
import { portOperational } from "./ethernet.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
export function ipv6Command(
  t: Topology,
  d: Device,
  session: CliSession,
  line: string,
  mutate: (edit: (d: Device) => void) => CommandResult,
  unchanged: (message: string) => CommandResult,
  runtime?: NetworkRuntime,
): CommandResult | null {
  const w = line.toLowerCase().split(/\s+/),
    lower = w.join(" "),
    networkDevice = d.kind === "router" || d.kind === "switch";
  if (
    w[0] === "ping" &&
    ((w.length === 2 && w[1].includes(":")) ||
      ((w[1] === "ipv6" || w[1] === "-6") &&
        (w.length === 3 || w.length === 4)))
  ) {
    if (networkDevice && !["user", "privileged"].includes(session.mode))
      return unchanged("% Exit configuration mode before ping.");
    const address = w.length === 2 ? w[1] : w[2],
      selected = w[3]
        ? d.ports.find((p) => p.name.toLowerCase() === w[3])?.id
        : undefined;
    if (w[3] && !selected) return unchanged("% Unknown IPv6 source interface.");
    let destination = address;
    if (!address.includes(":") && !/^[0-9.]+$/.test(address)) {
      const answer = resolveHostname(t, d.id, address, "AAAA", runtime);
      if (!answer.address) return unchanged(answer.message);
      destination = answer.address;
    }
    const result = ping6(t, d.id, destination, selected, runtime);
    return unchanged(`${result.ok ? "Success" : "Failed"}: ${result.message}`);
  }
  if (
    (lower === "ipv6config" && !networkDevice) ||
    (lower === "show ipv6 interface brief" &&
      networkDevice &&
      ["user", "privileged"].includes(session.mode))
  )
    return unchanged(
      d.ports
        .map(
          (p) =>
            `${p.name}: ${p.ipv6 || "unassigned"}/${p.prefix6 ?? 64} ${p.enabled ? "enabled" : "disabled"}`,
        )
        .join("\n") + `\nIPv6 gateway: ${d.gateway6 || "none"}`,
    );
  if (
    lower === "show ipv6 route" &&
    networkDevice &&
    ["user", "privileged"].includes(session.mode)
  )
    return unchanged(
      [
        `IPv6 forwarding: ${d.ipv6Routing ? "enabled" : "disabled"}`,
        ...d.ports
          .filter(
            (p) =>
              p.ipv6 && p.enabled && portOperational(t, d.id, p.id, runtime),
          )
          .map(
            (p) =>
              `C ${formatIPv6(ipv6(p.ipv6!)! & mask6(p.prefix6 ?? 64))}/${p.prefix6 ?? 64}, ${p.name}`,
          ),
        ...(d.routes6?.map(
          (r) =>
            `S ${r.network}/${r.prefix} via ${r.nextHop}${r.interface ? `, ${d.ports.find((p) => p.id === r.interface)?.name}` : ""}`,
        ) ?? []),
      ].join("\n"),
    );
  if (session.mode === "config" && networkDevice) {
    if (lower === "ipv6 unicast-routing" || lower === "no ipv6 unicast-routing")
      return mutate((device) => {
        device.ipv6Routing = !lower.startsWith("no ");
      });
    const remove = w[0] === "no",
      a = remove ? w.slice(1) : w;
    if (
      a[0] === "ipv6" &&
      a[1] === "route" &&
      (a.length === 4 || a.length === 5)
    ) {
      const cidr = a[2].split("/"),
        prefix = Number(cidr[1]),
        n = ipv6(cidr[0]);
      const nextHop = a[3].includes(":") ? a[3] : a[4],
        name = a[3].includes(":") ? a[4] : a[3];
      const port = name
        ? d.ports.find((p) => p.name.toLowerCase() === name)
        : undefined;
      if (
        cidr.length !== 2 ||
        !Number.isInteger(prefix) ||
        prefix < 0 ||
        prefix > 128 ||
        n === null ||
        (n & mask6(prefix)) !== n ||
        !nextHop ||
        !usableIPv6(nextHop) ||
        (name && !port)
      )
        return unchanged("% Invalid IPv6 route, next hop or interface.");
      return mutate((device) => {
        device.routes6 = (device.routes6 ?? []).filter(
          (r) =>
            !(
              ipv6(r.network) === n &&
              r.prefix === prefix &&
              ipv6(r.nextHop) === ipv6(nextHop) &&
              (r.interface ?? "") === (port?.id ?? "")
            ),
        );
        if (!remove)
          device.routes6.push({
            network: cidr[0],
            prefix,
            nextHop,
            ...(port ? { interface: port.id } : {}),
          });
      });
    }
  }
  if (session.mode === "interface" && networkDevice) {
    const port = d.ports.find((p) => p.id === session.portId);
    if (!port || !isRoutedInterface(d, port)) return null;
    if (lower === "no ipv6 address")
      return mutate((device) => {
        device.ports.find((p) => p.id === session.portId)!.ipv6 = "";
      });
    if (w[0] === "ipv6" && w[1] === "address" && w.length === 3) {
      if (
        port.virtual?.kind === "subinterface" &&
        port.virtual.vlan === undefined
      )
        return unchanged(
          "% Configure encapsulation dot1Q before addressing this subinterface.",
        );
      const parts = w[2].split("/");
      if (parts.length !== 2)
        return unchanged("% Use ipv6 address ADDRESS/PREFIX.");
      return mutate((device) => {
        const p = device.ports.find((p) => p.id === session.portId)!;
        p.ipv6 = parts[0];
        p.prefix6 = Number(parts[1]);
      });
    }
  }
  return null;
}
