"""Native DTP defaults, commands and source-preserving container edits."""

from copy import deepcopy
from hashlib import sha256
import re
import unittest

from lxml import etree as X

from documents import open_document, save_document
from editing import set_interface
from network import ios_sections, read_network
from serve import export_native, import_native
from test_channels import bundle_lab, channel
from test_native import read_and_attach


def dtp_lab():
    topology = bundle_lab()
    for index, device in enumerate(topology["devices"]):
        mode = "dynamic-desirable" if index == 0 else "dynamic-auto"
        for port in device["ports"]:
            port["mode"] = mode
    return topology


class NativeDtp(unittest.TestCase):
    def test_author_and_edit_all_containers(self):
        for fmt in ("pkt", "pka", "pkz"):
            with self.subTest(format=fmt):
                topology = dtp_lab()
                raw = export_native(dict(network=topology, format=fmt))
                request = read_and_attach(raw, fmt)
                self.assertEqual(
                    sha256(export_native(request)).digest(), sha256(raw).digest()
                )
                devices = request["network"]["devices"]
                self.assertEqual(channel(devices[0])["mode"], "dynamic-desirable")
                self.assertEqual(channel(devices[1])["mode"], "dynamic-auto")
                for port in devices[0]["ports"]:
                    if (
                        port.get("channelGroup")
                        or port.get("virtual", {}).get("kind") == "portchannel"
                    ):
                        port.update(mode="trunk", nonegotiate=True)
                changed = export_native(request)
                edited = read_and_attach(changed, fmt)
                switch = edited["network"]["devices"][0]
                self.assertEqual(channel(switch)["mode"], "trunk")
                self.assertTrue(channel(switch)["nonegotiate"])
                self.assertTrue(switch["ports"][0]["nonegotiate"])
                for port in switch["ports"]:
                    if port.get("nonegotiate"):
                        port["mode"] = "dynamic-auto"
                        del port["nonegotiate"]
                restored = import_native(export_native(edited), fmt, "restored")[
                    "network"
                ]
                self.assertEqual(
                    channel(restored["devices"][0])["mode"], "dynamic-auto"
                )
                self.assertNotIn("nonegotiate", channel(restored["devices"][0]))

    def test_implicit_auto_and_unrestricted_trunks_include_lab_vlans(self):
        root = open_document(
            export_native(dict(network=dtp_lab(), format="pkt")), "pkt"
        )
        engine = root.find("NETWORK/DEVICES/DEVICE/ENGINE")
        for name in ("FastEthernet0/1", "Port-channel1"):
            set_interface(
                engine,
                name,
                [
                    (re.compile(r"switchport mode .*"), None),
                    (re.compile(r"switchport trunk allowed vlan .*"), None),
                ],
            )
        topology, _, _ = read_network(root, "implicit")
        self.assertEqual(topology["devices"][0]["ports"][0]["mode"], "dynamic-auto")
        self.assertEqual(channel(topology["devices"][0])["mode"], "dynamic-auto")
        self.assertIn(10, channel(topology["devices"][0])["allowedVlans"])

    def test_fixed_access_is_explicit_when_authored(self):
        topology = bundle_lab()
        for device in topology["devices"]:
            for port in device["ports"]:
                port["mode"] = "access"
        root = open_document(export_native(dict(network=topology, format="pkt")), "pkt")
        for engine in root.findall("NETWORK/DEVICES/DEVICE/ENGINE")[:2]:
            _, sections = ios_sections(engine)
            self.assertIn("switchport mode access", sections["FastEthernet0/1"])
            self.assertIn(
                "switchport mode access",
                next(v for k, v in sections.items() if k.startswith("Port-channel")),
            )

    def test_preserves_unrelated_xml_and_rejects_opaque_mode_edit(self):
        root = open_document(
            export_native(dict(network=dtp_lab(), format="pkt")), "pkt"
        )
        engine = root.find("NETWORK/DEVICES/DEVICE/ENGINE")
        X.SubElement(engine, "UNMODELED_DTP_CONTROL").text = "retain"
        raw = save_document(root)
        request = read_and_attach(raw, "pkt")
        request["network"]["devices"][0]["ports"][0]["mode"] = "dynamic-auto"
        edited = open_document(export_native(request), "pkt")
        self.assertEqual(
            edited.findtext("NETWORK/DEVICES/DEVICE/ENGINE/UNMODELED_DTP_CONTROL"),
            "retain",
        )
        set_interface(
            engine,
            "FastEthernet0/1",
            [(re.compile(r"switchport mode .*"), "switchport mode dot1q-tunnel")],
        )
        request = read_and_attach(save_document(root), "pkt")
        self.assertEqual(request["network"]["devices"][0]["ports"][0]["mode"], "access")
        self.assertEqual(read_network(root, "opaque")[2]["switchport modes"], 1)
        request["network"]["devices"][0]["ports"][0]["mode"] = "trunk"
        with self.assertRaisesRegex(ValueError, "must be edited in Packet Tracer"):
            export_native(request)
        set_interface(
            engine,
            "Port-channel1",
            [(re.compile(r"switchport mode .*"), "switchport mode dot1q-tunnel")],
        )
        request = read_and_attach(save_document(root), "pkt")
        channel(request["network"]["devices"][0])["mode"] = "trunk"
        with self.assertRaisesRegex(ValueError, "must be edited in Packet Tracer"):
            export_native(request)

    def test_rejects_invalid_dtp_combinations(self):
        for patch in (
            {"nonegotiate": True},
            {"nonegotiate": "yes"},
            {"routed": True},
            {"mode": "invalid"},
        ):
            with self.subTest(patch=patch):
                topology = dtp_lab()
                channel(topology["devices"][0]).update(patch)
                with self.assertRaises(ValueError):
                    export_native(dict(network=topology, format="pkt"))
        topology = dtp_lab()
        topology["devices"][0]["ports"][0]["media"] = "serial"
        with self.assertRaises(ValueError):
            export_native(dict(network=topology, format="pkt"))

    def test_edit_retains_member_differences_and_false_negotiation_means_enabled(self):
        request = read_and_attach(
            export_native(dict(network=dtp_lab(), format="pkt")), "pkt"
        )
        device = request["network"]["devices"][0]
        device["ports"][0].update(mode="access", nonegotiate=False)
        changed = export_native(request)
        result = import_native(changed, "pkt", "changed")["network"]["devices"][0]
        self.assertEqual(result["ports"][0]["mode"], "access")
        self.assertFalse(result["ports"][0].get("nonegotiate", False))
        self.assertEqual(channel(result)["mode"], "dynamic-desirable")
        copy = deepcopy(request)
        copy["network"]["devices"][0]["ports"][0]["mode"] = "dynamic-auto"
        self.assertEqual(
            import_native(export_native(copy), "pkt", "copy")["network"]["devices"][0][
                "ports"
            ][0]["mode"],
            "dynamic-auto",
        )


if __name__ == "__main__":
    unittest.main()
