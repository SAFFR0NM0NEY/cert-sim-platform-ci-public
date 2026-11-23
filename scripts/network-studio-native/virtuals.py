"""Native IOS subinterfaces, switch VLAN interfaces and IPv4 routing state."""

from copy import deepcopy
import re
from lxml import etree as X

from network import ios_sections, project_port, text
from channels import GROUP, PORTCHANNEL, opaque_manager

SUBINTERFACE = re.compile(r"(.+)\.([0-9]+)$")
SVI = re.compile(r"Vlan([0-9]+)$", re.I)
ENCAPSULATION = re.compile(r"encapsulation dot1[Qq] ([0-9]+)( native)?$")


def logical_ports(engine, kind, physical):
    if kind not in ("router", "switch"):
        return [], []
    _, sections = ios_sections(engine)
    parents = {p["name"]: p for p in physical}
    ports, inventory = [], []
    for name, config in sections.items():
        sub = SUBINTERFACE.fullmatch(name)
        svi = SVI.fullmatch(name)
        channel = PORTCHANNEL.fullmatch(name)
        if kind == "router" and sub and sub[1] in parents:
            parent = parents[sub[1]]
            if parent["media"] not in ("copper", "fiber"):
                continue
            virtual = {"kind": "subinterface", "parent": parent["id"]}
            encapsulations = [c for c in config if c.startswith("encapsulation ")]
            if encapsulations:
                match = ENCAPSULATION.fullmatch(encapsulations[0])
                if (
                    len(encapsulations) != 1
                    or not match
                    or not 1 <= int(match[1]) <= 4094
                ):
                    continue
                virtual["vlan"] = int(match[1])
                if match[2]:
                    virtual["native"] = True
            identifier, media = f"subinterface:{parent['id']}:{sub[2]}", parent["media"]
        elif kind == "switch" and svi and 1 <= int(svi[1]) <= 4094:
            virtual = {"kind": "svi", "vlan": int(svi[1])}
            identifier, media = f"svi:{svi[1]}", "copper"
        elif kind == "switch" and channel:
            virtual = {"kind": "portchannel", "group": int(channel[1])}
            identifier, media = f"port-channel:{channel[1]}", "copper"
            media = next(
                (
                    p["media"]
                    for p in physical
                    if any(
                        (match := GROUP.fullmatch(line)) and match[1] == channel[1]
                        for line in sections.get(p["name"], [])
                    )
                ),
                media,
            )
        else:
            continue
        port = project_port(
            0,
            (name, media, X.Element("PORT"), config),
            "switch" if channel else "router",
        )
        port.update(id=identifier, virtual=virtual)
        ports.append(port)
        inventory.append((name, media, None, config))
    return ports, inventory


def logical_name(device, port, native_names):
    virtual = port.get("virtual", {})
    if not isinstance(virtual, dict) or virtual.keys() - {
        "kind",
        "parent",
        "vlan",
        "native",
        "group",
    }:
        raise ValueError("Invalid virtual interface metadata.")
    tag = virtual.get("vlan")
    if virtual.get("kind") == "portchannel":
        group = virtual.get("group")
        if (
            device["kind"] == "switch"
            and virtual.keys() == {"kind", "group"}
            and type(group) is int
            and 1 <= group <= 6
            and port["media"] in ("copper", "fiber")
        ):
            return "Port-channel" + str(group)
        raise ValueError("Native port-channels require a switch and group 1 through 6.")
    if tag is not None and (type(tag) is not int or not 1 <= tag <= 4094):
        raise ValueError("A virtual interface needs a VLAN from 1 through 4094.")
    if (
        virtual.get("kind") == "svi"
        and device["kind"] == "switch"
        and tag is not None
        and port["media"] == "copper"
        and not virtual.keys() - {"kind", "vlan"}
    ):
        return "Vlan" + str(tag)
    if virtual.get("kind") == "subinterface" and device["kind"] == "router":
        parent = next(
            (p for p in device["ports"] if p["id"] == virtual.get("parent")), None
        )
        suffix = SUBINTERFACE.fullmatch(port["name"])
        if (
            parent
            and not parent.get("virtual")
            and parent["media"] in ("copper", "fiber")
            and parent["id"] in native_names
            and suffix
            and 0 <= int(suffix[2]) <= 4294967295
            and port["media"] == parent["media"]
            and isinstance(virtual.get("native", False), bool)
            and not (virtual.get("native") and tag is None)
        ):
            return native_names[parent["id"]] + "." + suffix[2]
    raise ValueError("This virtual interface has no supported native parent or VLAN.")


