"""Native fiber coverage; template/container tests run in cloud CI."""
from copy import deepcopy
from hashlib import sha256
import unittest

from lxml import etree as X
from author import network
from documents import current_network, open_document, save_document
from editing import set_lines
from fiber import mapped_metrics, needs_fiber_router, router_pt_port_names
from network import native_ports, read_network
from packages import read_package
from serve import export_native, import_native
from test_native import lab, read_and_attach


def synthetic():
    engine = X.Element("ENGINE")
    X.SubElement(engine, "TYPE", model="Router-PT").text = "Router"
    root = X.SubElement(engine, "MODULE")
    X.SubElement(root, "TYPE").text = "eNonRemovableModule"
    for slot, module_model, medium in (
        (0, "PT-ROUTER-NM-1CFE", "eCopperFastEthernet"),
        (1, "PT-ROUTER-NM-1CFE", "eCopperFastEthernet"),
        (2, "PT-ROUTER-NM-1S", "eSerial"),
        (3, "PT-ROUTER-NM-1S", "eSerial"),
        (4, "PT-ROUTER-NM-1FFE", "eFiberFastEthernet"),
        (5, "PT-ROUTER-NM-1FFE", "eFiberFastEthernet"),
        *[(i, None, None) for i in range(6, 10)],
    ):
        entry = X.SubElement(root, "SLOT")
        X.SubElement(entry, "TYPE").text = "ePtRouterModule"
        if module_model:
            module = X.SubElement(entry, "MODULE")
            X.SubElement(module, "TYPE").text = "ePtRouterModule"
            X.SubElement(module, "MODEL").text = module_model
            port = X.SubElement(module, "PORT")
            X.SubElement(port, "TYPE").text = medium
            X.SubElement(port, "IP").text = f"192.0.{slot}.1"
    set_lines(engine, "RUNNINGCONFIG", [
        "interface FastEthernet5/0", " delay 55", "!",
        "interface FastEthernet0/0", " delay 10", "!", "end",
    ])
    return engine


def fiber_lab():
    topology = lab()
    routers = []
    for index, host in enumerate(topology["devices"], 1):
        host["ports"][0]["ip"] = f"10.{index}.0.10"
        host["gateway"] = f"10.{index}.0.1"
        base = host["ports"][0]
        router = dict(
            id=f"r{index}", kind="router", name=f"Fiber-{index}", powered=True,
            x=150 + index * 200, y=400, gateway="", routes=[], note="",
            ports=[
                {**base, "id": "p0", "name": "GigabitEthernet0/0", "ip": host["gateway"]},
                {**base, "id": "p1", "name": "GigabitEthernet0/1", "ip": ""},
                {**base, "id": "p2", "name": "GigabitEthernet0/2", "media": "fiber",
                 "ip": f"192.0.2.{index}", "prefix": 30, "bandwidth": 500000, "delay": 20},
            ],
            routing=dict(protocol="eigrp", processId=10, routerId="",
                         networks=[dict(network="0.0.0.0", prefix=0, area=0)],
                         passivePorts=["p0"]),
        )
        routers.append(router)
    topology["links"] = [
        dict(id=f"lan{i}", a=dict(device=host["id"], port="p0"),
             b=dict(device=routers[i]["id"], port="p0"), cable="copper")
        for i, host in enumerate(topology["devices"])
    ] + [dict(id="fiber", a=dict(device="r1", port="p2"),
              b=dict(device="r2", port="p2"), cable="fiber")]
    topology["devices"].extend(routers)
    return topology


def document(raw, fmt):
    if fmt == "pkz":
        package = read_package(raw)
        return open_document(package.document, package.format)
    return open_document(raw, fmt)


class FiberSynthetic(unittest.TestCase):
    def test_slot_names_do_not_depend_on_config_order_or_presence(self):
        engine = synthetic()
        ports = native_ports(engine, "router")
        self.assertEqual([entry[0] for entry in ports],
                         ["FastEthernet0/0", "FastEthernet1/0", "Serial2/0",
                          "Serial3/0", "FastEthernet4/0", "FastEthernet5/0"])
        self.assertEqual(ports[4][1], "fiber")
        self.assertEqual(ports[4][2].findtext("IP"), "192.0.4.1")
        self.assertEqual(ports[4][3], [])
        self.assertEqual(ports[5][3], ["delay 55"])
        set_lines(engine, "RUNNINGCONFIG", ["end"])
        self.assertEqual([entry[0] for entry in native_ports(engine, "router")],
                         [entry[0] for entry in ports])

    def test_unknown_modular_layout_is_not_guessed(self):
        engine = synthetic()
        engine.find("MODULE/SLOT/MODULE/MODEL").text = "Unknown-module"
        self.assertEqual(native_ports(engine, "router"), [])
        engine = synthetic()
        engine.find("MODULE").remove(engine.findall("MODULE/SLOT")[-1])
        self.assertEqual(router_pt_port_names(engine), {})
        engine.find("TYPE").set("model", "2911")
        self.assertIsNone(router_pt_port_names(engine))

    def test_fiber_selection_respects_spares_parent_references_and_settings(self):
        topology = fiber_lab()
        device = topology["devices"][2]
        port = device["ports"][2]
        self.assertTrue(needs_fiber_router(topology, device))
        topology["links"] = []
        port.update(ip="", prefix=24)
        del port["bandwidth"], port["delay"]
        self.assertFalse(needs_fiber_router(topology, device))
        for patch in (dict(enabled=False), dict(delay=1), dict(helperAddresses=["10.1.0.1"])):
            candidate = deepcopy(device)
            candidate["ports"][2].update(patch)
            self.assertTrue(needs_fiber_router(topology, candidate))
        device["ports"].append(dict(id="sub", virtual=dict(kind="subinterface", parent="p2")))
        self.assertTrue(needs_fiber_router(topology, device))
        device["ports"].pop()
        topology["pdus"] = [dict(source=device["id"], sourceInterface="p2")]
        self.assertTrue(needs_fiber_router(topology, device))

    def test_mapped_metrics_preserve_effective_values_without_relabeling_hardware(self):
        base = dict(name="GigabitEthernet0/2", media="fiber")
        self.assertEqual(mapped_metrics(base, "FastEthernet4/0"), dict(bandwidth=1000000, delay=1))
        self.assertEqual(mapped_metrics({**base, "bandwidth": 1234, "delay": 88}, "FastEthernet4/0"),
                         dict(bandwidth=1234, delay=88))
        self.assertEqual(mapped_metrics(base, "GigabitEthernet0/2"), {})
        self.assertEqual(mapped_metrics(dict(name="FastEthernet0/2", media="fiber"), "FastEthernet4/0"), {})


