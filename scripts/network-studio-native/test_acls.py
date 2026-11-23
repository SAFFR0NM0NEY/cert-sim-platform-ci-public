"""Synthetic IPv4 ACL semantics; native-container cases run in cloud CI."""
from copy import deepcopy
from hashlib import sha256
import unittest

from lxml import etree as X
from acls import guard, parse_rule, project, update, validate
from editing import set_lines
from network import ios_sections


def rule(action="permit", protocol="ip", **extra):
    return dict(action=action, protocol=protocol, source="0.0.0.0", sourcePrefix=0,
                destination="0.0.0.0", destinationPrefix=0, **extra)


def fixture(body=None, interface=None, kind="Router"):
    engine = X.Element("ENGINE")
    X.SubElement(engine, "TYPE").text = kind
    X.SubElement(engine, "OPAQUE").text = "retained"
    lines = ["version 15.1", "interface GigabitEthernet0/0", " ip address 192.0.2.1 255.255.255.0"]
    lines += [" " + line for line in (interface if interface is not None else ["ip access-group POLICY in"])]
    lines += ["!", "ip access-list extended POLICY"]
    lines += [" " + line for line in (body if body is not None else ["permit tcp any host 198.51.100.10 eq www", "deny ip any any"])]
    lines += ["!", "ip route 203.0.113.0 255.255.255.0 192.0.2.2", "end"]
    set_lines(engine, "RUNNINGCONFIG", lines)
    ports = [dict(id="p0", name="GigabitEthernet0/0", media="copper", enabled=True, ip="192.0.2.1", prefix=24, vlan=1, mode="access", allowedVlans=[1])]
    return engine, ports


def device_from(engine, ports):
    lists, bindings, hidden = project(engine, ports)
    device = dict(kind="router", ports=deepcopy(ports))
    if lists is not None:
        device["accessLists"] = lists
    for port in device["ports"]:
        port.update(bindings.get(port["id"], {}))
    return device, hidden


