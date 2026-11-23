"""Small synthetic DNS service tests; container/GUI checks run separately in CI."""

from copy import deepcopy
import unittest

from lxml import etree as X

from dns_service import authored, empty, project, update, validate


def record(name="certsim.lab", kind="A", value="192.0.2.80", ttl=None):
    result = {"name": name, "type": kind, "value": value}
    if ttl is not None:
        result["ttl"] = ttl
    return result


def settings(*records, enabled=True):
    return {"enabled": enabled, "records": list(records)}


def engine():
    return X.fromstring(
        b"<ENGINE><TYPE>Server</TYPE><DHCP_SERVERS><OPAQUE>keep DHCP</OPAQUE></DHCP_SERVERS>"
        b"<HTTP_SERVER><ENABLED>1</ENABLED><OPAQUE>keep HTTP</OPAQUE></HTTP_SERVER>"
        b"<DNS_CACHE><OPAQUE>keep cache</OPAQUE></DNS_CACHE></ENGINE>"
    )


def native():
    root = engine()
    dns = X.fromstring(
        b"<DNS_SERVER>\n <ENABLED>1</ENABLED><NAMESERVER-DATABASE>\n"
        b" <RESOURCE-RECORD><TYPE>A-REC</TYPE><NAME>CertSim.Lab.</NAME><TTL>00300</TTL>"
        b"<IPADDRESS>192.0.2.80</IPADDRESS></RESOURCE-RECORD>\n"
        b" <RESOURCE-RECORD><TYPE>AAAA-REC</TYPE><NAME>V6.CertSim.Lab.</NAME><TTL>0</TTL>"
        b"<IPV6ADDRESS>2001:0DB8:0000:0000:0000:0000:0000:0080</IPV6ADDRESS></RESOURCE-RECORD>\n"
        b" <RESOURCE-RECORD><TYPE>CNAME</TYPE><NAME>www.CertSim.Lab.</NAME><TTL>86400</TTL>"
        b"<HOSTNAME>CertSim.Lab.</HOSTNAME></RESOURCE-RECORD>\n"
        b"</NAMESERVER-DATABASE></DNS_SERVER>"
    )
    root.insert(2, dns)
    return root


def unrelated(root):
    return [X.tostring(child) for child in root if child.tag != "DNS_SERVER"]


