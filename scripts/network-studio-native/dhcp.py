"""Bounded Server-PT DHCP projection; imported native service data stays intact."""

from copy import deepcopy
from ipaddress import IPv4Address, IPv4Network
from lxml import etree as X

DEFAULT_LEASE = 86400
NATIVE_DEFAULT_LEASE = "86400000"
DEFAULT_PAGE = {"path": "/", "body": "Welcome to your CertSim lab server."}
POOL_FIELDS = {"id", "name", "start", "prefix", "count", "gateway", "dns", "tftp", "leaseSeconds"}
POOL_TAGS = {
    "NAME", "NETWORK", "MASK", "DEFAULT_ROUTER", "TFTP_ADDRESS", "START_IP",
    "END_IP", "DNS_SERVER", "MAX_USERS", "DHCP_POOL_LEASES", "DOMAIN_NAME",
    "LEASE_TIME", "WLC_ADDRESS",
}
OPAQUE = "This native DHCP layout or option is not modeled; its source is preserved. Edit services in Packet Tracer."


def empty_services():
    return {
        "dhcp": {"enabled": False, "pools": [], "leases": []},
        "dns": {"enabled": False, "records": []},
        "http": {"enabled": False, "pages": []},
    }


def _text(node, name):
    return node.findtext(name) or ""


def _shape(node, tags, required=()):
    if node is None or node.attrib or any(c.tag not in tags for c in node):
        raise ValueError(OPAQUE)
    names = [c.tag for c in node]
    if len(names) != len(set(names)) or any(n not in names for n in required):
        raise ValueError(OPAQUE)


def _leaf(node, name):
    item = node.find(name)
    if item is not None and (item.attrib or len(item)):
        raise ValueError(OPAQUE)
    return _text(node, name)


def _ip(value, empty=False):
    if empty and value == "":
        return ""
    if not isinstance(value, str):
        raise ValueError("DHCP settings require IPv4 address strings.")
    ip = IPv4Address(value)
    first = int(ip) >> 24
    if not 1 <= first <= 223 or first == 127:
        raise ValueError("DHCP settings require unicast IPv4 addresses.")
    return str(ip)


def _name(value, maximum):
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or any(ord(c) < 32 for c in value):
        raise ValueError("DHCP identifiers and names must be bounded nonempty text.")
    return value


def _pool(value):
    if not isinstance(value, dict) or value.keys() - POOL_FIELDS:
        raise ValueError("Native DHCP requires the supported pool settings.")
    prefix, count = value.get("prefix"), value.get("count")
    if type(prefix) is not int or not 1 <= prefix <= 30 or type(count) is not int or not 1 <= count <= 256:
        raise ValueError("Native DHCP pools require prefix 1..30 and 1..256 addresses.")
    start = _ip(value.get("start"))
    network = IPv4Network((start, prefix), strict=False)
    last = int(IPv4Address(start)) + count - 1
    if int(IPv4Address(start)) <= int(network.network_address) or last >= int(network.broadcast_address):
        raise ValueError("DHCP pools must remain within usable hosts in one subnet.")
    gateway = _ip(value.get("gateway"), True)
    dns = _ip(value.get("dns"), True)
    tftp = _ip(value.get("tftp", ""), True)
    if gateway and IPv4Address(gateway) not in network:
        raise ValueError("DHCP gateway must be on the pool subnet.")
    lease = value.get("leaseSeconds", DEFAULT_LEASE)
    if type(lease) is not int or lease != DEFAULT_LEASE:
        raise ValueError("Native DHCP currently supports only the default 86400-second lease.")
    return {
        "id": _name(value.get("id"), 80),
        "name": _name(value.get("name"), 48),
        "start": start, "prefix": prefix, "count": count, "gateway": gateway,
        "dns": dns, **({"tftp": tftp} if tftp else {}),
    }


def _services(value):
    if value is None:
        return empty_services()
    if not isinstance(value, dict) or value.keys() != {"dhcp", "dns", "http"}:
        raise ValueError("Native services require DHCP, DNS and HTTP settings.")
    dhcp, dns, http = value["dhcp"], value["dns"], value["http"]
    if not isinstance(dns, dict) or dns != {"enabled": False, "records": []}:
        raise ValueError("Native DNS service changes are not supported; use CertSim JSON.")
    if not isinstance(http, dict) or http.keys() != {"enabled", "pages"} or http["enabled"] is not False or http["pages"] not in ([], [DEFAULT_PAGE]):
        raise ValueError("Native HTTP service changes are not supported; use CertSim JSON.")
    if not isinstance(dhcp, dict) or dhcp.keys() - {"enabled", "pools", "leases"} or type(dhcp.get("enabled")) is not bool:
        raise ValueError("Native DHCP requires a boolean enable setting and pool list.")
    pools = dhcp.get("pools")
    if not isinstance(pools, list) or len(pools) > 16:
        raise ValueError("Native DHCP supports at most 16 pools.")
    pools = [_pool(pool) for pool in pools]
    if len({p["id"] for p in pools}) != len(pools) or len({p["name"] for p in pools}) != len(pools):
        raise ValueError("Native DHCP pools need unique identifiers and names.")
    result = empty_services()
    result["dhcp"].update(enabled=dhcp["enabled"], pools=pools)
    return result