class NativeAclSynthetic(unittest.TestCase):
    def test_ordered_extended_rules_bindings_and_wildcards(self):
        engine, ports = fixture()
        device, hidden = device_from(engine, ports)
        self.assertEqual(hidden, 0)
        self.assertEqual(device["ports"][0]["inboundAcl"], "POLICY")
        rules = device["accessLists"][0]["rules"]
        self.assertEqual(rules[0]["destinationPort"], 80)
        self.assertEqual(rules[0]["destinationPrefix"], 32)
        self.assertEqual(rules[1]["action"], "deny")
        self.assertEqual(parse_rule("permit ip 192.0.2.7 0.0.0.255 any", "extended")["source"], "192.0.2.0")
        self.assertEqual(parse_rule("permit ip 192.0.2.7 0.0.0.0 any", "extended")["sourcePrefix"], 32)
        self.assertEqual(parse_rule("permit ip 0.0.0.0 255.255.255.255 any", "extended")["sourcePrefix"], 0)

    def test_unsupported_rule_never_projects_partial_allow(self):
        for unsupported in (
            "permit tcp any any established", "permit ip any any log",
            "permit icmp any any echo", "permit udp any eq 53 any",
            "permit tcp any any range 80 90", "permit ip 10.0.0.0 0.255.0.255 any",
            "permit ip 10.0.0.0 255.0.0.0 any",
            "permit gre any any", "permit ip any any time-range WORK",
            "permit ip any host", "permit tcp any any eq 0", "permit tcp any any eq unknown",
        ):
            with self.subTest(unsupported=unsupported):
                engine, ports = fixture(["permit ip any any", unsupported])
                self.assertEqual(project(engine, ports)[0:2], (None, {}))
                self.assertGreater(project(engine, ports)[2], 0)
                before, _ = device_from(engine, ports)
                source = X.tostring(engine)
                update(engine, before, {**before, "note": "unrelated"}, {"p0": ports[0]["name"]})
                self.assertEqual(source, X.tostring(engine))
                with self.assertRaisesRegex(ValueError, "source is preserved"):
                    guard(engine, before, {**before, "accessLists": [dict(name="NEW", rules=[rule()])]})

    def test_numbered_standard_and_extended_preserve_family(self):
        engine, ports = fixture(interface=["ip access-group 10 in", "ip access-group 110 out"])
        set_lines(engine, "RUNNINGCONFIG", [
            "interface GigabitEthernet0/0", " ip access-group 10 in", " ip access-group 110 out", "!",
            "access-list 10 permit 192.0.2.0 0.0.0.255", "access-list 10 deny any",
            "access-list 110 permit udp any any eq domain", "end"])
        before, hidden = device_from(engine, ports)
        self.assertEqual(hidden, 0)
        self.assertEqual([a["name"] for a in before["accessLists"]], ["10", "110"])
        self.assertEqual(before["accessLists"][0]["rules"][0]["destinationPrefix"], 0)
        after = deepcopy(before)
        after["accessLists"][0]["rules"][0]["action"] = "deny"
        after["accessLists"][1]["rules"][0]["destinationPort"] = 123
        update(engine, before, after, {"p0": ports[0]["name"]})
        lines, _ = ios_sections(engine)
        self.assertIn("access-list 10 deny 192.0.2.0 0.0.0.255", lines)
        self.assertIn("access-list 110 permit udp any any eq 123", lines)
        self.assertEqual(device_from(engine, ports)[0], after)
        after["accessLists"][0]["rules"][0]["protocol"] = "tcp"
        with self.assertRaisesRegex(ValueError, "standard ACL number"):
            validate(after, {"p0": ports[0]["name"]})

    def test_remarks_unrelated_xml_and_noop_preserved(self):
        engine, ports = fixture(["remark keep this explanation", "10 permit ip any any", "20 deny ip any any"])
        before, _ = device_from(engine, ports)
        source = X.tostring(engine)
        update(engine, before, deepcopy(before), {"p0": ports[0]["name"]})
        self.assertEqual(source, X.tostring(engine))
        after = deepcopy(before)
        after["accessLists"][0]["rules"][0]["protocol"] = "icmp"
        after["ports"][0]["inboundAcl"] = ""
        after["ports"][0]["outboundAcl"] = "POLICY"
        update(engine, before, after, {"p0": ports[0]["name"]})
        lines, interfaces = ios_sections(engine)
        self.assertIn(" remark keep this explanation", lines)
        self.assertIn("ip route 203.0.113.0 255.255.255.0 192.0.2.2", lines)
        self.assertNotIn("ip access-group POLICY in", interfaces[ports[0]["name"]])
        self.assertIn("ip access-group POLICY out", interfaces[ports[0]["name"]])
        self.assertEqual(engine.findtext("OPAQUE"), "retained")

    def test_empty_duplicate_and_xml_policies_are_opaque(self):
        for body in ([], ["remark only a comment"]):
            engine, ports = fixture(body)
            self.assertIsNone(project(engine, ports)[0])
        engine, ports = fixture()
        lines, _ = ios_sections(engine)
        set_lines(engine, "RUNNINGCONFIG", lines[:-1] + ["ip access-list extended POLICY", " permit ip any any", "end"])
        self.assertIsNone(project(engine, ports)[0])
        engine, ports = fixture()
        X.SubElement(X.SubElement(X.SubElement(engine, "ACL_PROCESS"), "ACLS"), "ACL").text = "unmodeled"
        before, hidden = device_from(engine, ports)
        self.assertGreater(hidden, 0)
        self.assertNotIn("accessLists", before)
        after = deepcopy(before)
        after["accessLists"] = [dict(name="POLICY", rules=[rule("deny")])]
        with self.assertRaisesRegex(ValueError, "source is preserved"):
            guard(engine, before, after)

    def test_missing_ambiguous_and_unmapped_bindings_are_guarded(self):
        for bindings in (
            ["ip access-group MISSING in"],
            ["ip access-group POLICY in", "ip access-group POLICY in"],
            ["ip access-group POLICY in log"], ["no ip access-group POLICY in"],
        ):
            engine, ports = fixture(interface=bindings)
            before, hidden = device_from(engine, ports)
            self.assertGreater(hidden, 0)
            self.assertNotIn("inboundAcl", before["ports"][0])
            after = deepcopy(before)
            after["accessLists"] = []
            with self.assertRaisesRegex(ValueError, "source is preserved"):
                guard(engine, before, after)
        engine, ports = fixture()
        lines, _ = ios_sections(engine)
        set_lines(engine, "RUNNINGCONFIG", lines[:-1] + ["interface Tunnel99", " ip access-group POLICY out", "end"])
        before, hidden = device_from(engine, ports)
        self.assertGreater(hidden, 0)
        with self.assertRaises(ValueError):
            guard(engine, before, {**before, "accessLists": []})

    def test_native_consumers_block_list_deletion(self):
        for consumer in (
            "ip nat inside source list POLICY interface GigabitEthernet0/0 overload",
            " access-class POLICY in",
            " match ip address POLICY",
            " distribute-list POLICY in",
        ):
            engine, ports = fixture()
            lines, _ = ios_sections(engine)
            set_lines(engine, "RUNNINGCONFIG", lines[:-1] + ["!", consumer, "end"])
            before, _ = device_from(engine, ports)
            after = deepcopy(before)
            after["accessLists"] = []
            after["ports"][0].pop("inboundAcl")
            with self.assertRaisesRegex(ValueError, "still references"):
                guard(engine, before, after)
            after = deepcopy(before)
            after["accessLists"][0]["rules"][0]["action"] = "deny"
            with self.assertRaisesRegex(ValueError, "still references"):
                guard(engine, before, after)

    def test_author_remaps_router_svi_and_portchannel_bindings(self):
        for kind, raw_kind, virtual in (
            ("router", "Router", {"kind": "subinterface", "parent": "p0", "vlan": 10}),
            ("switch", "MultilayerSwitch", {"kind": "svi", "vlan": 10}),
            ("switch", "MultilayerSwitch", {"kind": "portchannel", "group": 1}),
        ):
            engine = X.Element("ENGINE")
            X.SubElement(engine, "TYPE").text = raw_kind
            set_lines(engine, "RUNNINGCONFIG", ["end"])
            port = dict(id="logical", name="Generic", virtual=virtual, inboundAcl="APP", outboundAcl="APP")
            if virtual["kind"] == "portchannel":
                port["routed"] = True
            name = "Vlan10" if virtual["kind"] == "svi" else "Port-channel1" if virtual["kind"] == "portchannel" else "FastEthernet4/0.10"
            after = dict(kind=kind, ports=[port], accessLists=[dict(name="APP", rules=[rule()])])
            update(engine, {"ports": []}, after, {"logical": name})
            lists, bindings, hidden = project(engine, [{**port, "name": name}])
            self.assertEqual(hidden, 0)
            self.assertEqual(lists, after["accessLists"])
            self.assertEqual(bindings["logical"], {"inboundAcl": "APP", "outboundAcl": "APP"})

    def test_validation_rejects_lossy_or_malformed_policies(self):
        base = dict(kind="router", ports=[dict(id="p0", inboundAcl="APP")], accessLists=[dict(name="APP", rules=[rule()])])
        for acl in (
            dict(name="APP", rules=[]), dict(name="0", rules=[rule()]),
            dict(name="300", rules=[rule()]), dict(name="bad name", rules=[rule()]),
            dict(name="APP", rules=[{**rule(), "source": "192.0.2.3", "sourcePrefix": 24}]),
            dict(name="APP", rules=[{**rule(), "destinationPort": 80}]),
            dict(name="APP", rules=[{**rule("permit", "tcp"), "destinationPort": True}]),
            dict(name="APP", rules=[{**rule("permit", "tcp"), "destinationPort": None}]),
            dict(name="APP", rules=[{**rule(), "log": True}]),
        ):
            with self.subTest(acl=acl):
                with self.assertRaises(ValueError):
                    validate({**base, "accessLists": [acl]}, {"p0": "GigabitEthernet0/0"})
        with self.assertRaisesRegex(ValueError, "routed interfaces"):
            validate({**base, "kind": "switch"}, {"p0": "FastEthernet0/1"})
        with self.assertRaisesRegex(ValueError, "existing ACL"):
            validate({**base, "ports": [{"id": "p0", "inboundAcl": "MISSING"}]}, {"p0": "GigabitEthernet0/0"})


