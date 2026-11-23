import type { Device, Port, Topology } from "./types.ts";
import { switchportState } from "./dtp.ts";
import { useNetworkRuntime } from "./RuntimePanels.tsx";

const labels = {
  access: "Access",
  trunk: "Trunk",
  "dynamic-auto": "Dynamic auto",
  "dynamic-desirable": "Dynamic desirable",
  down: "Down",
  routed: "Routed",
};

export function SwitchportStatus({
  device,
  port,
  topology,
}: {
  device: Device;
  port: Port;
  topology: Topology;
}) {
  const { runtime } = useNetworkRuntime();
  const state = switchportState(topology, device.id, port.id, runtime);
  const peer = topology.devices.find((d) => d.id === state.peer?.device);
  const peerPort = peer?.ports.find((p) => p.id === state.peer?.port);
  return (
    <section
      className="ns-switchport-status"
      aria-label={port.name + " switchport status"}
    >
      <div className="ns-channel-heading">
        <strong>Switchport status</strong>
        <span>{labels[state.operational]}</span>
      </div>
      <p>
        Applied mode: {labels[state.administrative]} · DTP{" "}
        {state.negotiation ? "on" : "off"}
      </p>
      {peer && (
        <p>
          Peer: {peer.name} / {peerPort?.name ?? state.peer?.port}
        </p>
      )}
      <p>{state.reason}</p>
    </section>
  );
}
