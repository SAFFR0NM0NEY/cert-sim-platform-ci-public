import type { Device, Topology } from "./types.ts";
import { devicePdus } from "./vlanInterfaces.ts";
import { eraseStartup, reloadDevice, saveStartup } from "./deviceLifecycle.ts";
export function LifecyclePanel({
  device,
  topology,
  onCommit,
  onReload,
}: {
  device: Device;
  topology: Topology;
  onCommit: (t: Topology) => void;
  onReload: (t: Topology) => void;
}) {
  const update = (next: Device, reload = false) =>
    (reload ? onReload : onCommit)({
      ...topology,
      devices: topology.devices.map((d) => (d.id === device.id ? next : d)),
      ...(topology.pdus ? { pdus: devicePdus(topology, next) } : {}),
    });
  return (
    <section className="ns-lifecycle" aria-label="Device startup configuration">
      <h3>Startup configuration</h3>
      <p>
        {device.startupConfig
          ? "A startup copy is saved. Reload restores it."
          : "No startup copy saved. Reload restores factory settings."}
      </p>
      <div>
        <button
          className="ns-button"
          disabled={!device.powered}
          onClick={() => update(saveStartup(device))}
        >
          Save startup
        </button>
        <button
          className="ns-button"
          onClick={() => update(reloadDevice(device), true)}
        >
          Reload device
        </button>
        <button
          className="ns-link-button ns-danger-text"
          disabled={!device.startupConfig}
          onClick={() => update(eraseStartup(device))}
        >
          Erase startup
        </button>
      </div>
      <small>
        Reload keeps device identity, physical interfaces and placement. DHCP
        addresses require renewal after reload. Undo can restore the previous
        state.
      </small>
    </section>
  );
}
