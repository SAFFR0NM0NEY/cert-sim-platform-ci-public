import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createPythonLabWorkspaceController,
  normalizePythonLabPresentation,
  normalizePythonRunDto,
  normalizePythonWorkspace,
} from '../src/lib/pythonLabWorkspace.js';
import { toPresentationQuestion } from '../src/lib/protectedExamContract.js';

const attemptId = '86000000-0000-4000-8000-000000000101';
const itemId = '86000000-0000-4000-8000-000000000102';
const hash = 'a'.repeat(64);
const starterWorkspace = Object.freeze({
  entryPoint: 'main.py',
  files: Object.freeze([
    Object.freeze({ path: 'main.py', content: 'print("starter")\n' }),
    Object.freeze({ path: 'support/helper.py', content: 'VALUE = 1\n' }),
  ]),
});
const presentation = Object.freeze({
  interactionVersion: 'executable-python-lab-v1',
  task: 'Complete the synthetic Python task.',
  instructions: Object.freeze(['Edit the learner-visible files.', 'Save before requesting a run.']),
  starterWorkspace,
  allowedFilenames: Object.freeze(['main.py', 'support/helper.py']),
});
const publishedPresentation = Object.freeze({
  coverageTags: Object.freeze(['synthetic-python', 'executable-python-lab-v1']),
  difficulty: 'medium',
  editableFiles: Object.freeze(['main.py']),
  instructions: 'Implement the learner-visible synthetic requirement, then save the file.',
  interactionVersion: 'executable-python-lab-v1',
  language: 'python',
  officialObjectiveKey: 'synthetic-objective',
  officialSkillGroup: 'executable-python-lab-v1',
  starterCode: 'def synthetic_function():\n    return None\n',
});

test('published Python Next Generation presentation adapts to the browser workspace contract', () => {
  const normalized = normalizePythonLabPresentation(publishedPresentation);
  assert.equal(normalized.task, 'Python coding task');
  assert.deepEqual(normalized.instructions, [publishedPresentation.instructions]);
  assert.deepEqual(normalized.starterWorkspace, {
    entryPoint: 'main.py',
    files: [{ path: 'main.py', content: publishedPresentation.starterCode }],
  });
  assert.deepEqual(normalized.allowedFilenames, ['main.py']);
});

test('published presentation adapter rejects ambiguous or incomplete workspace mappings', () => {
  assert.throws(() => normalizePythonLabPresentation({
    ...publishedPresentation,
    editableFiles: ['main.py', 'helper.py'],
  }), /invalid_python_lab_starter_workspace/);
  assert.throws(() => normalizePythonLabPresentation({
    ...publishedPresentation,
    starterCode: undefined,
  }), /invalid_python_lab_starter_workspace/);
});

test('initial load uses the learner-visible starter workspace without persisting it', async () => {
  const mapped = toPresentationQuestion({
    itemId,
    presentation,
    questionType: 'executable-python-lab-v1',
    revision: 0,
  });
  assert.equal(mapped.interactionVersion, 'executable-python-lab-v1');
  const { client, calls } = fakeClient();
  const controller = createController(client);
  assert.equal(await controller.load(), true);
  assert.deepEqual(controller.getSnapshot().workspace, starterWorkspace);
  assert.equal(controller.getSnapshot().serverRevision, 0);
  assert.equal(controller.getSnapshot().persisted, false);
  assert.deepEqual(calls.map((entry) => entry.method), ['getPythonWorkspace']);
});

test('server resume restores the exact latest workspace revision', async () => {
  const restored = { entryPoint: 'main.py', files: [{ path: 'main.py', content: 'print("restored")\n' }, { path: 'support/helper.py', content: 'VALUE = 2\n' }] };
  const { client } = fakeClient({
    getPythonWorkspace: async () => workspaceRead({ exists: true, revision: 4, workspace: restored }),
  });
  const controller = createController(client);
  assert.equal(await controller.load(), true);
  assert.deepEqual(controller.getSnapshot().workspace, restored);
  assert.equal(controller.getSnapshot().serverRevision, 4);
  assert.equal(controller.getSnapshot().persisted, true);
});

test('save persists edited source and records the returned revision', async () => {
  const { client, calls } = fakeClient();
  const controller = createController(client);
  await controller.load();
  controller.updateFile('main.py', 'print("saved")\n');
  assert.equal(await controller.save(), true);
  assert.equal(calls[1].method, 'savePythonWorkspace');
  assert.equal(calls[1].args[2].files[0].content, 'print("saved")\n');
  assert.equal(calls[1].args[3], 0);
  assert.equal(controller.getSnapshot().serverRevision, 1);
  assert.equal(controller.getSnapshot().dirty, false);
});

