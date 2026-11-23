import { useState } from "react";
import type { Device, Port, Topology } from "./types.ts";
import { spanningTree, stpPriority, bridgeMac } from "./spanningTree.ts";
import { configurationError } from "./engine.ts";
import { isPhysicalSwitchport } from "./vlanInterfaces.ts";
import { portOperational } from "./ethernet.ts";
import { bridgePorts } from "./etherChannel.ts";
import { useNetworkRuntime } from "./RuntimePanels.tsx";
import {
  bpduGuardDeadline,
  bpduGuardDown,
  clearBpduState,
  configuredPortFast,
  effectiveBpduGuard,
  operationalPortFast,
  synchronizeBpduGuard,
} from "./bpduGuard.ts";
export function SpanningTreePanel({
  device,
  topology,
  onCommit,
}: {
  device: Device;
  topology: Topology;
  onCommit: (t: Topology, preserveRuntime?: boolean) => void;
}) {
  const { runtime, refresh } = useNetworkRuntime();
  const [vlan, setVlan] = useState(1),
    [error, setError] = useState("");
  const ports = bridgePorts(topology, device, runtime);
  const protectionPorts = device.ports.filter((p) =>
    isPhysicalSwitchport(device, p),
  );
  const rows = spanningTree(topology, vlan, runtime).filter(
      (r) => r.device === device.id,
    ),
    root = rows.some((r) => r.state !== "disabled")
      ? topology.devices.find((d) => d.id === rows[0]?.root)
      : undefined;
  return (
    <section className="ns-lifecycle ns-stp" aria-label="Spanning tree">
      <h3>Spanning tree</h3>
      <p>Per-VLAN loop prevention · Immediate convergence</p>
      <label>
        Inspect VLAN
        <input
          aria-label="Inspect VLAN"
          type="number"
          min="1"
          max="4094"
          value={vlan}
          onChange={(e) => {
            const n = e.target.valueAsNumber;
            if (Number.isInteger(n) && n >= 1 && n <= 4094) setVlan(n);
          }}
        />
      </label>
      <form
        key={`${device.id}/${vlan}/${JSON.stringify(device.spanningTree)}/${JSON.stringify(device.ports.map((p) => [p.id, p.spanningTreeCost, p.portFast, p.bpduGuard]))}`}
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget),
            next = structuredClone(device);
          const tree = next.spanningTree ?? { priorities: [] };
          for (const key of ["portFastDefault", "bpduGuardDefault"] as const) {
            if (form.has(key) !== (tree[key] ?? false)) {
              tree[key] = form.has(key);
              next.spanningTree = tree;
            }
          }
          const priority = Number(form.get("priority"));
          if (priority !== stpPriority(device, vlan)) {
            tree.priorities = [
              ...tree.priorities.filter((entry) => entry.vlan !== vlan),
              { vlan, priority },
            ];
            next.spanningTree = tree;
          }
          for (const p of next.ports.filter((p) =>
            ports.some((row) => row.id === p.id),
          )) {
            const value = String(form.get(p.id) ?? "").trim();
            if (value) {
              const cost = Number(value);
              if (cost !== p.spanningTreeCost) p.spanningTreeCost = cost;
            } else if (p.spanningTreeCost !== undefined) {
              delete p.spanningTreeCost;
            }
          }
          for (const p of next.ports.filter((p) =>
            isPhysicalSwitchport(next, p),
          )) {
            const edge = String(
              form.get("portFast/" + p.id),
            ) as Port["portFast"];
            const guard = String(
              form.get("bpduGuard/" + p.id),
            ) as Port["bpduGuard"];
            if (edge !== (p.portFast ?? "default"))
              p.portFast = edge === "default" ? undefined : edge;
            if (guard !== (p.bpduGuard ?? "default"))
              p.bpduGuard = guard === "default" ? undefined : guard;
          }
          const failure = configurationError(next);
          if (failure) {
            setError(failure);
            return;
          }
          onCommit({
            ...topology,
            devices: topology.devices.map((d) => (d.id === next.id ? next : d)),
          });
          setError("");
        }}
      >
        <label>
          Bridge priority
          <select
            name="priority"
            aria-label="Bridge priority"
            defaultValue={stpPriority(device, vlan)}
          >
            {Array.from({ length: 16 }, (_, i) => (
              <option key={i} value={i * 4096}>
                {i * 4096}
              </option>
            ))}
          </select>
        </label>
        <details>
          <summary>Interface path costs</summary>
          {ports.map((p) => (
            <label key={p.id}>
              {p.name}
              <input
                aria-label={`Spanning-tree cost ${p.name}`}
                name={p.id}
                type="number"
                min="1"
                max="200000000"
                defaultValue={p.spanningTreeCost ?? ""}
                placeholder={
                  rows.some((row) => row.port === p.id)
                    ? `Auto (${rows.find((row) => row.port === p.id)!.cost})`
                    : "Auto"
                }
              />
            </label>
          ))}
          <p>
            Leave blank for automatic cost. A Port-channel cost adjusts to its
            bundled member count.
          </p>
        </details>
        <h4>Edge port protection</h4>
        <label className="ns-checkbox">
          <input
            type="checkbox"
            name="portFastDefault"
            defaultChecked={device.spanningTree?.portFastDefault ?? false}
          />
          PortFast by default on access ports
        </label>
        <label className="ns-checkbox">
          <input
            type="checkbox"
            name="bpduGuardDefault"
            defaultChecked={device.spanningTree?.bpduGuardDefault ?? false}
          />
          BPDU Guard by default on PortFast ports
        </label>
        {protectionPorts.map((p) => {
          const state = runtime.bpduPorts.find(
            (entry) => entry.device === device.id && entry.port === p.id,
          );
          const down = bpduGuardDown(runtime, device.id, p.id);
          const edge =
            operationalPortFast(device, p, runtime, topology) &&
            portOperational(topology, device.id, p.id, runtime);
          const due = bpduGuardDeadline(device, state);
          return (
            <details className="ns-stp-protection" key={p.id}>
              <summary>
                {p.name} ·{" "}
                {down ? "BPDU Guard shutdown" : edge ? "Edge" : "Normal"}
              </summary>
              <label>
                PortFast
                <select
                  aria-label={"PortFast " + p.name}
                  name={"portFast/" + p.id}
                  defaultValue={p.portFast ?? "default"}
                >
                  <option value="default">Default</option>
                  <option value="enable">Enabled</option>
                  <option value="trunk">Trunk</option>
                  <option value="disable">Disabled</option>
                </select>
              </label>
              <label>
                BPDU Guard
                <select
                  aria-label={"BPDU Guard " + p.name}
                  name={"bpduGuard/" + p.id}
                  defaultValue={p.bpduGuard ?? "default"}
                >
                  <option value="default">Default</option>
                  <option value="enable">Enabled</option>
                  <option value="disable">Disabled (CertSim)</option>
                </select>
              </label>
              <div aria-label={"Spanning-tree protection " + p.name}>
                <p>
                  Configured PortFast:{" "}
                  {configuredPortFast(device, p, topology, runtime)
                    ? "enabled"
                    : "disabled"}{" "}
                  · Operational edge: {edge ? "yes" : "no"}
                </p>
                <p>
                  Effective BPDU Guard:{" "}
                  {effectiveBpduGuard(device, p, runtime, topology)
                    ? "enabled"
                    : "disabled"}
                </p>
                {state?.edgeLost && (
                  <p>A received BPDU removed operational edge status.</p>
                )}
                {down && (
                  <p className="ns-error">
                    Err-disabled · BPDU Guard · Violations:{" "}
                    {state?.violations ?? 0}
                  </p>
                )}
                {state?.peer && (
                  <p>
                    BPDU source:{" "}
                    {topology.devices.find((d) => d.id === state.peer?.device)
                      ?.name ?? "Disconnected switch"}
                  </p>
                )}
                {due !== undefined && (
                  <p>
                    Automatic recovery in {Math.max(0, due - runtime.time)}s
                  </p>
                )}
              </div>
              <button
                type="button"
                className="ns-button"
                disabled={!down}
                onClick={() => {
                  clearBpduState(runtime, device.id, p.id);
                  synchronizeBpduGuard(topology, runtime);
                  refresh();
                }}
              >
                Recover BPDU Guard {p.name}
              </button>
            </details>
          );
        })}
        {error && <p role="alert">{error}</p>}
        <button className="ns-button" type="submit">
          Apply spanning tree
        </button>
      </form>
      <form
        aria-label="BPDU Guard recovery"
        key={JSON.stringify([
          device.bpduGuardRecovery,
          device.securityRecovery?.interval,
        ])}
        onSubmit={(e) => {
          e.preventDefault();
          const form = new FormData(e.currentTarget);
          const next: Device = { ...device };
          const enabled = form.has("bpduRecovery");
          const interval = Number(form.get("interval"));
          if (enabled !== (device.bpduGuardRecovery ?? false))
            next.bpduGuardRecovery = enabled;
          if (interval !== (device.securityRecovery?.interval ?? 300))
            next.securityRecovery = {
              enabled: device.securityRecovery?.enabled ?? false,
              interval,
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
                d.id === next.id ? next : d,
              ),
            },
            true,
          );
        }}
      >
        <h4>BPDU Guard recovery</h4>
        <label className="ns-checkbox">
          <input
            type="checkbox"
            name="bpduRecovery"
            defaultChecked={device.bpduGuardRecovery ?? false}
          />
          Recover BPDU Guard shutdowns automatically
        </label>
        <label>
          Shared recovery interval (seconds)
          <input
            type="number"
            name="interval"
            min={30}
            max={86400}
            required
            defaultValue={device.securityRecovery?.interval ?? 300}
          />
        </label>
        <p className="ns-panel-note">
          The interval is shared with port-security recovery. Automatic BPDU
          Guard recovery is a CertSim simulation extension for Packet Tracer
          2960 switches.
        </p>
        <button className="ns-button">Apply BPDU Guard recovery</button>
      </form>
      <p>
        Bridge: {bridgeMac(device.id)}
        <br />
        Root: {root?.name ?? "No participating ports"}
      </p>
      <div className="ns-stp-rows" aria-label="Spanning-tree port roles">
        {rows.map((r) => (
          <p key={r.port}>
            <strong>{device.ports.find((p) => p.id === r.port)?.name}</strong>
            <br />
            {r.role} · {r.state} · cost {r.cost} · root path {r.rootCost}
          </p>
        ))}
      </div>
      <small>
        Carrier can be up while a VLAN is blocked. PortFast and BPDU Guard use
        immediate BPDU detection; listening and learning delays are not modeled.
        Recovery uses the simulation clock.
      </small>
    </section>
  );
}
