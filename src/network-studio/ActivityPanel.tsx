import { ActivitySettings, describeSetting } from "./ActivitySettings.tsx";
import { interfaceCheckKey } from "./activity.ts";
import { useState } from "react";
import {
  captureActivity,
  checkActivity,
  describeProbe,
  MAX_CHECKS,
  resetActivity,
} from "./activity.ts";
import { useNetworkRuntime } from "./RuntimePanels.tsx";
import type { Topology } from "./types.ts";

export function ActivityPanel({
  topology,
  onCommit,
  onReset,
}: {
  topology: Topology;
  onCommit: (t: Topology) => boolean;
  onReset: (t: Topology) => void;
}) {
  const activity = topology.activity;
  const [settings, setSettings] = useState(activity?.interfaceChecks ?? []);
  const { runtime } = useNetworkRuntime();
  const [editing, setEditing] = useState(!activity),
    [error, setError] = useState("");
  const [checked, setChecked] = useState<{
    network: Topology;
    time: number;
    rows: ReturnType<typeof checkActivity>;
  }>();
  const results =
    checked?.network === topology && checked.time === runtime.time
      ? checked.rows
      : undefined;
  const choices = new Map(
    (activity?.checks ?? []).map((c) => [c.probe.id, c.probe]),
  );
  for (const p of topology.pdus ?? []) choices.set(p.id, p);
  if (editing)
    return (
      <form
        className="ns-config ns-activity"
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          try {
            const checks = [...choices.values()]
              .filter((p) => data.has("check:" + p.id))
              .map((probe) => ({
                probe,
                deliver: data.get("outcome:" + probe.id) === "delivered",
              }));
            const next = captureActivity(
              topology,
              String(data.get("title")),
              String(data.get("instructions")),
              checks,
              settings,
              !!activity && !data.has("replaceStart"),
            );
            if (!onCommit({ ...topology, activity: next }))
              throw Error("Activity exceeds the workspace save limit.");
            setChecked(undefined);
            setError("");
            setEditing(false);
          } catch (cause) {
            setError(
              cause instanceof Error ? cause.message : "Invalid activity.",
            );
          }
        }}
      >
        <label>
          Activity title
          <input
            name="title"
            required
            maxLength={100}
            defaultValue={activity?.title ?? topology.name}
          />
        </label>
        <label>
          Instructions
          <textarea
            aria-label="Instructions"
            name="instructions"
            rows={4}
            required
            maxLength={4000}
            defaultValue={activity?.instructions}
          />
        </label>
        <fieldset>
          <legend>Connectivity checks</legend>
          {!choices.size && (
            <p>
              Add a Simple PDU on the canvas or a packet in User-created PDUs to
              use it as a check.
            </p>
          )}
          {[...choices.values()].map((p) => {
            const previous = activity?.checks.find((c) => c.probe.id === p.id);
            const label = describeProbe(topology, p);
            return (
              <div key={p.id} className="ns-activity-check">
                <label className="ns-checkbox">
                  <input
                    type="checkbox"
                    name={"check:" + p.id}
                    defaultChecked={!!previous}
                  />
                  {label}
                </label>
                <select
                  aria-label={"Expected result for " + label}
                  name={"outcome:" + p.id}
                  defaultValue={
                    previous?.deliver === false ? "blocked" : "delivered"
                  }
                >
                  <option value="delivered">Should deliver</option>
                  <option value="blocked">Should fail to deliver</option>
                </select>
              </div>
            );
          })}
        </fieldset>
        <ActivitySettings
          topology={topology}
          checks={settings}
          onChange={setSettings}
        />
        {activity ? (
          <label className="ns-checkbox">
            <input type="checkbox" name="replaceStart" />
            Replace the starting network with the current network
          </label>
        ) : (
          <p>Saving captures the current network as the starting point.</p>
        )}
        <p>Choose up to {MAX_CHECKS} checks.</p>
        {error && <p role="alert">{error}</p>}
        <div className="ns-actions">
          <button
            className="ns-button ns-primary"
            disabled={!choices.size && !settings.length}
          >
            Save practice activity
          </button>
          {activity && (
            <button
              type="button"
              className="ns-button"
              onClick={() => {
                setError("");
                setEditing(false);
              }}
            >
              Cancel edit
            </button>
          )}
        </div>
      </form>
    );
  if (!activity) return null;
  return (
    <section
      className="ns-guide ns-activity"
      aria-label="Practice instructions"
    >
      <h3>{activity.title}</h3>
      <p className="ns-activity-text">{activity.instructions}</p>
      <ol>
        {activity.checks.map(({ probe, deliver }, i) => (
          <li key={probe.id}>
            {describeProbe(activity.initial, probe)} ·{" "}
            {deliver ? "Should deliver" : "Should fail to deliver"}
            {results && (
              <p>
                <strong>{results[i].ok ? "Passed" : "Needs work"}</strong> ·{" "}
                {results[i].message}
              </p>
            )}
          </li>
        ))}
        {(activity.interfaceChecks ?? []).map((c, i) => {
          const result = results?.[activity.checks.length + i];
          return (
            <li key={interfaceCheckKey(c)}>
              {describeSetting(activity.initial, c)}
              {result && (
                <p>
                  <strong>{result.ok ? "Passed" : "Needs work"}</strong> ·{" "}
                  {result.message}
                </p>
              )}
            </li>
          );
        })}
      </ol>
      {results && (
        <p role="status">
          {results.filter((r) => r.ok).length} of {results.length} checks passed
        </p>
      )}
      <div className="ns-actions">
        <button
          className="ns-button ns-primary"
          onClick={() =>
            setChecked({
              network: topology,
              time: runtime.time,
              rows: checkActivity(topology, runtime),
            })
          }
        >
          Check results
        </button>
        <button
          className="ns-button"
          onClick={() => {
            setChecked(undefined);
            onReset(resetActivity(topology));
          }}
        >
          Reset activity
        </button>
        <button
          className="ns-button"
          onClick={() => {
            setSettings(activity.interfaceChecks ?? []);
            setEditing(true);
          }}
        >
          Edit activity
        </button>
      </div>
    </section>
  );
}
