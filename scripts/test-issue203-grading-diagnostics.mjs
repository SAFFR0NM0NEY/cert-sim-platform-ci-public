// Local-only Issue #203 diagnostic. Synthetic tasks, credentials, transports,
// and clock; no network or database client is created.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createProtectedExamClient } from '../src/lib/protectedExamClient.js';

const bundled = await build({
  entryPoints: ['supabase/functions/certsim-protected-exam/python-grading.ts'],
  absWorkingDir: process.cwd(),
  bundle: true,
  write: false,
  platform: 'node',
  format: 'esm',
});
const {
  submitProtectedAttemptWithPythonGrading,
} = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const id = (n) => `86100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actorId = id(1);
const attemptId = id(2);
const submissionId = id(3);
const SECRET_SENTINEL = 'SENTINEL_PRIVATE_CONTENT_NOT_FOR_DIAGNOSTICS';
const executionSecret = 'synthetic-execution-secret-00000000000000000001';
const gradingSecret = 'synthetic-grading-secret-000000000000000000002';
const encoder = new TextEncoder();
const workspace = { entryPoint: 'main.py', files: [{ path: 'main.py', content: `# ${SECRET_SENTINEL}\n` }] };
const gradingMaterial = {
  contractVersion: 'synthetic-grading-v1', taskId: SECRET_SENTINEL, maximumRawPoints: 5,
  rules: [{ id: 'synthetic-rule', type: 'TOKEN', points: 5 }],
};

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
async function hmac(value) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(gradingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(bytes)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
const materialDigest = await sha256(canonicalJson(gradingMaterial));
const env = { get: (name) => ({
  CERTSIM_PYTHON_EXECUTION_ENABLED: 'YES',
  CERTSIM_PYTHON_GRADING_ENABLED: 'YES',
  CERTSIM_MODAL_BRIDGE_URL: 'https://synthetic.invalid',
  CERTSIM_MODAL_PROXY_KEY: SECRET_SENTINEL,
  CERTSIM_MODAL_PROXY_SECRET: `proxy-${SECRET_SENTINEL}`,
  CERTSIM_EXECUTION_SIGNING_SECRET: executionSecret,
  CERTSIM_GRADING_SIGNING_SECRET: gradingSecret,
})[name] };
const jsonResponse = (value) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const taskFromNumber = (n) => Math.floor((n % 100) / 10);
const generationFromNumber = (n) => n % 10;
const item = (task, generation) => ({
  itemId: id(100 + task),
  runId: id(200 + task * 10 + generation),
  state: 'authorized',
  attemptNumber: generation,
  executionRequestId: id(300 + task * 10 + generation),
  executionRequestDigest: null,
  workspaceRevision: 1,
  workspaceHash: 'a'.repeat(64),
  workspace,
  materializationId: id(400 + task * 10 + generation),
  gradingSessionId: id(500 + task * 10 + generation),
  materialDigest,
  gradingContractVersion: gradingMaterial.contractVersion,
  maximumRawPoints: 5,
  gradingMaterial,
  createdAt: '2026-09-21T00:00:00Z',
});
const executionResult = (requestId, cancelled = false) => ({
  contractVersion: 'certsim.python-execution.result.v1',
  executionId: `execution.${requestId}`,
  status: cancelled ? 'cancelled' : 'finished',
  stdout: '', stderr: '', exitCode: cancelled ? null : 0,
  outcome: cancelled ? 'cancelled' : 'completed', diagnostics: [],
});

async function gradeResponse(posted) {
  const { request, binding } = posted;
  const result = executionResult(request.requestId.slice('request.'.length));
  const evidence = {
    evidenceVersion: 'certsim.python-grading.evidence.v1',
    evidenceId: binding.gradingSessionId,
    gradingSessionId: binding.gradingSessionId,
    requestId: request.requestId,
    requestDigest: binding.requestDigest,
    executionId: result.executionId,
    executionResultDigest: await sha256(canonicalJson(result)),
    materializationId: binding.materializationId,
    materialDigest: binding.materialDigest,
    gradingContractVersion: binding.gradingContractVersion,
    earnedRawPoints: 4,
    maximumRawPoints: binding.maximumRawPoints,
    rules: [{ ruleId: 'synthetic-rule', earnedRawPoints: 4, maximumRawPoints: 5 }],
  };
  const canonical = canonicalJson(evidence);
  const frame = [
    'certsim.python-grading.evidence-signature.v1',
    'certsim.python-grading.evidence-envelope.v1',
    'certsim.python-grading.evidence.v1',
    String(encoder.encode(canonical).byteLength), canonical,
  ].join('\n');
  return {
    ok: true, executionResult: result, evidence,
    envelope: {
      envelopeVersion: 'certsim.python-grading.evidence-envelope.v1',
      algorithm: 'hmac-sha256', signature: await hmac(frame),
    },
    disposalConfirmed: true,
  };
}

function fixture({
  failingTasks = new Set(), gradeDelay = async () => {}, gradeBehavior,
  cancelBehavior, taskCount = 7, diagnosticNow = () => performance.now(),
  diagnosticSink, finalizationFails = false,
} = {}) {
  const diagnostics = [];
  const sink = diagnosticSink ?? ((event) => diagnostics.push(event));
  const recorded = { preparations: 0, materialized: [], terminal: [], cancelled: [], evidence: [], submitted: 0, activeGrades: 0, peakGrades: 0, order: [] };
  const evidenceTasks = new Set();
  const admin = { rpc: async (name, args) => {
    recorded.order.push({ name, runId: args.p_run_id });
    if (name === 'certsim_service_prepare_python_submission_grading') {
      recorded.preparations += 1;
      const generation = recorded.preparations === 1 ? 1 : 2;
      const items = Array.from({ length: taskCount }, (_, index) => {
        const task = index + 1;
        const current = item(task, failingTasks.has(task) ? generation : 1);
        return evidenceTasks.has(task) ? { ...current, state: 'graded' } : current;
      });
      return { data: { ok: true, required: true, ready: evidenceTasks.size === taskCount, completed: false, items }, error: null };
    }
    if (name === 'certsim_service_materialize_python_submission_grading') {
      recorded.materialized.push(args.p_run_id);
      return { data: { ok: true, claimed: true }, error: null };
    }
    if (name === 'certsim_service_request_python_submission_grading_cancellation') {
      recorded.cancelled.push(args.p_run_id);
      return { data: { ok: true, state: 'cancel_requested', disposalState: 'pending' }, error: null };
    }
    if (name === 'certsim_service_complete_python_execution') {
      recorded.terminal.push({ runId: args.p_run_id, state: args.p_state });
      return { data: { ok: true, runId: args.p_run_id, state: args.p_state }, error: null };
    }
    if (name === 'certsim_service_persist_verified_python_grading_evidence') {
      const task = taskFromNumber(Number(String(args.p_run_id).slice(-3)));
      evidenceTasks.add(task);
      recorded.evidence.push(args.p_run_id);
      return { data: { ok: true }, error: null };
    }
    if (name === 'certsim_protected_submit_attempt') {
      recorded.submitted += 1;
      if (finalizationFails) return { data: { ok: false, code: 'internal_failure' }, error: null };
      return { data: { ok: true, result: { attemptId, status: 'completed' } }, error: null };
    }
    throw new Error(`unexpected synthetic RPC: ${name}`);
  } };
  const fetchImpl = async (url, init) => {
    const posted = JSON.parse(String(init?.body));
    if (String(url).endsWith('/v1/cancel')) {
      if (cancelBehavior) return await cancelBehavior(posted, init);
      const requestId = posted.request.requestId.slice('request.'.length);
      return jsonResponse({ ok: true, result: executionResult(requestId, true), disposalConfirmed: true });
    }
    assert.equal(String(url), 'https://synthetic.invalid/v1/grade');
    const requestNumber = Number(String(posted.request.requestId).slice(-3));
    const task = taskFromNumber(requestNumber);
    recorded.activeGrades += 1;
    recorded.peakGrades = Math.max(recorded.peakGrades, recorded.activeGrades);
    try {
      await gradeDelay(task, init.signal);
      if (gradeBehavior) return await gradeBehavior(posted, task, init);
      if (failingTasks.has(task)) throw new Error('synthetic transport loss');
      return jsonResponse(await gradeResponse(posted));
    } finally {
      recorded.activeGrades -= 1;
    }
  };
  const run = () => submitProtectedAttemptWithPythonGrading({
    actorId, admin, attemptId, submissionId, env, fetchImpl, diagnosticSink: sink, diagnosticNow,
  });
  return { run, recorded, evidenceTasks, diagnostics };
}

const observed = fixture({ failingTasks: new Set([1, 3, 5]) });
await assert.rejects(observed.run(), { message: 'grading_failed' });
assert.equal(observed.recorded.preparations, 2);
assert.equal(observed.recorded.materialized.length, 10);
assert.equal(observed.recorded.cancelled.length, 6);
assert.equal(observed.recorded.terminal.length, 10);
assert.equal(observed.recorded.evidence.length, 4);
assert.equal(observed.recorded.submitted, 0);
assert.ok(observed.recorded.peakGrades >= 1 && observed.recorded.peakGrades <= 3);
assert.equal(observed.diagnostics.filter((x) => x.category === 'NETWORK_FAILURE').length, 6);
assert.equal(observed.diagnostics.filter((x) => x.category === 'TRANSPORT_RECONCILED').length, 6);
for (const runId of observed.recorded.cancelled) {
  const cancelIndex = observed.recorded.order.findIndex((x) => x.name === 'certsim_service_request_python_submission_grading_cancellation' && x.runId === runId);
  const terminalIndex = observed.recorded.order.findIndex((x) => x.name === 'certsim_service_complete_python_execution' && x.runId === runId);
  assert.ok(cancelIndex >= 0 && terminalIndex > cancelIndex);
}
console.log('OBSERVED_PATTERN_PASS: 7 tasks; 3 transport-reconciled twice; 4 verified; final submit not called');

async function expectTransportCase(label, gradeBehavior, category, upstreamCode = 'UNKNOWN_UPSTREAM_CODE') {
  let tick = 1_000;
  const sample = fixture({
    taskCount: 1, failingTasks: new Set([1]), gradeBehavior,
    diagnosticNow: () => { tick += 5; return tick; },
  });
  await assert.rejects(sample.run(), { message: 'grading_failed' });
  const failures = sample.diagnostics.filter((entry) => entry.stage === 'grade_request');
  assert.equal(failures.length, 2, label);
  for (const entry of failures) {
    assert.equal(entry.version, 'certsim.python-grading.diagnostic.v1');
    assert.equal(entry.category, category, label);
    assert.equal(entry.upstreamCode, upstreamCode, label);
    if (category === 'UNEXPECTED_CONTENT_TYPE' || category === 'MALFORMED_JSON') {
      assert.equal(entry.httpStatus, 200, label);
    }
    assert.equal(entry.pass === 1 || entry.pass === 2, true);
    assert.equal(entry.generation, entry.pass);
    assert.equal(entry.taskOrdinal, 1);
    assert.equal(entry.elapsedMs, 5);
    assert.equal(entry.ownTimeoutFired, false);
  }
  assert.equal(sample.recorded.cancelled.length, 2, label);
  assert.equal(sample.recorded.terminal.length, 2, label);
  assert.equal(sample.recorded.evidence.length, 0, label);
  assert.equal(sample.recorded.submitted, 0, label);
  assert.equal(JSON.stringify(sample.diagnostics).includes(SECRET_SENTINEL), false, label);
  assert.equal(JSON.stringify(sample.diagnostics).includes(attemptId), false, label);
  assert.equal(JSON.stringify(sample.diagnostics).includes(submissionId), false, label);
  return sample;
}

const allowedHttp = await expectTransportCase('allowlisted HTTP rejection',
  async () => new Response(JSON.stringify({ ok: false, code: 'grading_failed' }), {
    status: 503, headers: { 'content-type': 'application/json', 'x-private': SECRET_SENTINEL },
  }), 'HTTP_REJECTION', 'grading_failed');
assert.ok(allowedHttp.diagnostics.filter((x) => x.category === 'HTTP_REJECTION').every((x) => x.httpStatus === 503));

const maliciousHttp = await expectTransportCase('malicious HTTP body',
  async () => new Response(JSON.stringify({ ok: false, code: 'grading_failed', extra: SECRET_SENTINEL }), {
    status: 503, headers: { 'content-type': 'application/json' },
  }), 'HTTP_REJECTION');
assert.ok(maliciousHttp.diagnostics.filter((x) => x.category === 'HTTP_REJECTION').every((x) => x.httpStatus === 503));

await expectTransportCase('unknown upstream code',
  async () => new Response(JSON.stringify({ ok: false, code: `UNKNOWN_${SECRET_SENTINEL}` }), {
    status: 503, headers: { 'content-type': 'application/json' },
  }), 'HTTP_REJECTION');
await expectTransportCase('oversized upstream error body',
  async () => new Response(JSON.stringify({ ok: false, code: 'grading_failed', extra: SECRET_SENTINEL.repeat(50) }), {
    status: 503, headers: { 'content-type': 'application/json' },
  }), 'HTTP_REJECTION');
const stalledBodyStarted = performance.now();
await expectTransportCase('nonterminating upstream error body',
  async () => new Response(new ReadableStream({ start() {} }), {
    status: 503, headers: { 'content-type': 'application/json' },
  }), 'HTTP_REJECTION');
assert.ok(performance.now() - stalledBodyStarted < 1_000);
await expectTransportCase('non-JSON success',
  async () => new Response(SECRET_SENTINEL, { status: 200, headers: { 'content-type': 'text/plain' } }),
  'UNEXPECTED_CONTENT_TYPE');
await expectTransportCase('malformed JSON success',
  async () => new Response(`{${SECRET_SENTINEL}`, { status: 200, headers: { 'content-type': 'application/json' } }),
  'MALFORMED_JSON');
await expectTransportCase('network failure',
  async () => { throw new Error(SECRET_SENTINEL); }, 'NETWORK_FAILURE');
await expectTransportCase('foreign abort',
  async () => { throw new DOMException(SECRET_SENTINEL, 'AbortError'); }, 'EXTERNAL_ABORT');

const invalidEvidence = fixture({ taskCount: 1, gradeBehavior: async (posted) => {
  const body = await gradeResponse(posted);
  body.envelope.signature = '0'.repeat(64);
  return jsonResponse(body);
} });
await assert.rejects(invalidEvidence.run(), { message: 'grading_failed' });
assert.deepEqual(invalidEvidence.diagnostics.map((x) => x.category), ['EVIDENCE_VALIDATION_FAILURE']);
assert.equal(invalidEvidence.recorded.terminal.length, 1);
assert.equal(invalidEvidence.recorded.evidence.length, 0);
assert.equal(invalidEvidence.recorded.submitted, 0);

const failedCancellation = fixture({
  taskCount: 1, failingTasks: new Set([1]),
  gradeBehavior: async () => { throw new Error(SECRET_SENTINEL); },
  cancelBehavior: async () => { throw new Error(SECRET_SENTINEL); },
});
await assert.rejects(failedCancellation.run(), { message: 'grading_reconciliation_required' });
assert.ok(failedCancellation.diagnostics.some((x) => x.stage === 'grade_request' && x.category === 'NETWORK_FAILURE'));
assert.ok(failedCancellation.diagnostics.some((x) => x.stage === 'cancellation' && x.category === 'NETWORK_FAILURE'));
assert.ok(failedCancellation.diagnostics.some((x) => x.stage === 'reconciliation' && x.category === 'RECONCILIATION_FAILURE'));
assert.equal(JSON.stringify(failedCancellation.diagnostics).includes(SECRET_SENTINEL), false);
assert.equal(failedCancellation.recorded.terminal.length, 0);
assert.equal(failedCancellation.recorded.submitted, 0);

const throwingSink = fixture({
  taskCount: 1, failingTasks: new Set([1]),
  gradeBehavior: async () => { throw new Error(SECRET_SENTINEL); },
  diagnosticSink: () => { throw new Error(SECRET_SENTINEL); },
});
await assert.rejects(throwingSink.run(), { message: 'grading_failed' });
assert.equal(throwingSink.recorded.cancelled.length, 2);
assert.equal(throwingSink.recorded.terminal.length, 2);
assert.equal(throwingSink.recorded.submitted, 0);

const failedFinalization = fixture({ taskCount: 1, finalizationFails: true });
await assert.rejects(failedFinalization.run(), { message: 'internal_failure' });
assert.deepEqual(failedFinalization.diagnostics.map((x) => x.category), ['FINALIZATION_FAILURE']);
assert.equal(failedFinalization.recorded.evidence.length, 1);
assert.equal(failedFinalization.recorded.submitted, 1);
console.log('DIAGNOSTIC_BOUNDARY_PASS: HTTP allowlist/unknown, content type, JSON, network/foreign abort, evidence, reconciliation, sink, finalization');

class FakeClock {
  now = 0;
  nextId = 1;
  timers = new Map();
  scheduledMs = [];
  setTimeout = (fn, ms) => {
    this.scheduledMs.push(Number(ms));
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + Number(ms), fn });
    return id;
  };
  clearTimeout = (id) => this.timers.delete(id);
  async advanceNext() {
    const [id, timer] = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
    if (id === undefined) return false;
    this.timers.delete(id);
    this.now = timer.at;
    timer.fn();
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
    return true;
  }
}

