"""Bounded classic IPv4 EIGRP IOS projection; preserve unmodeled routing state."""

from ipaddress import IPv4Address, IPv4Network
import re

METRICS = {"bandwidth": 2147483647, "delay": 16777215}
ROUTING_FIELDS = {"protocol", "processId", "routerId", "networks", "passivePorts"}
PASS_THROUGH = {
    "metric weights 0 1 0 1 0 0",
    "eigrp log-neighbor-changes",
    "no eigrp log-neighbor-changes",
}


def metric_settings(config):
    result = {}
    for field, maximum in METRICS.items():
        lines = [
            line for line in config if re.match(rf"(?:no )?{field}(?: |$)", line)
        ]
        if len(lines) == 1:
            match = re.fullmatch(field + r" ([0-9]+)", lines[0])
            if match and 1 <= int(match[1]) <= maximum:
                result[field] = int(match[1])
    return result


def metric_commands(kind, config, before, after):
    result = []
    known = metric_settings(config)
    for field, maximum in METRICS.items():
        if before.get(field) == after.get(field):
            continue
        value = after.get(field)
        if kind not in ("router", "switch") or (
            value is not None and (type(value) is not int or not 1 <= value <= maximum)
        ):
            raise ValueError(
                f"Native {field} requires a supported integer on a router or switch interface."
            )
        pattern = re.compile(rf"(?:no )?{field}(?: .*)?")
        existing = [line for line in config if pattern.fullmatch(line)]
        if existing and field not in known and existing != ["no " + field]:
            raise ValueError(f"This native {field} variant must be edited in Packet Tracer.")
        result.append((pattern, f"{field} {value}" if value is not None else None))
    return result


def sections(lines):
    result = []
    for start, line in enumerate(lines):
        if not (line.startswith("router ") or line.startswith("ipv6 router eigrp ")):
            continue
        end = start + 1
        while end < len(lines) and lines[end].startswith(" "):
            end += 1
        result.append((start, end, line, [s.strip() for s in lines[start + 1:end]]))
    return result


def network_statement(words):
    if len(words) == 2:
        first = int(IPv4Address(words[1])) >> 24
        if first == 0 or first >= 224:
            raise ValueError("Unsupported classful network.")
        bits = 8 if first < 128 else 16 if first < 192 else 24
        return IPv4Network(f"{words[1]}/{bits}", strict=False)
    if len(words) == 3:
        wildcard = int(IPv4Address(words[2]))
        # Invert explicitly: ipaddress treats 0.0.0.0 as a netmask, not a wildcard.
        return IPv4Network(
            (words[1], str(IPv4Address(0xFFFFFFFF ^ wildcard))), strict=False
        )
    raise ValueError("Unsupported EIGRP network statement.")


def opaque_interfaces(interfaces):
    for commands in interfaces.values():
        if any(re.search(r"\beigrp\b", line, re.I) for line in commands):
            return True
        metrics = metric_settings(commands)
        for field in METRICS:
            explicit = [
                s for s in commands if re.match(rf"(?:no )?{field}(?: |$)", s)
            ]
            if explicit and field not in metrics and explicit != ["no " + field]:
                return True
    return False


def project(engine, ports):
    from network import ios_sections

    lines, interfaces = ios_sections(engine)
    processes = sections(lines)
    if not processes:
        return None, False
    if len(processes) != 1:
        return None, True
    _, _, marker, config = processes[0]
    match = re.fullmatch(r"router eigrp ([0-9]+)", marker)
    if not match or not 1 <= int(match[1]) <= 65535 or "no auto-summary" not in config:
        return None, True
    # Authentication, summaries, timers and other interface-specific EIGRP
    # controls are outside this projection, even with a simple process stanza.
    if opaque_interfaces(interfaces):
        return None, True
    by_name = {p["name"].casefold(): p["id"] for p in ports}
    routing = dict(
        protocol="eigrp", processId=int(match[1]), routerId="", networks=[], passivePorts=[]
    )
    seen_networks = set()
    try:
        for line in config:
            words = line.split()
            if line == "no auto-summary" or line in PASS_THROUGH:
                continue
            if words[:1] == ["network"]:
                net = network_statement(words)
                if str(net) not in seen_networks:
                    routing["networks"].append(
                        dict(network=str(net.network_address), prefix=net.prefixlen, area=0)
                    )
                    seen_networks.add(str(net))
            elif (
                words[:2] == ["eigrp", "router-id"]
                and len(words) == 3
                and not routing["routerId"]
            ):
                value = IPv4Address(words[2])
                if not int(value):
                    return None, True
                routing["routerId"] = str(value)
            elif (
                words[:1] == ["passive-interface"]
                and len(words) == 2
                and words[1].casefold() in by_name
            ):
                identifier = by_name[words[1].casefold()]
                if identifier not in routing["passivePorts"]:
                    routing["passivePorts"].append(identifier)
            else:
                return None, True
    except ValueError:
        return None, True
    if len(routing["networks"]) > 32:
        return None, True
    return routing, False


