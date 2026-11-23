"""Native IOS PortFast and BPDU Guard configuration, without inventing latch state."""

import re

PORTFAST = re.compile(r"(?:no )?spanning-tree portfast(?: trunk| disable)?")
GUARD = re.compile(
    r"(?:spanning-tree bpduguard (?:enable|disable)|no spanning-tree bpduguard(?: enable| disable)?)"
)
PRIORITY = re.compile(r"spanning-tree vlan (\d+) priority (\d+)")
GLOBALS = {
    "portFastDefault": "spanning-tree portfast default",
    "bpduGuardDefault": "spanning-tree portfast bpduguard default",
}


def port_settings(commands):
    result = {}
    for command in commands:
        if PORTFAST.fullmatch(command):
            result["portFast"] = (
                "default"
                if command.startswith("no ")
                else (
                    "disable"
                    if command.endswith(" disable")
                    else "trunk" if command.endswith(" trunk") else "enable"
                )
            )
        elif GUARD.fullmatch(command):
            result["bpduGuard"] = (
                "default"
                if command.startswith("no ")
                else "disable" if command.endswith(" disable") else "enable"
            )
    return result


def switch_settings(lines):
    result, priorities = {}, {}
    for line in lines:
        for key, command in GLOBALS.items():
            if line in (command, "no " + command):
                result[key] = line == command
        match = PRIORITY.fullmatch(line)
        if (
            match
            and 1 <= int(match[1]) <= 4094
            and int(match[2]) <= 61440
            and int(match[2]) % 4096 == 0
        ):
            priorities[int(match[1])] = int(match[2])
    if len(priorities) > 128:
        priorities = {}
    if not result and not priorities:
        return None
    result["priorities"] = [
        dict(vlan=v, priority=p) for v, p in sorted(priorities.items())
    ]
    return result


def port_commands(kind, before, after, physical=True):
    result = []
    for field, options, pattern, command in (
        (
            "portFast",
            ("default", "enable", "trunk", "disable"),
            PORTFAST,
            "spanning-tree portfast",
        ),
        (
            "bpduGuard",
            ("default", "enable", "disable"),
            GUARD,
            "spanning-tree bpduguard",
        ),
    ):
        value = after.get(field, "default")
        if field in after and (
            kind != "switch"
            or not physical
            or after.get("routed")
            or after.get("media") not in ("copper", "fiber")
        ):
            raise ValueError(
                "PortFast and BPDU Guard require a physical native switchport."
            )
        if value not in options:
            raise ValueError("Invalid native PortFast or BPDU Guard setting.")
        if before.get(field, "default") == value:
            continue
        if field == "bpduGuard" and value == "disable":
            raise ValueError(
                "Packet Tracer cannot preserve an explicit BPDU Guard disable override. Use default or export CertSim JSON."
            )
        written = None
        if value != "default":
            written = command
            if field == "bpduGuard" or value != "enable":
                written += " " + value
        result.append((pattern, written))
    return result


def validate_switch(settings):
    if not isinstance(settings, dict) or settings.keys() - {"priorities", *GLOBALS}:
        raise ValueError("Unsupported native spanning-tree settings.")
    for key in GLOBALS:
        if key in settings and not isinstance(settings[key], bool):
            raise ValueError("Native PortFast and BPDU Guard defaults must be boolean.")
    rows = settings.get("priorities", [])
    if not isinstance(rows, list) or len(rows) > 128:
        raise ValueError("Use at most 128 native VLAN bridge priorities.")
    seen = set()
    for row in rows:
        if (
            not isinstance(row, dict)
            or row.keys() != {"vlan", "priority"}
            or type(row.get("vlan")) is not int
            or not 1 <= row["vlan"] <= 4094
            or row["vlan"] in seen
            or type(row.get("priority")) is not int
            or not 0 <= row["priority"] <= 61440
            or row["priority"] % 4096
        ):
            raise ValueError(
                "Native bridge priorities need distinct VLANs and multiples of 4096."
            )
        seen.add(row["vlan"])


def update_switch(engine, before, after):
    from editing import set_lines

    recovery = after.get("bpduGuardRecovery", False)
    if not isinstance(recovery, bool):
        raise ValueError("BPDU Guard recovery must be enabled or disabled.")
    if recovery and not before.get("bpduGuardRecovery", False):
        raise ValueError(
            "Packet Tracer does not support automatic BPDU Guard recovery. Export CertSim JSON to keep recovery settings."
        )
    previous, current = (
        before.get("spanningTree") or {},
        after.get("spanningTree") or {},
    )
    if previous == current:
        return
    validate_switch(current)
    lines = [n.text or "" for n in engine.findall("RUNNINGCONFIG/LINE")]
    additions = []
    for key, command in GLOBALS.items():
        if previous.get(key, False) == current.get(key, False):
            continue
        lines = [s for s in lines if s not in (command, "no " + command)]
        if current.get(key):
            additions.append(command)
    if previous.get("priorities", []) != current.get("priorities", []):
        old = {
            f"spanning-tree vlan {r['vlan']} priority {r['priority']}"
            for r in previous.get("priorities", [])
        }
        lines = [s for s in lines if s not in old]
        additions.extend(
            f"spanning-tree vlan {r['vlan']} priority {r['priority']}"
            for r in current.get("priorities", [])
        )
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
