"""Independent service families; native containers run only in cloud CI."""

from copy import deepcopy
import unittest
from lxml import etree as X

import dhcp
import server_services
from test_dhcp import device, native_network
from test_http_service import synthetic_http_engine, http_value


def services():
    result = device()["services"]
    result["dns"] = {"enabled": True, "records": [
        {"name": "certsim.lab", "type": "A", "value": "192.0.2.2"},
        {"name": "certsim.lab", "type": "AAAA", "value": "2001:db8::2", "ttl": 60},
        {"name": "www.certsim.lab", "type": "CNAME", "value": "certsim.lab", "ttl": 90},
    ]}
    result["http"] = http_value()
    return result


def synthetic():
    engine = synthetic_http_engine()
    source = device()
    source["services"] = services()
    server_services.authored(engine, source, {"p0": "FastEthernet0"})
    source["services"], omitted = server_services.project(engine, source["ports"])
    assert not omitted
    return engine, source


class ServiceFamilies(unittest.TestCase):
    def test_supported_families_project_together_and_defaults_are_noops(self):
        engine, before = synthetic()
        original = X.tostring(engine)
        self.assertEqual(before["services"]["dns"]["records"][0]["ttl"], 300)
        after = deepcopy(before)
        del after["services"]["dns"]["records"][0]["ttl"]
        after["services"]["http"]["pages"][0]["path"] = "/index.html"
        after["services"]["dhcp"]["pools"][0]["leaseSeconds"] = 86400
        server_services.update(engine, before, after, {"p0": "FastEthernet0"})
        self.assertEqual(X.tostring(engine), original)

    def test_opaque_family_does_not_block_other_edits_and_stays_guarded(self):
        for family, tag in (("dns", "DNS_SERVER"), ("http", "HTTP_SERVER"), ("dhcp", "DHCP_SERVERS")):
            with self.subTest(family=family):
                engine, before = synthetic()
                node = engine.find(tag)
                X.SubElement(node, "FUTURE_SETTING").text = "retain synthetic source"
                opaque = X.tostring(node)
                projected, omitted = server_services.project(engine, before["ports"])
                self.assertEqual(omitted, {family.upper() + " server settings": 1})
                self.assertEqual(projected[family], dhcp.empty_services()[family])
                before["services"] = projected
                after = deepcopy(before)
                editable = "http" if family == "dns" else "dns"
                after["services"][editable]["enabled"] = False
                server_services.update(engine, before, after, {"p0": "FastEthernet0"})
                self.assertEqual(X.tostring(engine.find(tag)), opaque)
                self.assertFalse(server_services.project(engine, before["ports"])[0][editable]["enabled"])
                changed = deepcopy(after)
                changed["services"][family] = services()[family]
                original = X.tostring(engine)
                with self.assertRaisesRegex(ValueError, "source is preserved"):
                    server_services.update(engine, after, changed, {"p0": "FastEthernet0"})
                self.assertEqual(X.tostring(engine), original)

    def test_later_http_guard_rolls_back_dhcp_and_dns_changes(self):
        engine, before = synthetic()
        engine.find("HTTP_SERVER/USERNAME").text = "synthetic-account"
        before["services"], _ = server_services.project(engine, before["ports"])
        after = deepcopy(before)
        after["services"]["dhcp"]["pools"][0]["start"] = "192.0.2.60"
        after["services"]["dns"]["records"][0]["ttl"] = 120
        after["services"]["http"] = http_value()
        original = X.tostring(engine)
        with self.assertRaisesRegex(ValueError, "source is preserved"):
            server_services.update(engine, before, after, {"p0": "FastEthernet0"})
        self.assertEqual(X.tostring(engine), original)

    def test_https_source_is_flagged_and_preserved_through_all_service_edits(self):
        engine, before = synthetic()
        engine.find("HTTPS_SERVER/HTTPSENABLED").text = "1"
        original = X.tostring(engine.find("HTTPS_SERVER"))
        before["services"], omitted = server_services.project(engine, before["ports"])
        self.assertEqual(omitted, {"HTTPS server settings": 1})
        after = deepcopy(before)
        after["services"]["dhcp"]["enabled"] = False
        after["services"]["dns"]["enabled"] = False
        after["services"]["http"]["enabled"] = False
        server_services.update(engine, before, after, {"p0": "FastEthernet0"})
        self.assertEqual(X.tostring(engine.find("HTTPS_SERVER")), original)


class ServiceContainers(unittest.TestCase):
    def test_all_native_containers_author_edit_reopen_and_noop(self):
        from serve import export_native
        from test_native import lab, read_and_attach

        for fmt in ("pkt", "pka", "pkz"):
            with self.subTest(format=fmt):
                topology = lab()
                server = topology["devices"][1]
                server.update(kind="server", services=services())
                raw = export_native(dict(network=topology, format=fmt))
                files = read_and_attach(raw, fmt)
                imported = next(d for d in files["network"]["devices"] if d["kind"] == "server")
                projected = imported["services"]
                self.assertEqual(projected["dns"]["records"], [
                    {**r, "ttl": r.get("ttl", 300)} for r in services()["dns"]["records"]
                ])
                self.assertEqual(projected["http"], services()["http"])
                self.assertEqual(projected["dhcp"]["pools"][0]["start"], "192.0.2.50")
                self.assertEqual(export_native(files), raw)
                projected["dns"]["records"][0]["value"] = "192.0.2.3"
                projected["dns"]["records"][2]["ttl"] = 30
                projected["http"]["pages"][0]["body"] = "CertSim café <b>literal text</b> 🌍\r\n"
                projected["dhcp"]["pools"][0]["dns"] = "192.0.2.3"
                edited = export_native(files)
                reopened = read_and_attach(edited, fmt)
                restored = next(d for d in reopened["network"]["devices"] if d["kind"] == "server")["services"]
                self.assertEqual(restored, projected)
                self.assertEqual(export_native(reopened), edited)
                engine = next(e for e in native_network(edited, fmt).findall("NETWORK/DEVICES/DEVICE/ENGINE") if e.findtext("TYPE") == "Server")
                stores = engine.xpath('./FILE_MANAGER/FILE/FILES/FILE[NAME="http:"]')
                self.assertTrue(stores)
                for store in stores:
                    self.assertEqual(store.findtext("FILES/FILE/NAME"), "index.html")
                    self.assertEqual(store.findtext("FILES/FILE/FILE_CONTENT/TEXT"), restored["http"]["pages"][0]["body"])


if __name__ == "__main__":
    unittest.main()
