import { useState } from "react";
import type { Device, Topology } from "./types.ts";
import { discoveryEnabled, phoneVoiceVlan } from "./discovery.ts";
import { useNetworkRuntime } from "./RuntimePanels.tsx";

export function DiscoveryPanel({
  device,
  topology,
  onCommit,
}: {
  device: Device;
  topology: Topology;
  onCommit: (next: Topology, preserve?: boolean) => void;
}) {
  const { runtime } = useNetworkRuntime();
  const [selected, setSelected] = useState(device.ports[0].id);
  const ports =
    device.kind === "phone" ? device.ports.slice(0, 1) : device.ports.filter((p) => !p.virtual);
  const port = ports.find((p) => p.id === selected) ?? ports[0];
  const peers = runtime.neighbors.filter((n) => n.local.device === device.id);
  function change(edit: (d: Device) => void) {
    const next = structuredClone(topology);
    edit(next.devices.find((d) => d.id === device.id)!);
    onCommit(next, true);
  }
  return (
    <section className="ns-config" aria-label="Neighbor discovery">
      <h3>Neighbor discovery</h3>
      {(["cdp", "lldp"] as const).map((protocol) => (
        <label className="ns-checkbox" key={protocol}>
          <input
            type="checkbox"
            checked={discoveryEnabled(device, protocol)}
            onChange={(e) =>
              change((d) => {
                d[protocol] = e.target.checked;
              })
            }
          />
          {protocol.toUpperCase()} enabled
        </label>
      ))}
      <label>
        Discovery interface
        <select value={port.id} onChange={(e) => setSelected(e.target.value)}>
          {ports.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {(
        [
          ["cdp", "CDP on interface"],
          ["lldpTransmit", "LLDP transmit"],
          ["lldpReceive", "LLDP receive"],
        ] as const
      ).map(([key, label]) => (
        <label className="ns-checkbox" key={key}>
          <input
            type="checkbox"
            checked={port[key] !== false}
            onChange={(e) =>
              change((d) => {
                d.ports.find((p) => p.id === port.id)![key] = e.target.checked;
              })
            }
          />
          {label}
        </label>
      ))}
      {device.kind === "phone" && (
        <p>
          Voice traffic:{" "}
          {phoneVoiceVlan(topology, device, runtime) ?? "untagged"}
        </p>
      )}
      <div aria-label="Learned neighbors">
        {peers.length === 0 ? (
          <p>No advertisements received.</p>
        ) : (
          peers.map((n) => (
            <p key={n.local.port + n.protocol}>
              <strong>{n.name}</strong> · {n.protocol.toUpperCase()}
              <br />
              {device.ports.find((p) => p.id === n.local.port)?.name} →{" "}
              {n.interfaceName}
              <br />
              {n.address && n.address + " · "}Expires in{" "}
              {n.expires - runtime.time}s
              {n.voiceVlan && " · Voice VLAN " + n.voiceVlan}
            </p>
          ))
        )}
      </div>
    </section>
  );
}
