import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import {
  EXECUTION_REQUEST_VERSION,
  EXECUTION_RESULT_VERSION,
  createSignedExecutionEnvelope,
} from '../../python-executor/src/contract.mjs';
import { createGradingBinding } from '../../python-grading/src/contract.mjs';
import {
  TRUSTED_GRADING_CONTRACT_VERSION,
  createTrustedGradingMaterialDigest,
} from '../../python-grading/src/trusted-grading-contract.mjs';
import { createModalBridgeServer } from '../src/server.mjs';
import { executeModalBridgePayload, gradeModalBridgePayload } from '../src/service.mjs';
import { executeSignedRequestToTerminal } from '../src/terminal-execution.mjs';

const SECRET = 'synthetic-execution-signing-secret-00000000000000000000';
const GRADING_SECRET = 'synthetic-grading-signing-secret-000000000000000000000';
const REQUEST_ID = 'request.11111111-1111-4111-8111-111111111111';
const EXECUTION_ID = 'execution.11111111-1111-4111-8111-111111111111';
const request = {
  contractVersion: EXECUTION_REQUEST_VERSION,
  requestId: REQUEST_ID,
  runtime: { language: 'python', contract: 'python-source-v1' },
  workspace: { entryPoint: 'main.py', files: [{ path: 'main.py', content: 'print("safe")\n' }] },
  limits: { wallTimeMs: 20_000, memoryBytes: 128 * 1024 * 1024, outputBytes: 1024 * 1024 },
};
const envelope = createSignedExecutionEnvelope(request, SECRET);
const gradingMaterial = {
  contractVersion: TRUSTED_GRADING_CONTRACT_VERSION,
  taskId: 'synthetic-http-grade',
  maximumRawPoints: 1,
  rules: [{
    id: 'rule.synthetic-http-structure',
    type: 'AST',
    points: 1,
    compiled: {
      contractVersion: TRUSTED_GRADING_CONTRACT_VERSION,
      family: 'ast_features',
      requiredNodes: [{ type: 'Call', minimum: 1 }],
      requiredCalls: ['print'],
      requiredNames: [],
      requiredDefinitions: [],
      requiredAttributes: [],
      requiredLiterals: [],
      requiredOperators: [],
      forbiddenCalls: [],
      forbiddenAttributes: [],
      orderedNames: [],
      requireDynamicReturn: false,
    },
  }],
};
const gradingBinding = createGradingBinding({
  gradingSessionId: 'grading-session.synthetic-http-001',
  request,
  materializationId: 'materialization.synthetic-http-001',
  materialDigest: createTrustedGradingMaterialDigest(gradingMaterial),
  gradingContractVersion: TRUSTED_GRADING_CONTRACT_VERSION,
  maximumRawPoints: 1,
});

function result(status, values = {}) {
  return {
    contractVersion: EXECUTION_RESULT_VERSION,
    executionId: EXECUTION_ID,
    status,
    stdout: values.stdout ?? '',
    stderr: values.stderr ?? '',
    exitCode: values.exitCode ?? null,
    outcome: values.outcome ?? null,
    diagnostics: [],
  };
}

function fakeProvider({ activePolls = 1 } = {}) {
  const calls = [];
  let polls = 0;
  return {
    calls,
    execute: async () => { calls.push('execute'); return result('accepted'); },
    getStatus: async () => {
      calls.push('status');
      polls += 1;
      return polls <= activePolls
        ? result('running')
        : result('finished', { stdout: 'safe\n', stderr: 'notice\n', exitCode: 0, outcome: 'completed' });
    },
    cancel: async () => { calls.push('cancel'); return result('cancelled', { outcome: 'cancelled' }); },
    dispose: async () => { calls.push('dispose'); return polls <= activePolls
      ? result('cancelled', { outcome: 'cancelled' })
      : result('finished', { stdout: 'safe\n', stderr: 'notice\n', exitCode: 0, outcome: 'completed' }); },
    close: async () => { calls.push('close'); },
  };
}

test('one authenticated request runs to terminal and confirms disposal', async () => {
  const provider = fakeProvider();
  const response = await executeSignedRequestToTerminal({
    envelope, provider, request, signingSecret: SECRET, pollIntervalMs: 1,
  });
  assert.equal(response.disposalConfirmed, true);
  assert.equal(response.result.status, 'finished');
  assert.equal(response.result.stdout, 'safe\n');
  assert.deepEqual(provider.calls, ['execute', 'status', 'status', 'dispose', 'close']);
});

