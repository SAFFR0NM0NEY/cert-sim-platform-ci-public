"""Bounded Server-PT DNS configuration; unknown native records remain opaque."""

from copy import deepcopy
from ipaddress import IPv4Address, IPv6Address
import re

from lxml import etree as X


DEFAULT_TTL = 300
MAX_TTL = 2147483647
MAX_RECORDS = 128
RECORD_TYPES = {
    "A": ("A-REC", "IPADDRESS"),
    "AAAA": ("AAAA-REC", "IPV6ADDRESS"),
    "CNAME": ("CNAME", "HOSTNAME"),
}
NATIVE_TYPES = {native: (kind, field) for kind, (native, field) in RECORD_TYPES.items()}
OPAQUE = "This native DNS layout or record is not modeled; its source is preserved. Edit DNS in Packet Tracer."
HOST_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", re.ASCII)


def empty():
    return {"enabled": False, "records": []}


def _text(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 253 or any(ord(c) < 32 for c in value):
        raise ValueError("DNS names and values require bounded nonempty text.")
    return value


def _host(value):
    value = _text(value).lower()
    if value.endswith("."):
        value = value[:-1]
    if not all(HOST_LABEL.fullmatch(label) for label in value.split(".")):
        raise ValueError("DNS names require valid hostname labels.")
    return value


def _address(value, kind):
    value = _text(value)
    if kind == "A":
        address = IPv4Address(value)
        first = int(address) >> 24
        if int(address) == 0 or first >= 224 or first == 127:
            raise ValueError("DNS A records require usable IPv4 addresses.")
    else:
        if any(c.isspace() or c in "%[]" for c in value):
            raise ValueError("DNS AAAA records require unscoped IPv6 addresses.")
        address = IPv6Address(value)
        number = int(address)
        if number <= 1 or number >> 120 == 255 or number >> 32 == 65535:
            raise ValueError("DNS AAAA records require usable IPv6 addresses.")
    return str(address)


def validate(value):
    """Normalize the same bounded DNS configuration accepted by CertSim."""
    if value is None:
        return empty()
    if not isinstance(value, dict) or value.keys() != {"enabled", "records"} or type(value["enabled"]) is not bool:
        raise ValueError("Native DNS requires an enable flag and record list.")
    records = value["records"]
    if not isinstance(records, list) or len(records) > MAX_RECORDS:
        raise ValueError("Native DNS supports at most 128 records.")
    normalized, identities, names = [], set(), {}
    for record in records:
        if not isinstance(record, dict) or record.keys() - {"name", "type", "value", "ttl"}:
            raise ValueError("Native DNS requires supported record fields.")
        kind = record.get("type")
        if not isinstance(kind, str) or kind not in RECORD_TYPES:
            raise ValueError("Native DNS supports A, AAAA and CNAME records.")
        name = _host(record.get("name"))
        target = _host(record.get("value")) if kind == "CNAME" else _address(record.get("value"), kind)
        item = {"name": name, "type": kind, "value": target}
        if "ttl" in record:
            ttl = record["ttl"]
            if type(ttl) is not int or not 0 <= ttl <= MAX_TTL:
                raise ValueError("DNS TTL must be an integer from 0 to 2147483647 seconds.")
            item["ttl"] = ttl
        identity = (name, kind, target)
        if identity in identities:
            raise ValueError("Duplicate DNS records are not allowed.")
        if name in names and (kind == "CNAME" or "CNAME" in names[name]):
            raise ValueError("A CNAME must be the only record for its hostname.")
        identities.add(identity)
        names.setdefault(name, set()).add(kind)
        normalized.append(item)
    return {"enabled": value["enabled"], "records": normalized}


def _effective(record):
    return {**record, "ttl": record.get("ttl", DEFAULT_TTL)}


def _config(value):
    value = validate(value)
    return {"enabled": value["enabled"], "records": [_effective(record) for record in value["records"]]}


def _layout(node, tags, repeated=False):
    if node is None or node.attrib or (node.text or "").strip():
        raise ValueError(OPAQUE)
    names = [child.tag for child in node]
    if any(name not in tags for name in names) or any((child.tail or "").strip() for child in node):
        raise ValueError(OPAQUE)
    if not repeated and (set(names) != set(tags) or len(names) != len(tags)):
        raise ValueError(OPAQUE)


def _leaf(node, tag):
    child = node.find(tag)
    if child is None or child.attrib or len(child):
        raise ValueError(OPAQUE)
    return child.text or ""


def _read(engine):
    if (engine.findtext("TYPE") or "").lower() != "server":
        raise ValueError(OPAQUE)
    blocks = engine.findall("DNS_SERVER")
    if not blocks:
        return empty(), []
    if len(blocks) != 1:
        raise ValueError(OPAQUE)
    block = blocks[0]
    _layout(block, {"ENABLED", "NAMESERVER-DATABASE"})
    enabled = _leaf(block, "ENABLED")
    if enabled not in ("0", "1"):
        raise ValueError(OPAQUE)
    database = block.find("NAMESERVER-DATABASE")
    if len(database) > MAX_RECORDS:
        raise ValueError(OPAQUE)
    _layout(database, {"RESOURCE-RECORD"}, repeated=True)
    records, nodes = [], []
    for raw in database:
        kind = _leaf(raw, "TYPE")
        if kind not in NATIVE_TYPES:
            raise ValueError(OPAQUE)
        record_type, field = NATIVE_TYPES[kind]
        _layout(raw, {"TYPE", "NAME", "TTL", field})
        ttl = _leaf(raw, "TTL")
        if len(ttl) > 10 or not re.fullmatch(r"[0-9]+", ttl):
            raise ValueError(OPAQUE)
        records.append({"type": record_type, "name": _leaf(raw, "NAME"), "value": _leaf(raw, field), "ttl": int(ttl)})
        nodes.append(raw)
    return validate({"enabled": enabled == "1", "records": records}), nodes


def project(engine):
    """Project the entire configured database, or preserve it as one opaque block."""
    try:
        value, _ = _read(engine)
        return value, False
    except (ValueError, TypeError, OverflowError):
        return None, True


def _key(record):
    return (record["name"], record["type"], record["value"], record.get("ttl", DEFAULT_TTL))


def _write(engine, value, previous=None, nodes=()):
    blocks = engine.findall("DNS_SERVER")
    existing = blocks[0] if len(blocks) == 1 else None
    block = deepcopy(existing) if previous is not None and existing is not None else X.Element("DNS_SERVER")
    enabled = block.find("ENABLED")
    if enabled is None:
        enabled = X.SubElement(block, "ENABLED")
    enabled.text = "1" if value["enabled"] else "0"
    database = block.find("NAMESERVER-DATABASE")
    if database is None:
        database = X.SubElement(block, "NAMESERVER-DATABASE")
    for raw in list(database):
        database.remove(raw)
    old = {_key(record): raw for record, raw in zip(previous["records"], nodes)} if previous is not None else {}
    for record in value["records"]:
        source = old.get(_key(record))
        if source is not None:
            database.append(deepcopy(source))
            continue
        raw = X.SubElement(database, "RESOURCE-RECORD")
        kind, field = RECORD_TYPES[record["type"]]
        for tag, text in (("TYPE", kind), ("NAME", record["name"]), ("TTL", record.get("ttl", DEFAULT_TTL)), (field, record["value"])):
            X.SubElement(raw, tag).text = str(text)
    position = list(engine).index(blocks[0]) if blocks else len(engine)
    for old_block in blocks:
        engine.remove(old_block)
    engine.insert(position, block)


def authored(engine, value):
    """Replace only a fresh template's DNS service, including its donor defaults."""
    value = validate(value)
    if (engine.findtext("TYPE") or "").lower() != "server":
        raise ValueError("Native DNS authoring requires Server-PT.")
    _write(engine, value)


def update(engine, before, after):
    """Apply supported DNS edits without touching unrelated services or no-op XML."""
    if before == after:
        return
    value = validate(after)
    try:
        previous, nodes = _read(engine)
    except (ValueError, TypeError, OverflowError):
        raise ValueError(OPAQUE) from None
    if _config(before) == _config(value) or _config(previous) == _config(value):
        return
    _write(engine, value, previous, nodes)
