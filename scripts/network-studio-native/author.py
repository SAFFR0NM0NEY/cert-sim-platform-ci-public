"""Build new native wired labs using the installed format library's chassis builder."""

from copy import deepcopy
from html import escape
from xml.etree import ElementTree as ET
from ipaddress import IPv4Interface
from lxml import etree as X
from pkt_core import Lab
from documents import ACTIVITY, child
from editing import mask, update_port
from network import MODELS, native_ports
from scenarios import DEFAULT, write_scenarios
from fiber import mapped_metrics, needs_fiber_router, unused_router_fiber

DEVICE_FIELDS = {
    "id",
    "kind",
    "name",
    "x",
    "y",
    "powered",
    "gateway",
    "dns",
    "routes",
    "routing",
    "note",
    "ports",
    "ipRouting",
    "vlans",
    "vtp",
    "spanningTree",
    "bpduGuardRecovery",
    "etherChannelLoadBalance",
    "accessLists",
    "services",
}
PORT_FIELDS = {
    "id",
    "name",
    "media",
    "enabled",
    "ip",
    "prefix",
    "vlan",
    "mode",
    "nonegotiate",
    "allowedVlans",
    "nativeVlan",
    "addressMode",
    "clockRate",
    "helperAddresses",
    "virtual",
    "routed",
    "portFast",
    "bpduGuard",
    "channelGroup",
    "channelProtocol",
    "bandwidth",
    "delay",
    "inboundAcl",
    "outboundAcl",
}


def require_supported(data, allowed, subject):
    unknown = sorted(
        k for k in data.keys() - allowed if data[k] not in (None, "", [], {})
    )
    if unknown:
        raise ValueError(
            f"Native authoring cannot yet write {subject} fields: {', '.join(unknown)}. Export CertSim JSON for this workspace."
        )


