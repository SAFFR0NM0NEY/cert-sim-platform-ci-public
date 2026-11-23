import { useState } from "react";
import type { Device, Port } from "./types.ts";
import {
  createSubinterface,
  createSvi,
  removeDeviceInterface,
} from "./vlanInterfaces.ts";
import { ensureSviVlan } from "./vlans.ts";

export function LogicalInterfaceControls({
  device,
  port,
  onChange,
  onSelect,
  onError,
}: {
  device: Device;
  port: Port;
  onChange: (device: Device) => void;
  onSelect: (id: string) => void;
  onError: (message: string) => void;
}) {
  const parents = device.ports.filter(
    (p) =>
      !p.virtual &&
      !p.channelGroup &&
      (p.media === "copper" || p.media === "fiber"),
  );
  const [parent, setParent] = useState(parents[0]?.id ?? "");
  const [number, setNumber] = useState(10);
  const [vlan, setVlan] = useState(10);
  const [native, setNative] = useState(false);
  const subinterface = device.kind === "router";
  const virtual = port.virtual;
  function add() {
    try {
      const nextDevice = subinterface ? device : ensureSviVlan(device, vlan);
      const next = subinterface
        ? createSubinterface(nextDevice, parent, number, vlan, native)
        : createSvi(nextDevice, vlan);
      onChange({ ...nextDevice, ports: [...nextDevice.ports, next] });
      onSelect(next.id);
      onError("");
    } catch (error) {
      onError(
        error instanceof Error ? error.message : "Could not add the interface.",
      );
    }
  }
  return (
    <section className="ns-logical-interfaces" aria-label="Logical interfaces">
      <details>
        <summary>
          Add {subinterface ? "subinterface" : "VLAN interface"}
        </summary>
        <div className="ns-logical-interface-fields">
          {subinterface && (
            <>
              <label>
                Parent interface
                <select
                  aria-label="Parent interface"
                  value={parent}
                  onChange={(event) => setParent(event.target.value)}
                >
                  {parents.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Subinterface number
                <input
                  type="number"
                  min={0}
                  max={4294967295}
                  value={number}
                  onChange={(event) => setNumber(+event.target.value)}
                />
              </label>
            </>
          )}
          <label>
            {subinterface ? "Encapsulation VLAN" : "SVI VLAN"}
            <input
              type="number"
              min={1}
              max={4094}
              value={vlan}
              onChange={(event) => setVlan(+event.target.value)}
            />
          </label>
          {subinterface && (
            <label className="ns-checkbox">
              <input
                type="checkbox"
                checked={native}
                onChange={(event) => setNative(event.target.checked)}
              />
              Native 802.1Q VLAN
            </label>
          )}
          <button type="button" className="ns-button" onClick={add}>
            Add interface
          </button>
        </div>
      </details>
      {virtual && (
        <>
          <p>
            {virtual.kind === "svi"
              ? "Switch VLAN interface"
              : virtual.kind === "portchannel"
                ? "Logical EtherChannel interface · Cables attach to physical members"
                : "Parent " +
                  device.ports.find((p) => p.id === virtual.parent)?.name}
          </p>
          {virtual.kind === "subinterface" && (
            <>
              <label>
                802.1Q VLAN
                <input
                  type="number"
                  min={1}
                  max={4094}
                  value={virtual.vlan ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...device,
                      ports: device.ports.map((p) =>
                        p.id === port.id
                          ? {
                              ...p,
                              virtual: {
                                ...virtual,
                                vlan: event.target.value
                                  ? +event.target.value
                                  : undefined,
                              },
                            }
                          : p,
                      ),
                    })
                  }
                />
              </label>
              <label className="ns-checkbox">
                <input
                  type="checkbox"
                  checked={virtual.native ?? false}
                  onChange={(event) =>
                    onChange({
                      ...device,
                      ports: device.ports.map((p) =>
                        p.id === port.id
                          ? {
                              ...p,
                              virtual: {
                                ...virtual,
                                native: event.target.checked,
                              },
                            }
                          : p,
                      ),
                    })
                  }
                />
                Native VLAN
              </label>
            </>
          )}
          <button
            type="button"
            className="ns-link-button ns-danger-text"
            onClick={() => {
              try {
                onChange(removeDeviceInterface(device, port.id));
                onSelect(device.ports[0].id);
                onError("");
              } catch (error) {
                onError(
                  error instanceof Error
                    ? error.message
                    : "Could not remove the interface.",
                );
              }
            }}
          >
            Remove interface
          </button>
        </>
      )}
    </section>
  );
}
