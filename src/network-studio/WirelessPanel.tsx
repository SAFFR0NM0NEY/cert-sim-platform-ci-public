import { useState } from "react";
import type {
  Device,
  Topology,
  WirelessSettings,
  RadioBand,
  RadioMode,
} from "./types.ts";
import {
  associatedAccessPoint,
  channels,
  supportedModes,
  radioModes,
  nearbyAccessPoints,
  parseWireless,
  wirelessAssociations,
} from "./wireless.ts";

export function WirelessPanel({
  device,
  topology,
  onCommit,
}: {
  device: Device;
  topology: Topology;
  onCommit: (t: Topology) => void;
}) {
  const ap = device.kind === "ap";
  const [draft, setDraft] = useState<WirelessSettings>(device.wireless!);
  const [error, setError] = useState("");
  const band = draft.band ?? (ap ? "2.4" : undefined);
  const modes = band ? ["mixed", ...supportedModes(band)] : radioModes;
  function selectBand(value: string) {
    const band = value ? (value as RadioBand) : undefined;
    const mode =
      draft.mode &&
      draft.mode !== "mixed" &&
      band &&
      !supportedModes(band).includes(draft.mode)
        ? "mixed"
        : draft.mode;
    const channel =
      ap && band
        ? channels[band].includes(draft.channel!)
          ? draft.channel
          : channels[band][0]
        : undefined;
    update({ band, mode, ...(ap ? { channel } : {}) });
  }
  const associated = ap ? undefined : associatedAccessPoint(topology, device);
  const networks = ap
    ? []
    : nearbyAccessPoints(topology, device).filter(
        (n) => n.ap.wireless!.broadcast,
      );
  const peers = ap
    ? wirelessAssociations(topology).filter((a) => a.ap.id === device.id)
    : [];
  function update(values: Partial<WirelessSettings>) {
    setDraft((s) => ({ ...s, ...values }));
    setError("");
  }
  return (
    <section className="ns-config" aria-label="Wireless radio">
      <h3>{ap ? "Access point radio" : "Wireless adapter"}</h3>
      {ap ? (
        <p aria-label="Associated stations">
          {peers.length} associated ·{" "}
          {peers.map((p) => p.client.name).join(", ") || "No stations"}
        </p>
      ) : (
        <p aria-label="Association status">
          {associated
            ? "Associated with " +
              associated.name +
              " · channel " +
              associated.wireless!.channel
            : "Disconnected"}
        </p>
      )}
      {!ap && (
        <details>
          <summary>Nearby networks</summary>
          {networks.map(({ ap, distance }) => (
            <button
              className="ns-button"
              key={ap.id}
              onClick={() => {
                const network = ap.wireless!;
                update({
                  ssid: network.ssid,
                  security: network.security,
                  key: undefined,
                });
              }}
            >
              {ap.wireless!.ssid} · channel {ap.wireless!.channel} ·{" "}
              {ap.wireless!.band ?? "2.4"} GHz · {Math.round(distance)} units
            </button>
          ))}
          {!networks.length && <p>No visible networks in range.</p>}
        </details>
      )}
      <form
        className="ns-config"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            const saved = parseWireless(draft, device.kind, device.ports);
            onCommit({
              ...topology,
              devices: topology.devices.map((d) =>
                d.id === device.id ? { ...d, wireless: saved } : d,
              ),
            });
            setError("");
          } catch (cause) {
            setError(
              cause instanceof Error
                ? cause.message
                : "Invalid radio settings.",
            );
          }
        }}
      >
        <label>
          SSID
          <input
            value={draft.ssid}
            maxLength={32}
            onChange={(e) => update({ ssid: e.target.value })}
          />
        </label>
        <label>
          Wireless security
          <select
            aria-label="Wireless security"
            value={draft.security}
            onChange={(e) =>
              update({
                security: e.target.value as WirelessSettings["security"],
                key: undefined,
              })
            }
          >
            <option value="open">Open</option>
            <option value="wpa2-personal">WPA2-Personal</option>
          </select>
        </label>
        <label>
          Radio band
          <select
            aria-label="Radio band"
            value={band ?? ""}
            onChange={(e) => selectBand(e.target.value)}
          >
            {!ap && <option value="">Both bands</option>}
            <option value="2.4">2.4 GHz</option>
            <option value="5">5 GHz</option>
          </select>
        </label>
        <label>
          Radio mode
          <select
            aria-label="Radio mode"
            value={draft.mode ?? "mixed"}
            onChange={(e) => update({ mode: e.target.value as RadioMode })}
          >
            {modes.map((m) => (
              <option key={m} value={m}>
                {m === "mixed" ? "Mixed" : "802.11" + m + " only"}
              </option>
            ))}
          </select>
        </label>
        {draft.security === "wpa2-personal" && (
          <label>
            Practice passphrase
            <input
              type="password"
              autoComplete="off"
              minLength={8}
              maxLength={63}
              required
              value={draft.key ?? ""}
              onChange={(e) => update({ key: e.target.value })}
            />
          </label>
        )}
        {ap && (
          <>
            <label>
              Radio channel
              <select
                aria-label="Radio channel"
                value={draft.channel}
                onChange={(e) => update({ channel: Number(e.target.value) })}
              >
                {channels[band ?? "2.4"].map((channel) => (
                  <option key={channel}>{channel}</option>
                ))}
              </select>
            </label>
            <label>
              Radio range (canvas units)
              <input
                type="number"
                required
                min={1}
                max={1500}
                value={draft.range}
                onChange={(e) => update({ range: Number(e.target.value) })}
              />
            </label>
            <label className="ns-checkbox">
              <input
                type="checkbox"
                checked={draft.broadcast}
                onChange={(e) => update({ broadcast: e.target.checked })}
              />
              Broadcast SSID
            </label>
          </>
        )}
        <button className="ns-button ns-primary">
          Apply wireless settings
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