test('ambiguous save retry reuses one request ID and server success is idempotent', async () => {
  const requestIds = [];
  let saves = 0;
  const { client } = fakeClient({
    savePythonWorkspace: async (...args) => {
      requestIds.push(args[4]);
      saves += 1;
      if (saves === 1) throw clientError('network_failure', { ambiguousTransport: true });
      return workspaceSave(1);
    },
  });
  const controller = createController(client, ['save-request-1']);
  await controller.load();
  controller.updateFile('main.py', 'print("retry")\n');
  assert.equal(await controller.save(), false);
  assert.equal(await controller.save(), true);
  assert.deepEqual(requestIds, ['save-request-1', 'save-request-1']);
  assert.equal(await controller.save(), true);
  assert.equal(saves, 2);
});

test('revision conflict preserves local edits and offers authoritative recovery', async () => {
  let reads = 0;
  const { client } = fakeClient({
    getPythonWorkspace: async () => {
      reads += 1;
      return reads === 1
        ? workspaceRead()
        : workspaceRead({
            exists: true,
            revision: 7,
            workspace: { entryPoint: 'main.py', files: [{ path: 'main.py', content: 'print("server")\n' }, { path: 'support/helper.py', content: 'VALUE = 7\n' }] },
          });
    },
    savePythonWorkspace: async () => { throw clientError('revision_conflict'); },
  });
  const controller = createController(client);
  await controller.load();
  controller.updateFile('main.py', 'print("local")\n');
  assert.equal(await controller.save(), false);
  assert.equal(controller.getSnapshot().phase, 'conflict');
  assert.equal(controller.getSnapshot().workspace.files[0].content, 'print("local")\n');
  assert.equal(controller.getSnapshot().conflict.revision, 7);
  assert.equal(controller.resolveConflict('use-server'), true);
  assert.equal(controller.getSnapshot().workspace.files[0].content, 'print("server")\n');
  assert.equal(controller.getSnapshot().dirty, false);
});

test('keep-local conflict choice advances expected revision without overwriting edits', async () => {
  let reads = 0;
  let saveCalls = 0;
  const { client } = fakeClient({
    getPythonWorkspace: async () => (++reads === 1
      ? workspaceRead()
      : workspaceRead({ exists: true, revision: 3, workspace: starterWorkspace })),
    savePythonWorkspace: async (...args) => {
      saveCalls += 1;
      if (saveCalls === 1) throw clientError('revision_conflict');
      assert.equal(args[3], 3);
      assert.equal(args[2].files[0].content, 'print("mine")\n');
      return workspaceSave(4);
    },
  });
  const controller = createController(client, ['first-save', 'second-save']);
  await controller.load();
  controller.updateFile('main.py', 'print("mine")\n');
  await controller.save();
  assert.equal(controller.resolveConflict('keep-local'), true);
  assert.equal(controller.getSnapshot().dirty, true);
  assert.equal(await controller.save(), true);
  assert.equal(controller.getSnapshot().serverRevision, 4);
});

test('run saves a dirty workspace before requesting its returned revision', async () => {
  const order = [];
  const { client } = fakeClient({
    savePythonWorkspace: async () => { order.push('save'); return workspaceSave(2); },
    requestPythonRun: async (...args) => {
      order.push('run');
      assert.equal(args[2], 2);
      return runDto({ state: 'queued' });
    },
  });
  const controller = createController(client, ['save-id', 'run-id']);
  await controller.load();
  controller.updateFile('main.py', 'print("run")\n');
  assert.equal(await controller.requestRun(), true);
  assert.deepEqual(order, ['save', 'run']);
  assert.equal(controller.getSnapshot().run.state, 'queued');
});

test('executor_disabled becomes a bounded availability state without fake output', async () => {
  const { client } = fakeClient({
    requestPythonRun: async () => { throw clientError('executor_disabled', { httpStatus: 503 }); },
  });
  const controller = createController(client, ['save-id', 'run-id']);
  await controller.load();
  await controller.save();
  assert.equal(await controller.requestRun(), false);
  assert.equal(controller.getSnapshot().phase, 'executor-disabled');
  assert.deepEqual(controller.getSnapshot().availability, { code: 'executor_disabled' });
  assert.equal(controller.getSnapshot().run, null);
  assert.equal(Object.hasOwn(controller.getSnapshot(), 'output'), false);
});

test('status refresh consumes only the bounded R5 run DTO', async () => {
  const { client } = fakeClient({
    requestPythonRun: async () => runDto({ state: 'queued' }),
    getPythonRun: async () => runDto({ state: 'completed', terminalOutcome: 'completed', stdout: 'safe\n', exitCode: 0, disposalState: 'confirmed' }),
  });
  const controller = createController(client);
  await controller.load();
  await controller.save();
  await controller.requestRun();
  assert.equal(await controller.refreshRun(), true);
  assert.equal(controller.getSnapshot().run.state, 'completed');
  assert.equal(controller.getSnapshot().run.terminalOutcome, 'completed');
  assert.equal(controller.getSnapshot().run.stdout, 'safe\n');
});

test('cancel uses a stable request ID and accepts the generic cancellation DTO', async () => {
  const cancellations = [];
  const { client } = fakeClient({
    requestPythonRun: async () => runDto({ state: 'running' }),
    cancelPythonRun: async (...args) => {
      cancellations.push(args);
      return runDto({ state: 'cancel_requested', cancellationRequestedAt: '2026-09-14T12:01:00Z' });
    },
  });
  const controller = createController(client, ['save-id', 'run-id', 'cancel-id']);
  await controller.load();
  await controller.save();
  await controller.requestRun();
  assert.equal(await controller.cancelRun(), true);
  assert.equal(cancellations[0][3], 'cancel-id');
  assert.equal(controller.getSnapshot().run.state, 'cancel_requested');
});

