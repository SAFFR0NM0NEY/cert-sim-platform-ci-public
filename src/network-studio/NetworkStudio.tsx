import {
  addPackageFiles,
  checkNative,
  downloadFile,
  downloadPackageFile,
  isNativeLauncher,
  nativeActivity,
  NATIVE_STUDIO_URL,
  openNative,
  packageBackground,
  packageFileSource,
  packageResources,
  removePackageFile,
  saveNative,
  setPackageBackground,
} from "./nativeFiles.ts";
import {
  backgroundImage,
  isBackgroundName,
  LogicalBackground,
} from "./PackageBackground.tsx";
import { applicationHost, addressable } from "./wireless.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent } from "react";
import type {
  Cable,
  CliSession,
  Device,
  DeviceKind,
  NativeFile,
  PingResult,
  Topology,
  UserPdu,
} from "./types.ts";
import {
  blankTopology,
  connect,
  createDevice,
  DEVICE_LABELS,
  exampleTopology,
  isOccupied,
  serialRates,
  serialRole,
  linkError,
  MAX_DEVICES,
} from "./model.ts";
import { configurationError, ping } from "./engine.ts";
import { interfaceMetric } from "./routing.ts";
import { command, INITIAL_CLI, prompt } from "./cli.ts";
import {
  MAX_FILE_BYTES,
  parseTopology,
  serializeTopology,
  STORAGE_KEY,
} from "./persistence.ts";
import { DeviceIcon } from "./icons.tsx";
import "./studio.css";
import "./advanced.css";
import {
  ClientTools,
  PolicyPanel,
  RoutingPanel,
  ServicesPanel,
} from "./AdvancedPanels.tsx";
import type { ServiceResult } from "./services.ts";
import { requestDhcp } from "./services.ts";
import {
  servicesLab,
  dhcpRelayLab,
  routingLab,
  wirelessLab,
  wirelessRepairLab,
  dualStackLab,
  serialWanLab,
  redundantLab,
  bpduGuardLab,
  natLab,
  natPoolsLab,
  secureVlansLab,
  officePhoneLab,
  routerOnAStickLab,
  multilayerSwitchLab,
  vtpCampusLab,
  etherChannelLab,
  etherChannelRepairLab,
  dtpRepairLab,
  eigrpRepairLab,
  nativePolicyLab,
} from "./labs.ts";
import { ping6 } from "./ipv6Engine.ts";
import { IPv6Panel } from "./IPv6Panel.tsx";
import { PhysicalPanel, CableLengthControl } from "./PhysicalPanel.tsx";
import { removeDevice, linkStatus } from "./model.ts";
import "./physical.css";
import { LifecyclePanel } from "./LifecyclePanel.tsx";
import { AnnotationControls, AnnotationLayer } from "./AnnotationWorkspace.tsx";
import type { DrawingTool } from "./AnnotationWorkspace.tsx";
import { SpanningTreePanel } from "./SpanningTreePanel.tsx";
import {
  RuntimeContext,
  RuntimeControls,
  MacPanel,
  NeighborCachePanel,
  useNetworkRuntime,
} from "./RuntimePanels.tsx";
import {
  createRuntime,
  resetRuntime,
  adoptRuntime,
  bindRuntime,
} from "./networkRuntime.ts";
import { CallManagerPanel, PhonePanel } from "./PhonePanel.tsx";
import { DiscoveryPanel } from "./DiscoveryPanel.tsx";
import { discoveryCapable } from "./discovery.ts";

import { automaticConnection } from "./hardware.ts";
import { ActivityPanel } from "./ActivityPanel.tsx";
import { WirelessPanel } from "./WirelessPanel.tsx";
import { isWireless, wirelessAssociations } from "./wireless.ts";
import { HardwarePanel } from "./HardwarePanel.tsx";
import { PduPanel } from "./PduPanel.tsx";
import { advanceWorkspaceClock } from "./workspaceClock.ts";
import { MAX_PDUS, runPdu } from "./pdus.ts";
import { NatPanel } from "./NatPanel.tsx";
import { materializeSecurity } from "./portSecurity.ts";
import { LogicalInterfaceControls } from "./LogicalInterfaceControls.tsx";
import {
  devicePdus,
  isPacketEndpoint,
  isRoutedInterface,
  isSwitchport,
  packetInterfaces,
} from "./vlanInterfaces.ts";
import { materializeVlans, setSwitchport, ensureAccessVlan } from "./vlans.ts";
import { synchronizeVtp } from "./vtp.ts";
import { VlansPanel } from "./VlansPanel.tsx";
import { EtherChannelPanel } from "./EtherChannelPanel.tsx";
import { SwitchportStatus } from "./SwitchportStatus.tsx";
import { reconcilePortChannels } from "./etherChannel.ts";
import { portOperational } from "./ethernet.ts";
import { natConflict } from "./nat.ts";
import { clearBpduState, synchronizeBpduGuard } from "./bpduGuard.ts";

type History = { past: Topology[]; present: Topology; future: Topology[] };
function loadInitial(): { topology: Topology; warning: string } {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return {
      topology: saved ? parseTopology(saved) : exampleTopology(),
      warning: "",
    };
  } catch {
    return {
      topology: exampleTopology(),
      warning:
        "Saved workspace could not be loaded. The example is open; your previous saved data will be kept until you edit.",
    };
  }
}
const clamp = (n: number, min: number, max: number) =>
  Math.round(Math.max(min, Math.min(max, n)));

