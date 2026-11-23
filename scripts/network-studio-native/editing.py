"""Apply representable edits to a native document without rebuilding unrelated XML."""

from html import escape
from ipaddress import IPv4Network
import re
from lxml import etree as X
from documents import child
from scenarios import update_scenarios
from inventory import insert_devices, remove_devices
from network import text, read_network, helper_address


def mask(bits):
    return str(IPv4Network("0.0.0.0/" + str(bits)).netmask)


def changes(old, new, allowed, subject):
    extra = [
        k for k in set(old) | set(new) if old.get(k) != new.get(k) and k not in allowed
    ]
    if extra:
        raise ValueError(
            f"Native save cannot represent {subject} changes to {', '.join(sorted(extra))}. Export CertSim JSON to keep these settings."
        )


def set_lines(engine, tag, lines):
    block = engine.find(tag)
    if block is None:
        block = X.SubElement(engine, tag)
    for el in block.findall("LINE"):
        block.remove(el)
    for line in lines:
        X.SubElement(block, "LINE").text = line


def set_interface(engine, name, entries):
    """Only replace changed commands in this interface's running stanza."""
    lines = [e.text or "" for e in engine.findall("RUNNINGCONFIG/LINE")]
    marker = "interface " + name
    if marker not in lines:
        start = lines.index("end") if "end" in lines else len(lines)
        if re.fullmatch(r"Port-channel[1-6]", name, re.I):
            start = next(
                (
                    i
                    for i, s in enumerate(lines)
                    if s.startswith("interface ")
                    and not re.fullmatch(r"interface Port-channel[1-6]", s, re.I)
                ),
                start,
            )
        lines[start:start] = [marker, "!"]
    start = lines.index(marker) + 1
    end = start
    while end < len(lines) and lines[end].startswith(" "):
        end += 1
    keep = [
        line
        for line in lines[start:end]
        if not any(match.fullmatch(line.strip()) for match, _ in entries)
    ]
    lines[start:end] = keep + [" " + cmd for _, cmd in entries if cmd]
    set_lines(engine, "RUNNINGCONFIG", lines)


