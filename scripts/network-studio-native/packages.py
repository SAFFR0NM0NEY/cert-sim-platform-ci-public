"""Read and write Packet Tracer packages entirely in memory."""

from copy import copy
from dataclasses import dataclass, field
from datetime import datetime
from io import BytesIO
import stat
import struct
import unicodedata
from zipfile import BadZipFile, ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo
import zlib

from documents import MAX_FILE

try:
    from ntpath import isreserved
except ImportError:  # Python 3.10–3.12
    from pathlib import PureWindowsPath

    def isreserved(name):
        return PureWindowsPath(name).is_reserved()


MAX_ENTRIES = 256
MAX_EXPANDED = 48 * 1024 * 1024


@dataclass(frozen=True)
class Package:
    document_name: str
    document: bytes
    resources: dict[str, bytes]
    _entries: tuple[ZipInfo, ...] = field(default=(), repr=False)
    _comment: bytes = field(default=b"", repr=False)

    @property
    def format(self):
        return self.document_name.rsplit(".", 1)[-1].lower()


def member_path_key(name):
    # Package members may be opened later on a different operating system.
    # Match paths case-insensitively and reject ambiguous Windows spellings.
    if not isinstance(name, str) or not name or len(name) > 1024:
        raise ValueError("Invalid PKZ member name.")
    parts = name.replace("\\", "/").split("/")
    for part in parts:
        if (
            not part
            or part.endswith((".", " "))
            or any(ord(c) < 32 or c in '<>:"|?*' for c in part)
            or isreserved(part)
        ):
            raise ValueError("Invalid PKZ member path.")
    return unicodedata.normalize("NFC", "/".join(parts)).casefold()


def _check_directory(raw):
    # Check the actual central directory count before ZipFile allocates a
    # ZipInfo for every record. Small native packages use classic ZIP.
    end = raw.rfind(b"PK\x05\x06", max(0, len(raw) - 65557))
    if end < 0 or end + 22 > len(raw):
        raise ValueError("Invalid PKZ archive directory.")
    disk, start_disk, local, count, size, offset, comment = struct.unpack_from(
        "<4H2IH", raw, end + 4
    )
    if (
        disk
        or start_disk
        or not 0 < count <= MAX_ENTRIES
        or count != local
        or end + 22 + comment != len(raw)
        or offset + size != end
    ):
        raise ValueError("Invalid or oversized PKZ archive directory.")
    for _ in range(count):
        if offset + 46 > end or raw[offset : offset + 4] != b"PK\x01\x02":
            raise ValueError("Invalid PKZ member record.")
        lengths = struct.unpack_from("<3H", raw, offset + 28)
        offset += 46 + sum(lengths)
    if offset != end:
        raise ValueError("Invalid PKZ member count.")


def _validate_names(entries):
    files, directories, explicit = set(), set(), set()
    for name, is_dir in entries:
        key = member_path_key(name[:-1] if is_dir else name)
        if key in explicit or (not is_dir and key in directories):
            raise ValueError("PKZ member paths conflict.")
        explicit.add(key)
        parts = key.split("/")
        parents = {"/".join(parts[:i]) for i in range(1, len(parts))}
        if parents & files:
            raise ValueError("PKZ member paths conflict.")
        directories.update(parents)
        (directories if is_dir else files).add(key)


def _read_member(raw, archive, info):
    if info.flag_bits & 1 or info.compress_type not in (ZIP_STORED, ZIP_DEFLATED):
        raise ValueError("Unsupported PKZ member compression or encryption.")
    kind = stat.S_IFMT(info.external_attr >> 16) if info.create_system == 3 else 0
    if kind not in (0, stat.S_IFDIR if info.is_dir() else stat.S_IFREG):
        raise ValueError("A PKZ member is not an ordinary file or directory.")
    if info.file_size > MAX_FILE or (info.is_dir() and info.file_size):
        raise ValueError("PKZ member exceeds the size limit or has an invalid size.")
    # ZipFile checks local names and overlapping member ranges. Verify the
    # actual DEFLATE end as well. ZipExtFile alone can stop at a forged size.
    with archive.open(info):
        offset = info.header_offset
        flags, compression = struct.unpack_from("<2H", raw, offset + 6)
        name_length, extra_length = struct.unpack_from("<2H", raw, offset + 26)
        if flags != info.flag_bits or compression != info.compress_type:
            raise ValueError("PKZ member headers disagree.")
        start = offset + 30 + name_length + extra_length
        compressed = memoryview(raw)[start : start + info.compress_size]
        if info.compress_type == ZIP_DEFLATED:
            stream = zlib.decompressobj(-zlib.MAX_WBITS)
            data = stream.decompress(compressed, info.file_size + 1)
            if not stream.eof or stream.unused_data:
                raise ValueError("Invalid compressed PKZ member.")
        else:
            data = bytes(compressed)
    if len(data) != info.file_size or zlib.crc32(data) != info.CRC:
        raise ValueError("Damaged PKZ member.")
    return data


