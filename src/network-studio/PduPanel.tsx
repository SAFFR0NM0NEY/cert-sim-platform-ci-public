import { applicationHost } from "./wireless.ts";
import { isPacketEndpoint, packetInterfaces } from "./vlanInterfaces.ts";
import { useState } from "react";
import type { PingResult, Topology, UserPdu } from "./types.ts";
import { useNetworkRuntime } from "./RuntimePanels.tsx";
import {
  DEFAULT_SCENARIO_ID,
  MAX_SCENARIOS,
  scenariosFor,
  activePdus,
  removeScenario,
  parseScenarios,
} from "./scenarios.ts";
import { MAX_PDUS, runPdu } from "./pdus.ts";
interface Props {
  topology: Topology;
  onAdd: (pdu: UserPdu) => void;
  onCommit: (next: Topology, preserve?: boolean) => unknown;
  onResult: (result: PingResult) => void;
}
export function PduPanel({ topology, onAdd, onCommit, onResult }: Props) {
  const { runtime } = useNetworkRuntime(),
    hosts = topology.devices.filter(isPacketEndpoint);
  const [source, setSource] = useState(""),
    [target, setTarget] = useState(""),
    [port, setPort] = useState(""),
    [protocol, setProtocol] = useState<UserPdu["protocol"]>("icmp");
  const scenarios = scenariosFor(topology),
    active = scenarios.find(
      (s) => s.id === (topology.activeScenario ?? DEFAULT_SCENARIO_ID),
    )!,
    packets = activePdus(topology);
  const [scenarioError, setScenarioError] = useState("");
  const [timing, setTiming] = useState("now");
  const sender =
      hosts.find((d) => d.id === source) ??
      hosts.find((d) => applicationHost(d.kind)) ??
      hosts[0],
    dest =
      hosts.find((d) => d.id === target) ??
      hosts.find((d) => d !== sender && applicationHost(d.kind)) ??
      hosts.find((d) => d !== sender) ??
      sender;
  const interfaces = dest ? packetInterfaces(dest) : [];
  const ipv6 = protocol === "icmpv6";
  const transport = protocol === "tcp" || protocol === "udp";
  const nic =
    interfaces.find((p) => p.id === port) ??
    interfaces.find((p) => (ipv6 ? p.ipv6 : p.ip)) ??
    interfaces[0];
  const name = (id: string) => topology.devices.find((d) => d.id === id)?.name;
  return (
    <section className="ns-client-tools" aria-label="User-created PDUs">
      <details>
        <summary>User-created PDUs ({packets.length})</summary>
        <label>
          Packet scenario
          <select
            value={active.id}
            onChange={(e) => {
              setScenarioError("");
              onCommit({ ...topology, activeScenario: e.target.value }, true);
            }}
          >
            {scenarios.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <details>
          <summary>Scenario settings</summary>
          <form
            className="ns-config"
            key={active.id + active.name + active.description}
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              const next = scenarios.map((s) =>
                s.id === active.id
                  ? {
                      ...s,
                      name: String(data.get("name")).trim(),
                      description: String(data.get("description")),
                    }
                  : s,
              );
              try {
                parseScenarios(next);
              } catch (error) {
                setScenarioError(
                  error instanceof Error ? error.message : "Invalid scenario.",
                );
                return;
              }
              setScenarioError("");
              onCommit({ ...topology, scenarios: next }, true);
            }}
          >
            <label>
              Scenario name
              <input
                name="name"
                maxLength={48}
                defaultValue={active.name}
                required
              />
            </label>
            <label>
              Scenario description
              <input
                name="description"
                maxLength={300}
                defaultValue={active.description}
              />
            </label>
            <button className="ns-button">Save scenario</button>
          </form>
          <div className="ns-drawing-tools">
            <button
              className="ns-button"
              disabled={scenarios.length >= MAX_SCENARIOS}
              onClick={() => {
                let i = 1;
                while (
                  scenarios.some(
                    (s) => s.name.toLowerCase() === "scenario " + i,
                  )
                )
                  i++;
                const scenario = {
                  id: crypto.randomUUID(),
                  name: "Scenario " + i,
                  description: "",
                };
                setScenarioError("");
                onCommit(
                  {
                    ...topology,
                    scenarios: [...scenarios, scenario],
                    activeScenario: scenario.id,
                  },
                  true,
                );
              }}
            >
              New scenario
            </button>
            <button
              className="ns-link-button"
              disabled={active.id === DEFAULT_SCENARIO_ID}
              onClick={() => {
                setScenarioError("");
                onCommit(removeScenario(topology, active.id), true);
              }}
            >
              Remove scenario
            </button>
          </div>
          {scenarioError && <p role="alert">{scenarioError}</p>}
        </details>
        <form
          className="ns-config"
          onSubmit={(e) => {
            e.preventDefault();
            if (!sender || !dest || !nic) return;
            const data = new FormData(e.currentTarget);
            onAdd({
              id: crypto.randomUUID(),
              source: sender.id,
              target: dest.id,
              port: nic.id,
              protocol,
              ...(Number(data.get("ttl")) === 32
                ? {}
                : { ttl: Number(data.get("ttl")) }),
              ...(ipv6 && data.get("scope")
                ? { sourceInterface: String(data.get("scope")) }
                : {}),
              ...(timing === "now"
                ? {}
                : {
                    schedule: {
                      delay: Number(data.get("delay")),
                      ...(timing === "periodic"
                        ? { interval: Number(data.get("interval")) }
                        : {}),
                    },
                  }),
              ...(transport
                ? {
                    destinationPort: Number(data.get("transport")),
                  }
                : {}),
            });
          }}
        >
          <label>
            PDU source
            <select
              value={sender?.id ?? ""}
              onChange={(e) => setSource(e.target.value)}
            >
              {hosts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            PDU destination
            <select
              value={dest?.id ?? ""}
              onChange={(e) => {
                setTarget(e.target.value);
                setPort("");
              }}
            >
              {hosts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Destination interface
            <select
              value={nic?.id ?? ""}
              onChange={(e) => setPort(e.target.value)}
            >
              {interfaces.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {(ipv6 ? p.ipv6 : p.ip) || "unassigned"}
                </option>
              ))}
            </select>
          </label>
          <label>
            PDU protocol
            <select
              value={protocol}
              onChange={(e) =>
                setProtocol(e.target.value as UserPdu["protocol"])
              }
            >
              {(["icmp", "icmpv6", "tcp", "udp"] as const).map((p) => (
                <option key={p} value={p}>
                  {p.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          {ipv6 && (
            <label>
              IPv6 source interface
              <select
                name="scope"
                key={sender?.id}
                aria-label="IPv6 PDU source interface"
              >
                <option value="">Automatic</option>
                {(sender ? packetInterfaces(sender) : []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.ipv6 || "unassigned"}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            {ipv6 ? "Hop limit" : "TTL"}
            <input
              type="number"
              min={1}
              max={255}
              defaultValue={32}
              name="ttl"
              required
            />
          </label>
          {transport && (
            <label>
              Destination port
              <input
                type="number"
                name="transport"
                min={1}
                max={65535}
                defaultValue={protocol === "tcp" ? 80 : 53}
                key={protocol}
                required
              />
            </label>
          )}
          <label>
            PDU timing
            <select value={timing} onChange={(e) => setTiming(e.target.value)}>
              <option value="now">Immediate</option>
              <option value="once">Delayed one-shot</option>
              <option value="periodic">Periodic</option>
            </select>
          </label>
          {timing !== "now" && (
            <label>
              Initial delay (seconds)
              <input
                type="number"
                name="delay"
                min={0}
                max={86400}
                defaultValue={10}
                required
              />
            </label>
          )}
          {timing === "periodic" && (
            <label>
              Repeat interval (seconds)
              <input
                type="number"
                name="interval"
                min={1}
                max={86400}
                defaultValue={10}
                required
              />
            </label>
          )}
          <button
            className="ns-button"
            disabled={!nic || (topology.pdus?.length ?? 0) >= MAX_PDUS}
          >
            {timing === "now" ? "Add and send PDU" : "Schedule PDU"}
          </button>
        </form>
        {packets.map((p) => {
          const last = runtime.pduResults.get(p.id),
            timer = runtime.pduTimers.get(p.id);
          return (
            <fieldset className="ns-route" key={p.id}>
              <legend>
                {p.protocol.toUpperCase()} · {name(p.source)} → {name(p.target)}
              </legend>
              <p>
                {last ? (last.ok ? "Delivered" : "Failed") : "Ready"}
                {p.destinationPort ? " · port " + p.destinationPort : ""}
                {p.ttl !== undefined &&
                  " · " +
                    (p.protocol === "icmpv6" ? "Hop limit " : "TTL ") +
                    p.ttl}
              </p>
              {timer && (
                <p aria-label="PDU schedule status">
                  {timer.sent} scheduled sends ·{" "}
                  {timer.next === undefined
                    ? "Complete"
                    : "Next at " + timer.next + "s"}
                  {timer.last !== undefined
                    ? " · Last at " + timer.last + "s"
                    : ""}
                </p>
              )}
              <div className="ns-drawing-tools">
                <button
                  className="ns-button"
                  onClick={() => onResult(runPdu(topology, p, runtime))}
                >
                  Send again
                </button>
                <button
                  className="ns-button"
                  disabled={!last}
                  onClick={() => last && onResult(last)}
                >
                  View trace
                </button>
                <button
                  className="ns-link-button"
                  onClick={() =>
                    onCommit(
                      {
                        ...topology,
                        pdus: topology.pdus?.filter((d) => d.id !== p.id),
                      },
                      true,
                    )
                  }
                >
                  Remove PDU
                </button>
              </div>
            </fieldset>
          );
        })}
      </details>
    </section>
  );
}
