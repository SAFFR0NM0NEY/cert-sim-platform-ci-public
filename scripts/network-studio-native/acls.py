"""Conservative IOS IPv4 ACL projection and edits; unmodeled policies stay opaque."""

from ipaddress import IPv4Address, IPv4Network
import re

BINDINGS = {"inboundAcl": "in", "outboundAcl": "out"}
NAME = re.compile(r"[A-Za-z0-9_-]{1,32}")
RULE_FIELDS = {"action", "protocol", "source", "sourcePrefix", "destination", "destinationPrefix", "destinationPort"}
PORT_ALIASES = {"ftp-data": 20, "ftp": 21, "ssh": 22, "telnet": 23, "smtp": 25, "domain": 53, "bootps": 67, "bootpc": 68, "tftp": 69, "www": 80, "http": 80, "pop3": 110, "ntp": 123, "https": 443}
OPAQUE = "Unsupported native ACL settings must be edited in Packet Tracer; their source is preserved."


def number_kind(name):
    if not name.isdecimal():
        return None
    value = int(name)
    if str(value) != name:
        raise ValueError("Use canonical native ACL numbers.")
    if 1 <= value <= 99 or 1300 <= value <= 1999:
        return "standard"
    if 100 <= value <= 199 or 2000 <= value <= 2699:
        return "extended"
    raise ValueError("Use supported IPv4 standard or extended ACL numbers.")


def address(words, at):
    if at >= len(words):
        raise ValueError("Missing ACL address.")
    if words[at] == "any":
        return "0.0.0.0", 0, at + 1
    if words[at] == "host":
        return str(IPv4Address(words[at + 1])), 32, at + 2
    ip = IPv4Address(words[at])
    wildcard = int(IPv4Address(words[at + 1]))
    # Low contiguous ones only. Dotted IPv4Network masks can otherwise interpret
    # a leading-zero inverted mask as another hostmask rather than rejecting it.
    if wildcard & (wildcard + 1):
        raise ValueError("Noncontiguous ACL wildcards are not supported.")
    net = IPv4Network((str(ip), 32 - wildcard.bit_count()), strict=False)
    return str(net.network_address), net.prefixlen, at + 2


def parse_rule(line, kind):
    words = line.split()
    if words and words[0].isdecimal():
        words = words[1:]  # Named-list sequence numbers do not change saved order.
    if words[:1] == ["remark"]:
        return None
    if not words or words[0] not in ("permit", "deny"):
        raise ValueError("Unsupported ACL action.")
    action = words[0]
    if kind == "standard":
        # IOS standard ACLs can use a bare host address.
        if len(words) == 2 and words[1] != "any":
            source, bits, at = str(IPv4Address(words[1])), 32, 2
        else:
            source, bits, at = address(words, 1)
        result = dict(action=action, protocol="ip", source=source, sourcePrefix=bits, destination="0.0.0.0", destinationPrefix=0)
    else:
        if len(words) < 4 or words[1] not in ("ip", "icmp", "tcp", "udp"):
            raise ValueError("Unsupported ACL protocol.")
        source, bits, at = address(words, 2)
        destination, destination_bits, at = address(words, at)
        result = dict(action=action, protocol=words[1], source=source, sourcePrefix=bits, destination=destination, destinationPrefix=destination_bits)
        if at < len(words) and words[at] == "eq" and words[1] in ("tcp", "udp"):
            value = words[at + 1]
            port = PORT_ALIASES.get(value)
            if port is None:
                port = int(value)
            if not 1 <= port <= 65535:
                raise ValueError("Invalid ACL destination port.")
            result["destinationPort"] = port
            at += 2
    if at != len(words):
        raise ValueError("Unsupported ACL rule variant.")
    return result


def definitions(engine):
    from network import ios_sections

    lines, interfaces = ios_sections(engine)
    found = {}
    unknown = False
    for index, line in enumerate(lines):
        if line.startswith("ip access-list "):
            words = line.split()
            name = words[3] if len(words) > 3 else ""
            end = index + 1
            while end < len(lines) and lines[end].startswith(" "):
                end += 1
            item = dict(name=name, kind=words[2] if len(words) > 2 else "", indices=list(range(index, end)), body=lines[index + 1:end], named=True, bad=len(words) != 4)
            if name in found:
                found[name]["bad"] = True
                found[name]["indices"].extend(item["indices"])
            else:
                found[name] = item
        elif line.startswith("access-list "):
            words = line.split()
            name = words[1] if len(words) > 1 else ""
            try:
                kind = number_kind(name)
            except ValueError:
                kind = None
            item = found.setdefault(name, dict(name=name, kind=kind, indices=[], body=[], named=False, bad=kind is None))
            item["indices"].append(index)
            item["body"].append(" ".join(words[2:]))
            if item["named"]:
                item["bad"] = True
        elif re.match(r"(?:no )?(?:ip access-list|access-list)(?: |$)", line):
            unknown = True
    for name, item in found.items():
        if not NAME.fullmatch(name) or item["kind"] not in ("standard", "extended"):
            item["bad"] = True
        try:
            numeric = number_kind(name)
            if numeric and numeric != item["kind"]:
                item["bad"] = True
            rules = [r for line in item["body"] if (r := parse_rule(line, item["kind"])) is not None]
            if not rules or len(rules) > 128:
                item["bad"] = True
            item["rules"] = rules
        except (ValueError, IndexError):
            item["bad"] = True
    # Router/IOS templates inspected for this phase store ACLs in config only.
    # A distinct serialized ACL table is not a supported alternative authority.
    if any(len(node) or (node.text or "").strip() for node in engine.findall("ACL_PROCESS/ACLS")):
        unknown = True
    return lines, interfaces, found, unknown


