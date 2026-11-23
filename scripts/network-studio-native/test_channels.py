"""Native EtherChannel authoring, source-preserving edits and model contracts."""

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import re
import shutil
import subprocess
import unittest

from lxml import etree as X

from documents import open_document, save_document
from editing import set_interface
from network import ios_sections
from serve import export_native, import_native
from test_native import read_and_attach
from test_virtuals import port


def bundle_lab(routed=False, mode="active"):
    devices = []
    for i in range(2):
        group = i + 1
        options = (
            {"routed": True}
            if routed
            else {"mode": "trunk", "allowedVlans": [1, 10], "nativeVlan": 1}
        )
        members = [
            port(
                f"p{n}",
                f"FastEthernet0/{n+1}",
                channelGroup=dict(id=group, mode=mode),
                **options,
            )
            for n in range(2)
        ]
        logical = port(
            f"port-channel:{group}",
            f"Port-channel{group}",
            f"192.0.2.{i+1}" if routed else "",
            dict(kind="portchannel", group=group),
            **options,
        )
        devices.append(
            dict(
                id=str(i),
                name=f"Bundle-{i}",
                kind="switch",
                x=200 + i * 300,
                y=200,
                powered=True,
                gateway="",
                routes=[],
                note="",
                ipRouting=routed,
                ports=members + [logical],
                etherChannelLoadBalance="src-dst-mac",
            )
        )
    return dict(
        version=1,
        name="EtherChannel control",
        devices=devices,
        links=[
            dict(
                id=f"link-{n}",
                a=dict(device="0", port=f"p{n}"),
                b=dict(device="1", port=f"p{n}"),
                cable="copper",
            )
            for n in range(2)
        ],
    )


def channel(device):
    return next(
        p for p in device["ports"] if p.get("virtual", {}).get("kind") == "portchannel"
    )


