"""Native container I/O and inert learner-facing views of Packet Tracer documents."""

from html.parser import HTMLParser
import re
import zlib
from lxml import etree as X
from pkt_core import decode_bytes, encode_bytes
from pkt_core.codec import container
from pkt_core.errors import IntegrityError, TruncatedFileError

MAX_FILE = 8 * 1024 * 1024
MAX_XML = 48 * 1024 * 1024
NETWORK = "PACKETTRACER5"
ACTIVITY = "PACKETTRACER5_ACTIVITY"


def limited_inflate(data):
    size = int.from_bytes(data[:4], "big")
    if len(data) < 5 or not 0 < size <= MAX_XML:
        raise ValueError("Native workspace exceeds the 48 MiB expanded limit.")
    stream = zlib.decompressobj()
    result = stream.decompress(data[4:], size + 1)
    if len(result) != size or not stream.eof or stream.unused_data:
        raise ValueError("Invalid compressed Packet Tracer workspace.")
    return result


# The pinned codec has a process-wide inflate hook. Install once in this
# dedicated helper to enforce its allocation limit before parsing any file.
container.quncompress = limited_inflate


def read_container(raw, fmt):
    if len(raw) > MAX_FILE or not raw:
        raise ValueError("Select a native file up to 8 MiB.")
    try:
        try:
            decoded = decode_bytes(raw, "pkt")
        except (IntegrityError, TruncatedFileError):
            # Pre-5.3.3 files use a separate qCompress container. Its
            # declared size, zlib checksum and complete stream must validate.
            decoded = decode_bytes(raw, "legacy")
        data = decoded.xml
        parser = X.XMLParser(
            resolve_entities=False,
            load_dtd=False,
            no_network=True,
            strip_cdata=False,
            remove_comments=False,
        )
        root = X.fromstring(data, parser)
    except Exception as exc:
        raise ValueError(
            "Unable to read this Packet Tracer file. Check its format, size and integrity."
        ) from exc
    if root.getroottree().docinfo.doctype or root.tag != {
        "pkt": NETWORK,
        "pka": ACTIVITY,
    }.get(fmt):
        raise ValueError("The native document does not match the selected file type.")
    if fmt == "pka" and len(root.findall(NETWORK)) != 3:
        raise ValueError(
            "The activity does not have the expected three network states."
        )
    if decoded.format_name == "legacy":
        version = root.findtext("VERSION") or ""
        if not re.fullmatch(r"[45]\.\d+(?:\.\d+){0,2}", version) or tuple(
            map(int, version.split(".")[:3])
        ) >= (5, 3, 3):
            raise ValueError("Unrecognized legacy Packet Tracer document version.")
    return root, decoded.format_name


def open_document(raw, fmt):
    return read_container(raw, fmt)[0]


def restricted_activity(root):
    if root.tag != ACTIVITY:
        return False
    locks = root.find("LOCKINGTREE")
    settings = root.find("ACTIVITY")
    return (
        locks is None
        or any(node.get("on", "no") != "no" for node in locks.iter("NODE"))
        or settings is None
        or settings.get("ENABLED") == "yes"
        or bool(settings.get("PASS"))
        or root.findtext("USER_PROFILE_LOCKED") == "true"
        or root.findtext("USER_PROFILE_NOGUEST") == "true"
    )


def save_document(root, encoding="pkt"):
    data = X.tostring(root.getroottree(), encoding="UTF-8")
    if len(data) > MAX_XML:
        raise ValueError("Native workspace exceeds the expanded file limit.")
    raw = encode_bytes(data, encoding)
    if len(raw) > MAX_FILE:
        raise ValueError("Native workspace exceeds the 8 MiB save limit.")
    return raw


def current_network(root):
    return root if root.tag == NETWORK else root.find(NETWORK)


class Instructions(HTMLParser):
    def __init__(self):
        super().__init__()
        self.lines = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("head", "script", "style"):
            self.hidden += 1
        elif tag in ("p", "br", "div", "li", "tr", "h1", "h2", "h3"):
            self.lines.append("\n")

    def handle_endtag(self, tag):
        if tag in ("head", "script", "style"):
            self.hidden = max(0, self.hidden - 1)
        elif tag in ("p", "div", "li", "tr"):
            self.lines.append("\n")

    def handle_data(self, data):
        if not self.hidden:
            self.lines.append(data)


def plain_text(html):
    reader = Instructions()
    reader.feed(html)
    reader.close()
    return "\n".join(
        line.strip() for line in "".join(reader.lines).splitlines() if line.strip()
    )


def activity_pages(root):
    pages = []
    for page in root.findall("ACTIVITY/INSTRUCTIONS/PAGE"):
        pages.append(plain_text("".join(page.itertext()))[:12000])
    return pages[:24]


def child(parent, tag, value):
    field = parent.find(tag)
    if field is None:
        field = X.SubElement(parent, tag)
    field.text = str(value)
    return field
