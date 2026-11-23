import { useEffect, useState } from "react";
import type { Device, Port, Topology } from "./types.ts";
import {
  channelState,
  createPortChannel,
  reconcilePortChannels,
  removeChannelGroup,
  selectChannelMember,
  setChannelGroup,
} from "./etherChannel.ts";
import { configurationError } from "./engine.ts";
import { devicePdus, removeDeviceInterface } from "./vlanInterfaces.ts";
import { useNetworkRuntime } from "./RuntimePanels.tsx";
import { SwitchportStatus } from "./SwitchportStatus.tsx";

type Mode = NonNullable<Port["channelGroup"]>["mode"];
const modes: [Mode, string][] = [
  ["active", "LACP active"],
  ["passive", "LACP passive"],
  ["desirable", "PAgP desirable"],
  ["auto", "PAgP auto"],
  ["on", "Static on"],
];

export function EtherChannelPanel({
  device,
  topology,
  onCommit,
  onConfigure,
}: {
  device: Device;
  topology: Topology;
  onCommit: (topology: Topology) => void;
  onConfigure: (port: string) => void;
}) {
  const { runtime } = useNetworkRuntime();
  const [draft, setDraft] = useState(device);
  const [group, setGroup] = useState(1);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(device);
    setError("");
  }, [device]);
  const groups = draft.ports.filter((p) => p.virtual?.kind === "portchannel");
  const physical = draft.ports.filter(
    (p) => !p.virtual && ["copper", "fiber"].includes(p.media),
  );
  function change(action: () => Device) {
    try {
      setDraft(action());
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not change the channel.",
      );
    }
  }
  function membership(port: Port, id: number, mode: Mode) {
    setDraft({
      ...draft,
      ports: draft.ports.map((p) =>
        p.id === port.id
          ? { ...p, channelGroup: id ? { id, mode } : undefined }
          : p,
      ),
    });
  }
  return (
    <section className="ns-config ns-etherchannel" aria-label="EtherChannel">
      <h3>EtherChannel</h3>
      <p>
        Combine physical links into one logical interface. Configure VLANs or
        routing on the Port-channel; keep cables on its members.
      </p>
      <div className="ns-vlan-add">
        <label>
          New channel group
          <input
            aria-label="New channel group"
            type="number"
            min={1}
            max={6}
            value={group}
            onChange={(e) => setGroup(+e.target.value)}
          />
        </label>
        <button
          type="button"
          className="ns-button"
          onClick={() =>
            change(() => ({
              ...draft,
              ports: [...draft.ports, createPortChannel(draft, group)],
            }))
          }
        >
          Add Port-channel
        </button>
      </div>
      {groups.length === 0 && <p>No Port-channels configured.</p>}
      {groups.map((port) => {
        if (port.virtual?.kind !== "portchannel") return null;
        const channel = port.virtual.group;
        const saved = device.ports.find((p) => p.id === port.id);
        const state = saved
          ? channelState(topology, device.id, channel, runtime)
          : undefined;
        const members = draft.ports.filter(
          (p) => p.channelGroup?.id === channel,
        );
        return (
          <article
            className="ns-channel-card"
            key={port.id}
            aria-label={port.name + " channel"}
          >
            <div className="ns-channel-heading">
              <strong>{port.name}</strong>
              <span>{port.routed ? "Routed" : "Layer 2"}</span>
            </div>
            <div aria-label={port.name + " status"}>
              <p>
                {state
                  ? `${state.up ? "Up" : "Down"} · ${state.protocol === "on" ? "Static" : (state.protocol?.toUpperCase() ?? "No protocol")} · ${state.members.filter((m) => m.status === "bundled").length} bundled`
                  : "Apply to activate this interface"}
              </p>
              {state?.members.map((member) => {
                const peer = topology.devices.find(
                  (d) => d.id === member.peer?.device,
                );
                return (
                  <p key={member.port}>
                    <strong>
                      {device.ports.find((p) => p.id === member.port)?.name}
                    </strong>{" "}
                    · {member.status}
                    <br />
                    {member.reason}
                    {peer &&
                      ` · Peer: ${peer.name} / ${peer.ports.find((p) => p.id === member.peer?.port)?.name ?? member.peer?.port}`}
                  </p>
                );
              })}
            </div>
            <p>
              {members.length} configured member
              {members.length === 1 ? "" : "s"}. Status reflects the applied
              configuration.
            </p>
            {saved && !saved.routed && (
              <SwitchportStatus
                device={device}
                port={saved}
                topology={topology}
              />
            )}
            {saved && (
              <ChannelHashPreview
                device={device}
                topology={topology}
                port={saved}
              />
            )}
            <div className="ns-actions">
              <button
                type="button"
                className="ns-button"
                disabled={
                  !saved || JSON.stringify(draft) !== JSON.stringify(device)
                }
                onClick={() => onConfigure(port.id)}
              >
                Configure {port.name}
              </button>
              <button
                type="button"
                className="ns-link-button ns-danger-text"
                onClick={() =>
                  change(() => removeDeviceInterface(draft, port.id))
                }
              >
                Remove {port.name}
              </button>
            </div>
          </article>
        );
      })}
      <details className="ns-channel-members" open>
        <summary>Physical members</summary>
        <p>
          At least one LACP peer must be active, or one PAgP peer desirable.
          Configure a new Port-channel before adding members with different VLAN
          or routing settings. A detached member keeps its cable.
        </p>
        {physical.map((port) => (
          <fieldset className="ns-channel-card" key={port.id}>
            <legend>{port.name}</legend>
            <label>
              Channel group
              <select
                aria-label={"Channel group " + port.name}
                value={port.channelGroup?.id ?? 0}
                onChange={(e) =>
                  membership(
                    port,
                    +e.target.value,
                    port.channelGroup?.mode ?? "active",
                  )
                }
              >
                <option value={0}>Unassigned</option>
                {groups.map(
                  (p) =>
                    p.virtual?.kind === "portchannel" && (
                      <option key={p.id} value={p.virtual.group}>
                        {p.name}
                      </option>
                    ),
                )}
              </select>
            </label>
            <label>
              Negotiation mode
              <select
                aria-label={"Channel mode " + port.name}
                disabled={!port.channelGroup}
                value={port.channelGroup?.mode ?? "active"}
                onChange={(e) =>
                  membership(
                    port,
                    port.channelGroup!.id,
                    e.target.value as Mode,
                  )
                }
              >
                {modes.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Protocol restriction
              <select
                aria-label={"Channel protocol " + port.name}
                value={port.channelProtocol ?? ""}
                onChange={(e) =>
                  change(() => ({
                    ...draft,
                    ports: draft.ports.map((p) =>
                      p.id === port.id
                        ? {
                            ...p,
                            channelProtocol: (e.target.value ||
                              undefined) as Port["channelProtocol"],
                          }
                        : p,
                    ),
                  }))
                }
              >
                <option value="">From negotiation mode</option>
                <option value="lacp">LACP only</option>
                <option value="pagp">PAgP only</option>
              </select>
            </label>
          </fieldset>
        ))}
      </details>
      <label>
        Load balancing
        <select
          aria-label="EtherChannel load balancing"
          value={draft.etherChannelLoadBalance ?? "src-mac"}
          onChange={(e) =>
            setDraft({
              ...draft,
              etherChannelLoadBalance: e.target
                .value as Device["etherChannelLoadBalance"],
            })
          }
        >
          <option value="src-mac">Source MAC</option>
          <option value="dst-mac">Destination MAC</option>
          <option value="src-dst-mac">Source and destination MAC</option>
        </select>
      </label>
      <p>
        Each frame selects one available member using the configured MAC hash. A
        failed member is removed from selection; remaining members carry
        traffic. This does not multiply one flow’s bandwidth.
      </p>
      {error && (
        <p className="ns-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="ns-button ns-button-primary"
        onClick={() => {
          try {
            const changed = physical.filter(
              (p) =>
                JSON.stringify(p.channelGroup) !==
                JSON.stringify(
                  device.ports.find((old) => old.id === p.id)?.channelGroup,
                ),
            );
            let next = changed.length
              ? removeChannelGroup(
                  draft,
                  changed.map((p) => p.id),
                )
              : draft;
            for (const p of changed)
              if (p.channelGroup)
                next = setChannelGroup(
                  next,
                  [p.id],
                  p.channelGroup.id,
                  p.channelGroup.mode,
                );
            next = reconcilePortChannels(device, next);
            const issue = configurationError(next);
            if (issue) throw Error(issue);
            onCommit({
              ...topology,
              devices: topology.devices.map((d) =>
                d.id === device.id ? next : d,
              ),
              ...(topology.pdus && { pdus: devicePdus(topology, next) }),
            });
            setError("");
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : "Could not apply EtherChannel.",
            );
          }
        }}
      >
        Apply EtherChannel
      </button>
    </section>
  );
}

function ChannelHashPreview({
  device,
  topology,
  port,
}: {
  device: Device;
  topology: Topology;
  port: Port;
}) {
  const { runtime } = useNetworkRuntime();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState("02:00:00:00:00:01");
  const [destination, setDestination] = useState("02:00:00:00:00:02");
  const normalize = (mac: string) => mac.replace(/[.:-]/g, "").toLowerCase();
  const valid = [source, destination].every((mac) =>
    /^[0-9a-f]{12}$/.test(normalize(mac)),
  );
  const selected =
    open && valid
      ? selectChannelMember(
          topology,
          device.id,
          port.id,
          normalize(source),
          normalize(destination),
          runtime,
        )
      : undefined;
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Preview member selection</summary>
      <label>
        Source MAC
        <input
          aria-label={port.name + " hash source MAC"}
          maxLength={17}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
      </label>
      <label>
        Destination MAC
        <input
          aria-label={port.name + " hash destination MAC"}
          maxLength={17}
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
        />
      </label>
      <p aria-label={port.name + " selected member"}>
        {!valid
          ? "Enter two valid MAC addresses."
          : selected
            ? `Selected member: ${device.ports.find((p) => p.id === selected.local.port)?.name} · Applied policy: ${device.etherChannelLoadBalance ?? "src-mac"}`
            : "No bundled member is available."}
      </p>
      <p>
        Preview only. No frame is sent; selection uses the currently applied
        configuration.
      </p>
    </details>
  );
}
