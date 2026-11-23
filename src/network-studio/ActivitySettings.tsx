import { useState } from "react";
import {
  fieldLabels,
  interfaceValue,
  interfaceCheckKey,
  MAX_CHECKS,
} from "./activity.ts";
import type { ActivityField, InterfaceCheck, Topology } from "./types.ts";

export function describeSetting(topology: Topology, check: InterfaceCheck) {
  const device = topology.devices.find((d) => d.id === check.device);
  const port = device?.ports.find((p) => p.id === check.port);
  return [
    device?.name ?? check.device,
    port?.name ?? check.port,
    fieldLabels[check.field],
  ].join(" · ");
}

export function ActivitySettings({
  topology,
  checks,
  onChange,
}: {
  topology: Topology;
  checks: InterfaceCheck[];
  onChange: (next: InterfaceCheck[]) => void;
}) {
  const [deviceId, setDevice] = useState(""),
    [portId, setPort] = useState(""),
    [fieldId, setField] = useState<ActivityField>("enabled");
  const device =
    topology.devices.find((d) => d.id === deviceId) ?? topology.devices[0];
  const port = device?.ports.find((p) => p.id === portId) ?? device?.ports[0];
  const fields =
    device && port
      ? (Object.keys(fieldLabels) as ActivityField[]).filter(
          (f) => interfaceValue(device, port, f) !== undefined,
        )
      : [];
  const field = fields.includes(fieldId) ? fieldId : fields[0];
  const expected =
    device && port && field ? interfaceValue(device, port, field) : undefined;
  const selected =
    device && port && field && expected !== undefined
      ? { device: device.id, port: port.id, field, expected }
      : undefined;
  const key = selected && interfaceCheckKey(selected);
  return (
    <fieldset>
      <legend>Interface checks</legend>
      <div className="ns-config">
        <label>
          Check device
          <select
            aria-label="Check device"
            value={device?.id ?? ""}
            onChange={(e) => {
              setDevice(e.target.value);
              setPort("");
            }}
          >
            {topology.devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Check interface
          <select
            aria-label="Check interface"
            value={port?.id ?? ""}
            onChange={(e) => setPort(e.target.value)}
          >
            {device?.ports.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Interface setting
          <select
            aria-label="Interface setting"
            value={field ?? ""}
            onChange={(e) => setField(e.target.value as ActivityField)}
          >
            {fields.map((f) => (
              <option key={f} value={f}>
                {fieldLabels[f]}
              </option>
            ))}
          </select>
        </label>
        <button
          className="ns-button"
          type="button"
          disabled={
            !selected ||
            (checks.length >= MAX_CHECKS &&
              !checks.some((c) => interfaceCheckKey(c) === key))
          }
          onClick={() => {
            if (selected)
              onChange([
                ...checks.filter((c) => interfaceCheckKey(c) !== key),
                selected,
              ]);
          }}
        >
          Capture expected setting
          {expected === undefined ? "" : " · " + expected}
        </button>
        {checks.map((c) => (
          <div key={interfaceCheckKey(c)} className="ns-activity-check">
            <span>
              {describeSetting(topology, c)} · {c.expected}
            </span>
            <button
              type="button"
              className="ns-button"
              aria-label={"Remove " + describeSetting(topology, c)}
              onClick={() => onChange(checks.filter((x) => x !== c))}
            >
              Remove check
            </button>
          </div>
        ))}
      </div>
    </fieldset>
  );
}