export default function NetworkStudio() {
  const runtime = useMemo(createRuntime, []);
  const [runtimeVersion, setRuntimeVersion] = useState(0);
  const refreshRuntime = () => setRuntimeVersion((v) => v + 1);
  const initial = useMemo(loadInitial, []);
  const [history, setHistory] = useState<History>({
    past: [],
    present: initial.topology,
    future: [],
  });
  const topology = history.present;
  const activityFile = nativeActivity(topology);
  const resources = packageResources(topology);
  const background = packageBackground(topology);
  const backgroundSource =
    background && isBackgroundName(background.name)
      ? packageFileSource(topology, background.name)
      : undefined;
  const airLinks = useMemo(() => wirelessAssociations(topology), [topology]);
  useEffect(() => {
    bindRuntime(runtime, topology);
    setRuntimeVersion((v) => v + 1);
  }, [runtime, topology]);
  useEffect(() => {
    const next = materializeSecurity(topology, runtime);
    if (next !== topology) commit(next, true, true);
  }, [topology, runtimeVersion]);
  const [selected, setSelected] = useState(topology.devices[0]?.id ?? "");
  const [workspaceView, setWorkspaceView] = useState<"logical" | "physical">(
    "logical",
  );
  const [tool, setTool] = useState<"select" | "connect" | "annotate" | "pdu">(
    "select",
  );
  const [drawingTool, setDrawingTool] = useState<DrawingTool>("select");
  const [selectedAnnotation, setSelectedAnnotation] = useState("");
  const [connectFrom, setConnectFrom] = useState("");
  const [cablePair, setCablePair] = useState<[string, string] | null>(null);
  const [zoom, setZoom] = useState(1);
  const [notice, setNotice] = useState(initial.warning);
  const [saveStatus, setSaveStatus] = useState("Local practice");
  const [result, setResult] = useState<PingResult | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [mode, setMode] = useState<"realtime" | "simulation">("simulation");
  const [filter, setFilter] = useState("all");
  const [eventIndex, setEventIndex] = useState<number | null>(null);
  const [nativePreview, setNativePreview] = useState<{
    file: File;
    format: NativeFile["format"];
    pages: string[];
  } | null>(null);
  const [nativeBusy, setNativeBusy] = useState(false);
  const [fileError, setFileError] = useState("");
  const [fileTools, setFileTools] = useState(false);
  const [help, setHelp] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(
    null,
  );
  const dragOrigin = useRef<{
    id: string;
    x: number;
    y: number;
    sx: number;
    sy: number;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const hasEdited = useRef(false);
  const currentDevice = topology.devices.find((d) => d.id === selected);
  const activeEvent = result?.events[Math.max(0, cursor - 1)];
  const detailEvent =
    eventIndex === null ? activeEvent : result?.events[eventIndex];

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const fit = () =>
      setZoom(Math.min(1, Math.max(0.65, el.clientWidth / 1120)));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [workspaceView]);

  function clearSimulation() {
    setPlaying(false);
    setResult(null);
    setCursor(0);
    setEventIndex(null);
  }
  function commit(
    next: Topology,
    preserveRuntime = false,
    preserveSimulation = false,
    syncProtocols = true,
    resetProtectionFor?: string,
    bypassChannelReconcile = false,
  ) {
    const candidate = structuredClone(runtime);
    try {
      if (syncProtocols && !bypassChannelReconcile)
        next = {
          ...next,
          devices: next.devices.map((d) => {
            const before = topology.devices.find(
              (previous) => previous.id === d.id,
            );
            return before ? reconcilePortChannels(before, d) : d;
          }),
        };
      parseTopology(serializeTopology(next));
      if (preserveRuntime) adoptRuntime(candidate, next);
      else resetRuntime(candidate, next, { preserveProtection: syncProtocols });
      if (resetProtectionFor) clearBpduState(candidate, resetProtectionFor);
      if (syncProtocols) {
        synchronizeBpduGuard(next, candidate);
        next = synchronizeVtp(next, candidate);
        adoptRuntime(candidate, next);
      }
      const conflict = natConflict(next);
      if (conflict) throw Error(conflict);
      parseTopology(serializeTopology(next));
    } catch (error) {
      setNotice(
        `${error instanceof Error ? error.message : "Workspace change rejected."} The previous network is unchanged.`,
      );
      return false;
    }
    hasEdited.current = true;
    Object.assign(runtime, candidate);
    setHistory((h) => ({
      past: [...h.past, h.present].slice(-40),
      present: next,
      future: [],
    }));
    if (!preserveSimulation) clearSimulation();
    setNotice("");
    setConnectFrom("");
    return next;
  }
  function undo() {
    resetRuntime(runtime);
    hasEdited.current = true;
    setHistory((h) =>
      h.past.length
        ? {
            past: h.past.slice(0, -1),
            present: h.past[h.past.length - 1],
            future: [h.present, ...h.future].slice(0, 40),
          }
        : h,
    );
    clearSimulation();
    setConnectFrom("");
    setCablePair(null);
  }
  function redo() {
    resetRuntime(runtime);
    hasEdited.current = true;
    setHistory((h) =>
      h.future.length
        ? {
            past: [...h.past, h.present].slice(-40),
            present: h.future[0],
            future: h.future.slice(1),
          }
        : h,
    );
    clearSimulation();
    setConnectFrom("");
    setCablePair(null);
  }
  useEffect(() => {
    if (!hasEdited.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, serializeTopology(topology));
      setSaveStatus("Saved on this device");
    } catch {
      setSaveStatus("Autosave unavailable — export to keep changes");
    }
  }, [topology, initial]);
  useEffect(() => {
    if (!playing || !result) return;
    const timer = window.setInterval(
      () => setCursor((c) => Math.min(c + 1, result.events.length)),
      600,
    );
    return () => clearInterval(timer);
  }, [playing, result]);
  useEffect(() => {
    if (result && cursor >= result.events.length) setPlaying(false);
  }, [cursor, result]);
  useEffect(() => {
    if (!currentDevice) setSelected("");
  }, [currentDevice]);

  function add(kind: DeviceKind) {
    if (topology.devices.length >= MAX_DEVICES) {
      setNotice("Workspace supports up to 128 devices.");
      return;
    }
    let index = 1;
    while (
      topology.devices.some((d) => d.name === `${DEVICE_LABELS[kind]}-${index}`)
    )
      index++;
    let d = createDevice(
      kind,
      index,
      160 + (topology.devices.length % 5) * 170,
      110 + (Math.floor(topology.devices.length / 5) % 4) * 140,
    );
    if (kind === "switch") d = materializeVlans(d);
    commit({ ...topology, devices: [...topology.devices, d] });
    setSelected(d.id);
    setTool("select");
  }
  function addPdu(definition: UserPdu) {
    if ((topology.pdus?.length ?? 0) >= MAX_PDUS) {
      setNotice(
        "The workspace supports up to " + MAX_PDUS + " user-created PDUs.",
      );
      return;
    }
    if (topology.activeScenario)
      definition = { ...definition, scenario: topology.activeScenario };
    const next = commit(
      { ...topology, pdus: [...(topology.pdus ?? []), definition] },
      true,
    );
    if (!next) return;
    if (definition.schedule) {
      if (definition.schedule.delay === 0) {
        const provisioned = advanceWorkspaceClock(runtime, next, 0);
        const result = runtime.pduResults.get(definition.id);
        if (result)
          handleOperation(
            result,
            provisioned === next ? undefined : provisioned,
          );
      }
      return;
    }
    handleOperation(runPdu(next, definition, runtime));
  }
  function chooseDevice(id: string) {
    if (tool === "pdu") {
      const d = topology.devices.find((d) => d.id === id)!;
      const ports = packetInterfaces(d);
      if (!isPacketEndpoint(d) || !ports.some((p) => p.ip || p.ipv6)) {
        setNotice("Choose a device with a configured IP address.");
        return;
      }
      if (!connectFrom) {
        setConnectFrom(id);
        setNotice("");
        return;
      }
      const source = topology.devices.find(
        (device) => device.id === connectFrom,
      );
      const preferredPort = (family: "ip" | "ipv6") =>
        source && packetInterfaces(source).some((p) => p[family])
          ? (ports.find((p) => p.enabled && p[family]) ??
            ports.find((p) => p[family]))
          : undefined;
      const v4 = preferredPort("ip"),
        nic = v4 ?? preferredPort("ipv6");
      if (!nic) {
        setNotice(
          "Select a destination with the same IP address family as the source.",
        );
        return;
      }
      addPdu({
        id: crypto.randomUUID(),
        source: connectFrom,
        target: id,
        port: nic.id,
        protocol: v4 ? "icmp" : "icmpv6",
      });
      setConnectFrom("");
      setTool("select");
      return;
    }
    if (tool === "connect") {
      if (!connectFrom) setConnectFrom(id);
      else if (connectFrom !== id) {
        setCablePair([connectFrom, id]);
        setConnectFrom("");
      }
    } else setSelected(id);
  }
  function dragStart(event: PointerEvent<HTMLButtonElement>, d: Device) {
    if (tool !== "select" || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragOrigin.current = {
      id: d.id,
      x: d.x,
      y: d.y,
      sx: event.clientX,
      sy: event.clientY,
    };
  }
  function dragMove(event: PointerEvent<HTMLButtonElement>) {
    const o = dragOrigin.current;
    if (
      !o ||
      (Math.abs(event.clientX - o.sx) < 4 && Math.abs(event.clientY - o.sy) < 4)
    )
      return;
    setDrag({
      id: o.id,
      x: clamp(o.x + (event.clientX - o.sx) / zoom, 40, 1080),
      y: clamp(o.y + (event.clientY - o.sy) / zoom, 50, 650),
    });
  }
  function dragEnd(event: PointerEvent<HTMLButtonElement>) {
    const origin = dragOrigin.current;
    if (
      origin &&
      (Math.abs(event.clientX - origin.sx) >= 4 ||
        Math.abs(event.clientY - origin.sy) >= 4)
    )
      commit({
        ...topology,
        devices: topology.devices.map((d) =>
          d.id === origin.id
            ? {
                ...d,
                x: clamp(
                  origin.x + (event.clientX - origin.sx) / zoom,
                  40,
                  1080,
                ),
                y: clamp(
                  origin.y + (event.clientY - origin.sy) / zoom,
                  50,
                  650,
                ),
              }
            : d,
        ),
      });
    dragOrigin.current = null;
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function runPing(
    source: string,
    destination: string,
    family: "ipv4" | "ipv6" = "ipv4",
    port?: string,
  ) {
    const next =
      family === "ipv6"
        ? ping6(topology, source, destination, port || undefined, runtime)
        : ping(topology, source, destination, runtime);
    refreshRuntime();
    setResult(next);
    setEventIndex(null);
    setCursor(mode === "realtime" ? next.events.length : 0);
    setPlaying(false);
  }
  function handleOperation(result: ServiceResult, next?: Topology) {
    if (next && !commit(next, true)) return;
    refreshRuntime();
    setResult(result);
    setCursor(mode === "realtime" ? result.events.length : 0);
    setPlaying(false);
    setEventIndex(null);
  }
  function exportFile() {
    downloadFile(
      new Blob([serializeTopology(topology)], { type: "application/json" }),
      filename("certsim.json"),
    );
  }
  function filename(suffix: string) {
    return (
      (topology.name.replace(/[^a-z0-9_-]/gi, "-").slice(0, 60) || "network") +
      "." +
      suffix
    );
  }
  async function addResources(files: File[], replaceName?: string) {
    if (!files.length) return;
    setNativeBusy(true);
    setFileError("");
    try {
      const next = await addPackageFiles(topology, files, replaceName);
      if (replaceName && background?.name === replaceName) {
        const source = packageFileSource(next, replaceName);
        if (source) await backgroundImage(source);
      }
      if (!commit(next, true, true))
        throw Error("The package files exceed this workspace’s storage limit.");
    } catch (error) {
      setFileError(
        error instanceof Error
          ? error.message
          : "Could not add the package files.",
      );
    } finally {
      setNativeBusy(false);
    }
  }
  async function downloadResource(name: string) {
    setNativeBusy(true);
    setFileError("");
    try {
      await downloadPackageFile(topology, name);
    } catch (error) {
      setFileError(
        error instanceof Error
          ? error.message
          : "Could not download the package file.",
      );
    } finally {
      setNativeBusy(false);
    }
  }
  async function chooseBackground(name: string) {
    setFileError("");
    if (!name) {
      commit(setPackageBackground(topology, null), true, true);
      return;
    }
    setNativeBusy(true);
    try {
      const source = packageFileSource(topology, name);
      if (!source) throw Error("The image is missing from this package.");
      await backgroundImage(source);
      commit(
        setPackageBackground(topology, {
          name,
          tiled: background?.tiled ?? false,
        }),
        true,
        true,
      );
    } catch (error) {
      setFileError(
        error instanceof Error
          ? error.message
          : "Could not display the package background.",
      );
    } finally {
      setNativeBusy(false);
    }
  }
  async function savePacketTracer(format: NativeFile["format"]) {
    setNativeBusy(true);
    setFileError("");
    try {
      const blob = await saveNative(topology, format);
      if (format === "pkz") {
        const opened = await openNative(
          new File([blob], filename(format)),
          format,
        );
        if (opened.readOnly)
          throw Error("The saved package requires Cisco Packet Tracer.");
        if (
          topology.packageEdits ||
          opened.topology.nativeFile?.key !== topology.nativeFile?.key
        ) {
          if (!commit(opened.topology, false, false, false))
            throw Error(
              "Could not retain the saved package in this workspace.",
            );
          const previous = topology.devices.find((d) => d.id === selected);
          const next = opened.topology.devices.find(
            (d) => d.id === selected || d.name === previous?.name,
          );
          setSelected(next?.id ?? opened.topology.devices[0]?.id ?? "");
        }
      }
      downloadFile(blob, filename(format));
      setFileTools(false);
      setNotice("Downloaded " + filename(format) + ".");
    } catch (e) {
      setFileError(e instanceof Error ? e.message : "Native save failed.");
    } finally {
      setNativeBusy(false);
    }
  }
  async function checkNativeActivity() {
    setNativeBusy(true);
    try {
      const { earned, total, unmapped } = await checkNative(topology);
      const score = total
        ? "Earned " + earned + " of " + total + " supported assessment points."
        : "This activity has no supported points to score.";
      setNotice(
        score +
          (unmapped
            ? " " + unmapped + " additional items require Packet Tracer."
            : ""),
      );
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Could not check the activity.",
      );
    } finally {
      setNativeBusy(false);
    }
  }
  async function importFile(file?: File) {
    if (!file) return;
    setNativeBusy(true);
    try {
      const ext = file.name.split(".").pop()?.toLowerCase();
      let imported: Topology;
      let details = "";
      if (ext === "pkt" || ext === "pka" || ext === "pkz") {
        const opened = await openNative(file, ext);
        if (opened.readOnly) {
          setNativePreview({ file, format: ext, pages: opened.pages });
          return;
        }
        imported = opened.topology;
        details = opened.details;
      } else {
        if (file.size > MAX_FILE_BYTES)
          throw new Error("Workspace exceeds the 2 MiB limit.");
        imported = parseTopology(await file.text());
      }
      if (!commit(imported, false, false, false)) return;
      setSelected(imported.devices[0]?.id ?? "");
      setNotice(
        `Opened “${imported.name}”. Undo restores your previous workspace.${details}`,
      );
    } catch (error) {
      setNotice(
        `Import failed: ${error instanceof Error ? error.message : "Invalid workspace"}. Your current network is unchanged.`,
      );
    } finally {
      if (fileInput.current) fileInput.current.value = "";
      setNativeBusy(false);
    }
  }
  const pos = (d: Device) => (drag?.id === d.id ? drag : d);
  const named = (id: string) =>
    topology.devices.find((d) => d.id === id)?.name ?? "Unknown";
  const shownEvents = (result?.events ?? [])
    .slice(0, cursor)
    .filter((e) => filter === "all" || e.protocol === filter);

  return (
    <RuntimeContext.Provider value={{ runtime, refresh: refreshRuntime }}>
      <div className="ns-app">
        <header className="ns-header">
          <a href="/" className="ns-brand" aria-label="CertSim Platform home">
            <img
              src="/brand/certsim-platform-wordmark-dark-display.png"
              alt="CertSim Platform"
            />
          </a>
          <div className="ns-header-divider" />
          <div>
            <strong>Network Studio</strong>
            <span className="ns-subtitle">Build. Configure. Understand.</span>
          </div>
          <span className="ns-practice-badge">
            <span />
            Practice workspace
          </span>
          <button
            className="ns-button ns-help-button"
            onClick={() => setHelp(true)}
          >
            Workspace guide <span aria-hidden="true">↗</span>
          </button>
        </header>
        <main>
          <div className="ns-heading">
            <div>
              <span className="ns-eyebrow">NETWORKING LAB</span>
              <h1>Your network, explained.</h1>
              <p>
                Bring a topology to life. Follow every hop and find what makes
                it work.
              </p>
            </div>
            <div className="ns-save">
              <span className="ns-dot" />
              {saveStatus}
            </div>
          </div>
          <section className="ns-workspace" aria-label="Network workspace">
            <div className="ns-project-bar">
              <label className="ns-project-name">
                <span aria-hidden="true">◇</span>
                <input
                  aria-label="Network name"
                  value={topology.name}
                  maxLength={80}
                  onChange={(e) => {
                    if (e.target.value.trim())
                      commit({ ...topology, name: e.target.value });
                  }}
                />
                <span className="ns-version">NETWORK LAB</span>
              </label>
              <div className="ns-actions">
                <button
                  className="ns-button"
                  onClick={() => {
                    commit(blankTopology());
                    setSelected("");
                  }}
                >
                  New
                </button>
                <button
                  className="ns-button"
                  disabled={nativeBusy}
                  onClick={() => fileInput.current?.click()}
                >
                  Open
                </button>
                <button
                  className="ns-button"
                  onClick={() => setActivityOpen(true)}
                >
                  Practice activity
                </button>
                <button className="ns-button ns-primary" onClick={exportFile}>
                  Export network <span aria-hidden="true">↓</span>
                </button>
                <button
                  className="ns-button"
                  disabled={nativeBusy}
                  onClick={() => {
                    setFileError("");
                    setFileTools(true);
                  }}
                >
                  {nativeBusy ? "Processing file…" : "Packet Tracer files"}
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  accept=".json,.pkt,.pka,.pkz"
                  hidden
                  onChange={(e) => void importFile(e.target.files?.[0])}
                />
              </div>
            </div>
            {activityFile && (
              <details className="ns-native-instructions">
                <summary>Activity instructions</summary>
                {activityFile.pages.some(Boolean) ? (
                  activityFile.pages.map((page, i) => <p key={i}>{page}</p>)
                ) : (
                  <p>This activity has no written instructions.</p>
                )}
                <button
                  className="ns-button"
                  disabled={nativeBusy}
                  onClick={() => void checkNativeActivity()}
                >
                  Check native activity
                </button>
              </details>
            )}
            {notice && (
              <div className="ns-notice" role="status">
                {notice}
                <button
                  aria-label="Dismiss message"
                  onClick={() => setNotice("")}
                >
                  ×
                </button>
              </div>
            )}
            <div className="ns-workspace-grid">
              <aside className="ns-palette" aria-label="Device palette">
                <div className="ns-panel-label">DEVICE LIBRARY</div>
                <h2>Start with a device</h2>
                <p>Add a device, then connect its ports.</p>
                <div className="ns-device-library">
                  {(
                    [
                      "router",
                      "switch",
                      "pc",
                      "server",
                      "phone",
                      "ap",
                      "laptop",
                    ] as DeviceKind[]
                  ).map((kind) => (
                    <button
                      key={kind}
                      className={`ns-device-card ns-kind-${kind}`}
                      onClick={() => add(kind)}
                    >
                      <span className="ns-device-card-icon">
                        <DeviceIcon kind={kind} size={31} />
                      </span>
                      <span>
                        <strong>{DEVICE_LABELS[kind]}</strong>
                        <small>
                          {kind === "router"
                            ? "Route between networks"
                            : kind === "switch"
                              ? "Connect your LAN"
                              : kind === "pc"
                                ? "Configure an endpoint"
                                : kind === "phone"
                                  ? "Connect voice and a workstation"
                                  : kind === "ap"
                                    ? "Bridge wireless clients"
                                    : kind === "laptop"
                                      ? "Join a wireless network"
                                      : "Add a server endpoint"}
                        </small>
                      </span>
                      <b aria-hidden="true">+</b>
                    </button>
                  ))}
                </div>
                <div className="ns-library-note">
                  <span className="ns-eyebrow">FIRST STEPS</span>
                  <ol>
                    <li>Add and arrange your devices.</li>
                    <li>Connect available ports.</li>
                    <li>Configure IPs and send a ping.</li>
                  </ol>
                  <button
                    className="ns-button"
                    onClick={() => {
                      const next = exampleTopology();
                      commit(next);
                      setSelected(next.devices[0].id);
                    }}
                  >
                    Load example LAN <span aria-hidden="true">→</span>
                  </button>
                </div>
                <p className="ns-library-footnote">
                  Generic educational models.
                  <br />
                  See the guide for supported features.
                </p>
              </aside>
              <div
                className={`ns-center ${tool === "annotate" ? "ns-drawing" : ""}`}
              >
                <div
                  className="ns-workspace-views"
                  role="group"
                  aria-label="Workspace view"
                >
                  <button
                    aria-pressed={workspaceView === "logical"}
                    onClick={() => setWorkspaceView("logical")}
                  >
                    Logical
                  </button>
                  <button
                    aria-pressed={workspaceView === "physical"}
                    onClick={() => {
                      setWorkspaceView("physical");
                      setTool("select");
                      setConnectFrom("");
                    }}
                  >
                    Physical
                  </button>
                </div>
                {workspaceView === "physical" ? (
                  <PhysicalPanel
                    topology={topology}
                    onCommit={commit}
                    onSelect={setSelected}
                  />
                ) : (
                  <>
                    <div className="ns-canvas-toolbar">
                      <div className="ns-tool-group">
                        <button
                          aria-pressed={tool === "select"}
                          className="ns-button"
                          onClick={() => {
                            setTool("select");
                            setConnectFrom("");
                          }}
                        >
                          <span aria-hidden="true">↖</span> Select
                        </button>
                        <button
                          aria-pressed={tool === "connect"}
                          className="ns-button"
                          onClick={() => {
                            setTool("connect");
                            setConnectFrom("");
                          }}
                        >
                          <span aria-hidden="true">⌁</span> Connect
                        </button>
                        <button
                          aria-pressed={tool === "pdu"}
                          className="ns-button"
                          onClick={() => {
                            setTool("pdu");
                            setConnectFrom("");
                          }}
                        >
                          Add Simple PDU
                        </button>
                        <button
                          aria-pressed={tool === "annotate"}
                          className="ns-button"
                          onClick={() => {
                            setTool("annotate");
                            setConnectFrom("");
                          }}
                        >
                          Draw
                        </button>
                      </div>
                      <div className="ns-tool-group">
                        <button
                          className="ns-icon-button"
                          aria-label="Undo"
                          disabled={!history.past.length}
                          onClick={undo}
                        >
                          ↶
                        </button>
                        <button
                          className="ns-icon-button"
                          aria-label="Redo"
                          disabled={!history.future.length}
                          onClick={redo}
                        >
                          ↷
                        </button>
                        <span className="ns-toolbar-rule" />
                        <button
                          className="ns-icon-button"
                          aria-label="Zoom out"
                          onClick={() =>
                            setZoom((z) => Math.max(0.3, +(z - 0.1).toFixed(1)))
                          }
                        >
                          −
                        </button>
                        <button
                          className="ns-button ns-zoom"
                          onClick={() =>
                            setZoom(
                              Math.min(
                                1,
                                Math.max(
                                  0.3,
                                  (canvas.current?.clientWidth ?? 1120) / 1120,
                                ),
                              ),
                            )
                          }
                          title="Fit canvas"
                        >
                          {Math.round(zoom * 100)}%
                        </button>
                        <button
                          className="ns-icon-button"
                          aria-label="Zoom in"
                          onClick={() =>
                            setZoom((z) => Math.min(1.5, +(z + 0.1).toFixed(1)))
                          }
                        >
                          +
                        </button>
                      </div>
                    </div>
                    {tool === "annotate" && (
                      <AnnotationControls
                        topology={topology}
                        selected={selectedAnnotation}
                        onSelect={setSelectedAnnotation}
                        onCommit={commit}
                        tool={drawingTool}
                        onTool={setDrawingTool}
                      />
                    )}
                    <div
                      className={`ns-canvas-scroll ${tool === "connect" ? "ns-connecting" : ""}`}
                      ref={canvas}
                      tabIndex={0}
                      aria-label="Scrollable network canvas"
                    >
                      <div
                        className="ns-canvas"
                        style={{ width: 1120 * zoom, height: 710 * zoom }}
                      >
                        <div
                          className="ns-canvas-inner"
                          style={{ transform: `scale(${zoom})` }}
                        >
                          {background && backgroundSource && (
                            <LogicalBackground
                              key={JSON.stringify([
                                backgroundSource.packaged,
                                backgroundSource.key,
                                backgroundSource.name,
                              ])}
                              source={backgroundSource}
                              tiled={background.tiled}
                              onError={setNotice}
                            />
                          )}
                          <AnnotationLayer
                            topology={topology}
                            selected={selectedAnnotation}
                            onSelect={setSelectedAnnotation}
                            onCommit={commit}
                            enabled={tool === "annotate"}
                            tool={drawingTool}
                            onTool={setDrawingTool}
                            onError={setNotice}
                          />
                          <svg
                            className="ns-links"
                            width="1120"
                            height="710"
                            aria-label="Network cables"
                          >
                            {airLinks.map(({ client, ap }) => {
                              const a = pos(client),
                                b = pos(ap);
                              return (
                                <line
                                  key={client.id}
                                  className="ns-air-link"
                                  x1={a.x}
                                  y1={a.y}
                                  x2={b.x}
                                  y2={b.y}
                                >
                                  <title>
                                    {client.name} associated with {ap.name}
                                  </title>
                                </line>
                              );
                            })}
                            {topology.links.map((link) => {
                              const a = topology.devices.find(
                                  (d) => d.id === link.a.device,
                                ),
                                b = topology.devices.find(
                                  (d) => d.id === link.b.device,
                                );
                              if (!a || !b) return null;
                              const ap = pos(a),
                                bp = pos(b),
                                up = linkStatus(topology, link, runtime).up;
                              const active =
                                cursor > 0 &&
                                activeEvent !== undefined &&
                                (activeEvent.link !== undefined
                                  ? activeEvent.link === link.id
                                  : activeEvent.protocol === "ICMP" &&
                                    ((activeEvent.from === a.id &&
                                      activeEvent.to === b.id) ||
                                      (activeEvent.from === b.id &&
                                        activeEvent.to === a.id)));
                              return (
                                <g key={link.id}>
                                  <line
                                    data-link-id={link.id}
                                    x1={ap.x}
                                    y1={ap.y}
                                    x2={bp.x}
                                    y2={bp.y}
                                    className={`ns-cable ${up ? "up" : "down"} ${active ? "active" : ""} ${link.cable}`}
                                  />
                                  <circle
                                    cx={ap.x * 0.85 + bp.x * 0.15}
                                    cy={ap.y * 0.85 + bp.y * 0.15}
                                    r="4"
                                    fill={up ? "#34d399" : "#fb7185"}
                                  />
                                  <circle
                                    cx={ap.x * 0.15 + bp.x * 0.85}
                                    cy={ap.y * 0.15 + bp.y * 0.85}
                                    r="4"
                                    fill={up ? "#34d399" : "#fb7185"}
                                  />
                                  <title>
                                    {a.name} {link.a.port} ↔ {b.name}{" "}
                                    {link.b.port}:{" "}
                                    {linkStatus(topology, link, runtime).reason}
                                  </title>
                                </g>
                              );
                            })}
                          </svg>
                          {topology.devices.map((d) => {
                            const p = pos(d);
                            return (
                              <button
                                key={d.id}
                                className={`ns-node ns-kind-${d.kind} ${selected === d.id ? "selected" : ""} ${connectFrom === d.id ? "connecting" : ""} ${!d.powered ? "off" : ""} ${cursor > 0 && activeEvent?.to === d.id ? "packet-active" : ""}`}
                                style={{ left: p.x, top: p.y } as CSSProperties}
                                onClick={() => chooseDevice(d.id)}
                                onPointerDown={(e) => dragStart(e, d)}
                                onPointerMove={dragMove}
                                onPointerUp={dragEnd}
                                onPointerCancel={() => {
                                  dragOrigin.current = null;
                                  setDrag(null);
                                }}
                                onKeyDown={(e) => {
                                  const delta: Record<
                                    string,
                                    [number, number]
                                  > = {
                                    ArrowLeft: [-10, 0],
                                    ArrowRight: [10, 0],
                                    ArrowUp: [0, -10],
                                    ArrowDown: [0, 10],
                                  };
                                  if (delta[e.key] && tool === "select") {
                                    e.preventDefault();
                                    const [dx, dy] = delta[e.key];
                                    commit({
                                      ...topology,
                                      devices: topology.devices.map((n) =>
                                        n.id === d.id
                                          ? {
                                              ...n,
                                              x: clamp(n.x + dx, 40, 1080),
                                              y: clamp(n.y + dy, 50, 650),
                                            }
                                          : n,
                                      ),
                                    });
                                  }
                                }}
                                aria-label={`${d.name}, ${DEVICE_LABELS[d.kind]}${!d.powered ? ", powered off" : ""}`}
                                aria-pressed={selected === d.id}
                              >
                                <span className="ns-node-symbol">
                                  <DeviceIcon kind={d.kind} />
                                  <i className={d.powered ? "online" : ""} />
                                </span>
                                <strong>{d.name}</strong>
                                <small>
                                  {d.ports.find((p) => p.ip)?.ip ||
                                    d.ports.find((p) => p.ipv6)?.ipv6 ||
                                    (d.kind === "ap"
                                      ? d.wireless?.ssid || "Radio unconfigured"
                                      : d.kind === "switch"
                                        ? "Layer 2 switch"
                                        : "Not configured")}
                                </small>
                              </button>
                            );
                          })}
                          {!topology.devices.length && (
                            <div className="ns-empty-canvas">
                              <DeviceIcon kind="router" size={62} />
                              <h2>A blank canvas for your next network.</h2>
                              <p>Add a device from the library to begin.</p>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="ns-canvas-status">
                      <span>
                        <i className="ns-dot" />
                        Logical workspace
                      </span>
                      <span>
                        {topology.devices.length} devices ·{" "}
                        {topology.links.length} connections
                      </span>
                      <span>
                        {tool === "connect" || tool === "pdu"
                          ? connectFrom
                            ? `Choose a destination for ${named(connectFrom)}`
                            : "Choose a source device"
                          : "Drag to arrange · Arrow keys to move"}
                      </span>
                    </div>
                  </>
                )}
              </div>
              <aside className="ns-inspector" aria-label="Device inspector">
                {currentDevice ? (
                  <DeviceInspector
                    key={currentDevice.id}
                    device={currentDevice}
                    topology={topology}
                    onCommit={commit}
                    onCliCommit={(next, preserveRuntime) =>
                      commit(
                        next,
                        preserveRuntime,
                        false,
                        true,
                        undefined,
                        true,
                      )
                    }
                    onReload={(next) =>
                      commit(next, false, false, true, currentDevice.id, true)
                    }
                    onOperation={handleOperation}
                    onDelete={() => {
                      commit(removeDevice(topology, selected));
                      setSelected("");
                    }}
                  />
                ) : (
                  <div className="ns-inspector-empty">
                    <span aria-hidden="true">↖</span>
                    <h2>Inspect a device</h2>
                    <p>
                      Select a device to configure interfaces, run commands, or
                      review its connections.
                    </p>
                  </div>
                )}
              </aside>
            </div>
            <section className="ns-simulation" aria-label="Packet simulation">
              <div className="ns-simulation-heading">
                <div>
                  <span className="ns-eyebrow">SEE THE JOURNEY</span>
                  <h2>Packet simulation</h2>
                </div>
                <div className="ns-mode-switch" aria-label="Simulation mode">
                  {(["realtime", "simulation"] as const).map((m) => (
                    <button
                      key={m}
                      aria-pressed={mode === m}
                      onClick={() => {
                        setMode(m);
                        clearSimulation();
                      }}
                    >
                      {m === "realtime" ? "Realtime" : "Simulation"}
                    </button>
                  ))}
                </div>
              </div>
              <PingForm
                key={topology.devices[0]?.id ?? "empty"}
                topology={topology}
                onPing={runPing}
              />
              <PduPanel
                topology={topology}
                onAdd={addPdu}
                onCommit={commit}
                onResult={handleOperation}
              />
              <RuntimeControls topology={topology} onCommit={commit} />
              <ClientTools topology={topology} onResult={handleOperation} />
              <div className="ns-lab-examples">
                <button
                  className="ns-button"
                  onClick={() => {
                    const next = routerOnAStickLab();
                    commit(next);
                    setSelected(next.devices[0].id);
                  }}
                >
                  Router-on-a-stick
                </button>
                <button
                  className="ns-button"
                  onClick={() => {
                    const next = multilayerSwitchLab();
                    commit(next);
                    setSelected(next.devices[0].id);
                  }}
                >
                  Multilayer switch
                </button>
                <button
                  className="ns-button"
                  onClick={() => {
                    const next = vtpCampusLab();
                    commit(next);
                    setSelected(next.devices[0].id);
                  }}
                >
                  VTP campus
                </button>
                <button
                  className="ns-button"
                  onClick={() => {
                    const next = etherChannelLab();
                    commit(next);
                    setSelected(next.devices[0].id);
                  }}
                >
                  LACP EtherChannel
                </button>
                <button
                  className="ns-button"
                  onClick={() => {
                    const next = etherChannelRepairLab();
                    commit(next);
                    setSelected(next.devices[0].id);
                  }}
                >
                  Repair EtherChannel
                </button>
                <button
                  className="ns-button"
                  onClick={() => {
                    const next = dtpRepairLab();
                    commit(next);
                    setSelected(next.devices[0].id);
                  }}
                >
                  Repair DTP
                </button>
                <button
                  className="ns-button"
                  onClick={() => {
                    const next = eigrpRepairLab();
                    commit(next);
                    setSelected(next.devices[0].id);
                  }}
                >
                  Repair EIGRP
                </button>
                <button
                  className="ns-button"
                  onClick={() => {
                    const next = nativePolicyLab();
                    commit(next);
                    setSelected(next.devices[0].id);
                  }}
                >
                  DHCP and ACL
                </button>
                <button
                  className="ns-button"
                  onClick={() => {
                    const t = secureVlansLab();
                    commit(t);
                    setSelected(t.devices[2].id);
                  }}
                >
                  Secure VLANs
                </button>
                <span>Explore a ready-to-run lab:</span>
                <button
                  className="ns-link-button"
                  onClick={() => {
                    const t = officePhoneLab();
                    commit(t);
                    setSelected(t.devices[0].id);
                  }}
                >
                  Office phones
                </button>
                <button
                  className="ns-link-button"
                  onClick={() => {
                    const t = servicesLab();
                    commit(t);
                    setSelected(t.devices[0].id);
                  }}
                >
                  DHCP / DNS / HTTP
                </button>
                <button
                  className="ns-link-button"
                  onClick={() => {
                    const t = dhcpRelayLab();
                    commit(t);
                    setSelected(t.devices[0].id);
                  }}
                >
                  DHCP relay
                </button>
                <button
                  className="ns-link-button"
                  onClick={() => {
                    const t = routingLab();
                    commit(t);
                    setSelected(t.devices[0].id);
                  }}
                >
                  Routed campus / OSPF
                </button>
                <button
                  className="ns-link-button"
                  onClick={() => {
                    const next = serialWanLab();
                    commit(next);
                    setSelected(next.devices[0].id);
                  }}
                >
                  Serial WAN
                </button>
                <button
                  className="ns-link-button"
                  onClick={() => {
                    const next = wirelessLab();
                    commit(next);
                    setSelected(next.devices[0].id);
                  }}
                >
                  Wireless office
                </button>
                <button
                  className="ns-link-button"
                  onClick={() => {
                    const next = wirelessRepairLab();
                    if (commit(next)) {
                      setSelected(next.devices[0].id);
                      setActivityOpen(true);
                    }
                  }}
                >
                  Wireless troubleshooting
                </button>
                <button
                  className="ns-link-button"
                  onClick={() => {
                    const t = dualStackLab();
                    commit(t);
                    setSelected(t.devices[0].id);
                  }}
                >
                  Dual-stack / IPv6
                </button>
                <button
                  className="ns-link-button"
                  onClick={() => {
                    const next = redundantLab();
                    commit(next);
                    setSelected(next.devices[2].id);
                  }}
                >
                  Redundant LAN / STP
                </button>
                <button
                  className="ns-link-button"
                  onClick={() => {
                    const next = bpduGuardLab();
                    commit(next);
                    setSelected(
                      next.devices.find((d) => d.kind === "switch")!.id,
                    );
                  }}
                >
                  PortFast / BPDU Guard
                </button>
                <button
                  className="ns-link-button"
                  onClick={() => {
                    const t = natLab();
                    commit(t);
                    setSelected(t.devices[4].id);
                  }}
                >
                  NAT edge / PAT
                </button>
                <button
                  className="ns-link-button"
                  onClick={() => {
                    const t = natPoolsLab();
                    commit(t);
                    setSelected(t.devices[4].id);
                  }}
                >
                  NAT pools
                </button>
              </div>
              {result && (
                <div
                  className={`ns-ping-result ${cursor >= result.events.length ? (result.ok ? "success" : "failure") : ""}`}
                  role="status"
                >
                  {cursor < result.events.length
                    ? `Scenario queued · ${cursor}/${result.events.length} events observed. Step or play to inspect the result.`
                    : result.message}
                </div>
              )}
              <div className="ns-playback">
                <div className="ns-tool-group">
                  <button
                    className="ns-button ns-primary"
                    aria-label={playing ? "Pause" : "Play"}
                    disabled={!result?.events.length || mode === "realtime"}
                    onClick={() => {
                      if (cursor >= (result?.events.length ?? 0)) {
                        setCursor(0);
                        setEventIndex(null);
                      }
                      setPlaying((p) => !p);
                    }}
                  >
                    {playing ? "Ⅱ Pause" : "▶ Play"}
                  </button>
                  <button
                    className="ns-button"
                    disabled={
                      !result ||
                      playing ||
                      cursor >= result.events.length ||
                      mode === "realtime"
                    }
                    onClick={() => {
                      setCursor((c) => c + 1);
                      setEventIndex(null);
                    }}
                  >
                    Step forward →
                  </button>
                  <button
                    className="ns-icon-button"
                    aria-label="Reset simulation"
                    disabled={!result}
                    onClick={() => {
                      setCursor(
                        mode === "realtime" ? (result?.events.length ?? 0) : 0,
                      );
                      setPlaying(false);
                      setEventIndex(null);
                    }}
                  >
                    ↺
                  </button>
                </div>
                <span className="ns-event-count">
                  {cursor} / {result?.events.length ?? 0} events
                </span>
                <label className="ns-filter">
                  Protocol
                  <select
                    aria-label="Protocol filter"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="all">All protocols</option>
                    {[
                      ...new Set([
                        "ARP",
                        "ICMP",
                        "DROP",
                        ...(result?.events.map((e) => e.protocol) ?? []),
                      ]),
                    ].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="ns-events-layout">
                <div className="ns-event-table-wrap">
                  <table className="ns-event-table">
                    <thead>
                      <tr>
                        <th>STEP</th>
                        <th>PROTOCOL</th>
                        <th>FROM</th>
                        <th>AT DEVICE</th>
                        <th>PHASE</th>
                        <th>DETAIL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownEvents.map((e) => (
                        <tr
                          key={e.id}
                          data-link-id={e.link}
                          className={detailEvent?.id === e.id ? "active" : ""}
                        >
                          <td>{String(e.id + 1).padStart(2, "0")}</td>
                          <td>
                            <span
                              className={`ns-protocol ${e.protocol.toLowerCase()}`}
                            >
                              {e.protocol}
                            </span>
                          </td>
                          <td>{named(e.from)}</td>
                          <td>{named(e.to)}</td>
                          <td>{e.phase}</td>
                          <td>
                            <button
                              className="ns-link-button"
                              aria-label={`Inspect event ${e.id + 1}`}
                              onClick={() => setEventIndex(e.id)}
                            >
                              Inspect <span aria-hidden="true">↗</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!shownEvents.length && (
                    <div className="ns-events-empty">
                      <span aria-hidden="true">⌁</span>
                      <strong>
                        {result
                          ? "Ready when you are."
                          : "Every packet has a story."}
                      </strong>
                      <p>
                        {result
                          ? "Step through the scenario, or choose a different protocol filter."
                          : "Send a ping to trace its path through your network."}
                      </p>
                    </div>
                  )}
                </div>
                <div className="ns-event-detail">
                  {detailEvent && cursor > 0 ? (
                    <>
                      <span className="ns-eyebrow">
                        EVENT {detailEvent.id + 1}
                      </span>
                      <h3>
                        {detailEvent.protocol === "DROP"
                          ? "Delivery stopped"
                          : detailEvent.protocol === "ARP"
                            ? "Address resolution"
                            : detailEvent.protocol === "ICMP"
                              ? `Echo ${detailEvent.phase}`
                              : `${detailEvent.protocol} ${detailEvent.phase}`}
                      </h3>
                      <p>{detailEvent.detail}</p>
                      <dl>
                        <div>
                          <dt>OSI layer</dt>
                          <dd>
                            {
                              {
                                2: "2 · Data link",
                                3: "3 · Network",
                                4: "4 · Transport",
                                7: "7 · Application",
                              }[detailEvent.layer]
                            }
                          </dd>
                        </div>
                        <div>
                          <dt>IP TTL</dt>
                          <dd>{detailEvent.ttl}</dd>
                        </div>
                      </dl>
                    </>
                  ) : (
                    <>
                      <span className="ns-eyebrow">PACKET INSPECTOR</span>
                      <h3>Understand each hop.</h3>
                      <p>
                        Select an event to see what happened and which layer
                        handled it.
                      </p>
                      <span className="ns-detail-decoration" aria-hidden="true">
                        ◎ ── ◎ ── ◎
                      </span>
                    </>
                  )}
                </div>
              </div>
            </section>
          </section>
          <footer className="ns-footer">
            <span>CertSim Network Studio</span>
            <span>Local practice · Educational network model</span>
            <button className="ns-link-button" onClick={() => setHelp(true)}>
              Supported features ↗
            </button>
          </footer>
        </main>
        {cablePair && (
          <CableDialog
            topology={topology}
            pair={cablePair}
            onClose={() => setCablePair(null)}
            onConnect={(next) => {
              commit(next);
              setCablePair(null);
              setTool("select");
            }}
          />
        )}
        {activityOpen && (
          <Modal
            title="Practice activity"
            onClose={() => setActivityOpen(false)}
          >
            <ActivityPanel
              topology={topology}
              onCommit={(next) => Boolean(commit(next, true))}
              onReset={(next) => {
                if (commit(next)) setSelected(next.devices[0]?.id ?? "");
              }}
            />
          </Modal>
        )}
        {nativePreview && (
          <Modal
            title={nativePreview.file.name}
            onClose={() => setNativePreview(null)}
          >
            <div className="ns-guide ns-native-preview">
              <p>
                This activity uses Packet Tracer access or timing settings. Read
                the instructions here and complete the lab in Cisco Packet
                Tracer.
              </p>
              {nativePreview.pages.map((page, i) => (
                <p key={i}>{page}</p>
              ))}
              <button
                className="ns-button"
                onClick={() =>
                  downloadFile(nativePreview.file, nativePreview.file.name)
                }
              >
                Save original .{nativePreview.format}
              </button>
            </div>
          </Modal>
        )}
        {fileTools && (
          <Modal
            title="Packet Tracer files"
            busy={nativeBusy}
            onClose={() => setFileTools(false)}
          >
            <div className="ns-guide">
              <p>
                Open a network (.pkt), activity (.pka) or package (.pkz). This
                browser keeps the original file for saving supported changes.
                Download a native copy to move it to another computer.
              </p>
              {!topology.nativeFile &&
                topology.devices.some(
                  (d) =>
                    d.kind === "router" &&
                    d.ports.some((p) => p.media === "fiber"),
                ) && (
                  <p className="ns-panel-note">
                    Connected or configured router fiber ports use the native
                    Router-PT FastEthernet module layout. Interface names can
                    change; explicit bandwidth and delay settings preserve
                    routing metrics. The native physical ports remain
                    FastEthernet.
                  </p>
                )}
              {!isNativeLauncher() && (
                <p>
                  <a href={NATIVE_STUDIO_URL}>
                    Open the local native-file workspace
                  </a>
                </p>
              )}
              <section className="ns-package-files" aria-label="Package files">
                <h3>Package files</h3>
                {topology.nativeFile?.format !== "pkz" && (
                  <p>
                    Save .pkz to bundle this{" "}
                    {activityFile || topology.activity ? "activity" : "network"}{" "}
                    with its files and continue working in the saved package.
                  </p>
                )}
                {resources.length > 0 && (
                  <ul>
                    {resources.map((resource) => (
                      <li key={resource.name}>
                        <div className="ns-package-resource-info">
                          <span>{resource.name}</span>
                          <small>{resource.size.toLocaleString()} bytes</small>
                        </div>
                        <div className="ns-package-resource-actions">
                          <button
                            className="ns-button"
                            aria-label={"Download " + resource.name}
                            disabled={nativeBusy}
                            onClick={() => void downloadResource(resource.name)}
                          >
                            Download
                          </button>
                          <label className="ns-button ns-package-replace">
                            Replace
                            <input
                              type="file"
                              aria-label={"Replace " + resource.name}
                              disabled={nativeBusy}
                              onChange={(event) => {
                                const file = event.currentTarget.files?.[0];
                                event.currentTarget.value = "";
                                if (file)
                                  void addResources([file], resource.name);
                              }}
                            />
                          </label>
                          <button
                            className="ns-button"
                            aria-label={"Remove " + resource.name}
                            disabled={nativeBusy}
                            onClick={() => {
                              setFileError("");
                              commit(
                                removePackageFile(topology, resource.name),
                                true,
                                true,
                              );
                            }}
                          >
                            Remove
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <label>
                  Add package files
                  <input
                    type="file"
                    multiple
                    disabled={nativeBusy}
                    onChange={(e) => {
                      const files = Array.from(e.currentTarget.files ?? []);
                      e.currentTarget.value = "";
                      void addResources(files);
                    }}
                  />
                </label>
                {resources.some((r) => isBackgroundName(r.name)) && (
                  <div className="ns-package-background-controls">
                    <label>
                      Logical background image
                      <select
                        value={backgroundSource?.name ?? ""}
                        disabled={nativeBusy}
                        onChange={(event) =>
                          void chooseBackground(event.target.value)
                        }
                      >
                        <option value="">None</option>
                        {resources
                          .filter((r) => isBackgroundName(r.name))
                          .map((r) => (
                            <option key={r.name} value={r.name}>
                              {r.name}
                            </option>
                          ))}
                      </select>
                    </label>
                    {background && backgroundSource && (
                      <label className="ns-package-tile">
                        <input
                          type="checkbox"
                          checked={background.tiled}
                          disabled={nativeBusy}
                          onChange={(event) =>
                            commit(
                              setPackageBackground(topology, {
                                name: background.name,
                                tiled: event.target.checked,
                              }),
                              true,
                              true,
                            )
                          }
                        />
                        Tile image
                      </label>
                    )}
                  </div>
                )}
                {topology.packageEdits && (
                  <p>Package file changes are pending.</p>
                )}
              </section>
              {fileError && (
                <p className="ns-file-error" role="alert">
                  {fileError}
                </p>
              )}
              <div className="ns-actions">
                {(["pkt", "pka", "pkz"] as const)
                  .filter(
                    (f) =>
                      f === "pkz" ||
                      (topology.nativeFile
                        ? f === topology.nativeFile.format
                        : f === "pka" || !topology.activity),
                  )
                  .map((f) => (
                    <button
                      key={f}
                      disabled={
                        nativeBusy || (!!topology.packageEdits && f !== "pkz")
                      }
                      className="ns-button ns-primary"
                      onClick={() => void savePacketTracer(f)}
                    >
                      Save .{f}
                    </button>
                  ))}
              </div>
            </div>
          </Modal>
        )}
        {help && (
          <Modal
            title="Your Network Studio guide"
            onClose={() => setHelp(false)}
          >
            <div className="ns-guide">
              <p>
                Build a network with routers, switches, workstations, IP phones
                and servers. Open the example LAN for a ready-to-test starting
                point.
              </p>
              <h3>Build and configure</h3>
              <p>
                Add devices from the library. Drag or use arrow keys to arrange
                them. Choose Connect, click a source and destination, then
                select compatible free ports. In Hardware, power off a router to
                install an interface module. The Serial WAN lab connects two
                routers with a DCE clock on Router-1. Select a device to
                configure IP addresses, default gateway, VLANs and static
                routes.
              </p>
              <h3>Follow a packet</h3>
              <p>
                Choose a source and destination IP, then send a ping. Simulation
                mode lets you step through address resolution and the ICMP
                request and reply. Realtime shows the completed result
                immediately. Add Simple PDU sends between two devices.
                User-created PDUs support named scenarios, TTL and timed sends.
              </p>
              <h3>Keep your work</h3>
              <p>
                Edits are saved in this browser when storage is available.
                Export a CertSim JSON file for a durable copy; Open validates
                and restores that format. Undo restores the previous network
                after import, new, or loading an example.
              </p>
              <h3>Current simulation boundary</h3>
              <p>
                Network Studio models IPv4, access VLANs, tagged trunks, router
                802.1Q subinterfaces, switch VLAN interfaces (SVIs), named VLAN
                databases, VTP v1/v2, routed physical switchports,
                LACP/PAgP/static EtherChannels with Layer 2 or routed
                Port-channels, inter-VLAN routing, directly connected/static
                routing and per-interface ARP caches. Ping requires an
                independently reachable return path. It also supports DHCP, DNS
                A/AAAA/CNAME records and timed resolver caches, simulated HTTP,
                interface ACLs, and immediate-convergence RIPv2 or single-area
                OSPF. IPv6 supports manual addresses, neighbor discovery and
                static forwarding. Ethernet supports dynamic MAC learning,
                flooding, filtering, virtual-time aging and per-VLAN spanning
                tree with PortFast, BPDU Guard and simulated recovery timers.
                Switches enforce secure MAC bindings per VLAN. IP phones learn
                their voice VLAN, pass workstation traffic and register
                extensions with a router for local calls. Access points bridge
                associated laptops to the wired LAN. IPv4 supports static
                translations, NAT pools, overload and hairpin NAT. It does not
                yet model timed BPDUs, wireless interference, SLAAC, DHCPv6,
                dynamic IPv6 routing, IoT, or industrial protocols. Switch
                trunks carry allowed VLANs with optional untagged native
                traffic. DTP dynamic auto and desirable negotiate trunks; fixed
                trunks can disable negotiation. DTP convergence is immediate,
                without timed negotiation frames.
              </p>
              <p>
                CLI help lists implemented commands. Use the local native-file
                workspace to open and save Packet Tracer 9 networks, activities
                and packages. Export network saves CertSim settings as JSON.
              </p>
            </div>
          </Modal>
        )}
      </div>
    </RuntimeContext.Provider>
  );
}

function PingForm({
  topology,
  onPing,
}: {
  topology: Topology;
  onPing: (
    source: string,
    target: string,
    family: "ipv4" | "ipv6",
    port?: string,
  ) => void;
}) {
  const candidates = topology.devices.filter(isPacketEndpoint);
  const defaultSource =
    candidates.find((d) => applicationHost(d.kind)) ?? candidates[0];
  const [source, setSource] = useState(defaultSource?.id ?? "");
  const [family, setFamily] = useState<"ipv4" | "ipv6">("ipv4");
  const [sourceInterface, setSourceInterface] = useState("");
  const [target, setTarget] = useState(
    (
      candidates.find(
        (d) => d.id !== defaultSource?.id && applicationHost(d.kind),
      ) ?? candidates.find((d) => d !== defaultSource)
    )?.ports.find((p) => p.ip)?.ip ?? "",
  );
  const effectiveSource = candidates.some((d) => d.id === source)
    ? source
    : (defaultSource?.id ?? "");
  const sourceDevice = candidates.find((d) => d.id === effectiveSource);
  const sourcePorts = sourceDevice ? packetInterfaces(sourceDevice) : [];
  const effectiveInterface = sourcePorts.some((p) => p.id === sourceInterface)
    ? sourceInterface
    : "";
  return (
    <form
      className="ns-ping-form"
      onSubmit={(e) => {
        e.preventDefault();
        onPing(
          effectiveSource,
          target,
          family,
          effectiveInterface || undefined,
        );
      }}
    >
      <label>
        Source device
        <select
          aria-label="Ping source"
          value={effectiveSource}
          onChange={(e) => {
            setSource(e.target.value);
            setSourceInterface("");
          }}
        >
          {candidates.length ? (
            candidates.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))
          ) : (
            <option value="">Add a host or router</option>
          )}
        </select>
      </label>
      <span className="ns-ping-arrow" aria-hidden="true">
        →
      </span>
      <label>
        Destination {family === "ipv6" ? "IPv6" : "IPv4"}
        <input
          aria-label="Ping destination"
          value={target}
          maxLength={45}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="192.168.10.20"
          required
        />
      </label>
      <label>
        Address family
        <select
          aria-label="Ping address family"
          value={family}
          onChange={(e) => {
            const value = e.target.value as "ipv4" | "ipv6";
            setFamily(value);
            const dest =
              candidates.find(
                (d) => d.id !== effectiveSource && applicationHost(d.kind),
              ) ?? candidates.find((d) => d.id !== effectiveSource);
            setTarget(
              value === "ipv6"
                ? (dest?.ports.find((p) => p.ipv6)?.ipv6 ?? "")
                : (dest?.ports.find((p) => p.ip)?.ip ?? ""),
            );
          }}
        >
          <option value="ipv4">IPv4</option>
          <option value="ipv6">IPv6</option>
        </select>
      </label>
      {family === "ipv6" && (
        <label>
          Source interface
          <select
            aria-label="IPv6 source interface"
            value={effectiveInterface}
            onChange={(e) => setSourceInterface(e.target.value)}
          >
            <option value="">Automatic</option>
            {sourcePorts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button className="ns-button ns-primary" disabled={!effectiveSource}>
        Send ping <span aria-hidden="true">↗</span>
      </button>
    </form>
  );
}

function DeviceInspector({
  device,
  topology,
  onCommit,
  onCliCommit,
  onReload,
  onDelete,
  onOperation,
}: {
  device: Device;
  topology: Topology;
  onCommit: (t: Topology) => void;
  onCliCommit: (t: Topology, preserveRuntime?: boolean) => unknown;
  onReload: (t: Topology) => void;
  onOperation: (result: ServiceResult, next?: Topology) => void;
  onDelete: () => void;
}) {
  const { runtime } = useNetworkRuntime();
  const [tab, setTab] = useState<
    | "config"
    | "cli"
    | "links"
    | "services"
    | "routing"
    | "wireless"
    | "hardware"
    | "policy"
    | "ipv6"
    | "nat"
    | "phone"
    | "manager"
    | "discovery"
    | "vlans"
    | "etherchannel"
  >("config");
  const [draft, setDraft] = useState(device);
  const [portId, setPortId] = useState(device.ports[0].id);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(device);
    setError("");
  }, [device]);
  const port = draft.ports.find((p) => p.id === portId) ?? draft.ports[0];
  const metricDefaults = isRoutedInterface(draft, port)
    ? interfaceMetric(
        topology,
        draft,
        { ...port, bandwidth: undefined, delay: undefined },
        runtime,
      )
    : undefined;
  const links = topology.links.filter(
    (l) => l.a.device === device.id || l.b.device === device.id,
  );
  const field = (key: keyof Device, value: unknown) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const portField = (key: keyof typeof port, value: unknown) =>
    setDraft((d) => ({
      ...d,
      ports: d.ports.map((p) =>
        p.id === port.id ? { ...p, [key]: value } : p,
      ),
    }));
  return (
    <>
      <div className="ns-inspector-header">
        <span className={`ns-inspector-icon ns-kind-${device.kind}`}>
          <DeviceIcon kind={device.kind} size={30} />
        </span>
        <div>
          <h2>{device.name}</h2>
          <span>
            {DEVICE_LABELS[device.kind]} · {device.ports.length} interfaces
          </span>
        </div>
        <span
          className={`ns-power-dot ${device.powered ? "on" : ""}`}
          title={device.powered ? "Powered on" : "Powered off"}
        />
      </div>
      <div
        className="ns-inspector-tabs"
        role="group"
        aria-label="Device panels"
      >
        {(
          [
            "config",
            ...(device.kind === "ap" ? [] : ["cli"]),
            ...(isWireless(device.kind) ? ["wireless"] : []),
            ...(device.kind === "router" || device.kind === "switch"
              ? ["hardware"]
              : []),
            ...(device.kind === "server" ? ["services"] : []),
            ...(device.kind === "router"
              ? ["routing", "policy", "nat"]
              : device.kind === "switch"
                ? ["vlans", "etherchannel", "routing", "policy"]
                : []),
            ...(addressable(device.kind) ||
            device.ports.some((p) => p.virtual?.kind === "svi")
              ? ["ipv6"]
              : []),
            ...(device.kind === "phone"
              ? ["phone"]
              : device.kind === "router"
                ? ["manager"]
                : []),
            ...(discoveryCapable(device) ? ["discovery"] : []),
            "links",
          ] as (typeof tab)[]
        ).map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {
              {
                config: "Config",
                vlans: "VLANs",
                etherchannel: "EtherChannel",
                hardware: "Hardware",
                wireless: "Wireless",
                cli: "CLI",
                links: "Links",
                discovery: "Discovery",
                manager: "Call manager",
                phone: "Handset",
                services: "Services",
                ipv6: "IPv6",
                routing: "Routing",
                policy: "Policy",
                nat: "NAT",
              }[t]
            }
          </button>
        ))}
      </div>
      {tab === "config" && (
        <form
          className="ns-config"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              let next = reconcilePortChannels(device, draft);
              for (const p of draft.ports.filter((p) =>
                isSwitchport(draft, p),
              )) {
                const original = device.ports.find(
                  (entry) => entry.id === p.id,
                );
                const assigned = [
                  ...(p.mode !== "trunk" &&
                  (p.vlan !== original?.vlan || original?.mode === "trunk")
                    ? [p.vlan]
                    : []),
                  ...(p.voiceVlan && p.voiceVlan !== original?.voiceVlan
                    ? [p.voiceVlan]
                    : []),
                ];
                for (const vlan of assigned)
                  next = ensureAccessVlan(next, vlan);
              }
              const message = configurationError(next);
              if (message) throw Error(message);
              onCommit({
                ...topology,
                devices: topology.devices.map((d) =>
                  d.id === next.id ? next : d,
                ),
                ...(topology.pdus && { pdus: devicePdus(topology, next) }),
              });
              setError("");
            } catch (cause) {
              setError(
                cause instanceof Error
                  ? cause.message
                  : "Could not apply configuration.",
              );
            }
          }}
        >
          <label>
            Device name
            <input
              value={draft.name}
              maxLength={48}
              onChange={(e) => field("name", e.target.value)}
              required
            />
          </label>
          {draft.kind === "switch" && (
            <label className="ns-checkbox">
              <input
                type="checkbox"
                checked={draft.ipRouting ?? false}
                onChange={(event) => field("ipRouting", event.target.checked)}
              />
              Enable IPv4 routing
            </label>
          )}
          <label className="ns-checkbox">
            <input
              type="checkbox"
              checked={draft.powered}
              onChange={(e) => field("powered", e.target.checked)}
            />
            Power on
          </label>
          {device.kind !== "router" && addressable(device.kind) && (
            <label>
              Default gateway
              <input
                placeholder="Optional IPv4 gateway"
                value={draft.gateway}
                maxLength={15}
                onChange={(e) => field("gateway", e.target.value)}
              />
            </label>
          )}
          {addressable(device.kind) && (
            <label>
              DNS server
              <input
                value={draft.dns ?? ""}
                maxLength={15}
                placeholder="Optional DNS IPv4 address"
                onChange={(e) => field("dns", e.target.value)}
              />
            </label>
          )}
          <div className="ns-form-divider" />
          <label>
            Interface
            <select
              aria-label="Interface"
              value={port.id}
              onChange={(e) => setPortId(e.target.value)}
            >
              {draft.ports.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ·{" "}
                  {p.virtual
                    ? p.virtual.kind === "svi"
                      ? "SVI"
                      : p.virtual.kind === "portchannel"
                        ? "EtherChannel"
                        : "802.1Q"
                    : p.media}
                  {p.routed ? " · routed" : ""}
                </option>
              ))}
            </select>
          </label>
          {draft.kind === "switch" &&
            (!port.virtual || port.virtual.kind === "portchannel") &&
            (port.media === "copper" || port.media === "fiber") && (
              <label className="ns-checkbox">
                <input
                  type="checkbox"
                  checked={port.routed ?? false}
                  onChange={(event) => {
                    try {
                      setDraft(
                        setSwitchport(draft, port.id, !event.target.checked),
                      );
                      setError("");
                    } catch (cause) {
                      setError(
                        cause instanceof Error
                          ? cause.message
                          : "Could not change the interface mode.",
                      );
                    }
                  }}
                />
                Routed port
              </label>
            )}
          {(draft.kind === "router" || draft.kind === "switch") && (
            <LogicalInterfaceControls
              device={draft}
              port={port}
              onChange={setDraft}
              onSelect={setPortId}
              onError={setError}
            />
          )}
          {(port.virtual || port.routed) && (
            <p aria-label="Interface operational state">
              {device.ports.some((p) => p.id === port.id)
                ? portOperational(topology, device.id, port.id, runtime)
                  ? "Operationally up"
                  : "Operationally down"
                : "Apply configuration to activate this interface"}
            </p>
          )}
          {port.channelGroup && (
            <p className="ns-panel-note">
              Member of Port-channel{port.channelGroup.id}. VLAN and routing
              changes on the aggregate apply to its members; incompatible local
              member settings can suspend this link.
            </p>
          )}
          <label className="ns-checkbox">
            <input
              type="checkbox"
              checked={port.enabled}
              onChange={(e) => portField("enabled", e.target.checked)}
            />
            Interface enabled
          </label>
          {port.media === "serial" && (
            <label>
              Serial clock rate ·{" "}
              {serialRole(topology, device.id, port.id) ?? "Unconnected"}
              <select
                aria-label="Serial clock rate"
                value={port.clockRate ?? ""}
                onChange={(e) =>
                  portField(
                    "clockRate",
                    e.target.value ? Number(e.target.value) : undefined,
                  )
                }
              >
                <option value="">No clock</option>
                {serialRates.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate} bps
                  </option>
                ))}
              </select>
            </label>
          )}
          {draft.kind === "phone" && port.id === "p1" ? (
            <p>Untagged workstation traffic passes through this jack.</p>
          ) : port.channelGroup && port.routed ? (
            <p>
              Configure addressing, DHCP relay and routing on Port-channel
              {port.channelGroup.id}.
            </p>
          ) : draft.kind === "ap" ? null : draft.kind !== "switch" ||
            isRoutedInterface(draft, port) ? (
            <>
              <label>
                IPv4 address
                <input
                  aria-label="Interface IPv4 address"
                  placeholder="Not configured"
                  value={port.ip}
                  maxLength={15}
                  onChange={(e) => {
                    portField("ip", e.target.value);
                    setDraft((d) => ({
                      ...d,
                      ports: d.ports.map((p) =>
                        p.id === port.id
                          ? {
                              ...p,
                              addressMode: applicationHost(d.kind)
                                ? "static"
                                : undefined,
                              dhcpLease: undefined,
                              dhcpRetryAt: undefined,
                            }
                          : p,
                      ),
                    }));
                  }}
                />
              </label>
              <label>
                Prefix length
                <input
                  type="number"
                  min="1"
                  max="32"
                  value={port.prefix}
                  onChange={(e) => portField("prefix", Number(e.target.value))}
                />
              </label>
              {isRoutedInterface(draft, port) && (
                <label>
                  DHCP helper addresses
                  <input
                    placeholder="IPv4 addresses, separated by commas"
                    value={(port.helperAddresses ?? []).join(",")}
                    onChange={(e) =>
                      portField(
                        "helperAddresses",
                        e.target.value
                          ? e.target.value
                              .split(",")
                              .map((address) => address.trim())
                          : undefined,
                      )
                    }
                  />
                </label>
              )}
              {metricDefaults && (
                <fieldset className="ns-route">
                  <legend>EIGRP interface metric</legend>
                  <div className="ns-form-pair">
                    <label>
                      Bandwidth (Kbit/s)
                      <input
                        type="number"
                        min={1}
                        max={2147483647}
                        step={1}
                        placeholder={String(metricDefaults.bandwidth)}
                        value={port.bandwidth ?? ""}
                        onChange={(event) =>
                          portField(
                            "bandwidth",
                            event.target.value === ""
                              ? undefined
                              : Number(event.target.value),
                          )
                        }
                      />
                    </label>
                    <label>
                      Delay (10 µs units)
                      <input
                        type="number"
                        min={1}
                        max={16777215}
                        step={1}
                        placeholder={String(metricDefaults.delay)}
                        value={port.delay ?? ""}
                        onChange={(event) =>
                          portField(
                            "delay",
                            event.target.value === ""
                              ? undefined
                              : Number(event.target.value),
                          )
                        }
                      />
                    </label>
                  </div>
                  <p className="ns-panel-note">
                    Leave blank to use interface defaults:{" "}
                    {metricDefaults.bandwidth} Kbit/s and {metricDefaults.delay}{" "}
                    × 10 µs. These values change route preference, not the
                    physical link speed.
                  </p>
                </fieldset>
              )}
            </>
          ) : (
            <>
              <label>
                Port mode
                <select
                  aria-label="Port mode"
                  value={port.mode}
                  onChange={(e) => portField("mode", e.target.value)}
                >
                  <option value="access">Access</option>
                  <option value="trunk">Trunk (802.1Q)</option>
                  <option value="dynamic-auto">Dynamic auto</option>
                  <option value="dynamic-desirable">Dynamic desirable</option>
                </select>
              </label>
              {port.mode !== "trunk" && (
                <label>
                  Access VLAN
                  <input
                    type="number"
                    min="1"
                    max="4094"
                    value={port.vlan}
                    onChange={(e) => portField("vlan", Number(e.target.value))}
                  />
                </label>
              )}
              {port.mode !== "access" && (
                <label>
                  Allowed VLANs
                  <input
                    value={port.allowedVlans.join(",")}
                    onChange={(e) =>
                      portField(
                        "allowedVlans",
                        e.target.value.split(",").map(Number),
                      )
                    }
                    placeholder="10,20"
                  />
                </label>
              )}
            </>
          )}
          {isSwitchport(draft, port) && port.mode !== "access" && (
            <label>
              Native VLAN
              <input
                type="number"
                min={1}
                max={4094}
                placeholder="All tagged"
                value={port.nativeVlan ?? ""}
                onChange={(e) =>
                  portField(
                    "nativeVlan",
                    e.target.value ? Number(e.target.value) : undefined,
                  )
                }
              />
            </label>
          )}
          {isSwitchport(draft, port) && (
            <>
              <label className="ns-checkbox">
                <input
                  type="checkbox"
                  checked={port.nonegotiate ?? false}
                  onChange={(event) =>
                    portField("nonegotiate", event.target.checked || undefined)
                  }
                />
                Disable DTP negotiation
              </label>
              <p className="ns-panel-note">
                Dynamic auto waits for a trunk proposal. Dynamic desirable
                initiates one. A dynamic port uses its access VLAN until a trunk
                forms. Disable DTP only with a fixed Access or Trunk mode.
              </p>
              {device.ports.some((p) => p.id === port.id) ? (
                <SwitchportStatus
                  device={device}
                  port={device.ports.find((p) => p.id === port.id)!}
                  topology={topology}
                />
              ) : (
                <p className="ns-panel-note">
                  Apply configuration to inspect trunk negotiation.
                </p>
              )}
            </>
          )}
          {["pc", "server"].includes(draft.kind) && (
            <label>
              Tagged endpoint VLAN (optional)
              <input
                aria-label="Tagged endpoint VLAN"
                type="number"
                min="1"
                max="4094"
                value={port.taggedVlan ?? ""}
                onChange={(e) =>
                  portField(
                    "taggedVlan",
                    e.target.value ? Number(e.target.value) : undefined,
                  )
                }
              />
            </label>
          )}
          {isSwitchport(draft, port) &&
            !port.virtual &&
            !port.channelGroup &&
            port.mode === "access" && (
              <label>
                Voice VLAN (optional)
                <input
                  aria-label="Voice VLAN"
                  type="number"
                  min="1"
                  max="4094"
                  value={port.voiceVlan ?? ""}
                  onChange={(e) =>
                    portField(
                      "voiceVlan",
                      e.target.value ? Number(e.target.value) : undefined,
                    )
                  }
                />
              </label>
            )}
          {(draft.kind === "router" || draft.kind === "switch") && (
            <>
              <div className="ns-form-divider" />
              <div className="ns-route-heading">
                <strong>Static routes</strong>
                <button
                  type="button"
                  className="ns-link-button"
                  disabled={draft.routes.length >= 128}
                  onClick={() =>
                    field("routes", [
                      ...draft.routes,
                      { network: "0.0.0.0", prefix: 0, nextHop: "" },
                    ])
                  }
                >
                  + Add
                </button>
              </div>
              {draft.routes.map((r, i) => (
                <fieldset className="ns-route" key={i}>
                  <legend>Route {i + 1}</legend>
                  <label>
                    Network
                    <input
                      value={r.network}
                      maxLength={15}
                      onChange={(e) =>
                        field(
                          "routes",
                          draft.routes.map((r, j) =>
                            j === i ? { ...r, network: e.target.value } : r,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Prefix
                    <input
                      type="number"
                      min="0"
                      max="32"
                      value={r.prefix}
                      onChange={(e) =>
                        field(
                          "routes",
                          draft.routes.map((r, j) =>
                            j === i
                              ? { ...r, prefix: Number(e.target.value) }
                              : r,
                          ),
                        )
                      }
                    />
                  </label>
                  <label>
                    Next hop
                    <input
                      value={r.nextHop}
                      maxLength={15}
                      onChange={(e) =>
                        field(
                          "routes",
                          draft.routes.map((r, j) =>
                            j === i ? { ...r, nextHop: e.target.value } : r,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    className="ns-link-button ns-danger-text"
                    type="button"
                    onClick={() =>
                      field(
                        "routes",
                        draft.routes.filter((_, j) => j !== i),
                      )
                    }
                  >
                    Remove route
                  </button>
                </fieldset>
              ))}
            </>
          )}
          {(device.kind === "pc" ||
            device.kind === "laptop" ||
            device.kind === "server" ||
            (device.kind === "phone" && port.id === "p0")) && (
            <button
              type="button"
              className="ns-button"
              onClick={() => {
                const r = requestDhcp(topology, device.id, port.id, runtime);
                onOperation(
                  r,
                  r.topology === topology ? undefined : r.topology,
                );
              }}
            >
              Request DHCP on interface
            </button>
          )}
          {port.dhcpRetryAt !== undefined && port.addressMode === "dhcp" && (
            <p aria-label="DHCP discovery">
              Waiting for a DHCP server · retry in{" "}
              {Math.max(0, port.dhcpRetryAt - (topology.dhcpTime ?? 0))}s
            </p>
          )}
          {port.dhcpLease && port.addressMode === "dhcp" && (
            <p aria-label="DHCP lease state">
              DHCP {port.dhcpLease.state} ·{" "}
              {Math.max(0, port.dhcpLease.expires - (topology.dhcpTime ?? 0))}s
              remaining
            </p>
          )}
          <label>
            Note
            <input
              value={draft.note}
              maxLength={300}
              onChange={(e) => field("note", e.target.value)}
              placeholder="Optional device note"
            />
          </label>
          {error && (
            <p className="ns-error" role="alert">
              {error}
            </p>
          )}
          <button className="ns-button ns-primary ns-apply" type="submit">
            Apply configuration
          </button>
          <button
            type="button"
            className="ns-button ns-delete"
            onClick={onDelete}
          >
            Remove device
          </button>
        </form>
      )}
      {tab === "vlans" && (
        <VlansPanel device={device} topology={topology} onCommit={onCommit} />
      )}
      {tab === "etherchannel" && (
        <EtherChannelPanel
          device={device}
          topology={topology}
          onCommit={onCommit}
          onConfigure={(id) => {
            setPortId(id);
            setTab("config");
          }}
        />
      )}
      {tab === "config" && device.kind === "switch" && (
        <MacPanel device={device} topology={topology} onCommit={onCommit} />
      )}
      {tab === "config" && device.kind === "switch" && (
        <SpanningTreePanel
          device={device}
          topology={topology}
          onCommit={onCommit}
        />
      )}
      {tab === "wireless" && (
        <WirelessPanel
          key={JSON.stringify(device.wireless)}
          device={device}
          topology={topology}
          onCommit={onCommit}
        />
      )}
      {tab === "hardware" && (
        <HardwarePanel
          device={device}
          topology={topology}
          onCommit={onCommit}
        />
      )}
      {tab === "phone" && (
        <PhonePanel
          key={device.managerAddress}
          device={device}
          topology={topology}
          onCommit={onCommit}
          onOperation={onOperation}
        />
      )}
      {tab === "manager" && (
        <CallManagerPanel
          key={JSON.stringify(device.callManager)}
          device={device}
          topology={topology}
          onCommit={onCommit}
          onOperation={onOperation}
        />
      )}
      {tab === "discovery" && (
        <DiscoveryPanel
          device={device}
          topology={topology}
          onCommit={onCommit}
        />
      )}
      {tab === "config" && addressable(device.kind) && (
        <NeighborCachePanel device={device} />
      )}
      {tab === "cli" && (
        <CliPanel device={device} topology={topology} onCommit={onCliCommit} />
      )}
      {tab === "config" && (
        <LifecyclePanel
          device={device}
          topology={topology}
          onCommit={onCommit}
          onReload={onReload}
        />
      )}
      {tab === "ipv6" && (
        <IPv6Panel device={device} topology={topology} onCommit={onCommit} />
      )}
      {tab === "services" && (
        <ServicesPanel
          device={device}
          topology={topology}
          onCommit={onCommit}
        />
      )}
      {tab === "routing" && (
        <RoutingPanel device={device} topology={topology} onCommit={onCommit} />
      )}
      {tab === "nat" && (
        <NatPanel device={device} topology={topology} onCommit={onCommit} />
      )}
      {tab === "policy" && (
        <PolicyPanel device={device} topology={topology} onCommit={onCommit} />
      )}
      {tab === "links" && (
        <div className="ns-device-links">
          <p>{links.length} connected ports</p>
          {links.map((l) => {
            const other = l.a.device === device.id ? l.b : l.a,
              own = l.a.device === device.id ? l.a : l.b;
            return (
              <div className="ns-connection-card" key={l.id}>
                <strong>
                  {device.ports.find((p) => p.id === own.port)?.name}
                </strong>
                <span>
                  → {topology.devices.find((d) => d.id === other.device)?.name}{" "}
                  · {other.port}
                </span>
                <small>
                  {l.cable === "serial"
                    ? "Serial " + serialRole(topology, device.id, own.port)
                    : l.cable}{" "}
                  · {linkStatus(topology, l, runtime).reason}
                </small>
                <CableLengthControl
                  link={l}
                  topology={topology}
                  onCommit={onCommit}
                />
                <button
                  className="ns-link-button ns-danger-text"
                  onClick={() =>
                    onCommit({
                      ...topology,
                      links: topology.links.filter((link) => link.id !== l.id),
                    })
                  }
                >
                  Disconnect
                </button>
              </div>
            );
          })}
          {!links.length && (
            <p>
              Choose Connect in the canvas toolbar, then select two devices.
            </p>
          )}
        </div>
      )}
    </>
  );
}

function CliPanel({
  device,
  topology,
  onCommit,
}: {
  device: Device;
  topology: Topology;
  onCommit: (t: Topology, preserveRuntime?: boolean) => unknown;
}) {
  const { runtime, refresh } = useNetworkRuntime();
  const [session, setSession] = useState<CliSession>(INITIAL_CLI);
  const [input, setInput] = useState("");
  const [lines, setLines] = useState([
    "CertSim educational CLI",
    "Type help for supported commands.",
  ]);
  const output = useRef<HTMLDivElement>(null);
  const history = useRef<string[]>([]),
    historyIndex = useRef(0);
  useEffect(() => {
    if (output.current) output.current.scrollTop = output.current.scrollHeight;
  }, [lines]);
  return (
    <div className="ns-cli">
      <div
        className="ns-cli-output"
        ref={output}
        role="log"
        aria-label="CLI output"
      >
        {lines.map((line, i) => (
          <pre key={i}>{line || " "}</pre>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const result = command(topology, device.id, session, input, runtime);
          refresh();
          const applied =
            !result.changed ||
            onCommit(
              result.topology,
              input.trim().toLowerCase() === "ipconfig /renew" ||
                result.preserveRuntime,
            ) !== false;
          setLines((lines) =>
            [
              ...lines,
              `${prompt(device, session)} ${input}`,
              applied
                ? result.output
                : "% Workspace change rejected. See the workspace message; the previous configuration is unchanged.",
            ].slice(-300),
          );
          if (input.trim()) {
            history.current = [...history.current, input].slice(-100);
            historyIndex.current = history.current.length;
          }
          setInput("");
          if (applied) setSession(result.session);
        }}
      >
        <label htmlFor={`cli-${device.id}`}>{prompt(device, session)}</label>
        <input
          id={`cli-${device.id}`}
          aria-label="CLI command"
          autoComplete="off"
          spellCheck={false}
          value={input}
          maxLength={240}
          disabled={!device.powered}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              historyIndex.current = Math.max(
                0,
                Math.min(
                  history.current.length,
                  historyIndex.current + (e.key === "ArrowUp" ? -1 : 1),
                ),
              );
              setInput(history.current[historyIndex.current] ?? "");
            }
          }}
        />
        <button className="ns-button" disabled={!device.powered}>
          Run
        </button>
      </form>
      <p>
        Commands change this practice model only. Unsupported commands return an
        explicit error.
      </p>
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
  busy = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    d?.showModal();
    return () => {
      d?.close();
    };
  }, []);
  return (
    <dialog
      className="ns-modal"
      ref={dialog}
      aria-label={title}
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <div className="ns-modal-title">
        <h2>{title}</h2>
        <button
          className="ns-icon-button"
          aria-label="Close dialog"
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
function CableDialog({
  topology,
  pair,
  onClose,
  onConnect,
}: {
  topology: Topology;
  pair: [string, string];
  onClose: () => void;
  onConnect: (t: Topology) => void;
}) {
  const a = topology.devices.find((d) => d.id === pair[0])!,
    b = topology.devices.find((d) => d.id === pair[1])!;
  const suggested = automaticConnection(topology, a, b);
  const [ap, setAp] = useState(
    suggested?.a.port ??
      a.ports.find(
        (p) =>
          !p.virtual && !isOccupied(topology, { device: a.id, port: p.id }),
      )?.id ??
      a.ports.find((p) => !p.virtual)?.id ??
      "",
  );
  const [bp, setBp] = useState(
    suggested?.b.port ??
      b.ports.find(
        (p) =>
          !p.virtual && !isOccupied(topology, { device: b.id, port: p.id }),
      )?.id ??
      b.ports.find((p) => !p.virtual)?.id ??
      "",
  );
  const [cable, setCable] = useState<Cable>(suggested?.cable ?? "copper");
  const [dce, setDce] = useState<"a" | "b">("a");
  const left = { device: a.id, port: ap },
    right = { device: b.id, port: bp };
  const error = linkError(topology, left, right, cable);
  return (
    <Modal title="Connect devices" onClose={onClose}>
      <form
        className="ns-cable-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!error)
            onConnect(
              connect(
                topology,
                left,
                right,
                cable,
                cable === "serial" ? dce : undefined,
              ),
            );
        }}
      >
        <p>
          Choose an available port on each device. One cable can use each port.
        </p>
        {(
          [
            [a, ap, setAp],
            [b, bp, setBp],
          ] as const
        ).map(([d, value, setter], i) => (
          <label key={d.id}>
            {i ? "Destination" : "Source"} · {d.name}
            <select
              aria-label={i ? "Destination port" : "Source port"}
              value={value}
              onChange={(e) => setter(e.target.value)}
            >
              {d.ports
                .filter((p) => !p.virtual)
                .map((p) => {
                  const occupied = isOccupied(topology, {
                    device: d.id,
                    port: p.id,
                  });
                  return (
                    <option key={p.id} value={p.id} disabled={occupied}>
                      {p.name} · {p.media}
                      {occupied ? " · in use" : ""}
                    </option>
                  );
                })}
            </select>
          </label>
        ))}
        <label>
          Cable media
          <select
            aria-label="Cable media"
            value={cable}
            onChange={(e) => setCable(e.target.value as Cable)}
          >
            <option value="copper">Copper Ethernet</option>
            <option value="fiber">Fiber optic</option>
            <option value="serial">Serial WAN</option>
          </select>
        </label>
        {(cable === "serial" || suggested?.cable === "serial") && (
          <label>
            Clock provider (DCE)
            <select
              aria-label="Serial DCE end"
              value={dce}
              onChange={(e) => setDce(e.target.value as "a" | "b")}
            >
              <option value="a">{a.name}</option>
              <option value="b">{b.name}</option>
            </select>
          </label>
        )}
        {error && (
          <p role="status" className="ns-error">
            {error}
          </p>
        )}
        <button
          type="button"
          className="ns-button"
          disabled={!suggested}
          onClick={() => {
            if (suggested)
              onConnect(
                connect(
                  topology,
                  suggested.a,
                  suggested.b,
                  suggested.cable,
                  suggested.cable === "serial" ? dce : undefined,
                ),
              );
          }}
        >
          Auto-connect available ports
        </button>
        <button className="ns-button ns-primary" disabled={!!error}>
          Connect ports
        </button>
      </form>
    </Modal>
  );
}
