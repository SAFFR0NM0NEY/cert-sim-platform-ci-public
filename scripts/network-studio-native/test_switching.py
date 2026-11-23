"""Native VLAN/VTP databases and physical multilayer switch interoperability."""

from copy import deepcopy
import unittest

from lxml import etree as X

from author import network
from documents import child, open_document, save_document
from editing import patch
from network import ios_sections, native_ports, read_network
from serve import export_native, import_native
from switching import DEFAULTS, project_switch, update_switch
from test_native import read_and_attach
from test_virtuals import port, routed_lab


def database():
    return [dict(id=i, name=name, state="active") for i, name in DEFAULTS.items()] + [
        dict(id=10, name="Students", state="active"),
        dict(id=20, name="Teachers", state="active"),
    ]


def switching_lab():
    topology = routed_lab(True)
    switch = topology["devices"][-1]
    switch["vlans"] = database()
    switch["vtp"] = dict(mode="server", domain="lab", version=2, revision=7)
    switch["ports"].append(
        port(
            "p2",
            "FastEthernet0/3",
            "198.51.100.1",
            routed=True,
            helperAddresses=["198.51.100.10"],
        )
    )
    return topology


def switch_engine(root):
    return next(
        d.find("ENGINE")
        for d in root.findall("NETWORK/DEVICES/DEVICE")
        if d.findtext("ENGINE/TYPE") == "MultiLayerSwitch"
    )