class NativeChannels(unittest.TestCase):
    def test_layer2_hash_limit_and_new_multilayer_selection(self):
        topology = bundle_lab()
        for device in topology["devices"]:
            device.pop("etherChannelLoadBalance")
        raw = export_native(dict(network=topology, format="pkt"))
        request = read_and_attach(raw, "pkt")
        request["network"]["devices"][0]["etherChannelLoadBalance"] = "dst-mac"
        with self.assertRaisesRegex(ValueError, "does not preserve"):
            export_native(request)
        request["network"]["devices"][0]["etherChannelLoadBalance"] = "src-mac"
        self.assertNotIn(
            "etherChannelLoadBalance",
            import_native(export_native(request), "pkt", "default")["network"][
                "devices"
            ][0],
        )
        authored = open_document(
            export_native(dict(network=bundle_lab(), format="pkt")), "pkt"
        )
        self.assertEqual(
            authored.findtext("NETWORK/DEVICES/DEVICE/ENGINE/TYPE"), "MultiLayerSwitch"
        )

    def test_author_orders_global_and_logical_before_physical_stanzas(self):
        raw = export_native(dict(network=bundle_lab(), format="pkt"))
        root = open_document(raw, "pkt")
        lines = ios_sections(root.find("NETWORK/DEVICES/DEVICE/ENGINE"))[0]
        self.assertLess(
            lines.index("port-channel load-balance src-dst-mac"),
            lines.index("interface Port-channel1"),
        )
        self.assertLess(
            lines.index("interface Port-channel1"),
            lines.index("interface FastEthernet0/1"),
        )

    def test_multilayer_membership_table_tracks_edits_and_removal(self):
        topology = bundle_lab(True)
        topology["devices"][0]["ports"][0]["channelProtocol"] = "lacp"
        raw = export_native(dict(network=topology, format="pkt"))
        root = open_document(raw, "pkt")
        engine = root.find("NETWORK/DEVICES/DEVICE/ENGINE")
        table = "ETHERCHANNEL_MANAGER/ETHERCHANNEL_ALL_PORT_DATA"
        row = engine.find(table + "/ETHERCHANNEL_PORT_DATA")
        self.assertEqual(row.findtext("PORT_NAME"), "FastEthernet0/1")
        self.assertEqual(
            row.findtext("ETHERCHANNEL_PORT_DATA/ETHER_CHANNEL_PROTOCOL"), "1"
        )
        request = read_and_attach(raw, "pkt")
        device = request["network"]["devices"][0]
        device["ports"][0]["channelGroup"]["mode"] = "passive"
        device["ports"][1].pop("channelGroup")
        saved = open_document(export_native(request), "pkt")
        engine = saved.find("NETWORK/DEVICES/DEVICE/ENGINE")
        rows = engine.findall(table + "/ETHERCHANNEL_PORT_DATA")
        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0].findtext("ETHERCHANNEL_PORT_DATA/ETHER_CHANNEL_MODE"), "5"
        )
        self.assertEqual(
            rows[0].findtext("ETHERCHANNEL_PORT_DATA/ETHER_CHANNEL_PROTOCOL"), "1"
        )
        device["ports"][0].pop("channelGroup")
        device["ports"].remove(channel(device))
        engine = open_document(export_native(request), "pkt").find(
            "NETWORK/DEVICES/DEVICE/ENGINE"
        )
        row = engine.find(table + "/ETHERCHANNEL_PORT_DATA")
        self.assertEqual(row.findtext("ETHERCHANNEL_PORT_DATA/PORT_CHANNEL"), "0")
        self.assertEqual(row.findtext("ETHERCHANNEL_PORT_DATA/ETHER_CHANNEL_MODE"), "0")
        self.assertEqual(
            row.findtext("ETHERCHANNEL_PORT_DATA/ETHER_CHANNEL_PROTOCOL"), "1"
        )
        self.assertEqual(len(engine.find("ETHERCHANNEL_MANAGER/ETHERCHANNEL")), 0)

    def test_member_validation_matches_model(self):
        base = bundle_lab()
        for change in (
            {"channelGroup": {"id": 1, "mode": "on"}, "channelProtocol": "lacp"},
            {"channelGroup": {"id": 1, "mode": "auto"}},
            {"voiceVlan": 10},
            {"security": {"enabled": True}},
            {"ip": "192.0.2.1"},
            {"helperAddresses": ["192.0.2.1"]},
        ):
            with self.subTest(change=change):
                topology = deepcopy(base)
                topology["devices"][0]["ports"][0].update(change)
                with self.assertRaises(ValueError):
                    export_native(dict(network=topology, format="pkt"))

    def test_unknown_hash_policy_is_preserved_and_replacement_rejected(self):
        raw = export_native(dict(network=bundle_lab(), format="pkt"))
        root = open_document(raw, "pkt")
        engine = root.find("NETWORK/DEVICES/DEVICE/ENGINE")
        for line in engine.findall("RUNNINGCONFIG/LINE"):
            if (line.text or "").startswith("port-channel load-balance "):
                line.text = "port-channel load-balance dst-ip"
        raw = save_document(root)
        request = read_and_attach(raw, "pkt")
        self.same_bytes(export_native(request), raw)
        request["network"]["devices"][0]["etherChannelLoadBalance"] = "dst-mac"
        with self.assertRaisesRegex(ValueError, "not supported for editing"):
            export_native(request)

    def same_bytes(self, a, b):
        self.assertEqual(
            (len(a), sha256(a).hexdigest()), (len(b), sha256(b).hexdigest())
        )

    def test_all_modes_and_source_identity(self):
        for mode in ("on", "active", "passive", "desirable", "auto"):
            with self.subTest(mode=mode):
                topology = bundle_lab(mode=mode)
                raw = export_native(dict(network=topology, format="pkt"))
                request = read_and_attach(raw, "pkt")
                for i, d in enumerate(request["network"]["devices"]):
                    self.assertEqual(
                        d["ports"][0]["channelGroup"], dict(id=i + 1, mode=mode)
                    )
                    self.assertEqual(channel(d)["name"], f"Port-channel{i+1}")
                    self.assertEqual(channel(d)["mode"], "trunk")
                    self.assertEqual(channel(d)["allowedVlans"], [1, 10])
                self.same_bytes(export_native(request), raw)

    def test_edit_members_logical_and_hash_all_native_formats(self):
        for fmt in ("pkt", "pka", "pkz"):
            with self.subTest(fmt=fmt):
                raw = export_native(dict(network=bundle_lab(), format=fmt))
                request = read_and_attach(raw, fmt)
                first = request["network"]["devices"][0]
                first["ports"][0]["channelGroup"]["mode"] = "passive"
                first["ports"][0]["channelProtocol"] = "lacp"
                channel(first)["allowedVlans"] = [1, 10, 20]
                channel(first)["enabled"] = False
                first["etherChannelLoadBalance"] = "dst-mac"
                updated = import_native(export_native(request), fmt, "changed")[
                    "network"
                ]["devices"][0]
                self.assertEqual(updated["ports"][0]["channelGroup"]["mode"], "passive")
                self.assertEqual(updated["ports"][0]["channelProtocol"], "lacp")
                self.assertEqual(updated["etherChannelLoadBalance"], "dst-mac")
                self.assertEqual(channel(updated)["allowedVlans"], [1, 10, 20])
                self.assertFalse(channel(updated)["enabled"])

    def test_routed_portchannel_address_helpers_and_pdus_all_formats(self):
        topology = bundle_lab(True)
        channel(topology["devices"][0])["helperAddresses"] = ["198.51.100.10"]
        topology["pdus"] = [
            dict(
                id="echo",
                source="0",
                target="1",
                port="port-channel:2",
                protocol="icmp",
                ttl=42,
            )
        ]
        for fmt in ("pkt", "pka", "pkz"):
            with self.subTest(fmt=fmt):
                raw = export_native(dict(network=topology, format=fmt))
                request = read_and_attach(raw, fmt)
                first = request["network"]["devices"][0]
                self.assertTrue(channel(first)["routed"])
                self.assertEqual(channel(first)["ip"], "192.0.2.1")
                self.assertNotIn("nativeVlan", channel(first))
                self.assertEqual(channel(first)["helperAddresses"], ["198.51.100.10"])
                self.assertEqual(
                    request["network"]["pdus"][0]["port"], "port-channel:2"
                )
                channel(first)["ip"] = "192.0.2.10"
                saved = import_native(export_native(request), fmt, "changed")["network"]
                self.assertEqual(channel(saved["devices"][0])["ip"], "192.0.2.10")
                self.assertEqual(len(saved["pdus"]), 1)

    def test_remove_bundle_requires_cleared_members_and_keeps_physical_ids(self):
        raw = export_native(dict(network=bundle_lab(), format="pkt"))
        request = read_and_attach(raw, "pkt")
        device = request["network"]["devices"][0]
        old = [(p["id"], p["name"]) for p in device["ports"] if not p.get("virtual")]
        device["ports"].remove(channel(device))
        with self.assertRaisesRegex(ValueError, "represented port-channel"):
            export_native(request)
        for p in device["ports"]:
            p.pop("channelGroup", None)
        updated = import_native(export_native(request), "pkt", "removed")["network"][
            "devices"
        ][0]
        self.assertFalse(
            any(
                p.get("channelGroup")
                or p.get("virtual", {}).get("kind") == "portchannel"
                for p in updated["ports"]
            )
        )
        self.assertEqual(
            old,
            [(p["id"], p["name"]) for p in updated["ports"] if not p.get("virtual")],
        )

    def test_unknown_command_startup_and_industrial_state_preserved(self):
        raw = export_native(dict(network=bundle_lab(), format="pkt"))
        root = open_document(raw, "pkt")
        engine = root.find("NETWORK/DEVICES/DEVICE/ENGINE")
        set_interface(
            engine,
            "Port-channel1",
            [(re.compile("description .*"), "description native-only")],
        )
        manager = engine.find("ETHERCHANNEL_MANAGER")
        if manager is None:
            manager = X.SubElement(engine, "ETHERCHANNEL_MANAGER")
        manager.text = "opaque industrial data"
        raw = save_document(root)
        request = read_and_attach(raw, "pkt")
        self.same_bytes(export_native(request), raw)
        request["network"]["devices"][0]["note"] = "Unrelated edit"
        changed = open_document(export_native(request), "pkt")
        updated = changed.find("NETWORK/DEVICES/DEVICE/ENGINE")
        self.assertEqual(
            updated.findtext("ETHERCHANNEL_MANAGER"), "opaque industrial data"
        )
        self.assertIn(
            "description native-only", ios_sections(updated)[1]["Port-channel1"]
        )
        request["network"]["devices"][0]["ports"][0]["channelGroup"]["mode"] = "passive"
        with self.assertRaisesRegex(ValueError, "additional EtherChannel state"):
            export_native(request)

    def test_invalid_protocol_groups_and_layer2_chassis_rejected(self):
        topology = bundle_lab()
        topology["devices"][0]["ports"][0]["channelProtocol"] = "pagp"
        with self.assertRaisesRegex(ValueError, "conflicts"):
            export_native(dict(network=topology, format="pkt"))
        topology = bundle_lab()
        channel(topology["devices"][0])["virtual"]["group"] = 7
        with self.assertRaisesRegex(ValueError, "groups 1 through 6"):
            export_native(dict(network=topology, format="pkt"))
        topology = bundle_lab()
        for device in topology["devices"]:
            device.pop("etherChannelLoadBalance")
        raw = export_native(dict(network=topology, format="pkt"))
        request = read_and_attach(raw, "pkt")
        po = channel(request["network"]["devices"][0])
        po.update(routed=True, mode="access", vlan=1, allowedVlans=[1], ip="192.0.2.1")
        po.pop("nativeVlan", None)
        with self.assertRaisesRegex(ValueError, "does not support routed"):
            export_native(request)

    def test_projection_passes_typescript_parser(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node is unavailable")
        version = subprocess.check_output([node, "--version"], text=True).strip()
        if int(version.lstrip("v").split(".")[0]) < 22:
            self.skipTest("Node22 required")
        script = "import{parseTopology}from'./src/network-studio/persistence.ts';import{channelState}from'./src/network-studio/etherChannel.ts';let s='';for await(const b of process.stdin)s+=b;const t=parseTopology(s);for(const d of t.devices){const po=d.ports.find(p=>p.virtual?.kind==='portchannel');if(!channelState(t,d.id,po.virtual.group).up)throw Error('Projected channel did not form');}"
        for routed, fiber in ((False, False), (True, False), (False, True)):
            with self.subTest(routed=routed, fiber=fiber):
                raw = export_native(dict(network=bundle_lab(routed), format="pkt"))
                if fiber:
                    native = open_document(raw, "pkt")
                    for leaf in native.findall(
                        "NETWORK/DEVICES/DEVICE/ENGINE//MODULE/PORT/TYPE"
                    ):
                        leaf.text = (leaf.text or "").replace("Copper", "Fiber")
                    for leaf in native.findall("NETWORK/LINKS/LINK/TYPE"):
                        leaf.text = "eFiber"
                    raw = save_document(native)
                network = import_native(raw, "pkt", "cross-language")["network"]
                if fiber:
                    self.assertTrue(
                        all(channel(d)["media"] == "fiber" for d in network["devices"])
                    )
                    request = read_and_attach(raw, "pkt")
                    channel(request["network"]["devices"][0])["enabled"] = False
                    updated = import_native(
                        export_native(request), "pkt", "fiber edit"
                    )["network"]
                    self.assertFalse(channel(updated["devices"][0])["enabled"])
                result = subprocess.run(
                    [
                        node,
                        "--max-old-space-size=256",
                        "--experimental-strip-types",
                        "--input-type=module",
                        "-e",
                        script,
                    ],
                    cwd=Path(__file__).resolve().parents[2],
                    input=json.dumps(network),
                    text=True,
                    capture_output=True,
                    timeout=20,
                )
                self.assertEqual(result.returncode, 0, result.stderr[-4000:])


if __name__ == "__main__":
    unittest.main()
