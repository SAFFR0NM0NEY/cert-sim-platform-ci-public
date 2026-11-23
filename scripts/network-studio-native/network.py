"""Project the supported native Ethernet and serial interfaces into Network Studio."""

from collections import Counter, defaultdict
from ipaddress import IPv4Address, IPv4Network
import math
import re
from documents import plain_text
from scenarios import scenarios_from

MODELS = {"pc": "PC-PT", "server": "Server-PT", "switch": "2960-24TT", "router": "2911"}
KINDS = {
    "pc": "pc",
    "laptop": "pc",
    "server": "server",
    "router": "router",
    "switch": "switch",
    "multilayerswitch": "switch",
}
IFACE = re.compile(
    r"^(FastEthernet|GigabitEthernet|TenGigabitEthernet|Ethernet|Serial)(\d+(?:/\d+)*)$",
    re.I,
)
MAX_PORTS = 32


def text(node, path, default=""):
    return (node.findtext(path) or default).strip()


def address(value):
    try:
        ip = IPv4Address(value)
        return str(ip) if int(ip) else ""
    except ValueError:
        return ""


def helper_address(value):
    ip = address(value) if isinstance(value, str) else ""
    if not ip:
        return ""
    first = int(ip.split(".")[0])
    return ip if first < 224 and first != 127 else ""


def prefix(mask):
    try:
        return IPv4Network("0.0.0.0/" + mask).prefixlen or 24
    except ValueError:
        return 24


def coord(node, axis, low, high):
    try:
        value = float(text(node, "WORKSPACE/LOGICAL/" + axis))
        return max(low, min(high, round(value))) if math.isfinite(value) else low
    except (ValueError, OverflowError):
        return low


def ios_sections(engine):
    lines = [line.text or "" for line in engine.findall("RUNNINGCONFIG/LINE")]
    sections = {}
    current = None
    for line in lines:
        if line.startswith("interface "):
            current = sections.setdefault(line[10:].strip(), [])
        elif line.startswith(" ") and current is not None:
            current.append(line.strip())
        else:
            current = None
    return lines, sections


def native_ports(engine, kind):
    from fiber import router_pt_port_names

    _, sections = ios_sections(engine)
    physical_names = router_pt_port_names(engine) if kind == "router" else None
    if physical_names == {}:
        return []  # Unknown modular layouts must not be assigned invented endpoints.
    names = defaultdict(list)
    for name in sections:
        match = IFACE.fullmatch(name)
        if match:
            names[match[1].lower()].append(name)
    counts = Counter()
    result = []
    for raw in engine.findall(".//MODULE/PORT"):
        medium = text(raw, "TYPE").lower()
        if "serial" in medium:
            family, media = "Serial", "serial"
        elif "ethernet" in medium:
            family = next(
                (
                    f
                    for f in ("TenGigabitEthernet", "GigabitEthernet", "FastEthernet")
                    if f.lower() in medium
                ),
                "Ethernet",
            )
            media = "fiber" if "fiber" in medium else "copper"
        else:
            continue
        index = counts[family]
        counts[family] += 1
        candidates = names[family.lower()]
        if physical_names is not None:
            name = physical_names[raw]
        elif index < len(candidates):
            name = candidates[index]
        elif kind in ("pc", "server"):
            name = family + str(index)
        else:
            name = family + "0/" + str(index + (1 if kind == "switch" else 0))
        result.append((name, media, raw, sections.get(name, [])))
    return result


def vlan(value, default=1):
    return int(value) if value.isdigit() and 1 <= int(value) <= 4094 else default


def vlans(value):
    result = set()
    for item in value.split(","):
        ends = item.split("-")
        if len(ends) > 2 or not all(i.isdigit() for i in ends):
            return []
        a, b = int(ends[0]), int(ends[-1])
        if not 1 <= a <= b <= 4094 or b - a >= 128:
            return []
        result.update(range(a, b + 1))
        if len(result) > 128:
            return []
    return sorted(result)