def network(t):
    require_supported(
        t,
        {
            "version",
            "name",
            "devices",
            "links",
            "activity",
            "pdus",
            "scenarios",
            "activeScenario",
        },
        "workspace",
    )
    if len(t["devices"]) > 128 or len(t["links"]) > 256:
        raise ValueError("Too many native devices or links.")
    lab = Lab()
    lab.prune_seed_devices()
    for tag in ("COMMAND_LOGS", "CEPS", "EXT_PORT_MGR", "CODE_TESTING"):
        section = lab.base.find(tag)
        if section is not None:
            section.clear()
    profile = lab.base.find("USER_PROFILE")
    if profile is not None:
        for field in profile:
            field.text = "Guest" if field.tag == "NAME" else ""
    scripts = lab.base.find("SCRIPT_MODULE/SCRIPTS")
    if scripts is not None:
        scripts.clear()
    names = set()
    refs = {}
    generated = {}
    for i, d in enumerate(t["devices"]):
        from channels import validate_device

        validate_device(d)
        require_supported(d, DEVICE_FIELDS, "device")
        if d.get("routing") is not None and not isinstance(d["routing"], dict):
            raise ValueError("Native routing settings must be an object.")
        kind = d["kind"]
        if kind not in MODELS:
            raise ValueError(f"Native chassis generation is not available for {kind}.")
        if kind != "switch" and d.get("ipRouting") is not None:
            raise ValueError("The IPv4 routing toggle applies to native switches.")
        name = d["name"]
        if (
            not isinstance(name, str)
            or not name.strip()
            or len(name) > 48
            or name in names
        ):
            raise ValueError(
                "Native devices need unique display names up to 48 characters."
            )
        names.add(name)
        # The builder interpolates names in an XML template. Pass our own safe
        # token, then assign the user's name through an XML API on both leaves.
        model = (
            "3560-24PS"
            if kind == "switch"
            and (
                d.get("ipRouting")
                or (d.get("routing") or {}).get("protocol") == "eigrp"
                or any(p.get("routed") for p in d["ports"])
                or d.get("etherChannelLoadBalance") in ("dst-mac", "src-dst-mac")
            )
            else "Router-PT" if needs_fiber_router(t, d)
            else MODELS[kind]
        )
        ref = lab.add_device(
            model, f"CertSimDevice{i}", d["x"], d["y"], power=d["powered"]
        )
        refs[d["id"]] = ref
        generated[ref] = d
    root = X.fromstring(ET.tostring(lab.base, encoding="utf-8"))
    child(root.find("NETWORK"), "DESCRIPTION", escape(t["name"]))
    from editing import located_leaf, cable, set_lines

    endpoints = {}
    for node in root.findall("NETWORK/DEVICES/DEVICE"):
        eng = node.find("ENGINE")
        ref = eng.findtext("SAVE_REF_ID")
        d = generated[ref]
        kind = d["kind"]
        inv = native_ports(eng, kind)
        for tag in (
            "CUSTOM_VARS",
            "CUSTOM_INTERFACE",
            "STARTUPCONFIG",
            "TRAFFICGEN_USER_TRAFFIC",
        ):
            section = eng.find(tag)
            if section is not None:
                section.clear()
        child(eng, "NAME", d["name"])
        child(eng, "DESCRIPTION", escape(d.get("note", "")))
        leaf = located_leaf(root, node)
        if leaf is not None:
            child(leaf, "NAME", d["name"])
        if kind in ("router", "switch"):
            safe_hostname = "".join(
                c if c.isascii() and (c.isalnum() or c == "-") else "-"
                for c in d["name"]
            )
            child(eng, "SYS_NAME", safe_hostname)
            set_lines(
                eng,
                "RUNNINGCONFIG",
                ["version 15.1", "hostname " + safe_hostname, "end"],
            )
        else:
            child(eng, "GATEWAY", d.get("gateway", ""))
            dns = eng.find("DNS_CLIENT")
            if dns is not None:
                child(dns, "SERVER_IP", d.get("dns", ""))
        free = list(inv)
        native_names = {}
        logical_count = sum(bool(p.get("virtual")) for p in d["ports"])
        if len(d["ports"]) > 32 or len(inv) + logical_count > 32:
            raise ValueError("Use at most 32 native interfaces per device.")
        for port in [p for p in d["ports"] if not p.get("virtual")]:
            require_supported(port, PORT_FIELDS, "port")
            if kind != "switch" and port.get("routed") is not None:
                raise ValueError(
                    "The routed physical port flag applies to native switches."
                )
            if (
                kind != "router"
                and not (kind == "switch" and port.get("routed"))
                and port.get("helperAddresses")
            ):
                raise ValueError("DHCP helper addresses require a router interface.")
            chosen = next(
                (
                    entry
                    for entry in free
                    if entry[0] == port["name"] and entry[1] == port["media"]
                ),
                None,
            )
            if chosen is None:
                chosen = next(
                    (entry for entry in free if entry[1] == port["media"]), None
                )
            if chosen is None:
                if kind == "router" and unused_router_fiber(t, d, port):
                    continue
                raise ValueError(
                    f"No native {port['media']} interface available on {d['name']}."
                )
            if kind != "switch" and (port["vlan"] != 1 or port["mode"] != "access"):
                raise ValueError(
                    "This native host or router has no mapped VLAN subinterface."
                )
            free.remove(chosen)
            name, _, raw, _ = chosen
            endpoints[d["id"], port["id"]] = (ref, name)
            native_names[port["id"]] = name
            current = dict(port)
            current["name"] = name
            if kind == "router":
                current.update(mapped_metrics(port, name))
            # Write explicit values even if the donor happened to match.
            before = {**current, "enabled": None}
            before.pop("bandwidth", None)
            before.pop("delay", None)
            if kind == "router" or port.get("routed"):
                before.pop("helperAddresses", None)
            if current["media"] == "serial":
                before["clockRate"] = None
            if kind != "switch" or port.get("routed"):
                before.update(ip=None, prefix=None)
            if kind in ("pc", "server"):
                before["addressMode"] = "unset"
                current["addressMode"] = port.get("addressMode", "static")
                child(raw, "PORT_DNS", d.get("dns", ""))
                child(raw, "PORT_GATEWAY", d.get("gateway", ""))
            if kind == "switch":
                before.update(mode=None, vlan=None, nativeVlan=None, allowedVlans=None)
                before.pop("nonegotiate", None)
                before.pop("routed", None)
                before.pop("portFast", None)
                before.pop("bpduGuard", None)
                before.pop("channelGroup", None)
                before.pop("channelProtocol", None)
            update_port(eng, kind, chosen, before, current)
        from virtuals import ensure_vlan, update_routing, write_logical

        logical_names = set()
        for port in [p for p in d["ports"] if p.get("virtual")]:
            require_supported(port, PORT_FIELDS, "port")
            if any(
                e[s] == {"device": d["id"], "port": port["id"]}
                for e in t["links"]
                for s in ("a", "b")
            ):
                raise ValueError(
                    "Connect cables to the virtual interface's physical parent."
                )
            name = write_logical(eng, d, port, native_names)
            if name in logical_names:
                raise ValueError("Native virtual interfaces need unique names.")
            logical_names.add(name)
            endpoints[d["id"], port["id"]] = (ref, name)
        from eigrp import update as update_eigrp

        update_eigrp(
            eng,
            {"ports": []},
            d,
            {
                port_id: name
                for (device_id, port_id), (_, name) in endpoints.items()
                if device_id == d["id"]
            },
        )
        from acls import update as update_acls
        from server_services import authored as author_services

        update_acls(
            eng,
            {"kind": kind, "ports": []},
            d,
            {
                port_id: name
                for (device_id, port_id), (_, name) in endpoints.items()
                if device_id == d["id"]
            },
        )
        if kind == "server":
            author_services(eng, d, native_names)
        elif d.get("services"):
            raise ValueError("Native server service settings require a server.")
        if kind == "switch":
            from channels import update_switch as update_channels, sync_manager
            from edgeprotection import update_switch as update_edge
            from switching import authored_switch

            update_routing(eng, None, d.get("ipRouting", False))
            for port in d["ports"] if "vlans" not in d else []:
                for tag in [
                    port["vlan"],
                    *port["allowedVlans"],
                    port.get("nativeVlan", 1),
                ]:
                    ensure_vlan(eng, tag)
            authored_switch(eng, d)
            update_edge(eng, {}, d)
            update_channels(eng, {}, d)
            sync_manager(eng, {}, d, native_names)
        elif "vlans" in d or "vtp" in d:
            raise ValueError("VLAN databases and VTP require a native switch.")
        elif "spanningTree" in d or "bpduGuardRecovery" in d:
            raise ValueError("Native spanning-tree settings require a switch.")
        elif "etherChannelLoadBalance" in d:
            raise ValueError("Native EtherChannel settings require a switch.")
        if kind in ("router", "switch") and d["routes"]:
            lines = [e.text or "" for e in eng.findall("RUNNINGCONFIG/LINE")]
            at = lines.index("end")
            lines[at:at] = [
                "ip route "
                + r["network"]
                + " "
                + mask(r["prefix"])
                + " "
                + r["nextHop"]
                for r in d["routes"]
            ]
            set_lines(eng, "RUNNINGCONFIG", lines)
    links = root.find("NETWORK/LINKS")
    kinds = {d["id"]: d["kind"] for d in t["devices"]}
    for e in t["links"]:
        cable(links, e, endpoints, kinds)
    write_scenarios(root, t, refs)
    return root, endpoints


