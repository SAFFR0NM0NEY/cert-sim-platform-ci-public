"""Small synthetic HTTP XML cases; no native payloads or Lab construction."""

from copy import deepcopy
import unittest
from lxml import etree as X

from http_service import authored, project, update, validate


def http_value(enabled=True):
    return {"enabled": enabled, "pages": [
        {"path": "/", "body": "Synthetic home"},
        {"path": "/status", "body": "All synthetic services ready"},
    ]}


def _fields(parent, values):
    for tag, text in values.items():
        X.SubElement(parent, tag).text = text


def _file(parent, name, number, body, content_class="CHttpPage"):
    raw = X.SubElement(parent, "FILE", {"class": "CFile"})
    _fields(raw, {"FILE_NUMBER": str(number), "NAME": name, "DATE_TIME": "12345", "PERMISSION": "6"})
    content = X.SubElement(raw, "FILE_CONTENT", {"class": content_class})
    X.SubElement(content, "TEXT").text = body
    return raw


def synthetic_http_engine(managers=2):
    """Public synthetic fixture for service-coordinator preservation tests."""
    engine = X.Element("ENGINE")
    X.SubElement(engine, "TYPE").text = "Server"
    http = X.SubElement(engine, "HTTP_SERVER")
    _fields(http, {"ENABLED": "1", "USERNAME": "", "PASSWORD": ""})
    https = X.SubElement(engine, "HTTPS_SERVER")
    _fields(https, {"HTTPSENABLED": "1", "UNMODELED": "retain TLS"})
    for i in range(managers):
        manager = X.SubElement(engine, "FILE_MANAGER")
        root = X.SubElement(manager, "FILE", {"class": "CDirectory"})
        _fields(root, {"FILE_NUMBER": "0", "NAME": "", "DATE_TIME": "0", "PERMISSION": "6", "FILE_CONTENT": ""})
        files = X.SubElement(root, "FILES")
        for name in ("c:", "ftp:", "http:", "tftp:"):
            fs = X.SubElement(files, "FILE", {"class": "CFileSystem"})
            _fields(fs, {"FILE_NUMBER": "0", "NAME": name, "DATE_TIME": "0", "PERMISSION": "6", "FILE_CONTENT": ""})
            listing = X.SubElement(fs, "FILES")
            if name == "http:":
                _file(listing, "index.html", 1, "Synthetic home")
                _file(listing, "status", 2, "All synthetic services ready")
                counter = "7"  # Deleted pages may leave a higher allocator value.
            else:
                _file(listing, "unrelated.bin", 1, f"retain {name} manager {i}", "CSyntheticOpaque")
                counter = "11"
            _fields(fs, {"FILE_COUNTER": counter, "CAPACITY": "100000000"})
    return engine


def _stores(engine):
    return engine.xpath('./FILE_MANAGER/FILE/FILES/FILE[NAME="http:"]')


def _siblings(engine):
    return [X.tostring(fs) for fs in engine.xpath('./FILE_MANAGER/FILE/FILES/FILE[NAME!="http:"]')]


