import { isRoutedInterface, isSwitchport } from "./vlanInterfaces.ts";
import { ipv4 } from "./addressing.ts";
import type {
  ActivityField,
  Device,
  InterfaceCheck,
  Port,
  PracticeActivity,
  Topology,
  UserPdu,
} from "./types.ts";
import { bool, list, object, text, unique } from "./validation.ts";
import { parsePdus, runPdu } from "./pdus.ts";
import { createRuntime, type NetworkRuntime } from "./networkRuntime.ts";

export const MAX_CHECKS = 16;

export const fieldLabels: Record<ActivityField, string> = {
  enabled: "Administrative state",
  ipv4: "IPv4 address and prefix",
  vlan: "Access VLAN",
  band: "Radio band",
};

export function interfaceValue(
  d: Device,
  p: Port,
  field: ActivityField,
): string | undefined {
  if (field === "enabled") return p.enabled ? "up" : "down";
  if (
    field === "ipv4" &&
    (d.kind !== "switch" || isRoutedInterface(d, p)) &&
    d.kind !== "ap" &&
    !(d.kind === "phone" && p.id !== "p0")
  )
    return p.ip ? p.ip + "/" + p.prefix : "unassigned";
  if (field === "vlan" && isSwitchport(d, p) && p.mode !== "trunk")
    return String(p.vlan);
  if (field === "band" && p.media === "radio" && d.wireless)
    return d.wireless.band ?? (d.kind === "ap" ? "2.4" : "both");
  return undefined;
}
export function interfaceCheckKey(
  check: Pick<InterfaceCheck, "device" | "port" | "field">,
) {
  return JSON.stringify([check.device, check.port, check.field]);
}

function validExpectedSetting(
  d: Device,
  p: Port,
  field: ActivityField,
  expected: string,
): boolean {
  switch (field) {
    case "enabled":
      return expected === "up" || expected === "down";
    case "vlan":
      return (
        isSwitchport(d, p) &&
        /^[1-9]\d{0,3}$/.test(expected) &&
        Number(expected) <= 4094
      );
    case "band":
      return (
        p.media === "radio" &&
        (expected === "2.4" ||
          expected === "5" ||
          (expected === "both" && d.kind === "laptop"))
      );
    case "ipv4": {
      if (interfaceValue(d, p, "ipv4") === undefined) return false;
      if (expected === "unassigned") return true;
      const parts = expected.split("/");
      return (
        parts.length === 2 &&
        ipv4(parts[0]) !== null &&
        /^(0|[1-9]\d?)$/.test(parts[1]) &&
        Number(parts[1]) <= 32
      );
    }
  }
}

function parseInterfaceChecks(
  raw: unknown,
  initial: Topology,
): InterfaceCheck[] {
  const checks = list(raw, MAX_CHECKS).map((value) => {
    const c = object(value),
      device = text(c.device, 80),
      port = text(c.port, 80),
      expected = text(c.expected, 32);
    const d = initial.devices.find((d) => d.id === device),
      p = d?.ports.find((p) => p.id === port);
    if (typeof c.field !== "string" || !Object.hasOwn(fieldLabels, c.field))
      throw Error("Unknown activity setting.");
    const field = c.field as ActivityField;
    if (!d || !p) throw Error("Invalid activity interface.");
    if (!validExpectedSetting(d, p, field, expected))
      throw Error("Invalid expected interface setting.");
    return { device, port, field, expected };
  });
  unique(checks.map(interfaceCheckKey));
  return checks;
}

function onDemand(pdu: UserPdu): UserPdu {
  const { schedule: _schedule, scenario: _scenario, ...probe } = pdu;
  return probe;
}

