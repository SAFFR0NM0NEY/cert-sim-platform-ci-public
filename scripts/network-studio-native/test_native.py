"""Regression cases for local Packet Tracer 9 import and save."""

import base64
from copy import deepcopy
import unittest
from lxml import etree as X

from assessment import grade
from author import new_activity, network
from documents import (
    NETWORK,
    activity_pages,
    current_network,
    open_document,
    save_document,
)
from serve import check_native, export_native, import_native, package_resource
from packages import read_package, write_package


def lab():
    devices = []
    for index in range(2):
        port = dict(
            id="p0",
            name="FastEthernet0",
            media="copper",
            enabled=True,
            ip="192.0.2." + str(index + 1),
            prefix=24,
            vlan=1,
            mode="access",
            allowedVlans=[1],
        )
        devices.append(
            dict(
                id=str(index),
                kind="pc",
                name=f"PC-{index}",
                x=120 + index * 200,
                y=200,
                powered=True,
                gateway="",
                routes=[],
                note="",
                ports=[port],
            )
        )
    link = dict(
        id="edge",
        a=dict(device="0", port="p0"),
        b=dict(device="1", port="p0"),
        cable="copper",
    )
    return dict(version=1, name="Activity lab", devices=devices, links=[link])


def read_and_attach(raw, fmt):
    visible = import_native(raw, fmt, "lab")["network"]
    visible["nativeFile"] = {"name": "lab", "format": fmt}
    return dict(
        network=visible, format=fmt, source=base64.b64encode(raw).decode("ascii")
    )