def project_port(index, entry, kind):
    from eigrp import metric_settings

    name, media, raw, config = entry
    routed = (
        kind == "switch" and "no switchport" in config and media in ("copper", "fiber")
    )
    ip = address(text(raw, "IP"))
    bits = prefix(text(raw, "SUBNET"))
    p = dict(
        id="p" + str(index),
        name=name,
        media=media,
        enabled=text(raw, "POWER", "true") == "true",
        ip=ip if kind != "switch" or routed else "",
        prefix=bits,
        vlan=1,
        mode="access",
        allowedVlans=[1],
    )
    if kind in ("router", "switch"):
        p.update(metric_settings(config))
    if media == "serial":
        value = text(raw, "CLOCKRATE")
        if value.isdecimal() and 1 <= int(value) <= 4_000_000:
            p["clockRate"] = int(value)
    if kind in ("pc", "server"):
        p["addressMode"] = (
            "dhcp" if text(raw, "PORT_DHCP_ENABLE") == "true" else "static"
        )
    if kind == "switch":
        if routed:
            p["routed"] = True
        else:
            from edgeprotection import port_settings
            from dtp import port_settings as dtp_settings

            p["nativeVlan"] = 1
            p.update(port_settings(config))
            p.update(dtp_settings(config))
    for line in config:
        words = line.split()
        if line in ("shutdown", "no shutdown"):
            p["enabled"] = line == "no shutdown"
        elif (
            words[:2] == ["ip", "address"]
            and len(words) == 4
            and (kind == "router" or routed)
        ):
            p["ip"], p["prefix"] = address(words[2]), prefix(words[3])
        elif (
            (kind == "router" or routed)
            and words[:2] == ["ip", "helper-address"]
            and len(words) == 3
        ):
            server_ip = helper_address(words[2])
            if server_ip and server_ip not in p.get("helperAddresses", []):
                p.setdefault("helperAddresses", []).append(server_ip)
        elif (
            line.startswith("switchport access vlan ")
            and kind == "switch"
            and not routed
        ):
            p["vlan"] = vlan(words[-1])
        elif (
            line.startswith("switchport trunk native vlan ")
            and kind == "switch"
            and not routed
        ):
            p["nativeVlan"] = vlan(words[-1])
        elif (
            line.startswith("switchport trunk allowed vlan ")
            and kind == "switch"
            and not routed
        ):
            p["allowedVlans"] = vlans(words[-1]) or [1]
    return p


