import { clearBpduState, synchronizeBpduGuard } from "./bpduGuard.ts";
import { parseTopology, serializeTopology } from "./persistence.ts";
import { synchronizeVtp } from "./vtp.ts";
import { applicationHost } from "./wireless.ts";
import type { AccessRule, CliSession, Device, Topology } from "./types.ts";
import type { CommandResult } from "./cli.ts";
import { defaultRouting, parseRule } from "./extensions.ts";
import { ipString, ipv4, mask, prefixFromMask } from "./addressing.ts";
import {
  eigrpTopology,
  interfaceMetric,
  learnedRoutes,
  routingNeighbors,
  routingParticipates,
} from "./routing.ts";
import { devicePdus, isRoutedInterface } from "./vlanInterfaces.ts";
import { dnsLookup, releaseDhcp, requestDhcp } from "./services.ts";
import { ipv6Command } from "./ipv6Cli.ts";
import { configurationSnapshot, reloadDevice } from "./deviceLifecycle.ts";
import { configurationError } from "./engine.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
type Mutate = (edit: (d: Device) => void) => CommandResult;
type Unchanged = (output: string, session?: CliSession) => CommandResult;
function wildcardPrefix(wildcard: string): number | null {
  const n = ipv4(wildcard);
  return n === null ? null : prefixFromMask(ipString(~n >>> 0));
}
function aclRule(tokens: string[]): AccessRule {
  let i = 2;
  const address = (): { network: string; prefix: number } => {
    if (tokens[i] === "any") {
      i++;
      return { network: "0.0.0.0", prefix: 0 };
    }
    if (tokens[i] === "host") {
      i++;
      return { network: tokens[i++], prefix: 32 };
    }
    const n = ipv4(tokens[i++] ?? ""),
      prefix = wildcardPrefix(tokens[i++] ?? "");
    if (n === null || prefix === null)
      throw new Error("Use any, host IP, or NETWORK CONTIGUOUS_WILDCARD.");
    return { network: ipString((n & mask(prefix)) >>> 0), prefix };
  };
  const source = address(),
    destination = address();
  let destinationPort: number | undefined;
  if (tokens[i] === "eq") {
    const aliases: Record<string, number> = {
      www: 80,
      http: 80,
      domain: 53,
      ftp: 21,
      ssh: 22,
      telnet: 23,
    };
    destinationPort = aliases[tokens[i + 1]] ?? Number(tokens[i + 1]);
    i += 2;
  }
  if (i !== tokens.length) throw new Error("Unsupported ACL qualifier.");
  return parseRule({
    action: tokens[0],
    protocol: tokens[1],
    source: source.network,
    sourcePrefix: source.prefix,
    destination: destination.network,
    destinationPrefix: destination.prefix,
    ...(destinationPort === undefined ? {} : { destinationPort }),
  });
}
export function advancedRunningConfig(d: Device): string[] {
  const address = (ip: string, prefix: number) =>
    prefix === 0
      ? "any"
      : prefix === 32
        ? `host ${ip}`
        : `${ip} ${ipString(~mask(prefix) >>> 0)}`;
  return [
    ...(d.nat?.pools?.map(
      (p) =>
        `ip nat pool ${p.name} ${p.start} ${p.end} prefix-length ${p.prefix}`,
    ) ?? []),
    ...(d.nat?.hairpin
      ? ["! CertSim hairpin extension", "ip nat hairpin enable"]
      : []),
    ...(d.nat?.poolRules?.map(
      (r) =>
        `ip nat inside source list ${r.acl} pool ${r.pool}${r.overload ? " overload" : ""}`,
    ) ?? []),
    ...(d.staticMac?.map(
      (e) =>
        `mac address-table static ${e.mac.match(/.{4}/g)?.join(".")} vlan ${e.vlan} interface ${d.ports.find((p) => p.id === e.port)?.name}`,
    ) ?? []),
    ...(d.nat?.portForwards?.map(
      (f) =>
        `ip nat inside source static ${f.protocol} ${f.inside} ${f.insidePort} ${f.outside} ${f.outsidePort}`,
    ) ?? []),
    ...(d.nat?.static.map(
      (s) => `ip nat inside source static ${s.inside} ${s.outside}`,
    ) ?? []),
    ...(d.nat?.overload.map(
      (o) =>
        `ip nat inside source list ${o.acl} interface ${d.ports.find((p) => p.id === o.outsidePort)?.name} overload`,
    ) ?? []),
    ...(d.ipv6Routing ? ["ipv6 unicast-routing"] : []),
    ...(d.macAgingSeconds !== undefined
      ? [`mac address-table aging-time ${d.macAgingSeconds}`]
      : []),
    ...(d.spanningTree?.priorities.map(
      (p) => `spanning-tree vlan ${p.vlan} priority ${p.priority}`,
    ) ?? []),
    ...(d.routes6?.map(
      (r) =>
        `ipv6 route ${r.network}/${r.prefix} ${r.nextHop}${r.interface ? ` ${d.ports.find((p) => p.id === r.interface)?.name}` : ""}`,
    ) ?? []),
    ...(d.dns ? [`ip name-server ${d.dns}`] : []),
    ...(d.accessLists ?? []).flatMap((acl) =>
      acl.rules.map(
        (r) =>
          `access-list ${acl.name} ${r.action} ${r.protocol} ${address(r.source, r.sourcePrefix)} ${address(r.destination, r.destinationPrefix)}${r.destinationPort ? ` eq ${r.destinationPort}` : ""}`,
      ),
    ),
    ...(d.routing && d.routing.protocol !== "none"
      ? [
          `router ${d.routing.protocol}${d.routing.protocol !== "rip" ? ` ${d.routing.processId}` : ""}`,
          ...(d.routing.protocol === "rip"
            ? [" version 2", " no auto-summary"]
            : d.routing.protocol === "eigrp"
              ? [
                  " no auto-summary",
                  ...(d.routing.routerId
                    ? [` eigrp router-id ${d.routing.routerId}`]
                    : []),
                ]
              : d.routing.routerId
                ? [` router-id ${d.routing.routerId}`]
                : []),
          ...d.routing.networks.map(
            (n) =>
              ` network ${n.network}${d.routing!.protocol === "ospf" ? ` ${ipString(~mask(n.prefix) >>> 0)} area ${n.area}` : d.routing!.protocol === "eigrp" ? ` ${ipString(~mask(n.prefix) >>> 0)}` : ""}`,
          ),
          ...d.routing.passivePorts.map(
            (id) =>
              ` passive-interface ${d.ports.find((p) => p.id === id)?.name}`,
          ),
        ]
      : []),
  ];
}
export function advancedCommand(
  t: Topology,
  d: Device,
  session: CliSession,
  line: string,
  mutate: Mutate,
  unchanged: Unchanged,
  runtime?: NetworkRuntime,
): CommandResult | null {
  if (
    session.mode === "privileged" &&
    (d.kind === "router" || d.kind === "switch")
  ) {
    if (
      [
        "copy running-config startup-config",
        "copy run start",
        "write memory",
        "wr",
      ].includes(line.toLowerCase())
    ) {
      const result = mutate((device) => {
        device.startupConfig = configurationSnapshot(device);
      });
      return {
        ...result,
        output: result.changed
          ? "Building startup configuration...\n[OK]"
          : result.output,
      };
    }
    if (["erase startup-config", "write erase"].includes(line.toLowerCase())) {
      const result = mutate((device) => {
        delete device.startupConfig;
      });
      return {
        ...result,
        output: result.changed
          ? "Startup configuration erased."
          : result.output,
      };
    }
    if (line.toLowerCase() === "show startup-config")
      return unchanged(
        d.startupConfig
          ? JSON.stringify(d.startupConfig, null, 2)
          : "No startup configuration.",
      );
    if (line.toLowerCase() === "reload") {
      const next = reloadDevice(d),
        error = configurationError(next);
      if (error) return unchanged(`% ${error}`);
      let restored: Topology = {
        ...t,
        devices: t.devices.map((device) =>
          device.id === d.id ? next : device,
        ),
        ...(t.pdus ? { pdus: devicePdus(t, next) } : {}),
      };
      try {
        const candidate = runtime ? structuredClone(runtime) : undefined;
        if (candidate) {
          clearBpduState(candidate, d.id);
          synchronizeBpduGuard(restored, candidate);
        }
        restored = synchronizeVtp(restored, candidate);
        parseTopology(serializeTopology(restored));
        if (runtime && candidate) runtime.bpduPorts = candidate.bpduPorts;
      } catch (error) {
        return unchanged(
          "% " + (error instanceof Error ? error.message : "Could not reload."),
        );
      }
      return {
        topology: restored,
        session: { mode: "user", portId: null },
        changed: true,
        output: d.startupConfig
          ? "Reloaded from startup configuration."
          : "Reloaded with factory defaults; no startup configuration.",
      };
    }
  }
  const ipv6Result = ipv6Command(
    t,
    d,
    session,
    line,
    mutate,
    unchanged,
    runtime,
  );
  if (ipv6Result) return ipv6Result;
  const raw = line.split(/\s+/),
    w = raw.map((s) => s.toLowerCase()),
    lower = w.join(" "),
    host = applicationHost(d.kind);
  if (host && (lower === "ipconfig /renew" || lower === "ipconfig /release")) {
    const result = lower.endsWith("/renew")
      ? requestDhcp(t, d.id, undefined, runtime)
      : releaseDhcp(t, d.id, undefined, runtime);
    return {
      topology: result.topology,
      session,
      output: result.message,
      changed: result.topology !== t,
    };
  }
  if (
    w[0] === "nslookup" &&
    (host || ["user", "privileged"].includes(session.mode))
  ) {
    const typed = w[1]?.startsWith("-type=");
    const type = typed ? w[1].slice(6).toUpperCase() : "A";
    const args = w.slice(typed ? 2 : 1);
    if ((type !== "A" && type !== "AAAA") || args.length < 1 || args.length > 2)
      return unchanged("% Use nslookup [-type=A|AAAA] HOST [DNS_SERVER].");
    const result = dnsLookup(t, d.id, args[0], args[1], runtime, type);
    return unchanged(result.message);
  }
  if (
    ["user", "privileged"].includes(session.mode) &&
    (d.kind === "router" || d.kind === "switch")
  ) {
    if (lower === "show ip protocols")
      return unchanged(
        `Routing protocol: ${d.routing?.protocol ?? "none"}${d.routing?.protocol === "eigrp" ? ` AS ${d.routing.processId}\nK values: 1 0 1 0 0; automatic summarization disabled.` : ""}\n${d.routing?.networks.map((n) => `${n.network}/${n.prefix}${d.routing?.protocol === "ospf" ? ` area ${n.area}` : ""}`).join("\n") ?? ""}\nPassive: ${d.routing?.passivePorts.map((id) => d.ports.find((p) => p.id === id)?.name).join(", ") || "none"}\nImmediate-convergence educational model; no protocol timers.`,
      );
    if (/^show ip eigrp (neighbors?|interfaces|topology)$/.test(lower)) {
      if (d.routing?.protocol !== "eigrp")
        return unchanged("EIGRP is not enabled.");
      const heading = `EIGRP IPv4 AS ${d.routing.processId}`;
      const neighbors = routingNeighbors(t, d.id, runtime);
      if (w[3] === "topology")
        return unchanged(
          heading +
            "\nSelected internal routes (converged model; no DUAL timers):\n" +
            (eigrpTopology(t, d.id, runtime)
              .map(
                (r) =>
                  `${r.network}/${r.prefix} metric ${r.metric}, via ${r.nextHop}, ${d.ports.find((p) => p.id === r.localPort)?.name}; minimum BW ${r.bandwidth} Kbit/s, total delay ${r.delay * 10} usec`,
              )
              .join("\n") || "No learned EIGRP routes."),
        );
      if (w[3] === "interfaces")
        return unchanged(
          heading +
            "\nInterface  Peers  BW (Kbit/s)  DLY (usec)\n" +
            (d.ports
              .filter(
                (p) =>
                  routingParticipates(t, d, p, runtime) &&
                  !d.routing!.passivePorts.includes(p.id),
              )
              .map((p) => {
                const metric = interfaceMetric(t, d, p, runtime);
                return `${p.name}  ${neighbors.filter((n) => n.localPort === p.id).length}  ${metric.bandwidth}  ${metric.delay * 10}`;
              })
              .join("\n") || "No active EIGRP interfaces."),
        );
      return unchanged(
        heading +
          "\nNeighbor  Address  Local interface\n" +
          (neighbors
            .map(
              (n) =>
                `${t.devices.find((peer) => peer.id === n.router)?.name}  ${n.nextHop}  ${d.ports.find((p) => p.id === n.localPort)?.name}`,
            )
            .join("\n") || "No EIGRP neighbors."),
      );
    }
    if (lower === "show ip ospf neighbor" && d.routing?.protocol !== "ospf")
      return unchanged("OSPF is not enabled.");
    if (lower === "show ip ospf neighbor" || lower === "show ip rip database")
      return unchanged(
        lower.includes("ospf")
          ? `Neighbor   Local interface   Next hop\n${routingNeighbors(
              t,
              d.id,
              runtime,
            )
              .map(
                (n) =>
                  `${t.devices.find((d) => d.id === n.router)?.name} ${d.ports.find((p) => p.id === n.localPort)?.name} ${n.nextHop}`,
              )
              .join("\n")}`
          : learnedRoutes(t, d.id, runtime)
              .filter((r) => r.protocol === "rip")
              .map(
                (r) =>
                  `${r.network}/${r.prefix} via ${r.nextHop}, metric ${r.metric}`,
              )
              .join("\n") || "No RIP learned routes.",
      );
    if (lower === "show access-lists")
      return unchanged(
        advancedRunningConfig(d)
          .filter((s) => s.startsWith("access-list"))
          .join("\n") || "No access lists.",
      );
  }
  if (session.mode === "config") {
    if (w[0] === "ip" && w[1] === "name-server" && w.length === 3)
      return mutate((device) => {
        device.dns = w[2];
      });
    if (
      (d.kind === "router" || d.kind === "switch") &&
      (lower === "router rip" || /^router (ospf|eigrp) \d+$/.test(lower))
    ) {
      const result = mutate((device) => {
        device.routing = {
          ...(device.routing ?? defaultRouting()),
          protocol: w[1] as "rip" | "ospf" | "eigrp",
          processId: w[1] !== "rip" ? Number(w[2]) : 1,
        };
      });
      return result.changed
        ? { ...result, session: { mode: "routing", portId: null } }
        : result;
    }
    if (
      (d.kind === "router" || d.kind === "switch") &&
      (lower === "no router rip" || /^no router (ospf|eigrp) \d+$/.test(lower))
    )
      return mutate((device) => {
        const routing = device.routing;
        if (
          routing &&
          ((lower === "no router rip" && routing.protocol === "rip") ||
            ((w[2] === "ospf" || w[2] === "eigrp") &&
              routing.protocol === w[2] &&
              routing.processId === Number(w[3])))
        )
          routing.protocol = "none";
      });
    if (
      (d.kind === "router" || d.kind === "switch") &&
      w[0] === "access-list" &&
      w.length >= 4
    ) {
      try {
        const standard = !["ip", "icmp", "tcp", "udp"].includes(w[3]);
        const rule = aclRule(
          standard ? [w[2], "ip", ...w.slice(3), "any"] : w.slice(2),
        );
        return mutate((device) => {
          device.accessLists ??= [];
          let acl = device.accessLists.find((a) => a.name === raw[1]);
          if (!acl) {
            acl = { name: raw[1], rules: [] };
            device.accessLists.push(acl);
          }
          acl.rules.push(rule);
        });
      } catch (error) {
        return unchanged(
          `% ${error instanceof Error ? error.message : "Invalid ACL rule."}`,
        );
      }
    }
    if (
      (d.kind === "router" || d.kind === "switch") &&
      w[0] === "no" &&
      w[1] === "access-list" &&
      w.length === 3
    )
      return mutate((device) => {
        device.accessLists = device.accessLists?.filter(
          (a) => a.name !== raw[2],
        );
        if (device.nat)
          device.nat.poolRules = device.nat.poolRules?.filter(
            (o) => o.acl !== raw[2],
          );
        if (device.nat)
          device.nat.overload = device.nat.overload.filter(
            (o) => o.acl !== raw[2],
          );
        for (const p of device.ports) {
          if (p.inboundAcl === raw[2]) p.inboundAcl = "";
          if (p.outboundAcl === raw[2]) p.outboundAcl = "";
        }
      });
  }
  if (
    session.mode === "interface" &&
    d.ports.some((p) => p.id === session.portId && isRoutedInterface(d, p))
  ) {
    const remove = w[0] === "no",
      a = remove ? w.slice(1) : w,
      original = remove ? raw.slice(1) : raw;
    if (
      (a[0] === "bandwidth" || a[0] === "delay") &&
      a.length === (remove ? 1 : 2)
    ) {
      const key = a[0] as "bandwidth" | "delay";
      const port = d.ports.find((p) => p.id === session.portId)!;
      if (port.channelGroup)
        return unchanged(
          "% Configure routing metrics on the Port-channel interface.",
        );
      const value = Number(a[1]),
        maximum = key === "bandwidth" ? 2147483647 : 16777215;
      if (
        !remove &&
        (!/^\d+$/.test(a[1]) ||
          !Number.isInteger(value) ||
          value < 1 ||
          value > maximum)
      )
        return unchanged(`% ${key} must be an integer from 1 to ${maximum}.`);
      return mutate((device) => {
        const p = device.ports.find((entry) => entry.id === session.portId)!;
        if (remove) delete p[key];
        else p[key] = value;
      });
    }
    if (
      a[0] === "ip" &&
      a[1] === "access-group" &&
      a.length === 4 &&
      ["in", "out"].includes(a[3])
    )
      return mutate((device) => {
        const p = device.ports.find((p) => p.id === session.portId)!;
        p[a[3] === "in" ? "inboundAcl" : "outboundAcl"] = remove
          ? ""
          : original[2];
      });
    if (w[0] === "ip" && w[1] === "ospf" && w[2] === "cost" && w.length === 4)
      return mutate((device) => {
        device.ports.find((p) => p.id === session.portId)!.cost = Number(w[3]);
      });
  }
  if (
    session.mode === "routing" &&
    (d.kind === "router" || d.kind === "switch") &&
    d.routing &&
    d.routing.protocol !== "none"
  ) {
    if (lower === "version 2" && d.routing.protocol === "rip")
      return unchanged("RIPv2 is selected.");
    if (
      lower === "no auto-summary" &&
      (d.routing.protocol === "rip" || d.routing.protocol === "eigrp")
    )
      return unchanged(
        "CIDR advertisements are used; automatic summarization is disabled.",
      );
    if (w[0] === "router-id" && w.length === 2 && d.routing.protocol === "ospf")
      return mutate((device) => {
        device.routing!.routerId = w[1];
      });
    const remove = w[0] === "no",
      a = remove ? w.slice(1) : w;
    if (d.routing.protocol === "eigrp") {
      if (lower === "auto-summary")
        return unchanged(
          "% EIGRP automatic summarization is not modeled; use no auto-summary.",
        );
      if (a[0] === "metric" && a[1] === "weights")
        return unchanged(
          lower === "metric weights 0 1 0 1 0 0" ||
            lower === "no metric weights"
            ? "Default EIGRP K values are selected: 1 0 1 0 0."
            : "% Only default EIGRP K values are modeled: metric weights 0 1 0 1 0 0.",
        );
      if (
        a[0] === "eigrp" &&
        a[1] === "router-id" &&
        (a.length === 3 || (remove && a.length === 2))
      )
        return mutate((device) => {
          device.routing!.routerId = remove ? "" : a[2];
        });
    }
    if (a[0] === "passive-interface" && a.length === 2) {
      const port = d.ports.find((p) => p.name.toLowerCase() === a[1]);
      if (!port) return unchanged("% Unknown passive interface.");
      return mutate((device) => {
        const r = device.routing!;
        r.passivePorts = r.passivePorts.filter((id) => id !== port.id);
        if (!remove) r.passivePorts.push(port.id);
      });
    }
    if (a[0] === "network") {
      let prefix: number | null = null;
      if (
        (d.routing.protocol === "rip" || d.routing.protocol === "eigrp") &&
        a.length === 2 &&
        ipv4(a[1]) !== null
      ) {
        const first = Number(a[1].split(".")[0]);
        prefix = first < 128 ? 8 : first < 192 ? 16 : 24;
      }
      if (d.routing.protocol === "eigrp" && a.length === 3)
        prefix = wildcardPrefix(a[2]);
      if (
        d.routing.protocol === "ospf" &&
        a.length === 5 &&
        a[3] === "area" &&
        a[4] === "0"
      )
        prefix = wildcardPrefix(a[2]);
      if (prefix === null || ipv4(a[1]) === null)
        return unchanged(
          "% Use network CLASSFUL_NETWORK for RIPv2, network NETWORK [WILDCARD] for EIGRP, or network NETWORK WILDCARD area 0 for OSPF.",
        );
      const network = ipString((ipv4(a[1])! & mask(prefix)) >>> 0),
        selectedPrefix = prefix;
      return mutate((device) => {
        const r = device.routing!;
        r.networks = r.networks.filter(
          (n) => n.network !== network || n.prefix !== selectedPrefix,
        );
        if (!remove)
          r.networks.push({ network, prefix: selectedPrefix, area: 0 });
      });
    }
  }
  return null;
}
