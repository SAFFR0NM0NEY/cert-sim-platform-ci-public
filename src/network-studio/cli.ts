import type { CliSession, Device, Topology } from "./types.ts";
import { advancedCommand, advancedRunningConfig } from "./advancedCli.ts";
import { vlanCommand, vlanRunningConfig } from "./vlanCli.ts";
import { ensureSviVlan, ensureAccessVlan } from "./vlans.ts";
import { synchronizeVtp } from "./vtp.ts";
import { learnedRoutes } from "./routing.ts";
import { portOperational } from "./ethernet.ts";
import {
  bridgePorts,
  createPortChannel,
  reconcilePortChannels,
} from "./etherChannel.ts";
import { etherChannelCommand, interfaceRange } from "./etherChannelCli.ts";
import { switchportState } from "./dtp.ts";
import {
  devicePdus,
  isSwitchport,
  createSubinterface,
  createSvi,
  isRoutedInterface,
  ipv4Forwarding,
  removeVirtualInterface,
} from "./vlanInterfaces.ts";
import { resolveHostname } from "./services.ts";
import {
  spanningTreeCommand,
  spanningTreeRunningConfig,
  spanningTreePortConfig,
} from "./spanningTreeCli.ts";
import { synchronizeBpduGuard, bpduGuardDown } from "./bpduGuard.ts";
import { parseTopology, serializeTopology } from "./persistence.ts";
import {
  bindRuntime,
  createRuntime,
  clearMac,
  flushDns,
} from "./networkRuntime.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
import { getPort, serialRole, linkStatus } from "./model.ts";
import { materializeSecurity } from "./portSecurity.ts";
import { adoptRuntime } from "./networkRuntime.ts";
import { discoveryCommand } from "./discoveryCli.ts";
import { portSecurityCommand } from "./portSecurityCli.ts";
import { natCommand } from "./natCli.ts";
import { natConflict } from "./nat.ts";
import {
  configurationError,
  ipString,
  ipv4,
  mask,
  ping,
  prefixFromMask,
  usableIp,
} from "./engine.ts";