def update_port(engine, kind, entry, before, after):
    name, _, raw, config = entry
    portchannel = after.get("virtual", {}).get("kind") == "portchannel"
    routed_before = kind == "switch" and bool(before.get("routed"))
    routed_after = kind == "switch" and bool(after.get("routed"))
    converting = routed_before != routed_after
    valid = {"enabled"}
    if kind != "switch" or routed_before or routed_after:
        valid.update(("ip", "prefix"))
    if kind == "router" or routed_before or routed_after:
        valid.add("helperAddresses")
    if kind in ("router", "switch"):
        valid.update(("bandwidth", "delay", "inboundAcl", "outboundAcl"))
    if kind in ("pc", "server"):
        valid.add("addressMode")
    if kind == "switch":
        valid.update(
            (
                "vlan",
                "mode",
                "nonegotiate",
                "nativeVlan",
                "allowedVlans",
                "routed",
                "portFast",
                "bpduGuard",
                "channelGroup",
                "channelProtocol",
            )
        )
        if not isinstance(after.get("routed", False), bool):
            raise ValueError("A physical routed interface flag must be boolean.")
        if routed_after and (
            (raw is None and not portchannel)
            or after["media"] not in ("copper", "fiber")
        ):
            raise ValueError(
                "Native routed switchports require physical Ethernet ports."
            )
        if (
            converting
            and routed_after
            and text(engine, "TYPE").lower() != "multilayerswitch"
        ):
            raise ValueError(
                "This native switch chassis does not support routed physical ports."
            )
        if (
            converting
            and not routed_after
            and (after.get("ip") or after.get("helperAddresses"))
        ):
            raise ValueError(
                "Clear the IPv4 address and helpers when restoring a switchport."
            )
    if after["media"] == "serial":
        valid.add("clockRate")
    changes(before, after, valid, "interface")
    from edgeprotection import port_commands
    from channels import channel_commands
    from dtp import port_commands as dtp_commands
    from eigrp import metric_commands

    commands = port_commands(
        kind, before, after, physical=raw is not None or portchannel
    )
    commands.extend(channel_commands(engine, kind, before, after))
    commands.extend(dtp_commands(kind, config, before, after, converting))
    commands.extend(metric_commands(kind, config, before, after))
    if converting:
        commands.append(
            (
                re.compile(r"(?:no )?switchport(?: .*)?"),
                "no switchport" if routed_after else None,
            )
        )
        if not routed_after:
            commands.append(
                (
                    re.compile(r"(?:no )?ip address(?: .*)?|ip helper-address(?: .*)?"),
                    None,
                )
            )
            if raw is not None:
                child(raw, "IP", "")
                child(raw, "SUBNET", "")
    if before.get("helperAddresses", []) != after.get("helperAddresses", []):
        old = before.get("helperAddresses", [])
        new = after.get("helperAddresses", [])
        if (
            not isinstance(new, list)
            or len(new) > 64
            or not all(helper_address(ip) for ip in new)
            or len(new) != len(set(new))
        ):
            raise ValueError(
                "Use distinct unicast IPv4 helper addresses on router interfaces."
            )
        # Keep native variants such as VRF-scoped commands outside the projection.
        known = re.compile(
            "ip helper-address (?:" + "|".join(re.escape(ip) for ip in old) + ")"
        )
        commands.extend((known, "ip helper-address " + ip) for ip in new)
        if not new:
            commands.append((known, None))
    if before.get("clockRate") != after.get("clockRate"):
        rate = after.get("clockRate", 0)
        child(raw, "CLOCKRATE", rate)
        commands.append(
            (
                re.compile(r"(no )?clock rate(?: \d+)?"),
                "clock rate " + str(rate) if rate else None,
            )
        )
    if before.get("enabled") != after["enabled"]:
        if raw is not None:
            child(raw, "POWER", str(after["enabled"]).lower())
        commands.append(
            (
                re.compile(r"(no )?shutdown"),
                "no shutdown" if after["enabled"] else "shutdown",
            )
        )
    if (kind != "switch" or routed_after) and (
        converting or any(before.get(k) != after[k] for k in ("ip", "prefix"))
    ):
        if raw is not None:
            child(raw, "IP", after["ip"])
            child(raw, "SUBNET", mask(after["prefix"]) if after["ip"] else "")
        commands.append(
            (
                re.compile(
                    r"(?:no ip address|ip address (?:\S+ \S+|dhcp(?: .*)?|negotiated))"
                ),
                (
                    "ip address " + after["ip"] + " " + mask(after["prefix"])
                    if after["ip"]
                    else "no ip address"
                ),
            )
        )
    if kind in ("pc", "server") and before.get("addressMode") != after.get(
        "addressMode"
    ):
        child(raw, "PORT_DHCP_ENABLE", str(after.get("addressMode") == "dhcp").lower())
    if kind == "switch" and not routed_after:
        for field, command in [
            ("vlan", "switchport access vlan"),
            ("nativeVlan", "switchport trunk native vlan"),
            ("allowedVlans", "switchport trunk allowed vlan"),
        ]:
            if before.get(field) == after.get(field) and not converting:
                continue
            value = after.get(field, [1] if field == "allowedVlans" else 1)
            if field == "allowedVlans":
                value = ",".join(map(str, value))
            commands.append(
                (re.compile(re.escape(command) + r" .*"), command + " " + str(value))
            )
    if commands and kind in ("router", "switch"):
        set_interface(engine, name, commands)


def located_leaf(root, node):
    path = text(node, "WORKSPACE/PHYSICAL")
    if not path:
        return None
    uuid = path.split(",")[-1].casefold()
    return next(
        (
            n
            for n in root.iterfind("PHYSICALWORKSPACE//NODE")
            if text(n, "UUID_STR").casefold() == uuid
        ),
        None,
    )


