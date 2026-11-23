"""Classic EIGRP native conversion coverage; live Cisco acceptance is separate."""

from hashlib import sha256
import re
import unittest

from lxml import etree as X

from documents import open_document, save_document
from editing import set_interface, set_lines
from eigrp import guard, metric_commands, metric_settings, project, update, validate
from network import ios_sections, read_network
from serve import export_native, import_native
from test_native import read_and_attach
from test_virtuals import routed_lab


def process(asn=100, passive=None):
    return dict(
        protocol="eigrp", processId=asn, routerId="1.1.1.1",
        networks=[dict(network="192.0.10.0", prefix=24, area=0), dict(network="192.0.20.0", prefix=24, area=0)],
        passivePorts=passive or [],
    )


def eigrp_lab(multilayer=False):
    topology = routed_lab(multilayer)
    router = next(d for d in topology["devices"] if d["kind"] == ("switch" if multilayer else "router"))
    virtual = next(p for p in router["ports"] if p.get("virtual"))
    router["routing"] = process(passive=[virtual["id"]])
    router["ports"][0].update(bandwidth=50000, delay=200)
    virtual.update(bandwidth=25000, delay=100)
    return topology


def synthetic(config=None):
    engine = X.Element("ENGINE")
    lines = ["interface GigabitEthernet0/0", " bandwidth 100000", " delay 10", "!", "router eigrp 100"]
    lines.extend(" " + s for s in (config or ["no auto-summary", "network 10.0.0.0", "network 192.0.2.3 0.0.0.0", "passive-interface GigabitEthernet0/0"]))
    set_lines(engine, "RUNNINGCONFIG", lines + ["!", "end"])
    return engine, [dict(id="p0", name="GigabitEthernet0/0", bandwidth=100000, delay=10)]


