import type { CliSession, Device, Topology } from "./types.ts";
import type { CommandResult } from "./cli.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
import { interfaceMetric } from "./routing.ts";
import {
  channelState,
  setChannelGroup,
  removeChannelGroup,
} from "./etherChannel.ts";

function fullName(value: string): string {
  return value.toLowerCase().replace(
    /^(gi|fa|eth|po)(?=\d)/,
    (prefix) =>
      ({
        gi: "gigabitethernet",
        fa: "fastethernet",
        eth: "ethernet",
        po: "port-channel",
      })[prefix]!,
  );
}

export function interfaceRange(d: Device, value: string): string[] {
  const ids = new Set<string>();
  for (const item of value.split(",")) {
    const match =
      /^\s*([a-z]+\d+(?:\/\d+)+)\s*(?:-\s*(\d+|[a-z]+\d+(?:\/\d+)+))?\s*$/i.exec(
        item,
      );
    if (!match)
      throw Error("Use physical interface ranges such as Gi0/0 - 1, Gi0/3.");
    const first = fullName(match[1]);
    const prefix = first.slice(0, first.lastIndexOf("/") + 1);
    const start = Number(first.slice(prefix.length));
    const last = match[2] ? fullName(match[2]) : String(start);
    if (
      last.includes("/") &&
      last.slice(0, last.lastIndexOf("/") + 1) !== prefix
    )
      throw Error("Each interface range must use one interface prefix.");
    const end = Number(last.slice(last.lastIndexOf("/") + 1));
    if (end < start || end - start >= 32)
      throw Error("Use an ascending range of at most 32 physical interfaces.");
    for (let index = start; index <= end; index++) {
      const p = d.ports.find(
        (p) => !p.virtual && p.name.toLowerCase() === prefix + index,
      );
      if (!p)
        throw Error("Unknown physical interface: " + prefix + index + ".");
      ids.add(p.id);
    }
  }
  if (!ids.size || ids.size > 32)
    throw Error("Select between 1 and 32 physical interfaces.");
  return [...ids];
}

