"""Bounded native HTTP text-page mapping; imported content is never executed."""

import re
from copy import deepcopy
from lxml import etree as X

OPAQUE = "This native HTTP layout or resource is not modeled; its source is preserved. Edit HTTP in Packet Tracer."
EMPTY = {"enabled": False, "pages": []}
MAX_PAGES = 16
MAX_BODY_BYTES = 16384
STATIC_SUFFIXES = {"html", "htm", "txt", "json", "xml", "css"}
FILE_TAGS = {"FILE_NUMBER", "NAME", "DATE_TIME", "PERMISSION", "FILE_CONTENT"}
FS_TAGS = FILE_TAGS | {"FILES", "FILE_COUNTER", "CAPACITY"}


def _shape(node, tags, attributes=None):
    if node is None or dict(node.attrib) != (attributes or {}):
        raise ValueError(OPAQUE)
    names = [c.tag for c in node]
    if len(names) != len(set(names)) or set(names) != tags:
        raise ValueError(OPAQUE)
    if (node.text or "").strip() or any((c.tail or "").strip() for c in node):
        raise ValueError(OPAQUE)


def _leaf(node, tag):
    child = node.find(tag)
    if child is None or child.attrib or len(child):
        raise ValueError(OPAQUE)
    return child.text or ""


def _integer(node, tag, minimum=0):
    value = _leaf(node, tag)
    if not re.fullmatch(r"[0-9]+", value):
        raise ValueError(OPAQUE)
    number = int(value)
    if number < minimum:
        raise ValueError(OPAQUE)
    return number


def _empty(node):
    if node is None or node.attrib or len(node) or (node.text or "").strip():
        raise ValueError(OPAQUE)


def _filename(path):
    if not isinstance(path, str) or len(path) > 180 or not re.fullmatch(r"/[A-Za-z0-9_.~-]*", path):
        raise ValueError("Native HTTP supports flat text-page paths such as '/' and '/status'; use CertSim JSON for directories.")
    name = "index.html" if path == "/" else path[1:]
    if name in (".", "..") or ("." in name and name.rsplit(".", 1)[1].lower() not in STATIC_SUFFIXES):
        raise ValueError("Native HTTP supports extensionless pages and .html, .htm, .txt, .json, .xml or .css text files; other resources stay opaque.")
    return name


def _body(value):
    if not isinstance(value, str) or len(value.encode("utf-8")) > MAX_BODY_BYTES:
        raise ValueError("Native HTTP page bodies must be text of at most 16384 UTF-8 bytes.")
    # XML 1.0 cannot store NUL or other forbidden control characters.
    if any(not (c in "\t\n\r" or 0x20 <= ord(c) <= 0xD7FF or 0xE000 <= ord(c) <= 0xFFFD or 0x10000 <= ord(c) <= 0x10FFFF) for c in value):
        raise ValueError("Native HTTP page bodies must contain XML-compatible text.")
    return value


def validate(value):
    """Validate the independently editable HTTP subset; canonicalize root alias."""
    if not isinstance(value, dict) or value.keys() != {"enabled", "pages"} or type(value["enabled"]) is not bool:
        raise ValueError("Native HTTP requires a boolean enable setting and text-page list.")
    pages = value["pages"]
    if not isinstance(pages, list) or len(pages) > MAX_PAGES:
        raise ValueError("Native HTTP supports at most 16 text pages.")
    result, names = [], set()
    for page in pages:
        if not isinstance(page, dict) or page.keys() != {"path", "body"}:
            raise ValueError("Native HTTP pages require a path and body.")
        name = _filename(page["path"])
        if name in names:
            raise ValueError("Native HTTP page names must be unique; '/' and '/index.html' refer to the same native file.")
        names.add(name)
        result.append({"path": "/" if name == "index.html" else "/" + name, "body": _body(page["body"])})
    return {"enabled": value["enabled"], "pages": result}


def _server(engine, fresh=False):
    if (engine.findtext("TYPE") or "").lower() != "server":
        raise ValueError(OPAQUE)
    servers = engine.findall("HTTP_SERVER")
    if len(servers) != 1:
        raise ValueError(OPAQUE)
    server = servers[0]
    _shape(server, {"ENABLED", "USERNAME", "PASSWORD"})
    if _leaf(server, "ENABLED") not in ("0", "1"):
        raise ValueError(OPAQUE)
    credentials = [_leaf(server, tag) for tag in ("USERNAME", "PASSWORD")]
    if not fresh and any(credentials):
        raise ValueError(OPAQUE)
    return server


def _stores(engine):
    managers = engine.findall("FILE_MANAGER")
    if not 1 <= len(managers) <= 2:
        raise ValueError(OPAQUE)
    result = []
    for manager in managers:
        _shape(manager, {"FILE"})
        root = manager.find("FILE")
        _shape(root, FILE_TAGS | {"FILES"}, {"class": "CDirectory"})
        if _integer(root, "FILE_NUMBER") != 0 or _leaf(root, "NAME") != "":
            raise ValueError(OPAQUE)
        _integer(root, "DATE_TIME")
        if _leaf(root, "PERMISSION") != "6":
            raise ValueError(OPAQUE)
        _empty(root.find("FILE_CONTENT"))
        files = root.find("FILES")
        if files.attrib or (files.text or "").strip() or any(c.tag != "FILE" or (c.tail or "").strip() for c in files):
            raise ValueError(OPAQUE)
        # Other filesystems are retained verbatim, including their own ID counters.
        matches = [f for f in files if f.findtext("NAME") == "http:"]
        if len(matches) != 1:
            raise ValueError(OPAQUE)
        fs = matches[0]
        _shape(fs, FS_TAGS, {"class": "CFileSystem"})
        if _integer(fs, "FILE_NUMBER") != 0 or _leaf(fs, "NAME") != "http:":
            raise ValueError(OPAQUE)
        _integer(fs, "DATE_TIME")
        if _leaf(fs, "PERMISSION") != "6":
            raise ValueError(OPAQUE)
        _empty(fs.find("FILE_CONTENT"))
        _integer(fs, "FILE_COUNTER")
        _integer(fs, "CAPACITY", 1)
        listing = fs.find("FILES")
        if listing.attrib or (listing.text or "").strip() or any(c.tag != "FILE" or (c.tail or "").strip() for c in listing):
            raise ValueError(OPAQUE)
        result.append(fs)
    return result