const clock = new FakeClock();
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realAbortTimeout = AbortSignal.timeout;
try {
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
  AbortSignal.timeout = (ms) => {
    const controller = new AbortController();
    clock.setTimeout(() => controller.abort(new DOMException('synthetic timeout', 'TimeoutError')), ms);
    return controller.signal;
  };
  const slow = fixture({ gradeDelay: async () => new Promise((resolve) => clock.setTimeout(resolve, 50_000)) });
  let coordinatorSettled = false;
  const client = createProtectedExamClient({
    accessToken: 'synthetic-local-token',
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/submit')) {
        const running = slow.run().finally(() => { coordinatorSettled = true; });
        return await new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
          running.then((value) => {
            if (!init.signal.aborted) resolve(jsonResponse(value));
          }, reject);
        });
      }
      if (String(url).endsWith('/result')) {
        return jsonResponse({ ok: true, result: coordinatorSettled ? { attemptId, status: 'completed' } : null });
      }
      throw new Error('unexpected synthetic client route');
    },
  });
  const browser = client.submitAttempt(attemptId, submissionId)
    .then(() => ({ status: 'success' }), (error) => ({ status: 'error', code: error.code }));
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => realSetTimeout(resolve, 5));
  let browserResult;
  browser.then((value) => { browserResult = value; });
  for (let i = 0; i < 50 && (!browserResult || !coordinatorSettled); i += 1) {
    if (!await clock.advanceNext()) {
      await new Promise((resolve) => realSetTimeout(resolve, 5));
      assert.ok(browserResult && coordinatorSettled || clock.timers.size > 0, 'virtual clock stalled');
    }
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  assert.deepEqual(browserResult, { status: 'error', code: 'request_timeout' });
  assert.equal(slow.recorded.peakGrades, 3);
  assert.equal(slow.recorded.evidence.length, 7);
  assert.equal(slow.recorded.submitted, 1);
  assert.equal(coordinatorSettled, true);
  assert.equal(clock.now, 150_000);
  assert.ok(clock.scheduledMs.includes(120_000));
  assert.ok(clock.scheduledMs.includes(90_000));
  const laterResult = await client.getResult(attemptId);
  assert.equal(laterResult.result.status, 'completed');
  console.log('SEVEN_SLOW_TASKS_PASS: browser 120s timeout; synthetic coordinator finalizes at 150s; later result read succeeds');
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  AbortSignal.timeout = realAbortTimeout;
}

