"""Packet Tracer simulation scenarios and simple, one-shot IPv4 echo packets."""

from lxml import etree as X
from documents import child, plain_text

DEFAULT = {"id": "default", "name": "Scenario 0", "description": ""}


def echo_source(device):
    return device["kind"] != "switch" or any(
        (p.get("virtual", {}).get("kind") == "svi" or p.get("routed")) and p["ip"]
        for p in device["ports"]
    )


def scenarios_from(root, mapped):
    visible, packets, omitted = [], [], 0
    for i, scenario in enumerate(root.findall("SCENARIOSET/SCENARIO")):
        sid = "default" if i == 0 else f"native-scenario-{i}"
        name = (scenario.findtext("NAME") or f"Scenario {i}")[:48]
        if (
            any(s["name"].casefold() == name.casefold() for s in visible)
            or len(visible) >= 32
        ):
            omitted += 1 + len(scenario.findall("PDU"))
            continue
        description = " ".join(
            plain_text(scenario.findtext("DESCRIPTION") or "").split()
        )[:300]
        visible.append(dict(id=sid, name=name, description=description))
        for j, entry in enumerate(scenario.findall("PDU")):
            src = mapped.get(entry.findtext("SOURCE"))
            dest = entry.find("DESTINATION")
            target = mapped.get(dest.get("device")) if dest is not None else None
            header = entry.find("PDU")
            pdu_type = entry.find("TYPE")
            if (
                not src
                or not target
                or header is None
                or pdu_type is None
                or pdu_type.text != "0"
                or pdu_type.get("patterned", "no") != "no"
                or entry.findtext("START") not in ("0", "0.0")
                or entry.findtext("TEST_CONDITION") != "0"
                or header.findtext("TYPE") != "CIpHeader"
                or header.findtext("PDU/TYPE") != "CIcmpMessage"
                or header.findtext("PDU/ICMPTYPE") != "8"
                or not echo_source(src[0])
                or len(packets) >= 64
            ):
                omitted += 1
                continue
            ip = header.findtext("DSTADDR")
            port = next((p for p in target[0]["ports"] if ip and p["ip"] == ip), None)
            ttl = header.findtext("TTL") or "255"
            if (
                not port
                or (
                    target[0]["kind"] == "switch"
                    and port.get("virtual", {}).get("kind") != "svi"
                    and not port.get("routed")
                )
                or not ttl.isdigit()
                or not 1 <= int(ttl) <= 255
            ):
                omitted += 1
                continue
            packets.append(
                dict(
                    id=f"native-pdu-{i}-{j}",
                    source=src[0]["id"],
                    target=target[0]["id"],
                    port=port["id"],
                    protocol="icmp",
                    scenario=sid,
                    ttl=int(ttl),
                )
            )
    result = {}
    if visible and visible != [DEFAULT] or packets:
        result["scenarios"] = visible
    if packets:
        result["pdus"] = packets
    return result, omitted


