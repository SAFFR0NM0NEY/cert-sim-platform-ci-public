import type { Device, Endpoint, Port, Topology } from "./types.ts";
import { vlanActive } from "./vlans.ts";
import { operationalSwitchport } from "./dtp.ts";
import { isSwitchport } from "./vlanInterfaces.ts";
import {
  bridgePorts,
  channelState,
  forwardingLinks,
  selectForwardingMember,
} from "./etherChannel.ts";
import { getPort, linkUp } from "./model.ts";
import { spanningTree, bridgeMac, carriesVlan } from "./spanningTree.ts";
import { phoneVoiceVlan } from "./discovery.ts";
import { synchronizeBpduGuard } from "./bpduGuard.ts";
import { bindRuntime } from "./networkRuntime.ts";
import type { NetworkRuntime, AddressBinding } from "./networkRuntime.ts";
import {
  admitSecureSource,
  secureDestination,
  securityDown,
} from "./portSecurity.ts";
import { associatedAccessPoint, wirelessAssociations } from "./wireless.ts";
import { formatIPv6, ipv6 } from "./ipv6Address.ts";
import { natProxy } from "./nat.ts";
export const interfaceMac = (device: string, port: string) =>
  bridgeMac(`${device}/${port}`);
export const portMac = (device: Device, port: Port) =>
  interfaceMac(
    device.id,
    port.virtual?.kind === "subinterface" ? port.virtual.parent : port.id,
  );

