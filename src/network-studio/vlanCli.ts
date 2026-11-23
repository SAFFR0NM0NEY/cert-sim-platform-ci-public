import type { CliSession, Device, Topology } from "./types.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
import { switchportState } from "./dtp.ts";
import type { CommandResult } from "./cli.ts";
import { isSwitchport } from "./vlanInterfaces.ts";
import {
  deleteVlan,
  setSwitchport,
  setVlan,
  setVtp,
  vlanDatabase,
} from "./vlans.ts";

export function vlanList(value: string): number[] {
  const ids = new Set<number>();
  for (const item of value.split(",")) {
    if (!/^\d+(?:-\d+)?$/.test(item))
      throw Error("Enter VLAN IDs or ranges, such as 10,20-22.");
    const [start, end = start] = item.split("-").map(Number);
    if (start < 1 || end > 4094 || end < start)
      throw Error("VLAN IDs must be between 1 and 4094.");
    for (let id = start; id <= end; id++) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}

export function vlanRunningConfig(d: Device): string[] {
  if (d.kind !== "switch") return [];
  const v = d.vtp;
  return [
    ...(v
      ? [
          "vtp mode " + v.mode,
          ...(v.domain ? ["vtp domain " + v.domain] : []),
          "vtp version " + v.version,
          ...(v.password ? ["vtp password " + v.password] : []),
        ]
      : []),
    ...(d.vlans ?? [])
      .filter((v) => ![1, 1002, 1003, 1004, 1005].includes(v.id))
      .flatMap((v) => [
        "vlan " + v.id,
        " name " + v.name,
        ...(v.state === "suspended" ? [" state suspend"] : []),
      ]),
  ];
}

export function vlanCommand(
  t: Topology,
  d: Device,
  s: CliSession,
  line: string,
  runtime: NetworkRuntime,
  mutate: (edit: (d: Device) => Device | void) => CommandResult,
  unchanged: (message: string, session?: CliSession) => CommandResult,
): CommandResult | null {
  if (d.kind !== "switch") return null;
  const lower = line.toLowerCase();
  const exec = ["user", "privileged"].includes(s.mode);
  const config = ["config", "interface", "routing", "vlan"].includes(s.mode);
  const vtp = d.vtp ?? { mode: "server", domain: "", version: 1, revision: 0 };
  const vlans = vlanDatabase(d);
  if (exec && /^show vlan(?: brief| id \d+)?$/.test(lower)) {
    const id = / id (\d+)$/.exec(lower)?.[1];
    const rows = id ? vlans.filter((v) => v.id === Number(id)) : vlans;
    if (!rows.length) return unchanged("% VLAN does not exist.");
    return unchanged(
      "VLAN  Name                              Status      Access/voice ports\n" +
        rows
          .map(
            (v) =>
              String(v.id).padEnd(6) +
              v.name.padEnd(34) +
              v.state.padEnd(12) +
              d.ports
                .filter(
                  (p) =>
                    isSwitchport(d, p) &&
                    ((switchportState(t, d.id, p.id, runtime).mode ===
                      "access" &&
                      p.vlan === v.id) ||
                      p.voiceVlan === v.id),
                )
                .map((p) => p.name)
                .join(", "),
          )
          .join("\n"),
    );
  }
  if (exec && lower === "show vtp status")
    return unchanged(
      [
        "VTP Version: " + vtp.version,
        "VTP Operating Mode: " + vtp.mode,
        "VTP Domain Name: " + (vtp.domain || "(not configured)"),
        "Configuration Revision: " + vtp.revision,
        "Number of existing VLANs: " + vlans.length,
        "Password configured: " +
          ("password" in vtp && vtp.password ? "yes" : "no"),
        "VTP pruning: not modeled.",
        "Deterministic updates on committed changes and simulation-clock actions.",
      ].join("\n"),
    );
  if (exec && lower === "show vtp password")
    return unchanged(
      "password" in vtp && vtp.password
        ? String(vtp.password)
        : "No VTP password configured.",
    );
  const dtpShow = /^show dtp interface(?: (\S+))?$/.exec(lower);
  if (
    exec &&
    (dtpShow || /^show interfaces?(?: \S+)? switchport$/.test(lower))
  ) {
    const name = dtpShow
      ? dtpShow[1]
      : lower.split(/\s+/).length === 4
        ? lower.split(/\s+/)[2]
        : undefined;
    const ports = d.ports.filter(
      (p) =>
        (!p.virtual || p.virtual.kind === "portchannel") &&
        (!name ||
          p.name.toLowerCase() ===
            name.replace(
              /^(po|gi|fa|eth)(?=\d)/,
              (prefix) =>
                ({
                  po: "port-channel",
                  gi: "gigabitethernet",
                  fa: "fastethernet",
                  eth: "ethernet",
                })[prefix]!,
            )),
    );
    if (!ports.length) return unchanged("% Unknown switching interface.");
    return unchanged(
      ports
        .map((p) => {
          const state = switchportState(t, d.id, p.id, runtime);
          const peer =
            state.peer &&
            t.devices.find((device) => device.id === state.peer!.device);
          const peerPort = peer?.ports.find(
            (port) => port.id === state.peer!.port,
          );
          return [
            "Name: " + p.name,
            "Switchport: " + (p.routed ? "Disabled" : "Enabled"),
            ...(p.routed
              ? []
              : [
                  "Administrative Mode: " +
                    p.mode.replace("dynamic-", "dynamic "),
                  "Operational Mode: " + state.operational,
                  "Negotiation of Trunking: " + (p.nonegotiate ? "Off" : "On"),
                  "DTP: " + state.reason,
                  ...(dtpShow
                    ? [
                        "VTP Domain: " + (d.vtp?.domain || "(not configured)"),
                        "Neighbor: " +
                          (peer && peerPort
                            ? peer.name + " / " + peerPort.name
                            : "none"),
                        "Deterministic negotiation; DTP frame counters and timers are not modeled.",
                      ]
                    : []),
                  "Access Mode VLAN: " +
                    p.vlan +
                    " (" +
                    (vlans.find((v) => v.id === p.vlan)?.name ?? "inactive") +
                    ")",
                  "Voice VLAN: " + (p.voiceVlan ?? "none"),
                  "Trunking Native VLAN: " + (p.nativeVlan ?? "all tagged"),
                  "Trunking VLANs Enabled: " + p.allowedVlans.join(","),
                ]),
          ].join("\n");
        })
        .join("\n\n"),
    );
  }
  if (config) {
    const mode = /^vtp mode (server|client|transparent)$/.exec(lower);
    if (mode)
      return mutate((device) =>
        setVtp(device, {
          mode: mode[1] as "server" | "client" | "transparent",
        }),
      );
    const version = /^vtp version ([12])$/.exec(lower);
    if (version)
      return mutate((device) =>
        setVtp(device, { version: Number(version[1]) as 1 | 2 }),
      );
    const domain = /^vtp domain (\S+)$/i.exec(line);
    if (domain)
      return mutate((device) => setVtp(device, { domain: domain[1] }));
    const password = /^vtp password (.+)$/i.exec(line);
    if (password)
      return mutate((device) => setVtp(device, { password: password[1] }));
    if (lower === "no vtp password")
      return mutate((device) => setVtp(device, { password: "" }));
    if (lower.startsWith("vtp ") || lower.startsWith("no vtp "))
      return unchanged(
        "% Use vtp mode server|client|transparent, domain NAME, version 1|2, or password VALUE.",
      );
    const select = /^(no )?vlan ([\d,-]+)$/.exec(lower);
    if (select) {
      let ids: number[];
      try {
        ids = vlanList(select[2]);
      } catch (error) {
        return unchanged(
          "% " +
            (error instanceof Error ? error.message : "Invalid VLAN list."),
        );
      }
      const result = mutate((device) =>
        ids.reduce(
          (next, id) =>
            select[1] ? deleteVlan(next, id) : setVlan(next, id, {}),
          device,
        ),
      );
      return result.changed
        ? {
            ...result,
            session: select[1]
              ? { mode: "config", portId: null }
              : { mode: "vlan", portId: null, vlanIds: ids },
          }
        : result;
    }
  }
  if (s.mode === "vlan") {
    const ids = s.vlanIds ?? [];
    if (!ids.length) return unchanged("% Select a VLAN first.");
    const name = /^name (.+)$/i.exec(line);
    if (name)
      return mutate((device) =>
        ids.reduce((next, id) => setVlan(next, id, { name: name[1] }), device),
      );
    if (lower === "no name")
      return mutate((device) =>
        ids.reduce(
          (next, id) =>
            setVlan(next, id, { name: "VLAN" + String(id).padStart(4, "0") }),
          device,
        ),
      );
    if (["state active", "state suspend", "no state"].includes(lower))
      return mutate((device) =>
        ids.reduce(
          (next, id) =>
            setVlan(next, id, {
              state: lower === "state suspend" ? "suspended" : "active",
            }),
          device,
        ),
      );
  }
  if (
    s.mode === "interface" &&
    ["switchport", "no switchport"].includes(lower)
  ) {
    if (!s.portId) return unchanged("% Select a physical switch interface.");
    return mutate((device) =>
      setSwitchport(device, s.portId!, lower === "switchport"),
    );
  }
  return null;
}
