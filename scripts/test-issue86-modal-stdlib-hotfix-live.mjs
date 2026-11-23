import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  EXECUTION_REQUEST_VERSION,
  createSignedExecutionEnvelope,
  normalizeExecutionResult,
} from '../services/python-executor/src/contract.mjs';
import {
  assertAuthenticatedGradingEvidenceForExecution,
  createGradingBinding,
} from '../services/python-grading/src/contract.mjs';
import {
  TRUSTED_GRADING_CONTRACT_VERSION,
  createTrustedGradingMaterialDigest,
} from '../services/python-grading/src/trusted-grading-contract.mjs';
import { buildTrustedRuntimeProbeWorkspace } from '../services/python-grading/src/trusted-grader.mjs';
import { createConfiguredModalClient } from '../services/python-executor-modal/src/config.mjs';
import { MODAL_EXECUTOR_APP } from '../services/python-executor-modal/src/provider.mjs';

const bridgeUrl = required('CERTSIM_MODAL_BRIDGE_URL').replace(/\/$/, '');
const proxyKey = required('CERTSIM_MODAL_PROXY_KEY');
const proxySecret = required('CERTSIM_MODAL_PROXY_SECRET');
const executionSecret = required('CERTSIM_EXECUTION_SIGNING_SECRET');
const gradingSecret = required('CERTSIM_GRADING_SIGNING_SECRET');
assert.notEqual(executionSecret, gradingSecret);

const headers = Object.freeze({
  'content-type': 'application/json',
  'Modal-Key': proxyKey,
  'Modal-Secret': proxySecret,
});

if (process.env.CERTSIM_MODAL_STDLIB_PROOF_VALIDATE_ONLY === 'YES') {
  const validationMaterial = syntheticGradingMaterial();
  const validationRequest = requestFor(syntheticGradingWorkspace());
  const validationBinding = createGradingBinding({
    gradingSessionId: `grading-session.${randomUUID()}`,
    request: validationRequest,
    materializationId: `materialization.${randomUUID()}`,
    materialDigest: createTrustedGradingMaterialDigest(validationMaterial),
    gradingContractVersion: TRUSTED_GRADING_CONTRACT_VERSION,
    maximumRawPoints: validationMaterial.maximumRawPoints,
  });
  assert.ok(buildTrustedRuntimeProbeWorkspace(validationRequest.workspace, validationMaterial));
  assert.equal(validationBinding.maximumRawPoints, 10);
  process.stdout.write('{"ok":true,"validationOnly":true,"runtimeFamilies":9,"structuralRules":1}\n');
  process.exit(0);
}

const ordinaryRequest = requestFor(ordinaryWorkspace());
const ordinaryResponse = await post('/v1/execute', {
  request: ordinaryRequest,
  envelope: createSignedExecutionEnvelope(ordinaryRequest, executionSecret),
});
assert.equal(ordinaryResponse.ok, true);
assert.equal(ordinaryResponse.disposalConfirmed, true);
const ordinary = normalizeExecutionResult(ordinaryResponse.result, {
  outputByteLimit: ordinaryRequest.limits.outputBytes,
});
assert.deepEqual({ status: ordinary.status, outcome: ordinary.outcome, exitCode: ordinary.exitCode }, {
  status: 'finished', outcome: 'completed', exitCode: 0,
});
assert.match(ordinary.stdout, /^ISSUE86_STDLIB_PROOF:15:PROCESS_DENIED:ESCAPE_DENIED:NETWORK_DENIED\r?\n$/);
assert.equal(ordinary.stderr, '');

const gradingMaterial = syntheticGradingMaterial();
const gradingRequest = requestFor(syntheticGradingWorkspace());
const gradingBinding = createGradingBinding({
  gradingSessionId: `grading-session.${randomUUID()}`,
  request: gradingRequest,
  materializationId: `materialization.${randomUUID()}`,
  materialDigest: createTrustedGradingMaterialDigest(gradingMaterial),
  gradingContractVersion: TRUSTED_GRADING_CONTRACT_VERSION,
  maximumRawPoints: gradingMaterial.maximumRawPoints,
});
const probeWorkspace = buildTrustedRuntimeProbeWorkspace(gradingRequest.workspace, gradingMaterial);
assert.ok(probeWorkspace);
assert.doesNotMatch(probeWorkspace.files[0].content, /expectedObservation|maximumRawPoints|rule\.synthetic/);

