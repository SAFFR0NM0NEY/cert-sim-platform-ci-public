import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import {
  EXECUTION_REQUEST_VERSION,
} from '../../python-executor/src/contract.mjs';
import { PythonExecutionProviderError } from '../../python-executor/src/provider.mjs';
import {
  MODAL_PROVIDER_LIMITS,
  ModalPythonExecutionProvider,
  buildModalSandboxCreateParams,
} from '../src/index.mjs';

const encoder = new TextEncoder();
const launcherSource = readFileSync(new URL('../src/launcher.py', import.meta.url), 'utf8');

function runPython(source) {
  const candidates = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
  for (const [command, prefix] of candidates) {
    const result = spawnSync(command, [...prefix, '-c', source], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.error?.code === 'ENOENT') continue;
    assert.equal(result.status, 0, result.stderr || 'Python stdlib preload probe failed');
    return JSON.parse(result.stdout);
  }
  assert.fail('Python interpreter is required for the trusted stdlib preload test');
}

function stream(text) {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function request(overrides = {}) {
  return {
    contractVersion: EXECUTION_REQUEST_VERSION,
    requestId: 'request.synthetic-modal-001',
    runtime: { language: 'python', contract: 'python-source-v1' },
    workspace: {
      entryPoint: 'main.py',
      files: [
        { path: 'helper.py', content: 'VALUE = 42\n' },
        { path: 'main.py', content: 'from helper import VALUE\nprint(VALUE)\n' },
      ],
    },
    limits: { wallTimeMs: 500, memoryBytes: 64 * 1024 * 1024, outputBytes: 8_192 },
    ...overrides,
  };
}

function launcherReport() {
  return {
    namespaceSetup: true,
    workspaceBytes: MODAL_PROVIDER_LIMITS.diskBytes,
    workspaceFlags: ['nodev', 'noexec', 'nosuid'],
    learner: {
      uid: 65534,
      euid: 65534,
      gid: 65534,
      egid: 65534,
      groups: [],
      pid: 1,
      effectiveCapabilities: 0,
      noNewPrivileges: 1,
      seccompMode: 2,
      nproc: [1, 1],
      cpuSeconds: [4, 4],
      fileSizeBytes: [16 * 1024 * 1024, 16 * 1024 * 1024],
      environmentNames: [],
    },
  };
}

function modalMock({
  stdout = '42\n',
  stderr,
  exitCode = 0,
  waitDelayMs = 0,
  waitReject = false,
  terminateReject = false,
  pollReject = false,
} = {}) {
  const captured = {
    appCalls: [],
    imageCalls: [],
    createCalls: [],
    execCalls: [],
    stdin: '',
    terminateCalls: 0,
    detachCalls: 0,
    closeCalls: 0,
  };
  const processHandle = {
    stdin: {
      async writeText(value) { captured.stdin += value; },
      async close() {},
    },
    stdout: stream(stdout),
    stderr: stream(stderr ?? `CERTSIM_MODAL_LAUNCHER=${JSON.stringify(launcherReport())}\nlearner note\n`),
    async wait() {
      if (waitDelayMs > 0) await delay(waitDelayMs);
      if (waitReject) throw new Error('synthetic wait detail must not be logged');
      return exitCode;
    },
  };
  const sandbox = {
    sandboxId: 'sb-provider-internal-value',
    async exec(...args) { captured.execCalls.push(args); return processHandle; },
    async terminate() {
      captured.terminateCalls += 1;
      if (terminateReject) throw new Error('synthetic termination detail must not be logged');
    },
    async poll() {
      if (pollReject) throw new Error('synthetic poll detail must not be logged');
      return 0;
    },
    detach() { captured.detachCalls += 1; },
  };
  const client = {
    apps: { async fromName(...args) { captured.appCalls.push(args); return { appId: 'app.internal' }; } },
    images: { fromRegistry(...args) { captured.imageCalls.push(args); return { imageId: 'image.internal' }; } },
    sandboxes: {
      async create(...args) { captured.createCalls.push(args); return sandbox; },
    },
    close() { captured.closeCalls += 1; },
  };
  return { captured, client };
}

async function terminalStatus(provider, executionId) {
  for (let count = 0; count < 100; count += 1) {
    const result = await provider.getStatus(executionId);
    if (!['accepted', 'running'].includes(result.status)) return result;
    await delay(5);
  }
  throw new Error('mock execution did not terminate');
}

test('trusted stdlib preload is fixed, stdlib-only, and survives workspace-only import resolution', () => {
  const tuple = launcherSource.match(/TRUSTED_STDLIB_PRELOAD\s*=\s*\(([\s\S]*?)\)\s*\n/);
  assert.ok(tuple, 'trusted stdlib preload tuple is missing');
  const modules = [...tuple[1].matchAll(/"([a-z_][a-z0-9_]*)"/g)].map((match) => match[1]);
  assert.deepEqual(modules, [
    'ast', 'base64', 'builtins', 'contextlib', 'datetime', 'io', 'json', 'math',
    'os', 'pathlib', 'random', 'socket', 'sys', 'tempfile', 'unittest',
  ]);
  assert.match(launcherSource, /def main\(\):\s*\n\s+preload_trusted_stdlib\(\)/);
  assert.match(launcherSource, /sys\.path\[:\]\s*=\s*\[entry_directory\][\s\S]+sys\.path\.append\("\/workspace"\)/);
  assert.doesNotMatch(launcherSource, /\bpip\b|site-packages/i);
  assert.doesNotMatch(launcherSource, /MS_BIND|--bind|bind_mount/);
  assert.doesNotMatch(launcherSource, /["']\/(?:usr|lib|usr\/local)(?:\/|["'])/);

  const python = `
import json, os, sys, tempfile
modules = json.loads(${JSON.stringify(JSON.stringify(modules))})
for name in modules:
    if name not in sys.stdlib_module_names:
        raise AssertionError('non-stdlib preload')
    __import__(name)
transitive = next(name for name in ('enum', 'collections', 'functools', 'warnings') if name in sys.modules and name not in modules)
with tempfile.TemporaryDirectory() as root:
    workspace = os.path.join(root, 'workspace')
    outside = os.path.join(root, 'outside')
    os.mkdir(workspace)
    os.mkdir(outside)
    with open(os.path.join(workspace, 'helper.py'), 'w', encoding='utf-8') as handle:
        handle.write('VALUE = 42\\n')
    with open(os.path.join(outside, 'outside_package.py'), 'w', encoding='utf-8') as handle:
        handle.write('VALUE = 99\\n')
    host_path = list(sys.path)
    sys.path[:] = [workspace]
    for name in modules:
        __import__(name)
    __import__(transitive)
    from helper import VALUE
    assert VALUE == 42
    import ast, base64, contextlib, datetime, io, json, math, pathlib, random, socket, tempfile, unittest
    assert ast.parse('value = 1')
    assert base64.b64decode('NDI=') == b'42'
    with contextlib.redirect_stdout(io.StringIO()):
        print(json.dumps({'value': math.sqrt(4)}))
    assert datetime.datetime(2026, 9, 16).year == 2026
    assert pathlib.Path(workspace).is_dir()
    assert random.Random(86).randrange(10) >= 0
    probe_socket = socket.socket()
    probe_socket.close()
    assert issubclass(type('SyntheticCase', (unittest.TestCase,), {}), unittest.TestCase)
    denied = {}
    for name in ('outside_package', 'certsim_uninstalled_third_party', 'fractions'):
        sys.modules.pop(name, None)
        try:
            __import__(name)
            denied[name] = False
        except (ImportError, ModuleNotFoundError):
            denied[name] = True
    try:
        __import__('../outside')
        path_traversal_denied = False
    except (ImportError, ModuleNotFoundError, ValueError):
        path_traversal_denied = True
    workspace_only = sys.path == [workspace]
    sys.path[:] = host_path
print(json.dumps({'allowed': True, 'transitive': True, 'workspaceImport': True,
                  'localDenied': denied['outside_package'],
                  'thirdPartyDenied': denied['certsim_uninstalled_third_party'],
                  'unlistedHostStdlibDenied': denied['fractions'],
                  'pathTraversalDenied': path_traversal_denied,
                  'workspaceOnlyPath': workspace_only}))
`;
  assert.deepEqual(runPython(python), {
    allowed: true,
    transitive: true,
    workspaceImport: true,
    localDenied: true,
    thirdPartyDenied: true,
    unlistedHostStdlibDenied: true,
    pathTraversalDenied: true,
    workspaceOnlyPath: true,
  });
});

test('sandbox policy is fixed and caller limits can only reduce memory', () => {
  const canonical = request();
  const values = buildModalSandboxCreateParams('execution.00000000-0000-4000-8000-000000000001', canonical);
  assert.equal(values.cpuLimit, 0.25);
  assert.equal(values.memoryLimitMiB, 64);
  assert.equal(values.timeoutMs, 20_000);
  assert.equal(values.blockNetwork, true);
  assert.equal(values.includeOidcIdentityToken, false);
  assert.deepEqual(values.env, {});
  assert.deepEqual(values.secrets, []);
  assert.deepEqual(values.volumes, {});
  assert.deepEqual(values.cloudBucketMounts, {});
  assert.deepEqual(values.encryptedPorts, []);
  assert.deepEqual(values.unencryptedPorts, []);
});

test('adapter sends only the workspace through stdin and returns a normalized opaque result', async () => {
  const { client, captured } = modalMock();
  const logs = [];
  const provider = new ModalPythonExecutionProvider({ client, logger: (event) => logs.push(event) });
  const sourceRequest = request();
  const accepted = await provider.execute(sourceRequest);
  assert.equal(accepted.status, 'accepted');
  assert.match(accepted.executionId, /^execution\./);
  assert.doesNotMatch(accepted.executionId, /sb-provider/);

  const result = await terminalStatus(provider, accepted.executionId);
  assert.deepEqual({
    status: result.status,
    outcome: result.outcome,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }, {
    status: 'finished', outcome: 'completed', exitCode: 0, stdout: '42\n', stderr: 'learner note\n',
  });
  assert.deepEqual(JSON.parse(captured.stdin), sourceRequest.workspace);
  const commandText = JSON.stringify(captured.execCalls[0]);
  assert.doesNotMatch(commandText, /from helper import VALUE/);
  assert.equal(captured.createCalls[0][2].blockNetwork, true);
  assert.equal(captured.terminateCalls, 1);
  assert.equal(captured.detachCalls, 1);
  const logText = JSON.stringify(logs);
  assert.doesNotMatch(logText, /request\.synthetic|from helper|sb-provider|"stdout"|"stderr"/);
  await provider.close();
  assert.equal(captured.closeCalls, 1);
});

test('missing trusted launcher attestation fails closed', async () => {
  const { client } = modalMock({ stderr: 'learner supplied output\n' });
  const logs = [];
  const provider = new ModalPythonExecutionProvider({ client, logger: (event) => logs.push(event) });
  const accepted = await provider.execute(request());
  const result = await terminalStatus(provider, accepted.executionId);
  assert.equal(result.status, 'failed');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(logs.at(-1).category, 'launcher_attestation_failed');
  await provider.close();
});

test('a non-zero learner process returns bounded stderr without becoming grading authority', async () => {
  const { client } = modalMock({
    stdout: '', exitCode: 3, stderr: `CERTSIM_MODAL_LAUNCHER=${JSON.stringify(launcherReport())}\nLEARNER_ERROR:ValueError\n`,
  });
  const logs = [];
  const provider = new ModalPythonExecutionProvider({ client, logger: (event) => logs.push(event) });
  const accepted = await provider.execute(request());
  const result = await terminalStatus(provider, accepted.executionId);
  assert.equal(result.status, 'finished');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr, 'LEARNER_ERROR:ValueError\n');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(logs.at(-1).category, 'learner_nonzero_exit');
  assert.equal(logs.at(-1).exitCode, 3);
  assert.doesNotMatch(JSON.stringify(logs), /ValueError|LEARNER_ERROR|synthetic-modal/);
  await provider.close();
});

test('trusted launcher setup and mapping failures produce bounded server-only categories', async () => {
  for (const fixture of [
    {
      stderr: 'CERTSIM_MODAL_SETUP_ERROR=seccomp_setup:EPERM\n',
      category: 'launcher_setup_failed',
      operationCode: 'seccomp_setup:EPERM',
    },
    {
      stderr: 'CERTSIM_MODAL_MAPPING_ERROR=uid_mapping:EPERM\n',
      category: 'launcher_mapping_failed',
      operationCode: 'uid_mapping:EPERM',
    },
  ]) {
    const { client } = modalMock({ stdout: '', stderr: fixture.stderr, exitCode: 125 });
    const logs = [];
    const provider = new ModalPythonExecutionProvider({ client, logger: (event) => logs.push(event) });
    const accepted = await provider.execute(request());
    const result = await terminalStatus(provider, accepted.executionId);
    assert.equal(result.status, 'failed');
    assert.equal(result.stderr, '');
    assert.deepEqual(result.diagnostics, []);
    assert.equal(logs.at(-1).category, fixture.category);
    assert.equal(logs.at(-1).operationCode, fixture.operationCode);
    assert.doesNotMatch(JSON.stringify(result), /launcher|seccomp|mapping|EPERM/);
    await provider.close();
  }
});

test('reserved exit 125 is classified as a launcher failure without public diagnostics', async () => {
  const { client } = modalMock({ stdout: '', exitCode: 125 });
  const logs = [];
  const provider = new ModalPythonExecutionProvider({ client, logger: (event) => logs.push(event) });
  const accepted = await provider.execute(request());
  const result = await terminalStatus(provider, accepted.executionId);
  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, null);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(logs.at(-1).category, 'launcher_setup_failed');
  await provider.close();
});

test('wait, completion, and disposal failures remain distinct only in sanitized server logs', async () => {
  for (const fixture of [
    { options: { waitReject: true }, category: 'provider_wait_rejected' },
    { options: { stderr: '' }, category: 'completion_exception' },
    {
      options: { terminateReject: true, pollReject: true },
      category: 'disposal_unconfirmed',
    },
  ]) {
    const { client } = modalMock(fixture.options);
    const logs = [];
    const provider = new ModalPythonExecutionProvider({ client, logger: (event) => logs.push(event) });
    const accepted = await provider.execute(request());
    const result = await terminalStatus(provider, accepted.executionId);
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.diagnostics, []);
    assert.equal(logs.at(-1).category, fixture.category);
    assert.doesNotMatch(JSON.stringify(logs), /synthetic (?:wait|termination|poll) detail/);
    await provider.close();
  }
});

