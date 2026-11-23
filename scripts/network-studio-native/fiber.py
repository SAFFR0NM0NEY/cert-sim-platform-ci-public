"""Conservative native router selection and metric preservation for fiber ports."""


def unused_router_fiber(topology, device, port):
    """Only the untouched, unreferenced generic spare may be omitted on a 2911."""
    if port.get("virtual") or port.get("media") != "fiber":
        return False
    endpoint = {"device": device["id"], "port": port["id"]}
    if any(link[side] == endpoint for link in topology["links"] for side in ("a", "b")):
        return False
    if any(p.get("virtual", {}).get("parent") == port["id"] for p in device["ports"]):
        return False
    if port["id"] in (device.get("routing") or {}).get("passivePorts", []):
        return False
    for pdu in topology.get("pdus", []):
        if any(pdu.get(key) == device["id"] and pdu.get(field) == port["id"]
               for key, field in (("source", "sourceInterface"), ("target", "port"))):
            return False
    defaults = {
        "enabled": True, "ip": "", "prefix": 24, "vlan": 1,
        "mode": "access", "allowedVlans": [1],
    }
    if any(port.get(key) != value for key, value in defaults.items()):
        return False
    return all(
        value in (None, "", [], {})
        for key, value in port.items()
        if key not in {*defaults, "id", "name", "media"}
    )


def needs_fiber_router(topology, device):
    return device["kind"] == "router" and any(
        port.get("media") == "fiber" and not port.get("virtual")
        and not unused_router_fiber(topology, device, port)
        for port in device["ports"]
    )


def metric_defaults(name, media):
    # Same generic baselines as interfaceMetric in the TypeScript routing model.
    if media == "serial":
        return {"bandwidth": 1544, "delay": 2000}
    name = name.casefold()
    if name.startswith("fastethernet"):
        return {"bandwidth": 100000, "delay": 10}
    if name.startswith("ethernet"):
        return {"bandwidth": 10000, "delay": 100}
    return {"bandwidth": 1000000, "delay": 1}


def mapped_metrics(port, native_name):
    """A genuine FastEthernet module keeps its type; only IOS metrics change."""
    original = metric_defaults(port["name"], port["media"])
    native = metric_defaults(native_name, port["media"])
    return {
        field: port.get(field, value)
        for field, value in original.items()
        if field in port or value != native[field]
    }


def router_pt_port_names(engine):
    """Recognize the inspected Router-PT slot layout; unknown layouts stay opaque."""
    marker = engine.find("TYPE")
    if marker is None or marker.get("model") != "Router-PT":
        return None
    roots = engine.findall("MODULE")
    if (marker.text or "").strip() != "Router" or len(roots) != 1:
        return {}
    root = roots[0]
    slots = root.findall("SLOT")
    if root.findtext("TYPE") != "eNonRemovableModule" or len(slots) != 10:
        return {}
    names = {}
    types = {
        "PT-ROUTER-NM-1CFE": ("eCopperFastEthernet", "FastEthernet"),
        "PT-ROUTER-NM-1FFE": ("eFiberFastEthernet", "FastEthernet"),
        "PT-ROUTER-NM-1S": ("eSerial", "Serial"),
    }
    for index, slot in enumerate(slots):
        modules = slot.findall("MODULE")
        if slot.findtext("TYPE") != "ePtRouterModule" or len(modules) > 1:
            return {}
        if not modules:
            continue
        module = modules[0]
        ports = module.findall("PORT")
        expected = types.get(module.findtext("MODEL"))
        if (module.findtext("TYPE") != "ePtRouterModule" or not expected
                or module.findall("SLOT") or len(ports) != 1
                or ports[0].findtext("TYPE") != expected[0]):
            return {}
        names[ports[0]] = expected[1] + str(index) + "/0"
    return names if len(names) == len(root.findall(".//PORT")) else {}
