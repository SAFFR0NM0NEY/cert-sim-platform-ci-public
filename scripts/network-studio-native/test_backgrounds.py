"""Synthetic root-canvas background interoperability cases."""

from base64 import b64decode
import unittest

from lxml import etree as X

from backgrounds import CLUSTER, EMBEDDED, IMAGE, TILED, read_background, set_background
from documents import current_network, open_document, save_document
from packages import read_package, write_package


PNG = b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nG"
    "NoAAAAggCBd81ytgAAAABJRU5ErkJggg=="
)
ASSETS = {"art/Plan.png": PNG, "image.JPEG": b"\xff\xd8\xff\xe0\x00\x10"}


def network(path="", tile=False):
    root = X.fromstring(
        b"<PACKETTRACER5><CLUSTERS><ROOTCLUSTER>"
        b"<CLUSTER_BG_IMAGE isanim='false'/><CLUSTER_EMBEDDED_BG_IMAGE/>"
        b"<CLUSTER_ICON_IMAGE>icon.png</CLUSTER_ICON_IMAGE><TILED_BG/>"
        b"</ROOTCLUSTER></CLUSTERS></PACKETTRACER5>"
    )
    cluster = root.find(CLUSTER)
    cluster.find(IMAGE).text = path
    cluster.find(TILED).text = str(tile).lower()
    return root


class NativeBackgrounds(unittest.TestCase):
    def test_resolves_bundled_relative_paths(self):
        for path in ("art/Plan.png", "./art/Plan.png", r"Art\plan.png"):
            with self.subTest(path=path):
                root = network(path, True)
                self.assertEqual(
                    read_background(root, ASSETS),
                    {"name": "art/Plan.png", "tiled": True},
                )
        self.assertEqual(
            read_background(network("image.JPEG"), ASSETS),
            {"name": "image.JPEG", "tiled": False},
        )

    def test_skips_external_missing_non_raster_and_embedded_references(self):
        other = {**ASSETS, "notes.png": b"<html>test</html>", "photo.svg": PNG}
        for path in (
            r"C:\scratch\art\Plan.png",
            "/art/Plan.png",
            "../art/Plan.png",
            "https://example.invalid/art/Plan.png",
            "missing.png",
            "notes.png",
            "photo.svg",
        ):
            with self.subTest(path=path):
                self.assertIsNone(read_background(network(path), other))
        for variant in ("embedded", "animated"):
            root = network("art/Plan.png")
            if variant == "embedded":
                root.find(CLUSTER).find(EMBEDDED).text = "opaque"
            else:
                root.find(CLUSTER).find(IMAGE).set("isanim", "true")
            before = X.tostring(root)
            self.assertIsNone(read_background(root, ASSETS))
            self.assertFalse(set_background(root, ASSETS, None))
            self.assertEqual(X.tostring(root), before)

    def test_change_only_tile_then_clear(self):
        root = network("./art/Plan.png", False)
        current = read_background(root, ASSETS)
        self.assertFalse(set_background(root, ASSETS, current))
        self.assertTrue(set_background(root, ASSETS, {**current, "tiled": True}))
        cluster = root.find(CLUSTER)
        self.assertEqual(cluster.findtext(IMAGE), "./art/Plan.png")
        self.assertEqual(cluster.findtext(TILED), "true")
        self.assertTrue(set_background(root, ASSETS, None))
        self.assertFalse(cluster.findtext(IMAGE))
        self.assertEqual(cluster.findtext("CLUSTER_ICON_IMAGE"), "icon.png")
        self.assertEqual(cluster.findtext(TILED), "false")

    def test_bad_setting_leaves_original_xml_intact(self):
        root = network("art/Plan.png")
        before = X.tostring(root)
        for setting in (
            {"name": "../art/Plan.png", "tiled": False},
            {"name": "missing.png", "tiled": True},
            {"name": "image.JPEG", "tiled": "true"},
        ):
            with self.subTest(setting=setting), self.assertRaises(ValueError):
                set_background(root, ASSETS, setting)
            self.assertEqual(X.tostring(root), before)

    def test_authored_pkz_and_current_activity_state_round_trip(self):
        activity = X.Element("PACKETTRACER5_ACTIVITY")
        for _ in range(3):
            activity.append(X.Element("PACKETTRACER5"))
        self.assertTrue(
            set_background(
                current_network(activity),
                ASSETS,
                {"name": "art/Plan.png", "tiled": True},
            )
        )
        raw = write_package("activity.pka", save_document(activity), ASSETS)
        package = read_package(raw)
        opened = open_document(package.document, package.format)
        self.assertEqual(
            read_background(current_network(opened), package.resources),
            {"name": "art/Plan.png", "tiled": True},
        )
        self.assertFalse(
            any(node.find(CLUSTER) is not None for node in list(opened)[1:])
        )