class NativeFiles(unittest.TestCase):
    def test_network_address_and_cable(self):
        raw = export_native(dict(network=lab(), format="pkt"))
        self.assertEqual(
            open_document(raw, "pkt").findtext("NETWORK/LINKS/LINK/CABLE/TYPE"),
            "eCrossOver",
        )
        files = read_and_attach(raw, "pkt")
        self.assertEqual(export_native(files), raw)
        t = files["network"]
        self.assertEqual(len(t["links"]), 1)
        t["devices"][0]["ports"][0]["ip"] = "192.0.2.40"
        t["links"][0]["lengthMeters"] = 19.5
        edited = import_native(export_native(files), "pkt", "edited")["network"]
        self.assertEqual(edited["devices"][0]["ports"][0]["ip"], "192.0.2.40")
        self.assertEqual(edited["links"][0]["lengthMeters"], 19.5)

    def test_preserve_unmodeled_sections_and_existing_cable_data(self):
        root, _ = network(lab())
        X.SubElement(root.find("NETWORK/LINKS/LINK/CABLE"), "OPAQUE").text = "retain"
        X.SubElement(root, "CUSTOM_DATA").text = "unmodeled"
        files = read_and_attach(save_document(root), "pkt")
        files["network"]["links"][0]["lengthMeters"] = 42
        saved = open_document(export_native(files), "pkt")
        self.assertEqual(saved.findtext("CUSTOM_DATA"), "unmodeled")
        self.assertEqual(saved.findtext("NETWORK/LINKS/LINK/CABLE/OPAQUE"), "retain")

    def test_activity_scores_and_retains_initial_answer_and_grading(self):
        t = lab()
        t["activity"] = {
            "initial": deepcopy(t),
            "title": "Addressing",
            "instructions": "Set the address to 192.0.2.20.",
            "checks": [],
            "interfaceChecks": [
                {
                    "device": "0",
                    "port": "p0",
                    "field": "ipv4",
                    "expected": "192.0.2.20/24",
                }
            ],
        }
        raw = export_native(dict(network=t, format="pka"))
        original = open_document(raw, "pka")
        self.assertEqual(
            len(
                original.findall("COMPARISONS//NAME[@headNode='false'][@checkType='2']")
            ),
            2,
        )
        files = read_and_attach(raw, "pka")
        self.assertEqual(export_native(files), raw)
        self.assertEqual(files["network"]["devices"][0]["ports"][0]["ip"], "192.0.2.1")
        self.assertIn("Set the address", activity_pages(original)[0])
        files["network"]["devices"][0]["ports"][0]["ip"] = "192.0.2.20"
        saved = open_document(export_native(files), "pka")
        self.assertEqual(
            current_network(saved).findtext(".//MODULE/PORT/IP"), "192.0.2.20"
        )
        for index in (1, 2):
            self.assertEqual(
                X.tostring(original.findall(NETWORK)[index]),
                X.tostring(saved.findall(NETWORK)[index]),
            )
        self.assertEqual(
            X.tostring(original.find("COMPARISONS")),
            X.tostring(saved.find("COMPARISONS")),
        )

    def test_connectivity_grading(self):
        topology = lab()
        probe = dict(id="test", source="0", target="1", port="p0", protocol="icmp")
        for expect in (True, False):
            network_with_tests = {
                **topology,
                "activity": dict(
                    title="Ping",
                    instructions="Check the link.",
                    initial=topology,
                    checks=[dict(probe=probe, deliver=expect)],
                ),
            }
            root = new_activity(network_with_tests)
            files = read_and_attach(save_document(root), "pka")
            result = grade(root, files["network"], {})
            self.assertEqual(
                (result["earned"], result["total"], result["unmapped"]), (0, 1, 0)
            )
            key = result["probes"][0]["id"]
            self.assertEqual(grade(root, files["network"], {key: expect})["earned"], 1)
            self.assertEqual(
                grade(root, files["network"], {key: not expect})["earned"], 0
            )

    def test_native_simple_pdu_scenarios(self):
        t = lab()
        t["scenarios"] = [
            dict(id="default", name="Scenario 0", description=""),
            dict(id="test", name="Verify LAN", description="Reach the second PC"),
        ]
        t["pdus"] = [
            dict(
                id="ping",
                source="0",
                target="1",
                port="p0",
                protocol="icmp",
                scenario="test",
                ttl=55,
            )
        ]
        raw = export_native(dict(network=t, format="pkt"))
        files = read_and_attach(raw, "pkt")
        self.assertEqual(files["network"]["scenarios"][1]["name"], "Verify LAN")
        p = files["network"]["pdus"][0]
        self.assertEqual(
            (p["source"], p["target"], p["ttl"], p["scenario"]),
            ("native-0", "native-1", 55, "native-scenario-1"),
        )
        self.assertEqual(export_native(files), raw)
        files["network"]["pdus"][0]["ttl"] = 99
        files["network"]["scenarios"][1]["name"] = "Retest"
        updated = import_native(export_native(files), "pkt", "lab")["network"]
        self.assertEqual(updated["pdus"][0]["ttl"], 99)
        self.assertEqual(updated["scenarios"][1]["name"], "Retest")

    def test_change_native_inventory_and_reconnect(self):
        raw = export_native(dict(network=lab(), format="pkt"))
        files = read_and_attach(raw, "pkt")
        t = files["network"]
        old, kept = t["devices"]
        added = deepcopy(old)
        added.update(id="new-pc", name="Added PC", x=60, y=90)
        t["devices"] = [kept, added]
        t["links"] = [
            dict(
                id="replacement",
                a=dict(device=added["id"], port="p0"),
                b=dict(device=kept["id"], port="p0"),
                cable="copper",
            )
        ]
        saved = export_native(files)
        self.assertEqual(export_native(files), saved)
        network_after = import_native(saved, "pkt", "test")["network"]
        self.assertEqual(
            [d["name"] for d in network_after["devices"]], ["PC-1", "Added PC"]
        )
        self.assertEqual(len(network_after["links"]), 1)
        doc = open_document(saved, "pkt")
        native_refs = [
            e.text for e in doc.findall("NETWORK/DEVICES/DEVICE/ENGINE/SAVE_REF_ID")
        ]
        self.assertEqual(len(set(native_refs)), 2)
        self.assertEqual(
            len(set(x.text for x in doc.iter("MACADDRESS"))),
            len(list(doc.iter("MACADDRESS"))),
        )
        self.assertEqual(len(doc.xpath('PHYSICALWORKSPACE//NODE[NAME="Added PC"]')), 1)

    def test_retained_native_reference_prevents_deletion(self):
        root, _ = network(lab())
        ref = root.findtext("NETWORK/DEVICES/DEVICE/ENGINE/SAVE_REF_ID")
        X.SubElement(root, "EXTERNAL_OBJECT", device=ref)
        raw = save_document(root)
        files = read_and_attach(raw, "pkt")
        files["network"]["devices"].pop(0)
        files["network"]["links"] = []
        with self.assertRaisesRegex(ValueError, "retained native object"):
            export_native(files)

    def test_legacy_network_encoding_and_numbered_links(self):
        root, _ = network(lab())
        root.find("VERSION").text = "5.2.0.0068"
        for dev in root.findall("NETWORK/DEVICES/DEVICE/ENGINE"):
            dev.remove(dev.find("SAVE_REF_ID"))
        cable = root.find("NETWORK/LINKS/LINK/CABLE")
        cable.find("FROM").text = "0"
        cable.find("TO").text = "1"
        raw = save_document(root, "legacy")
        files = read_and_attach(raw, "pkt")
        self.assertEqual(len(files["network"]["links"]), 1)
        self.assertEqual(export_native(files), raw)
        files["network"]["name"] = "Edited legacy LAN"
        from documents import read_container

        edited, encoding = read_container(export_native(files), "pkt")
        self.assertEqual(
            (encoding, edited.findtext("NETWORK/DESCRIPTION")),
            ("legacy", "Edited legacy LAN"),
        )
        root.find("VERSION").text = "9.0.1"
        with self.assertRaisesRegex(ValueError, "legacy"):
            open_document(save_document(root, "legacy"), "pkt")

    def test_invalid_and_restricted_files(self):
        root = new_activity(lab())
        root.find("ACTIVITY/INSTRUCTIONS/PAGE").text = (
            "<p>Read this</p><script>hidden()</script>"
        )
        self.assertEqual(activity_pages(root), ["Read this"])
        root.find("LOCKINGTREE").set("enabled", "yes")
        root.find("LOCKINGTREE/NODE").set("on", "yes")
        raw = save_document(root)
        self.assertEqual(
            import_native(raw, "pka", "locked"),
            {"readOnly": True, "pages": ["Read this"]},
        )
        files = dict(
            network={**lab(), "nativeFile": {"name": "locked", "format": "pka"}},
            format="pka",
            source=base64.b64encode(raw).decode("ascii"),
        )
        with self.assertRaisesRegex(ValueError, "restrictions"):
            export_native(files)
        for content, fmt in [(raw, "pkt"), (b"damaged", "pkt")]:
            with self.assertRaises(ValueError):
                import_native(content, fmt, "invalid")

    def test_package_preserves_document_and_attachment_edits(self):
        pkt = export_native(dict(network=lab(), format="pkt"))
        wrapping = read_and_attach(pkt, "pkt")
        wrapping["format"] = "pkz"
        self.assertEqual(read_package(export_native(wrapping)).document_name, "lab.pkt")
        original = write_package("lab.pkt", pkt, {"handouts/readme.txt": b"before"})
        files = read_and_attach(original, "pkz")
        self.assertEqual(export_native(files), original)
        self.assertEqual(
            import_native(original, "pkz", "lab")["resources"],
            [{"name": "handouts/readme.txt", "size": 6}],
        )
        self.assertEqual(
            package_resource({**files, "name": "handouts/readme.txt"}), b"before"
        )
        with self.assertRaisesRegex(ValueError, "missing"):
            package_resource({**files, "name": "lab.pkt"})
        files["resources"] = {
            "remove": ["handouts/readme.txt"],
            "add": [{"name": "replacement.bin", "data": "AAE="}],
        }
        replaced = read_package(export_native(files))
        self.assertEqual(replaced.resources, {"replacement.bin": b"\x00\x01"})
        self.assertEqual(replaced.document, pkt)
        files["network"]["devices"][0]["ports"][0]["ip"] = "192.0.2.5"
        edited = import_native(export_native(files), "pkz", "lab")["network"]
        self.assertEqual(edited["devices"][0]["ports"][0]["ip"], "192.0.2.5")

    def test_package_background_changes_only_the_working_activity_network(self):
        # A one-pixel PNG accompanying the learner network.
        png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4"
            "38AAAAQBAYDFKhhdAAAAAElFTkSuQmCC"
        )
        activity = export_native(dict(network=lab(), format="pka"))
        original = write_package("exercise.pka", activity, {"images/floor.png": png})
        files = read_and_attach(original, "pkz")
        setting = {"name": "images/floor.png", "tiled": True}
        files["resources"] = {"background": setting}
        saved = export_native(files)
        self.assertEqual(import_native(saved, "pkz", "lab")["background"], setting)
        before = open_document(activity, "pka").findall(NETWORK)
        after = open_document(read_package(saved).document, "pka").findall(NETWORK)
        self.assertNotEqual(X.tostring(before[0]), X.tostring(after[0]))
        for prior, current in zip(before[1:], after[1:]):
            self.assertEqual(X.tostring(prior), X.tostring(current))
        files = read_and_attach(saved, "pkz")
        self.assertEqual(export_native(files), saved)
        files["resources"] = {"remove": ["images/floor.png"]}
        cleared = export_native(files)
        self.assertNotIn("background", import_native(cleared, "pkz", "lab"))
        self.assertEqual(read_package(cleared).resources, {})

    def test_restricted_packaged_activity(self):
        root = new_activity(lab())
        root.find("ACTIVITY/INSTRUCTIONS/PAGE").text = "<p>Learner page</p>"
        root.find("LOCKINGTREE").set("enabled", "yes")
        root.find("LOCKINGTREE/NODE").set("on", "yes")
        raw = write_package("locked.pka", save_document(root), {"guide.txt": b"guide"})
        self.assertEqual(
            import_native(raw, "pkz", "locked"),
            {"readOnly": True, "pages": ["Learner page"], "documentFormat": "pka"},
        )
        request = {
            "network": {**lab(), "nativeFile": {"format": "pkz", "name": "locked"}},
            "format": "pkz",
            "source": base64.b64encode(raw).decode(),
            "name": "guide.txt",
        }
        for operation in (export_native, check_native, package_resource):
            with self.assertRaises(ValueError):
                operation(request)

    def test_unsupported_changes_are_reported(self):
        t = lab()
        t["pdus"] = [{"id": "scheduled"}]
        with self.assertRaisesRegex(ValueError, "PDUs"):
            export_native(dict(network=t, format="pkt"))
        t = lab()
        raw = export_native(dict(network=t, format="pkt"))
        files = read_and_attach(raw, "pkt")
        files["network"]["devices"][0]["ports"][0]["security"] = {"enabled": True}
        with self.assertRaisesRegex(ValueError, "security"):
            export_native(files)
