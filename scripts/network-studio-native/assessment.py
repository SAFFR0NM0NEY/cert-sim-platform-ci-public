"""Score supported learner-visible work without returning native answer values."""

from collections import Counter
from ipaddress import IPv4Network
from documents import NETWORK, restricted_activity


def grade(root, topology, observations):
    if root.tag == NETWORK or restricted_activity(root):
        raise ValueError("Native grading requires an unrestricted activity.")
    devices = {d["name"]: d for d in topology["devices"]}
    duplicate = {
        n for n, c in Counter(d["name"] for d in topology["devices"]).items() if c > 1
    }
    earned = total = unmapped = 0
    probes = []
    for node in root.findall("COMPARISONS//NODE"):
        label = node.find("NAME")
        if (
            label is None
            or label.get("headNode") != "false"
            or label.get("checkType") != "2"
        ):
            continue
        path = [n.findtext("ID") for n in reversed(list(node.iterancestors("NODE")))]
        if len(path) > 1 and path[1] == "ConnectivityTests":
            continue
        points = node.findtext("POINTS")
        if (
            len(path) != 4
            or path[2] != "Ports"
            or not (points or "").isdecimal()
            or label.get("variableName")
        ):
            unmapped += 1
            continue
        device = devices.get(path[1])
        port = (
            next((p for p in device["ports"] if p["name"] == path[3]), None)
            if device
            else None
        )
        key = node.findtext("ID")
        if path[1] in duplicate or key not in {
            "IP Address",
            "Subnet Mask",
            "Power",
            "Access VLAN",
        }:
            unmapped += 1
            continue
        total += int(points)
        if not port:
            continue
        actual = {
            "IP Address": port["ip"] or "0.0.0.0",
            "Subnet Mask": (
                str(IPv4Network("0.0.0.0/" + str(port["prefix"])).netmask)
                if port["ip"]
                else "0.0.0.0"
            ),
            "Power": "1" if port["enabled"] else "0",
            "Access VLAN": str(port["vlan"]),
        }[key]
        if actual == label.get("nodeValue"):
            earned += int(points)

    # The native file identifies scored probe endpoints by answer-device references.
    # Translate references only to devices and addresses already present in the student workspace.
    answer = root.findall(NETWORK)[2]
    names = {
        (e.findtext("SAVE_REF_ID") or str(i)): e.findtext("NAME")
        for i, e in enumerate(answer.findall("NETWORK/DEVICES/DEVICE/ENGINE"))
    }
    first = answer.find("SCENARIOSET/SCENARIO")
    for i, entry in enumerate(first.findall("PDU") if first is not None else []):
        condition = entry.findtext("TEST_CONDITION")
        if condition in (None, "0"):
            continue
        dest = entry.find("DESTINATION")
        src_name = names.get(entry.findtext("SOURCE"))
        dst_name = names.get(dest.get("device")) if dest is not None else None
        src = devices.get(src_name)
        dst = devices.get(dst_name)
        ip = entry.findtext("PDU/DSTADDR")
        port = (
            next((p for p in dst["ports"] if ip and p["ip"] == ip), None)
            if dst
            else None
        )
        ttl = entry.findtext("PDU/TTL") or "255"
        points = entry.findtext("POINTS") or "1"
        if (
            condition not in ("2", "3")
            or entry.findtext("TYPE") != "0"
            or entry.findtext("PDU/PDU/TYPE") != "CIcmpMessage"
            or entry.findtext("PDU/PDU/ICMPTYPE") != "8"
            or src_name in duplicate
            or dst_name in duplicate
            or not src
            or not port
            or not points.isdecimal()
            or not ttl.isdecimal()
            or not 1 <= int(ttl) <= 255
            or len(probes) >= 64
        ):
            unmapped += 1
            continue
        key = "probe-" + str(i)
        total += int(points)
        probes.append(
            dict(
                id=key,
                source=src["id"],
                target=dst["id"],
                port=port["id"],
                protocol="icmp",
                ttl=int(ttl),
            )
        )
        if observations.get(key) is (condition == "3"):
            earned += int(points)
    return dict(earned=earned, total=total, unmapped=unmapped, probes=probes)