def remove_stanza(engine, name):
    from editing import set_lines

    lines = [e.text or "" for e in engine.findall("RUNNINGCONFIG/LINE")]
    marker = "interface " + name
    if marker in lines:
        start = lines.index(marker)
        end = start + 1
        while end < len(lines) and lines[end].startswith(" "):
            end += 1
        del lines[start:end]
        set_lines(engine, "RUNNINGCONFIG", lines)


def ensure_vlan(engine, vlan):
    database = engine.find("VLANS")
    if database is None:
        database = X.SubElement(engine, "VLANS")
    if not any(n.get("number") == str(vlan) for n in database.findall("VLAN")):
        X.SubElement(
            database, "VLAN", number=str(vlan), rspan="0", name=f"VLAN{vlan:04d}"
        )


def write_logical(engine, device, port, native_names, before=None):
    from editing import set_interface, update_port

    name = logical_name(device, port, native_names)
    previous = (
        deepcopy(before)
        if before
        else {
            **port,
            "enabled": None,
            "ip": None,
            "prefix": None,
            "helperAddresses": [],
        }
    )
    previous["name"] = name
    if before is None:
        previous.pop("bandwidth", None)
        previous.pop("delay", None)
    current = {**port, "name": name}
    # Metadata is represented by the stanza name and encapsulation command.
    previous["virtual"] = current["virtual"]
    virtual = port["virtual"]
    if virtual["kind"] == "portchannel" and before != port and opaque_manager(engine):
        raise ValueError(
            "This chassis has additional EtherChannel state; edit channels in Packet Tracer."
        )
    if virtual["kind"] == "portchannel" and before is None:
        previous.update(mode=None, vlan=None, nativeVlan=None, allowedVlans=None)
        if not port.get("routed"):
            previous.update(ip=port["ip"], prefix=port["prefix"])
            previous.pop("helperAddresses", None)
        for key in ("routed", "portFast", "bpduGuard", "nonegotiate"):
            previous.pop(key, None)
    old_virtual = (before or {}).get("virtual")
    if virtual["kind"] == "subinterface" and virtual != old_virtual:
        command = None
        if virtual.get("vlan") is not None:
            command = f"encapsulation dot1Q {virtual['vlan']}"
            if virtual.get("native"):
                command += " native"
        set_interface(engine, name, [(ENCAPSULATION, command)])
    update_port(
        engine,
        "switch" if virtual["kind"] == "portchannel" else "router",
        (name, port["media"], None, ios_sections(engine)[1].get(name, [])),
        previous,
        current,
    )
    if virtual["kind"] == "svi" and virtual != old_virtual and "vlans" not in device:
        ensure_vlan(engine, virtual["vlan"])
    return name


def update_routing(engine, before, after):
    if before == after:
        return
    if not isinstance(after, bool):
        raise ValueError("Switch IPv4 routing must be enabled or disabled.")
    if after and text(engine, "TYPE").lower() != "multilayerswitch":
        raise ValueError("This native switch chassis does not support IPv4 routing.")
    from editing import set_lines

    lines = [n.text or "" for n in engine.findall("RUNNINGCONFIG/LINE")]
    lines = [s for s in lines if s not in ("ip routing", "no ip routing")]
    at = lines.index("end") if "end" in lines else len(lines)
    lines.insert(at, "ip routing" if after else "no ip routing")
    set_lines(engine, "RUNNINGCONFIG", lines)