const timeoutClock = new FakeClock();
try {
  globalThis.setTimeout = timeoutClock.setTimeout;
  globalThis.clearTimeout = timeoutClock.clearTimeout;
  const stalled = fixture({ diagnosticNow: () => timeoutClock.now, gradeDelay: async (task, signal) => {
    if (task !== 1) return;
    await new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  } });
  let outcome;
  stalled.run().then(() => { outcome = 'unexpected_success'; }, (error) => { outcome = error.message; });
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => realSetTimeout(resolve, 5));
  for (let i = 0; i < 30 && !outcome; i += 1) {
    if (!await timeoutClock.advanceNext()) {
      for (let j = 0; j < 50; j += 1) await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => realSetTimeout(resolve, 5));
      assert.ok(outcome || timeoutClock.timers.size > 0, `timeout clock stalled at ${timeoutClock.now}; preparations=${stalled.recorded.preparations}; evidence=${stalled.recorded.evidence.length}; cancelled=${stalled.recorded.cancelled.length}`);
    }
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  assert.equal(outcome, 'grading_failed');
  assert.equal(timeoutClock.now, 180_000);
  assert.equal(stalled.recorded.cancelled.length, 2);
  assert.equal(stalled.recorded.evidence.length, 6);
  assert.equal(stalled.recorded.submitted, 0);
  assert.deepEqual(stalled.diagnostics.filter((x) => x.stage === 'grade_request').map((x) => x.category), ['OWN_TIMEOUT', 'OWN_TIMEOUT']);
  assert.ok(stalled.diagnostics.filter((x) => x.category === 'OWN_TIMEOUT').every((x) => x.ownTimeoutFired && x.elapsedMs === 90_000));
  assert.ok(timeoutClock.scheduledMs.includes(15_000));
  assert.equal(JSON.stringify(stalled.diagnostics).includes(SECRET_SENTINEL), false);
  console.log('GRADE_TIMEOUT_PASS: two synthetic 90s grade aborts reconcile; final scorer not called');
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}
