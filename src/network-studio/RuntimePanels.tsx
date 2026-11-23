import { isPacketEndpoint, packetInterfaces } from "./vlanInterfaces.ts";
import { bridgePorts } from "./etherChannel.ts";
import { PortSecurityPanel } from "./PortSecurityPanel.tsx";
import { createContext, useContext, useState } from "react";
import type { Device, Topology } from "./types.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
import {
  clearMac,
  createRuntime,
  clearNat,
  flushDns,
} from "./networkRuntime.ts";
import { advanceWorkspaceClock } from "./workspaceClock.ts";
import { interfaceMac, transmitFrame } from "./ethernet.ts";
import { configurationError } from "./engine.ts";
export const RuntimeContext = createContext<{
  runtime: NetworkRuntime;
  refresh: () => void;
}>({ runtime: createRuntime(), refresh: () => {} });
export const useNetworkRuntime = () => useContext(RuntimeContext);
export function RuntimeControls({
  topology,
  onCommit,
}: {
  topology: Topology;
  onCommit: (t: Topology, preserveRuntime?: boolean) => unknown;
}) {
  const { runtime, refresh } = useNetworkRuntime();
  return (
    <section className="ns-client-tools" aria-label="Simulation clock">
      <h3>Simulation clock · {runtime.time}s</h3>
      <p>
        Advance time to renew DHCP leases, provision phones, refresh neighbors
        and run port recovery timers.
      </p>
      <div className="ns-drawing-tools">
        {[10, 60, 300].map((seconds) => (
          <button
            key={seconds}
            className="ns-button"
            onClick={() => {
              const next = advanceWorkspaceClock(runtime, topology, seconds);
              if (next !== topology) onCommit(next, true);
              refresh();
            }}
          >
            Advance {seconds}s
          </button>
        ))}
        <button
          className="ns-button"
          onClick={() => {
            clearMac(runtime);
            clearNat(runtime);
            runtime.neighbors = [];
            runtime.addressBindings = [];
            runtime.dnsAnswers = [];
            runtime.frames = [];
            refresh();
          }}
        >
          Clear learned state
        </button>
      </div>
    </section>
  );
}
export function NeighborCachePanel({ device }: { device: Device }) {
  const { runtime, refresh } = useNetworkRuntime();
  const dns = runtime.dnsAnswers.filter((e) => e.device === device.id);
  const entries = runtime.addressBindings.filter((e) => e.device === device.id);
  return (
    <section className="ns-lifecycle" aria-label="Address resolution cache">
      <details>
        <summary>ARP and IPv6 neighbors ({entries.length})</summary>
        {entries.length ? (
          entries.map((e) => (
            <p key={e.port + e.family + e.address}>
              <strong>{e.address}</strong> ·{" "}
              {e.family === "ipv4" ? "ARP" : "NDP"}
              <br />
              {e.mac} · {device.ports.find((p) => p.id === e.port)?.name} ·{" "}
              {e.expires - runtime.time}s remaining
            </p>
          ))
        ) : (
          <p>No cached neighbors.</p>
        )}
        <button
          className="ns-button"
          disabled={!entries.length}
          onClick={() => {
            runtime.addressBindings = runtime.addressBindings.filter(
              (e) => e.device !== device.id,
            );
            refresh();
          }}
        >
          Clear neighbor cache
        </button>
      </details>
      <details>
        <summary>DNS resolver cache ({dns.length})</summary>
        {dns.length ? (
          dns.map((e) => (
            <p key={[e.server, e.name, e.type].join("/")}>
              <strong>{e.name}</strong> · {e.type} · {e.addresses.join(", ")}
              <br />
              Resolver {e.server} · {e.expires - runtime.time}s remaining
            </p>
          ))
        ) : (
          <p>No cached DNS answers.</p>
        )}
        <button
          className="ns-button"
          disabled={!dns.length}
          onClick={() => {
            flushDns(runtime, device.id);
            refresh();
          }}
        >
          Clear DNS cache
        </button>
      </details>
    </section>
  );
}
export function MacPanel({
  device,
  topology,
  onCommit,
}: {
  device: Device;
  topology: Topology;
  onCommit: (t: Topology) => void;
}) {
  const { runtime, refresh } = useNetworkRuntime();
  const [destination, setDestination] = useState("ff:ff:ff:ff:ff:ff"),
    [source, setSource] = useState(""),
    [sourceMac, setSourceMac] = useState(""),
    [error, setError] = useState("");
  const [agingError, setAgingError] = useState("");
  const sources = topology.devices.filter(isPacketEndpoint).flatMap((d) =>
      packetInterfaces(d).map((p) => ({
        id: JSON.stringify([d.id, p.id]),
        d,
        p,
      })),
    ),
    origin = sources.find((s) => s.id === source) ?? sources[0];
  const macs = runtime.mac.filter((e) => e.device === device.id);
  return (
    <section className="ns-lifecycle ns-stp" aria-label="MAC learning">
      <h3>MAC learning</h3>
      <p>
        VLAN scoped ·{" "}
        {device.macAgingSeconds === 0
          ? "Dynamic aging disabled"
          : `${device.macAgingSeconds ?? 300}s dynamic aging`}
      </p>
      <form
        key={device.macAgingSeconds ?? 300}
        onSubmit={(e) => {
          e.preventDefault();
          const n = Number(new FormData(e.currentTarget).get("aging"));
          if (
            !Number.isInteger(n) ||
            n < 0 ||
            (n > 0 && n < 10) ||
            n > 1000000
          ) {
            setAgingError("Use 0 to disable aging, or 10–1000000 seconds.");
            return;
          }
          setAgingError("");
          onCommit({
            ...topology,
            devices: topology.devices.map((d) =>
              d.id === device.id ? { ...d, macAgingSeconds: n } : d,
            ),
          });
        }}
      >
        <label>
          Aging seconds
          <input
            aria-label="MAC aging seconds"
            name="aging"
            type="number"
            min="0"
            max="1000000"
            required
            defaultValue={device.macAgingSeconds ?? 300}
          />
        </label>
        <button className="ns-button">Apply MAC aging</button>
      </form>
      {agingError && <p role="alert">{agingError}</p>}
      <button
        className="ns-button"
        onClick={() => {
          clearMac(runtime, device.id);
          refresh();
        }}
      >
        Clear MAC table
      </button>
      <div aria-label="Dynamic MAC table">
        {macs.length ? (
          macs.map((e) => (
            <p key={`${e.vlan}/${e.mac}`}>
              <strong>{e.mac.match(/.{4}/g)?.join(".")}</strong>
              <br />
              VLAN {e.vlan} · {device.ports.find((p) => p.id === e.port)?.name}{" "}
              · age {runtime.time - e.lastSeen}s
            </p>
          ))
        ) : (
          <p>No learned MAC addresses.</p>
        )}
      </div>
      <PortSecurityPanel
        device={device}
        topology={topology}
        onCommit={onCommit}
      />
      <StaticMacPanel device={device} topology={topology} onCommit={onCommit} />
      <details>
        <summary>Ethernet frame test</summary>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!origin) return;
            try {
              const results = transmitFrame(
                topology,
                { device: origin.d.id, port: origin.p.id },
                destination.replace(/[.:-]/g, "").toLowerCase(),
                runtime,
                sourceMac
                  ? sourceMac.toLowerCase().replace(/[.:-]/g, "")
                  : undefined,
              );
              setError(
                `Frame reached ${results.length} endpoint interface(s).`,
              );
              refresh();
            } catch (error) {
              setError(
                error instanceof Error ? error.message : "Invalid frame.",
              );
            }
          }}
        >
          <label>
            Frame source
            <select
              aria-label="Frame source"
              value={origin?.id ?? ""}
              onChange={(e) => setSource(e.target.value)}
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.d.name} / {s.p.name}
                </option>
              ))}
            </select>
          </label>
          <p>
            Source MAC:{" "}
            {origin ? interfaceMac(origin.d.id, origin.p.id) : "none"}
          </p>
          <label>
            Source MAC override (optional)
            <input
              aria-label="Frame source MAC override"
              value={sourceMac}
              onChange={(e) => setSourceMac(e.target.value)}
              maxLength={17}
            />
          </label>
          <label>
            Destination MAC
            <input
              aria-label="Frame destination MAC"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              maxLength={17}
            />
          </label>
          <button className="ns-button" disabled={!origin}>
            Send Ethernet frame
          </button>
        </form>
        <p role="status">{error}</p>
      </details>
      <details>
        <summary>Recent forwarding decisions</summary>
        <div aria-label="Ethernet forwarding decisions">
          {runtime.frames
            .filter((f) => f.device === device.id)
            .slice(-12)
            .reverse()
            .map((f, i) => (
              <p key={i}>
                {f.action} · VLAN {f.vlan}
                <br />
                {f.destination} ·{" "}
                {device.ports.find((p) => p.id === f.ingress)?.name} →{" "}
                {f.egress
                  .map((id) => device.ports.find((p) => p.id === id)?.name)
                  .join(", ") || "filtered"}
                {f.channelMembers?.map((selection) => (
                  <span
                    className="ns-channel-trace"
                    key={selection.channel + selection.link}
                  >
                    <br />
                    Selected member:{" "}
                    {
                      device.ports.find((p) => p.id === selection.channel)?.name
                    }{" "}
                    →{" "}
                    {device.ports.find((p) => p.id === selection.member)?.name}
                  </span>
                ))}
              </p>
            ))}
        </div>
      </details>
    </section>
  );
}
function StaticMacPanel({
  device,
  topology,
  onCommit,
}: {
  device: Device;
  topology: Topology;
  onCommit: (t: Topology) => void;
}) {
  const { runtime } = useNetworkRuntime();
  const [error, setError] = useState("");
  const save = (next: Device) => {
    const issue = configurationError(next);
    if (issue) {
      setError(issue);
      return;
    }
    onCommit({
      ...topology,
      devices: topology.devices.map((d) => (d.id === next.id ? next : d)),
    });
    setError("");
  };
  return (
    <details>
      <summary>Static MAC entries</summary>
      <div aria-label="Static MAC table">
        {device.staticMac?.map((e) => (
          <p key={`${e.vlan}/${e.mac}`}>
            {e.mac} · VLAN {e.vlan} ·{" "}
            {device.ports.find((p) => p.id === e.port)?.name}
            <button
              className="ns-link-button"
              onClick={() =>
                save({
                  ...device,
                  staticMac: device.staticMac?.filter(
                    (n) => n.mac !== e.mac || n.vlan !== e.vlan,
                  ),
                })
              }
            >
              Remove {e.mac}
            </button>
          </p>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const f = new FormData(event.currentTarget);
          save({
            ...device,
            staticMac: [
              ...(device.staticMac ?? []),
              {
                mac: String(f.get("mac")).replace(/[.:-]/g, "").toLowerCase(),
                vlan: Number(f.get("vlan")),
                port: String(f.get("port")),
              },
            ],
          });
        }}
      >
        <label>
          Static MAC
          <input
            aria-label="Static MAC address"
            name="mac"
            required
            maxLength={17}
          />
        </label>
        <label>
          VLAN
          <input
            aria-label="Static MAC VLAN"
            name="vlan"
            type="number"
            min="1"
            max="4094"
            required
            defaultValue="1"
          />
        </label>
        <label>
          Interface
          <select aria-label="Static MAC interface" name="port">
            {bridgePorts(topology, device, runtime)
              .filter((p) => !p.channelGroup)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        <button className="ns-button">Add static MAC</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
