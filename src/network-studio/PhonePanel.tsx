import { useState } from "react";
import type { Device, PingResult, Topology } from "./types.ts";
import { useNetworkRuntime } from "./RuntimePanels.tsx";
import { configurationError } from "./engine.ts";
import { interfaceMac } from "./ethernet.ts";
import {
  phoneManager,
  registerPhone,
  callFor,
  dialPhone,
  answerPhone,
  hangUp,
  sendPhoneNote,
} from "./telephony.ts";

interface Props {
  device: Device;
  topology: Topology;
  onCommit: (next: Topology) => void;
  onOperation: (result: PingResult) => void;
}
export function CallManagerPanel({ device, topology, onCommit }: Props) {
  const manager = device.callManager;
  const { runtime } = useNetworkRuntime();
  const [enabled, setEnabled] = useState(!!manager);
  const addresses = device.ports.filter((p) => p.ip);
  const [address, setAddress] = useState(
    manager?.address ?? addresses[0]?.ip ?? "",
  );
  const [lines, setLines] = useState(manager?.lines ?? []);
  const [error, setError] = useState("");
  const phones = topology.devices.filter((d) => d.kind === "phone");
  const registered = runtime.registrations.filter(
    (reg) => reg.router === device.id,
  );
  function update(index: number, key: "number" | "mac", value: string) {
    setLines((prev) =>
      prev.map((l, i) => (index === i ? { ...l, [key]: value } : l)),
    );
  }
  return (
    <form
      className="ns-config"
      aria-label="Call manager"
      onSubmit={(e) => {
        e.preventDefault();
        const next = { ...device };
        if (enabled) next.callManager = { address, lines };
        else delete next.callManager;
        const message = configurationError(next);
        if (message) {
          setError(message);
          return;
        }
        setError("");
        onCommit({
          ...topology,
          devices: topology.devices.map((d) => (d.id === next.id ? next : d)),
        });
      }}
    >
      <h3>Call manager</h3>
      <label className="ns-checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Enable local call manager
      </label>
      {enabled && (
        <>
          <label>
            Manager interface
            <select
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              required
            >
              <option value="">Select interface</option>
              {addresses.map((p) => (
                <option value={p.ip} key={p.id}>
                  {p.name} · {p.ip}
                </option>
              ))}
            </select>
          </label>
          {lines.map((line, i) => (
            <fieldset key={i} className="ns-route">
              <legend>Directory line {i + 1}</legend>
              <label>
                Phone MAC
                <input
                  value={line.mac}
                  maxLength={12}
                  list="ns-phone-macs"
                  onChange={(e) =>
                    update(i, "mac", e.target.value.trim().toLowerCase())
                  }
                  required
                />
              </label>
              <label>
                Extension
                <input
                  value={line.number}
                  inputMode="numeric"
                  maxLength={12}
                  pattern="[0-9]{1,12}"
                  onChange={(e) => update(i, "number", e.target.value)}
                  required
                />
              </label>
              <button
                type="button"
                className="ns-link-button"
                onClick={() =>
                  setLines((prev) => prev.filter((_, j) => j !== i))
                }
              >
                Remove line
              </button>
            </fieldset>
          ))}
          <datalist id="ns-phone-macs">
            {phones.map((p) => (
              <option key={p.id} value={interfaceMac(p.id, "p0")}>
                {p.name}
              </option>
            ))}
          </datalist>
          <button
            type="button"
            className="ns-button"
            disabled={lines.length >= 128}
            onClick={() => {
              const phone = phones.find(
                (d) => !lines.some((l) => l.mac === interfaceMac(d.id, "p0")),
              );
              let number = 1001;
              while (lines.some((l) => l.number === String(number))) number++;
              setLines([
                ...lines,
                {
                  mac: phone ? interfaceMac(phone.id, "p0") : "",
                  number: String(number),
                },
              ]);
            }}
          >
            Add directory line
          </button>
        </>
      )}
      <button className="ns-button ns-primary">Apply call manager</button>
      {error && <p role="alert">{error}</p>}
      <h3>Registered phones</h3>
      {registered.length ? (
        registered.map((reg) => (
          <p key={reg.phone}>
            {reg.number} ·{" "}
            {topology.devices.find((d) => d.id === reg.phone)?.name} ·{" "}
            {reg.address}
          </p>
        ))
      ) : (
        <p>No registered phones.</p>
      )}
    </form>
  );
}
export function PhonePanel({ device, topology, onCommit, onOperation }: Props) {
  const { runtime } = useNetworkRuntime();
  const [address, setAddress] = useState(device.managerAddress ?? "");
  const [number, setNumber] = useState("");
  const [message, setMessage] = useState("");
  const reg = runtime.registrations.find((r) => r.phone === device.id),
    call = callFor(runtime, device.id);
  const peer =
    call &&
    runtime.registrations.find(
      (r) =>
        r.phone === (call.caller === device.id ? call.callee : call.caller),
    );
  const incoming = call?.callee === device.id;
  const check = runtime.phoneChecks.get(device.id);
  function act(result: PingResult) {
    setMessage(result.message);
    onOperation(result);
  }
  return (
    <section className="ns-config" aria-label="IP phone handset">
      <h3>{reg ? "Extension " + reg.number : "Unregistered phone"}</h3>
      <p>Network MAC · {interfaceMac(device.id, "p0")}</p>
      <form
        className="ns-config"
        onSubmit={(e) => {
          e.preventDefault();
          const next = { ...device, managerAddress: address.trim() };
          const error = configurationError(next);
          if (error) {
            setMessage(error);
            return;
          }
          onCommit({
            ...topology,
            devices: topology.devices.map((d) =>
              d.id === device.id ? next : d,
            ),
          });
          setMessage("Manager address saved.");
        }}
      >
        <label>
          Call manager address
          <input
            value={address}
            maxLength={15}
            placeholder="Use DHCP option 150"
            onChange={(e) => setAddress(e.target.value)}
          />
        </label>
        <button className="ns-button">Save manager address</button>
      </form>
      <p>Manager · {phoneManager(topology, device) || "Unassigned"}</p>
      {check && (
        <p aria-label="Provisioning status">
          {check.message} Next check in {Math.max(0, check.next - runtime.time)}
          s.
        </p>
      )}
      <button
        className="ns-button"
        disabled={!!call}
        onClick={() => act(registerPhone(topology, runtime, device.id))}
      >
        Register phone
      </button>
      <h3 aria-label="Line status">
        {call
          ? (call.state === "connected"
              ? "Connected to "
              : incoming
                ? "Incoming call from "
                : "Calling ") + peer?.number
          : "Line idle"}
      </h3>
      {!call && (
        <form
          className="ns-config"
          onSubmit={(e) => {
            e.preventDefault();
            act(dialPhone(topology, runtime, device.id, number));
          }}
        >
          <label>
            Dial extension
            <input
              value={number}
              inputMode="numeric"
              pattern="[0-9]{1,12}"
              maxLength={12}
              onChange={(e) => setNumber(e.target.value)}
              required
            />
          </label>
          <div className="ns-phone-keys" role="group" aria-label="Phone keypad">
            {"123456789".split("").map((digit) => (
              <button
                key={digit}
                type="button"
                className="ns-button"
                disabled={number.length >= 12}
                onClick={() => setNumber((n) => n + digit)}
              >
                {digit}
              </button>
            ))}
            <button
              type="button"
              className="ns-button"
              disabled={!number}
              onClick={() => setNumber("")}
            >
              Clear
            </button>
            <button
              type="button"
              className="ns-button"
              disabled={number.length >= 12}
              onClick={() => setNumber((n) => n + "0")}
            >
              0
            </button>
            <button
              type="button"
              className="ns-button"
              aria-label="Delete last digit"
              disabled={!number}
              onClick={() => setNumber((n) => n.slice(0, -1))}
            >
              ⌫
            </button>
          </div>
          <button className="ns-button ns-primary" disabled={!reg}>
            Dial
          </button>
        </form>
      )}
      {incoming && call?.state === "ringing" && (
        <button
          className="ns-button ns-primary"
          onClick={() => act(answerPhone(topology, runtime, device.id))}
        >
          Answer
        </button>
      )}
      {call?.state === "connected" && (
        <>
          <div className="ns-drawing-tools">
            {(["Do", "Re", "Mi"] as const).map((note) => (
              <button
                className="ns-button"
                key={note}
                onClick={() =>
                  act(sendPhoneNote(topology, runtime, device.id, note))
                }
              >
                Send {note}
              </button>
            ))}
          </div>
          {call.lastNote?.to === device.id && (
            <p>Received note · {call.lastNote.note}</p>
          )}
        </>
      )}
      {call && (
        <button
          className="ns-button"
          onClick={() => act(hangUp(topology, runtime, device.id))}
        >
          Hang up
        </button>
      )}
      <p role="status">{message}</p>
    </section>
  );
}
