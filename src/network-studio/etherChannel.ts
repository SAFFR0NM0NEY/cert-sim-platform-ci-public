import type {
  ChannelMode,
  Device,
  Endpoint,
  Link,
  Port,
  Topology,
} from "./types.ts";
import type { NetworkRuntime } from "./networkRuntime.ts";
import { linkUp } from "./model.ts";
import { securityDown } from "./portSecurity.ts";
import { integer } from "./validation.ts";

export type ChannelProtocol = "on" | "lacp" | "pagp";
export type ChannelMember = {
  port: string;
  status: "bundled" | "individual" | "suspended" | "down";
  reason: string;
  peer?: Endpoint;
};
export type ForwardingLink = {
  id: string;
  a: Endpoint;
  b: Endpoint;
  /** Physical links represented by this single forwarding adjacency. */
  members: Link[];
};
const sameEndpoint = (a: Endpoint, b: Endpoint) =>
  a.device === b.device && a.port === b.port;
const key = (e: Endpoint) => e.device + "/" + e.port;
export const channelProtocol = (mode: ChannelMode): ChannelProtocol =>
  mode === "on"
    ? "on"
    : mode === "active" || mode === "passive"
      ? "lacp"
      : "pagp";
const aggregate = (d: Device, group: number) =>
  d.ports.find(
    (p) => p.virtual?.kind === "portchannel" && p.virtual.group === group,
  );
const switchKeys = [
  "mode",
  "nonegotiate",
  "vlan",
  "nativeVlan",
  "allowedVlans",
  "routed",
] as const;
const propagatedKeys = [
  ...switchKeys,
  "enabled",
  "spanningTreeCost",
  "portFast",
  "bpduGuard",
] as const;
const value = (p: Port, k: (typeof switchKeys)[number]) =>
  k === "allowedVlans"
    ? [...p.allowedVlans].sort((a, b) => a - b)
    : k === "routed"
      ? !!p.routed
      : p[k];