def _format(name):
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def _primary(names):
    # Desktop 9.0.1 selects the alphabetically first root-level PKT or PKA,
    # independent of ZIP order, file type or matching the archive's stem.
    candidates = [
        n
        for n in names
        if "/" not in n and "\\" not in n and _format(n) in ("pkt", "pka")
    ]
    if not candidates:
        raise ValueError("The PKZ needs a PKT or PKA in its top-level folder.")
    if len(candidates) == 1:
        return candidates[0]
    first = min(candidates)
    if (
        not all(n.isascii() for n in candidates)
        or min(candidates, key=str.lower) != first
    ):
        raise ValueError(
            "Cannot determine which root PKT or PKA opens for these names."
        )
    return first


def read_package(raw):
    if not raw or len(raw) > MAX_FILE:
        raise ValueError("Select a PKZ package up to 8 MiB.")
    _check_directory(raw)
    try:
        with ZipFile(BytesIO(raw), "r") as archive:
            entries = archive.infolist()
            if sum(info.file_size for info in entries) > MAX_EXPANDED:
                raise ValueError("PKZ package exceeds the 48 MiB expanded limit.")
            names = [info.orig_filename.replace("\\", "/") for info in entries]
            _validate_names((n, n.endswith("/")) for n in names)
            document_name = _primary(names)
            members = {}
            for name, info in zip(names, entries):
                data = _read_member(raw, archive, info)
                if not name.endswith("/"):
                    members[name] = data
            document = members.pop(document_name)
            if not document:
                raise ValueError("The PKZ contains an empty native document.")
            return Package(
                document_name, document, members, tuple(entries), archive.comment
            )
    except (BadZipFile, RuntimeError, zlib.error, struct.error, EOFError) as exc:
        raise ValueError("Unable to read this PKZ package.") from exc


def write_package(document_name, document, resources=None, *, original=None):
    if _format(document_name) not in ("pkt", "pka") or not document:
        raise ValueError("Choose a PKT or PKA document for the package.")
    resources = resources if resources is not None else {}
    if len(resources) >= MAX_ENTRIES:
        raise ValueError("PKZ packages support up to 256 members.")
    if document_name in resources:
        raise ValueError("PKZ member paths conflict.")
    members = {document_name: document, **resources}
    _validate_names((n, False) for n in members)
    members = {n.replace("\\", "/"): data for n, data in members.items()}
    if _primary(members) != document_name:
        raise ValueError("A package attachment would change which PKT or PKA opens.")
    existing = {}
    if original:
        existing = {
            info.orig_filename.replace("\\", "/"): info for info in original._entries
        }
    order = [n for n in existing if n in members or n.endswith("/")]
    order.extend(n for n in members if n not in existing)
    if len(order) > MAX_ENTRIES:
        raise ValueError("PKZ packages support up to 256 members.")
    _validate_names((n, n not in members) for n in order)
    if any(len(data) > MAX_FILE for data in members.values()):
        raise ValueError("Each PKZ member must be at most 8 MiB.")
    if sum(map(len, members.values())) > MAX_EXPANDED:
        raise ValueError("PKZ package exceeds the 48 MiB expanded limit.")
    buffer = BytesIO()
    timestamp = datetime.now().timetuple()[:6]
    with ZipFile(buffer, "w", allowZip64=False) as archive:
        if original:
            archive.comment = original._comment
        for name in order:
            if name in existing:
                info = copy(existing[name])
                # Do not reproduce optional path overrides in third-party ZIP
                # extra fields. The stored member name is the validated path.
                info.extra = b""
                info.filename = info.orig_filename = name
            else:
                info = ZipInfo(name, timestamp)
                info.create_system = 0
                info.compress_type = ZIP_DEFLATED
            archive.writestr(info, members.get(name, b""))
            if buffer.tell() > MAX_FILE:
                raise ValueError("PKZ package exceeds the 8 MiB save limit.")
    if buffer.tell() > MAX_FILE:
        raise ValueError("PKZ package exceeds the 8 MiB save limit.")
    return buffer.getvalue()
