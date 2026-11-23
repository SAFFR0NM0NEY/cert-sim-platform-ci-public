import type { CommandResult } from "./cli.ts";
import type { Device, CliSession } from "./types.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
import { discoveryCapable } from "./discovery.ts";
import { adoptRuntime } from "./networkRuntime.ts";
export function discoveryCommand(
  device: Device,
  session: CliSession,
  line: string,
  r: NetworkRuntime,
  mutate: (fn: (d: Device) => void) => CommandResult,
  unchanged: (s: string) => CommandResult,
): CommandResult | null {
  if (!discoveryCapable(device)) return null;
  const show = /^show (cdp|lldp) neighbors( detail)?$/.exec(line);
  if (show && ["user", "privileged"].includes(session.mode)) {
    const rows = r.neighbors.filter(
      (n) => n.local.device === device.id && n.protocol === show[1],
    );
    if (!rows.length) return unchanged("No neighbors learned.");
    return unchanged(
      rows
        .map((n) =>
          [
            n.name,
            device.ports.find((p) => p.id === n.local.port)!.name +
              " → " +
              n.interfaceName,
            n.expires - r.time + "s",
            ...(show[2]
              ? [
                  n.kind,
                  n.address || "No management address",
                  n.voiceVlan ? "Voice VLAN " + n.voiceVlan : "",
                ]
              : []),
          ]
            .filter(Boolean)
            .join("  "),
        )
        .join("\n"),
    );
  }
  const enabled = !line.startsWith("no "),
    positive = line.replace(/^no /, "");
  let result: CommandResult;
  if (
    session.mode === "config" &&
    (positive === "cdp run" || positive === "lldp run")
  ) {
    result = mutate((d) => {
      d[positive === "cdp run" ? "cdp" : "lldp"] = enabled;
    });
  } else if (
    session.mode === "interface" &&
    session.portId &&
    ["cdp enable", "lldp receive", "lldp transmit"].includes(positive)
  ) {
    if (device.ports.find((p) => p.id === session.portId)?.virtual)
      return unchanged("% Discovery is configured on physical interfaces.");
    const key =
      positive === "cdp enable"
        ? "cdp"
        : positive === "lldp receive"
          ? "lldpReceive"
          : "lldpTransmit";
    result = mutate((d) => {
      d.ports.find((p) => p.id === session.portId)![key] = enabled;
    });
  } else return null;
  if (result.changed) {
    adoptRuntime(r, result.topology);
    result.preserveRuntime = true;
  }
  return result;
}
