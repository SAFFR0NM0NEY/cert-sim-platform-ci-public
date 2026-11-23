"""Native router-on-a-stick and multilayer switch interoperability cases."""

from copy import deepcopy
import unittest

from lxml import etree as X

from documents import open_document, save_document
from network import ios_sections
from serve import import_native, export_native
from test_native import lab, read_and_attach


def port(identifier, name, ip="", virtual=None, **values):
    result = dict(
        id=identifier,
        name=name,
        media="copper",
        enabled=True,
        ip=ip,
        prefix=24,
        vlan=1,
        mode="access",
        allowedVlans=[1],
    )
    if virtual:
        result["virtual"] = virtual
    result.update(values)
    return result


def routed_lab(multilayer=False):
    topology = lab()
    pcs = topology["devices"]
    for n, pc in enumerate(pcs, 1):
        pc["name"] = "Client-" + str(n)
        pc["ports"][0]["ip"] = f"192.0.{n * 10}.2"
        pc["gateway"] = f"192.0.{n * 10}.1"
        pc["x"], pc["y"] = 150 + n * 250, 350
    switch = dict(
        id="switch",
        name="VLAN-Switch",
        kind="switch",
        x=400,
        y=200,
        powered=True,
        gateway="",
        routes=[],
        note="",
        ports=[
            port("p0", "FastEthernet0/1", vlan=10),
            port("p1", "FastEthernet0/2", vlan=20),
        ],
    )
    topology["devices"].append(switch)
    topology["links"] = [
        dict(
            id=f"lan-{i}",
            a=dict(device=pc["id"], port="p0"),
            b=dict(device="switch", port=f"p{i}"),
            cable="copper",
        )
        for i, pc in enumerate(pcs[:2])
    ]
    if multilayer:
        switch["ipRouting"] = True
        switch["ports"].extend(
            [
                port(f"svi:{v}", f"Vlan{v}", f"192.0.{v}.1", dict(kind="svi", vlan=v))
                for v in (10, 20)
            ]
        )
    else:
        switch["ports"].append(
            port(
                "p2",
                "GigabitEthernet0/1",
                mode="trunk",
                nativeVlan=1,
                allowedVlans=[10, 20],
            )
        )
        router = dict(
            id="router",
            name="VLAN-Router",
            kind="router",
            x=200,
            y=150,
            powered=True,
            gateway="",
            routes=[],
            note="",
            ports=[port("p0", "GigabitEthernet0/0")],
        )
        router["ports"].extend(
            [
                port(
                    f"subinterface:p0:{v}",
                    f"GigabitEthernet0/0.{v}",
                    f"192.0.{v}.1",
                    dict(kind="subinterface", parent="p0", vlan=v),
                )
                for v in (10, 20)
            ]
        )
        topology["devices"].append(router)
        topology["links"].append(
            dict(
                id="uplink",
                a=dict(device="router", port="p0"),
                b=dict(device="switch", port="p2"),
                cable="copper",
            )
        )
    return topology