def _config(services):
    dhcp = _services(services)["dhcp"]
    return {"enabled": dhcp["enabled"], "pools": [{k: v for k, v in p.items() if k != "id"} for p in dhcp["pools"]]}


def _single_port(ports, native_names=None):
    physical = [p for p in ports if not p.get("virtual") and p.get("media") in ("copper", "fiber")]
    if len(physical) != 1 or len(ports) != 1:
        raise ValueError("Native DHCP currently requires a single-interface Server-PT.")
    port = physical[0]
    name = native_names.get(port["id"]) if native_names is not None else port.get("name")
    if not isinstance(name, str) or not name:
        raise ValueError("Native DHCP requires a mapped server interface.")
    return name


def _read(engine, ports):
    """Return projected DHCP and pool XML nodes; reject the complete opaque block."""
    if (engine.findtext("TYPE") or "").lower() != "server":
        raise ValueError(OPAQUE)
    interface = _single_port(ports)
    blocks = engine.findall("DHCP_SERVERS")
    if not blocks:
        return empty_services()["dhcp"], []
    if len(blocks) != 1:
        raise ValueError(OPAQUE)
    root = blocks[0]
    _shape(root, {"ASSOCIATED_PORTS"}, {"ASSOCIATED_PORTS"})
    bound = root.find("ASSOCIATED_PORTS")
    if bound.attrib or any(c.tag != "ASSOCIATED_PORT" for c in bound):
        raise ValueError(OPAQUE)
    if not len(bound):
        return empty_services()["dhcp"], []
    if len(bound) != 1:
        raise ValueError(OPAQUE)
    binding = bound[0]
    _shape(binding, {"NAME", "DHCP_SERVER"}, {"NAME", "DHCP_SERVER"})
    if _leaf(binding, "NAME") != interface:
        raise ValueError(OPAQUE)
    server = binding.find("DHCP_SERVER")
    _shape(server, {"ENABLED", "POOLS", "DHCP_RESERVATIONS", "AUTOCONFIG"}, {"ENABLED", "POOLS"})
    enabled = _leaf(server, "ENABLED")
    if enabled not in ("0", "1"):
        raise ValueError(OPAQUE)
    for tag in ("DHCP_RESERVATIONS", "AUTOCONFIG"):
        node = server.find(tag)
        if node is not None and (len(node) or node.attrib or (node.text or "").strip()):
            raise ValueError(OPAQUE)
    raw_pools = server.find("POOLS")
    if raw_pools.attrib or len(raw_pools) > 16 or any(c.tag != "POOL" for c in raw_pools):
        raise ValueError(OPAQUE)
    pools, nodes = [], []
    for i, raw in enumerate(raw_pools):
        _shape(raw, POOL_TAGS, {
            "NAME", "NETWORK", "MASK", "DEFAULT_ROUTER", "TFTP_ADDRESS",
            "START_IP", "END_IP", "DNS_SERVER", "MAX_USERS",
        })
        for tag in POOL_TAGS - {"DHCP_POOL_LEASES"}:
            _leaf(raw, tag)
        if _text(raw, "DOMAIN_NAME") or _text(raw, "WLC_ADDRESS") not in ("", "0.0.0.0") or _text(raw, "LEASE_TIME") not in ("", NATIVE_DEFAULT_LEASE):
            raise ValueError(OPAQUE)
        # Packet Tracer's untouched, disabled serverPool is not an address pool.
        placeholder = (
            enabled == "0" and len(raw_pools) == 1 and _text(raw, "NAME") == "serverPool"
            and all(_text(raw, k) == "0.0.0.0" for k in ("NETWORK", "MASK", "DEFAULT_ROUTER", "TFTP_ADDRESS", "START_IP", "DNS_SERVER"))
            and _text(raw, "END_IP") == "0.0.2.0" and _text(raw, "MAX_USERS") == "512"
            and not raw.findall("DHCP_POOL_LEASES/*")
        )
        if placeholder:
            continue
        subnet = IPv4Network((_text(raw, "NETWORK"), _text(raw, "MASK")), strict=True)
        if _text(raw, "MASK") != str(subnet.netmask):
            raise ValueError(OPAQUE)
        value = {
            "id": f"native-dhcp-{i}", "name": _text(raw, "NAME"), "start": _text(raw, "START_IP"),
            "prefix": subnet.prefixlen, "count": int(_text(raw, "MAX_USERS")),
            **{field: "" if _text(raw, tag) == "0.0.0.0" else _text(raw, tag) for field, tag in (("gateway", "DEFAULT_ROUTER"), ("dns", "DNS_SERVER"), ("tftp", "TFTP_ADDRESS"))},
        }
        pool = _pool(value)
        if IPv4Network((pool["start"], pool["prefix"]), strict=False) != subnet or _text(raw, "END_IP") != str(IPv4Address(int(IPv4Address(pool["start"])) + pool["count"] - 1)):
            raise ValueError(OPAQUE)
        pools.append(pool)
        nodes.append(raw)
    if len({p["name"] for p in pools}) != len(pools):
        raise ValueError(OPAQUE)
    return {"enabled": enabled == "1", "pools": pools, "leases": []}, nodes


