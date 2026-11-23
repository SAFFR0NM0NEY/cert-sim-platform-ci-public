"""Native edge protection interoperability and unsupported-setting preservation."""

import json
from pathlib import Path
import re
import shutil
import subprocess
import unittest

from lxml import etree as X

from author import network
from documents import child, open_document, save_document
from edgeprotection import port_settings, switch_settings
from editing import patch, set_interface
from network import ios_sections, native_ports, read_network
from serve import export_native, import_native
from test_native import read_and_attach
from test_virtuals import routed_lab

SHUTDOWN = re.compile(r"(?:no )?shutdown")


def edge_lab():
    topology = routed_lab(True)
    switch = topology["devices"][-1]
    switch["spanningTree"] = dict(
        priorities=[dict(vlan=10, priority=4096)],
        portFastDefault=True,
        bpduGuardDefault=True,
    )
    switch["ports"][0].update(portFast="enable", bpduGuard="enable")
    switch["ports"][1].update(portFast="disable")
    return topology


def engine(root):
    return next(
        e
        for e in root.findall("NETWORK/DEVICES/DEVICE/ENGINE")
        if e.findtext("TYPE") in ("Switch", "MultiLayerSwitch")
    )


class NativeEdgeProtection(unittest.TestCase):
    def test_native_projection_passes_typescript_topology_validation(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node is unavailable for the cross-language contract check.")
        version = subprocess.check_output([node, "--version"], text=True).strip()
        if int(version.lstrip("v").split(".")[0]) < 22:
            self.skipTest("The TypeScript contract check needs Node 22 or later.")
        script = (
            "import {parseTopology} from './src/network-studio/persistence.ts';"
            "let input='';for await(const chunk of process.stdin) input+=chunk;"
            "parseTopology(input);"
        )
        root = Path(__file__).resolve().parents[2]
        for fmt in ("pkt", "pka", "pkz"):
            with self.subTest(fmt=fmt):
                raw = export_native(dict(network=edge_lab(), format=fmt))
                topology = import_native(raw, fmt, "native-edge")["network"]
                result = subprocess.run(
                    [
                        node,
                        "--experimental-strip-types",
                        "--input-type=module",
                        "-e",
                        script,
                    ],
                    cwd=root,
                    input=json.dumps(topology),
                    text=True,
                    capture_output=True,
                    timeout=20,
                )
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_edge_settings_and_defaults_roundtrip_all_native_formats(self):
        topology = edge_lab()
        expected = topology["devices"][-1]
        for fmt in ("pkt", "pka", "pkz"):
            with self.subTest(fmt=fmt):
                raw = export_native(dict(network=topology, format=fmt))
                request = read_and_attach(raw, fmt)
                switch = request["network"]["devices"][-1]
                self.assertEqual(switch["spanningTree"], expected["spanningTree"])
                self.assertEqual(switch["ports"][0]["portFast"], "enable")
                self.assertEqual(switch["ports"][0]["bpduGuard"], "enable")
                self.assertEqual(switch["ports"][1]["portFast"], "disable")
                self.assertEqual(export_native(request), raw)
                switch["ports"][0].update(portFast="trunk", bpduGuard="default")
                switch["spanningTree"]["portFastDefault"] = False
                switch["spanningTree"]["priorities"][0]["priority"] = 8192
                updated = import_native(export_native(request), fmt, "updated")[
                    "network"
                ]["devices"][-1]
                self.assertEqual(updated["ports"][0]["portFast"], "trunk")
                self.assertNotIn("bpduGuard", updated["ports"][0])
                self.assertFalse(updated["spanningTree"].get("portFastDefault", False))
                self.assertTrue(updated["spanningTree"]["bpduGuardDefault"])
                self.assertEqual(
                    updated["spanningTree"]["priorities"],
                    [dict(vlan=10, priority=8192)],
                )

    def test_runtime_power_snapshot_does_not_invent_shutdown_or_guard_cause(self):
        root, _ = network(edge_lab())
        eng = engine(root)
        child(native_ports(eng, "switch")[0][2], "POWER", "false")
        set_interface(eng, "FastEthernet0/1", [(SHUTDOWN, None)])
        raw = save_document(root, "pkt")
        request = read_and_attach(raw, "pkt")
        switch = request["network"]["devices"][-1]
        self.assertFalse(switch["ports"][0]["enabled"])
        self.assertNotIn("bpduPorts", switch)
        self.assertEqual(export_native(request), raw)
        switch["note"] = "Preserve runtime snapshot"
        saved = open_document(export_native(request), "pkt")
        self.assertEqual(
            native_ports(engine(saved), "switch")[0][2].findtext("POWER"), "false"
        )
        self.assertFalse(
            any(
                s in ("shutdown", "no shutdown")
                for s in ios_sections(engine(saved))[1]["FastEthernet0/1"]
            )
        )
        switch["ports"][0]["enabled"] = True
        saved = open_document(export_native(request), "pkt")
        self.assertEqual(
            native_ports(engine(saved), "switch")[0][2].findtext("POWER"), "true"
        )
        self.assertIn("no shutdown", ios_sections(engine(saved))[1]["FastEthernet0/1"])

    def test_known_command_edits_leave_other_stp_and_startup_settings(self):
        root, _ = network(edge_lab())
        eng = engine(root)
        startup = X.SubElement(eng, "STARTUP_EVIDENCE")
        startup.text = "unrelated snapshot"
        config = eng.find("RUNNINGCONFIG")
        index = next(
            i for i, n in enumerate(config) if n.text == "interface FastEthernet0/1"
        )
        for line in (
            " spanning-tree guard root",
            " spanning-tree bpdufilter enable",
            " description Retained",
        ):
            node = X.Element("LINE")
            node.text = line
            config.insert(index + 1, node)
        X.SubElement(config, "LINE").text = "spanning-tree portfast bpdufilter default"
        before_xml = X.tostring(startup)
        topology = read_network(root, "test")[0]
        switch = topology["devices"][-1]
        switch["ports"][0].update(portFast="default", bpduGuard="default")
        switch["spanningTree"]["bpduGuardDefault"] = False
        patch(root, "test", topology)
        lines, interfaces = ios_sections(eng)
        self.assertIn("spanning-tree portfast bpdufilter default", lines)
        self.assertIn("spanning-tree guard root", interfaces["FastEthernet0/1"])
        self.assertIn("spanning-tree bpdufilter enable", interfaces["FastEthernet0/1"])
        self.assertIn("description Retained", interfaces["FastEthernet0/1"])
        self.assertNotIn("spanning-tree portfast", interfaces["FastEthernet0/1"])
        self.assertNotIn(
            "spanning-tree bpduguard enable", interfaces["FastEthernet0/1"]
        )
        self.assertEqual(X.tostring(startup), before_xml)

    def test_explicit_disable_and_automatic_recovery_fail_new_native_export(self):
        for setting in ("disable", "recovery"):
            with self.subTest(setting=setting):
                topology = edge_lab()
                switch = topology["devices"][-1]
                if setting == "disable":
                    switch["ports"][0]["bpduGuard"] = "disable"
                else:
                    switch["bpduGuardRecovery"] = True
                with self.assertRaisesRegex(
                    ValueError,
                    "explicit BPDU Guard disable|automatic BPDU Guard recovery",
                ):
                    export_native(dict(network=topology, format="pkt"))
                request = read_and_attach(
                    export_native(dict(network=edge_lab(), format="pkt")), "pkt"
                )
                imported = request["network"]["devices"][-1]
                if setting == "disable":
                    imported["ports"][0]["bpduGuard"] = "disable"
                else:
                    imported["bpduGuardRecovery"] = True
                with self.assertRaisesRegex(
                    ValueError,
                    "explicit BPDU Guard disable|automatic BPDU Guard recovery",
                ):
                    export_native(request)

    def test_existing_native_only_disable_and_recovery_are_not_destroyed(self):
        root, _ = network(edge_lab())
        eng = engine(root)
        for n in eng.findall("RUNNINGCONFIG/LINE"):
            if n.text == " spanning-tree bpduguard enable":
                n.text = " spanning-tree bpduguard disable"
        X.SubElement(eng.find("RUNNINGCONFIG"), "LINE").text = (
            "errdisable recovery cause bpduguard"
        )
        raw = save_document(root, "pkt")
        request = read_and_attach(raw, "pkt")
        switch = request["network"]["devices"][-1]
        self.assertEqual(switch["ports"][0]["bpduGuard"], "disable")
        self.assertEqual(export_native(request), raw)
        switch["note"] = "Unrelated edit"
        saved = open_document(export_native(request), "pkt")
        lines, interfaces = ios_sections(engine(saved))
        self.assertIn("errdisable recovery cause bpduguard", lines)
        self.assertIn("spanning-tree bpduguard disable", interfaces["FastEthernet0/1"])

    def test_routed_and_virtual_interfaces_do_not_gain_edge_settings(self):
        for kind in ("routed", "svi", "host"):
            topology = edge_lab()
            switch = topology["devices"][-1]
            if kind == "routed":
                p = switch["ports"][0]
                p["routed"] = True
            elif kind == "svi":
                p = switch["ports"][-1]
            else:
                p = topology["devices"][0]["ports"][0]
            p["portFast"] = "enable"
            with self.subTest(kind=kind), self.assertRaisesRegex(
                ValueError, "physical native switchport"
            ):
                export_native(dict(network=topology, format="pkt"))

    def test_unrecognized_native_variants_are_not_projected_as_supported(self):
        self.assertEqual(
            port_settings(
                [
                    "spanning-tree bpduguard",
                    "spanning-tree portfast edge",
                    "spanning-tree bpdufilter enable",
                ]
            ),
            {},
        )
        self.assertIsNone(
            switch_settings(
                [
                    "spanning-tree vlan 1-20 priority 4096",
                    "spanning-tree portfast bpdufilter default",
                ]
            )
        )
        self.assertEqual(
            port_settings(
                [
                    "spanning-tree portfast trunk",
                    "no spanning-tree portfast",
                    "spanning-tree bpduguard enable",
                    "no spanning-tree bpduguard",
                ]
            ),
            dict(portFast="default", bpduGuard="default"),
        )


if __name__ == "__main__":
    unittest.main()
