"""Synthetic DHCP native coverage; full containers run in cloud CI."""

from copy import deepcopy
import unittest
from lxml import etree as X

from dhcp import authored, empty_services, project, update
from documents import current_network, open_document, save_document
from packages import read_package, write_package
from serve import export_native, import_native
from test_native import lab, read_and_attach


def pool(identifier="pool", name="Clients", start="192.0.2.50"):
    return dict(
        id=identifier, name=name, start=start, prefix=24, count=8,
        gateway="192.0.2.1", dns="", tftp="192.0.2.2",
    )


def device():
    return dict(
        kind="server",
        ports=[dict(id="p0", name="FastEthernet0", media="copper")],
        services={
            "dhcp": {"enabled": True, "pools": [pool()], "leases": []},
            "dns": {"enabled": False, "records": []},
            "http": {"enabled": False, "pages": []},
        },
    )


def synthetic():
    engine = X.Element("ENGINE")
    X.SubElement(engine, "TYPE").text = "Server"
    for tag in ("DNS_SERVER", "HTTP_SERVER"):
        section = X.SubElement(engine, tag)
        X.SubElement(section, "ENABLED").text = "0"
        X.SubElement(section, "OPAQUE").text = "retain synthetic service"
    authored(engine, device(), {"p0": "FastEthernet0"})
    visible, _ = project(engine, device()["ports"])
    before = dict(device(), services=visible)
    return engine, before


def native_network(raw, fmt):
    if fmt == "pkz":
        package = read_package(raw)
        raw, fmt = package.document, package.format
    return current_network(open_document(raw, fmt))