function consistent(member: Port, po: Port): boolean {
  if (!!member.routed !== !!po.routed) return false;
  if (member.routed) return true;
  if (member.mode !== po.mode || !!member.nonegotiate !== !!po.nonegotiate)
    return false;
  if (member.mode === "access") return member.vlan === po.vlan;
  if (member.mode !== "trunk" && member.vlan !== po.vlan) return false;
  return (["nativeVlan", "allowedVlans"] as const).every(
    (k) => JSON.stringify(value(member, k)) === JSON.stringify(value(po, k)),
  );
}
function copyKeys(target: Port, source: Port, keys: readonly (keyof Port)[]) {
  const output = target as unknown as Record<string, unknown>;
  for (const k of keys) {
    if (source[k] === undefined) delete output[k];
    else output[k] = structuredClone(source[k]);
  }
}
export function createPortChannel(d: Device, group: number): Port {
  integer(group, 1, 6);
  if (d.kind !== "switch") throw Error("Port-channels require a switch.");
  if (d.ports.length >= 32)
    throw Error("This device supports up to 32 interfaces.");
  if (aggregate(d, group)) throw Error("That Port-channel already exists.");
  return {
    id: "port-channel:" + group,
    name: "Port-channel" + group,
    media: "copper",
    virtual: { kind: "portchannel", group },
    enabled: true,
    ip: "",
    prefix: 24,
    mode: "access",
    vlan: 1,
    allowedVlans: [1],
  };
}
export function validateChannels(
  d: Pick<Device, "kind" | "ports" | "etherChannelLoadBalance" | "staticMac">,
): void {
  if (
    d.etherChannelLoadBalance !== undefined &&
    (d.kind !== "switch" ||
      !["src-mac", "dst-mac", "src-dst-mac"].includes(
        d.etherChannelLoadBalance,
      ))
  )
    throw Error("Unsupported EtherChannel load-balancing policy.");
  const groups = new Map<number, Port[]>();
  for (const p of d.ports) {
    if (
      p.channelProtocol !== undefined &&
      (d.kind !== "switch" ||
        p.virtual ||
        !["copper", "fiber"].includes(p.media) ||
        !["lacp", "pagp"].includes(p.channelProtocol))
    )
      throw Error("Channel protocol requires a physical switch Ethernet port.");
    if (!p.channelGroup) continue;
    integer(p.channelGroup.id, 1, 6);
    if (
      d.kind !== "switch" ||
      p.virtual ||
      !["copper", "fiber"].includes(p.media) ||
      !["on", "active", "passive", "desirable", "auto"].includes(
        p.channelGroup.mode,
      )
    )
      throw Error("Invalid EtherChannel member or negotiation mode.");
    if (
      p.channelProtocol &&
      channelProtocol(p.channelGroup.mode) !== p.channelProtocol
    )
      throw Error("Channel protocol conflicts with the membership mode.");
    if (d.staticMac?.some((entry) => entry.port === p.id))
      throw Error(
        "Move static MAC entries to the Port-channel before enrolling this member.",
      );
    if (p.security || p.voiceVlan !== undefined)
      throw Error(
        "Remove port security and voice VLAN before joining an EtherChannel.",
      );
    if (
      p.ip ||
      p.ipv6 ||
      p.helperAddresses?.length ||
      p.inboundAcl ||
      p.outboundAcl ||
      p.natRole
    )
      throw Error(
        "Configure routed addresses and services on the Port-channel, not its members.",
      );
    const po = d.ports.find(
      (p2) =>
        p2.virtual?.kind === "portchannel" &&
        p2.virtual.group === p.channelGroup!.id,
    );
    if (!po)
      throw Error(
        "An EtherChannel member requires its Port-channel interface.",
      );
    const members = groups.get(p.channelGroup.id) ?? [];
    members.push(p);
    groups.set(p.channelGroup.id, members);
  }
  for (const members of groups.values()) {
    if (members.length > 8)
      throw Error("An EtherChannel supports up to eight members.");
    if (
      new Set(members.map((p) => channelProtocol(p.channelGroup!.mode))).size >
      1
    )
      throw Error("All local members must use the same channel protocol.");
  }
}
export function setChannelGroup(
  d: Device,
  portIds: string[],
  group: number,
  mode: ChannelMode,
): Device {
  integer(group, 1, 6);
  if (!portIds.length || new Set(portIds).size !== portIds.length)
    throw Error("Select distinct physical members.");
  const next = structuredClone(d);
  const members = portIds.map((id) => {
    const p = next.ports.find((p) => p.id === id);
    if (
      !p ||
      p.virtual ||
      next.kind !== "switch" ||
      !["copper", "fiber"].includes(p.media)
    )
      throw Error("Select physical switch Ethernet ports.");
    if (p.channelGroup && p.channelGroup.id !== group)
      throw Error("Remove existing channel membership first.");
    return p;
  });
  if (!aggregate(next, group)) {
    const po = createPortChannel(next, group);
    copyKeys(po, members[0], propagatedKeys);
    po.media = members[0].media;
    next.ports.push(po);
  }
  const po = aggregate(next, group)!;
  if (!next.ports.some((p) => p.channelGroup?.id === group))
    po.media = members[0].media;
  for (const p of members) p.channelGroup = { id: group, mode };
  validateChannels(next);
  return next;
}
export function removeChannelGroup(d: Device, portIds: string[]): Device {
  const next = structuredClone(d);
  for (const id of portIds) {
    const p = next.ports.find((p) => p.id === id);
    if (!p || p.virtual)
      throw Error("Select existing physical channel members.");
    delete p.channelGroup;
  }
  return next;
}
/** Only explicit aggregate edits propagate; parsing and read-only state never reconcile snapshots. */
export function reconcilePortChannels(before: Device, next: Device): Device {
  let output = next;
  for (const po of next.ports.filter(
    (p) => p.virtual?.kind === "portchannel",
  )) {
    const old = before.ports.find((p) => p.id === po.id);
    if (!old) continue;
    const changed = propagatedKeys.filter(
      (k) => JSON.stringify(old[k]) !== JSON.stringify(po[k]),
    );
    if (!changed.length) continue;
    if (output === next) output = structuredClone(next);
    for (const member of output.ports.filter(
      (p) => p.channelGroup?.id === (po.virtual as { group: number }).group,
    ))
      copyKeys(member, po, changed);
  }
  return output;
}
function protocolMatches(a: ChannelMode, b: ChannelMode): boolean {
  const ap = channelProtocol(a),
    bp = channelProtocol(b);
  return (
    ap === bp &&
    (ap === "on" ||
      (ap === "lacp"
        ? a === "active" || b === "active"
        : a === "desirable" || b === "desirable"))
  );
}
function graph(t: Topology, r?: NetworkRuntime) {
  const states = new Map<string, ChannelMember>();
  const devices = new Map(t.devices.map((d) => [d.id, d]));
  const candidates: { link: Link; a: Endpoint; b: Endpoint }[] = [];
  const individual: ForwardingLink[] = [];
  const describe = (
    e: Endpoint,
    link?: Link,
  ): { d: Device; p: Port; po?: Port; member?: ChannelMember } => {
    const d = devices.get(e.device)!,
      p = d.ports.find((p) => p.id === e.port)!;
    if (!p.channelGroup) return { d, p };
    let member = states.get(key(e));
    const po = aggregate(d, p.channelGroup.id);
    if (!member) {
      member = {
        port: p.id,
        status: "down",
        reason: "No operational physical link.",
      };
      states.set(key(e), member);
    }
    if (link) member.peer = sameEndpoint(e, link.a) ? link.b : link.a;
    return { d, p, po, member };
  };
  for (const d of t.devices)
    for (const p of d.ports)
      if (p.channelGroup) describe({ device: d.id, port: p.id });
  for (const link of t.links) {
    const a = describe(link.a, link),
      b = describe(link.b, link);
    if (
      !linkUp(t, link, r) ||
      (r &&
        (securityDown(r, a.d.id, a.p.id) || securityDown(r, b.d.id, b.p.id)))
    )
      continue;
    if (!a.member && !b.member) {
      individual.push({ id: link.id, a: link.a, b: link.b, members: [link] });
      continue;
    }
    const bad = [a, b].find(
      (s) =>
        s.member &&
        (!s.po?.enabled || !consistent(s.p, s.po) || s.p.media !== s.po.media),
    );
    if (bad) {
      for (const s of [a, b])
        if (s.member)
          Object.assign(s.member, {
            status: "suspended",
            reason:
              "Local member settings or media differ from the Port-channel.",
          });
      continue;
    }
    if (
      a.member &&
      b.member &&
      protocolMatches(a.p.channelGroup!.mode, b.p.channelGroup!.mode)
    ) {
      candidates.push({
        link,
        a: { device: a.d.id, port: a.po!.id },
        b: { device: b.d.id, port: b.po!.id },
      });
      continue;
    }
    const staticSide = [a, b].some((s) => s.p.channelGroup?.mode === "on");
    for (const s of [a, b])
      if (s.member)
        Object.assign(s.member, {
          status: staticSide ? "suspended" : "individual",
          reason: staticSide
            ? "Static channels require on mode at both ends."
            : "Negotiation did not form a bundle; operating individually.",
        });
    if (!staticSide && !a.p.routed && !b.p.routed)
      individual.push({ id: link.id, a: link.a, b: link.b, members: [link] });
  }
  const partners = new Map<string, Set<string>>();
  for (const c of candidates)
    for (const [local, remote] of [
      [c.a, c.b],
      [c.b, c.a],
    ]) {
      const set = partners.get(key(local)) ?? new Set<string>();
      set.add(key(remote));
      partners.set(key(local), set);
    }
  const bundles = new Map<string, ForwardingLink>();
  for (const c of candidates) {
    if (
      (partners.get(key(c.a))?.size ?? 0) !== 1 ||
      (partners.get(key(c.b))?.size ?? 0) !== 1
    ) {
      for (const e of [c.link.a, c.link.b])
        Object.assign(states.get(key(e))!, {
          status: "suspended",
          reason:
            "Members connect to different partner devices or channel groups.",
        });
      continue;
    }
    for (const e of [c.link.a, c.link.b])
      Object.assign(states.get(key(e))!, {
        status: "bundled",
        reason: "Member is bundled.",
      });
    const id = [key(c.a), key(c.b)].sort().join("|");
    const bundle = bundles.get(id) ?? {
      id: "channel:" + id,
      a: c.a,
      b: c.b,
      members: [],
    };
    bundle.members.push(c.link);
    bundles.set(id, bundle);
  }
  for (const b of bundles.values())
    b.members.sort((a, b) => a.id.localeCompare(b.id));
  return { states, links: [...individual, ...bundles.values()] };
}
export function forwardingLinks(
  t: Topology,
  r?: NetworkRuntime,
): ForwardingLink[] {
  return graph(t, r).links;
}
/** Configured Po plus non-bundled physical ports, suitable for logical STP rows. */
export function bridgePorts(
  t: Topology,
  device: string | Device,
  r?: NetworkRuntime,
): Port[] {
  const d =
    typeof device === "string"
      ? t.devices.find((d) => d.id === device)
      : device;
  if (!d || d.kind !== "switch") return [];
  const { states } = graph(t, r);
  return d.ports.filter(
    (p) =>
      !p.routed &&
      (!p.virtual || p.virtual.kind === "portchannel") &&
      (!p.channelGroup ||
        states.get(key({ device: d.id, port: p.id }))?.status === "individual"),
  );
}
export function channelState(
  t: Topology,
  deviceId: string,
  group: number,
  r?: NetworkRuntime,
) {
  const d = t.devices.find((d) => d.id === deviceId),
    po = d && aggregate(d, group);
  if (!d || !po) throw Error("Port-channel does not exist.");
  const { states } = graph(t, r);
  const members = d.ports
    .filter((p) => p.channelGroup?.id === group)
    .map((p) => states.get(key({ device: d.id, port: p.id }))!);
  const protocols = new Set(
    d.ports
      .filter((p) => p.channelGroup?.id === group)
      .map((p) => channelProtocol(p.channelGroup!.mode)),
  );
  return {
    port: po,
    protocol: protocols.size === 1 ? [...protocols][0] : null,
    up: members.some((m) => m.status === "bundled"),
    members,
  };
}
export function selectForwardingMember(
  link: ForwardingLink,
  local: Endpoint,
  policy: Device["etherChannelLoadBalance"],
  sourceMac: string,
  destinationMac: string,
) {
  const input =
    policy === "dst-mac"
      ? destinationMac
      : policy === "src-dst-mac"
        ? sourceMac + destinationMac
        : sourceMac;
  let hash = 2166136261;
  for (const c of input) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
  const member = link.members[(hash >>> 0) % link.members.length];
  const localPhysical = member.a.device === local.device ? member.a : member.b;
  return {
    local: localPhysical,
    remote: member.a === localPhysical ? member.b : member.a,
    linkId: member.id,
  };
}
export function selectChannelMember(
  t: Topology,
  deviceId: string,
  poId: string,
  sourceMac: string,
  destinationMac: string,
  r?: NetworkRuntime,
) {
  const local = { device: deviceId, port: poId };
  const link = forwardingLinks(t, r).find(
    (l) => sameEndpoint(l.a, local) || sameEndpoint(l.b, local),
  );
  if (!link) return undefined;
  return selectForwardingMember(
    link,
    local,
    t.devices.find((d) => d.id === deviceId)?.etherChannelLoadBalance,
    sourceMac,
    destinationMac,
  );
}
