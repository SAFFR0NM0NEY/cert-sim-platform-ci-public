"""Offline local declaration checks. No Modal build/deploy/run or real secrets."""
import hashlib
import importlib.metadata
import importlib.util
import inspect
import json
import os
import shutil
import socket
import sys
import tempfile
import types
from pathlib import Path
from unittest.mock import patch

DESCRIPTOR = Path(__file__).resolve().parents[1] / "services/python-executor-modal/modal_fenced_app.py"
root = Path(os.environ["CERTSIM_TEST_PACKAGE_ROOT"]).resolve()
report = json.loads(Path(os.environ["CERTSIM_TEST_PACKAGE_REPORT"]).read_text())
layout = json.loads((root / "services/python-executor-modal/runtime-profile.json").read_text())
metadata = {
    "CERTSIM_FENCED_PACKAGE_ROOT": str(root),
    "CERTSIM_FENCED_INVENTORY_SHA256": report["inventorySha256"],
    "CERTSIM_FENCED_SOURCE_SHA": report["privateSourceSha"],
}


def load_descriptor(path):
    spec = importlib.util.spec_from_file_location("modal_fenced_app", path)
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, {"modal_fenced_app": module}):
        spec.loader.exec_module(module)
    return module


def record(path=DESCRIPTOR, environment=None):
    trace = {"copied": [], "commands": [], "configs": [], "secrets": [], "registry": [], "env": []}
    class Image:
        @staticmethod
        def from_registry(*args, **kwargs):
            trace["registry"].append((args, kwargs))
            return Image()
        def add_local_file(self, source, destination, **kwargs):
            assert kwargs == {"copy": True}
            trace["copied"].append((source, destination))
            return self
        def run_commands(self, command):
            trace["commands"].append(command)
            return self
        def env(self, environment):
            trace["env"].append(environment)
            return self
    class App:
        def __init__(self, name):
            assert name == "certsim-python-executor-bridge"
        def function(self, **kwargs):
            trace["configs"].append(kwargs)
            return lambda fn: fn
    class Secret:
        @staticmethod
        def from_local_environ(names):
            trace["secrets"].extend(names)
            return "OFFLINE_DECLARATION"
    def web_server(port, **kwargs):
        assert port == 8000 and kwargs == {"startup_timeout": 30, "requires_proxy_auth": True}
        return lambda fn: fn
    fake = types.SimpleNamespace(Image=Image, App=App, Secret=Secret, web_server=web_server, is_local=lambda: True)
    with patch.dict(sys.modules, {"modal": fake}), patch("importlib.metadata.version", return_value="1.1.4"), patch.dict(
        os.environ, metadata if environment is None else environment, clear=True
    ):
        load_descriptor(path)
    return trace


if len(sys.argv) > 1 and sys.argv[1] == "--sdk":
    import modal
    from modal._utils.async_utils import synchronizer
    from modal_proto import api_pb2
    assert importlib.metadata.version("modal") == "1.1.4"
    assert "copy" in inspect.signature(modal.Image.add_local_file).parameters
    assert "vars" in inspect.signature(modal.Image.env).parameters
    assert "env" not in inspect.signature(modal.App.function).parameters
    assert "requires_proxy_auth" in inspect.signature(modal.web_server).parameters
    for name in ("timeout", "max_containers", "scaledown_window"):
        assert name in inspect.signature(modal.App.function).parameters
    synthetic = {name: os.urandom(32).hex() for name in layout["bridgeSecretNames"]}
    synthetic["CERTSIM_FENCE_STORE_URL"] = "http://127.0.0.1:1"
    # Declaration only: all SDK object loaders remain unexecuted; no client/run/build.
    def deny_network(*args, **kwargs):
        raise AssertionError("Unexpected network during offline declaration")
    with patch.dict(os.environ, {**metadata, **synthetic}, clear=True), patch.object(socket.socket, "connect", deny_network):
        module = load_descriptor(DESCRIPTOR)
        info = synchronizer._translate_in(module.executor_bridge)._get_info()
        assert info.get_definition_type() == api_pb2.Function.DEFINITION_TYPE_FILE
        assert not info.is_serialized() and info.module_name == "modal_fenced_app"
        assert Path(info._file).resolve() == DESCRIPTOR.resolve()
        assert list(info.get_entrypoint_mount()) == ["modal_fenced_app"]
        dependencies = synchronizer._translate_in(module.executor_bridge).deps(only_explicit_mounts=True)
        shape = [{"class": type(dep).__name__, "prefix": dep._type_prefix} for dep in dependencies]
        assert [entry["class"] for entry in shape] == ["_Secret", "_Image"]
        if len(sys.argv) > 2:
            (Path(sys.argv[2]) / "sdk-dependencies.json").write_text(json.dumps(shape) + "\n")
    print(json.dumps({"pythonDeploymentSdk": "1.1.4", "offlineApiCompatibility": True,
                      "actualLocalFileDefinition": True, "dependencyTypes": shape, "serialized": False, "hostedOperations": 0}))
    sys.exit(0)