class HttpProjection(unittest.TestCase):
    def test_one_or_two_matching_stores_project_root_and_extensionless_page(self):
        for managers in (1, 2):
            with self.subTest(managers=managers):
                engine = synthetic_http_engine(managers)
                before = X.tostring(engine)
                self.assertEqual(project(engine), (http_value(), False))
                self.assertEqual(X.tostring(engine), before)

    def test_literal_text_and_unicode_round_trip_without_execution(self):
        engine = synthetic_http_engine()
        before, _ = project(engine)
        after = deepcopy(before)
        after["pages"][0]["body"] = '<script>throw "never executed"</script>\n& <text> café 🌍\r\n'
        update(engine, before, after)
        self.assertEqual(project(engine), (after, False))
        # XML entity handling is the only encoding layer; HTTP content stays text.
        reopened = X.fromstring(X.tostring(engine))
        self.assertEqual(project(reopened), (after, False))
        for fs in _stores(engine):
            self.assertEqual(fs.findtext("FILES/FILE/FILE_CONTENT/TEXT"), after["pages"][0]["body"])

    def test_edit_preserves_sibling_filesystems_https_and_page_metadata(self):
        engine = synthetic_http_engine()
        before, _ = project(engine)
        original_siblings = _siblings(engine)
        https = X.tostring(engine.find("HTTPS_SERVER"))
        unedited = [X.tostring(fs.find("FILES")[1]) for fs in _stores(engine)]
        after = deepcopy(before)
        after["enabled"] = False
        after["pages"][0]["body"] = "Changed synthetic home"
        after["pages"].append({"path": "/new.txt", "body": "New"})
        update(engine, before, after)
        self.assertEqual(project(engine), (after, False))
        self.assertEqual(_siblings(engine), original_siblings)
        self.assertEqual(X.tostring(engine.find("HTTPS_SERVER")), https)
        for i, fs in enumerate(_stores(engine)):
            pages = fs.find("FILES")
            self.assertEqual(X.tostring(pages[1]), unedited[i])
            self.assertEqual(pages[0].findtext("FILE_NUMBER"), "1")
            self.assertEqual(pages[0].findtext("DATE_TIME"), "12345")
            self.assertEqual(pages[2].findtext("FILE_NUMBER"), "8")
            self.assertEqual(fs.findtext("FILE_COUNTER"), "8")

    def test_deleted_ids_are_not_reused_and_counter_does_not_shrink(self):
        engine = synthetic_http_engine()
        before, _ = project(engine)
        removed = {"enabled": True, "pages": [before["pages"][0]]}
        update(engine, before, removed)
        self.assertTrue(all(fs.findtext("FILE_COUNTER") == "7" for fs in _stores(engine)))
        added = {"enabled": True, "pages": removed["pages"] + [{"path": "/replacement", "body": "Replacement"}]}
        update(engine, removed, added)
        self.assertTrue(all(fs.find("FILES")[1].findtext("FILE_NUMBER") == "8" for fs in _stores(engine)))

    def test_fresh_authoring_only_replaces_donor_http_content(self):
        engine = synthetic_http_engine()
        for fs in _stores(engine):
            _file(fs.find("FILES"), "opaque.php", 7, "synthetic script")
        engine.find("HTTP_SERVER/USERNAME").text = "synthetic account"
        engine.find("HTTP_SERVER/PASSWORD").text = "synthetic value"
        siblings = _siblings(engine)
        authored(engine, http_value(False))
        self.assertEqual(project(engine), (http_value(False), False))
        self.assertEqual(_siblings(engine), siblings)
        self.assertEqual(engine.findtext("HTTPS_SERVER/HTTPSENABLED"), "0")
        self.assertEqual(engine.findtext("HTTPS_SERVER/UNMODELED"), "retain TLS")
        self.assertEqual(engine.findtext("HTTP_SERVER/USERNAME"), "")
        for fs in _stores(engine):
            self.assertEqual(fs.findtext("FILE_COUNTER"), "2")

    def test_noop_and_root_alias_normalization_leave_original_xml_unchanged(self):
        engine = synthetic_http_engine()
        before, _ = project(engine)
        original = X.tostring(engine)
        update(engine, before, deepcopy(before))
        after = deepcopy(before)
        after["pages"][0]["path"] = "/index.html"
        update(engine, before, after)
        self.assertEqual(X.tostring(engine), original)

    def test_malformed_or_unsupported_http_is_opaque_and_unchanged_noops_survive(self):
        def mutate(engine, variant):
            for fs in _stores(engine):
                raw = fs.find("FILES")[0]
                if variant == "image":
                    raw.find("NAME").text = "picture.jpg"
                elif variant == "server_script":
                    raw.find("NAME").text = "index.php"
                elif variant == "directory":
                    raw.set("class", "CDirectory")
                elif variant == "duplicate_id":
                    raw.find("FILE_NUMBER").text = "2"
                elif variant == "low_counter":
                    fs.find("FILE_COUNTER").text = "1"
                elif variant == "unknown_metadata":
                    X.SubElement(raw, "FUTURE_BEHAVIOR").text = "retain"
                elif variant == "permissions":
                    raw.find("PERMISSION").text = "0"
                elif variant == "nested_content":
                    X.SubElement(raw.find("FILE_CONTENT/TEXT"), "SCRIPT")
                elif variant == "empty_name":
                    raw.find("NAME").text = ""
                elif variant == "nested_path":
                    raw.find("NAME").text = "folder/index.html"
                elif variant == "large_body":
                    raw.find("FILE_CONTENT/TEXT").text = "x" * 16385
            if variant == "auth":
                engine.find("HTTP_SERVER/USERNAME").text = "synthetic account"
            elif variant == "mismatched_store":
                _stores(engine)[1].find("FILES")[0].find("FILE_CONTENT/TEXT").text = "conflict"
            elif variant == "duplicate_server":
                engine.append(deepcopy(engine.find("HTTP_SERVER")))
            elif variant == "extra_store":
                engine.append(deepcopy(engine.find("FILE_MANAGER")))
            elif variant == "unknown_server_option":
                X.SubElement(engine.find("HTTP_SERVER"), "FUTURE_OPTION")
        variants = ("image", "server_script", "directory", "duplicate_id", "low_counter", "unknown_metadata", "permissions", "nested_content", "empty_name", "nested_path", "large_body", "auth", "mismatched_store", "duplicate_server", "extra_store", "unknown_server_option")
        for variant in variants:
            with self.subTest(variant=variant):
                engine = synthetic_http_engine()
                mutate(engine, variant)
                original = X.tostring(engine)
                self.assertEqual(project(engine), (None, True))
                update(engine, {"enabled": False, "pages": []}, {"enabled": False, "pages": []})
                self.assertEqual(X.tostring(engine), original)
                with self.assertRaises(ValueError):
                    update(engine, {"enabled": False, "pages": []}, http_value())
                self.assertEqual(X.tostring(engine), original)

    def test_failed_capacity_and_stale_projection_do_not_mutate(self):
        engine = synthetic_http_engine()
        before, _ = project(engine)
        after = deepcopy(before)
        after["pages"][0]["body"] = "new"
        for fs in _stores(engine):
            fs.find("CAPACITY").text = "64"
        oversized = deepcopy(after)
        oversized["pages"][0]["body"] = "x" * 65
        original = X.tostring(engine)
        with self.assertRaisesRegex(ValueError, "capacity"):
            update(engine, before, oversized)
        self.assertEqual(X.tostring(engine), original)
        stale = deepcopy(before)
        stale["pages"][1]["body"] = "stale"
        with self.assertRaisesRegex(ValueError, "no longer matches"):
            update(engine, stale, after)
        self.assertEqual(X.tostring(engine), original)