def update_device(root, node, inventory, old, new):
    changes(
        old,
        new,
        {
            "name", "x", "y", "powered", "ports", "gateway", "dns", "routes",
            "note", "routing", "accessLists", "services",
        }
        | (
            {
                "ipRouting",
                "vlans",
                "vtp",
                "spanningTree",
                "bpduGuardRecovery",
                "etherChannelLoadBalance",
            }
            if old["kind"] == "switch"
            else set()
        ),
        "device",
    )
    physical_before = [p for p in old["ports"] if not p.get("virtual")]
    physical_after = [p for p in new["ports"] if not p.get("virtual")]
    if [p["id"] for p in physical_before] != [p["id"] for p in physical_after]:
        raise ValueError("Native module inventory changes require Packet Tracer.")
    if len(new["ports"]) > 32 or len({p["id"] for p in new["ports"]}) != len(
        new["ports"]
    ):
        raise ValueError("Use at most 32 uniquely identified interfaces.")
    eng = node.find("ENGINE")
    from channels import validate_device, opaque_manager
    from eigrp import guard as guard_eigrp, update as update_eigrp
    from acls import guard as guard_acls, update as update_acls
    from server_services import update as update_services

    validate_device(new)
    guard_eigrp(eng, old, new)
    guard_acls(eng, old, new)
    if new["note"] != old["note"]:
        child(eng, "DESCRIPTION", escape(new["note"]))
    if new["name"] != old["name"]:
        child(eng, "NAME", new["name"])
        leaf = located_leaf(root, node)
        if leaf is not None:
            child(leaf, "NAME", new["name"])
    if new["powered"] != old["powered"]:
        child(eng, "POWER", str(new["powered"]).lower())
    for axis in ("x", "y"):
        if old[axis] != new[axis]:
            child(node.find("WORKSPACE/LOGICAL"), axis.upper(), new[axis])
    if old["gateway"] != new["gateway"]:
        child(eng, "GATEWAY", new["gateway"])
        if old["kind"] in ("pc", "server"):
            for _, _, raw, _ in inventory:
                child(raw, "PORT_GATEWAY", new["gateway"])
    if old.get("dns") != new.get("dns"):
        dns = eng.find("DNS_CLIENT")
        if dns is None:
            dns = X.SubElement(eng, "DNS_CLIENT")
        child(dns, "SERVER_IP", new.get("dns", ""))
        for _, _, raw, _ in inventory:
            child(raw, "PORT_DNS", new.get("dns", ""))
    if old["routes"] != new["routes"]:
        # Preserve unprojected forms (distance, tracked routes, interface-only).
        lines = [e.text or "" for e in eng.findall("RUNNINGCONFIG/LINE")]
        old_lines = {
            "ip route "
            + route["network"]
            + " "
            + mask(route["prefix"])
            + " "
            + route["nextHop"]
            for route in old["routes"]
        }
        lines = [s for s in lines if s.strip() not in old_lines]
        at = lines.index("end") if "end" in lines else len(lines)
        lines[at:at] = [
            "ip route " + r["network"] + " " + mask(r["prefix"]) + " " + r["nextHop"]
            for r in new["routes"]
        ]
        set_lines(eng, "RUNNINGCONFIG", lines)
    from virtuals import logical_name, remove_stanza, update_routing, write_logical

    native_names = {p["id"]: p["name"] for p in physical_before}
    if old["kind"] == "switch":
        update_routing(eng, old.get("ipRouting", False), new.get("ipRouting", False))
    old_ports = {p["id"]: p for p in old["ports"]}
    new_ports = {p["id"]: p for p in new["ports"]}
    entries = {p["id"]: entry for p, entry in zip(old["ports"], inventory)}
    logical_names = {}
    native_stanzas = {
        n.text[10:]
        for n in eng.findall("RUNNINGCONFIG/LINE")
        if n.text and n.text.startswith("interface ")
    }
    for after in new["ports"]:
        if not after.get("virtual"):
            continue
        name = logical_name(new, after, native_names)
        before = old_ports.get(after["id"])
        if name in logical_names.values() or (
            name in native_stanzas and (not before or name != before["name"])
        ):
            raise ValueError("This native virtual interface name already exists.")
        logical_names[after["id"]] = name
    for before in old["ports"]:
        if before.get("virtual") and before["id"] not in new_ports:
            if before["virtual"]["kind"] == "portchannel" and opaque_manager(eng):
                raise ValueError(
                    "This chassis has additional EtherChannel state; remove channels in Packet Tracer."
                )
            remove_stanza(eng, before["name"])
    for after in new["ports"]:
        before = old_ports.get(after["id"])
        if after.get("virtual"):
            if before and not before.get("virtual"):
                raise ValueError(
                    "A physical interface cannot become a virtual interface."
                )
            if before and before["name"] != logical_names[after["id"]]:
                marker = eng.find("RUNNINGCONFIG")
                for line in marker.findall("LINE"):
                    if line.text == "interface " + before["name"]:
                        line.text = "interface " + logical_names[after["id"]]
            write_logical(eng, new, after, native_names, before)
        else:
            update_port(eng, old["kind"], entries[after["id"]], before, after)
    update_eigrp(eng, old, new, {**native_names, **logical_names})
    update_acls(eng, old, new, {**native_names, **logical_names})
    if old["kind"] == "server":
        update_services(eng, old, new, native_names)
    elif old.get("services") != new.get("services"):
        raise ValueError("Native server service settings require a server.")
    if old["kind"] == "switch":
        from channels import update_switch as update_channels, sync_manager
        from edgeprotection import update_switch as update_edge
        from switching import update_switch

        update_switch(eng, old, new)
        update_edge(eng, old, new)
        update_channels(eng, old, new)
        sync_manager(eng, old, new, native_names)


