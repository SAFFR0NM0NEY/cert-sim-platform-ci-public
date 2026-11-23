import type { Device, PacketContext, Port } from "./types.ts";
import { sameSubnet } from "./addressing.ts";
export function aclDecision(
  device: Device,
  port: Port,
  direction: "in" | "out",
  packet: PacketContext,
): { permit: boolean; detail: string } | null {
  const name = direction === "in" ? port.inboundAcl : port.outboundAcl;
  if (!name) return null;
  const acl = device.accessLists?.find((a) => a.name === name);
  if (!acl)
    return { permit: false, detail: `Missing ACL ${name}: fail closed.` };
  const index = acl.rules.findIndex(
    (rule) =>
      (rule.protocol === "ip" || rule.protocol === packet.protocol) &&
      sameSubnet(rule.source, packet.sourceIp, rule.sourcePrefix) &&
      sameSubnet(
        rule.destination,
        packet.destinationIp,
        rule.destinationPrefix,
      ) &&
      (rule.destinationPort === undefined ||
        rule.destinationPort === packet.destinationPort),
  );
  return index < 0
    ? {
        permit: false,
        detail: `${name} ${direction} on ${port.name}: implicit deny.`,
      }
    : {
        permit: acl.rules[index].action === "permit",
        detail: `${name} ${direction} on ${port.name}: rule ${index + 1} ${acl.rules[index].action} ${packet.protocol.toUpperCase()}.`,
      };
}
