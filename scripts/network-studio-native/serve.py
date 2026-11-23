"""Loopback-only native file helper and Network Studio preview. Start with --help."""

import argparse
import base64
from copy import deepcopy
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import threading
from urllib.parse import unquote, urlsplit
from author import new_activity, network
from documents import (
    MAX_FILE,
    MAX_XML,
    open_document,
    read_container,
    save_document,
    current_network,
    activity_pages,
    restricted_activity,
)
from backgrounds import read_background, set_background
from assessment import grade
from editing import patch
from network import read_network
from packages import member_path_key, read_package, write_package

ROOT = Path(__file__).resolve().parents[2]
MAX_REQUEST = 14 * 1024 * 1024
MAX_SAVE_REQUEST = 4 * ((MAX_XML + MAX_FILE + 2) // 3) + 3 * 1024 * 1024
JOB = threading.BoundedSemaphore(1)


def import_native(raw, fmt, name):
    reply = {}
    package = read_package(raw) if fmt == "pkz" else None
    if package:
        raw, fmt = package.document, package.format
        reply["documentFormat"] = fmt
    root = open_document(raw, fmt)
    if restricted_activity(root):
        return {**reply, "readOnly": True, "pages": activity_pages(root)}
    source = current_network(root)
    topology, _, missing = read_network(source, name)
    if package:
        reply["resources"] = [
            {"name": key, "size": len(value)}
            for key, value in package.resources.items()
        ]
        background = read_background(source, package.resources)
        if background:
            reply["background"] = background
    return {
        **reply,
        "network": topology,
        "omitted": missing,
        "pages": activity_pages(root) if fmt == "pka" else [],
    }


def edit_resources(original, changes):
    if not isinstance(changes, dict):
        raise ValueError("Invalid package file changes.")
    remove = changes.get("remove", [])
    add = changes.get("add", [])
    if (
        not isinstance(remove, list)
        or not isinstance(add, list)
        or max(len(remove), len(add)) > 255
    ):
        raise ValueError("Invalid package file list.")
    resources = original.copy()
    for name in remove:
        if name not in resources:
            raise ValueError("A file selected for removal is missing from the package.")
        del resources[name]
    for item in add:
        name = item["name"]
        if name in resources:
            raise ValueError("Remove the existing package file before replacing it.")
        value = item["data"]
        if not isinstance(value, str) or len(value) > 4 * ((MAX_FILE + 2) // 3):
            raise ValueError("Select a package member up to 8 MiB.")
        resources[name] = base64.b64decode(value, validate=True)
    return resources


def native_snapshot(network):
    """Exclude CertSim DHCP runtime while retaining configured pool/client state."""
    topology = deepcopy(network)

    def clear_runtime(snapshot):
        snapshot.pop("dhcpTime", None)
        for device in snapshot.get("devices", []):
            for port in device.get("ports", []):
                port.pop("dhcpLease", None)
                port.pop("dhcpRetryAt", None)
            services = device.get("services")
            if isinstance(services, dict) and isinstance(services.get("dhcp"), dict):
                services["dhcp"]["leases"] = []

    clear_runtime(topology)
    initial = (topology.get("activity") or {}).get("initial")
    if isinstance(initial, dict):
        clear_runtime(initial)
    return topology


def export_native(data):
    topology = native_snapshot(data["network"])
    ref = topology.pop("nativeFile", None)
    output_format = data["format"]
    if output_format not in ("pkt", "pka", "pkz"):
        raise ValueError("Choose PKT, PKA or PKZ.")
    changes = data.get("resources") or {}
    if changes and output_format != "pkz":
        raise ValueError("Save as PKZ to include the package files.")
    package = None
    encoding = "pkt"
    original = None
    if ref:
        source_format = ref["format"]
        if output_format != source_format and output_format != "pkz":
            raise ValueError(
                "Choose the original native file type to preserve the document."
            )
        raw = base64.b64decode(data["source"], validate=True)
        if source_format == "pkz":
            package = read_package(raw)
        inner_format = package.format if package else source_format
        original = package.document if package else raw
        root, encoding = read_container(original, inner_format)
        if restricted_activity(root):
            raise ValueError(
                "This activity uses native restrictions. Continue it in Cisco Packet Tracer."
            )
        changed = patch(current_network(root), ref["name"], topology)
    else:
        if data.get("source"):
            raise ValueError("Unexpected native source attachment.")
        inner_format = (
            ("pka" if topology.get("activity") else "pkt")
            if output_format == "pkz"
            else output_format
        )
        if inner_format == "pkt" and topology.get("activity"):
            raise ValueError("Choose PKA to include the activity.")
        root = new_activity(topology) if inner_format == "pka" else network(topology)[0]
        changed = True
    if output_format != "pkz":
        return save_document(root, encoding) if changed else original
    if package:
        name = package.document_name
    else:
        name = "activity.pka" if inner_format == "pka" else "network.pkt"
        if ref:
            candidate = ref["name"] + "." + inner_format
            try:
                if "/" not in member_path_key(candidate):
                    name = candidate
            except ValueError:
                pass  # A non-portable source name still has a usable default.
    resources = edit_resources(package.resources if package else {}, changes)
    source = current_network(root)
    if "background" in changes:
        background = changes["background"]
        available = package.resources if package and background is None else resources
        changed = set_background(source, available, background) or changed
    elif package and changes.get("remove"):
        previous = read_background(source, package.resources)
        if previous and not read_background(source, resources):
            changed = set_background(source, package.resources, None) or changed
    if package and not changed and resources == package.resources:
        return raw
    document = save_document(root, encoding) if changed else original
    return write_package(name, document, resources, original=package)


def package_resource(data):
    package = read_package(base64.b64decode(data["source"], validate=True))
    if package.format == "pka" and restricted_activity(
        open_document(package.document, "pka")
    ):
        raise ValueError(
            "This activity uses native restrictions. Continue it in Cisco Packet Tracer."
        )
    if data["name"] not in package.resources:
        raise ValueError("The selected attachment is missing from the package.")
    return package.resources[data["name"]]


def check_native(data):
    raw = base64.b64decode(data["source"], validate=True)
    project = data["network"]
    if (project.get("nativeFile") or {}).get("format") == "pkz":
        package = read_package(raw)
        if package.format != "pka":
            raise ValueError(
                "This package contains a network. Choose an activity to check results."
            )
        raw = package.document
    return grade(open_document(raw, "pka"), project, data.get("observations", {}))


class LocalHandler(BaseHTTPRequestHandler):
    def __init__(self, *args, app, **kwargs):
        self.app = app
        super().__init__(*args, **kwargs)

    def log_message(self, format, *args):
        pass  # File names, instructions and network configurations are private.

    def allowed(self):
        ports = {self.server.server_port, 4188, 4189}
        local = ("127.0.0.1", "localhost")
        host = self.headers.get("Host", "")
        if host not in {f"{h}:{self.server.server_port}" for h in local}:
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin in {
            f"http://{h}:{p}" for h in local for p in ports
        }

    def response(self, status, body=b"", mime="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if self.allowed() and self.headers.get("Origin"):
            self.send_header("Access-Control-Allow-Origin", self.headers["Origin"])
            self.send_header("Vary", "Origin")
            self.send_header(
                "Access-Control-Allow-Headers",
                "Content-Type,X-CertSim-Native,X-Studio-Name",
            )
            self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self.response(204 if self.allowed() else 403)

    def do_GET(self):
        if not self.allowed():
            return self.response(403)
        route = urlsplit(self.path).path
        if route == "/native/status":
            return self.response(200, b'{"service":"certsim-native-files","version":1}')
        if route in ("/", "/network-studio.html"):
            target = self.app
        elif (
            route.startswith("/assets/") or route.startswith("/brand/")
        ) and self.app.name == "network-studio.html":
            target = (self.app.parent / unquote(route[1:])).resolve()
            if not target.is_relative_to(self.app.parent) or target.suffix not in (
                ".png",
                ".css",
                ".js",
                ".svg",
                ".woff2",
            ):
                return self.response(404)
        else:
            return self.response(404)
        if not target.is_file():
            return self.response(
                404, b"Build Network Studio before starting the helper.", "text/plain"
            )
        self.response(
            200,
            target.read_bytes(),
            (
                "text/javascript"
                if target.suffix == ".js"
                else mimetypes.guess_type(target)[0] or "application/octet-stream"
            ),
        )

    def do_POST(self):
        if not self.allowed() or self.headers.get("X-CertSim-Native") != "1":
            return self.response(403)
        path = urlsplit(self.path).path
        if path not in (
            "/native/open/pkt",
            "/native/open/pka",
            "/native/open/pkz",
            "/native/save",
            "/native/resource",
            "/native/check",
        ):
            return self.response(404)
        try:
            size = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            size = -1
        limit = MAX_FILE if path.startswith("/native/open/") else MAX_REQUEST
        if path == "/native/save":
            limit = MAX_SAVE_REQUEST
        if not 0 < size <= limit:
            return self.response(
                413, b'{"error":"Native file request exceeds the size limit."}'
            )
        if not JOB.acquire(blocking=False):
            return self.response(
                409, b'{"error":"Another native file is being processed. Try again."}'
            )
        try:
            body = self.rfile.read(size)
            if len(body) != size:
                raise ValueError("Incomplete file transfer.")
            if path == "/native/check":
                data = json.loads(body)
                result = check_native(data)
                self.response(200, json.dumps(result).encode())
            elif path == "/native/resource":
                self.response(
                    200, package_resource(json.loads(body)), "application/octet-stream"
                )
            elif path == "/native/save":
                data = json.loads(body)
                result = export_native(data)
                self.response(200, result, "application/octet-stream")
            else:
                name = unquote(self.headers.get("X-Studio-Name", "Imported network"))[
                    :80
                ]
                result = import_native(body, path.rsplit("/", 1)[-1], name)
                self.response(200, json.dumps(result).encode())
        except (KeyError, TypeError, IndexError, OverflowError, RecursionError):
            self.response(
                422,
                b'{"error":"Invalid native project structure or unsupported interface mapping."}',
            )
        except ValueError as exc:
            self.response(422, json.dumps({"error": str(exc)[:320]}).encode())
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.response(
                422,
                b'{"error":"Conversion failed. The source document has been retained."}',
            )
        finally:
            JOB.release()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--app", type=Path, default=ROOT / "dist-network-studio" / "network-studio.html"
    )
    parser.add_argument("--port", type=int, default=42397)
    args = parser.parse_args()
    if not args.app.is_file():
        parser.error(
            "Build the preview with npm run build:network-studio, or supply --app <standalone HTML>."
        )
    with ThreadingHTTPServer(
        ("127.0.0.1", args.port), partial(LocalHandler, app=args.app.resolve())
    ) as server:
        print(
            f"Network Studio native files: http://127.0.0.1:{args.port}/network-studio.html",
            flush=True,
        )
        server.serve_forever()
