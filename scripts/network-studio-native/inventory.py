"""Insert wired chassis into an existing physical workspace and retire unused ones."""

from uuid import NAMESPACE_URL, uuid5
import math
import re
from documents import child


def home_rack(root):
    workspace = root.find("PHYSICALWORKSPACE")
    if workspace is not None:
        home = (workspace.findtext("HOMERACK") or "").split(",")[-1].casefold()
        for node in workspace.iter("NODE"):
            if (node.findtext("UUID_STR") or "").casefold() != home:
                continue
            if node.findtext("TYPE") == "4":
                return node
            for rack in node.iterfind("CHILDREN/NODE"):
                if rack.findtext("TYPE") == "4":
                    return rack
    raise ValueError(
        "This native workspace has no home rack available for a new chassis."
    )


def insert_devices(root, added, deleted, endpoints, refs):
    if not added:
        return
    # Defer this import because new chassis and document editing share the
    # same native interface writer.
    from author import network
    from editing import located_leaf

    parent = root.find("NETWORK/DEVICES")
    rack = home_rack(root)
    children = rack.find("CHILDREN")
    if children is None or parent is None:
        raise ValueError("Missing native rack or inventory.")
    path = [
        n.findtext("UUID_STR") for n in reversed([rack, *rack.iterancestors("NODE")])
    ]
    if not all(path):
        raise ValueError("The native home rack has an incomplete physical path.")
    cluster = root.findtext("CLUSTERS/ROOTCLUSTER/CLUSTERID")
    names = {
        n.findtext("ENGINE/NAME") for n in parent.findall("DEVICE") if n not in deleted
    }
    used = {
        element.text.casefold()
        for element in root.iter()
        if element.text and len(element.text) < 90
    }

    def identity(key, render):
        for nonce in range(1000):
            digest = uuid5(
                NAMESPACE_URL, "/".join(("CertSim", path[-1], key, str(nonce)))
            )
            value = render(digest)
            if value.casefold() not in used:
                used.add(value.casefold())
                return value
        raise ValueError("Could not allocate a unique native device identifier.")

    # Generate only the new hardware. All existing native objects stay in
    # their original XML tree, including physical locations and module slots.
    donor, donor_ends = network(
        dict(version=1, name="New devices", devices=added, links=[])
    )
    positions = [float(n.findtext("X") or 0) for n in children.findall("NODE")]
    next_x = max([0, *[v for v in positions if math.isfinite(v)]]) + 6
    for device, node in zip(
        added, donor.findall("NETWORK/DEVICES/DEVICE"), strict=True
    ):
        if device["name"] in names:
            raise ValueError(
                "A device with that display name already exists in the native document."
            )
        names.add(device["name"])
        key = device["id"]
        engine = node.find("ENGINE")
        old_ref = engine.findtext("SAVE_REF_ID")
        new_ref = identity(
            key + "/device", lambda u: "save-ref-id:" + str(u.int & ((1 << 64) - 1))
        )
        leaf = located_leaf(donor, node)
        if leaf is None:
            raise ValueError("Could not locate the generated physical chassis.")
        new_uuid = identity(key + "/location", lambda u: "{" + str(u) + "}")
        physical = node.find("WORKSPACE/PHYSICAL_CPUR")
        child(node.find("WORKSPACE"), "PHYSICAL", ",".join([*path, new_uuid]))
        child(physical, "PARENT_PATH", ",".join(path[:-1]))
        child(physical, "CONTAINER_ID", path[-1])
        child(physical, "ORIGINAL_DEVICE_UUID", new_uuid)
        child(physical, "X", next_x)
        child(leaf, "X", next_x)
        child(leaf, "UUID_STR", new_uuid)
        next_x += 6
        logical = node.find("WORKSPACE/LOGICAL")
        if cluster:
            child(logical, "DEVCLUSTERID", cluster)
        for tag in ("MEM_ADDR", "DEV_ADDR"):
            child(
                logical,
                tag,
                identity(key + "/" + tag, lambda u: str(1 + (u.int % 2147483646))),
            )
        # Map equal hardware addresses consistently wherever the new chassis
        # repeats them. Never reuse a donor's MAC on an existing LAN.
        replace = {old_ref: new_ref}
        for field in engine.iter("MACADDRESS", "BIA"):
            if field.text and field.text not in replace:

                def mac(u):
                    value = "02" + u.hex[:10]
                    return ".".join(value[i : i + 4] for i in (0, 4, 8))

                replace[field.text] = identity(key + "/" + field.text, mac)
        for field in engine.iter():
            if field.text in replace:
                field.text = replace[field.text]
        children.append(leaf)
        parent.append(node)
        refs[key] = new_ref
        for port in device["ports"]:
            mapped = donor_ends.get((key, port["id"]))
            if mapped:
                endpoints[key, port["id"]] = (new_ref, mapped[1])


def remove_devices(root, deleted):
    from editing import located_leaf

    retired = set()
    for node in deleted:
        retired.add(node.findtext("ENGINE/SAVE_REF_ID"))
        leaf = located_leaf(root, node)
        if leaf is not None:
            retired.add(leaf.findtext("UUID_STR"))
            leaf.getparent().remove(leaf)
        node.getparent().remove(node)
    if not retired:
        return
    retired.discard(None)
    tokens = re.compile(r"save-ref-id:\d+|\{[0-9a-fA-F-]{36}\}")

    def uses_retired(value):
        return bool(
            value
            and (
                value in retired
                or (
                    ("save-ref-id:" in value or "{" in value)
                    and any(m.group() in retired for m in tokens.finditer(value))
                )
            )
        )

    if any(
        uses_retired(e.text) or any(uses_retired(v) for v in e.attrib.values())
        for e in root.iter()
    ):
        raise ValueError(
            "A retained native object still uses the removed device. Remove that connection in Packet Tracer before saving."
        )