def project(engine, ports):
    """Unsupported DNS/HTTP content is preserved, not represented as functional."""
    other_services = (
        _text(engine, "DNS_SERVER/ENABLED") not in ("", "0")
        or _text(engine, "HTTP_SERVER/ENABLED") not in ("", "0")
        or _text(engine, "HTTPS_SERVER/HTTPSENABLED") not in ("", "0")
        or bool(engine.findall("DNS_SERVER/NAMESERVER-DATABASE/*"))
    )
    try:
        dhcp, _ = _read(engine, ports)
    except (ValueError, TypeError, OverflowError):
        return None, True
    result = empty_services()
    result["dhcp"] = dhcp
    return result, other_services


def _set(node, name, value):
    child = node.find(name)
    if child is None:
        child = X.SubElement(node, name)
    child.text = str(value)


def _write_pool(pool, before=None):
    raw = deepcopy(before) if before is not None else X.Element("POOL")
    network = IPv4Network((pool["start"], pool["prefix"]), strict=False)
    fields = {
        "NAME": pool["name"], "NETWORK": str(network.network_address), "MASK": str(network.netmask),
        "DEFAULT_ROUTER": pool["gateway"] or "0.0.0.0", "TFTP_ADDRESS": pool.get("tftp") or "0.0.0.0",
        "START_IP": pool["start"], "END_IP": str(IPv4Address(int(IPv4Address(pool["start"])) + pool["count"] - 1)),
        "DNS_SERVER": pool["dns"] or "0.0.0.0", "MAX_USERS": pool["count"],
    }
    for tag, value in fields.items():
        _set(raw, tag, value)
    leases = raw.find("DHCP_POOL_LEASES")
    if leases is None:
        leases = X.SubElement(raw, "DHCP_POOL_LEASES")
    leases.clear()
    if before is None:
        _set(raw, "LEASE_TIME", NATIVE_DEFAULT_LEASE)
    return raw


def _replace(engine, interface, services, previous=None, old_nodes=()):
    before, nodes = previous or {"pools": []}, list(old_nodes)
    blocks = engine.findall("DHCP_SERVERS")
    existing = blocks[0] if len(blocks) == 1 else None
    new = deepcopy(existing) if previous is not None and existing is not None else X.Element("DHCP_SERVERS")
    bound = new.find("ASSOCIATED_PORTS")
    if bound is None:
        bound = X.SubElement(new, "ASSOCIATED_PORTS")
    if not len(bound):
        binding = X.SubElement(bound, "ASSOCIATED_PORT")
        _set(binding, "NAME", interface)
        server = X.SubElement(binding, "DHCP_SERVER")
        X.SubElement(server, "POOLS")
        X.SubElement(server, "DHCP_RESERVATIONS")
    else:
        server = bound[0].find("DHCP_SERVER")
    _set(server, "ENABLED", int(services["dhcp"]["enabled"]))
    pool_list = server.find("POOLS")
    for node in list(pool_list):
        pool_list.remove(node)
    old = {pool["id"]: (pool, node) for pool, node in zip(before["pools"], nodes)}
    for pool in services["dhcp"]["pools"]:
        pair = old.get(pool["id"])
        if pair and pool == pair[0]:
            pool_list.append(deepcopy(pair[1]))
        else:
            pool_list.append(_write_pool(pool, pair[1] if pair else None))
    position = list(engine).index(blocks[0]) if blocks else len(engine)
    for block in blocks:
        engine.remove(block)
    engine.insert(position, new)


def authored(engine, device, native_names):
    """Replace donor DHCP, and disable unconfigured DNS/HTTP only on fresh devices."""
    if device["kind"] != "server":
        if device.get("services") is not None:
            raise ValueError("Native DHCP service authoring requires Server-PT.")
        return
    services = _services(device.get("services"))
    interface = _single_port(device["ports"], native_names)
    _replace(engine, interface, services)
    for path in ("DNS_SERVER", "HTTP_SERVER"):
        node = engine.find(path)
        if node is not None:
            _set(node, "ENABLED", "0")
    https = engine.find("HTTPS_SERVER")
    if https is not None:
        _set(https, "HTTPSENABLED", "0")


def update(engine, before, after, native_names):
    old_value, new_value = before.get("services"), after.get("services")
    # Pure persistence/runtime changes must not touch imported native service data.
    if old_value == new_value:
        return
    if before["kind"] != "server":
        raise ValueError("Native DHCP service changes require Server-PT.")
    new_services = _services(new_value)
    try:
        previous, nodes = _read(engine, before["ports"])
    except (ValueError, TypeError, OverflowError):
        raise ValueError(OPAQUE) from None
    if _config(old_value) == _config(new_value):
        return
    interface = _single_port(after["ports"], native_names)
    _replace(engine, interface, new_services, previous, nodes)
