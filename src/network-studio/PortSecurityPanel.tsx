import type { Device, Topology, PortSecurity } from "./types.ts";
import { useNetworkRuntime } from "./RuntimePanels.tsx";
import { configurationError } from "./engine.ts";
import {
  configuredBindings,
  recoveryDeadline,
  materializeSecurity,
  transitionSticky,
} from "./portSecurity.ts";
import { recoverSecurity } from "./portSecurity.ts";
import { useState } from "react";
import { isPhysicalSwitchport } from "./vlanInterfaces.ts";
export function PortSecurityPanel({
  device,
  topology,
  onCommit,
}: {
  device: Device;
  topology: Topology;
  onCommit: (t: Topology, preserveRuntime?: boolean) => void;
}) {
  const { runtime, refresh } = useNetworkRuntime(),
    [error, setError] = useState("");
  const ports = device.ports.filter(
    (p) => isPhysicalSwitchport(device, p) && !p.channelGroup,
  );
  return (
    <section aria-label="Switch port security" className="ns-stp">
      <h3>Port security</h3>
      <p>
        Fixed access and tagged trunk ports. Secure learning survives ordinary
        MAC aging and clear. Configuration edits reset transient state.
      </p>
      <form
        aria-label="Automatic security recovery"
        key={JSON.stringify(device.securityRecovery)}
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          const next = {
            ...device,
            securityRecovery: {
              enabled: data.has("recovery"),
              interval: Number(data.get("interval")),
            },
          };
          const issue = configurationError(next);
          if (issue) {
            setError(issue);
            return;
          }
          setError("");
          onCommit(
            {
              ...topology,
              devices: topology.devices.map((d) =>
                d.id === device.id ? next : d,
              ),
            },
            true,
          );
        }}
      >
        <label className="ns-checkbox">
          <input
            type="checkbox"
            name="recovery"
            defaultChecked={device.securityRecovery?.enabled ?? false}
          />
          Recover security shutdowns automatically
        </label>
        <label>
          Recovery interval (seconds)
          <input
            type="number"
            min={30}
            max={86400}
            name="interval"
            defaultValue={device.securityRecovery?.interval ?? 300}
            required
          />
        </label>
        <button className="ns-button">Apply recovery settings</button>
        <p>The recovery interval is shared with BPDU Guard.</p>
      </form>
      {ports.map((p) => {
        if (p.mode === "dynamic-auto" || p.mode === "dynamic-desirable")
          return (
            <details key={p.id}>
              <summary>{p.name} · Dynamic mode</summary>
              <p>
                Choose a fixed Access or Trunk mode in Config before enabling
                port security on this interface.
              </p>
            </details>
          );
        const state = runtime.security.find(
          (s) => s.device === device.id && s.port === p.id,
        );
        const due = recoveryDeadline(device, state);
        return (
          <details key={p.id}>
            <summary>
              {p.name} ·{" "}
              {state?.shutdown
                ? "Security shutdown"
                : p.security
                  ? "Secure"
                  : "Disabled"}
            </summary>
            <form
              key={JSON.stringify(p.security)}
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget),
                  next = structuredClone(device),
                  port = next.ports.find((q) => q.id === p.id)!;
                if (data.has("enabled"))
                  port.security = {
                    ...port.security,
                    bindings: String(data.get("bindings"))
                      .split(/\n/)
                      .filter((s) => s.trim())
                      .map((line) => {
                        const [vlan, mac, kind] = line.trim().split(/\s+/);
                        return {
                          vlan: Number(vlan),
                          mac: (mac ?? "").replace(/[.:-]/g, "").toLowerCase(),
                          sticky: kind === "sticky",
                        };
                      }),
                    vlanMaximums: String(data.get("vlanMaximums"))
                      .split(/[\s,]+/)
                      .filter(Boolean)
                      .map((line) => {
                        const [vlan, maximum] = line.split(":").map(Number);
                        return { vlan, maximum };
                      }),
                    maximum: Number(data.get("maximum")),
                    violation: String(
                      data.get("violation"),
                    ) as PortSecurity["violation"],
                    ageStatic: data.has("ageStatic"),
                    agingMinutes: Number(data.get("agingMinutes")),
                    agingType: String(data.get("agingType")) as
                      | "absolute"
                      | "inactivity",
                    addresses: String(data.get("addresses"))
                      .split(/[\s,]+/)
                      .filter(Boolean)
                      .map((a) => a.toLowerCase().replace(/[.:-]/g, "")),
                  };
                else delete port.security;
                const issue = configurationError(next);
                if (issue) {
                  setError(issue);
                  return;
                }
                setError("");
                onCommit({
                  ...topology,
                  devices: topology.devices.map((d) =>
                    d.id === device.id ? next : d,
                  ),
                });
              }}
            >
              <label>
                <input
                  type="checkbox"
                  name="enabled"
                  defaultChecked={!!p.security}
                />
                Enable security {p.name}
              </label>
              <label>
                Maximum addresses
                <input
                  aria-label={`Secure maximum ${p.name}`}
                  type="number"
                  name="maximum"
                  min="1"
                  max="128"
                  required
                  defaultValue={p.security?.maximum ?? 1}
                />
              </label>
              <label>
                Violation mode
                <select
                  aria-label={`Secure violation ${p.name}`}
                  name="violation"
                  defaultValue={p.security?.violation ?? "shutdown"}
                >
                  {["protect", "restrict", "shutdown"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                Secure aging minutes (0 disables)
                <input
                  aria-label={`Secure aging minutes ${p.name}`}
                  type="number"
                  min="0"
                  max="1440"
                  required
                  name="agingMinutes"
                  defaultValue={p.security?.agingMinutes ?? 0}
                />
              </label>
              <label className="ns-checkbox">
                <input
                  name="ageStatic"
                  type="checkbox"
                  aria-label={`Age configured secure addresses ${p.name}`}
                  defaultChecked={p.security?.ageStatic ?? false}
                />
                Age configured secure addresses
              </label>
              <label>
                Secure aging type
                <select
                  aria-label={`Secure aging type ${p.name}`}
                  name="agingType"
                  defaultValue={p.security?.agingType ?? "absolute"}
                >
                  <option>absolute</option>
                  <option>inactivity</option>
                </select>
              </label>
              <label>
                Configured MAC addresses
                <textarea
                  aria-label={`Secure addresses ${p.name}`}
                  name="addresses"
                  defaultValue={p.security?.addresses.join("\n") ?? ""}
                  maxLength={2304}
                />
              </label>
              <label>
                VLAN bindings: VLAN MAC [sticky]
                <textarea
                  aria-label={`Secure VLAN bindings ${p.name}`}
                  name="bindings"
                  maxLength={4096}
                  defaultValue={
                    p.security?.bindings
                      ?.map(
                        (b) => `${b.vlan} ${b.mac}${b.sticky ? " sticky" : ""}`,
                      )
                      .join("\n") ?? ""
                  }
                />
              </label>
              <label>
                VLAN maxima: VLAN:maximum
                <input
                  aria-label={`Secure VLAN maxima ${p.name}`}
                  name="vlanMaximums"
                  maxLength={2048}
                  defaultValue={
                    p.security?.vlanMaximums
                      ?.map((b) => `${b.vlan}:${b.maximum}`)
                      .join(",") ?? ""
                  }
                />
              </label>
              <button className="ns-button">
                Apply port security {p.name}
              </button>
            </form>
            <button
              className="ns-button"
              disabled={!p.security}
              onClick={() => {
                const base = materializeSecurity(topology, runtime),
                  next = structuredClone(base),
                  old = base.devices.find((d) => d.id === device.id)!,
                  q = next.devices
                    .find((d) => d.id === device.id)!
                    .ports.find((q) => q.id === p.id)!;
                const enabled = !q.security!.sticky;
                q.security!.sticky = enabled;
                if (!enabled)
                  q.security!.bindings = q.security!.bindings?.filter(
                    (b) => !b.sticky,
                  );
                const issue = configurationError(
                  next.devices.find((d) => d.id === device.id)!,
                );
                if (issue) {
                  setError(issue);
                  return;
                }
                transitionSticky(runtime, old, p.id, enabled);
                onCommit(next, true);
                refresh();
              }}
            >
              {p.security?.sticky ? "Disable" : "Enable"} sticky learning{" "}
              {p.name}
            </button>
            <div aria-label={`Secure status ${p.name}`}>
              <p>
                {state?.shutdown ? "Security shutdown" : "No security shutdown"}{" "}
                · Violations: {state?.violations ?? 0}
              </p>
              <p>Configured: {p.security?.addresses.join(", ") || "none"}</p>
              <p>
                VLAN bindings:{" "}
                {configuredBindings(p)
                  .filter(
                    (b) =>
                      !p.security?.addresses.includes(b.mac) ||
                      b.vlan !== p.vlan,
                  )
                  .map((b) => `${b.vlan}/${b.mac}${b.sticky ? " sticky" : ""}`)
                  .join(", ") || "none"}
              </p>
              <p>Dynamic secure: {state?.addresses.join(", ") || "none"}</p>
              {due !== undefined && (
                <p>Automatic recovery in {Math.max(0, due - runtime.time)}s</p>
              )}
              {state?.lastSource && <p>Last violation: {state.lastSource}</p>}
            </div>
            <button
              className="ns-button"
              onClick={() => {
                recoverSecurity(runtime, device.id, p.id);
                refresh();
              }}
            >
              Recover security {p.name}
            </button>
          </details>
        );
      })}
      {error && <p role="alert">{error}</p>}
      <small>
        Recovery clears this port's dynamic secure addresses, violation counter
        and shutdown latch. Configured and sticky addresses remain on the port.
      </small>
    </section>
  );
}