class NativeEigrp(unittest.TestCase):
    def test_small_projection_and_metric_units(self):
        engine, ports = synthetic()
        routing, opaque = project(engine, ports)
        self.assertFalse(opaque)
        self.assertEqual(routing["processId"], 100)
        self.assertEqual(routing["routerId"], "")
        self.assertEqual(routing["passivePorts"], ["p0"])
        self.assertEqual(routing["networks"], [dict(network="10.0.0.0", prefix=8, area=0), dict(network="192.0.2.3", prefix=32, area=0)])
        self.assertEqual(metric_settings(["bandwidth 100000", "delay 10"]), dict(bandwidth=100000, delay=10))
        self.assertEqual(metric_settings(["no bandwidth", "no delay"]), {})
        lines = validate(routing, "router", {"p0": "GigabitEthernet0/0"})
        self.assertIn(" network 192.0.2.3 0.0.0.0", lines)
        self.assertIn(" no auto-summary", lines)

    def test_unmodeled_processes_are_not_simulated_and_are_guarded(self):
        for config in (
            ["auto-summary", "network 10.0.0.0"],
            ["network 10.0.0.0"],
            ["no auto-summary", "metric weights 0 1 1 1 0 0"],
            ["no auto-summary", "redistribute static"],
            ["no auto-summary", "variance 2"],
            ["no auto-summary", "passive-interface default"],
            ["no auto-summary", "network 10.0.0.0 0.255.0.255"],
            ["no auto-summary", "passive-interface Serial9/9"],
        ):
            with self.subTest(config=config):
                engine, ports = synthetic(config)
                self.assertEqual(project(engine, ports), (None, True))
                before = dict(kind="router", ports=ports)
                guard(engine, before, {**before, "name": "Renamed"})
                with self.assertRaisesRegex(ValueError, "source is preserved"):
                    guard(engine, before, {**before, "routing": process()})
                with self.assertRaisesRegex(ValueError, "source is preserved"):
                    guard(engine, before, {**before, "ports": [{**ports[0], "delay": 12}]})
        for marker in ("router eigrp NAMED", "router ospf 1", "ipv6 router eigrp 1"):
            engine, ports = synthetic()
            lines, _ = ios_sections(engine)
            set_lines(engine, "RUNNINGCONFIG", [marker if s == "router eigrp 100" else s for s in lines])
            self.assertEqual(project(engine, ports), (None, True))
            before = dict(kind="router", ports=ports)
            source = X.tostring(engine)
            update(engine, before, {**before, "note": "Unrelated edit"}, {"p0": "GigabitEthernet0/0"})
            self.assertEqual(X.tostring(engine), source)
        engine, ports = synthetic()
        lines, _ = ios_sections(engine)
        set_lines(engine, "RUNNINGCONFIG", lines[:-1] + ["router eigrp 200", " no auto-summary", "end"])
        self.assertEqual(project(engine, ports), (None, True))
        engine, ports = synthetic()
        set_interface(engine, ports[0]["name"], [(re.compile("ip summary-address eigrp .*"), "ip summary-address eigrp 100 10.0.0.0 255.0.0.0")])
        self.assertEqual(project(engine, ports), (None, True))

    def test_metric_bounds_and_opaque_variants(self):
        for field, value in (("bandwidth", 0), ("bandwidth", 2147483648), ("delay", 16777216), ("delay", True), ("delay", 1.5)):
            with self.subTest(field=field, value=value):
                with self.assertRaises(ValueError):
                    metric_commands("router", [], {}, {field: value})
        self.assertEqual(metric_commands("router", ["delay 10"], {"delay": 10}, {})[0][1], None)
        with self.assertRaisesRegex(ValueError, "variant"):
            metric_commands("router", ["bandwidth inherit"], {}, {"bandwidth": 1000})
        engine, ports = synthetic()
        set_interface(engine, ports[0]["name"], [(re.compile("bandwidth .*"), "bandwidth inherit")])
        self.assertEqual(project(engine, ports), (None, True))
        set_lines(engine, "RUNNINGCONFIG", ["interface GigabitEthernet0/0", " bandwidth inherit", "!", "end"])
        with self.assertRaisesRegex(ValueError, "source is preserved"):
            guard(engine, {"ports": ports}, {"ports": ports, "routing": process()})

    def test_routing_validation_rejects_lossy_exports(self):
        for patch in (
            {"processId": 0}, {"processId": 65536}, {"processId": True},
            {"protocol": "ospf"}, {"autoSummary": True}, {"routerId": "invalid"}, {"routerId": False},
            {"passivePorts": ["missing"]}, {"passivePorts": ["p0", "p0"]},
            {"networks": [dict(network="192.0.2.1", prefix=24, area=0)]},
            {"networks": [dict(network="192.0.2.0", prefix=24, area=1)]},
        ):
            with self.subTest(patch=patch):
                with self.assertRaises(ValueError):
                    validate({**process(), **patch}, "router", {"p0": "GigabitEthernet0/0"})

    def test_author_edit_remove_all_containers_and_virtual_interfaces(self):
        for fmt in ("pkt", "pka", "pkz"):
            for multilayer in (False, True):
                with self.subTest(format=fmt, multilayer=multilayer):
                    raw = export_native(dict(network=eigrp_lab(multilayer), format=fmt))
                    request = read_and_attach(raw, fmt)
                    self.assertEqual(sha256(export_native(request)).digest(), sha256(raw).digest())
                    router = next(d for d in request["network"]["devices"] if d.get("routing"))
                    passive = next(p for p in router["ports"] if p["id"] in router["routing"]["passivePorts"])
                    self.assertEqual((passive["bandwidth"], passive["delay"]), (25000, 100))
                    self.assertEqual((router["ports"][0]["bandwidth"], router["ports"][0]["delay"]), (50000, 200))
                    router["routing"].update(processId=200, routerId="2.2.2.2")
                    router["ports"][0]["delay"] = 400
                    del passive["bandwidth"]
                    changed = read_and_attach(export_native(request), fmt)
                    updated = next(d for d in changed["network"]["devices"] if d.get("routing"))
                    self.assertEqual(updated["routing"]["processId"], 200)
                    self.assertEqual(updated["routing"]["routerId"], "2.2.2.2")
                    self.assertEqual(updated["ports"][0]["delay"], 400)
                    updated_passive = next(p for p in updated["ports"] if p["id"] in updated["routing"]["passivePorts"])
                    self.assertNotIn("bandwidth", updated_passive)
                    del updated["routing"]
                    without = import_native(export_native(changed), fmt, "without")["network"]
                    self.assertTrue(all("routing" not in d for d in without["devices"]))

    def test_preserves_native_fields_and_unsupported_processes(self):
        root = open_document(export_native(dict(network=eigrp_lab(), format="pkt")), "pkt")
        engine = next(e for e in root.findall("NETWORK/DEVICES/DEVICE/ENGINE") if any((s.text or "").startswith("router eigrp ") for s in e.findall("RUNNINGCONFIG/LINE")))
        X.SubElement(engine, "UNMODELED_ROUTING_CONTROL").text = "retain"
        bandwidth = [n.text for n in engine.findall(".//MODULE/PORT/BANDWIDTH")]
        raw = save_document(root)
        request = read_and_attach(raw, "pkt")
        router = next(d for d in request["network"]["devices"] if d.get("routing"))
        router["ports"][0]["bandwidth"] = 10000
        edited = open_document(export_native(request), "pkt")
        retained = next(e for e in edited.findall("NETWORK/DEVICES/DEVICE/ENGINE") if e.find("UNMODELED_ROUTING_CONTROL") is not None)
        self.assertEqual(retained.findtext("UNMODELED_ROUTING_CONTROL"), "retain")
        self.assertEqual([n.text for n in retained.findall(".//MODULE/PORT/BANDWIDTH")], bandwidth)
        lines, _ = ios_sections(engine)
        set_lines(engine, "RUNNINGCONFIG", [" auto-summary" if s == " no auto-summary" else s for s in lines])
        self.assertEqual(read_network(root, "opaque")[2]["routing processes"], 1)
        request = read_and_attach(save_document(root), "pkt")
        router = next(d for d in request["network"]["devices"] if d["kind"] == "router")
        router["note"] = "Unrelated edit"
        kept = open_document(export_native(request), "pkt")
        self.assertIn(" auto-summary", [n.text for n in kept.findall("NETWORK/DEVICES/DEVICE/ENGINE/RUNNINGCONFIG/LINE")])
        router["routing"] = process()
        with self.assertRaisesRegex(ValueError, "source is preserved"):
            export_native(request)

    def test_passive_subinterface_renaming_updates_process(self):
        request = read_and_attach(export_native(dict(network=eigrp_lab(), format="pkt")), "pkt")
        router = next(d for d in request["network"]["devices"] if d.get("routing"))
        passive = next(p for p in router["ports"] if p["id"] in router["routing"]["passivePorts"])
        passive["name"] = "GigabitEthernet0/0.30"
        passive["virtual"]["vlan"] = 30
        changed = import_native(export_native(request), "pkt", "renamed")["network"]
        updated = next(d for d in changed["devices"] if d.get("routing"))
        port = next(p for p in updated["ports"] if p["id"] in updated["routing"]["passivePorts"])
        self.assertEqual(port["name"], "GigabitEthernet0/0.30")


if __name__ == "__main__":
    unittest.main()
