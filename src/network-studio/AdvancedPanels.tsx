import { applicationHost } from "./wireless.ts";
import { isRoutedInterface } from "./vlanInterfaces.ts";
import { useEffect, useMemo, useState } from "react";
import { useNetworkRuntime } from "./RuntimePanels.tsx";
import type {
  Device,
  DhcpPool,
  DnsAddressType,
  DnsRecord,
  ServerServices,
  Topology,
} from "./types.ts";
import type { ServiceResult } from "./services.ts";
import { configurationError } from "./engine.ts";
import {
  DEFAULT_DHCP_LEASE,
  defaultRouting,
  defaultServices,
} from "./extensions.ts";
import { ipString, ipv4, mask } from "./addressing.ts";
import {
  dnsLookup,
  httpRequest,
  releaseDhcp,
  requestDhcp,
} from "./services.ts";
import { eigrpTopology, learnedRoutes, routingNeighbors } from "./routing.ts";

interface PanelProps {
  device: Device;
  topology: Topology;
  onCommit: (t: Topology) => void;
}
function saveDevice(
  props: PanelProps,
  next: Device,
  setError: (s: string) => void,
): void {
  const error = configurationError(next);
  setError(error ?? "");
  if (!error)
    props.onCommit({
      ...props.topology,
      devices: props.topology.devices.map((d) => (d.id === next.id ? next : d)),
    });
}
export function ServicesPanel(props: PanelProps) {
  const initial = useMemo(
    () => props.device.services ?? defaultServices(),
    [props.device.services],
  );
  const [draft, setDraft] = useState(initial),
    [error, setError] = useState("");
  useEffect(() => {
    setDraft(initial);
    setError("");
  }, [initial]);
  const change = (update: (s: ServerServices) => void) =>
    setDraft((previous) => {
      const next = structuredClone(previous);
      update(next);
      return next;
    });
  const poolChange = (
    index: number,
    key: keyof DhcpPool,
    value: string | number,
  ) =>
    change((s) => {
      const pool = s.dhcp.pools[index];
      Object.assign(pool, { [key]: value });
      if (["start", "prefix", "count"].includes(key))
        s.dhcp.leases = s.dhcp.leases.filter((l) => l.pool !== pool.id);
    });
  return (
    <form
      className="ns-config ns-advanced-config"
      aria-label="Server services"
      onSubmit={(e) => {
        e.preventDefault();
        saveDevice(props, { ...props.device, services: draft }, setError);
      }}
    >
      <h3>DHCP server</h3>
      <label className="ns-checkbox">
        <input
          type="checkbox"
          checked={draft.dhcp.enabled}
          onChange={(e) =>
            change((s) => {
              s.dhcp.enabled = e.target.checked;
            })
          }
        />
        Enable DHCP service
      </label>
      {draft.dhcp.pools.map((p, i) => (
        <fieldset className="ns-route" key={p.id}>
          <legend>DHCP pool {i + 1}</legend>
          <label>
            Pool name
            <input
              value={p.name}
              maxLength={48}
              onChange={(e) => poolChange(i, "name", e.target.value)}
            />
          </label>
          <label>
            Starting address
            <input
              value={p.start}
              maxLength={15}
              onChange={(e) => poolChange(i, "start", e.target.value)}
            />
          </label>
          <div className="ns-form-pair">
            <label>
              Pool prefix
              <input
                type="number"
                min={1}
                max={30}
                value={p.prefix}
                onChange={(e) => poolChange(i, "prefix", +e.target.value)}
              />
            </label>
            <label>
              Pool size
              <input
                type="number"
                min={1}
                max={256}
                value={p.count}
                onChange={(e) => poolChange(i, "count", +e.target.value)}
              />
            </label>
          </div>
          <label>
            Lease duration (seconds)
            <input
              type="number"
              min={8}
              max={31536000}
              value={p.leaseSeconds ?? DEFAULT_DHCP_LEASE}
              onChange={(e) =>
                poolChange(i, "leaseSeconds", Number(e.target.value))
              }
            />
          </label>
          <label>
            Offered gateway
            <input
              value={p.gateway}
              maxLength={15}
              onChange={(e) => poolChange(i, "gateway", e.target.value)}
            />
          </label>
          <label>
            TFTP server (DHCP option 150)
            <input
              value={p.tftp ?? ""}
              maxLength={15}
              onChange={(e) => poolChange(i, "tftp", e.target.value)}
            />
          </label>
          <label>
            Offered DNS server
            <input
              value={p.dns}
              maxLength={15}
              onChange={(e) => poolChange(i, "dns", e.target.value)}
            />
          </label>
          <button
            type="button"
            className="ns-link-button ns-danger-text"
            onClick={() =>
              change((s) => {
                s.dhcp.pools.splice(i, 1);
                s.dhcp.leases = s.dhcp.leases.filter((l) => l.pool !== p.id);
              })
            }
          >
            Remove pool
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="ns-button"
        disabled={draft.dhcp.pools.length >= 16}
        onClick={() =>
          change((s) => {
            const p = props.device.ports.find((p) => p.ip),
              prefix = Math.min(30, p?.prefix ?? 24),
              base = p
                ? (ipv4(p.ip)! & mask(prefix)) >>> 0
                : ipv4("192.168.10.0")!;
            s.dhcp.pools.push({
              id: crypto.randomUUID(),
              name: `Pool-${s.dhcp.pools.length + 1}`,
              start: ipString(base + 1),
              prefix,
              count: Math.min(32, 2 ** (32 - prefix) - 2),
              gateway: props.device.gateway,
              dns: p?.ip ?? "",
            });
          })
        }
      >
        + Add DHCP pool
      </button>
      <p className="ns-panel-note">
        Changing the pool range clears its reservations. Clients receive updated
        options and lease durations when they renew.
      </p>
      <details className="ns-service-leases">
        <summary>
          Leases ({props.device.services?.dhcp.leases.length ?? 0})
        </summary>
        {props.device.services?.dhcp.leases.map((l) => (
          <p key={`${l.client}/${l.port}`}>
            {props.topology.devices.find((d) => d.id === l.client)?.name ??
              "Removed client"}{" "}
            · {l.ip}
            {l.expires !== undefined &&
              ` · ${Math.max(0, l.expires - (props.topology.dhcpTime ?? 0))}s remaining`}
          </p>
        ))}
      </details>
      <div className="ns-form-divider" />
      <h3>DNS server</h3>
      <label className="ns-checkbox">
        <input
          type="checkbox"
          checked={draft.dns.enabled}
          onChange={(e) =>
            change((s) => {
              s.dns.enabled = e.target.checked;
            })
          }
        />
        Enable DNS service
      </label>
      {draft.dns.records.map((r, i) => (
        <fieldset key={i} className="ns-route">
          <legend>DNS record {i + 1}</legend>
          <label>
            Record name
            <input
              value={r.name}
              maxLength={253}
              onChange={(e) =>
                change((s) => {
                  s.dns.records[i].name = e.target.value;
                })
              }
            />
          </label>
          <label>
            Record type
            <select
              aria-label="Record type"
              value={r.type}
              onChange={(e) =>
                change((s) => {
                  s.dns.records[i].type = e.target.value as DnsRecord["type"];
                })
              }
            >
              <option>A</option>
              <option>AAAA</option>
              <option>CNAME</option>
            </select>
          </label>
          <label>
            TTL (seconds)
            <input
              type="number"
              min={0}
              max={2147483647}
              required
              value={r.ttl ?? 300}
              onChange={(e) =>
                change((s) => {
                  s.dns.records[i].ttl = Number(e.target.value);
                })
              }
            />
          </label>
          <label>
            Record value
            <input
              value={r.value}
              maxLength={253}
              onChange={(e) =>
                change((s) => {
                  s.dns.records[i].value = e.target.value;
                })
              }
            />
          </label>
          <button
            type="button"
            className="ns-link-button ns-danger-text"
            onClick={() =>
              change((s) => {
                s.dns.records.splice(i, 1);
              })
            }
          >
            Remove record
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="ns-button"
        disabled={draft.dns.records.length >= 128}
        onClick={() =>
          change((s) => {
            s.dns.records.push({
              name: `host-${s.dns.records.length + 1}.lab`,
              type: "A",
              value:
                props.device.ports.find((p) => p.ip)?.ip ?? "192.168.10.100",
            });
          })
        }
      >
        + Add DNS record
      </button>
      <div className="ns-form-divider" />
      <h3>HTTP server</h3>
      <label className="ns-checkbox">
        <input
          type="checkbox"
          checked={draft.http.enabled}
          onChange={(e) =>
            change((s) => {
              s.http.enabled = e.target.checked;
            })
          }
        />
        Enable HTTP service
      </label>
      {draft.http.pages.map((p, i) => (
        <fieldset className="ns-route" key={i}>
          <legend>Page {i + 1}</legend>
          <label>
            Page path
            <input
              value={p.path}
              maxLength={180}
              onChange={(e) =>
                change((s) => {
                  s.http.pages[i].path = e.target.value;
                })
              }
            />
          </label>
          <label>
            Page body
            <textarea
              rows={5}
              aria-label="Page body"
              value={p.body}
              maxLength={16384}
              onChange={(e) =>
                change((s) => {
                  s.http.pages[i].body = e.target.value;
                })
              }
            />
          </label>
          <button
            type="button"
            className="ns-link-button ns-danger-text"
            onClick={() =>
              change((s) => {
                s.http.pages.splice(i, 1);
              })
            }
          >
            Remove page
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="ns-button"
        disabled={draft.http.pages.length >= 16}
        onClick={() =>
          change((s) => {
            s.http.pages.push({
              path: `/page-${s.http.pages.length}.html`,
              body: "New lab page",
            });
          })
        }
      >
        + Add HTTP page
      </button>
      <p className="ns-panel-note">
        Page bodies are displayed as inert text in the practice browser.
      </p>
      {error && (
        <p className="ns-error" role="alert">
          {error}
        </p>
      )}
      <button className="ns-button ns-primary">Apply services</button>
    </form>
  );
}
export function RoutingPanel(props: PanelProps) {
  const { runtime } = useNetworkRuntime();
  const initial = useMemo(
    () => props.device.routing ?? defaultRouting(),
    [props.device.routing],
  );
  const [draft, setDraft] = useState(initial),
    [error, setError] = useState("");
  useEffect(() => {
    setDraft(initial);
    setError("");
  }, [initial]);
  const neighbors = routingNeighbors(props.topology, props.device.id, runtime);
  const eigrp =
    props.device.routing?.protocol === "eigrp"
      ? eigrpTopology(props.topology, props.device.id, runtime)
      : [];
  const routes =
    props.device.routing?.protocol === "eigrp"
      ? eigrp
      : learnedRoutes(props.topology, props.device.id, runtime);
  return (
    <form
      className="ns-config ns-advanced-config"
      aria-label="Routing protocols"
      onSubmit={(e) => {
        e.preventDefault();
        saveDevice(props, { ...props.device, routing: draft }, setError);
      }}
    >
      <h3>Routing protocol</h3>
      <label>
        Protocol
        <select
          aria-label="Protocol"
          value={draft.protocol}
          onChange={(e) =>
            setDraft((d) => ({
              ...d,
              protocol: e.target.value as typeof d.protocol,
            }))
          }
        >
          <option value="none">None</option>
          <option value="rip">RIPv2</option>
          <option value="ospf">OSPF · area 0</option>
          <option value="eigrp">EIGRP · IPv4</option>
        </select>
      </label>
      {(draft.protocol === "ospf" || draft.protocol === "eigrp") && (
        <>
          <label>
            {draft.protocol === "eigrp"
              ? "Autonomous system (AS)"
              : "Process ID"}
            <input
              type="number"
              min={1}
              max={65535}
              value={draft.processId}
              onChange={(e) =>
                setDraft((d) => ({ ...d, processId: +e.target.value }))
              }
            />
          </label>
          <label>
            Router ID
            <input
              value={draft.routerId}
              maxLength={15}
              placeholder="Automatic: highest interface IP"
              onChange={(e) =>
                setDraft((d) => ({ ...d, routerId: e.target.value }))
              }
            />
          </label>
        </>
      )}
      <h3>Participating networks</h3>
      {draft.networks.map((n, i) => (
        <fieldset className="ns-route" key={i}>
          <legend>Advertisement {i + 1}</legend>
          <label>
            Network address
            <input
              value={n.network}
              maxLength={15}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  networks: d.networks.map((v, j) =>
                    j === i ? { ...v, network: e.target.value } : v,
                  ),
                }))
              }
            />
          </label>
          <label>
            Network prefix
            <input
              type="number"
              min={0}
              max={32}
              value={n.prefix}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  networks: d.networks.map((v, j) =>
                    j === i ? { ...v, prefix: +e.target.value } : v,
                  ),
                }))
              }
            />
          </label>
          <button
            type="button"
            className="ns-link-button ns-danger-text"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                networks: d.networks.filter((_, j) => j !== i),
              }))
            }
          >
            Remove advertisement
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="ns-button"
        disabled={draft.networks.length >= 32}
        onClick={() =>
          setDraft((d) => ({
            ...d,
            networks: [
              ...d.networks,
              { network: "0.0.0.0", prefix: 0, area: 0 },
            ],
          }))
        }
      >
        + Add network
      </button>
      <h3>Passive interfaces</h3>
      {props.device.ports
        .filter((p) => isRoutedInterface(props.device, p))
        .map((p) => (
          <label className="ns-checkbox" key={p.id}>
            <input
              type="checkbox"
              checked={draft.passivePorts.includes(p.id)}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  passivePorts: [
                    ...d.passivePorts.filter((id) => id !== p.id),
                    ...(e.target.checked ? [p.id] : []),
                  ],
                }))
              }
            />
            {p.name}
          </label>
        ))}
      <p className="ns-panel-note">
        Passive interfaces advertise their network but do not form neighbors.
        This model converges immediately and does not simulate routing control
        timers.
      </p>
      {draft.protocol === "eigrp" && (
        <p className="ns-panel-note">
          Neighbors must share an AS. IPv4 EIGRP uses minimum path bandwidth and
          cumulative delay with the default K values; automatic summarization is
          off. This model selects one internal route per prefix and does not
          simulate DUAL messages, redistribution or unequal-cost load balancing.
        </p>
      )}
      {error && (
        <p className="ns-error" role="alert">
          {error}
        </p>
      )}
      <button className="ns-button ns-primary">Apply routing</button>
      <section className="ns-live-routes" aria-label="Learned routing state">
        {props.device.routing?.protocol === "eigrp" && (
          <p>Applied EIGRP AS: {props.device.routing.processId}</p>
        )}
        <h3>Neighbors · {neighbors.length}</h3>
        {neighbors.map((n, i) => (
          <p key={i}>
            {props.topology.devices.find((d) => d.id === n.router)?.name} ·{" "}
            {n.nextHop}
            <br />
            <small>
              Local interface:{" "}
              {props.device.ports.find((p) => p.id === n.localPort)?.name ??
                n.localPort}
            </small>
          </p>
        ))}
        <h3>Learned routes · {routes.length}</h3>
        {routes.map((r) => {
          const vector = eigrp.find(
            (entry) => entry.network === r.network && entry.prefix === r.prefix,
          );
          return (
            <p key={`${r.network}/${r.prefix}`}>
              {r.protocol.toUpperCase()} {r.network}/{r.prefix}
              <br />
              <small>
                via {r.nextHop} · metric {r.metric}
              </small>
              {vector && (
                <>
                  <br />
                  <small>
                    Local interface:{" "}
                    {props.device.ports.find((p) => p.id === vector.localPort)
                      ?.name ?? vector.localPort}
                    <br />
                    Minimum bandwidth: {vector.bandwidth} Kbit/s · Total delay:{" "}
                    {vector.delay} × 10 µs
                  </small>
                </>
              )}
            </p>
          );
        })}
      </section>
    </form>
  );
}
export function PolicyPanel(props: PanelProps) {
  const [draft, setDraft] = useState(props.device),
    [error, setError] = useState("");
  useEffect(() => {
    setDraft(props.device);
    setError("");
  }, [props.device]);
  const change = (update: (d: Device) => void) =>
    setDraft((d) => {
      const next = structuredClone(d);
      update(next);
      return next;
    });
  return (
    <form
      className="ns-config ns-advanced-config"
      aria-label="Access list policy"
      onSubmit={(e) => {
        e.preventDefault();
        saveDevice(props, draft, setError);
      }}
    >
      <h3>Ordered access lists</h3>
      <p className="ns-panel-note">
        First matching rule wins. Attached lists have an implicit deny at the
        end. Request and reply are evaluated independently.
      </p>
      {(draft.accessLists ?? []).map((acl, a) => (
        <fieldset className="ns-route" key={a}>
          <legend>{acl.name}</legend>
          {acl.rules.map((rule, r) => (
            <fieldset className="ns-route ns-acl-rule" key={r}>
              <legend>Rule {r + 1}</legend>
              <div className="ns-form-pair">
                <label>
                  Action
                  <select
                    aria-label="Action"
                    value={rule.action}
                    onChange={(e) =>
                      change((d) => {
                        d.accessLists![a].rules[r].action = e.target
                          .value as typeof rule.action;
                      })
                    }
                  >
                    <option value="permit">Permit</option>
                    <option value="deny">Deny</option>
                  </select>
                </label>
                <label>
                  Match protocol
                  <select
                    aria-label="Match protocol"
                    value={rule.protocol}
                    onChange={(e) =>
                      change((d) => {
                        const next = d.accessLists![a].rules[r];
                        next.protocol = e.target.value as typeof rule.protocol;
                        if (next.protocol === "ip" || next.protocol === "icmp")
                          delete next.destinationPort;
                      })
                    }
                  >
                    <option value="ip">Any IPv4</option>
                    <option value="icmp">ICMP</option>
                    <option value="tcp">TCP</option>
                    <option value="udp">UDP</option>
                  </select>
                </label>
              </div>
              <label>
                Source network
                <input
                  value={rule.source}
                  maxLength={15}
                  onChange={(e) =>
                    change((d) => {
                      d.accessLists![a].rules[r].source = e.target.value;
                    })
                  }
                />
              </label>
              <label>
                Source prefix
                <input
                  type="number"
                  min={0}
                  max={32}
                  value={rule.sourcePrefix}
                  onChange={(e) =>
                    change((d) => {
                      d.accessLists![a].rules[r].sourcePrefix = +e.target.value;
                    })
                  }
                />
              </label>
              <label>
                Destination network
                <input
                  value={rule.destination}
                  maxLength={15}
                  onChange={(e) =>
                    change((d) => {
                      d.accessLists![a].rules[r].destination = e.target.value;
                    })
                  }
                />
              </label>
              <label>
                Destination prefix
                <input
                  type="number"
                  min={0}
                  max={32}
                  value={rule.destinationPrefix}
                  onChange={(e) =>
                    change((d) => {
                      d.accessLists![a].rules[r].destinationPrefix =
                        +e.target.value;
                    })
                  }
                />
              </label>
              {["tcp", "udp"].includes(rule.protocol) && (
                <label>
                  Destination port (optional)
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={rule.destinationPort ?? ""}
                    onChange={(e) =>
                      change((d) => {
                        const next = d.accessLists![a].rules[r];
                        if (e.target.value)
                          next.destinationPort = +e.target.value;
                        else delete next.destinationPort;
                      })
                    }
                  />
                </label>
              )}
              <div className="ns-rule-actions">
                <button
                  type="button"
                  className="ns-button"
                  disabled={!r}
                  aria-label={`Move rule ${r + 1} up`}
                  onClick={() =>
                    change((d) => {
                      const rules = d.accessLists![a].rules;
                      [rules[r - 1], rules[r]] = [rules[r], rules[r - 1]];
                    })
                  }
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="ns-button"
                  disabled={r === acl.rules.length - 1}
                  aria-label={`Move rule ${r + 1} down`}
                  onClick={() =>
                    change((d) => {
                      const rules = d.accessLists![a].rules;
                      [rules[r + 1], rules[r]] = [rules[r], rules[r + 1]];
                    })
                  }
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="ns-link-button ns-danger-text"
                  onClick={() =>
                    change((d) => {
                      d.accessLists![a].rules.splice(r, 1);
                    })
                  }
                >
                  Remove rule
                </button>
              </div>
            </fieldset>
          ))}
          <button
            type="button"
            className="ns-button"
            disabled={acl.rules.length >= 128}
            onClick={() =>
              change((d) => {
                d.accessLists![a].rules.push({
                  action: "permit",
                  protocol: "ip",
                  source: "0.0.0.0",
                  sourcePrefix: 0,
                  destination: "0.0.0.0",
                  destinationPrefix: 0,
                });
              })
            }
          >
            + Add rule
          </button>
          <button
            type="button"
            className="ns-link-button ns-danger-text"
            onClick={() =>
              change((d) => {
                d.accessLists!.splice(a, 1);
                for (const p of d.ports) {
                  if (p.inboundAcl === acl.name) p.inboundAcl = "";
                  if (p.outboundAcl === acl.name) p.outboundAcl = "";
                }
              })
            }
          >
            Remove access list
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="ns-button"
        disabled={(draft.accessLists?.length ?? 0) >= 16}
        onClick={() =>
          change((d) => {
            d.accessLists ??= [];
            let i = 1;
            while (d.accessLists.some((a) => a.name === `policy-${i}`)) i++;
            d.accessLists.push({ name: `policy-${i}`, rules: [] });
          })
        }
      >
        + Add access list
      </button>
      <h3>Interface bindings</h3>
      {draft.ports
        .filter((p) => isRoutedInterface(draft, p))
        .map((p) => (
          <fieldset className="ns-route" key={p.id}>
            <legend>{p.name}</legend>
            {(["inboundAcl", "outboundAcl"] as const).map((key) => (
              <label key={key}>
                {key === "inboundAcl" ? "Inbound ACL" : "Outbound ACL"}
                <select
                  aria-label={
                    key === "inboundAcl" ? "Inbound ACL" : "Outbound ACL"
                  }
                  value={p[key] ?? ""}
                  onChange={(e) =>
                    change((d) => {
                      d.ports.find((port) => port.id === p.id)![key] =
                        e.target.value;
                    })
                  }
                >
                  <option value="">No ACL</option>
                  {draft.accessLists?.map((a) => (
                    <option key={a.name}>{a.name}</option>
                  ))}
                </select>
              </label>
            ))}
            <label>
              OSPF interface cost
              <input
                type="number"
                min={1}
                max={65535}
                value={p.cost ?? 1}
                onChange={(e) =>
                  change((d) => {
                    d.ports.find((port) => port.id === p.id)!.cost =
                      +e.target.value;
                  })
                }
              />
            </label>
          </fieldset>
        ))}
      {error && (
        <p className="ns-error" role="alert">
          {error}
        </p>
      )}
      <button className="ns-button ns-primary">Apply policy</button>
    </form>
  );
}
export function ClientTools({
  topology,
  onResult,
}: {
  topology: Topology;
  onResult: (result: ServiceResult, next?: Topology) => void;
}) {
  const { runtime } = useNetworkRuntime();
  const clients = topology.devices.filter((d) => applicationHost(d.kind));
  const [clientId, setClientId] = useState(clients[0]?.id ?? ""),
    [operation, setOperation] = useState("dhcp"),
    [query, setQuery] = useState("certsim.lab"),
    [queryType, setQueryType] = useState<DnsAddressType>("A"),
    [response, setResponse] = useState<ServiceResult | null>(null);
  const effective = clients.find((d) => d.id === clientId) ?? clients[0];
  const [portId, setPortId] = useState("");
  const port =
    effective?.ports.find((p) => p.id === portId) ?? effective?.ports[0];
  useEffect(() => {
    setResponse(null);
  }, [topology]);
  const show = (result: ServiceResult, next?: Topology) => {
    setResponse(result);
    onResult(result, next);
  };
  return (
    <section className="ns-client-tools" aria-label="Client applications">
      <div className="ns-client-tools-title">
        <h3>Client applications</h3>
        <span>In-model services · no external requests</span>
      </div>
      <form
        className="ns-application-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!effective) return;
          if (operation === "dhcp") {
            const r = requestDhcp(topology, effective.id, port?.id, runtime);
            show(r, r.topology !== topology ? r.topology : undefined);
          } else
            show(
              operation === "dns"
                ? dnsLookup(
                    topology,
                    effective.id,
                    query,
                    undefined,
                    runtime,
                    queryType,
                  )
                : httpRequest(topology, effective.id, query, runtime),
            );
        }}
      >
        <label>
          Application client
          <select
            aria-label="Application client"
            value={effective?.id ?? ""}
            onChange={(e) => setClientId(e.target.value)}
          >
            {clients.length ? (
              clients.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))
            ) : (
              <option value="">Add a workstation</option>
            )}
          </select>
        </label>
        <label>
          Application
          <select
            aria-label="Application"
            value={operation}
            onChange={(e) => {
              setOperation(e.target.value);
              setQuery(
                e.target.value === "http"
                  ? "http://certsim.lab/"
                  : "certsim.lab",
              );
              setResponse(null);
            }}
          >
            <option value="dhcp">DHCP client</option>
            <option value="dns">DNS lookup</option>
            <option value="http">Web browser · HTTP</option>
          </select>
        </label>
        {operation === "dns" && (
          <label>
            Query type
            <select
              aria-label="Query type"
              value={queryType}
              onChange={(e) => setQueryType(e.target.value as DnsAddressType)}
            >
              <option>A</option>
              <option>AAAA</option>
            </select>
          </label>
        )}
        {operation === "dhcp" ? (
          <label>
            Client interface
            <select
              value={port?.id ?? ""}
              onChange={(e) => setPortId(e.target.value)}
            >
              {effective?.ports
                .filter((p) => effective.kind !== "phone" || p.id === "p0")
                .map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
        ) : (
          <label>
            {operation === "dns" ? "DNS query" : "Lab URL"}
            <input
              aria-label={operation === "dns" ? "DNS query" : "Lab URL"}
              value={query}
              maxLength={2048}
              onChange={(e) => setQuery(e.target.value)}
              required
            />
          </label>
        )}
        <button className="ns-button ns-primary" disabled={!effective}>
          {operation === "dhcp"
            ? "Request lease"
            : operation === "dns"
              ? "Resolve name"
              : "Browse lab site"}
        </button>
        {operation === "dhcp" && (
          <button
            type="button"
            className="ns-button"
            disabled={!effective || port?.addressMode !== "dhcp"}
            onClick={() => {
              if (effective) {
                const r = releaseDhcp(
                  topology,
                  effective.id,
                  port?.id,
                  runtime,
                );
                show(r, r.topology !== topology ? r.topology : undefined);
              }
            }}
          >
            Release lease
          </button>
        )}
      </form>
      {response?.body !== undefined && (
        <div className="ns-http-response">
          <strong>{response.message}</strong>
          <pre aria-label="HTTP response body">{response.body}</pre>
        </div>
      )}
    </section>
  );
}