test('bad R2 authentication is rejected before execution', async () => {
  const provider = fakeProvider();
  await assert.rejects(
    executeSignedRequestToTerminal({
      envelope: { ...envelope, signature: '0'.repeat(64) },
      provider,
      request,
      signingSecret: SECRET,
    }),
    { code: 'REQUEST_AUTHENTICATION_FAILED' },
  );
  assert.deepEqual(provider.calls, []);
});

test('abort converges on provider cancellation and disposal', async () => {
  const provider = fakeProvider({ activePolls: 20 });
  const abort = new AbortController();
  setTimeout(() => abort.abort(), 2);
  const response = await executeSignedRequestToTerminal({
    envelope, provider, request, signingSecret: SECRET,
    signal: abort.signal, pollIntervalMs: 10,
  });
  assert.equal(response.result.status, 'cancelled');
  assert.equal(response.disposalConfirmed, true);
  assert.ok(provider.calls.includes('cancel'));
  assert.ok(provider.calls.includes('dispose'));
});

test('service accepts only the exact request and envelope payload', async () => {
  const provider = fakeProvider();
  const response = await executeModalBridgePayload({ request, envelope }, {
    env: { CERTSIM_EXECUTION_SIGNING_SECRET: SECRET },
    providerFactory: async () => provider,
  });
  assert.equal(response.result.outcome, 'completed');
  await assert.rejects(
    executeModalBridgePayload({ request, envelope, actorId: 'blocked' }, {
      env: { CERTSIM_EXECUTION_SIGNING_SECRET: SECRET },
      providerFactory: async () => fakeProvider(),
    }),
    { code: 'invalid_request' },
  );
  const missingSecretProvider = fakeProvider();
  await assert.rejects(
    executeModalBridgePayload({ request, envelope }, {
      env: {},
      providerFactory: async () => missingSecretProvider,
    }),
    { code: 'service_unavailable' },
  );
  assert.deepEqual(missingSecretProvider.calls, []);
});

test('private grading fails closed when disabled, missing its key, or sharing the R2 key', async () => {
  const payload = { request, envelope, binding: gradingBinding, gradingMaterial };
  let providerCreated = false;
  const providerFactory = async () => { providerCreated = true; return fakeProvider(); };
  await assert.rejects(
    gradeModalBridgePayload(payload, {
      env: { CERTSIM_EXECUTION_SIGNING_SECRET: SECRET }, providerFactory,
    }),
    { code: 'service_unavailable' },
  );
  await assert.rejects(
    gradeModalBridgePayload(payload, {
      env: {
        CERTSIM_EXECUTION_SIGNING_SECRET: SECRET,
        CERTSIM_PYTHON_GRADING_ENABLED: 'YES',
      },
      providerFactory,
    }),
    { code: 'service_unavailable' },
  );
  await assert.rejects(
    gradeModalBridgePayload(payload, {
      env: {
        CERTSIM_EXECUTION_SIGNING_SECRET: SECRET,
        CERTSIM_GRADING_SIGNING_SECRET: SECRET,
        CERTSIM_PYTHON_GRADING_ENABLED: 'YES',
      },
      providerFactory,
    }),
    { code: 'service_unavailable' },
  );
  assert.equal(providerCreated, false);
});

test('HTTP bridge runs synthetic execution and grading through the real service handlers', async (t) => {
  const server = createModalBridgeServer({
    execute: (payload) => executeModalBridgePayload(payload, {
      env: { CERTSIM_EXECUTION_SIGNING_SECRET: SECRET },
      providerFactory: async () => fakeProvider(),
    }),
    grade: (payload) => gradeModalBridgePayload(payload, {
      env: {
        CERTSIM_EXECUTION_SIGNING_SECRET: SECRET,
        CERTSIM_GRADING_SIGNING_SECRET: GRADING_SECRET,
        CERTSIM_PYTHON_GRADING_ENABLED: 'YES',
      },
      providerFactory: async () => fakeProvider(),
    }),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const { port } = server.address();
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, nodeMajor: Number(process.versions.node.split('.')[0]) });
  const missing = await fetch(`http://127.0.0.1:${port}/v1/status`);
  assert.equal(missing.status, 404);
  const executed = await fetch(`http://127.0.0.1:${port}/v1/execute`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request, envelope }),
  });
  assert.equal(executed.status, 200);
  assert.equal((await executed.json()).disposalConfirmed, true);
  const graded = await fetch(`http://127.0.0.1:${port}/v1/grade`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ request, envelope, binding: gradingBinding, gradingMaterial }),
  });
  assert.equal(graded.status, 200);
  const gradedBody = await graded.json();
  assert.equal(gradedBody.evidence.earnedRawPoints, 1);
  assert.deepEqual(gradedBody.evidence.rules, [{
    ruleId: 'rule.synthetic-http-structure', earnedRawPoints: 1, maximumRawPoints: 1,
  }]);
});
