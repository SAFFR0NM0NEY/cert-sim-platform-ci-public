"""Packet Tracer VLAN databases and VTP state, independent of IOS interfaces."""

from copy import deepcopy
import re

from lxml import etree as X

from documents import child

MODES = {"0": "server", "1": "client", "2": "transparent"}
DEFAULTS = {
    1: "default",
    1002: "fddi-default",
    1003: "token-ring-default",
    1004: "fddinet-default",
    1005: "trnet-default",
}


def vlan_rows(engine):
    block = engine.find("VLANS")
    if block is None:
        return None
    rows, seen = [], set()
    for row in block.findall("VLAN"):
        number, name = row.get("number", ""), row.get("name", "")
        if (
            not number.isascii()
            or not number.isdecimal()
            or not 1 <= int(number) <= 4094
            or int(number) in seen
            or not name
            or len(name) > 32
            or any(ord(c) < 32 for c in name)
            or row.get("state", "active") != "active"
            or row.get("status", "active") != "active"
            or (int(number) in DEFAULTS and name != DEFAULTS[int(number)])
        ):
            # An unprojectable database stays native-only, including on unrelated edits.
            return None
        seen.add(int(number))
        rows.append(dict(id=int(number), name=name, state="active"))
    return sorted(rows, key=lambda row: row["id"])


def vtp_settings(engine):
    block = engine.find("VTP")
    if block is None:
        return None
    mode = MODES.get(block.findtext("MODE"))
    version = block.findtext("VERSION")
    revision = block.findtext("CONFIG_REVISION") or "0"
    if (
        not mode
        or version not in ("1", "2")
        or not revision.isascii()
        or not revision.isdecimal()
        or not 0 <= int(revision) <= 4294967295
    ):
        return None
    result = dict(
        mode=mode,
        domain=block.findtext("DOMAIN_NAME") or "",
        version=int(version),
        revision=int(revision),
    )
    password = block.findtext("PASSWORD") or ""
    if any(
        len(value) > limit or any(ord(c) < 32 or ord(c) == 127 for c in value)
        for value, limit in ((result["domain"], 32), (password, 64))
    ):
        return None
    if password:
        result["password"] = password
    return result


def project_switch(engine):
    result = {}
    for key, value in (("vlans", vlan_rows(engine)), ("vtp", vtp_settings(engine))):
        if value is not None:
            result[key] = value
    return result


def token(value, subject, empty=False, limit=32):
    if (
        not isinstance(value, str)
        or not (empty or value)
        or len(value) > limit
        or any(not 33 <= ord(c) <= 126 for c in value)
    ):
        raise ValueError(
            f"Native {subject} needs an ASCII token up to {limit} characters."
        )


def validate_rows(rows, previous):
    if not isinstance(rows, list) or len(rows) > 4094:
        raise ValueError("A native VLAN database supports at most 4094 entries.")
    old = {r["id"]: r for r in previous or []}
    seen = set()
    for row in rows:
        if (
            not isinstance(row, dict)
            or row.keys() != {"id", "name", "state"}
            or type(row.get("id")) is not int
            or not 1 <= row["id"] <= 4094
            or row["id"] in seen
        ):
            raise ValueError(
                "Native VLAN IDs must be distinct integers from 1 to 4094."
            )
        seen.add(row["id"])
        if row["state"] != "active":
            raise ValueError(
                "Packet Tracer does not support suspended VLANs. Export CertSim JSON to keep VLAN suspension."
            )
        if row != old.get(row["id"]):
            token(row["name"], "VLAN name")
        if row["id"] in DEFAULTS and row["name"] != DEFAULTS[row["id"]]:
            if row != old.get(row["id"]):
                raise ValueError("Native default VLANs cannot be renamed.")
    if any(
        i not in seen
        for i in (DEFAULTS if previous is None else old.keys() & DEFAULTS.keys())
    ):
        raise ValueError("Keep native default VLANs 1 and 1002 through 1005.")


def validate_vtp(value):
    if (
        not isinstance(value, dict)
        or value.keys() - {"mode", "domain", "version", "revision", "password"}
        or value.get("mode") not in MODES.values()
        or type(value.get("version")) is not int
        or value["version"] not in (1, 2)
        or type(value.get("revision")) is not int
        or not 0 <= value["revision"] <= 4294967295
    ):
        raise ValueError(
            "Native VTP supports server, client, transparent and versions 1 or 2."
        )
    token(value.get("domain"), "VTP domain", empty=True)
    token(value.get("password", ""), "VTP password", empty=True, limit=64)


def replace_rows(block, rows):
    existing = {n.get("number"): n for n in block.findall("VLAN")}
    keep = {str(row["id"]) for row in rows}
    for number, node in existing.items():
        if number not in keep:
            block.remove(node)
    for row in rows:
        node = existing.get(str(row["id"]))
        if node is None:
            node = X.SubElement(block, "VLAN", number=str(row["id"]), rspan="0")
        node.set("name", row["name"])


