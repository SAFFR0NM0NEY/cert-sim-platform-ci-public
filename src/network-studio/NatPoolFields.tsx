import type { Device, NatConfig } from "./types.ts";
export function NatPoolFields({
  nat,
  device,
  onChange,
}: {
  nat: NatConfig;
  device: Device;
  onChange: (next: NatConfig) => void;
}) {
  const pools = nat.pools ?? [],
    rules = nat.poolRules ?? [];
  return (
    <>
      <h4>Address pools</h4>
      <p>
        Without overload, each client reserves a public address. With overload,
        clients share public addresses through unique ports or identifiers.
      </p>
      {pools.map((p, i) => (
        <fieldset key={i}>
          <legend>Pool {i + 1}</legend>
          <label>
            Name
            <input
              aria-label={`Pool name ${i + 1}`}
              required
              maxLength={32}
              value={p.name}
              onChange={(e) =>
                onChange({
                  ...nat,
                  pools: pools.map((n, j) =>
                    j === i ? { ...n, name: e.target.value } : n,
                  ),
                  poolRules: rules.map((r) =>
                    r.pool === p.name ? { ...r, pool: e.target.value } : r,
                  ),
                })
              }
            />
          </label>
          {(["start", "end"] as const).map((key) => (
            <label key={key}>
              {key === "start" ? "First address" : "Last address"}
              <input
                aria-label={`Pool ${key} ${i + 1}`}
                required
                maxLength={15}
                value={p[key]}
                onChange={(e) =>
                  onChange({
                    ...nat,
                    pools: pools.map((n, j) =>
                      j === i ? { ...n, [key]: e.target.value } : n,
                    ),
                  })
                }
              />
            </label>
          ))}
          <label>
            Prefix length
            <input
              aria-label={`Pool prefix ${i + 1}`}
              required
              type="number"
              min="1"
              max="32"
              value={p.prefix}
              onChange={(e) =>
                onChange({
                  ...nat,
                  pools: pools.map((n, j) =>
                    j === i ? { ...n, prefix: e.target.valueAsNumber } : n,
                  ),
                })
              }
            />
          </label>
          <button
            type="button"
            className="ns-link-button"
            onClick={() =>
              onChange({
                ...nat,
                pools: pools.filter((_, j) => j !== i),
                poolRules: rules.filter((r) => r.pool !== p.name),
              })
            }
          >
            Remove pool {i + 1}
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="ns-button"
        disabled={pools.length >= 16}
        onClick={() => {
          let i = 1;
          while (pools.some((p) => p.name === `pool-${i}`)) i++;
          onChange({
            ...nat,
            pools: [
              ...pools,
              {
                name: `pool-${i}`,
                start: "203.0.113.10",
                end: "203.0.113.11",
                prefix: 24,
              },
            ],
          });
        }}
      >
        Add address pool
      </button>
      <h4>Pool rules</h4>
      <p>
        Static mappings take precedence, then these rules in order, then
        interface overload. A selected exhausted pool stops the flow.
      </p>
      {rules.map((r, i) => (
        <fieldset key={i}>
          <legend>Pool rule {i + 1}</legend>
          <label>
            Selector ACL
            <select
              aria-label={`Pool selector ACL ${i + 1}`}
              value={r.acl}
              onChange={(e) =>
                onChange({
                  ...nat,
                  poolRules: rules.map((n, j) =>
                    j === i ? { ...n, acl: e.target.value } : n,
                  ),
                })
              }
            >
              {device.accessLists?.map((a) => (
                <option key={a.name}>{a.name}</option>
              ))}
            </select>
          </label>
          <label>
            Pool
            <select
              aria-label={`Pool rule name ${i + 1}`}
              value={r.pool}
              onChange={(e) =>
                onChange({
                  ...nat,
                  poolRules: rules.map((n, j) =>
                    j === i ? { ...n, pool: e.target.value } : n,
                  ),
                })
              }
            >
              {pools.map((p) => (
                <option key={p.name}>{p.name}</option>
              ))}
            </select>
          </label>
          <label>
            Allocation
            <select
              aria-label={`Pool allocation ${i + 1}`}
              value={r.overload ? "overload" : "address"}
              onChange={(e) =>
                onChange({
                  ...nat,
                  poolRules: rules.map((n, j) =>
                    j === i
                      ? { ...n, overload: e.target.value === "overload" }
                      : n,
                  ),
                })
              }
            >
              <option value="address">One public address per client</option>
              <option value="overload">Overload / PAT</option>
            </select>
          </label>
          <button
            type="button"
            className="ns-link-button"
            onClick={() =>
              onChange({ ...nat, poolRules: rules.filter((_, j) => j !== i) })
            }
          >
            Remove pool rule {i + 1}
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="ns-button"
        disabled={
          !pools.length || !device.accessLists?.length || rules.length >= 16
        }
        onClick={() =>
          onChange({
            ...nat,
            poolRules: [
              ...rules,
              {
                acl: device.accessLists![0].name,
                pool: pools[0].name,
                overload: false,
              },
            ],
          })
        }
      >
        Add pool rule
      </button>
    </>
  );
}
