"""Regression cases for native PKZ package I/O using synthetic content."""

from io import BytesIO
import stat
import struct
import unittest
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile, ZipInfo
import zlib

from packages import read_package, write_package


def archive_of(entries):
    buffer = BytesIO()
    with ZipFile(buffer, "w", ZIP_DEFLATED) as archive:
        archive.comment = b"Training LAN"
        for name, content in entries:
            archive.writestr(name, content)
    return buffer.getvalue()


class NativePackages(unittest.TestCase):
    def test_document_and_resource_bytes_round_trip(self):
        for fmt in ("pkt", "pka"):
            with self.subTest(fmt=fmt):
                name = f"Lab.{fmt}"
                resources = {"diagram.bin": b"\x00\xff\x04", "notes.txt": b"hello"}
                raw = write_package(name, b"native document", resources)
                package = read_package(raw)
                self.assertEqual(package.document_name, name)
                self.assertEqual(package.format, fmt)
                self.assertEqual(package.document, b"native document")
                self.assertEqual(package.resources, resources)

    def test_requires_supported_document(self):
        for name in ("lab.xml", "lab.pkz", "", "lab"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                write_package(name, b"native document")

    def test_selects_first_named_root_document_and_preserves_others(self):
        raw = archive_of(
            [
                ("notes.txt", b"notes"),
                ("z-extra.pka", b"other activity"),
                ("nested/00-sample.pkt", b"other network"),
                ("a-lab.pkt", b"primary"),
            ]
        )
        package = read_package(raw)
        self.assertEqual(package.document_name, "a-lab.pkt")
        self.assertEqual(package.document, b"primary")
        edited = write_package(
            package.document_name, b"edited", package.resources, original=package
        )
        reopened = read_package(edited)
        self.assertEqual(reopened.document, b"edited")
        self.assertEqual(reopened.resources, package.resources)
        self.assertEqual(reopened.resources["z-extra.pka"], b"other activity")

    def test_cannot_silently_change_primary_by_attaching_another_document(self):
        with self.assertRaisesRegex(ValueError, "change which"):
            write_package("network.pkt", b"doc", {"activity.pka": b"another doc"})

    def test_requires_root_document_and_unambiguous_order(self):
        for entries in (
            [("only/nested.pkt", b"nested")],
            [("a.pkt", b"one"), ("Z.pkt", b"two")],
            [("accent\u00e9.pkt", b"one"), ("another.pka", b"two")],
        ):
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                read_package(archive_of(entries))

    def test_rejects_ambiguous_or_unsafe_members(self):
        for name in ("Lab.PKT", "../out", "C:/notes.txt", "notes.txt:stream", "NUL"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                write_package("lab.pkt", b"native document", {name: b"asset"})

    def test_rejects_truncation_and_trailing_content(self):
        raw = write_package("lab.pkt", b"document", {"notes.txt": b"notes"})
        for damaged in (b"", raw[:-1], raw + b"trailing", b"some other format"):
            with self.subTest(length=len(damaged)), self.assertRaises(ValueError):
                read_package(damaged)

    def test_refuses_oversized_package_before_reading_members(self):
        with self.assertRaises(ValueError):
            read_package(bytes(8 * 1024 * 1024 + 1))

    def test_empty_resource_is_valid(self):
        raw = write_package("activity.pka", b"activity", {"empty.txt": b""})
        self.assertEqual(read_package(raw).resources, {"empty.txt": b""})

    def test_edit_preserves_resource_paths_directories_order_and_comments(self):
        note = ZipInfo("assets/caf\u00e9.txt", (2020, 9, 4, 12, 1, 0))
        note.compress_type = ZIP_STORED
        note.comment = b"Installer handout"
        raw = archive_of(
            [
                ("lab.pkt", b"network"),
                ("assets/", b""),
                (note, b"caf\xc3\xa9"),
                ("empty-folder/", b""),
                ("diagram.bin", bytes(range(256))),
            ]
        )
        original = read_package(raw)
        self.assertEqual(
            list(original.resources), ["assets/caf\u00e9.txt", "diagram.bin"]
        )
        edited = write_package(
            "lab.pkt", b"edited", original.resources, original=original
        )
        with ZipFile(BytesIO(raw)) as before, ZipFile(BytesIO(edited)) as after:
            self.assertEqual(before.namelist(), after.namelist())
            self.assertEqual(before.comment, after.comment)
            for name in before.namelist():
                a, b = before.getinfo(name), after.getinfo(name)
                self.assertEqual(
                    (a.compress_type, a.date_time, a.comment),
                    (b.compress_type, b.date_time, b.comment),
                )
                expected = b"edited" if name == "lab.pkt" else before.read(name)
                self.assertEqual(after.read(name), expected)

    def test_rejects_collisions_and_non_files_on_import(self):
        symlink = ZipInfo("link.txt")
        symlink.create_system = 3
        symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
        for assets in (
            [("D/A", b"a"), ("d/a", b"b")],
            [("icons", b"a"), ("icons/x", b"b")],
            [("icons/x", b"a"), ("icons", b"b")],
            [("icons/../bg.png", b"b")],
            [(symlink, b"notes.txt")],
        ):
            with self.subTest(assets=assets), self.assertRaises(ValueError):
                read_package(archive_of([("lab.pkt", b"document"), *assets]))

    def test_rejects_forged_size_even_if_declared_prefix_crc_matches(self):
        raw = bytearray(archive_of([("lab.pkt", b"abcd" * 1000)]))
        central = raw.index(b"PK\x01\x02")
        for offset in (14, central + 16):
            struct.pack_into("<I", raw, offset, zlib.crc32(b"abcd"))
        for offset in (22, central + 24):
            struct.pack_into("<I", raw, offset, 4)
        with self.assertRaises(ValueError):
            read_package(bytes(raw))

    def test_limits_entry_count_and_declared_expanded_size(self):
        entries = [("lab.pkt", b"document")] + [(f"{i}.txt", b"") for i in range(256)]
        with self.assertRaises(ValueError):
            read_package(archive_of(entries))
        raw = bytearray(archive_of([("lab.pkt", b"document")]))
        central = raw.index(b"PK\x01\x02")
        struct.pack_into("<I", raw, central + 24, 8 * 1024 * 1024 + 1)
        with self.assertRaises(ValueError):
            read_package(bytes(raw))