export function portOperational(
  t: Topology,
  device: string,
  port: string,
  runtime?: NetworkRuntime,
): boolean {
  const current = t.devices.find((d) => d.id === device);
  const p = current?.ports.find((p) => p.id === port);
  if (
    !current?.powered ||
    !p?.enabled ||
    (runtime && securityDown(runtime, device, port))
  )
    return false;
  if (p.virtual?.kind === "portchannel")
    return channelState(t, device, p.virtual.group, runtime).up;
  if (p.virtual?.kind === "subinterface")
    return (
      p.virtual.vlan !== undefined &&
      portOperational(t, device, p.virtual.parent, runtime)
    );
  if (p.virtual?.kind === "svi") {
    const vlan = p.virtual.vlan;
    if (!vlanActive(current, vlan)) return false;
    const tree = spanningTree(t, vlan, runtime);
    return bridgePorts(t, current, runtime).some(
      (physical) =>
        carriesVlan(
          operationalSwitchport(t, current, physical, runtime),
          vlan,
        ) &&
        portOperational(t, device, physical.id, runtime) &&
        tree.some(
          (s) =>
            s.device === device &&
            s.port === physical.id &&
            s.state === "forwarding",
        ),
    );
  }
  // Model independent data/voice membership for autostate; the voice-only native edge is unverified.
  if (
    isSwitchport(current, p) &&
    operationalSwitchport(t, current, p, runtime).mode === "access" &&
    !vlanActive(current, p.vlan) &&
    (!p.voiceVlan || !vlanActive(current, p.voiceVlan))
  )
    return false;
  if (p.channelGroup) {
    const member = channelState(
      t,
      device,
      p.channelGroup.id,
      runtime,
    ).members.find((m) => m.port === p.id);
    return member?.status === "bundled" || member?.status === "individual";
  }
  if (current.kind === "laptop" && port === "p0")
    return !!associatedAccessPoint(t, current);
  return t.links.some(
    (l) =>
      [l.a, l.b].some((e) => e.device === device && e.port === port) &&
      linkUp(t, l, runtime),
  );
}
export type Hop = { from: string; to: string; link?: string };
export type L2Path = { device: Device; port: Port; hops: Hop[] };
function vlanAccept(
  device: Device,
  port: Port,
  tag: number | null,
): number | null {
  if (port.virtual?.kind === "subinterface")
    return port.virtual.vlan !== undefined &&
      (tag === port.virtual.vlan || (port.virtual.native && tag === null))
      ? port.virtual.vlan
      : null;
  if (!isSwitchport(device, port))
    return tag === (port.taggedVlan ?? null) ? (port.taggedVlan ?? 1) : null;
  const vlan =
    port.mode === "access"
      ? tag === null
        ? port.vlan
        : tag === port.voiceVlan
          ? tag
          : undefined
      : (tag ?? port.nativeVlan);
  return vlan !== undefined &&
    vlanActive(device, vlan) &&
    (port.mode === "access" || port.allowedVlans.includes(vlan))
    ? vlan
    : null;
}
function outgoingTag(
  device: Device,
  port: Port,
  vlan: number,
): number | null | false {
  if (!isSwitchport(device, port)) return port.taggedVlan ?? null;
  if (!vlanActive(device, vlan)) return false;
  if (port.mode === "access")
    return port.vlan === vlan ? null : port.voiceVlan === vlan ? vlan : false;
  if (!port.allowedVlans.includes(vlan)) return false;
  return vlan === port.nativeVlan ? null : vlan;
}
/** VLAN-aware broadcast-domain traversal. No IP address is required on the origin. */
export function layer2Peers(
  t: Topology,
  start: Endpoint,
  frame?: { runtime: NetworkRuntime; source: string; destination: string },
  runtime = frame?.runtime,
): L2Path[] {
  const origin = t.devices.find((d) => d.id === start.device),
    originPort = getPort(t, start);
  if (
    !origin?.powered ||
    !originPort?.enabled ||
    (originPort.virtual &&
      !portOperational(t, origin.id, originPort.id, runtime)) ||
    originPort.channelGroup ||
    (origin.kind === "phone" && originPort.id !== "p0")
  )
    return [];
  if (originPort.media === "serial") {
    if (frame) return [];
    const link = t.links.find(
      (l) =>
        l.cable === "serial" &&
        [l.a, l.b].some(
          (e) => e.device === start.device && e.port === start.port,
        ),
    );
    if (!link || !linkUp(t, link, runtime)) return [];
    const peer = link.a.device === start.device ? link.b : link.a;
    const device = t.devices.find((d) => d.id === peer.device),
      port = getPort(t, peer);
    return device && port
      ? [
          {
            device,
            port,
            hops: [{ from: start.device, to: device.id, link: link.id }],
          },
        ]
      : [];
  }
  const links = forwardingLinks(t, runtime);
  const trees = new Map<number, ReturnType<typeof spanningTree>>();
  const forwards = (device: string, port: string, vlan: number) => {
    if (!trees.has(vlan)) trees.set(vlan, spanningTree(t, vlan, runtime));
    return trees
      .get(vlan)!
      .some(
        (p) =>
          p.device === device && p.port === port && p.state === "forwarding",
      );
  };

  const queue: { endpoint: Endpoint; tag: number | null; hops: Hop[] }[] = [
    {
      endpoint:
        originPort.virtual?.kind === "subinterface"
          ? { device: origin.id, port: originPort.virtual.parent }
          : start,
      tag:
        originPort.virtual?.kind === "subinterface"
          ? originPort.virtual.native
            ? null
            : originPort.virtual.vlan!
          : origin.kind === "phone"
            ? (phoneVoiceVlan(t, origin, runtime) ?? null)
            : origin.kind === "switch"
              ? null
              : (originPort.taggedVlan ?? null),
      hops: [],
    },
  ];
  if (originPort.virtual?.kind === "svi") {
    queue.length = 0;
    const vlan = originPort.virtual.vlan;
    const known =
      frame && !multicast(frame.destination)
        ? (secureDestination(origin, vlan, frame.destination, frame.runtime) ??
          origin.staticMac?.find(
            (e) => e.vlan === vlan && e.mac === frame.destination,
          ) ??
          frame.runtime.mac.find(
            (e) =>
              e.device === origin.id &&
              e.vlan === vlan &&
              e.mac === frame.destination,
          ))
        : undefined;
    const outputs: string[] = [];
    for (const p of bridgePorts(t, origin, runtime).filter(
      (p) =>
        isSwitchport(origin, p) && p.enabled && (!known || known.port === p.id),
    )) {
      const tag = outgoingTag(
        origin,
        operationalSwitchport(t, origin, p, runtime),
        vlan,
      );
      if (
        tag !== false &&
        forwards(origin.id, p.id, vlan) &&
        (!runtime || !securityDown(runtime, origin.id, p.id))
      ) {
        outputs.push(p.id);
        queue.push({
          endpoint: { device: origin.id, port: p.id },
          tag,
          hops: [],
        });
      }
    }
    if (frame) {
      frame.runtime.frames.push({
        device: origin.id,
        vlan,
        source: frame.source,
        destination: frame.destination,
        ingress: originPort.id,
        egress: outputs,
        action: known ? (outputs.length ? "forward" : "filter") : "flood",
        time: frame.runtime.time,
      });
      frame.runtime.frames = frame.runtime.frames.slice(-256);
    }
  }
  if (origin.kind === "phone" && queue[0].tag === null) {
    queue.push({
      endpoint: { device: origin.id, port: "p1" },
      tag: null,
      hops: [],
    });
  }
  const seen = new Set<string>(),
    delivered = new Set<string>(),
    result: L2Path[] = [];
  const associations = wirelessAssociations(t);
  for (let index = 0; index < queue.length; index++) {
    const state = queue[index],
      key = `${state.endpoint.device}/${state.endpoint.port}/${state.tag}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (getPort(t, state.endpoint)?.media === "radio") {
      const node = t.devices.find((d) => d.id === state.endpoint.device)!;
      const ap =
        node.kind === "ap"
          ? node
          : associations.find((a) => a.client.id === node.id)?.ap;
      if (!ap) continue;
      const hops =
        node === ap
          ? state.hops
          : [...state.hops, { from: node.id, to: ap.id }];
      if (node !== ap)
        queue.push({
          endpoint: { device: ap.id, port: "p0" },
          tag: null,
          hops,
        });
      for (const { ap: owner, client } of associations) {
        if (
          owner.id !== ap.id ||
          client.id === start.device ||
          delivered.has(client.id)
        )
          continue;
        if (
          frame &&
          !multicast(frame.destination) &&
          frame.destination !== interfaceMac(client.id, "p0")
        )
          continue;
        result.push({
          device: client,
          port: client.ports[0],
          hops: [...hops, { from: ap.id, to: client.id }],
        });
        delivered.add(client.id);
      }
      continue;
    }
    const link = links.find((l) =>
      [l.a, l.b].some(
        (e) =>
          e.device === state.endpoint.device && e.port === state.endpoint.port,
      ),
    );
    if (!link) continue;
    const selected = selectForwardingMember(
      link,
      state.endpoint,
      t.devices.find((d) => d.id === state.endpoint.device)
        ?.etherChannelLoadBalance,
      frame?.source ?? "",
      frame?.destination ?? "",
    );
    if (frame && getPort(t, state.endpoint)?.virtual?.kind === "portchannel") {
      const decision = [...frame.runtime.frames]
        .reverse()
        .find(
          (f) =>
            f.device === state.endpoint.device &&
            f.time === frame.runtime.time &&
            f.source === frame.source &&
            f.destination === frame.destination &&
            f.egress.includes(state.endpoint.port) &&
            !f.channelMembers?.some((m) => m.channel === state.endpoint.port),
        );
      const evidence = {
        channel: state.endpoint.port,
        member: selected.local.port,
        link: selected.linkId,
      };
      if (decision) (decision.channelMembers ??= []).push(evidence);
      else if (
        state.endpoint.device === origin.id &&
        originPort.virtual?.kind === "portchannel"
      ) {
        frame.runtime.frames.push({
          device: origin.id,
          vlan: 1,
          source: frame.source,
          destination: frame.destination,
          ingress: originPort.id,
          egress: [originPort.id],
          channelMembers: [evidence],
          action: "forward",
          time: frame.runtime.time,
        });
        frame.runtime.frames = frame.runtime.frames.slice(-256);
      }
    }
    const other =
      link.a.device === state.endpoint.device &&
      link.a.port === state.endpoint.port
        ? link.b
        : link.a;
    const d = t.devices.find((d) => d.id === other.device)!;
    let p = getPort(t, other)!;
    if (d.kind === "router") {
      const children = d.ports.filter(
        (child) =>
          child.virtual?.kind === "subinterface" &&
          child.virtual.parent === p.id,
      );
      const child = children.find(
        (child) =>
          child.virtual?.kind === "subinterface" &&
          child.virtual.vlan !== undefined &&
          (child.virtual.native
            ? state.tag === null || state.tag === child.virtual.vlan
            : state.tag === child.virtual.vlan),
      );
      if (child) {
        if (!child.enabled) continue;
        p = child;
      } else if (state.tag !== null) continue;
    }
    if (d.kind === "ap") {
      if (state.tag === null && d.ports[1].enabled)
        queue.push({
          endpoint: { device: d.id, port: "p1" },
          tag: null,
          hops: [
            ...state.hops,
            { from: state.endpoint.device, to: d.id, link: selected.linkId },
          ],
        });
      continue;
    }
    if (d.kind === "phone") {
      const hops = [
        ...state.hops,
        { from: state.endpoint.device, to: d.id, link: selected.linkId },
      ];
      const voiceTag = phoneVoiceVlan(t, d, runtime) ?? null;
      if (
        (p.id === "p0" || state.tag === null) &&
        d.ports[0].enabled &&
        state.tag === voiceTag &&
        d.id !== start.device &&
        !delivered.has(d.id) &&
        (!frame ||
          multicast(frame.destination) ||
          frame.destination === interfaceMac(d.id, "p0"))
      ) {
        result.push({ device: d, port: d.ports[0], hops });
        delivered.add(d.id);
      }
      if (
        state.tag === null &&
        (!frame || frame.destination !== interfaceMac(d.id, "p0"))
      ) {
        queue.push({
          endpoint: { device: d.id, port: p.id === "p0" ? "p1" : "p0" },
          tag: null,
          hops,
        });
      }
      continue;
    }
    const vlan = vlanAccept(
      d,
      operationalSwitchport(t, d, p, runtime),
      state.tag,
    );
    if (vlan === null) continue;
    if (isSwitchport(d, p) && !forwards(d.id, p.id, vlan)) continue;
    if (
      frame &&
      isSwitchport(d, p) &&
      !admitSecureSource(d, p, frame.source, frame.runtime, vlan)
    ) {
      frame.runtime.frames.push({
        device: d.id,
        vlan,
        source: frame.source,
        destination: frame.destination,
        ingress: p.id,
        egress: [],
        action: "security-drop",
        time: frame.runtime.time,
      });
      frame.runtime.frames = frame.runtime.frames.slice(-256);
      continue;
    }
    const hops = [
      ...state.hops,
      { from: state.endpoint.device, to: d.id, link: selected.linkId },
    ];
    if (!isSwitchport(d, p)) {
      const identity = `${d.id}/${p.id}`;
      if (
        d.id !== start.device &&
        !delivered.has(identity) &&
        (!frame ||
          multicast(frame.destination) ||
          portMac(d, p) === frame.destination)
      ) {
        result.push({ device: d, port: p, hops });
        delivered.add(identity);
      }
    } else {
      const svi = d.ports.find(
        (candidate) =>
          candidate.virtual?.kind === "svi" &&
          candidate.virtual.vlan === vlan &&
          candidate.enabled,
      );
      const localFrame = svi && frame?.destination === portMac(d, svi);
      if (
        svi &&
        d.id !== start.device &&
        (!frame || multicast(frame.destination) || localFrame) &&
        !delivered.has(d.id + "/" + svi.id)
      ) {
        result.push({ device: d, port: svi, hops });
        delivered.add(d.id + "/" + svi.id);
      }
      if (frame) {
        const r = frame.runtime;
        const existing = r.mac.find(
          (e) => e.device === d.id && e.vlan === vlan && e.mac === frame.source,
        );
        const secureOwner = secureDestination(d, vlan, frame.source, r);
        if (existing && (!secureOwner || secureOwner.port === p.id)) {
          existing.port = p.id;
          existing.lastSeen = r.time;
        } else if (
          !existing &&
          (!secureOwner || secureOwner.port === p.id) &&
          !multicast(frame.source) &&
          !d.staticMac?.some((e) => e.vlan === vlan && e.mac === frame.source)
        ) {
          if (r.mac.length >= 4096)
            r.mac.splice(
              r.mac.reduce(
                (best, e, i) => (e.lastSeen < r.mac[best].lastSeen ? i : best),
                0,
              ),
              1,
            );
          r.mac.push({
            device: d.id,
            vlan,
            mac: frame.source,
            port: p.id,
            lastSeen: r.time,
          });
        }
      }
      if (localFrame) continue;
      const known =
        frame && !multicast(frame.destination)
          ? (secureDestination(d, vlan, frame.destination, frame.runtime) ??
            d.staticMac?.find(
              (e) => e.vlan === vlan && e.mac === frame.destination,
            ) ??
            frame.runtime.mac.find(
              (e) =>
                e.device === d.id &&
                e.vlan === vlan &&
                e.mac === frame.destination,
            ))
          : undefined;
      const outputs: string[] = [];
      for (const egress of bridgePorts(t, d, runtime).filter(
        (e) =>
          isSwitchport(d, e) &&
          e.id !== p.id &&
          e.enabled &&
          (!frame || !securityDown(frame.runtime, d.id, e.id)) &&
          (!known || known.port === e.id),
      )) {
        const tag = outgoingTag(
          d,
          operationalSwitchport(t, d, egress, runtime),
          vlan,
        );
        if (tag !== false && forwards(d.id, egress.id, vlan)) {
          outputs.push(egress.id);
          queue.push({
            endpoint: { device: d.id, port: egress.id },
            tag,
            hops,
          });
        }
      }
      if (frame) {
        frame.runtime.frames.push({
          device: d.id,
          vlan,
          source: frame.source,
          destination: frame.destination,
          ingress: p.id,
          egress: outputs,
          action: known ? (outputs.length ? "forward" : "filter") : "flood",
          time: frame.runtime.time,
        });
        frame.runtime.frames = frame.runtime.frames.slice(-256);
      }
    }
  }
  return result;
}
const multicast = (mac: string) => (parseInt(mac.slice(0, 2), 16) & 1) !== 0;
export function transmitFrame(
  t: Topology,
  start: Endpoint,
  destination: string,
  runtime: NetworkRuntime,
  source?: string,
): L2Path[] {
  const owner = t.devices.find((d) => d.id === start.device);
  const port = owner?.ports.find((p) => p.id === start.port);
  source ??=
    owner && port
      ? portMac(owner, port)
      : interfaceMac(start.device, start.port);
  if (
    !/^[0-9a-f]{12}$/.test(destination) ||
    !/^[0-9a-f]{12}$/.test(source) ||
    multicast(source) ||
    source === "000000000000"
  )
    throw Error("Use a 12-digit unicast source MAC and valid destination MAC.");
  bindRuntime(runtime, t);
  synchronizeBpduGuard(t, runtime);
  return layer2Peers(t, start, { runtime, source, destination });
}
type ResolvedPath = L2Path & {
  resolutionSent?: boolean;
  resolutionRequestLink?: string;
  resolutionReplyLink?: string;
};
export function resolveFrame(
  t: Topology,
  start: Endpoint,
  target: L2Path,
  runtime: NetworkRuntime,
  family: AddressBinding["family"],
  nextHop: string,
): ResolvedPath | null {
  if (target.port.media === "serial")
    return { ...target, resolutionSent: false };
  const address = family === "ipv6" ? formatIPv6(ipv6(nextHop)!) : nextHop;
  const destMac = portMac(target.device, target.port);
  const matchesTarget = (p: L2Path) =>
    p.device.id === target.device.id && p.port.id === target.port.id;
  const cached = runtime.addressBindings.find(
    (e) =>
      e.device === start.device &&
      e.port === start.port &&
      e.address === address &&
      e.family === family &&
      e.expires > runtime.time,
  );
  if (cached) {
    const delivered = transmitFrame(t, start, cached.mac, runtime).find(
      matchesTarget,
    );
    return delivered ? { ...delivered, resolutionSent: false } : null;
  }
  const request = transmitFrame(t, start, "ffffffffffff", runtime).find(
    matchesTarget,
  );
  if (!request) return null;
  const reply = transmitFrame(
    t,
    { device: target.device.id, port: target.port.id },
    portMac(t.devices.find((d) => d.id === start.device)!, getPort(t, start)!),
    runtime,
  ).find((p) => p.device.id === start.device && p.port.id === start.port);
  if (!reply) return null;
  if (runtime.addressBindings.length >= 4096) runtime.addressBindings.shift();
  runtime.addressBindings.push({
    family,
    ...start,
    address,
    mac: destMac,
    learned: runtime.time,
    expires: runtime.time + (family === "ipv4" ? 14400 : 30),
  });
  const delivered = transmitFrame(t, start, destMac, runtime).find(
    matchesTarget,
  );
  return delivered
    ? {
        ...delivered,
        resolutionSent: true,
        ...(request.hops.length === 1 && request.hops[0].link
          ? { resolutionRequestLink: request.hops[0].link }
          : {}),
        ...(reply.hops.length === 1 && reply.hops[0].link
          ? { resolutionReplyLink: reply.hops[0].link }
          : {}),
      }
    : null;
}
export function l2Reach(
  t: Topology,
  start: Endpoint,
  targetIp: string,
  runtime?: NetworkRuntime,
): ResolvedPath | null {
  const target = layer2Peers(t, start, undefined, runtime).find(
    (peer) =>
      peer.port.ip === targetIp ||
      natProxy(peer.device, peer.port, targetIp, runtime),
  );
  return target
    ? runtime
      ? resolveFrame(t, start, target, runtime, "ipv4", targetIp)
      : target
    : null;
}