def _signature(node):
    """Compare mirrored stores without treating XML indentation as authority."""
    return (node.tag, tuple(sorted(node.attrib.items())), node.text if not len(node) else None, tuple(_signature(c) for c in node))


def _read(engine):
    server, stores = _server(engine), _stores(engine)
    signatures = [_signature(fs) for fs in stores]
    if any(signature != signatures[0] for signature in signatures[1:]):
        raise ValueError(OPAQUE)
    fs, pages, numbers = stores[0], [], set()
    files = fs.find("FILES")
    if len(files) > MAX_PAGES:
        raise ValueError(OPAQUE)
    for raw in files:
        _shape(raw, FILE_TAGS, {"class": "CFile"})
        number = _integer(raw, "FILE_NUMBER", 1)
        if number in numbers:
            raise ValueError(OPAQUE)
        numbers.add(number)
        _integer(raw, "DATE_TIME")
        if _leaf(raw, "PERMISSION") != "6":
            raise ValueError(OPAQUE)
        name = _leaf(raw, "NAME")
        # A native slash-prefixed name is not a relative HTTP file name.
        if not name or _filename("/" + name) != name:
            raise ValueError(OPAQUE)
        content = raw.find("FILE_CONTENT")
        _shape(content, {"TEXT"}, {"class": "CHttpPage"})
        pages.append({"path": "/" if name == "index.html" else "/" + name, "body": _leaf(content, "TEXT")})
    if _integer(fs, "FILE_COUNTER") < max(numbers, default=0):
        raise ValueError(OPAQUE)
    value = validate({"enabled": _leaf(server, "ENABLED") == "1", "pages": pages})
    _capacity(stores, value)
    return value, server, stores


def project(engine):
    """Opaque HTTP never prevents the coordinator from projecting other services."""
    try:
        value, _, _ = _read(engine)
        return value, False
    except (ValueError, TypeError, OverflowError):
        return None, True


def _capacity(stores, value):
    size = sum(len(page["body"].encode("utf-8")) for page in value["pages"])
    if any(size > _integer(fs, "CAPACITY", 1) for fs in stores):
        raise ValueError("Native HTTP page text exceeds the source filesystem capacity.")


def _new_page(name, body, number):
    raw = X.Element("FILE", {"class": "CFile"})
    for tag, value in (("FILE_NUMBER", str(number)), ("NAME", name), ("DATE_TIME", "0"), ("PERMISSION", "6")):
        X.SubElement(raw, tag).text = value
    content = X.SubElement(raw, "FILE_CONTENT", {"class": "CHttpPage"})
    X.SubElement(content, "TEXT").text = body
    return raw


def _write(server, stores, value, fresh=False):
    _capacity(stores, value)
    for fs in stores:
        listing = fs.find("FILES")
        existing = {} if fresh else {raw.findtext("NAME"): raw for raw in listing}
        counter = 0 if fresh else _integer(fs, "FILE_COUNTER")
        replacement = []
        for page in value["pages"]:
            name = _filename(page["path"])
            raw = existing.get(name)
            if raw is not None:
                raw = deepcopy(raw)
                text = raw.find("FILE_CONTENT/TEXT")
                if (text.text or "") != page["body"]:
                    text.text = page["body"]
            else:
                counter += 1
                raw = _new_page(name, page["body"], counter)
            replacement.append(raw)
        for raw in list(listing):
            listing.remove(raw)
        listing.extend(replacement)
        if fresh or counter != _integer(fs, "FILE_COUNTER"):
            fs.find("FILE_COUNTER").text = str(counter)
    enabled = "1" if value["enabled"] else "0"
    if server.findtext("ENABLED") != enabled:
        server.find("ENABLED").text = enabled


def authored(engine, value):
    """Replace only a fresh donor's HTTP pages; never call this for imports."""
    normalized = validate(value)
    server, stores = _server(engine, fresh=True), _stores(engine)
    # A fresh template may contain resources outside the supported projection.
    _write(server, stores, normalized, fresh=True)
    for tag in ("USERNAME", "PASSWORD"):
        server.find(tag).text = ""
    for https in engine.findall("HTTPS_SERVER"):
        enabled = https.find("HTTPSENABLED")
        if enabled is not None:
            enabled.text = "0"


def update(engine, beforevalue, aftervalue):
    """Preserve opaque/native bytes on no-op, guard edits before any mutation."""
    if beforevalue == aftervalue:
        return
    after = validate(aftervalue)
    before = validate(beforevalue)
    if before == after:
        return
    try:
        previous, server, stores = _read(engine)
    except (ValueError, TypeError, OverflowError):
        raise ValueError(OPAQUE) from None
    if before != previous:
        raise ValueError("The native HTTP projection no longer matches the source; import it again before editing.")
    _write(server, stores, after)
