import { isPacketEndpoint, packetInterfaces } from "./vlanInterfaces.ts";
import { DEFAULT_SCENARIO_ID } from "./scenarios.ts";
import { ping6 } from "./ipv6Engine.ts";
import { probeIPv4 } from "./engine.ts";
import type { Device, PingResult, Topology, UserPdu } from "./types.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
import { list, integer, text, object, unique } from "./validation.ts";
export const MAX_PDUS = 64;
export function parsePdus(
  value: unknown,
  devices: Device[],
  scenarios = [DEFAULT_SCENARIO_ID],
): UserPdu[] {
  const pdus = list(value, MAX_PDUS).map((raw) => {
    const def = object(raw),
      id = text(def.id, 80),
      source = text(def.source, 80),
      target = text(def.target, 80),
      port = text(def.port, 80);
    const from = devices.find((d) => d.id === source),
      to = devices.find((d) => d.id === target);
    if (
      !from ||
      !isPacketEndpoint(from) ||
      !to ||
      !isPacketEndpoint(to) ||
      !packetInterfaces(to).some((p) => p.id === port)
    )
      throw Error("A PDU needs valid source and destination endpoints.");
    const protocol = def.protocol;
    if (
      protocol !== "icmp" &&
      protocol !== "icmpv6" &&
      protocol !== "tcp" &&
      protocol !== "udp"
    )
      throw Error("Unsupported PDU protocol.");
    if (
      (protocol === "icmp" || protocol === "icmpv6") &&
      def.destinationPort !== undefined
    )
      throw Error("ICMP PDUs do not take a transport port.");
    const pdu: UserPdu = { id, source, target, port, protocol };
    if (def.ttl !== undefined) pdu.ttl = integer(def.ttl, 1, 255);
    if (def.sourceInterface !== undefined) {
      const id = text(def.sourceInterface, 80);
      if (
        protocol !== "icmpv6" ||
        !packetInterfaces(from).some((p) => p.id === id)
      )
        throw Error("Select a valid IPv6 source interface.");
      pdu.sourceInterface = id;
    }
    if (def.scenario !== undefined) {
      pdu.scenario = text(def.scenario, 80);
      if (!scenarios.includes(pdu.scenario))
        throw Error("Unknown PDU scenario.");
    }
    if (def.schedule !== undefined) {
      const schedule = object(def.schedule);
      pdu.schedule = {
        delay: integer(schedule.delay, 0, 86400),
        ...(schedule.interval === undefined
          ? {}
          : { interval: integer(schedule.interval, 1, 86400) }),
      };
    }
    if (protocol === "tcp" || protocol === "udp")
      pdu.destinationPort = integer(def.destinationPort, 1, 65535);
    return pdu;
  });
  unique(pdus.map((p) => p.id));
  return pdus;
}
export function runPdu(
  t: Topology,
  pdu: UserPdu,
  r: NetworkRuntime,
): PingResult {
  const target = t.devices.find((d) => d.id === pdu.target),
    port = target?.ports.find((p) => p.id === pdu.port);
  const address = pdu.protocol === "icmpv6" ? port?.ipv6 : port?.ip;
  let result: PingResult;
  if (!address) {
    result = {
      ok: false,
      message:
        "The destination interface has no " +
        (pdu.protocol === "icmpv6" ? "IPv6" : "IPv4") +
        " address.",
      events: [],
      hops: [],
    };
  } else if (pdu.protocol === "icmpv6") {
    result = ping6(t, pdu.source, address, pdu.sourceInterface, r, pdu.ttl);
  } else {
    result = probeIPv4(
      t,
      pdu.source,
      address,
      pdu.protocol,
      pdu.destinationPort,
      r,
      pdu.ttl,
    );
  }
  if (result.ok && result.destinationDevice !== pdu.target) {
    result.ok = false;
    result.message = "The packet reached another endpoint.";
  }
  if (t.pdus?.some((p) => p.id === pdu.id)) r.pduResults.set(pdu.id, result);
  return result;
}