def answer_for(activity):
    answer = deepcopy(activity["initial"])
    devices = {d["id"]: d for d in answer["devices"]}
    for check in activity.get("interfaceChecks", []):
        dev = devices[check["device"]]
        port = next(p for p in dev["ports"] if p["id"] == check["port"])
        field, expected = check["field"], check["expected"]
        if field == "ipv4":
            ip = IPv4Interface(expected) if expected != "unassigned" else None
            port["ip"] = str(ip.ip) if ip else ""
            port["prefix"] = ip.network.prefixlen if ip else 24
        elif field == "enabled":
            port["enabled"] = expected == "up"
        elif field == "vlan":
            port.update(mode="access", vlan=int(expected))
        else:
            raise ValueError(
                "This activity check has no mapped native interface setting."
            )
    return answer


def new_activity(t):
    act = t.get("activity")
    initial = act["initial"] if act else t
    current, _ = network(t)
    start, _ = network(initial)
    solved = answer_for(act) if act else initial
    answer, ends = network(solved)
    root = X.Element(ACTIVITY)
    child(root, "VERSION", current.findtext("VERSION"))
    root.extend((current, start, answer))
    comparisons = X.SubElement(root, "COMPARISONS")
    tree = assessment_node(comparisons, "Network")
    if act and act["checks"]:
        # Cisco evaluates scored PDUs in the first answer-network scenario.
        # Practice probes belong only to this assessment, never the working network.
        assessment = assessment_node(tree, "ConnectivityTests", category="Other")
        child(assessment, "POINTS", 0)
        ref_by_id = {device: ref for (device, _), (ref, _) in ends.items()}
        scratch = X.Element("PACKETTRACER5")
        probes = [{**check["probe"], "scenario": "default"} for check in act["checks"]]
        write_scenarios(
            scratch, {**solved, "scenarios": [DEFAULT], "pdus": probes}, ref_by_id
        )
        scenario = answer.find("SCENARIOSET/SCENARIO")
        first = len(scenario.findall("PDU"))
        for i, (check, packet) in enumerate(
            zip(act["checks"], scratch.findall("SCENARIOSET/SCENARIO/PDU")), first
        ):
            child(packet, "TEST_CONDITION", 3 if check["deliver"] else 2)
            scenario.append(packet)
            assessment_node(assessment, str(i), value="1", category="Other", eclass="8")
    branches = {}
    for check in (act or {}).get("interfaceChecks", []):
        device = next(d for d in initial["devices"] if d["id"] == check["device"])
        path = (device["name"], "Ports", ends[device["id"], check["port"]][1])
        parent = tree
        for depth, name in enumerate(path, 1):
            key = path[:depth]
            if key not in branches:
                branches[key] = assessment_node(parent, name)
            parent = branches[key]
        expected = check["expected"]
        if check["field"] == "ipv4":
            addr = IPv4Interface(expected) if expected != "unassigned" else None
            assessment_node(
                parent,
                "IP Address",
                value=str(addr.ip) if addr else "0.0.0.0",
                category="Ip",
            )
            assessment_node(
                parent,
                "Subnet Mask",
                value=str(addr.netmask) if addr else "0.0.0.0",
                category="Ip",
            )
        elif check["field"] == "enabled":
            assessment_node(
                parent,
                "Port Status",
                "Power",
                "1" if expected == "up" else "0",
                "Physical",
                "4",
            )
        elif check["field"] == "vlan":
            assessment_node(
                parent, "Access VLAN", value=expected, category="Switching", eclass="5"
            )
    # Packet Tracer 9.0.1 rejects a compact nested assessment tree.
    X.indent(comparisons, space=" ")
    setup = X.SubElement(root, "INITIALSETUP")
    assessment_node(setup, "Network").find("NAME").set("checkType", "0")
    child(setup, "LOAD_INIT_TREE", "true")
    locks = X.SubElement(root, "LOCKINGTREE", enabled="no")
    node = X.SubElement(locks, "NODE", on="no")
    child(node, "ID", "Locking")
    child(node, "TEXT", "Locking / Starting")
    root.append(deepcopy(current.find("OPTIONS")))
    data = X.SubElement(
        root,
        "ACTIVITY",
        ENABLED="no",
        TIMERTYPE="0",
        ELAPSED="0",
        PASS="",
        COUNTDOWNLEFT="0",
        COUNTDOWNMS="0",
        COUNTDOWN_EXPIRED="0",
        FORWARD_ANS_SIM_MS="0",
    )
    pages = X.SubElement(data, "INSTRUCTIONS", enable_tab="false", layout="0")
    title = act["title"] if act else t["name"]
    instructions = (
        act["instructions"] if act else "Explore the network and verify connectivity."
    )
    page = X.SubElement(pages, "PAGE", title=title, translate="true", tabify="0")
    page.text = X.CDATA(
        "<html><body><h1>"
        + escape(title)
        + "</h1><p>"
        + escape(instructions).replace("\n", "<br/>")
        + "</p></body></html>"
    )
    dialog = X.SubElement(data, "INSTRUCTION_DIALOG")
    X.SubElement(dialog, "USER_NOTES", isDirty="false", tabify="0").text = X.CDATA("")
    variables = X.SubElement(root, "VARIABLE_MANAGER")
    for tag in (
        "SEED_POOLS",
        "NUMBER_POOLS",
        "STRING_POOLS",
        "IP_POOLS",
        "VARIABLES_POOLS",
    ):
        X.SubElement(variables, tag)
    child(root, "OVERALL_INCOMPLETE_FEEDBACK", "Review the activity instructions.").set(
        "translate", "true"
    )
    child(root, "OVERALL_COMPLETE_FEEDBACK", "Activity complete.").set(
        "translate", "true"
    )
    child(root, "UNLOCK_ASSESSMENT_ITEM_PERCENT", 100)
    child(root, "DYNAMIC_PERCENTAGE_FEEDBACK", "true").set("TYPE", "1")
    child(root, "USER_PROFILE_LOCKED", "false")
    child(root, "USER_PROFILE_NOGUEST", "false")
    child(root, "COMPONENT_LIST", "Other, Physical, Ip, Switching")
    child(root, "CLEAN_ACTIVITY", "true")
    root.append(deepcopy(current.find("SCRIPT_MODULE")))
    child(X.SubElement(root, "AUTHOR"), "INFO", "")
    X.SubElement(root, "OBJECT_LOCATIONS", INDEX="")
    for tag in ("START_TIMESTAMP", "CEPS", "EXT_PORT_MGR"):
        X.SubElement(root, tag)
    return root


def assessment_node(parent, name, identifier=None, value=None, category="", eclass="0"):
    node = X.SubElement(parent, "NODE")
    head = value is None
    label = child(node, "NAME", name)
    label.attrib.update(
        dict(
            headNode=str(head).lower(),
            eclass="8" if head else eclass,
            checkType="1" if head else "2",
            nodeValue="" if head else value,
            incorrectFeedback="",
            obfuscateName="false",
            overrideDBGrading="false",
            variableEnabled=str(not head).lower(),
            variableName="",
        )
    )
    child(node, "ID", identifier or name)
    child(node, "COMPONENTS", category)
    child(node, "POINTS", "" if head else 1)
    return node