const gradingResponse = await post('/v1/grade', {
  request: gradingRequest,
  envelope: createSignedExecutionEnvelope(gradingRequest, executionSecret),
  binding: gradingBinding,
  gradingMaterial,
});
assert.equal(gradingResponse.ok, true);
assert.equal(gradingResponse.disposalConfirmed, true);
const gradingExecution = normalizeExecutionResult(gradingResponse.executionResult, {
  outputByteLimit: gradingRequest.limits.outputBytes,
});
assert.deepEqual({
  status: gradingExecution.status,
  outcome: gradingExecution.outcome,
  exitCode: gradingExecution.exitCode,
}, { status: 'finished', outcome: 'completed', exitCode: 0 });
assertAuthenticatedGradingEvidenceForExecution({
  request: gradingRequest,
  executionResult: gradingExecution,
  binding: gradingBinding,
  evidence: gradingResponse.evidence,
  envelope: gradingResponse.envelope,
  secret: gradingSecret,
});
assert.equal(gradingResponse.evidence.earnedRawPoints, gradingMaterial.maximumRawPoints);
assert.equal(gradingResponse.evidence.rules.length, 10);
assert.ok(gradingResponse.evidence.rules.every(({ earnedRawPoints, maximumRawPoints }) => (
  earnedRawPoints === maximumRawPoints
)));

await new Promise((resolve) => setTimeout(resolve, 2_000));
const remainingSandboxes = await countRunningSandboxes();
assert.equal(remainingSandboxes, 0);

process.stdout.write(`${JSON.stringify({
  ok: true,
  temporaryApp: process.env.CERTSIM_MODAL_BRIDGE_APP ?? null,
  ordinaryExecution: 'PASS',
  supportedStdlibModules: 15,
  processDenial: 'PASS',
  filesystemEscapeDenial: 'PASS',
  networkDenial: 'PASS',
  trustedGrading: 'PASS',
  runtimeFamilies: 9,
  structuralRules: 1,
  r4Verification: 'PASS',
  sandboxesCreated: 3,
  sandboxesRemaining: remainingSandboxes,
  protectedMaterialBodies: 0,
  learnerIdentities: 0,
})}\n`);

function requestFor(workspace) {
  return {
    contractVersion: EXECUTION_REQUEST_VERSION,
    requestId: `request.${randomUUID()}`,
    runtime: { language: 'python', contract: 'python-source-v1' },
    workspace,
    limits: { wallTimeMs: 20_000, memoryBytes: 128 * 1024 * 1024, outputBytes: 1024 * 1024 },
  };
}

function ordinaryWorkspace() {
  const source = `
import ast
import base64
import builtins
import contextlib
import datetime
import io
import json
import math
import os
import pathlib
import random
import socket
import sys
import tempfile
import unittest
from helper import VALUE

assert VALUE == 42
assert ast.parse("answer = 42")
assert base64.b64decode("NDI=") == b"42"
captured = io.StringIO()
with contextlib.redirect_stdout(captured):
    builtins.print(json.dumps({"answer": math.sqrt(1764)}))
assert json.loads(captured.getvalue())["answer"] == 42
assert datetime.datetime(2026, 9, 16).year == 2026
assert random.Random(86).randrange(100) >= 0
assert sys.path == ["/workspace"]
assert os.environ == {}
assert not pathlib.Path("/etc/passwd").exists()
assert not pathlib.Path("/dev/null").exists()
assert not pathlib.Path("previous-run.txt").exists()
assert issubclass(type("SyntheticCase", (unittest.TestCase,), {}), unittest.TestCase)
with tempfile.TemporaryDirectory() as directory:
    target = pathlib.Path(directory) / "ordinary.txt"
    target.write_text("synthetic", encoding="utf-8")
    assert target.read_text(encoding="utf-8") == "synthetic"
pathlib.Path("proof.txt").write_text("synthetic", encoding="utf-8")
assert pathlib.Path("proof.txt").read_text(encoding="utf-8") == "synthetic"

try:
    __import__("certsim_uninstalled_third_party")
    raise AssertionError("third-party import unexpectedly available")
except ModuleNotFoundError:
    pass

process_denied = False
try:
    child = os.fork()
    if child == 0:
        os._exit(91)
    os.waitpid(child, 0)
except OSError:
    process_denied = True
assert process_denied

escape_denied = False
try:
    pathlib.Path("/escape.txt").write_text("blocked", encoding="utf-8")
except OSError:
    escape_denied = True
assert escape_denied

network_denied = False
probe = socket.socket()
probe.settimeout(0.1)
try:
    probe.connect(("203.0.113.1", 9))
except OSError:
    network_denied = True
finally:
    probe.close()
assert network_denied

print("ISSUE86_STDLIB_PROOF:15:PROCESS_DENIED:ESCAPE_DENIED:NETWORK_DENIED")
`;
  return {
    entryPoint: 'main.py',
    files: [
      { path: 'helper.py', content: 'VALUE = 42\n' },
      { path: 'main.py', content: source.trimStart() },
    ],
  };
}