export const INITIAL_CLI: CliSession = { mode: "user", portId: null };
export function prompt(d: Device, session: CliSession): string {
  if (session.mode === "interface" && session.portIds?.length)
    return d.name + "(config-if-range)#";
  if (
    session.mode === "interface" &&
    d.ports.find((p) => p.id === session.portId)?.virtual?.kind ===
      "subinterface"
  )
    return d.name + "(config-subif)#";
  return `${d.name}${{ user: ">", privileged: "#", config: "(config)#", interface: "(config-if)#", routing: "(config-router)#", vlan: "(config-vlan)#" }[session.mode]}`;
}
export interface CommandResult {
  topology: Topology;
  session: CliSession;
  output: string;
  changed: boolean;
  preserveRuntime?: boolean;
}
export function command(
  inputTopology: Topology,
  deviceId: string,
  session: CliSession,
  input: string,
  runtime: NetworkRuntime = createRuntime(),
  options: { deferControl?: boolean } = {},
): CommandResult {
  bindRuntime(runtime, inputTopology);
  const topology = materializeSecurity(inputTopology, runtime);
  if (topology !== inputTopology) adoptRuntime(runtime, topology);
  const device = topology.devices.find((d) => d.id === deviceId);
  const unchanged = (output: string, nextSession = session): CommandResult => ({
    topology,
    session: nextSession,
    output,
    changed: topology !== inputTopology,
    preserveRuntime: topology !== inputTopology,
  });
  if (!device) return unchanged("% Device no longer exists.");
  if (!device.powered) return unchanged("% Device is powered off.");
  const line = input.trim();
  if (!line) return unchanged("");
  if (line.length > 240) return unchanged("% Command exceeds 240 characters.");
  const words = line.toLowerCase().split(/\s+/);
  const lower = words.join(" ");
  const networkDevice = device.kind === "router" || device.kind === "switch";
  const commitControl = (next: Topology, state = runtime): Topology => {
    if (options.deferControl) {
      parseTopology(serializeTopology(next));
      return next;
    }
    const candidate = structuredClone(state);
    synchronizeBpduGuard(next, candidate);
    const synced = synchronizeVtp(next, candidate);
    parseTopology(serializeTopology(synced));
    state.bpduPorts = candidate.bpduPorts;
    return synced;
  };
  const mutate = (edit: (d: Device) => Device | void): CommandResult => {
    try {
      const next = structuredClone(topology);
      const index = next.devices.findIndex((d) => d.id === deviceId);
      const nextDevice = reconcilePortChannels(
        device,
        edit(next.devices[index]) ?? next.devices[index],
      );
      next.devices[index] = nextDevice;
      if (next.pdus) next.pdus = devicePdus(next, nextDevice);
      const error = configurationError(nextDevice) ?? natConflict(next);
      return error
        ? unchanged("% " + error)
        : {
            topology: commitControl(next),
            session,
            output: "",
            changed: true,
          };
    } catch (error) {
      return unchanged(
        "% " +
          (error instanceof Error ? error.message : "Invalid configuration."),
      );
    }
  };
  if (["user", "privileged"].includes(session.mode)) {
    if (lower === (networkDevice ? "show hosts" : "ipconfig /displaydns")) {
      const entries = runtime.dnsAnswers.filter((e) => e.device === device.id);
      return unchanged(
        entries.length
          ? entries
              .map(
                (e) =>
                  `${e.name}  ${e.type}  ${e.addresses.join(", ")}  ${e.expires - runtime.time}s`,
              )
              .join("\n")
          : "No cached DNS answers.",
      );
    }
    if (!networkDevice && lower === "ipconfig /flushdns") {
      flushDns(runtime, device.id);
      return unchanged("DNS cache cleared.");
    }
    const family =
      lower === "show ip arp" || lower === "arp -a"
        ? "ipv4"
        : lower === "show ipv6 neighbors"
          ? "ipv6"
          : null;
    if (family) {
      const entries = runtime.addressBindings.filter(
        (e) => e.device === device.id && e.family === family,
      );
      return unchanged(
        entries.length
          ? [
              "Address  MAC  Interface  Remaining",
              ...entries.map((e) =>
                [
                  e.address,
                  e.mac,
                  device.ports.find((p) => p.id === e.port)?.name,
                  e.expires - runtime.time + "s",
                ].join("  "),
              ),
            ].join("\n")
          : "No cached neighbors.",
      );
    }
    if (
      (!networkDevice || session.mode === "privileged") &&
      ["clear arp-cache", "clear ipv6 neighbors"].includes(lower)
    ) {
      const family = lower === "clear arp-cache" ? "ipv4" : "ipv6";
      runtime.addressBindings = runtime.addressBindings.filter(
        (e) => e.device !== device.id || e.family !== family,
      );
      return unchanged("Neighbor cache cleared.");
    }
  }
  const configurationMode = ["config", "interface", "routing", "vlan"].includes(
    session.mode,
  );
  const interfaceName = (name: string) =>
    name.replace(
      /^(?:gi(?:gabitethernet)?|fa(?:stethernet)?|eth(?:ernet)?|vl(?:an)?|po(?:rt-channel)?)(?=\d)/i,
      (prefix) =>
        ({
          gi: "GigabitEthernet",
          fa: "FastEthernet",
          et: "Ethernet",
          vl: "Vlan",
          po: "Port-channel",
        })[prefix.slice(0, 2).toLowerCase()]!,
    );
  if (networkDevice && configurationMode) {
    if (lower.startsWith("interface range ")) {
      try {
        const portIds = interfaceRange(device, lower.slice(16));
        return unchanged("", {
          mode: "interface",
          portId: portIds[0],
          portIds,
        });
      } catch (error) {
        return unchanged(
          "% " +
            (error instanceof Error
              ? error.message
              : "Invalid interface range."),
        );
      }
    }
    const select = /^(no )?interface\s+(\S+)(?:\s+(\d+))?$/.exec(lower);
    if (select) {
      const name = interfaceName(select[2] + (select[3] ?? ""));
      const existing = device.ports.find(
        (p) => p.name.toLowerCase() === name.toLowerCase(),
      );
      if (select[1]) {
        if (!existing?.virtual)
          return unchanged("% Select an existing logical interface to remove.");
        try {
          const next = removeVirtualInterface(topology, device.id, existing.id);
          return {
            topology: commitControl(next),
            session: { mode: "config", portId: null },
            output: "",
            changed: true,
          };
        } catch (error) {
          return unchanged(
            "% " +
              (error instanceof Error
                ? error.message
                : "Could not remove the interface."),
          );
        }
      }
      if (existing)
        return unchanged("", { mode: "interface", portId: existing.id });
      try {
        let port;
        const svi = /^vlan(\d+)$/i.exec(name);
        const channel = /^port-channel(\d+)$/i.exec(name);
        const subinterface = /^(.+)\.(\d+)$/.exec(name);
        if (channel) port = createPortChannel(device, Number(channel[1]));
        else if (svi) port = createSvi(device, Number(svi[1]));
        else if (subinterface) {
          const parent = device.ports.find(
            (p) => p.name.toLowerCase() === subinterface[1].toLowerCase(),
          );
          if (!parent)
            return unchanged("% The parent Ethernet interface does not exist.");
          port = createSubinterface(device, parent.id, Number(subinterface[2]));
        } else
          return unchanged(
            "% Unknown interface. Use the name from show ip interface brief.",
          );
        const result = mutate((d) => {
          const next =
            port.virtual?.kind === "svi"
              ? ensureSviVlan(d, port.virtual.vlan)
              : d;
          next.ports.push(port);
          return next;
        });
        return result.changed
          ? { ...result, session: { mode: "interface", portId: port.id } }
          : result;
      } catch (error) {
        return unchanged(
          "% " +
            (error instanceof Error
              ? error.message
              : "Could not create the interface."),
        );
      }
    }
    if (
      device.kind === "switch" &&
      ["ip routing", "no ip routing"].includes(lower)
    )
      return mutate((d) => {
        d.ipRouting = lower === "ip routing";
      });
    if (
      device.kind === "switch" &&
      /^(no )?ip default-gateway(?: \S+)?$/.test(lower)
    ) {
      if (words[0] !== "no" && words.length !== 3)
        return unchanged("% Enter a default gateway address.");
      return mutate((d) => {
        d.gateway = words[0] === "no" ? "" : words[2];
      });
    }
  }
  if (
    session.mode === "interface" &&
    session.portIds?.length &&
    !["exit", "end", "help", "?"].includes(lower)
  ) {
    // Evaluate every member against a private candidate. Control-plane effects
    // run only after all edits validate, so a bad range cannot partly apply.
    let next = topology;
    const candidate = structuredClone(runtime);
    const outputs: string[] = [];
    let changed = false,
      preserveRuntime = false;
    try {
      for (const portId of session.portIds) {
        const result = command(
          next,
          deviceId,
          { mode: "interface", portId },
          line,
          candidate,
          { deferControl: true },
        );
        if (result.output.startsWith("%")) return unchanged(result.output);
        if (result.session.mode !== "interface")
          return unchanged("% Select a single interface for this command.");
        next = result.topology;
        changed ||= result.changed;
        preserveRuntime ||= !!result.preserveRuntime;
        if (result.output && !outputs.includes(result.output))
          outputs.push(result.output);
        adoptRuntime(candidate, next);
      }
      if (!changed) return unchanged(outputs.join("\n"));
      next = commitControl(next, candidate);
      Object.assign(runtime, candidate);
      return {
        topology: next,
        session,
        output: outputs.join("\n"),
        changed: true,
        preserveRuntime,
      };
    } catch (error) {
      return unchanged(
        "% " +
          (error instanceof Error
            ? error.message
            : "Invalid interface range configuration."),
      );
    }
  }
  const channelResult = etherChannelCommand(
    topology,
    device,
    session,
    line,
    runtime,
    mutate,
    unchanged,
  );
  if (channelResult) return channelResult;
  const vlanResult = vlanCommand(
    topology,
    device,
    session,
    line,
    runtime,
    mutate,
    unchanged,
  );
  if (vlanResult) return vlanResult;
  const activePort = device.ports.find((p) => p.id === session.portId);
  if (
    session.mode === "interface" &&
    activePort?.routed &&
    /^(?:no )?(?:switchport |spanning-tree )/.test(lower)
  )
    return unchanged("% This command requires a Layer 2 switchport.");
  if (
    session.mode === "interface" &&
    activePort?.virtual &&
    activePort.virtual.kind !== "portchannel"
  ) {
    if (
      /^(?:switchport|spanning-tree|cdp |lldp |clock rate)|^no (?:switchport|spanning-tree|cdp |lldp |clock rate)/.test(
        lower,
      )
    )
      return unchanged("% This command requires a physical interface.");
    const encapsulation =
      /^(no )?encapsulation dot1q(?: (\d+)( native)?)?$/.exec(lower);
    if (encapsulation) {
      if (activePort.virtual.kind !== "subinterface")
        return unchanged("% Encapsulation requires a router subinterface.");
      if (!encapsulation[1] && !encapsulation[2])
        return unchanged("% Enter an 802.1Q VLAN ID.");
      return mutate((d) => {
        const virtual = d.ports.find((p) => p.id === activePort.id)!.virtual!;
        if (virtual.kind !== "subinterface") return;
        if (encapsulation[1]) {
          delete virtual.vlan;
          delete virtual.native;
        } else {
          virtual.vlan = Number(encapsulation[2]);
          virtual.native = !!encapsulation[3];
        }
      });
    }
    if (
      words[0] === "ip" &&
      words[1] === "address" &&
      activePort.virtual.kind === "subinterface" &&
      activePort.virtual.vlan === undefined
    )
      return unchanged(
        "% Configure encapsulation dot1Q before assigning an IP address.",
      );
  }
  const discovery = discoveryCommand(
    device,
    session,
    lower,
    runtime,
    mutate,
    unchanged,
  );
  if (discovery) return discovery;
  const secureResult = portSecurityCommand(
    device,
    session,
    line,
    runtime,
    mutate,
    unchanged,
  );
  if (secureResult) return secureResult;
  if (device.kind === "switch") {
    if (
      ["user", "privileged"].includes(session.mode) &&
      ["show mac address-table", "show mac address-table dynamic"].includes(
        lower,
      )
    )
      return unchanged(
        "VLAN MAC Address Type Interface\n" +
          ([
            ...(lower === "show mac address-table dynamic"
              ? []
              : (device.staticMac ?? [])
            ).map(
              (e) =>
                `${e.vlan} ${e.mac.match(/.{4}/g)?.join(".")} STATIC ${device.ports.find((p) => p.id === e.port)?.name}`,
            ),
            ...runtime.mac
              .filter((e) => e.device === device.id)
              .map(
                (e) =>
                  `${e.vlan} ${e.mac.match(/.{4}/g)?.join(".")} DYNAMIC ${device.ports.find((p) => p.id === e.port)?.name}`,
              ),
          ].join("\n") || "No learned MAC addresses."),
      );
    if (
      session.mode === "config" &&
      /^mac address-table static \S+ vlan \d+ interface \S+$/.test(lower)
    )
      return mutate((d) => {
        const port = d.ports.find((p) => p.name.toLowerCase() === words[7]);
        d.staticMac ??= [];
        d.staticMac.push({
          mac: words[3].replace(/[.:-]/g, ""),
          vlan: Number(words[5]),
          port: port?.id ?? "missing",
        });
      });
    if (
      session.mode === "config" &&
      /^no mac address-table static \S+ vlan \d+(?: interface \S+)?$/.test(
        lower,
      )
    )
      return mutate((d) => {
        d.staticMac = d.staticMac?.filter(
          (e) =>
            e.mac !== words[4].replace(/[.:-]/g, "") ||
            e.vlan !== Number(words[6]),
        );
      });
    if (
      session.mode === "privileged" &&
      lower === "clear mac address-table dynamic"
    ) {
      clearMac(runtime, device.id);
      return unchanged("Dynamic MAC entries cleared.");
    }
    if (
      session.mode === "config" &&
      /^mac address-table aging-time \d+$/.test(lower)
    )
      return mutate((d) => {
        d.macAgingSeconds = Number(words[3]);
      });
  }
  if (lower === "?" || lower === "help")
    return unchanged(
      (device.kind !== "switch"
        ? "Neighbor cache: show ip arp; show ipv6 neighbors; clear arp-cache; clear ipv6 neighbors.\n"
        : "") +
        (networkDevice
          ? "Discovery: show cdp neighbors [detail]; show lldp neighbors [detail]; cdp run; lldp run; interface cdp enable, lldp transmit or lldp receive.\nImplemented: enable; disable; configure terminal; hostname NAME; interface NAME; ip address IP MASK; shutdown; no shutdown; switchport mode access|trunk|dynamic auto|dynamic desirable; switchport nonegotiate; no switchport nonegotiate; show dtp interface [NAME]; switchport access vlan ID; switchport trunk allowed vlan ID[,ID]; switchport trunk native vlan ID; show interfaces trunk; ip route NETWORK MASK NEXT_HOP; no ip route NETWORK MASK NEXT_HOP; show ip interface brief; show ip route; show running-config; show vlan brief; ping IP; exit; end.\nLogical interfaces: interface PARENT.NUMBER; encapsulation dot1Q VLAN [native]; interface vlan VLAN; no interface NAME; ip routing; no ip routing; ip default-gateway ADDRESS.\nRouting: router rip; version 2; no auto-summary; network CLASSFUL_NETWORK; router ospf PROCESS; network NETWORK WILDCARD area 0; router-id IP; router eigrp AS; network NETWORK [WILDCARD]; eigrp router-id IP; passive-interface NAME; show ip protocols; show ip ospf neighbor; show ip eigrp neighbors|interfaces|topology.\nIPv4 policy: access-list NAME permit|deny ip|icmp|tcp|udp SOURCE DESTINATION [eq PORT]; addresses use any, host IP, or NETWORK WILDCARD. Interface: ip access-group NAME in|out; ip ospf cost NUMBER; bandwidth KBPS; delay TEN_MICROSECONDS; no bandwidth; no delay.\nIPv6: ipv6 unicast-routing; interface ipv6 address ADDRESS/PREFIX; ipv6 route NETWORK/PREFIX NEXT_HOP [INTERFACE]; show ipv6 interface brief; show ipv6 route; ping ipv6 ADDRESS [INTERFACE].\nThis is a bounded educational CLI, not Cisco IOS."
          : "Implemented: ipconfig; ipconfig /renew; ipconfig /release; ipconfig /displaydns; ipconfig /flushdns; ipv6config; nslookup [-type=A|AAAA] HOST [DNS_SERVER]; ping IP_OR_HOST; ping -6 IPV6_OR_HOST; help. Configure IP settings in the Config or IPv6 tab.") +
        (networkDevice
          ? "\nLifecycle (privileged): copy running-config startup-config; write memory; show startup-config; erase startup-config; reload."
          : "") +
        (device.kind === "switch"
          ? "\nEtherChannel: interface range Gi0/0 - 1; channel-group 1 mode active|passive|desirable|auto|on; channel-protocol lacp|pagp; no channel-group; interface Port-channel1; show etherchannel summary; show etherchannel [GROUP] detail; show lacp neighbor; show pagp neighbor; port-channel load-balance src-mac|dst-mac|src-dst-mac.\nVLANs: vlan ID[,ID-RANGE]; name NAME; state active|suspend (CertSim extension); no vlan ID[,ID-RANGE]; show vlan [brief|id ID]. VTP: vtp mode server|client|transparent; vtp domain NAME; vtp version 1|2; vtp password VALUE; show vtp status. Routed ports: interface → no switchport or switchport; show interfaces [NAME] switchport.\nSpanning tree: show spanning-tree [vlan ID]; configure terminal → spanning-tree vlan ID priority VALUE; interface → spanning-tree cost VALUE; no spanning-tree cost; spanning-tree portfast [trunk|disable]; spanning-tree bpduguard enable|disable. Global: spanning-tree portfast default; spanning-tree portfast bpduguard default. Inspect: show spanning-tree summary; show spanning-tree interface NAME detail; show interfaces status err-disabled. BPDU Guard disable override and automatic recovery are CertSim extensions beyond the observed Packet Tracer 9 behavior.\nPort security: interface switchport port-security; maximum NUMBER; violation protect|restrict|shutdown; mac-address [sticky] MAC [vlan ID|access|voice]; mac-address sticky; maximum NUMBER vlan ID|access|voice; switchport voice vlan ID; aging time MINUTES; aging type absolute|inactivity (each suffix follows switchport port-security); show port-security [interface NAME]; show errdisable recovery; errdisable recovery cause psecure-violation|bpduguard; errdisable recovery interval SECONDS.\nMAC: show mac address-table; clear mac address-table dynamic (privileged); mac address-table aging-time SECONDS (config)."
          : device.kind === "router"
            ? "\nDHCP relay: interface ip helper-address SERVER_IP; no ip helper-address SERVER_IP.\nSerial: show controllers INTERFACE; interface clock rate BPS; no clock rate.\nNAT: ip nat pool NAME START END netmask MASK; ip nat inside source list ACL pool NAME [overload]; CertSim extension: ip nat hairpin enable; interface ip nat inside|outside; ip nat inside source static LOCAL GLOBAL; ip nat inside source list ACL interface NAME overload; show ip nat translations; show ip nat statistics; clear ip nat translation * (privileged). Standard source ACLs: access-list NAME permit|deny IP WILDCARD or any."
            : ""),
    );
  const nat = natCommand(
    topology,
    device,
    session,
    line,
    runtime,
    mutate,
    unchanged,
  );
  if (nat) return nat;
  const spanning = spanningTreeCommand(
    topology,
    device,
    session,
    line,
    mutate,
    unchanged,
    runtime,
  );
  if (spanning) return spanning;
  const advanced = advancedCommand(
    topology,
    device,
    session,
    line,
    mutate,
    unchanged,
    runtime,
  );
  if (advanced) return advanced;
  if (words[0] === "ping" && words.length === 2) {
    if (networkDevice && !["user", "privileged"].includes(session.mode))
      return unchanged("% Exit configuration mode before ping.");
    let address = words[1];
    if (ipv4(address) === null) {
      const resolved = resolveHostname(
        topology,
        device.id,
        address,
        "A",
        runtime,
      );
      if (!resolved.ok || !resolved.address) return unchanged(resolved.message);
      address = resolved.address;
    }
    const result = ping(topology, device.id, address, runtime);
    return unchanged(`${result.ok ? "Success" : "Failed"}: ${result.message}`);
  }
  if (lower === "ipconfig" && !networkDevice)
    return unchanged(
      device.ports
        .map(
          (p) =>
            `${p.name}: ${p.enabled ? "enabled" : "disabled"}\nIPv4: ${p.ip || "unassigned"} /${p.prefix}\nGateway: ${device.gateway || "none"}\nDNS: ${device.dns || "none"}`,
        )
        .join("\n\n"),
    );
  if (!networkDevice)
    return unchanged("% Unsupported host command. Enter help.");
  if (lower === "enable" && session.mode === "user")
    return unchanged("", { mode: "privileged", portId: null });
  if (lower === "disable" && session.mode === "privileged")
    return unchanged("", INITIAL_CLI);
  if (
    lower === "end" &&
    ["config", "interface", "routing", "vlan"].includes(session.mode)
  )
    return unchanged("", { mode: "privileged", portId: null });
  if (lower === "exit")
    return unchanged("", {
      mode: ["interface", "routing", "vlan"].includes(session.mode)
        ? "config"
        : session.mode === "config"
          ? "privileged"
          : "user",
      portId: null,
    });
  if (lower === "configure terminal" && session.mode === "privileged")
    return unchanged("Enter configuration commands, one per line.", {
      mode: "config",
      portId: null,
    });
  if (
    lower.startsWith("show ") &&
    ["user", "privileged"].includes(session.mode)
  ) {
    if (
      device.kind === "router" &&
      words[1] === "controllers" &&
      words.length === 3
    ) {
      const p = device.ports.find(
        (p) => p.media === "serial" && p.name.toLowerCase() === words[2],
      );
      if (!p) return unchanged("% Select an existing serial interface.");
      const role = serialRole(topology, device.id, p.id);
      const link = topology.links.find((l) =>
        [l.a, l.b].some((e) => e.device === device.id && e.port === p.id),
      );
      const rate = link && getPort(topology, link[link.dce ?? "a"])?.clockRate;
      return unchanged(
        [
          p.name + " · " + (role ?? "Unconnected"),
          "Line clock " + (rate ? rate + " bps" : "absent"),
          link
            ? linkStatus(topology, link, runtime).reason
            : "No serial cable.",
        ].join("\n"),
      );
    }
    if (lower === "show ip interface brief")
      return unchanged(
        "Interface                 IPv4             Status                 Protocol\n" +
          device.ports
            .map((p) => {
              const operational = portOperational(
                topology,
                device.id,
                p.id,
                runtime,
              );
              const status = !p.enabled
                ? "administratively down"
                : bpduGuardDown(runtime, device.id, p.id)
                  ? "err-disabled"
                  : operational
                    ? "up"
                    : "down";
              return (
                p.name.padEnd(26) +
                (p.ip || "unassigned").padEnd(17) +
                status.padEnd(23) +
                (operational ? "up" : "down")
              );
            })
            .join("\n"),
      );
    if (device.kind === "switch" && lower === "show interfaces trunk") {
      const trunks = bridgePorts(topology, device, runtime).filter(
        (p) =>
          isSwitchport(device, p) &&
          switchportState(topology, device.id, p.id, runtime).operational ===
            "trunk",
      );
      return unchanged(
        trunks.length
          ? [
              "Port  Mode  Status  Native VLAN  Allowed VLANs",
              ...trunks.map(
                (p) =>
                  p.name +
                  "  " +
                  p.mode.replace("dynamic-", "dynamic ") +
                  "  trunking  " +
                  (p.nativeVlan ?? "all tagged") +
                  "  " +
                  p.allowedVlans.join(","),
              ),
            ].join("\n")
          : "No operational trunks.",
      );
    }
    if (lower === "show running-config")
      return unchanged(
        [
          "hostname " + device.name,
          ...vlanRunningConfig(device),
          ...(device.etherChannelLoadBalance
            ? ["port-channel load-balance " + device.etherChannelLoadBalance]
            : []),
          ...spanningTreeRunningConfig(device),
          ...(device.kind === "switch"
            ? [device.ipRouting ? "ip routing" : "no ip routing"]
            : []),
          ...(device.kind === "switch" && device.gateway
            ? ["ip default-gateway " + device.gateway]
            : []),
          ...(device.cdp === undefined
            ? []
            : [device.cdp ? "cdp run" : "no cdp run"]),
          ...(device.lldp === undefined
            ? []
            : [device.lldp ? "lldp run" : "no lldp run"]),
          ...(device.securityRecovery
            ? [
                ...(device.securityRecovery.enabled
                  ? ["errdisable recovery cause psecure-violation"]
                  : []),
                "errdisable recovery interval " +
                  device.securityRecovery.interval,
              ]
            : []),
          ...device.ports.flatMap((p) => [
            "interface " + p.name,
            ...(p.channelProtocol
              ? [" channel-protocol " + p.channelProtocol]
              : []),
            ...(p.channelGroup
              ? [
                  ` channel-group ${p.channelGroup.id} mode ${p.channelGroup.mode}`,
                ]
              : []),
            ...spanningTreePortConfig(device, p.id),
            ...(p.routed ? [" no switchport"] : []),
            ...(p.virtual?.kind === "subinterface" &&
            p.virtual.vlan !== undefined
              ? [
                  " encapsulation dot1Q " +
                    p.virtual.vlan +
                    (p.virtual.native ? " native" : ""),
                ]
              : []),
            ...(p.clockRate ? [` clock rate ${p.clockRate}`] : []),
            ...(p.bandwidth === undefined ? [] : [` bandwidth ${p.bandwidth}`]),
            ...(p.delay === undefined ? [] : [` delay ${p.delay}`]),
            ...(p.cdp === undefined
              ? []
              : [p.cdp ? " cdp enable" : " no cdp enable"]),
            ...(p.lldpTransmit === undefined
              ? []
              : [p.lldpTransmit ? " lldp transmit" : " no lldp transmit"]),
            ...(p.lldpReceive === undefined
              ? []
              : [p.lldpReceive ? " lldp receive" : " no lldp receive"]),
            ...(p.ip
              ? [` ip address ${p.ip} ${ipString(mask(p.prefix))}`]
              : []),
            p.enabled ? " no shutdown" : " shutdown",
            ...(p.security
              ? [
                  " switchport port-security",
                  ` switchport port-security maximum ${p.security.maximum}`,
                  ` switchport port-security aging time ${p.security.agingMinutes ?? 0}`,
                  ...(p.security.ageStatic
                    ? [" switchport port-security aging static"]
                    : []),
                  ` switchport port-security aging type ${p.security.agingType ?? "absolute"}`,
                  ` switchport port-security violation ${p.security.violation}`,
                  ...p.security.addresses.map(
                    (a) => ` switchport port-security mac-address ${a}`,
                  ),
                ]
              : []),
            ...(isSwitchport(device, p) && p.nativeVlan !== undefined
              ? [" switchport trunk native vlan " + p.nativeVlan]
              : []),
            ...(p.voiceVlan ? [` switchport voice vlan ${p.voiceVlan}`] : []),
            ...(p.security?.sticky
              ? [" switchport port-security mac-address sticky"]
              : []),
            ...(p.security?.bindings?.map(
              (b) =>
                ` switchport port-security mac-address ${b.sticky ? "sticky " : ""}${b.mac} vlan ${b.vlan}`,
            ) ?? []),
            ...(p.security?.vlanMaximums?.map(
              (b) =>
                ` switchport port-security maximum ${b.maximum} vlan ${b.vlan}`,
            ) ?? []),
            ...(p.helperAddresses ?? []).map(
              (address) => ` ip helper-address ${address}`,
            ),
            ...(p.natRole ? [` ip nat ${p.natRole}`] : []),
            ...(p.spanningTreeCost !== undefined
              ? [` spanning-tree cost ${p.spanningTreeCost}`]
              : []),
            ...(p.ipv6 ? [` ipv6 address ${p.ipv6}/${p.prefix6 ?? 64}`] : []),
            ...(p.inboundAcl ? [` ip access-group ${p.inboundAcl} in`] : []),
            ...(p.outboundAcl ? [` ip access-group ${p.outboundAcl} out`] : []),
            ...(isSwitchport(device, p)
              ? [
                  ` switchport mode ${p.mode.replace("dynamic-", "dynamic ")}`,
                  ` switchport access vlan ${p.vlan}`,
                  ` switchport trunk allowed vlan ${p.allowedVlans.join(",")}`,
                  ...(p.nonegotiate ? [" switchport nonegotiate"] : []),
                ]
              : []),
          ]),
          ...device.routes.map(
            (r) =>
              `ip route ${r.network} ${ipString(mask(r.prefix))} ${r.nextHop}`,
          ),
          ...advancedRunningConfig(device),
          "end",
        ].join("\n"),
      );
    if (lower === "show ip route" && networkDevice)
      return unchanged(
        [
          ...(device.kind === "switch" && !ipv4Forwarding(device)
            ? ["IP routing is disabled."]
            : []),
          "Codes: C - connected, S - static (configured; next-hop reachability checked during forwarding), R - RIP, O - OSPF, D - EIGRP",
          ...device.ports
            .filter(
              (p) =>
                p.ip &&
                isRoutedInterface(device, p) &&
                portOperational(topology, device.id, p.id, runtime),
            )
            .map(
              (p) =>
                `C ${ipString((ipv4(p.ip)! & mask(p.prefix)) >>> 0)}/${p.prefix} directly connected, ${p.name}`,
            ),
          ...device.routes.map(
            (r) => `S ${r.network}/${r.prefix} via ${r.nextHop}`,
          ),
          ...learnedRoutes(topology, device.id, runtime).map(
            (r) =>
              `${r.protocol === "rip" ? "R" : r.protocol === "eigrp" ? "D" : "O"} ${r.network}/${r.prefix} [${r.distance}/${r.metric}] via ${r.nextHop}`,
          ),
        ].join("\n"),
      );
  }
  if (session.mode === "config") {
    if (words[0] === "hostname" && words.length === 2)
      return mutate((d) => {
        d.name = line.split(/\s+/)[1];
      });
    const remove = words[0] === "no";
    const routeWords = remove ? words.slice(1) : words;
    if (
      routeWords[0] === "ip" &&
      routeWords[1] === "route" &&
      routeWords.length === 5 &&
      networkDevice
    ) {
      const prefix = prefixFromMask(routeWords[3]);
      if (prefix === null) return unchanged("% Invalid subnet mask.");
      const route = { network: routeWords[2], prefix, nextHop: routeWords[4] };
      if (!remove && device.routes.length >= 128)
        return unchanged("% Static route limit reached.");
      return mutate((d) => {
        d.routes = d.routes.filter(
          (r) =>
            !(
              r.network === route.network &&
              r.prefix === route.prefix &&
              r.nextHop === route.nextHop
            ),
        );
        if (!remove) d.routes.push(route);
      });
    }
  }
  if (session.mode === "interface") {
    const portId = session.portId;
    if (!device.ports.some((p) => p.id === portId))
      return unchanged("% Interface no longer exists.");
    if (lower === "no clock rate" || /^clock rate \d+$/.test(lower)) {
      if (device.ports.find((p) => p.id === portId)?.media !== "serial")
        return unchanged("% Clock rate requires a serial interface.");
      return mutate((d) => {
        const p = d.ports.find((p) => p.id === portId)!;
        if (lower === "no clock rate") delete p.clockRate;
        else p.clockRate = Number(words[2]);
      });
    }
    if (lower === "shutdown" || lower === "no shutdown")
      return mutate((d) => {
        d.ports.find((p) => p.id === portId)!.enabled = lower === "no shutdown";
      });
    if (
      !!activePort &&
      isRoutedInterface(device, activePort) &&
      /^(?:no )?ip helper-address \S+$/.test(lower)
    ) {
      const address = words[words.length - 1];
      if (!usableIp(address, 32))
        return unchanged("% Enter a unicast helper IPv4 address.");
      const helpers =
        device.ports.find((p) => p.id === portId)!.helperAddresses ?? [];
      const remove = words[0] === "no";
      const updated = remove
        ? helpers.filter((a) => a !== address)
        : [...new Set([...helpers, address])];
      if (updated.length === helpers.length) return unchanged("");
      return mutate((d) => {
        const p = d.ports.find((p) => p.id === portId)!;
        if (updated.length) p.helperAddresses = updated;
        else delete p.helperAddresses;
      });
    }
    if (
      lower === "no ip address" &&
      activePort &&
      isRoutedInterface(device, activePort)
    )
      return mutate((d) => {
        d.ports.find((p) => p.id === portId)!.ip = "";
      });
    if (
      words[0] === "ip" &&
      words[1] === "address" &&
      words.length === 4 &&
      !!activePort &&
      isRoutedInterface(device, activePort)
    ) {
      const prefix = prefixFromMask(words[3]);
      if (prefix === null || prefix === 0)
        return unchanged("% Invalid subnet mask.");
      return mutate((d) => {
        const p = d.ports.find((p) => p.id === portId)!;
        p.ip = words[2];
        p.prefix = prefix;
      });
    }
    const secureResult = portSecurityCommand(
      device,
      session,
      line,
      runtime,
      mutate,
      unchanged,
    );
    if (secureResult) return secureResult;
    if (activePort && isSwitchport(device, activePort)) {
      if (
        /^switchport mode (access|trunk|dynamic (auto|desirable))$/.test(
          lower,
        ) ||
        /^no switchport mode(?: (?:access|trunk|dynamic(?: auto| desirable)?))?$/.test(
          lower,
        )
      )
        return mutate((d) => {
          d.ports.find((p) => p.id === portId)!.mode =
            words[0] === "no"
              ? "dynamic-auto"
              : words[2] === "dynamic"
                ? words[3] === "auto"
                  ? "dynamic-auto"
                  : "dynamic-desirable"
                : (words[2] as "access" | "trunk");
        });
      if (
        lower === "switchport nonegotiate" ||
        lower === "no switchport nonegotiate"
      )
        return mutate((d) => {
          const port = d.ports.find((p) => p.id === portId)!;
          if (words[0] === "no") delete port.nonegotiate;
          else port.nonegotiate = true;
        });
      if (
        /^switchport trunk native vlan \d+$/.test(lower) ||
        lower === "no switchport trunk native vlan"
      )
        return mutate((d) => {
          d.ports.find((p) => p.id === portId)!.nativeVlan =
            words[0] === "no" ? 1 : Number(words[4]);
        });
      if (/^switchport access vlan \d+$/.test(lower))
        return mutate((d) => {
          const next = ensureAccessVlan(d, Number(words[3]));
          next.ports.find((p) => p.id === portId)!.vlan = Number(words[3]);
          return next;
        });
      if (/^switchport trunk allowed vlan \d+(,\d+)*$/.test(lower)) {
        const vlans = words[4].split(",").map(Number);
        if (vlans.length > 128) return unchanged("% VLAN list limit reached.");
        return mutate((d) => {
          d.ports.find((p) => p.id === portId)!.allowedVlans = [
            ...new Set(vlans),
          ];
        });
      }
    }
  }
  return unchanged(
    "% Unsupported command or wrong command mode. Enter help for implemented commands.",
  );
}