test('authentication failure is explicit and fails closed', async () => {
  const { client } = fakeClient({
    getPythonWorkspace: async () => { throw clientError('unauthenticated', { message: 'Sign in again.' }); },
  });
  const controller = createController(client);
  assert.equal(await controller.load(), false);
  assert.equal(controller.getSnapshot().phase, 'auth-error');
  assert.equal(controller.getSnapshot().errorCode, 'unauthenticated');
});

test('flush persists the workspace for Save & exit and navigation guards', async () => {
  const { client, calls } = fakeClient();
  const controller = createController(client);
  await controller.load();
  controller.updateFile('main.py', 'print("flush")\n');
  assert.equal(await controller.flush(), true);
  assert.equal(calls.filter((entry) => entry.method === 'savePythonWorkspace').length, 1);
  assert.equal(controller.getSnapshot().dirty, false);
});

test('presentation rejects protected grading and model-solution fields', () => {
  for (const protectedField of [
    { modelSolution: 'blocked' },
    { scoringRules: ['blocked'] },
    { answerKey: 'blocked' },
    { hiddenTests: ['blocked'] },
    { expectedOutput: 'blocked' },
    { gradingKey: 'blocked' },
    { protectedMaterialDigest: hash },
    { correctCode: 'blocked' },
  ]) {
    assert.throws(() => normalizePythonLabPresentation({ ...presentation, ...protectedField }), /protected_field_detected/);
  }
});

test('run DTO accepts bounded learner output and rejects internal fields', () => {
  assert.equal(normalizePythonRunDto(runDto({ stdout: 'safe\n', stderr: 'notice\n' })).stdout, 'safe\n');
  for (const blocked of [
    { gradingOutput: 'blocked' },
    { executionRequestDigest: hash },
    { providerExecutionId: 'blocked' },
  ]) {
    assert.throws(() => normalizePythonRunDto({ ...runDto(), ...blocked }), /invalid_python_run/);
  }
});

test('workspace validation rejects traversal, non-Python, duplicates, and oversized source', () => {
  for (const invalid of [
    { entryPoint: '../main.py', files: [{ path: '../main.py', content: '' }] },
    { entryPoint: 'main.txt', files: [{ path: 'main.txt', content: '' }] },
    { entryPoint: 'main file.py', files: [{ path: 'main file.py', content: '' }] },
    { entryPoint: 'main.py', files: [{ path: 'main.py', content: '' }, { path: 'MAIN.PY', content: '' }] },
    { entryPoint: 'main.py', files: [{ path: 'main.py', content: 'x'.repeat(64 * 1024 + 1) }] },
  ]) assert.throws(() => normalizePythonWorkspace(invalid), /invalid_python_workspace/);
});

function createController(client, requestIds = ['request-1', 'request-2', 'request-3']) {
  let index = 0;
  return createPythonLabWorkspaceController({
    attemptId,
    client,
    createRequestId: () => requestIds[index++] ?? `request-${index}`,
    itemId,
    presentation,
  });
}

function fakeClient(overrides = {}) {
  const calls = [];
  const defaults = {
    getPythonWorkspace: async () => workspaceRead(),
    savePythonWorkspace: async (...args) => workspaceSave((args[3] ?? 0) + 1),
    requestPythonRun: async () => runDto(),
    getPythonRun: async () => runDto(),
    cancelPythonRun: async () => runDto({ state: 'cancel_requested', cancellationRequestedAt: '2026-09-14T12:01:00Z' }),
  };
  const client = Object.fromEntries(Object.entries(defaults).map(([method, fallback]) => [method, async (...args) => {
    calls.push({ method, args });
    return (overrides[method] ?? fallback)(...args);
  }]));
  return { calls, client };
}

function workspaceRead({ exists = false, revision = 0, workspace = null } = {}) {
  return {
    itemId,
    exists,
    revision,
    workspaceHash: exists ? hash : null,
    workspace,
    updatedAt: exists ? '2026-09-14T12:00:00Z' : null,
  };
}

function workspaceSave(revision) {
  return { itemId, revision, workspaceHash: hash, updatedAt: '2026-09-14T12:00:00Z' };
}

function runDto(overrides = {}) {
  return {
    runId: '86000000-0000-4000-8000-000000000103',
    state: 'authorized',
    terminalOutcome: null,
    stdout: '',
    stderr: '',
    exitCode: null,
    cancellationRequestedAt: null,
    disposalState: 'not_requested',
    createdAt: '2026-09-14T12:00:00Z',
    updatedAt: '2026-09-14T12:00:00Z',
    ...overrides,
  };
}

function clientError(code, extras = {}) {
  return Object.assign(new Error(extras.message ?? code), { code, ...extras });
}