class DhcpProjection(unittest.TestCase):
    def test_bounded_pool_projection_has_no_leases_and_default_duration(self):
        engine, before = synthetic()
        raw = engine.find(".//POOL")
        leases = raw.find("DHCP_POOL_LEASES")
        X.SubElement(leases, "DHCP_POOL_LEASE").text = "transient synthetic state"
        services, opaque = project(engine, before["ports"])
        self.assertFalse(opaque)
        self.assertEqual(services["dhcp"]["pools"], [{**pool(), "id": "native-dhcp-0"}])
        self.assertEqual(services["dhcp"]["leases"], [])
        self.assertNotIn("leaseSeconds", services["dhcp"]["pools"][0])
        self.assertEqual(raw.findtext("END_IP"), "192.0.2.57")
        self.assertEqual(raw.findtext("MAX_USERS"), "8")
        self.assertEqual(raw.findtext("LEASE_TIME"), "86400000")
        self.assertEqual(services["dns"], {"enabled": False, "records": []})
        self.assertEqual(services["http"], {"enabled": False, "pages": []})

    def test_dhcp_edits_preserve_other_services_and_unchanged_pool_state(self):
        engine, before = synthetic()
        before["services"]["dhcp"]["pools"].append(pool("second", "Branch", "198.51.100.50") | {"gateway": "198.51.100.1"})
        # Create the second pool through the supported edit path.
        projected, _ = project(engine, before["ports"])
        update(engine, dict(before, services=projected), before, {"p0": "FastEthernet0"})
        projected, _ = project(engine, before["ports"])
        before["services"] = projected
        first, second = engine.findall(".//POOL")
        X.SubElement(first.find("DHCP_POOL_LEASES"), "DHCP_POOL_LEASE").text = "stale"
        X.SubElement(second.find("DHCP_POOL_LEASES"), "DHCP_POOL_LEASE").text = "retain"
        other = [X.tostring(engine.find(tag)) for tag in ("DNS_SERVER", "HTTP_SERVER")]
        second_bytes = X.tostring(second)
        after = deepcopy(before)
        after["services"]["dhcp"]["pools"][0]["start"] = "192.0.2.60"
        update(engine, before, after, {"p0": "FastEthernet0"})
        first, second = engine.findall(".//POOL")
        self.assertEqual(first.findtext("START_IP"), "192.0.2.60")
        self.assertEqual(first.findtext("END_IP"), "192.0.2.67")
        self.assertEqual(len(first.find("DHCP_POOL_LEASES")), 0)
        self.assertEqual(X.tostring(second), second_bytes)
        self.assertEqual([X.tostring(engine.find(tag)) for tag in ("DNS_SERVER", "HTTP_SERVER")], other)

    def test_noop_defaults_and_runtime_leases_preserve_native_bytes(self):
        engine, before = synthetic()
        original = X.tostring(engine)
        after = deepcopy(before)
        after["services"]["dhcp"]["pools"][0]["leaseSeconds"] = 86400
        after["services"]["dhcp"]["pools"][0]["id"] = "different-local-identifier"
        after["services"]["dhcp"]["leases"] = [{"synthetic": "ignored runtime"}]
        after["services"]["http"]["pages"] = [{"path": "/", "body": "Welcome to your CertSim lab server."}]
        update(engine, before, after, {"p0": "FastEthernet0"})
        self.assertEqual(X.tostring(engine), original)

    def test_opaque_pool_options_and_ambiguous_bindings_are_guarded(self):
        def mutate(engine, variant):
            raw = engine.find(".//POOL")
            if variant == "duplicate_binding":
                parent = engine.find("DHCP_SERVERS/ASSOCIATED_PORTS")
                parent.append(deepcopy(parent[0]))
            elif variant == "reservation":
                X.SubElement(engine.find(".//DHCP_RESERVATIONS"), "RESERVATION")
            elif variant == "unknown_tag":
                X.SubElement(raw, "FUTURE_OPTION").text = "set"
            elif variant == "duplicate_field":
                X.SubElement(raw, "MAX_USERS").text = "8"
            else:
                values = {"LEASE_TIME": "3600000", "DOMAIN_NAME": "example.test", "WLC_ADDRESS": "192.0.2.100", "END_IP": "192.0.2.58", "MASK": "255.0.255.0", "MAX_USERS": "512"}
                item = raw.find(variant)
                if item is None:
                    item = X.SubElement(raw, variant)
                item.text = values[variant]
        for variant in ("duplicate_binding", "reservation", "unknown_tag", "duplicate_field", "LEASE_TIME", "DOMAIN_NAME", "WLC_ADDRESS", "END_IP", "MASK", "MAX_USERS"):
            with self.subTest(variant=variant):
                engine, before = synthetic()
                mutate(engine, variant)
                self.assertEqual(project(engine, before["ports"]), (None, True))
                hidden = dict(before)
                hidden.pop("services")
                original = X.tostring(engine)
                update(engine, hidden, dict(hidden, note="Unrelated"), {"p0": "FastEthernet0"})
                self.assertEqual(X.tostring(engine), original)
                with self.assertRaisesRegex(ValueError, "source is preserved"):
                    update(engine, hidden, before, {"p0": "FastEthernet0"})
                self.assertEqual(X.tostring(engine), original)

    def test_authored_service_replaces_donor_and_disables_unconfigured_services(self):
        engine, before = synthetic()
        https = X.SubElement(engine, "HTTPS_SERVER")
        X.SubElement(https, "HTTPSENABLED").text = "1"
        parent = engine.find("DHCP_SERVERS/ASSOCIATED_PORTS")
        parent.append(deepcopy(parent[0]))
        for tag in ("DNS_SERVER", "HTTP_SERVER"):
            engine.find(tag + "/ENABLED").text = "1"
        fresh = deepcopy(device())
        fresh.pop("services")
        authored(engine, fresh, {"p0": "FastEthernet0"})
        self.assertEqual(project(engine, fresh["ports"]), (empty_services(), False))
        self.assertEqual(len(engine.findall("DHCP_SERVERS/ASSOCIATED_PORTS/ASSOCIATED_PORT")), 1)
        self.assertEqual(engine.findall(".//POOL"), [])
        self.assertEqual(engine.findtext("HTTPS_SERVER/HTTPSENABLED"), "0")
        for tag in ("DNS_SERVER", "HTTP_SERVER"):
            self.assertEqual(engine.findtext(tag + "/ENABLED"), "0")
            self.assertEqual(engine.findtext(tag + "/OPAQUE"), "retain synthetic service")

    def test_disabled_native_placeholder_can_be_configured_without_faking_a_pool(self):
        engine, before = synthetic()
        raw = engine.find(".//POOL")
        for tag in ("NETWORK", "MASK", "DEFAULT_ROUTER", "TFTP_ADDRESS", "START_IP", "DNS_SERVER"):
            raw.find(tag).text = "0.0.0.0"
        raw.find("NAME").text = "serverPool"
        raw.find("END_IP").text = "0.0.2.0"
        raw.find("MAX_USERS").text = "512"
        engine.find(".//DHCP_SERVER/ENABLED").text = "0"
        services, opaque = project(engine, before["ports"])
        self.assertFalse(opaque)
        self.assertEqual(services, empty_services())
        update(engine, dict(before, services=services), device(), {"p0": "FastEthernet0"})
        projected, opaque = project(engine, before["ports"])
        self.assertFalse(opaque)
        self.assertTrue(projected["dhcp"]["enabled"])
        self.assertEqual(projected["dhcp"]["pools"][0]["start"], "192.0.2.50")

    def test_author_rejects_custom_durations_services_and_invalid_pools(self):
        for field, value in (("leaseSeconds", 3600), ("count", 257), ("start", "192.0.2.0"), ("prefix", 31), ("gateway", "198.51.100.1"), ("tftp", "224.0.0.1"), ("count", True)):
            with self.subTest(field=field):
                candidate = device()
                candidate["services"]["dhcp"]["pools"][0][field] = value
                with self.assertRaises(ValueError):
                    authored(X.Element("ENGINE"), candidate, {"p0": "FastEthernet0"})
        for service, field, value in (("dns", "enabled", True), ("http", "enabled", True), ("http", "pages", [{"path": "/", "body": "custom"}])):
            candidate = device()
            candidate["services"][service][field] = value
            with self.assertRaisesRegex(ValueError, "DNS|HTTP"):
                authored(X.Element("ENGINE"), candidate, {"p0": "FastEthernet0"})
        candidate = device()
        candidate["ports"].append({"id": "p1", "name": "FastEthernet1", "media": "copper"})
        with self.assertRaisesRegex(ValueError, "single-interface"):
            authored(X.Element("ENGINE"), candidate, {"p0": "FastEthernet0", "p1": "FastEthernet1"})

    def test_unmapped_native_service_notices_do_not_block_dhcp_edits(self):
        engine, before = synthetic()
        engine.find("HTTP_SERVER/ENABLED").text = "1"
        services, opaque = project(engine, before["ports"])
        self.assertTrue(opaque)
        self.assertEqual(services, before["services"])
        after = deepcopy(before)
        after["services"]["dhcp"]["enabled"] = False
        update(engine, before, after, {"p0": "FastEthernet0"})
        self.assertEqual(engine.findtext("HTTP_SERVER/ENABLED"), "1")
        self.assertEqual(engine.findtext(".//DHCP_SERVER/ENABLED"), "0")

    def test_pool_removal_disable_and_missing_fields_fail_atomically(self):
        engine, before = synthetic()
        original = X.tostring(engine)
        after = deepcopy(before)
        del after["services"]["dhcp"]["pools"][0]["start"]
        with self.assertRaises(ValueError):
            update(engine, before, after, {"p0": "FastEthernet0"})
        self.assertEqual(X.tostring(engine), original)
        after = deepcopy(before)
        after["services"]["dhcp"].update(enabled=False, pools=[])
        update(engine, before, after, {"p0": "FastEthernet0"})
        self.assertEqual(project(engine, after["ports"])[0], empty_services())