class NativeAclContainers(unittest.TestCase):
    def test_author_edit_remove_and_noop_in_all_formats(self):
        from serve import export_native
        from test_native import read_and_attach
        from test_virtuals import routed_lab

        for fmt in ("pkt", "pka", "pkz"):
            for multilayer in (False, True):
                with self.subTest(format=fmt, multilayer=multilayer):
                    topology = routed_lab(multilayer)
                    router = next(d for d in topology["devices"] if d["kind"] == ("switch" if multilayer else "router"))
                    router["accessLists"] = [dict(name="CLIENTS", rules=[rule("deny", "icmp"), rule()])]
                    logical = next(p for p in router["ports"] if p.get("virtual"))
                    logical["inboundAcl"] = "CLIENTS"
                    raw = export_native(dict(network=topology, format=fmt))
                    request = read_and_attach(raw, fmt)
                    self.assertEqual(sha256(export_native(request)).digest(), sha256(raw).digest())
                    device = next(d for d in request["network"]["devices"] if d.get("accessLists"))
                    interface = next(p for p in device["ports"] if p.get("inboundAcl"))
                    self.assertEqual(interface["inboundAcl"], "CLIENTS")
                    device["accessLists"][0]["rules"][0]["action"] = "permit"
                    interface["inboundAcl"] = ""
                    interface["outboundAcl"] = "CLIENTS"
                    request = read_and_attach(export_native(request), fmt)
                    device = next(d for d in request["network"]["devices"] if d.get("accessLists"))
                    self.assertEqual(device["accessLists"][0]["rules"][0]["action"], "permit")
                    interface = next(p for p in device["ports"] if p.get("outboundAcl"))
                    self.assertEqual(interface["outboundAcl"], "CLIENTS")
                    interface["outboundAcl"] = ""
                    device.pop("accessLists")
                    cleared = read_and_attach(export_native(request), fmt)["network"]
                    self.assertFalse(any(d.get("accessLists") for d in cleared["devices"]))


if __name__ == "__main__":
    unittest.main()
