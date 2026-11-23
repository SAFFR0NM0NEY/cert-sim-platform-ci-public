import { useEffect, useState } from "react";
import type { Device, Topology } from "./types.ts";
import { configurationError } from "./engine.ts";
import { isSwitchport } from "./vlanInterfaces.ts";
import { switchportState } from "./dtp.ts";
import { useNetworkRuntime } from "./RuntimePanels.tsx";
import {
  defaultVtp,
  deleteVlan,
  materializeVlans,
  setVlan,
  setVtp,
  vlanDatabase,
  vlanMutable,
} from "./vlans.ts";

export function VlansPanel({
  device,
  topology,
  onCommit,
}: {
  device: Device;
  topology: Topology;
  onCommit: (next: Topology) => void;
}) {
  const { runtime } = useNetworkRuntime();
  const [rows, setRows] = useState(() => vlanDatabase(device));
  const [vtp, setVtpDraft] = useState(() => device.vtp ?? defaultVtp());
  const [newId, setNewId] = useState(10);
  const [error, setError] = useState("");
  useEffect(() => {
    setRows(vlanDatabase(device));
    setVtpDraft(device.vtp ?? defaultVtp());
    setError("");
  }, [device]);
  const currentVtp = device.vtp ?? defaultVtp();
  const client = currentVtp.mode === "client";
  function save(next: Device) {
    const issue = configurationError(next);
    if (issue) throw Error(issue);
    onCommit({
      ...topology,
      devices: topology.devices.map((d) => (d.id === device.id ? next : d)),
    });
    setError("");
  }
  function attempt(action: () => void) {
    try {
      action();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not update VLAN settings.",
      );
    }
  }
  return (
    <section className="ns-vlans-panel" aria-label="VLAN management">
      <form
        className="ns-config ns-vlan-form"
        onSubmit={(event) => {
          event.preventDefault();
          attempt(() => {
            let next = materializeVlans(device);
            for (const original of vlanDatabase(device))
              if (!rows.some((row) => row.id === original.id))
                next = deleteVlan(next, original.id);
            for (const row of rows) {
              const original = vlanDatabase(next).find(
                (entry) => entry.id === row.id,
              );
              if (
                !original ||
                row.name !== original.name ||
                row.state !== original.state
              )
                next = setVlan(next, row.id, {
                  name: row.name,
                  state: row.state,
                });
            }
            save(next);
          });
        }}
      >
        <h3>VLAN database</h3>
        {client && <p>VLANs are managed by the VTP server.</p>}
        <div className="ns-vlan-list" role="list" aria-label="Configured VLANs">
          {rows.map((row) => {
            const editable = vlanMutable(device, row.id);
            const members = device.ports.filter(
              (p) =>
                isSwitchport(device, p) &&
                !p.channelGroup &&
                ((switchportState(topology, device.id, p.id, runtime).mode ===
                  "access" &&
                  p.vlan === row.id) ||
                  p.voiceVlan === row.id),
            );
            return (
              <fieldset
                className="ns-route"
                key={row.id}
                role="listitem"
                aria-label={"VLAN " + row.id}
              >
                <legend>VLAN {row.id}</legend>
                <label>
                  Name
                  <input
                    aria-label={"VLAN " + row.id + " name"}
                    value={row.name}
                    disabled={!editable}
                    maxLength={32}
                    onChange={(event) =>
                      setRows(
                        rows.map((entry) =>
                          entry.id === row.id
                            ? { ...entry, name: event.target.value }
                            : entry,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  State
                  <select
                    aria-label={"VLAN " + row.id + " state"}
                    value={row.state}
                    disabled={!editable}
                    onChange={(event) =>
                      setRows(
                        rows.map((entry) =>
                          entry.id === row.id
                            ? {
                                ...entry,
                                state: event.target.value as typeof row.state,
                              }
                            : entry,
                        ),
                      )
                    }
                  >
                    <option value="active">Active</option>
                    <option value="suspended">Suspended</option>
                  </select>
                </label>
                {members.length > 0 && (
                  <p className="ns-vlan-members">
                    Member ports ·{" "}
                    {members
                      .map(
                        (p) =>
                          p.name + (p.voiceVlan === row.id ? " (voice)" : ""),
                      )
                      .join(", ")}
                  </p>
                )}
                {editable && (
                  <button
                    type="button"
                    className="ns-link-button ns-danger-text"
                    aria-label={"Delete VLAN " + row.id}
                    onClick={() =>
                      setRows(rows.filter((entry) => entry.id !== row.id))
                    }
                  >
                    Delete VLAN
                  </button>
                )}
              </fieldset>
            );
          })}
        </div>
        {!client && (
          <div className="ns-vlan-add">
            <label>
              New VLAN ID
              <input
                type="number"
                min={2}
                max={4094}
                value={newId}
                onChange={(event) => setNewId(+event.target.value)}
              />
            </label>
            <button
              type="button"
              className="ns-button"
              onClick={() =>
                attempt(() => {
                  if (rows.some((row) => row.id === newId))
                    throw Error("That VLAN already exists.");
                  setRows(
                    vlanDatabase(
                      setVlan({ ...device, vlans: rows }, newId, {}),
                    ),
                  );
                  setError("");
                })
              }
            >
              Add VLAN
            </button>
          </div>
        )}
        <button className="ns-button ns-primary" disabled={client}>
          Apply VLANs
        </button>
      </form>
      <form
        className="ns-config ns-vlan-form"
        aria-label="VTP settings"
        onSubmit={(event) => {
          event.preventDefault();
          attempt(() =>
            save(
              setVtp(device, {
                mode: vtp.mode,
                domain: vtp.domain,
                version: vtp.version,
                password: vtp.password,
              }),
            ),
          );
        }}
      >
        <h3>VTP</h3>
        <p aria-label="VTP status">
          Configuration revision {currentVtp.revision} · {currentVtp.mode} ·{" "}
          {currentVtp.domain || "No domain"}
        </p>
        <label>
          Mode
          <select
            aria-label="VTP mode"
            value={vtp.mode}
            onChange={(event) =>
              setVtpDraft({
                ...vtp,
                mode: event.target.value as typeof vtp.mode,
              })
            }
          >
            <option value="server">Server</option>
            <option value="client">Client</option>
            <option value="transparent">Transparent</option>
          </select>
        </label>
        <label>
          Domain
          <input
            aria-label="VTP domain"
            value={vtp.domain}
            maxLength={32}
            onChange={(event) =>
              setVtpDraft({ ...vtp, domain: event.target.value })
            }
          />
        </label>
        <label>
          Version
          <select
            aria-label="VTP version"
            value={vtp.version}
            onChange={(event) =>
              setVtpDraft({
                ...vtp,
                version: Number(event.target.value) as 1 | 2,
              })
            }
          >
            <option value={1}>1</option>
            <option value={2}>2</option>
          </select>
        </label>
        <label>
          Password
          <input
            aria-label="VTP password"
            type="password"
            autoComplete="off"
            value={vtp.password ?? ""}
            maxLength={64}
            onChange={(event) =>
              setVtpDraft({ ...vtp, password: event.target.value || undefined })
            }
          />
        </label>
        <button className="ns-button ns-primary">Apply VTP</button>
      </form>
      {error && (
        <p className="ns-error ns-vlan-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
