#!/usr/bin/env python3
"""Generic learner-Sandbox probe harness. Expected values never enter this file."""

import ast
import base64
import builtins
import contextlib
import io
import json
import math
import os
import random
import sys
import tempfile
from pathlib import Path

PREFIX = "CERTSIM_TRUSTED_PROBE_RESULT="
PAYLOAD_B64 = "__CERTSIM_PAYLOAD_B64__"


def typed(value):
    if value is None: return {"type": "none"}
    if type(value) is bool: return {"type": "bool", "value": value}
    if type(value) is int: return {"type": "int", "value": str(value)}
    if type(value) is float:
        text = "nan" if math.isnan(value) else "infinity" if math.isinf(value) and value > 0 else "-infinity" if math.isinf(value) else value.hex()
        return {"type": "float", "value": text}
    if type(value) is str: return {"type": "string", "value": value}
    if type(value) is bytes: return {"type": "bytes", "value": value.hex()}
    if type(value) in (list, tuple, set):
        items = [typed(item) for item in value]
        if type(value) is set: items.sort(key=lambda item: json.dumps(item, sort_keys=True))
        return {"type": "list" if type(value) is list else "tuple" if type(value) is tuple else "set", "items": items}
    if type(value) is dict:
        items = [[typed(key), typed(item)] for key, item in value.items()]
        items.sort(key=lambda item: json.dumps(item[0], sort_keys=True))
        return {"type": "dict", "items": items}
    return {"type": "object", "class": type(value).__name__}


def untyped(value):
    kind = value["type"]
    if kind == "none": return None
    if kind == "bool": return value["value"]
    if kind == "int": return int(value["value"])
    if kind == "float":
        text = value["value"]
        return float("nan") if text == "nan" else float("inf") if text == "infinity" else float("-inf") if text == "-infinity" else float.fromhex(text)
    if kind == "string": return value["value"]
    if kind == "bytes": return bytes.fromhex(value["value"])
    if kind == "list": return [untyped(item) for item in value["items"]]
    if kind == "tuple": return tuple(untyped(item) for item in value["items"])
    if kind == "set": return {untyped(item) for item in value["items"]}
    if kind == "dict": return {untyped(key): untyped(item) for key, item in value["items"]}
    raise ValueError("unsupported typed input")


def resolve_argument(item, root):
    return str(root if item["name"] == "." else root / item["name"]) if item["kind"] == "path" else untyped(item["value"])


def load_namespace(source):
    namespace = {"__name__": "certsim_submission", "__file__": "main.py"}
    exec(compile(source, "main.py", "exec"), namespace)
    return namespace


def observe(source, compiled):
    family = compiled["family"]
    stdout, stderr = io.StringIO(), io.StringIO()
    original_argv, original_cwd, original_input = list(sys.argv), os.getcwd(), builtins.input
    observation = {"status": "completed", "result": None, "argumentsAfter": [], "stdout": "", "stderr": "", "files": [], "cwdUnchanged": True, "argvRestored": True, "handlesReleased": True}
    with tempfile.TemporaryDirectory(prefix="certsim-probe-") as directory:
        root = Path(directory)
        try:
            for item in compiled.get("setup", []):
                path = root / item["name"]
                if item["kind"] == "directory": path.mkdir(parents=True, exist_ok=True)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(item["content"], encoding="utf-8")
            if family == "filesystem_cwd": os.chdir(root)
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                namespace = load_namespace(source)
                if family == "introspection":
                    value = namespace.get("__doc__") if compiled["target"] == "module" else getattr(namespace[compiled["target"]], compiled["attribute"])
                    results, arguments = [value], []
                elif family == "unittest":
                    import unittest
                    target = namespace[compiled["target"]]
                    operation = compiled["operation"]
                    if operation == "is_test_case": value = issubclass(target, unittest.TestCase)
                    elif operation == "case_count": value = unittest.defaultTestLoader.loadTestsFromTestCase(target).countTestCases()
                    elif operation == "callable_test_method": value = callable(getattr(target, "test_record", None))
                    else:
                        stream = io.StringIO()
                        outcome = unittest.TextTestRunner(stream=stream, verbosity=0).run(unittest.defaultTestLoader.loadTestsFromTestCase(target))
                        value = {"failures": len(outcome.failures), "errors": len(outcome.errors)}
                    results, arguments = [value], []
                else:
                    if family in {"function_call", "seeded_random"}:
                        arguments = [untyped(item) for item in compiled["arguments"]]
                        keywords = {key: untyped(item) for key, item in compiled["keywordArguments"].items()}
                    elif family in {"filesystem", "filesystem_cwd"}:
                        arguments = [resolve_argument(item, root) for item in compiled["arguments"]]
                        keywords = {}
                    else: arguments, keywords = [], {}
                    if family == "seeded_random": random.seed(compiled["seed"])
                    if family == "stdin_stdout":
                        inputs = iter(compiled["inputs"])
                        builtins.input = lambda _prompt="": next(inputs)
                    if family in {"stdout_cli", "filesystem_cli"}:
                        sys.argv = [resolve_argument(item, root) if isinstance(item, dict) else item for item in compiled["argv"]]
                    function = namespace[compiled["target"]]
                    results = [function(*arguments, **keywords) for _ in range(compiled.get("repeat", 1))]
            observation["result"] = typed(results[0] if len(results) == 1 else results)
            if family in {"filesystem", "filesystem_cwd"}:
                observation["argumentsAfter"] = [typed(argument) for descriptor, argument in zip(compiled["arguments"], arguments) if descriptor["kind"] == "value"]
            else: observation["argumentsAfter"] = [typed(item) for item in arguments]
            for name in compiled.get("capturePaths", []):
                path = root / name
                if path.is_file(): observation["files"].append({"name": name, "kind": "file", "content": path.read_text(encoding="utf-8")})
                elif path.is_dir(): observation["files"].append({"name": name, "kind": "directory", "content": ""})
                else: observation["files"].append({"name": name, "kind": "missing", "content": ""})
            if compiled.get("captureHandles"):
                for item in compiled.get("setup", []):
                    path = root / item["name"]
                    if path.exists():
                        moved = root / (item["name"] + ".moved")
                        path.rename(moved); moved.rename(path)
        except BaseException as error:
            observation["status"] = "error"
            observation["result"] = {"type": "exception", "class": type(error).__name__}
        finally:
            builtins.input = original_input
            sys.argv = original_argv
            os.chdir(original_cwd)
            observation["stdout"] = stdout.getvalue()
            observation["stderr"] = stderr.getvalue()
            observation["cwdUnchanged"] = os.getcwd() == original_cwd
            observation["argvRestored"] = sys.argv == original_argv
    return observation


payload = json.loads(base64.b64decode(PAYLOAD_B64).decode("utf-8"))
source = next(item["content"] for item in payload["files"] if item["path"] == payload["entryPoint"])
observations = [observe(source, compiled) for compiled in payload["probes"]]
print(PREFIX + json.dumps(observations, ensure_ascii=False, separators=(",", ":")))
