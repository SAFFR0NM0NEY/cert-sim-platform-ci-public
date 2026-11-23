"""Helper-address configuration in native router interface stanzas."""

import unittest

from documents import open_document, save_document
from network import ios_sections
from serve import export_native, import_native
from test_native import lab, read_and_attach


def router_lab():
    t = lab()
    router = t["devices"][0]
    router.update(kind="router", name="Relay-R1")
    router["ports"][0].update(
        name="GigabitEthernet0/0", helperAddresses=["198.51.100.67", "198.51.100.68"]
    )
    return t


def router_sections(root):
    engine = root.find("NETWORK/DEVICES/DEVICE/ENGINE")
    return ios_sections(engine)[1]


class NativeRelay(unittest.TestCase):
    def test_create_preserve_edit_and_remove(self):
        t = router_lab()
        raw = export_native(dict(format="pkt", network=t))
        root = open_document(raw, "pkt")
        stanza = router_sections(root)["GigabitEthernet0/0"]
        self.assertIn("ip helper-address 198.51.100.67", stanza)
        self.assertIn("ip helper-address 198.51.100.68", stanza)

        # This native interface variant has no CertSim routing context.
        lines = root.findall("NETWORK/DEVICES/DEVICE/ENGINE/RUNNINGCONFIG/LINE")
        marker = next(
            line for line in lines if line.text == "interface GigabitEthernet0/0"
        )
        opaque = marker.makeelement("LINE")
        opaque.text = " ip helper-address vrf example 203.0.113.7"
        marker.addnext(opaque)
        raw = save_document(root)
        files = read_and_attach(raw, "pkt")
        self.assertEqual(export_native(files), raw)
        port = files["network"]["devices"][0]["ports"][0]
        self.assertEqual(port["helperAddresses"], ["198.51.100.67", "198.51.100.68"])
        port["helperAddresses"] = ["203.0.113.9"]
        edited = export_native(files)
        values = router_sections(open_document(edited, "pkt"))["GigabitEthernet0/0"]
        self.assertIn("ip helper-address vrf example 203.0.113.7", values)
        self.assertIn("ip helper-address 203.0.113.9", values)
        self.assertNotIn("ip helper-address 198.51.100.67", values)
        self.assertNotIn("ip helper-address 198.51.100.68", values)

        files = read_and_attach(edited, "pkt")
        del files["network"]["devices"][0]["ports"][0]["helperAddresses"]
        removed = export_native(files)
        self.assertIn(
            "ip helper-address vrf example 203.0.113.7",
            router_sections(open_document(removed, "pkt"))["GigabitEthernet0/0"],
        )
        self.assertNotIn(
            "helperAddresses",
            import_native(removed, "pkt", "lab")["network"]["devices"][0]["ports"][0],
        )

    def test_invalid_addresses_and_unmapped_hardware(self):
        for value in [["224.0.0.1"], ["nope"], ["192.0.2.1", "192.0.2.1"], "192.0.2.1"]:
            with self.subTest(value=value):
                t = router_lab()
                t["devices"][0]["ports"][0]["helperAddresses"] = value
                with self.assertRaisesRegex(ValueError, "unicast"):
                    export_native(dict(format="pkt", network=t))
        t = router_lab()
        t["devices"][1]["ports"][0]["helperAddresses"] = ["192.0.2.1"]
        with self.assertRaisesRegex(ValueError, "router interface"):
            export_native(dict(format="pkt", network=t))
        t = router_lab()
        empty = {
            **t["devices"][0]["ports"][0],
            "id": "p2",
            "name": "GigabitEthernet0/2",
            "ip": "",
            "media": "fiber",
        }
        # The native Router-PT layout has two fiber modules; a third is unsupported.
        t["devices"][0]["ports"].extend(
            {**empty, "id": f"fiber{i}", "name": f"GigabitEthernet0/{i + 2}"}
            for i in range(3)
        )
        with self.assertRaisesRegex(ValueError, "No native fiber"):
            export_native(dict(format="pkt", network=t))


if __name__ == "__main__":
    unittest.main()