trace = record()
assert sorted(dest for _, dest in trace["copied"]) == sorted("/opt/certsim/" + p for p in layout["files"] + ["RUNTIME_INVENTORY.json"])
assert len(trace["copied"]) == len(layout["files"]) + 1
assert trace["registry"] == [(("node:22-bookworm-slim",), {"add_python": "3.12"})]
assert trace["commands"] == ["cd /opt/certsim/services/python-executor-modal && npm ci --omit=dev --ignore-scripts"]
config = trace["configs"][0]
assert "env" not in config
assert len(trace["env"]) == 1
container_env = trace["env"][0]
assert config["timeout"] == 180
assert config["cpu"] == 0.25 and config["memory"] == 256 and config["max_containers"] == 5
assert config["min_containers"] == 0 and config["scaledown_window"] == 30
assert all(container_env[name] == "false" for name in layout["gateDefaults"])
assert container_env["CERTSIM_FENCED_SOURCE_SHA"] == report["privateSourceSha"]
assert container_env["CERTSIM_FENCED_INVENTORY_SHA256"] == report["inventorySha256"]
assert "CERTSIM_FENCED_PACKAGE_ROOT" not in container_env
assert trace["secrets"] == layout["bridgeSecretNames"]
assert not any(name in container_env for name in trace["secrets"])

negative_checks = 0
for name in metadata:
    missing = {key: value for key, value in metadata.items() if key != name}
    try:
        record(environment=missing)
    except (KeyError, RuntimeError):
        negative_checks += 1
    else:
        raise AssertionError("Missing builder metadata accepted")
for change in ({"CERTSIM_FENCED_SOURCE_SHA": "0" * 40}, {"CERTSIM_FENCED_INVENTORY_SHA256": "0" * 64}):
    try:
        record(environment={**metadata, **change})
    except RuntimeError:
        negative_checks += 1
    else:
        raise AssertionError("Mismatched builder metadata accepted")
with tempfile.TemporaryDirectory(prefix="descriptor-negative-", dir=root.parent) as folder:
    isolated = Path(folder)
    inventory = json.loads((root / "RUNTIME_INVENTORY.json").read_bytes())
    for item in inventory["files"] + [{"path": "RUNTIME_INVENTORY.json"}]:
        destination = isolated / item["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / item["path"], destination)
    shared = isolated / "supabase/functions/_shared/python-fence-auth.mjs"
    original = shared.read_bytes()
    for corrupt in (True, False):
        if corrupt:
            shared.write_bytes(original + b"\n// corrupt fixture\n")
        else:
            shared.unlink()
        try:
            record(environment={**metadata, "CERTSIM_FENCED_PACKAGE_ROOT": str(isolated)})
        except (RuntimeError, FileNotFoundError):
            negative_checks += 1
        else:
            raise AssertionError("Missing/corrupt builder file accepted")
        shared.write_bytes(original)
    # The external inventory hash cannot bless a changed path list.
    changed = json.loads((isolated / "RUNTIME_INVENTORY.json").read_bytes())
    changed["files"] = changed["files"][:-1]
    raw = json.dumps(changed).encode()
    (isolated / "RUNTIME_INVENTORY.json").write_bytes(raw)
    try:
        record(environment={**metadata, "CERTSIM_FENCED_PACKAGE_ROOT": str(isolated),
                            "CERTSIM_FENCED_INVENTORY_SHA256": hashlib.sha256(raw).hexdigest()})
    except RuntimeError:
        negative_checks += 1
    else:
        raise AssertionError("Incomplete builder file set accepted")
assert negative_checks == 8

if len(sys.argv) > 1 and sys.argv[1] == "--fixtures":
    fixtures = Path(sys.argv[2])
    previous = record(fixtures / "original/modal_fenced_app.py")
    (fixtures / "declaration.json").write_text(json.dumps({
        "env": container_env, "originalEnv": previous["configs"][0]["env"],
        "secretNames": trace["secrets"], "builderRoot": str(root),
    }) + "\n")
print(json.dumps({"suite": "private-deployment-layout", "inventorySourceFiles": len(layout["files"]),
                  "exactCopies": len(trace["copied"]), "hostTimeoutSeconds": 180,
                  "gatesDisabled": True, "localNegativeChecks": negative_checks,
                  "builderRootExcludedFromContainer": True, "hostedOperations": 0, "passed": True}))
