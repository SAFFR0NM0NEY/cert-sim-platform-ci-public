import { useEffect, useState } from "react";
import type { Device, Topology } from "./types.ts";
import { configurationError } from "./engine.ts";
import { packetInterfaces } from "./vlanInterfaces.ts";
export function IPv6Panel({
  device,
  topology,
  onCommit,
}: {
  device: Device;
  topology: Topology;
  onCommit: (t: Topology) => void;
}) {
  const [draft, setDraft] = useState(device),
    [portId, setPortId] = useState(device.ports[0].id),
    [error, setError] = useState("");
  useEffect(() => {
    setDraft(device);
    setError("");
  }, [device]);
  const ports = packetInterfaces(draft);
  const port = ports.find((p) => p.id === portId) ?? ports[0];
  if (!port)
    return (
      <p className="ns-panel-note">
        Configure a routed port or VLAN interface in Config to assign IPv6
        addressing.
      </p>
    );
  return (
    <form
      className="ns-config ns-advanced-config"
      aria-label="IPv6 configuration"
      onSubmit={(e) => {
        e.preventDefault();
        const error = configurationError(draft);
        setError(error ?? "");
        if (!error)
          onCommit({
            ...topology,
            devices: topology.devices.map((d) =>
              d.id === device.id ? draft : d,
            ),
          });
      }}
    >
      <h3>IPv6 interfaces</h3>
      <label>
        IPv6 interface
        <select
          aria-label="IPv6 interface"
          value={port.id}
          onChange={(e) => setPortId(e.target.value)}
        >
          {ports.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        IPv6 address
        <input
          aria-label="Interface IPv6 address"
          value={port.ipv6 ?? ""}
          maxLength={45}
          placeholder="2001:db8:10::10"
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              ports: d.ports.map((p) =>
                p.id === port.id ? { ...p, ipv6: e.target.value } : p,
              ),
            }))
          }
        />
      </label>
      <label>
        IPv6 prefix length
        <input
          type="number"
          min={1}
          max={128}
          value={port.prefix6 ?? 64}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              ports: d.ports.map((p) =>
                p.id === port.id ? { ...p, prefix6: +e.target.value } : p,
              ),
            }))
          }
        />
      </label>
      {device.kind !== "router" && device.kind !== "switch" ? (
        <label>
          IPv6 default gateway
          <input
            value={draft.gateway6 ?? ""}
            maxLength={45}
            onChange={(e) =>
              setDraft((d) => ({ ...d, gateway6: e.target.value }))
            }
          />
        </label>
      ) : (
        <>
          <label className="ns-checkbox">
            <input
              type="checkbox"
              checked={draft.ipv6Routing ?? false}
              onChange={(e) =>
                setDraft((d) => ({ ...d, ipv6Routing: e.target.checked }))
              }
            />
            Enable IPv6 forwarding
          </label>
          <h3>Static IPv6 routes</h3>
          {(draft.routes6 ?? []).map((r, i) => (
            <fieldset className="ns-route" key={i}>
              <legend>IPv6 route {i + 1}</legend>
              <label>
                IPv6 network
                <input
                  value={r.network}
                  maxLength={45}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      routes6: d.routes6!.map((v, j) =>
                        j === i ? { ...v, network: e.target.value } : v,
                      ),
                    }))
                  }
                />
              </label>
              <label>
                IPv6 route prefix
                <input
                  type="number"
                  min={0}
                  max={128}
                  value={r.prefix}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      routes6: d.routes6!.map((v, j) =>
                        j === i ? { ...v, prefix: +e.target.value } : v,
                      ),
                    }))
                  }
                />
              </label>
              <label>
                IPv6 next hop
                <input
                  value={r.nextHop}
                  maxLength={45}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      routes6: d.routes6!.map((v, j) =>
                        j === i ? { ...v, nextHop: e.target.value } : v,
                      ),
                    }))
                  }
                />
              </label>
              <label>
                IPv6 route interface
                <select
                  aria-label="IPv6 route interface"
                  value={r.interface ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      routes6: d.routes6!.map((v, j) =>
                        j === i ? { ...v, interface: e.target.value } : v,
                      ),
                    }))
                  }
                >
                  <option value="">Automatic</option>
                  {ports.map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="ns-link-button ns-danger-text"
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    routes6: d.routes6!.filter((_, j) => j !== i),
                  }))
                }
              >
                Remove IPv6 route
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            className="ns-button"
            disabled={(draft.routes6?.length ?? 0) >= 128}
            onClick={() =>
              setDraft((d) => ({
                ...d,
                routes6: [
                  ...(d.routes6 ?? []),
                  { network: "::", prefix: 0, nextHop: "" },
                ],
              }))
            }
          >
            + Add IPv6 route
          </button>
        </>
      )}
      <p className="ns-panel-note">
        Static unicast routing and neighbor discovery. SLAAC, DHCPv6, dynamic
        IPv6 routing and IPv6 ACLs are not yet modeled. IPv4 ACLs do not apply
        to IPv6.
      </p>
      {error && (
        <p className="ns-error" role="alert">
          {error}
        </p>
      )}
      <button className="ns-button ns-primary">Apply IPv6 configuration</button>
    </form>
  );
}
