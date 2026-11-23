import { useState } from "react";
import { changeModule, moduleSlots, type ModuleSlot } from "./hardware.ts";
import type { Cable, Device, Topology } from "./types.ts";

export function HardwarePanel({
  device,
  topology,
  onCommit,
}: {
  device: Device;
  topology: Topology;
  onCommit: (t: Topology) => void;
}) {
  const [error, setError] = useState("");
  function change(slot: ModuleSlot, media: Cable | null) {
    try {
      const next = changeModule(topology, device.id, slot, media);
      setError("");
      onCommit(next);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Module change failed.",
      );
    }
  }
  return (
    <section className="ns-config" aria-label="Device hardware">
      <h3>Interface expansion slots</h3>
      <button
        className="ns-button"
        onClick={() => {
          setError("");
          onCommit({
            ...topology,
            devices: topology.devices.map((d) =>
              d.id === device.id ? { ...d, powered: !d.powered } : d,
            ),
          });
        }}
      >
        {device.powered ? "Power off device" : "Power on device"}
      </button>
      {device.powered && <p>Power off to install or remove modules.</p>}
      {moduleSlots.map((slot) => {
        const port = device.ports.find((p) => p.slot === slot);
        return (
          <fieldset className="ns-route" key={slot}>
            <legend>Expansion slot {slot}</legend>
            {port ? (
              <>
                <p>
                  {port.name} ·{" "}
                  {port.media === "serial"
                    ? "Serial WAN"
                    : port.media === "fiber"
                      ? "Fiber Ethernet"
                      : "Copper Ethernet"}
                </p>
                <button
                  className="ns-button"
                  disabled={device.powered}
                  onClick={() => change(slot, null)}
                >
                  Remove module
                </button>
              </>
            ) : (
              <form
                className="ns-config"
                onSubmit={(e) => {
                  e.preventDefault();
                  change(
                    slot,
                    new FormData(e.currentTarget).get("media") as Cable,
                  );
                }}
              >
                <label>
                  Interface module
                  <select
                    name="media"
                    aria-label={"Module for slot " + slot}
                    disabled={device.powered}
                  >
                    <option value="copper">Copper Ethernet</option>
                    <option value="fiber">Fiber Ethernet</option>
                    {device.kind === "router" && (
                      <option value="serial">Serial WAN</option>
                    )}
                  </select>
                </label>
                <button className="ns-button" disabled={device.powered}>
                  Install module
                </button>
              </form>
            )}
          </fieldset>
        );
      })}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
