"""Bounded IOS EtherChannel settings on Catalyst switch chassis.

Packet Tracer 9.0.1 saves 2960 bundles in RUNNINGCONFIG, with no physical
PORT for the logical interface. The 3560 additionally mirrors membership in
ETHERCHANNEL_MANAGER. Keep configured L2NAT and unknown manager records opaque.
"""

import re
from lxml import etree as X

GROUP = re.compile(r"channel-group ([1-6]) mode (on|active|passive|desirable|auto)")
PROTOCOL = re.compile(r"channel-protocol (lacp|pagp)")
PORTCHANNEL = re.compile(r"Port-channel([1-6])", re.I)
BALANCE = re.compile(r"port-channel load-balance (src-mac|dst-mac|src-dst-mac)")
MODES = {"on", "active", "passive", "desirable", "auto"}
MODE_CODES = {"active": "1", "auto": "2", "desirable": "3", "on": "4", "passive": "5"}
PROTOCOL_CODES = {None: "0", "lacp": "1", "pagp": "2"}


def opaque_manager(engine):
    manager = engine.find("ETHERCHANNEL_MANAGER")
    if manager is None:
        return False
    if manager.attrib or (manager.text or "").strip() or len(manager) > 2:
        return True
    if len({n.tag for n in manager}) != len(manager):
        return True
    names = set()
    for node in manager:
        if node.attrib or (node.text or "").strip():
            return True
        if node.tag == "ETHERCHANNEL":
            if any(
                n.tag != "L2NAT" or len(n) or n.attrib or (n.text or "").strip()
                for n in node
            ):
                return True
        elif node.tag == "ETHERCHANNEL_ALL_PORT_DATA":
            if len(node) > 32:
                return True
            for row in node:
                if (
                    row.tag != "ETHERCHANNEL_PORT_DATA"
                    or row.attrib
                    or (row.text or "").strip()
                    or len(row) != 2
                    or {n.tag for n in row} != {"PORT_NAME", "ETHERCHANNEL_PORT_DATA"}
                ):
                    return True
                name, data = row.find("PORT_NAME"), row.find("ETHERCHANNEL_PORT_DATA")
                if (
                    len(name)
                    or name.attrib
                    or not name.text
                    or name.text in names
                    or len(name.text) > 80
                ):
                    return True
                names.add(name.text)
                if (
                    data.attrib
                    or (data.text or "").strip()
                    or len(data) != 3
                    or {n.tag for n in data}
                    != {"PORT_CHANNEL", "ETHER_CHANNEL_MODE", "ETHER_CHANNEL_PROTOCOL"}
                ):
                    return True
                if any(len(n) or n.attrib for n in data):
                    return True
                if (
                    data.findtext("PORT_CHANNEL") not in tuple(map(str, range(7)))
                    or data.findtext("ETHER_CHANNEL_MODE")
                    not in ("0", *MODE_CODES.values())
                    or data.findtext("ETHER_CHANNEL_PROTOCOL")
                    not in PROTOCOL_CODES.values()
                ):
                    return True
        else:
            return True
    return False


def sync_manager(engine, before, after, names):
    """Patch only represented membership rows; other source records are retained."""
    from documents import child

    manager = engine.find("ETHERCHANNEL_MANAGER")
    if manager is None:
        return
    old_ports = {p["id"]: p for p in before.get("ports", []) if not p.get("virtual")}
    changed = [
        p
        for p in after["ports"]
        if not p.get("virtual")
        and any(
            p.get(k) != old_ports.get(p["id"], {}).get(k)
            for k in ("channelGroup", "channelProtocol")
        )
    ]
    old_groups = [
        p["virtual"]["group"]
        for p in before.get("ports", [])
        if p.get("virtual", {}).get("kind") == "portchannel"
    ]
    groups = [
        p["virtual"]["group"]
        for p in after["ports"]
        if p.get("virtual", {}).get("kind") == "portchannel"
    ]
    if not changed and old_groups == groups:
        return
    if opaque_manager(engine):
        raise ValueError(
            "This chassis has additional EtherChannel state; edit channels in Packet Tracer."
        )
    block = manager.find("ETHERCHANNEL_ALL_PORT_DATA")
    if changed and block is None:
        block = X.SubElement(manager, "ETHERCHANNEL_ALL_PORT_DATA")
    for port in changed:
        name = names[port["id"]]
        row = next((n for n in block if n.findtext("PORT_NAME") == name), None)
        group, protocol = port.get("channelGroup"), port.get("channelProtocol")
        if not group and not protocol:
            if row is not None:
                block.remove(row)
            continue
        if row is None:
            row = X.SubElement(block, "ETHERCHANNEL_PORT_DATA")
            child(row, "PORT_NAME", name)
            X.SubElement(row, "ETHERCHANNEL_PORT_DATA")
        data = row.find("ETHERCHANNEL_PORT_DATA")
        child(data, "PORT_CHANNEL", group["id"] if group else 0)
        child(data, "ETHER_CHANNEL_MODE", MODE_CODES[group["mode"]] if group else "0")
        child(data, "ETHER_CHANNEL_PROTOCOL", PROTOCOL_CODES[protocol])
    if groups != old_groups:
        aggregates = manager.find("ETHERCHANNEL")
        if aggregates is None:
            aggregates = X.SubElement(manager, "ETHERCHANNEL")
        for item in list(aggregates):
            aggregates.remove(item)
        for _ in groups:
            X.SubElement(aggregates, "L2NAT")


