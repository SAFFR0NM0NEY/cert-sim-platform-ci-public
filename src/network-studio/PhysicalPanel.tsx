import { useEffect, useState } from "react";
import type { Link, Topology } from "./types.ts";
import {
  addLocation,
  parsePhysical,
  placeDevice,
  removeLocation,
  setCableLength,
} from "./physical.ts";
import { cableBudget, linkStatus } from "./model.ts";
import { DeviceIcon } from "./icons.tsx";
import { useNetworkRuntime } from "./RuntimePanels.tsx";
export function CableLengthControl({
  link,
  topology,
  onCommit,
}: {
  link: Link;
  topology: Topology;
  onCommit: (t: Topology) => void;
}) {
  const { runtime } = useNetworkRuntime();
  const [value, setValue] = useState(link.lengthMeters?.toString() ?? ""),
    [error, setError] = useState("");
  useEffect(() => {
    setValue(link.lengthMeters?.toString() ?? "");
    setError("");
  }, [link.id, link.lengthMeters]);
  const a = topology.devices.find((d) => d.id === link.a.device)?.name,
    b = topology.devices.find((d) => d.id === link.b.device)?.name;
  const status = linkStatus(topology, link, runtime);
  return (
    <form
      className="ns-cable-length"
      aria-label={`Cable length ${a} to ${b}`}
      onSubmit={(e) => {
        e.preventDefault();
        try {
          onCommit(
            setCableLength(
              topology,
              link.id,
              value === "" ? undefined : Number(value),
            ),
          );
          setError("");
        } catch (error) {
          setError(error instanceof Error ? error.message : "Invalid length.");
        }
      }}
    >
      <label>
        Cable length (metres)
        <input
          aria-label="Cable length (metres)"
          type="number"
          step="any"
          min={0}
          max={1000000}
          value={value}
          placeholder="Unmeasured"
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <button className="ns-button">Apply length</button>
      <p className={`ns-link-state ${status.up ? "" : "down"}`}>
        {status.reason}
      </p>
      <small>
        Generic {link.cable} profile · {cableBudget(link.cable)} m limit
      </small>
      {error && (
        <p role="alert" className="ns-error">
          {error}
        </p>
      )}
    </form>
  );
}
export function PhysicalPanel({
  topology,
  onCommit,
  onSelect,
}: {
  topology: Topology;
  onCommit: (t: Topology) => void;
  onSelect: (id: string) => void;
}) {
  const layout = topology.physical ?? { locations: [], placements: [] };
  const [locationId, setLocationId] = useState(""),
    [name, setName] = useState(""),
    [rename, setRename] = useState(""),
    [deviceId, setDeviceId] = useState(""),
    [unit, setUnit] = useState(0),
    [error, setError] = useState(""),
    [showEmpty, setShowEmpty] = useState(false);
  const current = layout.locations.find((l) => l.id === locationId),
    children = layout.locations.filter(
      (l) => l.parent === (current?.id ?? null),
    );
  useEffect(() => {
    setRename(current?.name ?? "");
    setError("");
  }, [current?.id, current?.name]);
  const breadcrumbs = [];
  let ancestor = current;
  for (let i = 0; ancestor && i < 3; i++) {
    breadcrumbs.unshift(ancestor);
    ancestor = layout.locations.find((l) => l.id === ancestor!.parent);
  }
  const placements = layout.placements.filter(
      (p) => p.location === current?.id,
    ),
    available = topology.devices.filter(
      (d) => !placements.some((p) => p.device === d.id),
    );
  const chosenDevice = available.find((d) => d.id === deviceId) ?? available[0];
  const action = (callback: () => Topology) => {
    try {
      onCommit(callback());
      setError("");
      return true;
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Invalid physical configuration.",
      );
      return false;
    }
  };
  const inspect = (id: string) => {
    onSelect(id);
  };
  return (
    <section className="ns-physical-panel" aria-label="Physical workspace">
      <nav aria-label="Physical location path">
        <button className="ns-link-button" onClick={() => setLocationId("")}>
          World
        </button>
        {breadcrumbs.map((l) => (
          <span key={l.id}>
            {" "}
            /{" "}
            <button
              className="ns-link-button"
              onClick={() => setLocationId(l.id)}
            >
              {l.name}
            </button>
          </span>
        ))}
      </nav>
      <div className="ns-physical-title">
        <div>
          <span className="ns-eyebrow">
            {current?.kind ?? "PHYSICAL WORKSPACE"}
          </span>
          <h2>{current?.name ?? "Build your campus"}</h2>
        </div>
        <span>
          {current?.kind === "closet"
            ? `${placements.length} devices`
            : `${children.length} locations`}
        </span>
      </div>
      {current && (
        <form
          className="ns-location-edit"
          onSubmit={(e) => {
            e.preventDefault();
            action(() => ({
              ...topology,
              physical: parsePhysical(
                {
                  ...layout,
                  locations: layout.locations.map((l) =>
                    l.id === current.id ? { ...l, name: rename } : l,
                  ),
                },
                topology.devices,
              ),
            }));
          }}
        >
          <label>
            Location display name
            <input
              value={rename}
              maxLength={64}
              required
              onChange={(e) => setRename(e.target.value)}
            />
          </label>
          <button className="ns-button">Rename location</button>
          <button
            type="button"
            className="ns-button ns-danger-text"
            disabled={!!children.length || !!placements.length}
            title="Remove devices and child locations first"
            onClick={() => {
              const parent = current.parent;
              if (action(() => removeLocation(topology, current.id)))
                setLocationId(parent ?? "");
            }}
          >
            Remove location
          </button>
        </form>
      )}
      {current?.kind !== "closet" && (
        <>
          <div className="ns-location-grid">
            {children.map((l) => (
              <button
                className="ns-location-card"
                aria-label={`Open ${l.name}`}
                key={l.id}
                onClick={() => setLocationId(l.id)}
              >
                <span aria-hidden="true">
                  {l.kind === "city" ? "◈" : l.kind === "building" ? "▥" : "▤"}
                </span>
                <strong>{l.name}</strong>
                <small>{l.kind} →</small>
              </button>
            ))}
          </div>
          <form
            className="ns-location-edit"
            onSubmit={(e) => {
              e.preventDefault();
              try {
                const next = addLocation(topology, name, current?.id ?? null);
                onCommit(next);
                setLocationId(
                  next.physical!.locations[next.physical!.locations.length - 1]
                    .id,
                );
                setName("");
                setError("");
              } catch (error) {
                setError(
                  error instanceof Error ? error.message : "Invalid location.",
                );
              }
            }}
          >
            <label>
              New{" "}
              {current?.kind === "city"
                ? "building"
                : current?.kind === "building"
                  ? "closet"
                  : "city"}{" "}
              name
              <input
                aria-label="New location name"
                value={name}
                maxLength={64}
                required
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <button
              className="ns-button ns-primary"
              disabled={layout.locations.length >= 64}
            >
              Add location
            </button>
          </form>
        </>
      )}
      {current?.kind === "closet" && (
        <>
          <form
            className="ns-location-edit"
            onSubmit={(e) => {
              e.preventDefault();
              if (chosenDevice)
                action(() =>
                  placeDevice(topology, chosenDevice.id, current.id, unit),
                );
            }}
          >
            <label>
              Device to place
              <select
                aria-label="Device to place"
                value={chosenDevice?.id ?? ""}
                onChange={(e) => setDeviceId(e.target.value)}
              >
                {available.length ? (
                  available.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name} ·{" "}
                      {layout.locations.find(
                        (l) =>
                          l.id ===
                          layout.placements.find((p) => p.device === d.id)
                            ?.location,
                      )?.name ?? "unassigned"}
                    </option>
                  ))
                ) : (
                  <option value="">All devices placed here</option>
                )}
              </select>
            </label>
            <label>
              Rack unit
              <input
                aria-label="Rack unit"
                type="number"
                min={0}
                max={42}
                value={unit}
                onChange={(e) => setUnit(+e.target.value)}
              />
            </label>
            <button className="ns-button ns-primary" disabled={!chosenDevice}>
              Place device
            </button>
          </form>
          <p className="ns-panel-note">
            U1–U42 use one generic slot each. Unit 0 places a device on the
            floor. Placing a device here moves it from its previous location.
          </p>
          <label className="ns-checkbox">
            <input
              type="checkbox"
              checked={showEmpty}
              onChange={(e) => setShowEmpty(e.target.checked)}
            />
            Show empty rack units
          </label>
          <div className="ns-rack" aria-label="Wiring closet rack">
            {Array.from({ length: 42 }, (_, i) => 42 - i)
              .filter(
                (unit) => showEmpty || placements.some((p) => p.unit === unit),
              )
              .map((unit) => {
                const placement = placements.find((p) => p.unit === unit),
                  device = topology.devices.find(
                    (d) => d.id === placement?.device,
                  );
                return (
                  <div className="ns-rack-row" key={unit}>
                    <span>U{unit}</span>
                    {device ? (
                      <>
                        <button
                          className="ns-physical-device"
                          aria-label={`Inspect ${device.name}`}
                          onClick={() => inspect(device.id)}
                        >
                          <DeviceIcon kind={device.kind} size={25} />
                          <strong>{device.name}</strong>
                          <small>{device.powered ? "On" : "Off"}</small>
                        </button>
                        <button
                          className="ns-icon-button"
                          aria-label={`Unplace ${device.name}`}
                          onClick={() =>
                            onCommit({
                              ...topology,
                              physical: {
                                ...layout,
                                placements: layout.placements.filter(
                                  (p) => p.device !== device.id,
                                ),
                              },
                            })
                          }
                        >
                          ×
                        </button>
                      </>
                    ) : (
                      <small>Available</small>
                    )}
                  </div>
                );
              })}
            {!placements.some((p) => p.unit > 0) && !showEmpty && (
              <p className="ns-panel-note">
                The rack is empty. Place a device in U1–U42 to begin.
              </p>
            )}
          </div>
          <h3>Floor devices</h3>
          <div className="ns-floor-devices">
            {placements
              .filter((p) => p.unit === 0)
              .map((p) => {
                const d = topology.devices.find((d) => d.id === p.device)!;
                return (
                  <div key={d.id}>
                    <button
                      className="ns-physical-device"
                      aria-label={`Inspect ${d.name}`}
                      onClick={() => inspect(d.id)}
                    >
                      <DeviceIcon kind={d.kind} size={26} />
                      <strong>{d.name}</strong>
                    </button>
                    <button
                      className="ns-icon-button"
                      aria-label={`Unplace ${d.name}`}
                      onClick={() =>
                        onCommit({
                          ...topology,
                          physical: {
                            ...layout,
                            placements: layout.placements.filter(
                              (p) => p.device !== d.id,
                            ),
                          },
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                );
              })}
          </div>
        </>
      )}
      {error && (
        <p className="ns-error" role="alert">
          {error}
        </p>
      )}
      <details className="ns-physical-cables">
        <summary>Measured cabling · {topology.links.length} links</summary>
        <p className="ns-panel-note">
          Cable budgets affect the logical network. Lengths are entered
          manually; rack positions do not infer cable distance.
        </p>
        {topology.links.map((link) => (
          <fieldset className="ns-route" key={link.id}>
            <legend>
              {topology.devices.find((d) => d.id === link.a.device)?.name} ↔{" "}
              {topology.devices.find((d) => d.id === link.b.device)?.name}
            </legend>
            <CableLengthControl
              link={link}
              topology={topology}
              onCommit={onCommit}
            />
          </fieldset>
        ))}
      </details>
      <p className="ns-panel-note">
        {
          topology.devices.filter(
            (d) => !layout.placements.some((p) => p.device === d.id),
          ).length
        }{" "}
        devices are not assigned to a physical location. Placement does not
        change device identity or configuration.
      </p>
    </section>
  );
}
