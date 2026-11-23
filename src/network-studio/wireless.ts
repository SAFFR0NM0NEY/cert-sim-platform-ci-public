import type {
  Device,
  DeviceKind,
  Port,
  Topology,
  WirelessSettings,
  RadioBand,
  RadioMode,
} from "./types.ts";
import { bool, integer, object } from "./validation.ts";

export const radioModes: readonly RadioMode[] = [
  "mixed",
  "a",
  "b",
  "g",
  "n",
  "ac",
];
const bands = { "2.4": ["b", "g", "n"], "5": ["a", "n", "ac"] } as const;
export function supportedModes(band: RadioBand): readonly RadioMode[] {
  return bands[band];
}
export const channels: Record<RadioBand, readonly number[]> = {
  "2.4": Array.from({ length: 11 }, (_, i) => i + 1),
  "5": [36, 40, 44, 48, 149, 153, 157, 161, 165],
};
function compatibleRadio(
  ap: WirelessSettings,
  client: WirelessSettings,
): boolean {
  const band = ap.band ?? "2.4";
  if (client.band && client.band !== band) return false;
  return supportedModes(band).some(
    (mode) =>
      (!ap.mode || ap.mode === "mixed" || ap.mode === mode) &&
      (!client.mode || client.mode === "mixed" || client.mode === mode),
  );
}
export const isWireless = (kind: DeviceKind) =>
  kind === "ap" || kind === "laptop";
export const addressable = (kind: DeviceKind) => kind !== "ap";
export const applicationHost = (kind: DeviceKind) =>
  addressable(kind) && kind !== "router" && kind !== "switch";

export function parseWireless(
  raw: unknown,
  kind: DeviceKind,
  ports: Port[],
): WirelessSettings | undefined {
  if (!isWireless(kind)) {
    if (raw !== undefined || ports.some((p) => p.media === "radio"))
      throw Error("Wireless settings require an access point or laptop.");
    return undefined;
  }
  const ap = kind === "ap";
  if (
    ports.length !== (ap ? 2 : 1) ||
    ports[0].id !== "p0" ||
    ports[0].media !== (ap ? "copper" : "radio") ||
    (ap &&
      (ports[1].id !== "p1" ||
        ports[1].media !== "radio" ||
        ports.some((p) => p.ip || p.ipv6 || p.addressMode === "dhcp")))
  )
    throw Error("Invalid wireless device interface inventory.");
  const w = object(raw);
  const band = w.band,
    mode = w.mode;
  if (band !== undefined && band !== "2.4" && band !== "5")
    throw Error("Select a supported radio band.");
  if (mode !== undefined && !radioModes.includes(mode as RadioMode))
    throw Error("Select a supported 802.11 mode.");
  const operatingBand = band ?? (ap ? "2.4" : undefined);
  if (
    operatingBand &&
    mode &&
    mode !== "mixed" &&
    !supportedModes(operatingBand).includes(mode as RadioMode)
  )
    throw Error("The selected radio mode does not support that band.");
  if (ap && !channels[band ?? "2.4"].includes(w.channel as number))
    throw Error("Select an available channel on the operating band.");
  if (
    typeof w.ssid !== "string" ||
    new TextEncoder().encode(w.ssid).length > 32 ||
    /[\u0000-\u001f]/.test(w.ssid)
  )
    throw Error("Use an SSID up to 32 bytes.");
  if (w.security !== "open" && w.security !== "wpa2-personal")
    throw Error("Select open or WPA2-Personal.");
  if (
    w.security === "wpa2-personal" &&
    (typeof w.key !== "string" || !/^[ -~]{8,63}$/.test(w.key))
  )
    throw Error("Use an 8–63 character practice passphrase.");
  if (w.security === "open" && w.key !== undefined)
    throw Error("Open wireless profiles have no key.");
  if (
    !ap &&
    (w.range !== undefined ||
      w.channel !== undefined ||
      w.broadcast !== undefined)
  )
    throw Error(
      "Set channel, range and beacon visibility on the access point.",
    );
  return {
    ssid: w.ssid,
    ...(band ? { band } : {}),
    ...(mode ? { mode: mode as RadioMode } : {}),
    security: w.security,
    ...(w.security === "wpa2-personal" ? { key: w.key as string } : {}),
    ...(ap
      ? {
          range: integer(w.range, 1, 1500),
          channel: w.channel as number,
          broadcast: bool(w.broadcast),
        }
      : {}),
  };
}
export function defaultWireless(kind: "ap" | "laptop"): WirelessSettings {
  return {
    ssid: kind === "ap" ? "CertSim Wi-Fi" : "",
    security: "open",
    ...(kind === "ap" ? { channel: 6, range: 300, broadcast: true } : {}),
  };
}
export function nearbyAccessPoints(t: Topology, client: Device) {
  if (client.kind !== "laptop" || !client.powered || !client.ports[0].enabled)
    return [];
  return t.devices
    .filter(
      (d) =>
        d.kind === "ap" &&
        d.powered &&
        d.ports[1]?.enabled &&
        d.wireless?.ssid &&
        client.wireless &&
        compatibleRadio(d.wireless, client.wireless),
    )
    .map((ap) => ({
      ap,
      distance: Math.hypot(ap.x - client.x, ap.y - client.y),
    }))
    .filter(({ ap, distance }) => distance <= ap.wireless!.range!)
    .sort((a, b) => a.distance - b.distance || a.ap.id.localeCompare(b.ap.id));
}
export function associatedAccessPoint(
  t: Topology,
  client: Device,
): Device | undefined {
  const config = client.wireless;
  if (!config?.ssid) return undefined;
  return nearbyAccessPoints(t, client).find(
    ({ ap }) =>
      ap.wireless!.ssid === config.ssid &&
      ap.wireless!.security === config.security &&
      ap.wireless!.key === config.key,
  )?.ap;
}
export function wirelessAssociations(t: Topology) {
  return t.devices.flatMap((client) => {
    if (client.kind !== "laptop") return [];
    const ap = associatedAccessPoint(t, client);
    return ap ? [{ client, ap }] : [];
  });
}