test('the provider terminates and classifies output that reaches the request byte ceiling', async () => {
  const { client, captured } = modalMock({ stdout: '0123456789abcdef' });
  const logs = [];
  const provider = new ModalPythonExecutionProvider({ client, logger: (event) => logs.push(event) });
  const accepted = await provider.execute(request({
    limits: { wallTimeMs: 500, memoryBytes: 64 * 1024 * 1024, outputBytes: 8 },
  }));
  const result = await terminalStatus(provider, accepted.executionId);
  assert.equal(result.status, 'finished');
  assert.equal(result.outcome, 'resource_limit');
  assert.ok(encoder.encode(result.stdout + result.stderr).byteLength <= 8);
  assert.equal(captured.terminateCalls, 1);
  assert.equal(logs.at(-1).category, 'output_limit');
  await provider.close();
});

test('the provider timeout terminates the Sandbox and returns no fabricated exit code', async () => {
  const { client, captured } = modalMock({ waitDelayMs: 175 });
  const logs = [];
  const provider = new ModalPythonExecutionProvider({ client, logger: (event) => logs.push(event) });
  const accepted = await provider.execute(request({
    limits: { wallTimeMs: 100, memoryBytes: 64 * 1024 * 1024, outputBytes: 8_192 },
  }));
  const result = await terminalStatus(provider, accepted.executionId);
  assert.equal(result.status, 'finished');
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.exitCode, null);
  assert.equal(captured.terminateCalls, 1);
  assert.equal(logs.at(-1).category, 'timeout');
  await provider.close();
});