def routed(engine, port):
    kind = (engine.findtext("TYPE") or "").lower()
    return kind == "router" or bool(port.get("routed")) or port.get("virtual", {}).get("kind") == "svi"


def project(engine, ports):
    _, interfaces, found, unknown = definitions(engine)
    supported = [dict(name=name, rules=item["rules"]) for name, item in found.items() if not item["bad"] and not unknown]
    hidden = sum(item["bad"] for item in found.values()) + int(unknown)
    if len(supported) > 16:
        hidden += len(supported) - 16
        supported = supported[:16]
    known = {item["name"] for item in supported}
    by_name = {p["name"]: p for p in ports}
    bindings = {}
    for name, config in interfaces.items():
        raw = [line for line in config if re.match(r"(?:no )?ip access-group(?: |$)", line)]
        for field, direction in BINDINGS.items():
            selected = [line for line in raw if line.split()[-1:] == [direction]]
            if not selected:
                continue
            match = re.fullmatch(r"ip access-group ([A-Za-z0-9_-]{1,32}) " + direction, selected[0])
            port = by_name.get(name)
            if len(selected) == 1 and match and match[1] in known and port and routed(engine, port):
                bindings.setdefault(port["id"], {})[field] = match[1]
            else:
                hidden += 1
        hidden += sum(line.split()[-1:] not in (["in"], ["out"]) for line in raw)
    return supported or None, bindings, hidden


def state(device):
    return (
        device.get("accessLists") or [],
        {p["id"]: {k: p.get(k) or "" for k in BINDINGS} for p in device.get("ports", []) if any(p.get(k) for k in BINDINGS)},
    )


def guard(engine, before, after):
    validate(after, {p["id"]: p["name"] for p in after.get("ports", [])})
    _, interfaces, found, unknown = definitions(engine)
    changed = state(before) != state(after)
    _, _, hidden = project(engine, before.get("ports", []))
    # Missing bindings and truncated/opaque policies are deliberately conservative.
    if changed and (unknown or any(item["bad"] for item in found.values()) or hidden):
        raise ValueError(OPAQUE)
    previous = {p["id"]: p for p in before.get("ports", [])}
    current = {p["id"]: p for p in after.get("ports", [])}
    for identifier, port in previous.items():
        if identifier not in current and any("ip access-group" in s for s in interfaces.get(port["name"], [])):
            if any(item["bad"] for item in found.values()) or hidden:
                raise ValueError(OPAQUE)
    old_lists = {a["name"]: a for a in before.get("accessLists", [])}
    new_lists = {a["name"]: a for a in after.get("accessLists", [])}
    affected = {name for name in old_lists if old_lists[name] != new_lists.get(name)}
    if not affected:
        return
    mapped = {p["name"]: p for p in before.get("ports", [])}
    for iface, config in interfaces.items():
        if iface not in mapped or not routed(engine, mapped[iface]):
            if any(re.fullmatch(r"ip access-group " + re.escape(name) + r" (?:in|out)", s) for name in affected for s in config):
                raise ValueError("A native-only interface still references this ACL; its source is preserved.")
    # NAT, VTY and route-map consumers are not part of interface ACL projection.
    lines = [line.text or "" for line in engine.findall("RUNNINGCONFIG/LINE")]
    for name in affected:
        patterns = (
            r"(?:ip nat .+\blist|access-class|ip access-class) " + re.escape(name) + r"(?: |$)",
            r"match ip address(?: .*)?\b" + re.escape(name) + r"(?: |$)",
            r"(?:distribute-list|ip inspect .+ access-group) " + re.escape(name) + r"(?: |$)",
        )
        if any(re.search(pattern, line.strip()) for pattern in patterns for line in lines):
            raise ValueError("Another native feature still references this ACL; its source is preserved.")