def read_network(root, filename):
    devices, links, mapped, omitted = [], [], {}, Counter()
    elements = root.findall("NETWORK/DEVICES/DEVICE")
    if len(elements) > 2000:
        raise ValueError("This native lab exceeds the desktop import device limit.")
    domain_vlans = {1}
    for i, node in enumerate(elements):
        engine = node.find("ENGINE")
        if engine is None:
            omitted["devices"] += 1
            continue
        kind = KINDS.get(text(engine, "TYPE").lower())
        inventory = native_ports(engine, kind) if kind else []
        reference = text(engine, "SAVE_REF_ID") or str(i)
        if not inventory or not reference or len(devices) >= 128 or reference in mapped:
            omitted["devices"] += 1
            continue
        if len(inventory) > MAX_PORTS:
            omitted["interfaces"] += len(inventory) - MAX_PORTS
        inventory = inventory[:MAX_PORTS]
        ports = [project_port(n, p, kind) for n, p in enumerate(inventory)]
        from virtuals import logical_ports

        logical, logical_inventory = logical_ports(engine, kind, ports)
        available = MAX_PORTS - len(ports)
        omitted["interfaces"] += max(0, len(logical) - available)
        ports.extend(logical[:available])
        inventory.extend(logical_inventory[:available])
        if kind == "switch":
            from channels import port_settings as channel_settings
            from dtp import opaque_mode

            unknown_modes = sum(opaque_mode(entry[3]) for entry in inventory)
            if unknown_modes:
                omitted["switchport modes"] += unknown_modes

            groups = {
                p["virtual"]["group"]
                for p in ports
                if p.get("virtual", {}).get("kind") == "portchannel"
            }
            for p, entry in zip(ports, inventory):
                if p.get("virtual"):
                    continue
                settings = channel_settings(entry[3])
                if settings.get("channelGroup", {}).get("id") not in groups:
                    settings.pop("channelGroup", None)
                p.update(settings)
        device = dict(
            id="native-" + str(i),
            name=text(engine, "NAME", kind)[:48],
            kind=kind,
            x=coord(node, "X", 40, 1080),
            y=coord(node, "Y", 50, 650),
            powered=text(engine, "POWER", "true") == "true",
            gateway=address(text(engine, "GATEWAY")),
            routes=[],
            note=" ".join(plain_text(text(engine, "DESCRIPTION")).split())[:300],
            ports=ports,
        )
        if kind in ("pc", "server"):
            device["dns"] = address(text(engine, "DNS_CLIENT/SERVER_IP"))
        lines, _ = ios_sections(engine)
        if kind in ("router", "switch"):
            from eigrp import project as project_eigrp

            routing, unsupported = project_eigrp(engine, ports)
            if routing is not None:
                device["routing"] = routing
            if unsupported:
                omitted["routing processes"] += 1
            from acls import project as project_acls

            access_lists, bindings, unsupported = project_acls(engine, ports)
            if access_lists is not None:
                device["accessLists"] = access_lists
            for port in ports:
                port.update(bindings.get(port["id"], {}))
            if unsupported:
                omitted["IPv4 ACL settings"] += unsupported
        if kind == "server":
            from server_services import project as project_services

            services, unsupported = project_services(engine, ports)
            if services is not None:
                device["services"] = services
            if unsupported:
                omitted.update(unsupported)
        if kind == "switch":
            from channels import switch_settings as channel_settings
            from edgeprotection import switch_settings
            from switching import project_switch

            device["ipRouting"] = "ip routing" in lines
            device.update(channel_settings(lines))
            device.update(project_switch(engine))
            stp = switch_settings(lines)
            if stp is not None:
                device["spanningTree"] = stp
            domain_vlans.update(v["id"] for v in device.get("vlans", []))
        for line in lines:
            words = line.split()
            if (
                kind in ("router", "switch")
                and len(words) == 5
                and words[:2] == ["ip", "route"]
                and address(words[4])
            ):
                try:
                    net = IPv4Network((words[2], words[3]))
                except ValueError:
                    continue
                device["routes"].append(
                    dict(
                        network=str(net.network_address),
                        prefix=net.prefixlen,
                        nextHop=words[4],
                    )
                )
        for p in ports:
            domain_vlans.update([p["vlan"], *p["allowedVlans"], p.get("nativeVlan", 1)])
            if p.get("virtual", {}).get("vlan"):
                domain_vlans.add(p["virtual"]["vlan"])
        devices.append(device)
        mapped[reference] = (device, node, inventory)
    # Model the VLANs present in this lab for an unrestricted native trunk.
    for d, _, inv in mapped.values():
        for p, entry in zip(d["ports"], inv):
            if p["mode"] in ("trunk", "dynamic-auto", "dynamic-desirable") and not any(
                s.startswith("switchport trunk allowed vlan ") for s in entry[3]
            ):
                p["allowedVlans"] = sorted(domain_vlans)[:128]
    occupied = set()
    for i, link in enumerate(root.findall("NETWORK/LINKS/LINK")):
        cab = link.find("CABLE")
        if cab is None:
            omitted["cables"] += 1
            continue
        fmt = {"eCopper": "copper", "eFiber": "fiber", "eSerial": "serial"}.get(
            text(link, "TYPE")
        )
        names = [p.text for p in cab.findall("PORT")]
        refs = [text(cab, "FROM"), text(cab, "TO")]
        ends = []
        for ref, name in zip(refs, names):
            if ref in mapped:
                d = mapped[ref][0]
                p = next(
                    (
                        p
                        for p in d["ports"]
                        if not p.get("virtual")
                        and p["name"] == name
                        and p["media"] == fmt
                    ),
                    None,
                )
                if p:
                    ends.append((d["id"], p["id"]))
        if (
            len(ends) != 2
            or ends[0][0] == ends[1][0]
            or occupied.intersection(ends)
            or len(links) >= 256
        ):
            omitted["cables"] += 1
            continue
        a, b = (dict(device=d, port=p) for d, p in ends)
        edge = dict(id="native-link-" + str(i), a=a, b=b, cable=fmt)
        try:
            length = float(text(cab, "LENGTH"))
            if math.isfinite(length) and 0 <= length <= 1_000_000:
                edge["lengthMeters"] = length
        except ValueError:
            pass
        if fmt == "serial":
            edge["dce"] = "b" if text(cab, "DCEDEV") == refs[1] else "a"
        links.append(edge)
        occupied.update(ends)
    description = plain_text(text(root, "NETWORK/DESCRIPTION"))
    name = (" ".join(description.split()) or filename or "Imported network")[:80]
    scenario_data, hidden = scenarios_from(root, mapped)
    if hidden:
        omitted["simulation items"] = hidden
    return (
        dict(version=1, name=name, devices=devices, links=links, **scenario_data),
        mapped,
        dict(omitted),
    )
