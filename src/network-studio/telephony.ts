import { probeIPv4 } from "./engine.ts";
import { interfaceMac } from "./ethernet.ts";
import { bindRuntime } from "./networkRuntime.ts";
import type { NetworkRuntime, Registration } from "./networkRuntime.ts";
import type { Device, PacketEvent, PingResult, Topology } from "./types.ts";

export function phoneManager(t: Topology, phone: Device): string {
  if (phone.managerAddress) return phone.managerAddress;
  const nic = phone.ports[0];
  if (nic.addressMode !== "dhcp" || !nic.ip) return "";
  if (nic.dhcpLease?.address === nic.ip) return nic.dhcpLease.tftp ?? "";
  for (const d of t.devices) {
    const lease = d.services?.dhcp.leases.find(
      (l) => l.client === phone.id && l.port === nic.id && l.ip === nic.ip,
    );
    if (lease?.tftp) return lease.tftp;
  }
  return "";
}
export const callFor = (r: NetworkRuntime, id: string) =>
  r.calls.find((c) => c.caller === id || c.callee === id);
const fail = (message: string): PingResult => ({
  ok: false,
  message,
  events: [],
  hops: [],
});
function combine(message: string, ...parts: PingResult[]): PingResult {
  return {
    ok: parts.every((p) => p.ok),
    message,
    events: parts.flatMap((p) => p.events).map((e, id) => ({ ...e, id })),
    hops: parts.flatMap((p) => p.hops),
  };
}
function exchange(
  t: Topology,
  r: NetworkRuntime,
  from: string,
  to: string,
  address: string,
  protocol: "SCCP" | "RTP",
  detail: string,
): PingResult {
  const signaling = protocol === "SCCP",
    port = signaling ? 2000 : 16384;
  const result = probeIPv4(
    t,
    from,
    address,
    signaling ? "tcp" : "udp",
    port,
    r,
  );
  if (!result.ok) return result;
  if (
    result.destinationDevice !== to ||
    result.destinationAddress !== address ||
    result.destinationPort !== port
  )
    return {
      ...result,
      ok: false,
      message: "The exchange reached a different endpoint.",
    };
  const event: PacketEvent = {
    id: result.events.length,
    protocol,
    from,
    to,
    detail,
    phase: "request",
    layer: 7,
    ttl: 32,
  };
  return { ...result, message: detail, events: [...result.events, event] };
}
function signal(
  t: Topology,
  r: NetworkRuntime,
  reg: Registration,
  detail: string,
) {
  return exchange(t, r, reg.phone, reg.router, reg.manager, "SCCP", detail);
}
export function registerPhone(
  t: Topology,
  r: NetworkRuntime,
  id: string,
): PingResult {
  bindRuntime(r, t);
  const phone = t.devices.find((d) => d.kind === "phone" && d.id === id);
  if (!phone || !phone.powered || !phone.ports[0].enabled || !phone.ports[0].ip)
    return fail("Enable the phone and configure its Network IPv4 address.");
  const manager = phoneManager(t, phone);
  if (!manager)
    return fail("Set the call manager address or obtain DHCP option 150.");
  const router = t.devices.find((d) => d.callManager?.address === manager);
  if (!router) return fail("No call manager is configured at " + manager + ".");
  const reply = exchange(
    t,
    r,
    id,
    router.id,
    manager,
    "SCCP",
    "Phone registration request.",
  );
  if (!reply.ok) return reply;
  const line = router.callManager!.lines.find(
    (l) => l.mac === interfaceMac(id, "p0"),
  );
  if (!line)
    return {
      ...reply,
      ok: false,
      message:
        "Registration rejected. The manager has no directory line for this MAC.",
    };
  const previous = r.registrations.find((reg) => reg.phone === id);
  if (
    previous &&
    (previous.router !== router.id || previous.number !== line.number)
  )
    r.calls = r.calls.filter((c) => c.caller !== id && c.callee !== id);
  r.registrations = r.registrations.filter((reg) => reg.phone !== id);
  r.phoneChecks.set(id, {
    next: r.time + 30,
    missed: 0,
    message: "Registered extension " + line.number + ".",
  });
  r.registrations.push({
    phone: id,
    router: router.id,
    manager,
    address: phone.ports[0].ip,
    number: line.number,
  });
  return {
    ...reply,
    message: "Registered extension " + line.number + ".",
    events: [
      ...reply.events,
      {
        id: reply.events.length,
        protocol: "SCCP",
        from: router.id,
        to: id,
        phase: "reply",
        layer: 7,
        ttl: 32,
        detail: "Directory line assigned: " + line.number,
      },
    ],
  };
}
export function checkRegisteredPhone(
  t: Topology,
  r: NetworkRuntime,
  reg: Registration,
) {
  const phone = t.devices.find((d) => d.id === reg.phone)!;
  const router = t.devices.find((d) => d.id === reg.router);
  const line = router?.callManager?.lines.find(
    (l) => l.mac === interfaceMac(phone.id, "p0"),
  );
  if (phoneManager(t, phone) !== reg.manager || line?.number !== reg.number)
    return fail("The assigned line or call manager changed.");
  return signal(t, r, reg, "Call manager keepalive.");
}
export function dialPhone(
  t: Topology,
  r: NetworkRuntime,
  id: string,
  number: string,
): PingResult {
  bindRuntime(r, t);
  const caller = r.registrations.find((e) => e.phone === id);
  if (!caller) return fail("Register this phone before dialing.");
  if (callFor(r, id)) return fail("This line is busy.");
  const request = signal(t, r, caller, "Dial " + number + ".");
  if (!request.ok) return request;
  const manager = t.devices.find((d) => d.id === caller.router)!.callManager!;
  if (!manager.lines.some((line) => line.number === number))
    return { ...request, ok: false, message: "Unknown extension." };
  const dest = r.registrations.find(
    (e) => e.router === caller.router && e.number === number,
  );
  if (!dest)
    return {
      ...request,
      ok: false,
      message: "The destination phone is unregistered.",
    };
  if (dest.phone === id || callFor(r, dest.phone))
    return { ...request, ok: false, message: "The destination line is busy." };
  const ring = signal(
    t,
    r,
    dest,
    "Ringing acknowledgement for " + number + ".",
  );
  if (!ring.ok) return combine(ring.message, request, ring);
  r.calls.push({
    caller: id,
    callee: dest.phone,
    state: "ringing",
    started: r.time,
  });
  return combine("Ringing extension " + number + ".", request, ring);
}
export function answerPhone(
  t: Topology,
  r: NetworkRuntime,
  id: string,
): PingResult {
  bindRuntime(r, t);
  const call = callFor(r, id);
  if (!call || call.callee !== id || call.state !== "ringing")
    return fail("There is no incoming call to answer.");
  const a = r.registrations.find((reg) => reg.phone === id)!,
    b = r.registrations.find((reg) => reg.phone === call.caller)!;
  const answer = signal(t, r, a, "Handset answered.");
  if (!answer.ok) return answer;
  const open = signal(t, r, b, "Open media channel.");
  if (!open.ok) return combine(open.message, answer, open);
  const incoming = exchange(
    t,
    r,
    b.phone,
    a.phone,
    a.address,
    "RTP",
    "Open caller media path.",
  );
  if (!incoming.ok) return combine(incoming.message, answer, open, incoming);
  const outgoing = exchange(
    t,
    r,
    a.phone,
    b.phone,
    b.address,
    "RTP",
    "Open answering media path.",
  );
  if (outgoing.ok) call.state = "connected";
  return combine(
    outgoing.ok ? "Call connected." : outgoing.message,
    answer,
    open,
    incoming,
    outgoing,
  );
}
export function sendPhoneNote(
  t: Topology,
  r: NetworkRuntime,
  id: string,
  note: "Do" | "Re" | "Mi",
): PingResult {
  bindRuntime(r, t);
  const call = callFor(r, id);
  if (call?.state !== "connected")
    return fail("Answer the call before sending a note.");
  const peer = r.registrations.find(
    (reg) => reg.phone === (id === call.caller ? call.callee : call.caller),
  )!;
  const result = exchange(
    t,
    r,
    id,
    peer.phone,
    peer.address,
    "RTP",
    "Received note " + note + ".",
  );
  if (result.ok) call.lastNote = { to: peer.phone, note };
  return result;
}
export function hangUp(t: Topology, r: NetworkRuntime, id: string): PingResult {
  bindRuntime(r, t);
  const call = callFor(r, id);
  if (!call) return fail("This line is idle.");
  const reg = r.registrations.find((e) => e.phone === id)!;
  const result = signal(t, r, reg, "Handset on hook.");
  r.calls = r.calls.filter((c) => c !== call);
  return {
    ...result,
    message: result.ok ? "Call ended." : "Local call ended. " + result.message,
  };
}