def write_scenarios(root, topology, refs):
    scenarios = topology.get("scenarios") or [DEFAULT]
    devices = {d["id"]: d for d in topology["devices"]}
    block = root.find("SCENARIOSET")
    if block is None:
        block = X.SubElement(root, "SCENARIOSET")
    for item in block.findall("SCENARIO"):
        block.remove(item)
    sections = {}
    for scenario in scenarios:
        item = X.SubElement(block, "SCENARIO")
        sections[scenario["id"]] = item
        child(item, "NAME", scenario["name"]).set("translate", "true")
        child(item, "DESCRIPTION", scenario["description"]).set("translate", "true")
    for p in topology.get("pdus", []):
        if p.get("protocol") != "icmp" or p.get("schedule") or p.get("sourceInterface"):
            raise ValueError(
                "Native export currently supports one-shot, unscheduled IPv4 ICMP PDUs."
            )
        source, target = devices[p["source"]], devices[p["target"]]
        if not echo_source(source):
            raise ValueError(
                "A source switch needs an addressed SVI or routed port for a native echo PDU."
            )
        port = next((n for n in target["ports"] if n["id"] == p["port"]), None)
        if (
            not port
            or not port["ip"]
            or (
                target["kind"] == "switch"
                and port.get("virtual", {}).get("kind") != "svi"
                and not port.get("routed")
            )
        ):
            raise ValueError("A native echo PDU requires a destination IPv4 address.")
        entry = X.SubElement(sections[p.get("scenario", "default")], "PDU")
        child(entry, "TYPE", "0").set("patterned", "no")
        child(entry, "CUSTOM_TYPE", "")
        child(entry, "SOURCE", refs[p["source"]])
        child(entry, "PORT", "")
        X.SubElement(entry, "DESTINATION", device=refs[p["target"]])
        child(entry, "COLOR", "-16391283")
        header = X.SubElement(entry, "PDU")
        for k, v in [
            ("TYPE", "CIpHeader"),
            ("SRCADDR", ""),
            ("DSTADDR", port["ip"]),
            ("PROTOCOL", ""),
            ("TTL", p.get("ttl", 255)),
        ]:
            child(header, k, v)
        echo = X.SubElement(header, "PDU")
        for k, v in [
            ("TYPE", "CIcmpMessage"),
            ("ICMPTYPE", 8),
            ("CODE", 0),
            ("ID", 0),
            ("SEQ", 0),
            ("CHK", 0),
        ]:
            child(echo, k, v)
        child(header, "TOS", 0)
        for k, v in [
            ("TEST_CONDITION", 0),
            ("POINTS", 1),
            ("PDU_SIZE", 0),
            ("START", 0),
        ]:
            child(entry, k, v)


def update_scenarios(root, original, edited, refs):
    """Preserve opaque native scenarios/PDUs and change only mapped records."""
    before = {s["id"]: s for s in original.get("scenarios", [DEFAULT])}
    after = {s["id"]: s for s in edited.get("scenarios", [DEFAULT])}
    old = {p["id"]: p for p in original.get("pdus", [])}
    new = {p["id"]: p for p in edited.get("pdus", [])}
    if before == after and old == new:
        return
    block = root.find("SCENARIOSET")
    if block is None:
        block = X.SubElement(root, "SCENARIOSET")
    sections = {
        ("default" if i == 0 else f"native-scenario-{i}"): node
        for i, node in enumerate(block.findall("SCENARIO"))
    }
    raw_pdus = {
        f"native-pdu-{i}-{j}": node
        for i, section in enumerate(block.findall("SCENARIO"))
        for j, node in enumerate(section.findall("PDU"))
    }
    for key, previous in old.items():
        if new.get(key) != previous:
            node = raw_pdus[key]
            node.getparent().remove(node)
    for sid in before.keys() - after.keys():
        node = sections[sid]
        if any(c.tag not in {"NAME", "DESCRIPTION"} for c in node):
            raise ValueError(
                "This scenario contains native-only simulation data. Keep it or edit it in Packet Tracer."
            )
        block.remove(node)
    for sid, s in after.items():
        if sid not in sections:
            sections[sid] = X.SubElement(block, "SCENARIO")
        node = sections[sid]
        for key, tag in [("name", "NAME"), ("description", "DESCRIPTION")]:
            if before.get(sid, {}).get(key) != s[key] or node.find(tag) is None:
                child(node, tag, s[key]).set("translate", "true")
    modified = [p for key, p in new.items() if p != old.get(key)]
    if modified:
        buffer = X.Element("PACKETTRACER5")
        write_scenarios(buffer, {**edited, "pdus": modified}, refs)
        for scenario, generated in zip(
            after.values(), buffer.findall("SCENARIOSET/SCENARIO")
        ):
            sections[scenario["id"]].extend(generated.findall("PDU"))