def cable(parent, edge, endpoints, kinds, *, indexed=False):
    medium = edge["cable"]
    types = {"copper": "eCopper", "fiber": "eFiber", "serial": "eSerial"}
    result = X.SubElement(parent, "LINK")
    child(result, "TYPE", types[medium])
    cab = X.SubElement(result, "CABLE")
    child(cab, "LENGTH", edge.get("lengthMeters", 1))
    if not indexed:
        child(cab, "FUNCTIONAL", "true")
    for field, side in [("FROM", "a"), ("TO", "b")]:
        ep = edge[side]
        ref, port = endpoints[ep["device"], ep["port"]]
        child(cab, field, ref)
        X.SubElement(cab, "PORT").text = port
    for i, tag in enumerate(
        (
            "FROM_DEVICE_MEM_ADDR",
            "TO_DEVICE_MEM_ADDR",
            "FROM_PORT_MEM_ADDR",
            "TO_PORT_MEM_ADDR",
        ),
        1,
    ):
        child(cab, tag, i)
    if not indexed:
        child(cab, "GEO_VIEW_COLOR", "#6ba72e")
        child(cab, "IS_MANAGED_IN_RACK_VIEW", "false")
    if medium == "copper":
        a_switch = kinds[edge["a"]["device"]] == "switch"
        b_switch = kinds[edge["b"]["device"]] == "switch"
        child(cab, "TYPE", "eCrossOver" if a_switch == b_switch else "eStraightThrough")
    if medium == "serial":
        side = edge.get("dce", "a")
        ref, port = endpoints[edge[side]["device"], edge[side]["port"]]
        child(cab, "DCEDEV", ref)
        child(cab, "DCEPORT", port)
    return result


def patch(root, filename, edited):
    original, mapped, _ = read_network(root, filename)
    changes(
        original,
        edited,
        {"name", "devices", "links", "pdus", "scenarios", "activeScenario"},
        "workspace",
    )
    if original == edited:
        return False
    if original["name"] != edited["name"]:
        child(root.find("NETWORK"), "DESCRIPTION", escape(edited["name"]))
    new = {d["id"]: d for d in edited["devices"]}
    endpoints = {}
    refs = {d["id"]: ref for ref, (d, _, _) in mapped.items()}
    added = [d for d in edited["devices"] if d["id"] not in refs]
    deleted = []
    for ref, (d, node, inventory) in mapped.items():
        if d["id"] not in new:
            deleted.append(node)
            continue
        update_device(root, node, inventory, d, new[d["id"]])
        for p in d["ports"]:
            if not p.get("virtual"):
                endpoints[d["id"], p["id"]] = (ref, p["name"])
    indexed = any(
        n.findtext("ENGINE/SAVE_REF_ID") in (None, "")
        for n in root.findall("NETWORK/DEVICES/DEVICE")
    )
    if (
        indexed or (root.findtext("VERSION") or "").split(".")[0] in ("4", "5", "6")
    ) and (added or deleted):
        raise ValueError(
            "This older file uses numbered devices. Save a new copy in Packet Tracer before changing its device inventory."
        )
    insert_devices(root, added, deleted, endpoints, refs)
    old = {link["id"]: link for link in original["links"]}
    newlinks = {link["id"]: link for link in edited["links"]}
    parent = root.find("NETWORK/LINKS")
    natives = parent.findall("LINK") if parent is not None else []
    for id, edge in old.items():
        updated = newlinks.get(id)
        if updated and all(
            edge.get(k) == updated.get(k) for k in ("a", "b", "cable", "dce")
        ):
            if updated.get("lengthMeters") != edge.get("lengthMeters"):
                original_cable = natives[int(id.removeprefix("native-link-"))].find(
                    "CABLE"
                )
                child(original_cable, "LENGTH", updated.get("lengthMeters", 1))
            old[id] = updated
        elif edge != updated:
            parent.remove(natives[int(id.removeprefix("native-link-"))])
    kinds = {d["id"]: d["kind"] for d in edited["devices"]}
    virtual_endpoints = {
        (d["id"], p["id"])
        for d in edited["devices"]
        for p in d["ports"]
        if p.get("virtual")
    }
    for id, edge in newlinks.items():
        if old.get(id) == edge:
            continue
        if any(
            (edge[s]["device"], edge[s]["port"]) in virtual_endpoints
            for s in ("a", "b")
        ):
            raise ValueError(
                "Connect cables to the virtual interface's physical parent."
            )
        if parent is None:
            parent = X.SubElement(root.find("NETWORK"), "LINKS")
        # Preserve occupancy of physical ports used by native-only links.
        occupied = set()
        for native in parent.findall("LINK/CABLE"):
            occupied.update(
                zip(
                    (text(native, "FROM"), text(native, "TO")),
                    [p.text for p in native.findall("PORT")],
                )
            )
        if any(
            endpoints[edge[s]["device"], edge[s]["port"]] in occupied
            for s in ("a", "b")
        ):
            raise ValueError("A port is already occupied by a native cable.")
        cable(parent, edge, endpoints, kinds, indexed=indexed)
    update_scenarios(root, original, edited, refs)
    remove_devices(root, deleted)
    return True