class HttpValidation(unittest.TestCase):
    def test_alias_maps_to_root_but_alias_collision_rejects(self):
        self.assertEqual(validate({"enabled": False, "pages": [{"path": "/index.html", "body": ""}]}), {"enabled": False, "pages": [{"path": "/", "body": ""}]})
        with self.assertRaisesRegex(ValueError, "same native file"):
            validate({"enabled": True, "pages": [{"path": "/", "body": "a"}, {"path": "/index.html", "body": "b"}]})

    def test_body_limits_are_utf8_bytes_and_xml_controls_are_guarded(self):
        for body in ("x" * 16384, "é" * 8192, "\r\n\t", "", "😀" * 4096):
            with self.subTest(length=len(body)):
                value = {"enabled": True, "pages": [{"path": "/", "body": body}]}
                self.assertEqual(validate(value), value)
        for body in ("é" * 8193, "x\x00", "x\x01", "\ud800", None):
            with self.subTest(length=len(body) if isinstance(body, str) else None):
                with self.assertRaises(ValueError):
                    validate({"enabled": True, "pages": [{"path": "/", "body": body}]})

    def test_page_limit_paths_and_model_shape_are_guarded(self):
        bad = [
            {"enabled": 1, "pages": []},
            {"enabled": True, "pages": [], "extra": "unmodeled"},
            {"enabled": True, "pages": [{"path": f"/p{i}", "body": ""} for i in range(17)]},
            {"enabled": True, "pages": [{"path": "/status", "body": "a"}, {"path": "/status", "body": "b"}]},
        ]
        for path in ("relative", "/folder/page", "/../page", "/.", "/..", "/page?x=1", "/file.php", "/file.js", "/file.jpg", "/" + "x" * 180):
            bad.append({"enabled": True, "pages": [{"path": path, "body": ""}]})
        for value in bad:
            with self.subTest(value=repr(value)[:100]):
                with self.assertRaises(ValueError):
                    validate(value)


if __name__ == "__main__":
    unittest.main()