class NativeVirtualInterfaces(unittest.TestCase):
    def test_host_and_svi_echoes_round_trip_in_each_native_format(self):
        topology = routed_lab(True)
        topology["pdus"] = [
            dict(
                id="to-svi",
                source="0",
                target="switch",
                port="svi:10",
                protocol="icmp",
                ttl=64,
            ),
            dict(
                id="from-svi",
                source="switch",
                target="0",
                port="p0",
                protocol="icmp",
                ttl=48,
            ),
        ]
        for fmt in ("pkt", "pka", "pkz"):
            with self.subTest(fmt=fmt):
                raw = export_native(dict(network=topology, format=fmt))
                request = read_and_attach(raw, fmt)
                projected = request["network"]
                host = next(d for d in projected["devices"] if d["name"] == "Client-1")
                switch = next(
                    d for d in projected["devices"] if d["name"] == "VLAN-Switch"
                )
                self.assertEqual(
                    [
                        (p["source"], p["target"], p["port"], p["ttl"])
                        for p in projected["pdus"]
                    ],
                    [
                        (host["id"], switch["id"], "svi:10", 64),
                        (switch["id"], host["id"], host["ports"][0]["id"], 48),
                    ],
                )
                self.assertEqual(export_native(request), raw)
                projected["pdus"][0]["ttl"] = 35
                projected["pdus"][1]["ttl"] = 36
                reopened = import_native(export_native(request), fmt, "SVI echoes")[
                    "network"
                ]
                self.assertEqual([p["ttl"] for p in reopened["pdus"]], [35, 36])

    def test_svi_echo_edits_keep_native_only_packet_and_scenario_records(self):
        topology = routed_lab(True)
        topology["pdus"] = [
            dict(id="echo", source="0", target="switch", port="svi:10", protocol="icmp")
        ]
        raw = export_native(dict(network=topology, format="pkt"))
        root = open_document(raw, "pkt")
        scenario = root.find("SCENARIOSET/SCENARIO")
        opaque = deepcopy(scenario.find("PDU"))
        opaque.find("TYPE").text = "1"
        scenario.append(opaque)
        metadata = X.SubElement(scenario, "NATIVE_ONLY_STATE", future="retained")
        metadata.text = "synthetic opaque marker"
        original_packet, original_state = X.tostring(opaque), X.tostring(metadata)
        raw = save_document(root)
        request = read_and_attach(raw, "pkt")
        self.assertEqual(len(request["network"]["pdus"]), 1)
        self.assertEqual(export_native(request), raw)
        request["network"]["pdus"][0]["ttl"] = 24
        reopened = open_document(export_native(request), "pkt")
        preserved = reopened.find("SCENARIOSET/SCENARIO")
        self.assertEqual(X.tostring(preserved.find("PDU")), original_packet)
        self.assertEqual(
            X.tostring(preserved.find("NATIVE_ONLY_STATE")), original_state
        )

    def test_layer_two_switch_without_an_addressed_svi_cannot_source_native_echo(self):
        for multilayer in (False, True):
            topology = routed_lab(multilayer)
            switch = next(d for d in topology["devices"] if d["kind"] == "switch")
            for interface in switch["ports"]:
                interface["ip"] = ""
            topology["pdus"] = [
                dict(
                    id="invalid",
                    source="switch",
                    target="0",
                    port="p0",
                    protocol="icmp",
                )
            ]
            with self.subTest(multilayer=multilayer), self.assertRaisesRegex(
                ValueError, "addressed SVI"
            ):
                export_native(dict(network=topology, format="pkt"))
            topology["pdus"][0]["source"] = "1"
            root = open_document(
                export_native(dict(network=topology, format="pkt")), "pkt"
            )
            engine = next(
                e
                for e in root.findall("NETWORK/DEVICES/DEVICE/ENGINE")
                if e.findtext("TYPE") in ("Switch", "MultiLayerSwitch")
            )
            root.find("SCENARIOSET/SCENARIO/PDU/SOURCE").text = engine.findtext(
                "SAVE_REF_ID"
            )
            raw = save_document(root)
            request = read_and_attach(raw, "pkt")
            self.assertFalse(request["network"].get("pdus"))
            self.assertEqual(export_native(request), raw)

    def test_static_edit_replaces_dynamic_primary_and_keeps_secondary(self):
        for name in ("GigabitEthernet0/0", "GigabitEthernet0/0.10", "Vlan10"):
            multilayer = name == "Vlan10"
            original = export_native(dict(network=routed_lab(multilayer), format="pkt"))
            for dynamic in (
                "ip address dhcp",
                "ip address dhcp hostname router-client",
                "ip address negotiated",
            ):
                with self.subTest(name=name, dynamic=dynamic):
                    root = open_document(original, "pkt")
                    engine = next(
                        e
                        for e in root.findall("NETWORK/DEVICES/DEVICE/ENGINE")
                        if e.findtext("TYPE")
                        == ("MultiLayerSwitch" if multilayer else "Router")
                    )
                    lines = engine.find("RUNNINGCONFIG")
                    marker = next(n for n in lines if n.text == "interface " + name)
                    after = lines.index(marker) + 1
                    for node in list(lines)[after:]:
                        if not (node.text or "").startswith(" "):
                            break
                        if (
                            (node.text or "")
                            .strip()
                            .startswith(("ip address ", "no ip address"))
                        ):
                            lines.remove(node)
                    for command in (
                        dynamic,
                        "ip address 203.0.113.1 255.255.255.0 secondary",
                    ):
                        node = X.Element("LINE")
                        node.text = " " + command
                        lines.insert(after, node)
                    raw = save_document(root)
                    request = read_and_attach(raw, "pkt")
                    self.assertEqual(export_native(request), raw)
                    device = next(
                        d
                        for d in request["network"]["devices"]
                        if d["kind"] == ("switch" if multilayer else "router")
                    )
                    selected = next(p for p in device["ports"] if p["name"] == name)
                    selected["ip"] = "192.0.10.254"
                    edited = export_native(request)
                    result = open_document(edited, "pkt")
                    engine = next(
                        e
                        for e in result.findall("NETWORK/DEVICES/DEVICE/ENGINE")
                        if e.findtext("TYPE")
                        == ("MultiLayerSwitch" if multilayer else "Router")
                    )
                    commands = ios_sections(engine)[1][name]
                    self.assertNotIn(dynamic, commands)
                    self.assertIn("ip address 192.0.10.254 255.255.255.0", commands)
                    self.assertIn(
                        "ip address 203.0.113.1 255.255.255.0 secondary", commands
                    )

    def test_author_routing_variants_in_all_native_containers(self):
        for multilayer in (False, True):
            for fmt in ("pkt", "pka", "pkz"):
                with self.subTest(multilayer=multilayer, fmt=fmt):
                    raw = export_native(
                        dict(network=routed_lab(multilayer), format=fmt)
                    )
                    imported = import_native(raw, fmt, "Inter-VLAN")["network"]
                    routed = next(
                        d
                        for d in imported["devices"]
                        if d["kind"] == ("switch" if multilayer else "router")
                    )
                    logical = [p for p in routed["ports"] if p.get("virtual")]
                    self.assertEqual([p["virtual"]["vlan"] for p in logical], [10, 20])
                    self.assertEqual(
                        [p["ip"] for p in logical], ["192.0.10.1", "192.0.20.1"]
                    )
                    if multilayer:
                        self.assertTrue(routed["ipRouting"])
                    else:
                        for interface in logical:
                            parent = next(
                                p
                                for p in routed["ports"]
                                if p["id"] == interface["virtual"]["parent"]
                            )
                            self.assertFalse(parent.get("virtual"))

    def test_edit_add_remove_and_preserve_unknown_stanza_commands(self):
        raw = export_native(dict(network=routed_lab(), format="pkt"))
        root = open_document(raw, "pkt")
        eng = next(
            e
            for e in root.findall("NETWORK/DEVICES/DEVICE/ENGINE")
            if e.findtext("TYPE") == "Router"
        )
        lines = eng.find("RUNNINGCONFIG")
        marker = next(n for n in lines if n.text == "interface GigabitEthernet0/0.10")
        unknown = X.Element("LINE")
        unknown.text = " description retained native setting"
        lines.insert(lines.index(marker) + 1, unknown)
        secondary = X.Element("LINE")
        secondary.text = " ip address 203.0.113.1 255.255.255.0 secondary"
        lines.insert(lines.index(marker) + 2, secondary)
        from documents import save_document

        raw = save_document(root)
        data = read_and_attach(raw, "pkt")
        router = next(d for d in data["network"]["devices"] if d["kind"] == "router")
        logical = [p for p in router["ports"] if p.get("virtual")]
        self.assertEqual(logical[0]["ip"], "192.0.10.1")
        logical[0]["virtual"]["native"] = True
        logical[0]["helperAddresses"] = ["198.51.100.5"]
        logical[0]["ip"] = "192.0.10.254"
        router["ports"].remove(logical[1])
        router["ports"].append(
            port(
                "sub-new",
                "GigabitEthernet0/0.99",
                "",
                dict(kind="subinterface", parent=logical[0]["virtual"]["parent"]),
            )
        )
        edited = export_native(data)
        e = next(
            e
            for e in open_document(edited, "pkt").findall(
                "NETWORK/DEVICES/DEVICE/ENGINE"
            )
            if e.findtext("TYPE") == "Router"
        )
        _, sections = ios_sections(e)
        self.assertIn(
            "description retained native setting", sections["GigabitEthernet0/0.10"]
        )
        self.assertIn(
            "ip address 203.0.113.1 255.255.255.0 secondary",
            sections["GigabitEthernet0/0.10"],
        )
        self.assertIn(
            "encapsulation dot1Q 10 native", sections["GigabitEthernet0/0.10"]
        )
        self.assertIn(
            "ip helper-address 198.51.100.5", sections["GigabitEthernet0/0.10"]
        )
        self.assertNotIn("GigabitEthernet0/0.20", sections)
        self.assertIn("GigabitEthernet0/0.99", sections)

    def test_unchanged_native_source_and_unmapped_configuration_are_retained(self):
        for multilayer in (False, True):
            raw = export_native(dict(network=routed_lab(multilayer), format="pkt"))
            self.assertEqual(export_native(read_and_attach(raw, "pkt")), raw)

    def test_cannot_enable_routing_on_imported_layer_two_chassis(self):
        raw = export_native(dict(network=routed_lab(), format="pkt"))
        data = read_and_attach(raw, "pkt")
        switch = next(d for d in data["network"]["devices"] if d["kind"] == "switch")
        switch["ipRouting"] = True
        with self.assertRaisesRegex(ValueError, "chassis"):
            export_native(data)

    def test_rejects_virtual_cable_and_duplicate_name(self):
        topology = routed_lab()
        topology["links"][-1]["a"]["port"] = "subinterface:p0:10"
        with self.assertRaisesRegex(ValueError, "physical parent"):
            export_native(dict(network=topology, format="pkt"))
        topology = routed_lab()
        router = topology["devices"][-1]
        router["ports"].append({**deepcopy(router["ports"][-1]), "id": "duplicate"})
        with self.assertRaisesRegex(ValueError, "unique"):
            export_native(dict(network=topology, format="pkt"))
        topology = routed_lab(True)
        switch = topology["devices"][-1]
        switch["ports"].extend(
            port(f"svi:{v}", f"Vlan{v}", "", dict(kind="svi", vlan=v))
            for v in range(30, 35)
        )
        with self.assertRaisesRegex(ValueError, "32 native"):
            export_native(dict(network=topology, format="pkt"))

    def test_append_zero_subinterface_preserves_physical_ports_and_addresses(self):
        topology = routed_lab()
        router = topology["devices"][-1]
        router["ports"] = [p for p in router["ports"] if not p.get("virtual")]
        router["ports"].append(port("p1", "GigabitEthernet0/1", "198.51.100.1"))
        raw = export_native(dict(network=topology, format="pkt"))
        data = read_and_attach(raw, "pkt")
        router = next(d for d in data["network"]["devices"] if d["kind"] == "router")
        physical = deepcopy(router["ports"])
        router["ports"].append(
            port(
                "zero",
                "GigabitEthernet0/0.0",
                "",
                dict(kind="subinterface", parent="p0"),
            )
        )
        edited = export_native(data)
        result = import_native(edited, "pkt", "lab")["network"]
        output = next(d for d in result["devices"] if d["kind"] == "router")
        self.assertEqual([p for p in output["ports"] if not p.get("virtual")], physical)
        self.assertEqual(output["ports"][-1]["name"], "GigabitEthernet0/0.0")
        for source in (raw, edited):
            engine = next(
                e
                for e in open_document(source, "pkt").findall(
                    "NETWORK/DEVICES/DEVICE/ENGINE"
                )
                if e.findtext("TYPE") == "Router"
            )
            modules = [X.tostring(m) for m in engine.findall("MODULE")]
            if source == raw:
                original_modules = modules
            else:
                self.assertEqual(modules, original_modules)

    def test_edit_remove_svi_and_routing_toggle(self):
        raw = export_native(dict(network=routed_lab(True), format="pkt"))
        data = read_and_attach(raw, "pkt")
        switch = next(d for d in data["network"]["devices"] if d["kind"] == "switch")
        interfaces = [p for p in switch["ports"] if p.get("virtual")]
        switch["ports"].remove(interfaces[1])
        interfaces[0]["ip"] = "192.0.10.254"
        interfaces[0]["enabled"] = False
        interfaces[0]["helperAddresses"] = ["198.51.100.5"]
        switch["ipRouting"] = False
        edited = export_native(data)
        root = open_document(edited, "pkt")
        engine = next(
            e
            for e in root.findall("NETWORK/DEVICES/DEVICE/ENGINE")
            if e.findtext("TYPE") == "MultiLayerSwitch"
        )
        lines, stanzas = ios_sections(engine)
        self.assertIn("no ip routing", lines)
        self.assertNotIn("Vlan20", stanzas)
        self.assertIn("shutdown", stanzas["Vlan10"])
        self.assertIn("ip address 192.0.10.254 255.255.255.0", stanzas["Vlan10"])
        self.assertIn("ip helper-address 198.51.100.5", stanzas["Vlan10"])
