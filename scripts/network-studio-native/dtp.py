"""Administrative DTP settings stored in native IOS interface stanzas."""

import re

MODES = {
    "access": "access",
    "trunk": "trunk",
    "dynamic auto": "dynamic-auto",
    "dynamic desirable": "dynamic-desirable",
}
MODE = re.compile(r"(?:no )?switchport mode(?: .*)?")
NEGOTIATION = re.compile(r"(?:no )?switchport nonegotiate")


def opaque_mode(config):
    return any(
        line.startswith("switchport mode ")
        and line.removeprefix("switchport mode ") not in MODES
        for line in config
    )


def port_settings(config):
    # The observed 2960/3560 IOS default is dynamic auto. Cisco omits its
    # command when saving, so absence must not turn an imported port static.
    result = {"mode": "dynamic-auto"}
    for line in config:
        if line.startswith("switchport mode "):
            value = line.removeprefix("switchport mode ")
            if value in MODES:
                result["mode"] = MODES[value]
        elif line == "no switchport mode":
            result["mode"] = "dynamic-auto"
        elif line == "switchport nonegotiate":
            result["nonegotiate"] = True
        elif line == "no switchport nonegotiate":
            result.pop("nonegotiate", None)
    if opaque_mode(config):
        # Never let an unsupported tunnel/private-VLAN mode negotiate a trunk.
        # read_network adds a projection warning and edits retain a guard.
        result["mode"] = "access"
    return result


def validate_port(kind, port):
    mode = port.get("mode")
    if mode not in MODES.values():
        raise ValueError("Unsupported native switch port mode.")
    dynamic = mode.startswith("dynamic-")
    if (dynamic or "nonegotiate" in port) and (
        kind != "switch"
        or port.get("routed")
        or port["media"] not in ("copper", "fiber")
        or port.get("virtual", {}).get("kind") not in (None, "portchannel")
    ):
        raise ValueError("Native DTP settings require a Layer 2 switch Ethernet port.")
    if "nonegotiate" in port and type(port["nonegotiate"]) is not bool:
        raise ValueError("Native DTP negotiation must be enabled or disabled.")
    if dynamic and port.get("nonegotiate"):
        raise ValueError("Dynamic switchports cannot disable DTP negotiation.")
    if dynamic and port.get("security"):
        raise ValueError("Port security requires a static access or trunk mode.")


def port_commands(kind, config, before, after, converting=False):
    validate_port(kind, after)
    changed = converting or any(
        before.get(key) != after.get(key) for key in ("mode", "nonegotiate")
    )
    if not changed:
        return []
    if opaque_mode(config):
        raise ValueError("This native switchport mode must be edited in Packet Tracer.")
    if kind != "switch" or after.get("routed"):
        return []
    commands = []
    if before.get("mode") != after.get("mode") or converting:
        commands.append((MODE, "switchport mode " + after["mode"].replace("-", " ")))
    if before.get("nonegotiate") != after.get("nonegotiate") or converting:
        commands.append(
            (
                NEGOTIATION,
                "switchport nonegotiate" if after.get("nonegotiate") else None,
            )
        )
    return commands