test('active cancellation and disposal are terminal and idempotent', async () => {
  const controllers = {};
  let resolveWait;
  let terminateCalls = 0;
  let detachCalls = 0;
  const processHandle = {
    stdin: { async writeText() {}, async close() {} },
    stdout: new ReadableStream({ start(controller) { controllers.stdout = controller; } }),
    stderr: new ReadableStream({ start(controller) { controllers.stderr = controller; } }),
    wait: () => new Promise((resolve) => { resolveWait = resolve; }),
  };
  const sandbox = {
    async exec() { return processHandle; },
    async terminate() {
      terminateCalls += 1;
      controllers.stdout.close();
      controllers.stderr.close();
      resolveWait(143);
    },
    async poll() { return 143; },
    detach() { detachCalls += 1; },
  };
  const client = {
    apps: { async fromName() { return {}; } },
    images: { fromRegistry() { return {}; } },
    sandboxes: { async create() { return sandbox; } },
  };
  const provider = new ModalPythonExecutionProvider({ client });
  const accepted = await provider.execute(request());
  const first = await provider.cancel(accepted.executionId);
  const repeated = await provider.cancel(accepted.executionId);
  const disposed = await provider.dispose(accepted.executionId);
  const repeatedDisposal = await provider.dispose(accepted.executionId);
  assert.equal(first.status, 'cancelled');
  assert.deepEqual(repeated, first);
  assert.deepEqual(disposed, first);
  assert.deepEqual(repeatedDisposal, first);
  assert.equal(terminateCalls, 1);
  assert.equal(detachCalls, 1);
  await provider.close();
});

test('unknown provider execution IDs are rejected without a lookup side channel', async () => {
  const { client } = modalMock();
  const provider = new ModalPythonExecutionProvider({ client });
  for (const value of ['', '../escape', 'execution.00000000-0000-4000-8000-000000000000']) {
    await assert.rejects(() => provider.getStatus(value), (error) => (
      error instanceof PythonExecutionProviderError
      && error.code === 'PROVIDER_EXECUTION_NOT_FOUND'
    ));
  }
  await provider.close();
});