class NativeSwitching(unittest.TestCase):
    def test_databases_and_routed_interfaces_roundtrip_all_formats(self):
        topology = switching_lab()
        topology["pdus"] = [
            dict(
                id="to-routed",
                source="0",
                target="switch",
                port="p2",
                protocol="icmp",
                ttl=64,
            ),
            dict(
                id="from-routed",
                source="switch",
                target="0",
                port="p0",
                protocol="icmp",
                ttl=52,
            ),
        ]
        for fmt in ("pkt", "pka", "pkz"):
            with self.subTest(fmt=fmt):
                raw = export_native(dict(network=topology, format=fmt))
                request = read_and_attach(raw, fmt)
                switch = request["network"]["devices"][-1]
                self.assertEqual(
                    switch["vlans"], sorted(database(), key=lambda r: r["id"])
                )
                self.assertEqual(switch["vtp"], topology["devices"][-1]["vtp"])
                routed = next(p for p in switch["ports"] if p.get("routed"))
                self.assertNotIn("nativeVlan", routed)
                self.assertEqual((routed["vlan"], routed["mode"]), (1, "access"))
                self.assertEqual(
                    (routed["id"], routed["ip"], routed["helperAddresses"]),
                    ("p2", "198.51.100.1", ["198.51.100.10"]),
                )
                self.assertEqual(len(request["network"]["pdus"]), 2)
                self.assertEqual(export_native(request), raw)
                switch["vlans"][1]["name"] = "Renamed"
                switch["vtp"]["revision"] = 8
                routed["ip"] = "198.51.100.2"
                routed["helperAddresses"] = ["198.51.100.11"]
                updated = import_native(export_native(request), fmt, "updated")[
                    "network"
                ]["devices"][-1]
                self.assertEqual(updated["vlans"][1]["name"], "Renamed")
                self.assertEqual(updated["vtp"]["revision"], 8)
                self.assertEqual(updated["ports"][2]["ip"], "198.51.100.2")
                self.assertEqual(
                    updated["ports"][2]["helperAddresses"], ["198.51.100.11"]
                )

    def test_routed_source_without_svi_survives_roundtrip(self):
        topology = switching_lab()
        switch = topology["devices"][-1]
        switch["ports"] = [p for p in switch["ports"] if not p.get("virtual")]
        switch["ipRouting"] = False
        topology["pdus"] = [
            dict(
                id="echo",
                source="switch",
                target="0",
                port="p0",
                protocol="icmp",
                ttl=64,
            )
        ]
        raw = export_native(dict(network=topology, format="pkt"))
        native = open_document(raw, "pkt")
        self.assertIsNotNone(switch_engine(native))
        imported = import_native(raw, "pkt", "test")["network"]
        self.assertFalse(imported["devices"][-1]["ipRouting"])
        self.assertEqual(len(imported["pdus"]), 1)

    def test_conversion_clears_old_mode_commands_and_raw_ipv4(self):
        root, _ = network(switching_lab())
        engine = switch_engine(root)
        native_port = native_ports(engine, "switch")[2][2]
        block = engine.find("RUNNINGCONFIG")
        marker = next(n for n in block if n.text == "interface FastEthernet0/3")
        block.insert(block.index(marker) + 1, X.Element("LINE"))
        marker.getnext().text = " description Keep this native setting"
        topology = read_network(root, "test")[0]
        routed = topology["devices"][-1]["ports"][2]
        routed.update(routed=False, ip="", helperAddresses=[], vlan=20)
        patch(root, "test", topology)
        commands = ios_sections(engine)[1]["FastEthernet0/3"]
        self.assertNotIn("no switchport", commands)
        self.assertFalse(
            any(
                c.startswith("ip address ") or c.startswith("ip helper-address ")
                for c in commands
            )
        )
        self.assertIn("switchport access vlan 20", commands)
        self.assertIn("description Keep this native setting", commands)
        self.assertEqual(native_port.findtext("IP"), "")
        topology = read_network(root, "test")[0]
        routed = topology["devices"][-1]["ports"][2]
        routed.update(routed=True, ip="203.0.113.1")
        patch(root, "test", topology)
        commands = ios_sections(engine)[1]["FastEthernet0/3"]
        self.assertIn("no switchport", commands)
        self.assertFalse(any(c.startswith("switchport ") for c in commands))
        self.assertEqual(native_port.findtext("IP"), "203.0.113.1")

    def test_layer_two_chassis_cannot_gain_routed_port(self):
        root, _ = network(routed_lab(False))
        topology = read_network(root, "test")[0]
        switch = next(d for d in topology["devices"] if d["kind"] == "switch")
        switch["ports"][0].update(routed=True, ip="198.51.100.1")
        with self.assertRaisesRegex(ValueError, "chassis"):
            patch(root, "test", topology)

    def test_database_edit_preserves_unknowns_and_only_actual_vlan_file(self):
        root, _ = network(switching_lab())
        engine = switch_engine(root)
        row = engine.find("VLANS/VLAN[@number='10']")
        row.set("rspan", "1")
        row.set("future", "keep")
        X.SubElement(engine.find("VTP"), "FUTURE").text = "keep"
        manager = engine.find("FILE_MANAGER")
        if manager is None:
            manager = X.SubElement(engine, "FILE_MANAGER")
        stale = X.SubElement(manager, "FILE", {"class": "CFileSystem"})
        child(stale, "NAME", "flash:")
        child(stale, "FILE_CONTENT", "keep stale snapshot")
        actual = X.SubElement(manager, "FILE", {"class": "CFile"})
        child(actual, "NAME", "vlan.dat")
        content = X.SubElement(actual, "FILE_CONTENT", {"class": "CVlanDatFileContent"})
        content.extend([deepcopy(engine.find("VLANS")), deepcopy(engine.find("VTP"))])
        before = project_switch(engine)
        after = deepcopy(before)
        after["vlans"] = [r for r in after["vlans"] if r["id"] != 20]
        next(r for r in after["vlans"] if r["id"] == 10)["name"] = "Changed"
        after["vtp"].update(mode="transparent", revision=0)
        update_switch(engine, before, after)
        self.assertEqual(row.get("future"), "keep")
        self.assertEqual(row.get("rspan"), "1")
        self.assertEqual(content.findtext("VTP/MODE"), "2")
        self.assertEqual(content.findtext("VLAN_COUNT"), "6")
        self.assertEqual(content.findtext("VTP/FUTURE"), "keep")
        self.assertEqual(stale.findtext("FILE_CONTENT"), "keep stale snapshot")
        self.assertIsNone(engine.find("VLANS/VLAN[@number='20']"))
        self.assertIn("vlan 10", ios_sections(engine)[0])
        self.assertIn(" name Changed", ios_sections(engine)[0])

    def test_suspended_and_reserved_native_changes_fail(self):
        for change in ("suspended", "rename", "delete"):
            with self.subTest(change=change):
                topology = switching_lab()
                rows = topology["devices"][-1]["vlans"]
                if change == "suspended":
                    rows[-1]["state"] = "suspended"
                elif change == "rename":
                    rows[0]["name"] = "Rename"
                else:
                    rows.pop(0)
                with self.assertRaisesRegex(ValueError, "suspended|default VLAN"):
                    export_native(dict(network=topology, format="pkt"))

    def test_absent_and_unsupported_native_databases_stay_unprojected(self):
        root, _ = network(switching_lab())
        engine = switch_engine(root)
        engine.remove(engine.find("VLANS"))
        child(engine.find("VTP"), "VERSION", "3")
        raw = save_document(root, "pkt")
        request = read_and_attach(raw, "pkt")
        switch = request["network"]["devices"][-1]
        self.assertNotIn("vlans", switch)
        self.assertNotIn("vtp", switch)
        self.assertEqual(export_native(request), raw)
        switch["note"] = "Updated only the description"
        saved = open_document(export_native(request), "pkt")
        self.assertEqual(switch_engine(saved).findtext("VTP/VERSION"), "3")
        self.assertIsNone(switch_engine(saved).find("VLANS"))

    def test_explicit_missing_vlan_does_not_reappear_on_unrelated_save(self):
        topology = switching_lab()
        topology["devices"][-1]["vlans"] = [r for r in database() if r["id"] != 10]
        raw = export_native(dict(network=topology, format="pkt"))
        request = read_and_attach(raw, "pkt")
        request["network"]["devices"][-1]["note"] = "Preserve deleted VLAN"
        saved = open_document(export_native(request), "pkt")
        self.assertIsNone(switch_engine(saved).find("VLANS/VLAN[@number='10']"))
        self.assertIn("Vlan10", ios_sections(switch_engine(saved))[1])

    def test_transparent_vtp_removes_only_owned_commands_on_mode_change(self):
        topology = switching_lab()
        topology["devices"][-1]["vtp"].update(mode="transparent", revision=0)
        root, _ = network(topology)
        engine = switch_engine(root)
        before = project_switch(engine)
        self.assertIn("vtp mode transparent", ios_sections(engine)[0])
        block = engine.find("RUNNINGCONFIG")
        X.SubElement(block, "LINE").text = "vtp pruning"
        after = deepcopy(before)
        after["vtp"]["mode"] = "client"
        update_switch(engine, before, after)
        self.assertNotIn("vtp mode transparent", ios_sections(engine)[0])
        self.assertIn("vtp pruning", ios_sections(engine)[0])
        self.assertFalse(
            any(repr(s).startswith("'vlan ") for s in ios_sections(engine)[0])
        )


if __name__ == "__main__":
    unittest.main()