def validate(routing, kind, native_names):
    if routing is None:
        return None
    if not isinstance(routing, dict) or routing.keys() - ROUTING_FIELDS:
        raise ValueError("Native EIGRP requires the supported classic routing settings.")
    if kind not in ("router", "switch"):
        raise ValueError("Native EIGRP requires a router or multilayer switch.")
    if routing.get("protocol") == "none":
        return None
    if routing.get("protocol") != "eigrp":
        raise ValueError("Native dynamic routing authoring currently supports classic IPv4 EIGRP only.")
    asn = routing.get("processId")
    if type(asn) is not int or not 1 <= asn <= 65535:
        raise ValueError("Native EIGRP requires an autonomous system from 1 through 65535.")
    lines = [f"router eigrp {asn}", " no auto-summary"]
    router_id = routing.get("routerId", "")
    if not isinstance(router_id, str):
        raise ValueError("Native EIGRP requires an IPv4 router ID or an empty string.")
    if router_id:
        try:
            if not isinstance(router_id, str) or not int(IPv4Address(router_id)):
                raise ValueError()
        except ValueError:
            raise ValueError("Native EIGRP requires a valid nonzero IPv4 router ID.") from None
        lines.append(" eigrp router-id " + router_id)
    networks = routing.get("networks", [])
    passive = routing.get("passivePorts", [])
    if not isinstance(networks, list) or len(networks) > 32:
        raise ValueError("Native EIGRP supports at most 32 network statements.")
    for net in networks:
        if (
            not isinstance(net, dict)
            or net.keys() != {"network", "prefix", "area"}
            or type(net["prefix"]) is not int
            or not 0 <= net["prefix"] <= 32
            or type(net["area"]) is not int
            or net["area"] != 0
        ):
            raise ValueError("Native EIGRP requires IPv4 network statements without OSPF areas.")
        try:
            network = IPv4Network((net["network"], net["prefix"]), strict=True)
        except (ValueError, TypeError):
            raise ValueError("Native EIGRP requires canonical IPv4 network addresses.") from None
        lines.append(f" network {network.network_address} {network.hostmask}")
    if (
        not isinstance(passive, list)
        or len(passive) > 32
        or any(not isinstance(p, str) or p not in native_names for p in passive)
        or len(set(passive)) != len(passive)
    ):
        raise ValueError("Native EIGRP passive interfaces must refer to distinct mapped interfaces.")
    lines.extend(" passive-interface " + native_names[p] for p in passive)
    return lines


def guard(engine, before, after):
    """Unsupported process data survives unrelated edits, never gets overwritten."""
    from network import ios_sections

    _, opaque = project(engine, before["ports"])
    routing = after.get("routing")
    if (
        isinstance(routing, dict)
        and routing.get("protocol") == "eigrp"
        and opaque_interfaces(ios_sections(engine)[1])
    ):
        opaque = True
    if not opaque:
        return
    prior = {p["id"]: p for p in before["ports"]}
    metric_change = any(
        any(prior.get(p["id"], {}).get(k) != p.get(k) for k in METRICS)
        for p in after["ports"]
    )
    if before.get("routing") != after.get("routing") or metric_change:
        raise ValueError("Unsupported native routing settings must be edited in Packet Tracer; their source is preserved.")


def update(engine, before, after, native_names):
    from editing import set_lines
    from network import text

    old, new = before.get("routing"), after.get("routing")
    replacement = validate(new, after["kind"], native_names)
    old_names = {p["id"]: p["name"] for p in before.get("ports", [])}
    remapped = any(
        old_names.get(p) != native_names.get(p)
        for p in (new or {}).get("passivePorts", [])
    )
    if old == new and not remapped:
        return
    # The caller guards the original process before any interface renaming.
    if (
        replacement
        and after["kind"] == "switch"
        and text(engine, "TYPE").lower() != "multilayerswitch"
    ):
        raise ValueError("This native switch chassis does not support EIGRP.")
    lines = [line.text or "" for line in engine.findall("RUNNINGCONFIG/LINE")]
    retained = [
        " " + command
        for _, _, _, config in sections(lines)
        for command in config
        if command in PASS_THROUGH
    ]
    for start, end, _, _ in reversed(sections(lines)):
        del lines[start:end]
    if replacement:
        at = lines.index("end") if "end" in lines else len(lines)
        lines[at:at] = replacement + retained + ["!"]
    set_lines(engine, "RUNNINGCONFIG", lines)
