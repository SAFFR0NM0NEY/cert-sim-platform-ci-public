"""Resolve the root logical workspace background against in-memory PKZ members."""

from lxml import etree as X

from packages import member_path_key


CLUSTER = "CLUSTERS/ROOTCLUSTER"
IMAGE = "CLUSTER_BG_IMAGE"
EMBEDDED = "CLUSTER_EMBEDDED_BG_IMAGE"
TILED = "TILED_BG"
PNG = b"\x89PNG\r\n\x1a\n"
JPEG = b"\xff\xd8\xff"


def _raster(name, resources):
    data = resources.get(name)
    if data is None:
        return False
    if name.lower().endswith(".png"):
        return data.startswith(PNG)
    return name.lower().endswith((".jpg", ".jpeg")) and data.startswith(JPEG)


def _member(path, resources):
    # A package network is at the archive root. Resolve only relative names
    # present in the package; never probe an external source path.
    path = path.replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    try:
        key = member_path_key(path)
    except ValueError:
        return None
    if path in resources:
        return path if _raster(path, resources) else None
    for name in resources:
        if member_path_key(name) == key and _raster(name, resources):
            return name
    return None


def read_background(root, resources):
    cluster = root.find(CLUSTER)
    if cluster is None:
        return None
    image = cluster.find(IMAGE)
    embedded = cluster.find(EMBEDDED)
    if (
        image is None
        or not image.text
        or image.get("isanim", "false") != "false"
        or (embedded is not None and (len(embedded) or (embedded.text or "").strip()))
    ):
        return None
    name = _member(image.text, resources)
    if name is None:
        return None
    return {"name": name, "tiled": cluster.findtext(TILED) == "true"}


def _field(parent, tag):
    node = parent.find(tag)
    return node if node is not None else X.SubElement(parent, tag)


def set_background(root, resources, setting):
    if root.tag != "PACKETTRACER5":
        raise ValueError("Choose the current logical network for its background.")
    if setting is not None and (
        not isinstance(setting, dict)
        or not isinstance(setting.get("name"), str)
        or not isinstance(setting.get("tiled"), bool)
        or _member(setting["name"], resources) != setting["name"]
    ):
        raise ValueError("Choose a bundled PNG or JPEG for the canvas background.")
    current = read_background(root, resources)
    if current == setting:
        return False
    cluster = root.find(CLUSTER)
    if cluster is None:
        cluster = _field(_field(root, "CLUSTERS"), "ROOTCLUSTER")
    image = _field(cluster, IMAGE)
    if setting is None or current is None or current["name"] != setting["name"]:
        image.text = setting["name"] if setting else None
        image.set("isanim", "false")
        # Explicit replacement of the background supersedes its embedded
        # representation. Leave cluster icons and other cluster fields alone.
        embedded = cluster.find(EMBEDDED)
        if embedded is not None:
            embedded.text = None
            for child in list(embedded):
                embedded.remove(child)
    _field(cluster, TILED).text = "true" if setting and setting["tiled"] else "false"
    return True