class DnsProjection(unittest.TestCase):
    def test_authentic_field_shapes_project_normalized_records_and_ttl(self):
        root = native()
        before = X.tostring(root)
        value, opaque = project(root)
        self.assertFalse(opaque)
        self.assertEqual(value, settings(
            record(ttl=300), record("v6.certsim.lab", "AAAA", "2001:db8::80", 0),
            record("www.certsim.lab", "CNAME", "certsim.lab", 86400),
        ))
        self.assertEqual(X.tostring(root), before)

    def test_missing_block_and_disabled_empty_database(self):
        root = engine()
        self.assertEqual(project(root), (empty(), False))
        authored(root, None)
        self.assertEqual(project(root), (empty(), False))
        self.assertEqual(root.findtext("DNS_SERVER/ENABLED"), "0")
        self.assertEqual(len(root.find("DNS_SERVER/NAMESERVER-DATABASE")), 0)

    def test_unknown_or_ambiguous_layout_is_completely_opaque(self):
        def change_type(root, kind):
            root.find(".//RESOURCE-RECORD/TYPE").text = kind

        mutations = {
            "NS": lambda root: change_type(root, "NS"),
            "SOA": lambda root: change_type(root, "SOA"),
            "unknown type": lambda root: change_type(root, "MX"),
            "unknown record field": lambda root: X.SubElement(root.find(".//RESOURCE-RECORD"), "PRIORITY"),
            "unknown service field": lambda root: X.SubElement(root.find("DNS_SERVER"), "CACHE"),
            "unknown table child": lambda root: X.SubElement(root.find(".//NAMESERVER-DATABASE"), "UNKNOWN"),
            "service attribute": lambda root: root.find("DNS_SERVER").set("future", "1"),
            "table attribute": lambda root: root.find(".//NAMESERVER-DATABASE").set("future", "1"),
            "record attribute": lambda root: root.find(".//RESOURCE-RECORD").set("future", "1"),
            "leaf attribute": lambda root: root.find(".//RESOURCE-RECORD/NAME").set("future", "1"),
            "nested leaf": lambda root: X.SubElement(root.find(".//RESOURCE-RECORD/NAME"), "NESTED"),
            "missing TTL": lambda root: root.find(".//RESOURCE-RECORD").remove(root.find(".//RESOURCE-RECORD/TTL")),
            "missing enable": lambda root: root.find("DNS_SERVER").remove(root.find("DNS_SERVER/ENABLED")),
            "missing database": lambda root: root.find("DNS_SERVER").remove(root.find("DNS_SERVER/NAMESERVER-DATABASE")),
            "duplicate field": lambda root: X.SubElement(root.find(".//RESOURCE-RECORD"), "TTL"),
            "duplicate block": lambda root: root.append(deepcopy(root.find("DNS_SERVER"))),
            "duplicate record": lambda root: root.find(".//NAMESERVER-DATABASE").append(deepcopy(root.find(".//RESOURCE-RECORD"))),
            "service text": lambda root: setattr(root.find("DNS_SERVER"), "text", "unknown"),
            "record text": lambda root: setattr(root.find(".//RESOURCE-RECORD"), "text", "unknown"),
            "mixed text": lambda root: setattr(root.find(".//RESOURCE-RECORD/NAME"), "tail", "unknown"),
            "noninteger TTL": lambda root: setattr(root.find(".//RESOURCE-RECORD/TTL"), "text", "3.5"),
            "negative TTL": lambda root: setattr(root.find(".//RESOURCE-RECORD/TTL"), "text", "-1"),
            "huge TTL": lambda root: setattr(root.find(".//RESOURCE-RECORD/TTL"), "text", "2147483648"),
            "invalid name": lambda root: setattr(root.find(".//RESOURCE-RECORD/NAME"), "text", "invalid_name.lab"),
            "invalid enable": lambda root: setattr(root.find("DNS_SERVER/ENABLED"), "text", "true"),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                root = native()
                mutate(root)
                before = X.tostring(root)
                self.assertEqual(project(root), (None, True))
                update(root, None, None)
                self.assertEqual(X.tostring(root), before)
                with self.assertRaisesRegex(ValueError, "source is preserved"):
                    update(root, None, settings(record()))
                self.assertEqual(X.tostring(root), before)


class DnsValidation(unittest.TestCase):
    def test_normalization_defaults_and_supported_ttl_bounds(self):
        self.assertEqual(validate(None), empty())
        self.assertEqual(validate(settings(record("CertSim.Lab.", "CNAME", "Target.Lab."))),
                         settings(record("certsim.lab", "CNAME", "target.lab")))
        for ttl in (0, 300, 86400, 2147483647):
            self.assertEqual(validate(settings(record(ttl=ttl)))["records"][0]["ttl"], ttl)
        self.assertEqual(validate(settings(record(value="0.0.0.1")))["records"][0]["value"], "0.0.0.1")
        self.assertEqual(validate(settings(record(kind="AAAA", value="::192.0.2.80")))["records"][0]["value"], "::c000:250")

    def test_rejects_invalid_settings_records_names_addresses_and_ttl(self):
        invalid = [
            [], {}, {"enabled": 1, "records": []}, {"enabled": True, "records": None},
            {**empty(), "cache": []}, settings(None), settings({}),
            settings({**record(), "extra": "unknown"}), settings(record(kind="MX")),
            settings(record(kind=[])), settings(record(name="a..lab")),
            settings(record(name="-a.lab")), settings(record(name="a_.lab")),
            settings(record(name=" a.lab")), settings(record(name="a.lab..")),
            settings(record(name="a" * 64 + ".lab")), settings(record(name="é.lab")),
            settings(record(kind="CNAME", value="bad_target.lab")),
        ]
        for address in ("0.0.0.0", "127.0.0.1", "224.0.0.1", "255.255.255.255", "192.000.2.80", "192.0.2.256", "192.0.2.80 ", None):
            invalid.append(settings(record(value=address)))
        for address in ("::", "::1", "ff02::1", "::ffff:192.0.2.80", "fe80::1%eth0", "[2001:db8::80]", "2001:db8::80 ", "2001:::80"):
            invalid.append(settings(record(kind="AAAA", value=address)))
        for ttl in (-1, 2147483648, 1.5, True, "300", None):
            invalid.append(settings({**record(), "ttl": ttl}))
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate(value)

    def test_duplicate_and_cname_collision_rules_match_certsim(self):
        a = record()
        alias = record(kind="CNAME", value="target.lab")
        for records in ((a, a), (a, {**a, "ttl": 99}), (a, alias), (alias, a), (alias, {**alias, "value": "other.lab"})):
            with self.subTest(records=records), self.assertRaises(ValueError):
                validate(settings(*records))
        self.assertEqual(len(validate(settings(a, {**a, "value": "192.0.2.81"},
                                              record(kind="AAAA", value="2001:db8::80")))["records"]), 3)
        # Cycles remain representable configuration; the resolver handles them.
        self.assertEqual(len(validate(settings(record("a.lab", "CNAME", "b.lab"),
                                              record("b.lab", "CNAME", "a.lab")))["records"]), 2)

    def test_record_count_bound_on_authored_and_imported_data(self):
        records = [record(name=f"host-{index}.lab") for index in range(128)]
        root = engine()
        authored(root, settings(*records))
        self.assertEqual(len(project(root)[0]["records"]), 128)
        with self.assertRaises(ValueError):
            validate(settings(*records, record("overflow.lab")))
        root.find(".//NAMESERVER-DATABASE").append(deepcopy(root.find(".//RESOURCE-RECORD")))
        self.assertEqual(project(root), (None, True))


class DnsMutation(unittest.TestCase):
    def test_noop_preserves_raw_casing_ttl_and_xml(self):
        root = native()
        before = X.tostring(root)
        current, _ = project(root)
        same = deepcopy(current)
        same["records"][0].pop("ttl")
        same["records"][0]["name"] = "CERTSIM.LAB."
        update(root, current, same)
        self.assertEqual(X.tostring(root), before)
        absent = engine()
        absent_before = X.tostring(absent)
        update(absent, None, empty())
        self.assertEqual(X.tostring(absent), absent_before)

    def test_add_edit_remove_and_toggle_preserve_other_services_and_unchanged_records(self):
        root = native()
        neighbours = unrelated(root)
        current, _ = project(root)
        first = X.tostring(root.find(".//RESOURCE-RECORD"))
        edited = deepcopy(current)
        edited["records"][2]["name"] = "portal.certsim.lab"
        edited["records"].append(record("extra.lab", value="198.51.100.9", ttl=42))
        update(root, current, edited)
        self.assertEqual(project(root), (edited, False))
        self.assertEqual(X.tostring(root.find(".//RESOURCE-RECORD")), first)
        self.assertEqual(unrelated(root), neighbours)
        current = edited
        edited = settings(*edited["records"][:1], enabled=False)
        update(root, current, edited)
        self.assertEqual(project(root), (edited, False))
        self.assertEqual(unrelated(root), neighbours)
        update(root, edited, None)
        self.assertEqual(project(root), (empty(), False))
        self.assertEqual(unrelated(root), neighbours)

    def test_authoring_replaces_donor_dns_and_materializes_certsim_default_ttl(self):
        root = native()
        neighbours = unrelated(root)
        X.SubElement(root.find("DNS_SERVER"), "UNKNOWN-DONOR-FIELD").text = "discard fresh donor"
        root.append(deepcopy(root.find("DNS_SERVER")))
        authored(root, settings(record()))
        self.assertEqual(project(root), (settings(record(ttl=300)), False))
        self.assertEqual(len(root.findall("DNS_SERVER")), 1)
        self.assertEqual(unrelated(root), neighbours)
        authored(root, None)
        self.assertEqual(project(root), (empty(), False))

    def test_bad_writes_are_atomic_and_non_server_engines_are_rejected(self):
        root = native()
        before = X.tostring(root)
        current, _ = project(root)
        invalid = settings(record(value="127.0.0.1"))
        with self.assertRaises(ValueError):
            authored(root, invalid)
        with self.assertRaises(ValueError):
            update(root, current, invalid)
        self.assertEqual(X.tostring(root), before)
        root.find("TYPE").text = "Router"
        self.assertEqual(project(root), (None, True))
        with self.assertRaises(ValueError):
            authored(root, settings(record()))


if __name__ == "__main__":
    unittest.main()