def validate(after, native_names):
    lists = after.get("accessLists", [])
    if not isinstance(lists, list) or len(lists) > 16:
        raise ValueError("Use at most 16 native IPv4 access lists.")
    if (lists or any(p.get(k) for p in after.get("ports", []) for k in BINDINGS)) and after.get("kind") not in ("router", "switch"):
        raise ValueError("Native interface ACLs require a router or switch.")
    seen = set()
    for acl in lists:
        if not isinstance(acl, dict) or acl.keys() != {"name", "rules"} or not isinstance(acl["name"], str) or not NAME.fullmatch(acl["name"]) or acl["name"] in seen:
            raise ValueError("Native ACLs require unique names using letters, numbers, underscores or hyphens.")
        kind = number_kind(acl["name"])
        seen.add(acl["name"])
        rules = acl["rules"]
        if not isinstance(rules, list) or len(rules) > 128:
            raise ValueError("Use at most 128 rules per native ACL.")
        if not rules:
            raise ValueError("An empty native ACL has different forwarding semantics; add an explicit permit or deny rule.")
        for rule in rules:
            if not isinstance(rule, dict) or rule.keys() - RULE_FIELDS or not (RULE_FIELDS - {"destinationPort"}).issubset(rule):
                raise ValueError("Use supported native ACL rule fields.")
            if rule["action"] not in ("permit", "deny") or rule["protocol"] not in ("ip", "icmp", "tcp", "udp"):
                raise ValueError("Use supported native ACL actions and protocols.")
            for key in ("source", "destination"):
                bits = rule[key + "Prefix"]
                try:
                    if type(bits) is not int or not 0 <= bits <= 32 or not isinstance(rule[key], str):
                        raise ValueError()
                    IPv4Network((rule[key], bits), strict=True)
                except (ValueError, TypeError):
                    raise ValueError("Native ACLs require canonical IPv4 network addresses.") from None
            value = rule.get("destinationPort")
            if "destinationPort" in rule and (type(value) is not int or not 1 <= value <= 65535 or rule["protocol"] not in ("tcp", "udp")):
                raise ValueError("Native destination ports require TCP/UDP and an integer from 1 through 65535.")
            if kind == "standard" and not standard_rule(rule):
                raise ValueError("A standard ACL number supports source-only IP rules; use an extended number or name.")
    for port in after.get("ports", []):
        for field in BINDINGS:
            name = port.get(field)
            if field not in port or name == "":
                continue
            if not isinstance(name, str) or name not in seen or port["id"] not in native_names:
                raise ValueError("Native interface bindings must reference an existing ACL and mapped interface.")
            if after["kind"] != "router" and not (port.get("routed") or port.get("virtual", {}).get("kind") == "svi"):
                raise ValueError("Native IPv4 ACL bindings require routed interfaces.")
    return lists


def standard_rule(rule):
    return rule["protocol"] == "ip" and rule["destination"] == "0.0.0.0" and rule["destinationPrefix"] == 0 and "destinationPort" not in rule


def format_address(value, bits):
    if bits == 0:
        return "any"
    if bits == 32:
        return "host " + value
    return value + " " + str(IPv4Network((value, bits)).hostmask)


def format_rule(rule, kind):
    source = format_address(rule["source"], rule["sourcePrefix"])
    if kind == "standard":
        if not standard_rule(rule):
            raise ValueError("An imported standard ACL supports source-only IP rules; create an extended list for this policy.")
        return rule["action"] + " " + source
    dest = format_address(rule["destination"], rule["destinationPrefix"])
    return f'{rule["action"]} {rule["protocol"]} {source} {dest}' + (f' eq {rule["destinationPort"]}' if "destinationPort" in rule else "")


def update(engine, before, after, native_names):
    from editing import set_interface, set_lines

    lists = validate(after, native_names)
    before_ports = {p["id"]: p for p in before.get("ports", [])}
    moved = any(
        any(p.get(k) for k in BINDINGS)
        and before_ports.get(p["id"], {}).get("name") != native_names.get(p["id"])
        for p in after.get("ports", [])
    )
    if state(before) == state(after) and not moved:
        return
    guard(engine, before, after)
    lines, _, found, _ = definitions(engine)
    old = {item["name"]: item for item in before.get("accessLists") or []}
    new = {item["name"]: item for item in lists}
    changed = {name for name in old.keys() | new.keys() if old.get(name) != new.get(name)}
    remove = {i for name in changed if name in found for i in found[name]["indices"]}
    replacements = []
    for name in new:
        if name not in changed:
            continue
        original = found.get(name)
        kind = original["kind"] if original else number_kind(name) or "extended"
        # Keep inert remarks when editing a list, without pretending they are rules.
        remarks = [s.strip() for s in original["body"] if re.fullmatch(r"(?:[0-9]+ )?remark(?: .*)?", s.strip())] if original else []
        rules = [format_rule(rule, kind) for rule in new[name]["rules"]]
        named = original["named"] if original else not name.isdecimal()
        if named:
            replacements.extend([f"ip access-list {kind} {name}", *[" " + s for s in remarks + rules], "!"])
        else:
            replacements.extend(f"access-list {name} {s}" for s in remarks + rules)
    if changed:
        remaining = [line for i, line in enumerate(lines) if i not in remove]
        at = remaining.index("end") if "end" in remaining else len(remaining)
        remaining[at:at] = replacements
        set_lines(engine, "RUNNINGCONFIG", remaining)
    for port in after.get("ports", []):
        previous = before_ports.get(port["id"], {})
        entries = []
        for field, direction in BINDINGS.items():
            name = port.get(field) or ""
            if (previous.get(field) or "") != name or (name and previous.get("name") != native_names.get(port["id"])):
                entries.append((re.compile(r"ip access-group \S+ " + direction), f"ip access-group {name} {direction}" if name else None))
        if entries:
            set_interface(engine, native_names[port["id"]], entries)