class FiberContainers(unittest.TestCase):
    def test_author_and_edit_all_native_containers(self):
        for fmt in ("pkt", "pka", "pkz"):
            with self.subTest(format=fmt):
                raw = export_native(dict(network=fiber_lab(), format=fmt))
                files = read_and_attach(raw, fmt)
                self.assertEqual(sha256(export_native(files)).digest(), sha256(raw).digest())
                projected = files["network"]
                self.assertEqual(len(projected["links"]), 3)
                self.assertEqual(sum(e["cable"] == "fiber" for e in projected["links"]), 1)
                router = next(d for d in projected["devices"] if d["name"] == "Fiber-1")
                port = next(p for p in router["ports"] if p["ip"] == "192.0.2.1")
                self.assertEqual((port["name"], port["media"], port["bandwidth"], port["delay"]),
                                 ("FastEthernet4/0", "fiber", 500000, 20))
                lan = next(p for p in router["ports"] if p["ip"] == "10.1.0.1")
                self.assertEqual((lan["bandwidth"], lan["delay"]), (1000000, 1))
                self.assertEqual(router["routing"]["passivePorts"], [lan["id"]])
                port.update(delay=60, enabled=False)
                changed = read_and_attach(export_native(files), fmt)
                updated = next(p for d in changed["network"]["devices"] for p in d["ports"]
                               if p["ip"] == "192.0.2.1")
                self.assertEqual((updated["delay"], updated["enabled"]), (60, False))
                root = current_network(document(raw, fmt))
                engines = [n for n in root.findall("NETWORK/DEVICES/DEVICE/ENGINE")
                           if n.find("TYPE").get("model") == "Router-PT"]
                self.assertEqual(len(engines), 2)
                for engine in engines:
                    for p in engine.findall(".//PORT"):
                        if p.findtext("TYPE") == "eFiberFastEthernet":
                            self.assertEqual(p.findtext("BANDWIDTH"), "100000")

    def test_edits_keep_original_module_tree_and_unknown_fields(self):
        root = open_document(export_native(dict(network=fiber_lab(), format="pkt")), "pkt")
        engine = next(e for e in root.findall("NETWORK/DEVICES/DEVICE/ENGINE")
                      if e.findtext("NAME") == "Fiber-1")
        X.SubElement(engine, "UNMODELED_FIBER_SETTING").text = "retain"
        before = deepcopy(engine.find("MODULE"))
        files = read_and_attach(save_document(root), "pkt")
        router = next(d for d in files["network"]["devices"] if d["name"] == "Fiber-1")
        next(p for p in router["ports"] if p["ip"] == "192.0.2.1")["delay"] = 100
        changed = open_document(export_native(files), "pkt")
        after = next(e for e in changed.findall("NETWORK/DEVICES/DEVICE/ENGINE")
                     if e.findtext("NAME") == "Fiber-1")
        self.assertEqual(after.findtext("UNMODELED_FIBER_SETTING"), "retain")
        self.assertEqual(sha256(X.tostring(after.find("MODULE"))).digest(),
                         sha256(X.tostring(before)).digest())

    def test_parent_mapping_copper_compatibility_and_capacity(self):
        topology = fiber_lab()
        topology["links"] = []
        device = topology["devices"][2]
        parent = device["ports"][2]
        parent.update(ip="", prefix=24)
        del parent["bandwidth"], parent["delay"]
        device["ports"].append({
            **parent, "id": "sub", "name": "GigabitEthernet0/2.10", "ip": "192.0.10.1",
            "virtual": dict(kind="subinterface", parent="p2", vlan=10),
        })
        device["routing"]["passivePorts"].append("sub")
        root, _ = network(topology)
        router = next(d for d in read_network(root, "fiber")[0]["devices"] if d["name"] == "Fiber-1")
        sub = next(p for p in router["ports"] if p["ip"] == "192.0.10.1")
        self.assertEqual(sub["name"], "FastEthernet4/0.10")
        self.assertIn(sub["id"], router["routing"]["passivePorts"])
        topology = fiber_lab()
        device = topology["devices"][2]
        device["ports"].extend({**device["ports"][2], "id": f"extra{i}",
                                "name": f"GigabitEthernet1/{i}"} for i in range(2))
        with self.assertRaisesRegex(ValueError, "No native fiber"):
            network(topology)
        topology = fiber_lab()
        topology["links"] = []
        for device in topology["devices"][2:]:
            port = device["ports"][2]
            port.update(ip="", prefix=24)
            del port["bandwidth"], port["delay"]
        root, _ = network(topology)
        models = [e.find("TYPE").get("model") for e in root.findall("NETWORK/DEVICES/DEVICE/ENGINE")
                  if e.findtext("TYPE") == "Router"]
        self.assertEqual(models, ["2911", "2911"])