function syntheticGradingWorkspace() {
  return {
    entryPoint: 'main.py',
    files: [{
      path: 'main.py',
      content: `
import os
import random
import sys
import unittest

def function_probe():
    return None

def filesystem_probe():
    return None

def stdout_probe():
    assert sys.argv == ["synthetic-program"]

def stdin_probe():
    return input()

def filesystem_cli_probe():
    assert sys.argv == ["synthetic-program"]

def seeded_probe():
    random.random()

def filesystem_cwd_probe():
    assert os.path.basename(os.getcwd()).startswith("certsim-probe-")

class SyntheticCase(unittest.TestCase):
    def test_synthetic(self):
        self.assertTrue(True)
`.trimStart(),
    }],
  };
}

function syntheticGradingMaterial() {
  const none = { type: 'none' };
  const string = (value) => ({ type: 'string', value });
  const integer = (value) => ({ type: 'int', value: String(value) });
  const observation = (result = none) => ({
    status: 'completed', result, argumentsAfter: [], stdout: '', stderr: '', files: [],
    cwdUnchanged: true, argvRestored: true, handlesReleased: true,
  });
  const base = (family, expectedObservation = observation()) => ({
    contractVersion: TRUSTED_GRADING_CONTRACT_VERSION,
    family,
    expectedObservation,
  });
  const rules = [
    ['function_call', { ...base('function_call'), target: 'function_probe', arguments: [], keywordArguments: {}, repeat: 1 }],
    ['filesystem', { ...base('filesystem'), target: 'filesystem_probe', setup: [], arguments: [], repeat: 1, capturePaths: [], captureCwd: false, captureHandles: false }],
    ['stdout_cli', { ...base('stdout_cli'), target: 'stdout_probe', argv: ['synthetic-program'] }],
    ['stdin_stdout', { ...base('stdin_stdout', observation(string('synthetic-input'))), target: 'stdin_probe', inputs: ['synthetic-input'] }],
    ['introspection', { ...base('introspection'), target: 'module', attribute: '__doc__' }],
    ['filesystem_cli', { ...base('filesystem_cli'), target: 'filesystem_cli_probe', setup: [], argv: ['synthetic-program'], capturePaths: [], captureHandles: false }],
    ['seeded_random', { ...base('seeded_random'), target: 'seeded_probe', arguments: [], keywordArguments: {}, seed: 86, repeat: 1 }],
    ['unittest', { ...base('unittest', observation(integer(1))), operation: 'case_count', target: 'SyntheticCase' }],
    ['filesystem_cwd', { ...base('filesystem_cwd'), target: 'filesystem_cwd_probe', setup: [], arguments: [], captureCwd: true }],
  ].map(([type, compiled], index) => ({
    id: `rule.synthetic-runtime-${index + 1}`,
    type,
    points: 1,
    compiled,
  }));
  rules.push({
    id: 'rule.synthetic-structural',
    type: 'AST',
    points: 1,
    compiled: {
      contractVersion: TRUSTED_GRADING_CONTRACT_VERSION,
      family: 'ast_features',
      requiredNodes: [{ type: 'FunctionDef', minimum: 7 }],
      requiredCalls: [],
      requiredNames: [],
      requiredDefinitions: ['function_probe'],
      requiredAttributes: [],
      requiredLiterals: [],
      requiredOperators: [],
      forbiddenCalls: [],
      forbiddenAttributes: [],
      orderedNames: [],
      requireDynamicReturn: false,
    },
  });
  return {
    contractVersion: TRUSTED_GRADING_CONTRACT_VERSION,
    taskId: 'synthetic-issue86-stdlib-hotfix-proof',
    maximumRawPoints: rules.length,
    rules,
  };
}

async function post(path, body) {
  const response = await fetch(`${bridgeUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, `Modal proof request failed with HTTP ${response.status}`);
  return response.json();
}

async function countRunningSandboxes() {
  const client = await createConfiguredModalClient();
  try {
    const app = await client.apps.fromName(MODAL_EXECUTOR_APP, { createIfMissing: false });
    let count = 0;
    for await (const sandbox of client.sandboxes.list({
      appId: app.appId,
      tags: { purpose: MODAL_EXECUTOR_APP, lifecycle: 'one-disposable-execution' },
    })) {
      void sandbox;
      count += 1;
    }
    return count;
  } finally {
    client.close();
  }
}

function required(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name}_REQUIRED`);
  return value;
}
