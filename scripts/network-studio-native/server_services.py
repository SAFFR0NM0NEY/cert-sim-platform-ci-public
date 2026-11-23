"""Independent native server families with atomic, source-preserving edits."""

from copy import deepcopy

import dhcp
import dns_service
import http_service


def families(value):
    if value is None:
        return dhcp.empty_services()
    if not isinstance(value, dict) or value.keys() != {"dhcp", "dns", "http"}:
        raise ValueError("Native server services require DHCP, DNS and HTTP settings.")
    return value


def dhcp_device(device):
    # Keep the bounded DHCP mapper independent of DNS/HTTP configuration.
    services = dhcp.empty_services()
    services["dhcp"] = families(device.get("services"))["dhcp"]
    return {**device, "services": services}


def validate(value):
    value = families(value)
    neutral = dhcp.empty_services()
    neutral["dhcp"] = value["dhcp"]
    result = dhcp._services(neutral)
    result["dns"] = dns_service.validate(value["dns"])
    result["http"] = http_service.validate(value["http"])
    return result


def project(engine, ports):
    services = dhcp.empty_services()
    omitted = {}
    supported = False
    projected, _ = dhcp.project(engine, ports)
    if projected is None:
        omitted["DHCP server settings"] = 1
    else:
        services["dhcp"] = projected["dhcp"]
        supported = True
    for name, module in (("dns", dns_service), ("http", http_service)):
        value, hidden = module.project(engine)
        if value is not None:
            services[name] = value
            supported = True
        if hidden:
            omitted[name.upper() + " server settings"] = 1
    if (engine.findtext("HTTPS_SERVER/HTTPSENABLED") or "0") != "0":
        omitted["HTTPS server settings"] = 1
    return services if supported else None, omitted


def commit(engine, candidate):
    # Keep the ENGINE object identity while committing all service edits together.
    # Deepcopy retains unmodeled children, comments, attributes and text exactly.
    engine.clear()
    engine.attrib.update(candidate.attrib)
    engine.text, engine.tail = candidate.text, candidate.tail
    engine.extend(list(candidate))


def authored(engine, device, native_names):
    if device["kind"] != "server":
        if device.get("services") is not None:
            raise ValueError("Native server services require Server-PT.")
        return
    services = validate(device.get("services"))
    candidate = deepcopy(engine)
    dhcp.authored(candidate, dhcp_device({**device, "services": services}), native_names)
    dns_service.authored(candidate, services["dns"])
    http_service.authored(candidate, services["http"])
    commit(engine, candidate)


def update(engine, before, after, native_names):
    old, new = before.get("services"), after.get("services")
    if old == new:
        return
    if before["kind"] != "server":
        raise ValueError("Native server service changes require Server-PT.")
    services = validate(new)
    old = families(old)
    candidate = deepcopy(engine)
    dhcp.update(candidate, dhcp_device(before), dhcp_device(after), native_names)
    dns_service.update(candidate, old["dns"], services["dns"])
    http_service.update(candidate, old["http"], services["http"])
    commit(engine, candidate)
