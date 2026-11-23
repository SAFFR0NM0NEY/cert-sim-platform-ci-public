"""One fresh isolated Linux container process per case; actual Modal1.1.4 loader.
Only /harness test files and the SDK's /root file-definition entrypoint are mounted.
No provider calls, hosted hydration, proxy or process-survival proof is claimed.
"""
import argparse
import importlib.metadata
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

parser = argparse.ArgumentParser()
parser.add_argument("--case", required=True)
case = parser.parse_args().case
declaration = json.loads(Path("/harness/declaration.json").read_bytes())
assert sys.platform == "linux" and sys.version_info[:2] == (3, 12)
assert not Path(declaration["builderRoot"]).exists(), "Builder stage must not be mounted"
assert not Path("/checkout").exists() and "PYTHONPATH" not in os.environ
runtime_env = dict(declaration["originalEnv"] if case.startswith("original-") else declaration["env"])
assert "CERTSIM_FENCED_PACKAGE_ROOT" not in runtime_env
for name in declaration["secretNames"]:
    runtime_env[name] = os.urandom(32).hex()
runtime_env["CERTSIM_FENCE_STORE_URL"] = "http://127.0.0.1:1"
runtime_env.update(PATH="/usr/local/bin:/usr/bin:/bin", HOME="/tmp")
if case in ("original-stale-builder", "stale-builder"):
    runtime_env["CERTSIM_FENCED_PACKAGE_ROOT"] = "/builder-only-unavailable"
if case == "missing-hash":
    runtime_env.pop("CERTSIM_FENCED_INVENTORY_SHA256")
if case == "missing-source":
    runtime_env.pop("CERTSIM_FENCED_SOURCE_SHA")
if case == "wrong-hash":
    runtime_env["CERTSIM_FENCED_INVENTORY_SHA256"] = "0" * 64
if case == "wrong-source":
    runtime_env["CERTSIM_FENCED_SOURCE_SHA"] = "0" * 40
os.environ.clear()
os.environ.update(runtime_env)
os.chdir("/opt/certsim/services/python-executor-modal" if case != "missing-inventory" else "/tmp")
sys.path.insert(0, "/root")
assert all("checkout" not in entry and declaration["builderRoot"] not in entry for entry in sys.path)
assert importlib.metadata.version("modal") == "1.1.4"

import modal
from modal._runtime.container_io_manager import _ContainerIOManager
from modal._runtime.user_code_imports import import_single_function_service
from modal._utils.async_utils import synchronizer
from modal.running_app import RunningApp
from modal_proto import api_pb2

# This is the exact distinction used by modal.is_local() in1.1.4. No IO manager
# is constructed (that would connect to Modal); an inert singleton models remote.
_ContainerIOManager._singleton = object()
assert modal.is_local() is False
function_def = api_pb2.Function(module_name="modal_fenced_app", function_name="executor_bridge",
                               definition_type=api_pb2.Function.DEFINITION_TYPE_FILE)
original_connect = socket.socket.connect
def guarded_connect(sock, address):
    if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "::1"):
        raise AssertionError("Unexpected external network")
    return original_connect(sock, address)