def port_settings(config):
    result = {}
    for line in config:
        match = GROUP.fullmatch(line)
        if match:
            result["channelGroup"] = {"id": int(match[1]), "mode": match[2]}
        match = PROTOCOL.fullmatch(line)
        if match:
            result["channelProtocol"] = match[1]
    return result


def switch_settings(lines):
    matches = [BALANCE.fullmatch(line) for line in lines]
    return next(({"etherChannelLoadBalance": m[1]} for m in reversed(matches) if m), {})


def validate_device(device):
    groups = {}
    protocols = {}
    for p in device["ports"]:
        virtual = p.get("virtual", {})
        if virtual.get("kind") == "portchannel":
            group = virtual.get("group")
            if type(group) is not int or not 1 <= group <= 6 or group in groups:
                raise ValueError(
                    "Native port-channels need distinct groups 1 through 6."
                )
            groups[group] = 0
    for p in device["ports"]:
        group, protocol = p.get("channelGroup"), p.get("channelProtocol")
        if group is None and protocol is None:
            continue
        if (
            device["kind"] != "switch"
            or p.get("virtual")
            or p["media"] not in ("copper", "fiber")
        ):
            raise ValueError(
                "Native channel membership requires physical switch Ethernet ports."
            )
        if protocol is not None and protocol not in ("lacp", "pagp"):
            raise ValueError("Native channel protocol must be LACP or PAgP.")
        if group is None:
            continue
        if (
            not isinstance(group, dict)
            or group.keys() != {"id", "mode"}
            or type(group.get("id")) is not int
            or group["id"] not in groups
            or group.get("mode") not in MODES
        ):
            raise ValueError(
                "Native channel membership needs a represented port-channel and supported mode."
            )
        groups[group["id"]] += 1
        if groups[group["id"]] > 8:
            raise ValueError("Use at most eight native members in one EtherChannel.")
        expected = (
            "lacp"
            if group["mode"] in ("active", "passive")
            else "pagp" if group["mode"] in ("desirable", "auto") else "on"
        )
        if protocol and protocol != expected:
            raise ValueError(
                "The native channel protocol conflicts with its negotiation mode."
            )
        protocols.setdefault(group["id"], set()).add(expected)
        if len(protocols[group["id"]]) > 1:
            raise ValueError(
                "All local EtherChannel members must use the same protocol."
            )
        if p.get("security") or "voiceVlan" in p:
            raise ValueError(
                "Remove native port security and voice VLAN before adding channel membership."
            )
        if any(
            p.get(k)
            for k in (
                "ip",
                "ipv6",
                "helperAddresses",
                "inboundAcl",
                "outboundAcl",
                "natRole",
            )
        ):
            raise ValueError(
                "Configure routed addresses and services on the Port-channel, not its members."
            )
        if any(row.get("port") == p["id"] for row in device.get("staticMac", [])):
            raise ValueError(
                "Move static MAC entries to the Port-channel before adding membership."
            )


def channel_commands(engine, kind, before, after):
    changes = []
    for field, pattern, command in (
        ("channelGroup", GROUP, "channel-group"),
        ("channelProtocol", PROTOCOL, "channel-protocol"),
    ):
        if before.get(field) == after.get(field):
            continue
        if kind != "switch" or after.get("virtual"):
            raise ValueError(
                "Native channel membership requires a physical switchport."
            )
        if opaque_manager(engine):
            raise ValueError(
                "This native chassis has additional EtherChannel state; edit its channels in Packet Tracer."
            )
        value = after.get(field)
        if value is not None:
            command += (
                f" {value['id']} mode {value['mode']}"
                if field == "channelGroup"
                else f" {value}"
            )
        changes.append((pattern, command if value is not None else None))
    return changes


def update_switch(engine, before, after):
    from editing import set_lines

    old, new = before.get("etherChannelLoadBalance"), after.get(
        "etherChannelLoadBalance"
    )
    if old == new:
        return
    if opaque_manager(engine):
        raise ValueError(
            "This chassis has additional EtherChannel state; edit channels in Packet Tracer."
        )
    if new is not None and new not in ("src-mac", "dst-mac", "src-dst-mac"):
        raise ValueError("Unsupported native EtherChannel load-balancing policy.")
    multilayer = (engine.findtext("TYPE") or "").lower() == "multilayerswitch"
    if not multilayer and new not in (None, "src-mac"):
        raise ValueError(
            "Packet Tracer does not preserve this chassis's nondefault EtherChannel hash policy; use a multilayer switch or export CertSim JSON."
        )
    lines = [x.text or "" for x in engine.findall("RUNNINGCONFIG/LINE")]
    if any(
        s.startswith("port-channel load-balance ") and not BALANCE.fullmatch(s)
        for s in lines
    ):
        raise ValueError(
            "This native load-balancing policy is not supported for editing; use Packet Tracer."
        )
    lines = [s for s in lines if not BALANCE.fullmatch(s)]
    if new and (multilayer or new != "src-mac"):
        at = next(
            (
                i
                for i, s in enumerate(lines)
                if s.startswith("interface ") or s == "end"
            ),
            len(lines),
        )
        lines.insert(at, "port-channel load-balance " + new)
    set_lines(engine, "RUNNINGCONFIG", lines)