export function parseActivity(
  raw: Record<string, unknown>,
  initial: Topology,
): PracticeActivity {
  const title = text(raw.title, 100);
  const instructions = raw.instructions;
  if (
    typeof instructions !== "string" ||
    !instructions.trim() ||
    instructions.length > 4000 ||
    /[\u0000-\u0008\u000b-\u001f]/.test(instructions)
  )
    throw Error("Enter activity instructions of up to 4000 characters.");
  const checks = list(raw.checks, MAX_CHECKS).map((value) => {
    const check = object(value);
    const [probe] = parsePdus([check.probe], initial.devices);
    if (probe.schedule || probe.scenario)
      throw Error("Activity checks must be on-demand probes.");
    return { probe, deliver: bool(check.deliver) };
  });
  const interfaceChecks =
    raw.interfaceChecks === undefined
      ? []
      : parseInterfaceChecks(raw.interfaceChecks, initial);
  if (!checks.length && !interfaceChecks.length)
    throw Error("Select at least one connectivity or interface check.");
  if (checks.length + interfaceChecks.length > MAX_CHECKS)
    throw Error("Select up to " + MAX_CHECKS + " checks.");
  unique(checks.map((c) => c.probe.id));
  return {
    title,
    instructions,
    initial,
    checks,
    ...(interfaceChecks.length ? { interfaceChecks } : {}),
  };
}

export function captureActivity(
  t: Topology,
  title: string,
  instructions: string,
  checks: PracticeActivity["checks"],
  interfaceChecks: InterfaceCheck[] = [],
  preserveInitial = false,
): PracticeActivity {
  const { activity: _previous, packageEdits: _files, ...network } = t;
  return parseActivity(
    {
      title,
      instructions,
      interfaceChecks,
      checks: checks.map((c) => ({ ...c, probe: onDemand(c.probe) })),
    },
    structuredClone(
      preserveInitial && t.activity ? t.activity.initial : network,
    ),
  );
}

export function resetActivity(t: Topology): Topology {
  if (!t.activity) return t;
  const { packageEdits: _files, ...initial } = structuredClone(
    t.activity.initial,
  );
  return {
    ...initial,
    activity: t.activity,
    ...(t.packageEdits && { packageEdits: t.packageEdits }),
  };
}

export function checkActivity(t: Topology, runtime?: NetworkRuntime) {
  const packets = (t.activity?.checks ?? []).map(({ probe, deliver }) => {
    const source = t.devices.find((d) => d.id === probe.source);
    const target = t.devices.find((d) => d.id === probe.target);
    const targetPort = target?.ports.find((p) => p.id === probe.port);
    if (
      !source ||
      !targetPort ||
      (probe.sourceInterface &&
        !source.ports.some((p) => p.id === probe.sourceInterface))
    ) {
      return {
        ok: false,
        message: "The required device or interface is missing.",
      };
    }
    if (!(probe.protocol === "icmpv6" ? targetPort.ipv6 : targetPort.ip))
      return {
        ok: false,
        message: "The destination interface needs an address to test.",
      };
    const isolated = runtime ? structuredClone(runtime) : createRuntime();
    const result = runPdu(t, probe, isolated);
    return { ok: result.ok === deliver, message: result.message };
  });
  const settings = (t.activity?.interfaceChecks ?? []).map((c) => {
    const d = t.devices.find((d) => d.id === c.device),
      p = d?.ports.find((p) => p.id === c.port);
    const actual = d && p ? interfaceValue(d, p, c.field) : undefined;
    return {
      ok: actual === c.expected,
      message:
        actual === undefined
          ? "Device, interface or setting unavailable."
          : "Current " + actual + " · expected " + c.expected,
    };
  });
  return [...packets, ...settings];
}

export function describeProbe(t: Topology, p: UserPdu) {
  const name = (id: string) => t.devices.find((d) => d.id === id)?.name ?? id;
  const port = t.devices
    .find((d) => d.id === p.target)
    ?.ports.find((port) => port.id === p.port);
  return (
    name(p.source) +
    " → " +
    name(p.target) +
    " (" +
    (port?.name ?? p.port) +
    ", " +
    p.protocol.toUpperCase() +
    (p.destinationPort ? " " + p.destinationPort : "") +
    ")"
  );
}
