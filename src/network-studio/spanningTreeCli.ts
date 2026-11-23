import type { CliSession, Device, Topology } from "./types.ts";
import type { CommandResult } from "./cli.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
import { spanningTree, bridgeMac, stpPriority } from "./spanningTree.ts";
import { isSwitchport } from "./vlanInterfaces.ts";
import { portOperational } from "./ethernet.ts";
import { securityDown } from "./portSecurity.ts";
import {
  configuredPortFast,
  operationalPortFast,
  effectiveBpduGuard,
  bpduGuardDown,
  bpduGuardDeadline,
} from "./bpduGuard.ts";

export function spanningTreeRunningConfig(d: Device): string[] {
  if (d.kind !== "switch") return [];
  return [
    ...(d.spanningTree?.portFastDefault
      ? ["spanning-tree portfast default"]
      : []),
    ...(d.spanningTree?.bpduGuardDefault
      ? ["spanning-tree portfast bpduguard default"]
      : []),
    ...(d.bpduGuardRecovery ? ["errdisable recovery cause bpduguard"] : []),
  ];
}
export function spanningTreePortConfig(d: Device, id: string): string[] {
  const p = d.ports.find((p) => p.id === id);
  if (!p || !isSwitchport(d, p)) return [];
  return [
    ...(p.portFast && p.portFast !== "default"
      ? [
          " spanning-tree portfast" +
            (p.portFast === "enable" ? "" : " " + p.portFast),
        ]
      : []),
    ...(p.bpduGuard && p.bpduGuard !== "default"
      ? [" spanning-tree bpduguard " + p.bpduGuard]
      : []),
  ];
}
export function spanningTreeCommand(
  t: Topology,
  d: Device,
  s: CliSession,
  line: string,
  mutate: (edit: (d: Device) => void) => CommandResult,
  unchanged: (text: string) => CommandResult,
  runtime: NetworkRuntime,
): CommandResult | null {
  if (d.kind !== "switch") return null;
  const w = line.toLowerCase().trim().split(/\s+/),
    lower = w.join(" ");
  const exec = ["user", "privileged"].includes(s.mode);
  if (exec && lower === "show spanning-tree summary")
    return unchanged(
      [
        "Spanning tree: per-VLAN immediate convergence",
        "PortFast Default: " +
          (d.spanningTree?.portFastDefault ? "Enabled" : "Disabled"),
        "PortFast BPDU Guard Default: " +
          (d.spanningTree?.bpduGuardDefault ? "Enabled" : "Disabled"),
        "BPDU Guard err-disabled ports: " +
          d.ports.filter((p) => bpduGuardDown(runtime, d.id, p.id)).length,
        "Direct-switch BPDU reception is modeled at configuration, packet and clock boundaries.",
        "Listening/learning timers and BPDU byte-level simulation are not modeled.",
      ].join("\n"),
    );
  if (exec && /^show interfaces? status err-disabled$/.test(lower)) {
    const rows = d.ports
      .filter((p) => isSwitchport(d, p))
      .flatMap((p) => {
        const reasons = [
          ...(bpduGuardDown(runtime, d.id, p.id) ? ["bpduguard"] : []),
          ...(securityDown(runtime, d.id, p.id) ? ["psecure-violation"] : []),
        ];
        return reasons.length
          ? [p.name + "  err-disabled  " + reasons.join(", ")]
          : [];
      });
    return unchanged(
      rows.length
        ? "Port  Status  Reason\n" + rows.join("\n")
        : "No err-disabled interfaces.",
    );
  }
  if (
    exec &&
    /^show spanning-tree interface \S+(?: detail| portfast)?$/.test(lower)
  ) {
    const name = w[3].replace(
      /^(gi|fa|eth|po)(?=\d)/,
      (prefix) =>
        ({
          gi: "gigabitethernet",
          fa: "fastethernet",
          eth: "ethernet",
          po: "port-channel",
        })[prefix]!,
    );
    const p = d.ports.find((p) => p.name.toLowerCase() === name);
    if (!p || !isSwitchport(d, p))
      return unchanged("% Select a Layer 2 switching interface.");
    const state = runtime.bpduPorts.find(
      (pstate) => pstate.device === d.id && pstate.port === p.id,
    );
    const due = bpduGuardDeadline(d, state);
    const edge =
      operationalPortFast(d, p, runtime, t) &&
      portOperational(t, d.id, p.id, runtime);
    return unchanged(
      [
        "Interface: " + p.name,
        "PortFast configured: " +
          (p.portFast ?? "default") +
          " (" +
          (configuredPortFast(d, p, t, runtime) ? "enabled" : "disabled") +
          ")",
        "PortFast operational: " + (edge ? "edge" : "normal/down"),
        "BPDU Guard configured: " + (p.bpduGuard ?? "default"),
        "BPDU Guard effective: " +
          (effectiveBpduGuard(d, p, runtime, t) ? "Enabled" : "Disabled"),
        "Status: " +
          (bpduGuardDown(runtime, d.id, p.id)
            ? "err-disabled (bpduguard)"
            : portOperational(t, d.id, p.id, runtime)
              ? "up"
              : "down"),
        "BPDU Guard violations: " + (state?.violations ?? 0),
        ...(state?.peer
          ? [
              "Last BPDU peer: " +
                (t.devices.find((d) => d.id === state.peer?.device)?.name ??
                  state.peer.device),
            ]
          : []),
        ...(due === undefined
          ? []
          : [
              "Automatic recovery in " +
                Math.max(0, due - runtime.time) +
                "s (CertSim extension)",
            ]),
      ].join("\n"),
    );
  }
  if (exec && /^show spanning-tree(?: vlan \d+)?$/.test(lower)) {
    const vlan = w[2] ? Number(w[3]) : 1;
    if (vlan < 1 || vlan > 4094) return unchanged("% VLAN must be 1–4094.");
    const rows = spanningTree(t, vlan, runtime).filter(
      (p) => p.device === d.id,
    );
    const root = t.devices.find((n) => n.id === rows[0]?.root) ?? d;
    if (!rows.some((p) => p.state !== "disabled"))
      return unchanged("No spanning tree instance exists.");
    return unchanged(
      [
        "VLAN " + vlan,
        "Root: " +
          root.name +
          " " +
          (stpPriority(root, vlan) + vlan) +
          "." +
          bridgeMac(root.id),
        "Bridge: " +
          (stpPriority(d, vlan) + vlan) +
          "." +
          bridgeMac(d.id) +
          " (priority " +
          stpPriority(d, vlan) +
          " sys-id-ext " +
          vlan +
          ")",
        "Interface Role State Cost",
        rows
          .map(
            (r) =>
              d.ports.find((p) => p.id === r.port)?.name +
              " " +
              r.role +
              " " +
              r.state +
              " " +
              r.cost,
          )
          .join("\n") || "No ports in this VLAN.",
        "Immediate convergence; direct-switch BPDU protection is modeled without STP transition timers.",
      ].join("\n"),
    );
  }
  if (s.mode === "config") {
    const defaults = /^(no )?spanning-tree portfast (bpduguard )?default$/.exec(
      lower,
    );
    if (defaults)
      return mutate((device) => {
        device.spanningTree ??= { priorities: [] };
        device.spanningTree[
          defaults[2] ? "bpduGuardDefault" : "portFastDefault"
        ] = !defaults[1];
      });
    if (/^spanning-tree vlan \d+ priority \d+$/.test(lower))
      return mutate((device) => {
        const vlan = Number(w[2]),
          priority = Number(w[4]);
        device.spanningTree = {
          ...device.spanningTree,
          priorities: [
            ...(device.spanningTree?.priorities ?? []).filter(
              (p) => p.vlan !== vlan,
            ),
            { vlan, priority },
          ],
        };
      });
    if (/^no spanning-tree vlan \d+ priority$/.test(lower))
      return mutate((device) => {
        device.spanningTree = {
          ...device.spanningTree,
          priorities: (device.spanningTree?.priorities ?? []).filter(
            (p) => p.vlan !== Number(w[3]),
          ),
        };
      });
  }
  if (s.mode === "interface" && s.portId) {
    const p = d.ports.find((p) => p.id === s.portId);
    if (!p || !isSwitchport(d, p)) return null;
    const fast = /^(no )?spanning-tree portfast(?: (trunk|disable))?$/.exec(
      lower,
    );
    if (fast)
      return mutate((device) => {
        const p = device.ports.find((p) => p.id === s.portId)!;
        if (fast[1]) delete p.portFast;
        else
          p.portFast =
            fast[2] === "trunk"
              ? "trunk"
              : fast[2] === "disable"
                ? "disable"
                : "enable";
      });
    const guard = /^(no )?spanning-tree bpduguard(?: (enable|disable))?$/.exec(
      lower,
    );
    if (guard) {
      if (!guard[1] && !guard[2])
        return unchanged("% Use spanning-tree bpduguard enable or disable.");
      return mutate((device) => {
        const p = device.ports.find((p) => p.id === s.portId)!;
        if (guard[1]) delete p.bpduGuard;
        else p.bpduGuard = guard[2] as "enable" | "disable";
      });
    }
    if (/^spanning-tree cost \d+$/.test(lower))
      return mutate((device) => {
        device.ports.find((p) => p.id === s.portId)!.spanningTreeCost = Number(
          w[2],
        );
      });
    if (lower === "no spanning-tree cost")
      return mutate((device) => {
        delete device.ports.find((p) => p.id === s.portId)!.spanningTreeCost;
      });
  }
  return null;
}