def write_vtp(block, value):
    for key, tag in (
        ("domain", "DOMAIN_NAME"),
        ("version", "VERSION"),
        ("revision", "CONFIG_REVISION"),
        ("password", "PASSWORD"),
    ):
        child(block, tag, value.get(key, ""))
    child(block, "MODE", next(k for k, v in MODES.items() if v == value["mode"]))


def update_switch(engine, before, after):
    db_changed = before.get("vlans") != after.get("vlans")
    vtp_changed = before.get("vtp") != after.get("vtp")
    if not db_changed and not vtp_changed:
        return
    rows, vtp = after.get("vlans"), after.get("vtp")
    if db_changed:
        if rows is None:
            raise ValueError(
                "Keep the explicit native VLAN database when saving this file."
            )
        if engine.find("VLANS") is not None and vlan_rows(engine) is None:
            raise ValueError("This native VLAN database contains unsupported settings.")
        validate_rows(rows, before.get("vlans"))
    if vtp_changed:
        if vtp is None:
            raise ValueError("Keep native VTP settings when saving this file.")
        if engine.find("VTP") is not None and vtp_settings(engine) is None:
            raise ValueError(
                "This native VTP version or mode is not supported for editing."
            )
        validate_vtp(vtp)
    # Match the live database and its persisted vlan.dat file. Do not overwrite the
    # separate CFileSystem snapshot, startup configuration, or unrelated files.
    containers = [engine]
    containers.extend(
        f.find("FILE_CONTENT")
        for f in engine.findall("FILE_MANAGER//FILE")
        if f.findtext("NAME") == "vlan.dat"
        and f.get("class") == "CFile"
        and f.find("FILE_CONTENT") is not None
    )
    for container in containers:
        if db_changed:
            block = container.find("VLANS")
            if block is None:
                block = X.SubElement(container, "VLANS")
            replace_rows(block, rows)
            if container is not engine:
                child(container, "VLAN_COUNT", len(rows))
        if vtp_changed:
            block = container.find("VTP")
            if block is None:
                block = X.SubElement(container, "VTP")
            write_vtp(block, vtp)
    update_config(engine, before, after, db_changed, vtp_changed)


def update_config(engine, before, after, db_changed, vtp_changed):
    from editing import set_lines

    lines = [n.text or "" for n in engine.findall("RUNNINGCONFIG/LINE")]
    transparent = after.get("vtp", {}).get("mode") == "transparent"
    mode_changed = before.get("vtp", {}).get("mode") != after.get("vtp", {}).get("mode")
    rows = after.get("vlans")
    additions = []
    if rows is not None and (db_changed or mode_changed):
        wanted = {r["id"]: r for r in rows}
        old = {r["id"] for r in before.get("vlans", [])}
        result, seen, index = [], set(), 0
        while index < len(lines):
            match = re.fullmatch(r"vlan (\d+)", lines[index])
            if not match or int(match[1]) not in old | wanted.keys():
                result.append(lines[index])
                index += 1
                continue
            number = int(match[1])
            end = index + 1
            while end < len(lines) and lines[end].startswith(" "):
                end += 1
            commands = [s for s in lines[index + 1 : end] if not s.startswith(" name ")]
            if number in wanted and transparent:
                result.extend([lines[index], *commands])
                result.append(" name " + wanted[number]["name"])
                seen.add(number)
            elif number in wanted and commands:
                # Retain unrelated native VLAN commands when changing VTP mode.
                result.extend([lines[index], *commands])
            index = end
        lines = result
        if transparent:
            for number, row in wanted.items():
                if number not in DEFAULTS and number not in seen:
                    additions.extend([f"vlan {number}", " name " + row["name"], "!"])
    if vtp_changed:
        lines = [
            s
            for s in lines
            if not re.fullmatch(r"vtp (domain|mode|version|password) .+", s)
        ]
        vtp = after["vtp"]
        if transparent:
            if vtp["domain"]:
                additions.append("vtp domain " + vtp["domain"])
            additions.extend(["vtp mode transparent", f"vtp version {vtp['version']}"])
    if additions:
        at = next(
            (
                i
                for i, s in enumerate(lines)
                if s.startswith("interface ") or s == "end"
            ),
            len(lines),
        )
        lines[at:at] = additions
    set_lines(engine, "RUNNINGCONFIG", lines)


def authored_switch(engine, device):
    """Explicit databases take precedence over inferred legacy VLAN memberships."""
    before = project_switch(engine)
    desired = deepcopy(before)
    desired.update({key: device[key] for key in ("vlans", "vtp") if key in device})
    update_switch(engine, before, desired)