expected_errors = {
    "original-missing-builder": KeyError, "original-stale-builder": FileNotFoundError,
    "missing-hash": KeyError, "missing-source": KeyError,
    "wrong-hash": RuntimeError, "wrong-source": RuntimeError,
    "missing-inventory": FileNotFoundError, "missing-module": FileNotFoundError,
    "corrupt-module": RuntimeError, "corrupt-inventory": RuntimeError,
}
processes = []
real_popen = subprocess.Popen
def tracked_popen(command, **kwargs):
    assert command == ["node", "src/fenced-start.mjs"]
    assert kwargs["cwd"] == "/opt/certsim/services/python-executor-modal"
    assert "CERTSIM_FENCED_PACKAGE_ROOT" not in kwargs["env"]
    assert "CERTSIM_MODAL_API_TOKEN_ID" not in kwargs["env"]
    assert "CERTSIM_MODAL_API_TOKEN_SECRET" not in kwargs["env"]
    assert kwargs["env"]["MODAL_TOKEN_ID"] == runtime_env["CERTSIM_MODAL_API_TOKEN_ID"]
    assert kwargs["env"]["MODAL_TOKEN_SECRET"] == runtime_env["CERTSIM_MODAL_API_TOKEN_SECRET"]
    for name in declaration["env"]:
        assert kwargs["env"][name] == declaration["env"][name]
    process = real_popen(command, **kwargs, start_new_session=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    processes.append(process)
    return process

def request(path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request("http://127.0.0.1:8000" + path, data=data,
                                     headers={"content-type": "application/json"})
    try:
        response = urllib.request.urlopen(request, timeout=1)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, json.loads(response.read())

try:
    with patch.object(socket.socket, "connect", guarded_connect), \
         patch.object(modal.Image, "from_registry", side_effect=AssertionError("Remote image build declaration")), \
         patch.object(modal.Image, "add_local_file", side_effect=AssertionError("Remote builder copy")), \
         patch.object(modal.Image, "run_commands", side_effect=AssertionError("Remote install declaration")), \
         patch.object(modal.Image, "env", side_effect=AssertionError("Remote image environment declaration")), \
         patch.object(modal.Secret, "from_local_environ", side_effect=AssertionError("Remote local-secret acquisition")):
        try:
            service = import_single_function_service(function_def, None, None)
        except Exception as error:
            expected = expected_errors.get(case)
            if expected is None or not isinstance(error, expected):
                raise
            print(json.dumps({"suite": "container-cold-import", "case": case,
                              "exception": type(error).__name__, "expectedFailure": True,
                              "actualPinnedSdkLoader": True, "hostedOperations": 0, "passed": True}))
            sys.exit(0)
        assert case not in expected_errors, "Required-material/configuration failure was accepted"
        module = sys.modules["modal_fenced_app"]
        info = synchronizer._translate_in(module.executor_bridge)._get_info()
        assert info.get_definition_type() == api_pb2.Function.DEFINITION_TYPE_FILE
        assert info.module_name == "modal_fenced_app" and not info.is_serialized()
        assert info._file == "/root/modal_fenced_app.py"
        assert module.CONTAINER_ROOT == Path("/opt/certsim")
        assert not hasattr(module, "PACKAGE_ROOT")
        assert set(module.deployment_dependencies) == {"secrets"}
        assert len(module.deployment_dependencies["secrets"]) == 1
        assert module.INVENTORY["privateSourceSha"] == declaration["env"]["CERTSIM_FENCED_SOURCE_SHA"]
        # Match the actual local SDK declaration, including dependency order.
        # Mirror _container_entrypoint's count check and per-object hydration.
        local_shape = json.loads(Path("/harness/sdk-dependencies.json").read_bytes())
        dependencies = service.service_deps
        remote_shape = [{"class": type(dep).__name__, "prefix": dep._type_prefix} for dep in dependencies]
        assert remote_shape == local_shape and len(dependencies) == 2
        dependency_ids = [entry["prefix"] + "-offline" for entry in local_shape]
        function_def.object_dependencies.extend(api_pb2.ObjectDependency(object_id=value) for value in dependency_ids)
        handle_metadata = {"fu-offline": api_pb2.FunctionHandleMetadata(), **{value: None for value in dependency_ids}}
        service.app._init_container(object(), RunningApp(
            app_id="ap-offline", function_ids={"executor_bridge": "fu-offline"},
            object_handle_metadata=handle_metadata,
        ))
        internal_function = synchronizer._translate_in(module.executor_bridge)
        assert internal_function.object_id == "fu-offline" and internal_function.is_hydrated
        assert len(dependencies) == len(function_def.object_dependencies)
        for dependency, value in zip(dependencies, function_def.object_dependencies):
            dependency._hydrate(value.object_id, object(), handle_metadata[value.object_id])
            assert dependency.is_hydrated and dependency.object_id == value.object_id
        if case == "bootstrap":
            with patch.object(subprocess, "Popen", tracked_popen):
                service._user_defined_callable()
            assert len(processes) == 1
            deadline = time.monotonic() + 10
            while True:
                assert processes[0].poll() is None, "Node startup exited"
                try:
                    status, health = request("/health")
                    assert status == 200 and health["nodeMajor"] == 22
                    break
                except (OSError, urllib.error.URLError):
                    if time.monotonic() >= deadline:
                        raise AssertionError("Node readiness deadline")
                    time.sleep(0.05)
            assert request("/v2/expiry-grade", {})[0] == 400
            assert request("/v2/expiry-grade", {
                "request": {}, "envelope": {}, "binding": {}, "gradingMaterial": {}, "fence": {}, "auth": {}
            })[0] == 503
            assert request("/v2/expiry-recover", {
                "recovery": {"fence": {}, "token": "unauthorised-fixture"}, "auth": {}
            })[0] == 503
            assert request("/v1/grade", {})[0] == 400
finally:
    for process in processes:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
        assert process.poll() is not None
        try:
            os.killpg(process.pid, 0)
        except ProcessLookupError:
            pass
        else:
            raise AssertionError("Bootstrap child process group leaked")
    if processes:
        try:
            socket.create_connection(("127.0.0.1", 8000), timeout=0.2).close()
        except OSError:
            pass
        else:
            raise AssertionError("Bootstrap listener leaked")
print(json.dumps({"suite": "container-cold-import", "case": case, "actualPinnedSdkLoader": True,
                  "fileDefinition": True, "inMemoryHydration": True, "dependencyTypesMatch": remote_shape,
                  "builderStageMounted": False,
                  "actualNodeBootstrap": case == "bootstrap", "childCleanup": len(processes),
                  "hostedOperations": 0, "passed": True}))