class DhcpContainers(unittest.TestCase):
    def test_all_native_containers_author_edit_reopen_and_noop(self):
        for fmt in ("pkt", "pka", "pkz"):
            with self.subTest(format=fmt):
                topology = lab()
                server = topology["devices"][1]
                server["kind"] = "server"
                server["services"] = device()["services"]
                raw = export_native(dict(network=topology, format=fmt))
                files = read_and_attach(raw, fmt)
                imported = files["network"]
                imported_server = next(d for d in imported["devices"] if d["kind"] == "server")
                self.assertEqual(imported_server["services"]["dhcp"]["pools"][0]["start"], "192.0.2.50")
                self.assertEqual(export_native(files), raw)
                imported_server["services"]["dhcp"]["pools"][0]["start"] = "192.0.2.60"
                imported_server["services"]["dhcp"]["pools"][0]["dns"] = "192.0.2.2"
                saved = export_native(files)
                restored = import_native(saved, fmt, "edited")["network"]
                actual = next(d for d in restored["devices"] if d["kind"] == "server")["services"]["dhcp"]
                self.assertEqual(actual["pools"][0]["start"], "192.0.2.60")
                self.assertEqual(actual["pools"][0]["dns"], "192.0.2.2")
                self.assertEqual(actual["leases"], [])
                engine = next(e for e in native_network(saved, fmt).findall("NETWORK/DEVICES/DEVICE/ENGINE") if e.findtext("TYPE") == "Server")
                self.assertEqual(engine.findtext(".//POOL/END_IP"), "192.0.2.67")
                self.assertEqual(engine.findtext("HTTP_SERVER/ENABLED"), "0")
                self.assertEqual(engine.findtext("DNS_SERVER/ENABLED"), "0")

    def test_opaque_import_keeps_source_and_allows_unrelated_edit(self):
        topology = lab()
        topology["devices"][1]["kind"] = "server"
        topology["devices"][1]["services"] = device()["services"]
        raw = export_native(dict(network=topology, format="pkt"))
        root = open_document(raw, "pkt")
        engine = next(e for e in root.findall("NETWORK/DEVICES/DEVICE/ENGINE") if e.findtext("TYPE") == "Server")
        X.SubElement(engine.find(".//POOL"), "FUTURE_OPTION").text = "opaque"
        source_service = X.tostring(engine.find("DHCP_SERVERS"))
        raw = save_document(root)
        files = read_and_attach(raw, "pkt")
        server = next(d for d in files["network"]["devices"] if d["kind"] == "server")
        self.assertEqual(server["services"]["dhcp"], empty_services()["dhcp"])
        self.assertEqual(export_native(files), raw)
        server["note"] = "An unrelated edit"
        edited = open_document(export_native(files), "pkt")
        engine = next(e for e in edited.findall("NETWORK/DEVICES/DEVICE/ENGINE") if e.findtext("TYPE") == "Server")
        self.assertEqual(X.tostring(engine.find("DHCP_SERVERS")), source_service)
        server["services"] = device()["services"]
        with self.assertRaisesRegex(ValueError, "source is preserved"):
            export_native(files)


if __name__ == "__main__":
    unittest.main()
