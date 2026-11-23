import { useEffect, useState } from "react";
import type { Device, NatConfig, Topology } from "./types.ts";
import { configurationError } from "./engine.ts";
import { useNetworkRuntime } from "./RuntimePanels.tsx";
import { clearNat } from "./networkRuntime.ts";
import { NatPoolFields } from "./NatPoolFields.tsx";
export function NatPanel({
  device,
  topology,
  onCommit,
}: {
  device: Device;
  topology: Topology;
  onCommit: (t: Topology) => void;
}) {
  const { runtime, refresh } = useNetworkRuntime();
  const [draft, setDraft] = useState(device),
    [error, setError] = useState("");
  useEffect(() => {
    setDraft(device);
    setError("");
  }, [device]);
  const nat: NatConfig = draft.nat ?? { static: [], overload: [] },
    edit = (next: NatConfig) => setDraft({ ...draft, nat: next });
  return (
    <section className="ns-config ns-stp" aria-label="NAT configuration">
      <h3>Network address translation</h3>
      <p>
        Static mappings, address pools and interface overload. Configure
        selector ACLs in Policy. Simulation only; no external traffic.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const next = { ...draft, nat };
          const issue = configurationError(next);
          if (issue) {
            setError(issue);
            return;
          }
          onCommit({
            ...topology,
            devices: topology.devices.map((d) =>
              d.id === device.id ? next : d,
            ),
          });
          setError("");
        }}
      >
        <label>
          <input
            type="checkbox"
            checked={nat.hairpin ?? false}
            onChange={(e) => edit({ ...nat, hairpin: e.target.checked })}
          />
          Enable hairpin reflection
        </label>
        <small>
          CertSim extension: reflect published services between inside
          interfaces.
        </small>
        <h4>Interface roles</h4>
        {draft.ports.map((p) => (
          <label key={p.id}>
            {p.name}
            <select
              aria-label={`NAT role ${p.name}`}
              value={p.natRole ?? ""}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  ports: draft.ports.map((port) =>
                    port.id === p.id
                      ? {
                          ...port,
                          natRole: (e.target.value ||
                            undefined) as typeof p.natRole,
                        }
                      : port,
                  ),
                })
              }
            >
              <option value="">No NAT role</option>
              <option value="inside">Inside</option>
              <option value="outside">Outside</option>
            </select>
          </label>
        ))}
        <h4>Static mappings</h4>
        {nat.static.map((s, i) => (
          <fieldset key={i}>
            <legend>Static mapping {i + 1}</legend>
            <label>
              Inside local
              <input
                aria-label={`Inside local ${i + 1}`}
                value={s.inside}
                maxLength={15}
                required
                onChange={(e) =>
                  edit({
                    ...nat,
                    static: nat.static.map((n, j) =>
                      j === i ? { ...n, inside: e.target.value } : n,
                    ),
                  })
                }
              />
            </label>
            <label>
              Inside global
              <input
                aria-label={`Inside global ${i + 1}`}
                value={s.outside}
                maxLength={15}
                required
                onChange={(e) =>
                  edit({
                    ...nat,
                    static: nat.static.map((n, j) =>
                      j === i ? { ...n, outside: e.target.value } : n,
                    ),
                  })
                }
              />
            </label>
            <button
              type="button"
              className="ns-link-button"
              onClick={() =>
                edit({ ...nat, static: nat.static.filter((_, j) => j !== i) })
              }
            >
              Remove static {i + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className="ns-button"
          disabled={nat.static.length >= 128}
          onClick={() =>
            edit({
              ...nat,
              static: [...nat.static, { inside: "", outside: "" }],
            })
          }
        >
          Add static mapping
        </button>
        <h4>TCP / UDP port forwards</h4>
        {(nat.portForwards ?? []).map((f, i) => (
          <fieldset key={i}>
            <legend>Port forward {i + 1}</legend>
            <label>
              Protocol
              <select
                aria-label={`Port forward protocol ${i + 1}`}
                value={f.protocol}
                onChange={(e) =>
                  edit({
                    ...nat,
                    portForwards: nat.portForwards!.map((n, j) =>
                      j === i
                        ? { ...n, protocol: e.target.value as "tcp" | "udp" }
                        : n,
                    ),
                  })
                }
              >
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </select>
            </label>
            {(["inside", "insidePort", "outside", "outsidePort"] as const).map(
              (key) => (
                <label key={key}>
                  {
                    {
                      inside: "Inside local address",
                      insidePort: "Private service port",
                      outside: "Inside global address",
                      outsidePort: "Public service port",
                    }[key]
                  }
                  <input
                    aria-label={`Port forward ${{ inside: "private address", insidePort: "private port", outside: "public address", outsidePort: "public port" }[key]} ${i + 1}`}
                    type={key.endsWith("Port") ? "number" : "text"}
                    min={key.endsWith("Port") ? 1 : undefined}
                    max={key.endsWith("Port") ? 65535 : undefined}
                    required
                    value={f[key]}
                    onChange={(e) =>
                      edit({
                        ...nat,
                        portForwards: nat.portForwards!.map((n, j) =>
                          j === i
                            ? {
                                ...n,
                                [key]: key.endsWith("Port")
                                  ? e.target.valueAsNumber
                                  : e.target.value,
                              }
                            : n,
                        ),
                      })
                    }
                  />
                </label>
              ),
            )}
            <button
              type="button"
              className="ns-link-button"
              onClick={() =>
                edit({
                  ...nat,
                  portForwards: nat.portForwards?.filter((_, j) => j !== i),
                })
              }
            >
              Remove port forward {i + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className="ns-button"
          disabled={(nat.portForwards?.length ?? 0) >= 128}
          onClick={() =>
            edit({
              ...nat,
              portForwards: [
                ...(nat.portForwards ?? []),
                {
                  protocol: "tcp",
                  inside: "",
                  insidePort: 80,
                  outside:
                    draft.ports.find((p) => p.natRole === "outside")?.ip ?? "",
                  outsidePort: 8080,
                },
              ],
            })
          }
        >
          Add port forward
        </button>
        <NatPoolFields nat={nat} device={draft} onChange={edit} />
        <h4>Interface overload rules</h4>
        {nat.overload.map((rule, i) => (
          <fieldset key={i}>
            <legend>Overload rule {i + 1}</legend>
            <label>
              Selector ACL
              <select
                aria-label={`NAT selector ACL ${i + 1}`}
                value={rule.acl}
                onChange={(e) =>
                  edit({
                    ...nat,
                    overload: nat.overload.map((n, j) =>
                      j === i ? { ...n, acl: e.target.value } : n,
                    ),
                  })
                }
              >
                {draft.accessLists?.map((a) => (
                  <option key={a.name}>{a.name}</option>
                ))}
              </select>
            </label>
            <label>
              Public interface
              <select
                aria-label={`NAT public interface ${i + 1}`}
                value={rule.outsidePort}
                onChange={(e) =>
                  edit({
                    ...nat,
                    overload: nat.overload.map((n, j) =>
                      j === i ? { ...n, outsidePort: e.target.value } : n,
                    ),
                  })
                }
              >
                {draft.ports.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="ns-link-button"
              onClick={() =>
                edit({
                  ...nat,
                  overload: nat.overload.filter((_, j) => j !== i),
                })
              }
            >
              Remove overload {i + 1}
            </button>
          </fieldset>
        ))}
        <button
          type="button"
          className="ns-button"
          disabled={!draft.accessLists?.length || nat.overload.length >= 16}
          onClick={() =>
            edit({
              ...nat,
              overload: [
                ...nat.overload,
                {
                  acl: draft.accessLists![0].name,
                  outsidePort:
                    draft.ports.find((p) => p.natRole === "outside")?.id ??
                    draft.ports[0].id,
                },
              ],
            })
          }
        >
          Add overload rule
        </button>
        {error && <p role="alert">{error}</p>}
        <button type="submit" className="ns-button ns-primary ns-apply">
          Apply NAT
        </button>
      </form>
      <h4>Dynamic translations</h4>
      <button
        className="ns-button"
        onClick={() => {
          clearNat(runtime, device.id);
          refresh();
        }}
      >
        Clear dynamic translations
      </button>
      <div aria-label="NAT translations">
        {runtime.hairpin
          .filter((e) => e.router === device.id)
          .map((e, i) => (
            <p key={`hairpin-${i}`}>
              <strong>Hairpin {e.protocol.toUpperCase()}</strong>
              <br />
              {e.clientIp}:{e.clientPort} → {e.publicIp}:{e.publicPort}
              <br />
              Server {e.serverIp}:{e.serverPort} via {e.snatIp}:{e.snatPort} ·
              age {runtime.time - e.lastUsed}s
            </p>
          ))}
        {runtime.poolBindings
          .filter((e) => e.router === device.id)
          .map((e) => (
            <p key={`${e.pool}/${e.insideIp}`}>
              <strong>
                Pool {e.pool} · {e.insideIp}
              </strong>
              <br />→ {e.globalIp} · ports preserved
              <br />
              age {runtime.time - e.lastUsed}s
            </p>
          ))}
        {runtime.nat
          .filter((e) => e.router === device.id)
          .map((e, i) => (
            <p key={i}>
              <strong>
                {e.protocol.toUpperCase()} {e.insideIp}:{e.insidePort}
              </strong>
              <br />→ {e.globalIp}:{e.globalPort}
              <br />
              Remote {e.remoteIp}:{e.remotePort} · age{" "}
              {runtime.time - e.lastUsed}s {e.pool ? `· pool ${e.pool}` : ""}
            </p>
          ))}
        {!runtime.hairpin.some((e) => e.router === device.id) &&
          !runtime.nat.some((e) => e.router === device.id) &&
          !runtime.poolBindings.some((e) => e.router === device.id) && (
            <p>No active dynamic translations.</p>
          )}
      </div>
      <small>
        Virtual idle expiry: ICMP 30s, UDP 60s, TCP 300s. Port/identifier
        overload uses 20000–60000. Address bindings expire after 300s. NAT is
        not a firewall. Hairpin reflection is opt-in. TCP session emulation
        remains unsupported.
      </small>
    </section>
  );
}