export function etherChannelCommand(
  t: Topology,
  d: Device,
  s: CliSession,
  line: string,
  runtime: NetworkRuntime,
  mutate: (edit: (device: Device) => Device | void) => CommandResult,
  unchanged: (text: string) => CommandResult,
): CommandResult | null {
  if (d.kind !== "switch") return null;
  const lower = line.toLowerCase().trim().replace(/\s+/g, " ");
  const exec = ["user", "privileged"].includes(s.mode);
  const config = ["config", "interface", "vlan", "routing"].includes(s.mode);
  const aggregates = d.ports.filter((p) => p.virtual?.kind === "portchannel");
  const states = () =>
    aggregates.map((p) =>
      channelState(
        t,
        d.id,
        p.virtual!.kind === "portchannel" ? p.virtual!.group : 0,
        runtime,
      ),
    );
  const hash = d.etherChannelLoadBalance ?? "src-mac";
  if (exec && lower === "show etherchannel load-balance")
    return unchanged(
      "EtherChannel load balancing: " +
        hash +
        "\nDeterministic MAC hash; one active member per flow. Hardware-specific hash algorithms are not modeled.",
    );
  if (exec && lower === "show etherchannel summary") {
    const rows = states().map((state) => {
      const flags = (state.port.routed ? "R" : "S") + (state.up ? "U" : "D");
      const members = state.members
        .map(
          (m) =>
            `${d.ports.find((p) => p.id === m.port)?.name}(${{ bundled: "P", individual: "I", suspended: "s", down: "D" }[m.status]})`,
        )
        .join(" ");
      const group =
        state.port.virtual?.kind === "portchannel"
          ? state.port.virtual.group
          : "?";
      return `${group}  Po${group}(${flags})  ${state.protocol === "on" ? "-" : (state.protocol?.toUpperCase() ?? "-")}  ${members || "No members"}`;
    });
    return unchanged(
      "Flags: D down, P bundled, I individual, s suspended, S Layer2, R Layer3, U in use\nGroup  Port-channel  Protocol  Ports\n" +
        (rows.join("\n") || "No EtherChannels configured."),
    );
  }
  const detail = /^show etherchannel(?: (\d+))?(?: detail| port-channel)$/.exec(
    lower,
  );
  const showInterface = /^show interfaces? (?:po|port-channel)\s*(\d+)$/.exec(
    lower,
  );
  if (exec && (detail || showInterface)) {
    const group = Number(detail?.[1] ?? showInterface?.[1]);
    if (!Number.isNaN(group) && (group < 1 || group > 6))
      return unchanged("% Port-channel IDs must be between 1 and 6.");
    const selected = states().filter(
      (state) =>
        !group ||
        (state.port.virtual?.kind === "portchannel" &&
          state.port.virtual.group === group),
    );
    if (!selected.length)
      return unchanged("% No matching Port-channel interface.");
    return unchanged(
      selected
        .map((state) =>
          [
            `${state.port.name} is ${state.up ? "up" : "down"}, ${state.port.routed ? "Layer 3" : "Layer 2"}`,
            ...(state.port.routed
              ? [
                  `BW ${interfaceMetric(t, d, state.port, runtime).bandwidth} Kbit/s, DLY ${interfaceMetric(t, d, state.port, runtime).delay * 10} usec`,
                ]
              : []),
            "Protocol: " +
              (state.protocol === "on"
                ? "static"
                : (state.protocol?.toUpperCase() ?? "unconfigured")),
            "Load balancing: " + hash,
            "Active members: " +
              state.members.filter((m) => m.status === "bundled").length,
            ...state.members.map((m) => {
              const p = d.ports.find((p) => p.id === m.port)!;
              const peer = t.devices.find((peer) => peer.id === m.peer?.device);
              return `${p.name}  ${p.channelGroup?.mode}  ${m.status}  ${m.reason}${peer ? "  peer " + peer.name + "/" + peer.ports.find((port) => port.id === m.peer?.port)?.name : ""}`;
            }),
          ].join("\n"),
        )
        .join("\n\n"),
    );
  }
  const neighbors = /^show (lacp|pagp) neighbors?$/.exec(lower);
  if (exec && neighbors) {
    const rows = states()
      .filter((state) => state.protocol === neighbors[1])
      .flatMap((state) =>
        state.members
          .filter((m) => m.status === "bundled" && m.peer)
          .map((m) => {
            const peer = t.devices.find((peer) => peer.id === m.peer!.device)!;
            const remote = peer.ports.find((p) => p.id === m.peer!.port)!;
            return `${d.ports.find((p) => p.id === m.port)?.name}  ${peer.name}  ${remote.name}  ${remote.channelGroup?.mode}  ${remote.channelGroup?.id}`;
          }),
      );
    return unchanged(
      "Local interface  Partner  Partner interface  Mode  Partner group\n" +
        (rows.join("\n") || "No negotiated neighbors."),
    );
  }
  if (config && /^(?:no )?port-channel load-balance(?: \S+)?$/.test(lower)) {
    if (lower === "no port-channel load-balance")
      return mutate((device) => {
        delete device.etherChannelLoadBalance;
      });
    const algorithm = lower.split(" ")[2];
    if (
      !["src-mac", "dst-mac", "src-dst-mac"].includes(algorithm) ||
      lower.startsWith("no ")
    )
      return unchanged(
        "% Supported algorithms: src-mac, dst-mac, src-dst-mac.",
      );
    return mutate((device) => {
      device.etherChannelLoadBalance = algorithm as NonNullable<
        Device["etherChannelLoadBalance"]
      >;
    });
  }
  if (s.mode !== "interface") return null;
  const membership =
    /^(?:channel-group (\d+) mode (on|active|passive|desirable|auto)|no channel-group(?: (\d+))?)$/.exec(
      lower,
    );
  const protocol = /^(no )?channel-protocol(?: (lacp|pagp))?$/.exec(lower);
  if (!membership && !protocol) return null;
  const p = d.ports.find((p) => p.id === s.portId);
  if (!p || p.virtual || !["copper", "fiber"].includes(p.media))
    return unchanged(
      "% EtherChannel membership requires a physical Ethernet interface.",
    );
  if (protocol) {
    if (!protocol[1] && !protocol[2])
      return unchanged("% Select lacp or pagp.");
    return mutate((device) => {
      const port = device.ports.find((port) => port.id === p.id)!;
      if (protocol[1]) delete port.channelProtocol;
      else port.channelProtocol = protocol[2] as "lacp" | "pagp";
    });
  }
  if (lower.startsWith("no ")) {
    if (membership![3] && p.channelGroup?.id !== Number(membership![3]))
      return unchanged("% Interface is not a member of that channel group.");
    return mutate((device) => removeChannelGroup(device, [p.id]));
  }
  return mutate((device) =>
    setChannelGroup(
      device,
      [p.id],
      Number(membership![1]),
      membership![2] as "on" | "active" | "passive" | "desirable" | "auto",
    ),
  );
}
