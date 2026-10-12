import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

const vite = await createServer({
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, watch: null },
});
const {
  default: ExamOperationsPage,
  createHistoryRequestController,
  ExamHealth,
  OperationHistory,
} = await vite.ssrLoadModule('/src/components/admin/ExamOperationsPage.jsx');
const {
  EXAM_OPERATIONS_EXAMS,
  loadExamOperationsHealth,
  loadExamOperationsHistory,
  normalizeHealth,
  normalizeOperation,
} = await vite.ssrLoadModule('/src/lib/examOperationsService.js');

const pageSource = await readFile('src/components/admin/ExamOperationsPage.jsx', 'utf8');
const accountSource = await readFile('src/components/account/AccountPage.jsx', 'utf8');
const appSource = await readFile('src/App.jsx', 'utf8');

assert.deepEqual(
  EXAM_OPERATIONS_EXAMS.map(({ code }) => code).sort(),
  ['AI-901', 'AZ-204', 'AZ-400', 'INF-303', 'Python', 'SC-200', 'SY0-701'].sort(),
  'the operator list is derived from the seven protected exam metadata entries',
);
assert.match(accountSource, /isPlatformOwner\s*\?\s*\([\s\S]*?title="Exam Operations"/);
assert.match(appSource, /routePath === '\/admin\/exam-operations'/);
assert.match(appSource, /screen === 'admin-exam-operations'/);

const deniedCalls = [];
const deniedMarkup = renderToStaticMarkup(React.createElement(ExamOperationsPage, {
  identity: {
    isAuthenticated: true,
    isPlatformOwner: false,
    isSupabaseConfigured: true,
    loading: false,
  },
  service: {
    loadHistory: (...args) => deniedCalls.push(args),
    loadOverview: (...args) => deniedCalls.push(args),
  },
}));
assert.match(deniedMarkup, /Exam Operations access denied/);
assert.doesNotMatch(deniedMarkup, /Current release configuration/);
assert.equal(deniedCalls.length, 0, 'non-owner server render performs no data read');

const signedOutMarkup = renderToStaticMarkup(React.createElement(ExamOperationsPage, {
  identity: {
    isAuthenticated: false,
    isPlatformOwner: false,
    isSupabaseConfigured: true,
    loading: false,
  },
}));
assert.match(signedOutMarkup, /Sign in to continue/);

const baseHealth = normalizeHealth({
  catalogueLifecycle: 'production_ready',
  catalogueStatus: 'active',
  catalogueVersion: '1.0.0',
  configurationHash: 'a'.repeat(64),
  currentContinuationContracts: 3,
  currentContinuableAttempts: 3,
  currentMissingContinuationContracts: 0,
  currentPackageVersion: '1.0.0',
  currentPracticeAttempts: 2,
  currentStateFindings: [],
  currentStateStatus: 'CURRENT_STATE_VALID',
  currentTimedAttempts: 1,
  enabledDefaultCount: 6,
  enabledProfileCount: 1,
  examKey: 'az400',
  frozenSubmitCount: 0,
  generatorVersion: 'safe-generator-v1',
  healthSchema: 'certsim-exam-operations-health-v1',
  healthStatus: 'VALID',
  observedAt: '2026-09-21T06:00:00.000Z',
  olderPackageContinuableAttempts: 1,
  packageHash: 'b'.repeat(64),
  packageSchemaVersion: 'certsim-protected-package-v2',
  packageStatus: 'published',
  productionActivationCount: 1,
  releaseEvidencePackageVersion: '1.0.0',
  releaseEvidenceProfileKey: 'full',
  releaseEvidenceSource: 'legacy-release-configuration',
  releaseEvidenceStage: 'production',
  releaseEvidenceTimestamp: '2026-09-20T06:00:00.000Z',
  scorerVersion: 'safe-scorer-v1',
  sourceCommitSha: 'c'.repeat(40),
  telemetry: {
    DEPLOYMENT_CORRELATION: 'NOT_AVAILABLE',
    POST_RELEASE_HEALTH_EVENT: 'NOT_AVAILABLE',
    SAVE_FAILURE_TELEMETRY: 'NOT_AVAILABLE',
    SUBMIT_FAILURE_TELEMETRY: 'NOT_AVAILABLE',
  },
  usablePracticePolicyCount: 5,
  validationHash: 'd'.repeat(64),
});
const healthyMarkup = renderToStaticMarkup(React.createElement(ExamHealth, {
  exam: { code: 'AZ-400', examKey: 'az400', health: baseHealth, title: 'AZ-400 fixture' },
}));
assert.match(healthyMarkup, /CURRENT STATE VALID/i);
assert.match(healthyMarkup, /Continuation health/);
assert.match(healthyMarkup, /Contracts present/);
assert.equal((healthyMarkup.match(/<strong>Not available<\/strong>/g) ?? []).length, 4);
assert.match(healthyMarkup, /Legacy release evidence is shown separately/);

for (const examKey of ['ai901', 'az204']) {
  const blocked = normalizeHealth({
    ...baseHealth,
    currentStateFindings: ['CURRENT_CATALOGUE_VERSION_MISMATCH'],
    currentStateStatus: 'BLOCKED_CURRENT_STATE_INVALID',
    examKey,
    healthStatus: 'BLOCKED',
  });
  const markup = renderToStaticMarkup(React.createElement(ExamHealth, {
    exam: { code: examKey.toUpperCase(), examKey, health: blocked, title: `${examKey} fixture` },
  }));
  assert.match(markup, /BLOCKED/);
  assert.match(markup, /Current Catalogue Version Mismatch/);
  assert.doesNotMatch(markup, /<button[^>]*>\s*(?:Stage|Activate|Rollback|Publish|Retire|Promote)/i);
}

const missingContractMarkup = renderToStaticMarkup(React.createElement(ExamHealth, {
  exam: {
    code: 'AZ-400', examKey: 'az400', title: 'AZ-400 fixture',
    health: normalizeHealth({
      ...baseHealth,
      currentContinuationContracts: 2,
      currentMissingContinuationContracts: 1,
      healthStatus: 'BLOCKED',
    }),
  },
}));
assert.match(missingContractMarkup, /Critical: 1 currently continuable attempt lacks an immutable continuation contract/);

const emptyHistoryMarkup = renderToStaticMarkup(React.createElement(OperationHistory, {
  error: false,
  history: [],
  loading: false,
}));
assert.match(emptyHistoryMarkup, /No Exam Operations releases have been recorded yet/);

const safeOperation = normalizeOperation({
  actorId: '13340000-0000-4000-8000-000000000001',
  completedAt: '2026-09-21T06:05:00.000Z',
  operationId: '13340000-0000-4000-8000-000000000002',
  operationType: 'ACTIVATE',
  postconditions: { currentPackageVersion: '2.0.0', outcome: 'SUCCEEDED' },
  resultState: 'succeeded',
});
assert.deepEqual(Object.keys(safeOperation).sort(), [
  'completedAt', 'createdAt', 'operationType', 'outcome', 'resultState', 'targetVersion',
].sort());
const historyMarkup = renderToStaticMarkup(React.createElement(OperationHistory, {
  error: false,
  history: [safeOperation],
  loading: false,
}));
assert.match(historyMarkup, /Activate/);
assert.match(historyMarkup, /Platform Owner/);
assert.doesNotMatch(historyMarkup, /13340000-/);

const rollbackOperation = normalizeOperation({
  actorId: '13340000-0000-4000-8000-000000000003',
  operationId: '13340000-0000-4000-8000-000000000004',
  operationType: 'ROLLBACK',
  postconditions: { restoredPackageVersion: '1.0.0', outcome: 'SUCCEEDED' },
  resultState: 'succeeded',
});
assert.equal(rollbackOperation.targetVersion, '1.0.0');
const rollbackMarkup = renderToStaticMarkup(React.createElement(OperationHistory, {
  error: false,
  history: [rollbackOperation],
  loading: false,
}));
assert.match(rollbackMarkup, /Rollback/);
assert.match(rollbackMarkup, /1\.0\.0/);
assert.doesNotMatch(rollbackMarkup, /13340000-/);

const calls = [];
const fakeClient = {
  async rpc(name, parameters) {
    calls.push({ name, parameters });
    if (name === 'certsim_examops_get_health') return { data: { ...baseHealth, ok: true }, error: null };
    return {
      data: {
        ok: true,
        operations: [{
          actorId: 'private-actor-id',
          operationId: 'private-operation-id',
          operationType: 'STAGE',
          preflight: { targetPackageVersion: '1.1.0' },
          resultState: 'succeeded',
        }],
      },
      error: null,
    };
  },
};
assert.equal((await loadExamOperationsHealth('AZ-400', { client: fakeClient })).ok, true);
const historyResult = await loadExamOperationsHistory('AZ-400', { client: fakeClient, limit: 500 });
assert.equal(historyResult.ok, true);
assert.equal(historyResult.data[0].targetVersion, '1.1.0');
assert.equal(JSON.stringify(historyResult.data).includes('private-'), false);
assert.equal(calls[1].parameters.p_limit, 50, 'history request is bounded');

const backendFailure = await loadExamOperationsHealth('az400', {
  client: { rpc: async () => ({ data: null, error: { message: 'private database detail' } }) },
});
assert.equal(backendFailure.reason, 'backend_unavailable');
assert.equal(backendFailure.message.includes('private database detail'), false);

for (const label of ['Stage', 'Activate', 'Rollback', 'Publish', 'Retire', 'Promote']) {
  assert.doesNotMatch(pageSource, new RegExp(`<button[^>]*>[^<]*${label}`, 'i'));
}
assert.doesNotMatch(pageSource, /certsim_examops_(?:stage|activate|rollback)/i);
assert.match(pageSource, /loadOverview\(\{ refresh: true \}\)/);
assert.match(pageSource, /Refreshing\.\.\./);
assert.match(pageSource, /historyRequestControllerRef\.current\.invalidate\(\)/);

await proveHistoryRequestRaces();

await vite.close();

console.log('PASS Issue #133 Phase 5A frontend/service validation');
console.log('  owner boundary, release history accuracy, stale-request suppression, health states, telemetry, continuation, refresh, and sanitized errors are covered');

async function proveHistoryRequestRaces() {
  const successController = createHistoryRequestController();
  const successState = createHistoryState();
  const az400 = deferred();
  const sc200 = deferred();
  const requestA = successController.run(() => az400.promise, handlersFor(successState));
  successController.invalidate();
  const requestB = successController.run(() => sc200.promise, handlersFor(successState));

  sc200.resolve({ ok: true, data: [{ operationType: 'SC200_CURRENT' }] });
  assert.deepEqual(await requestB, { applied: true, stale: false });
  assert.deepEqual(successState.history, [{ operationType: 'SC200_CURRENT' }]);
  assert.equal(successState.loading, false);

  az400.resolve({ ok: true, data: [{ operationType: 'AZ400_STALE' }] });
  assert.deepEqual(await requestA, { applied: false, stale: true });
  assert.deepEqual(successState.history, [{ operationType: 'SC200_CURRENT' }]);
  assert.equal(successState.error, false);
  assert.equal(successState.loading, false);

  const failureController = createHistoryRequestController();
  const failureState = createHistoryState();
  const staleFailure = deferred();
  const currentSuccess = deferred();
  const failedRequest = failureController.run(
    () => staleFailure.promise,
    handlersFor(failureState),
  );
  failureController.invalidate();
  const currentRequest = failureController.run(
    () => currentSuccess.promise,
    handlersFor(failureState),
  );

  currentSuccess.resolve({ ok: true, data: [{ operationType: 'SC200_CURRENT' }] });
  await currentRequest;
  staleFailure.resolve({ ok: false, reason: 'backend_unavailable' });
  assert.deepEqual(await failedRequest, { applied: false, stale: true });
  assert.deepEqual(failureState.history, [{ operationType: 'SC200_CURRENT' }]);
  assert.equal(failureState.error, false);
  assert.equal(failureState.loading, false);
}

function createHistoryState() {
  return { error: false, history: [], loading: false };
}

function handlersFor(state) {
  return {
    onComplete: () => { state.loading = false; },
    onError: () => {
      state.error = true;
      state.history = [];
    },
    onStart: () => {
      state.error = false;
      state.loading = true;
    },
    onSuccess: (history) => {
      state.error = false;
      state.history = history;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}
