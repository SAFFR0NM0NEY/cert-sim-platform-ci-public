import { createProtectedAnswerDraft, reconcileProtectedAnswerDraft, editProtectedAnswerDraft, acknowledgeProtectedAnswerDraft } from '../src/lib/protectedAnswerDraft.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCompletionStatus, normalizePendingCompletionPage, requireMatchingCompletionResult, isExplicitCompletionContractUnsupported } from '../src/lib/protectedCompletionStatus.js';
import { createManagedCompletionAuthority } from '../src/lib/managedCompletionAuthority.js';
import { createCompletionRefreshController } from '../src/lib/completionRefreshController.js';
import { createProtectedExamClient } from '../src/lib/protectedExamClient.js';
import { createPythonLabWorkspaceController } from '../src/lib/pythonLabWorkspace.js';

const id = '20100000-0000-4000-8000-000000000001';
const other = '20100000-0000-4000-8000-000000000002';
const observedAt = '2026-10-16T08:00:00.000Z';
const status = (extra = {}) => ({ contractVersion: 1, attemptId: id, examKey: 'synthetic', packageVersion: '1.0.0',
  profileKey: 'formal', profileName: 'Synthetic formal', purpose: 'self_directed_exam', assignmentId: null,
  deadline: '2026-10-16T07:59:00.000Z', observedAt, expiryManaged: true,
  answeringAllowed: false, state: 'awaiting_processing', resultAvailable: false, completedAt: null,
  closureReason: extra.state === 'active' || extra.state === 'unmanaged' ? null : 'time_limit_expiry', ...extra });
const page = (extra = {}) => ({ contractVersion: 1, observedAt, items: [status()], watched: [], returnedCount: 1, nextCursor: null, ...extra });
const json = (body, httpStatus = 200) => new Response(JSON.stringify(body), { status: httpStatus, headers: { 'content-type': 'application/json' } });
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('pending states carry no result or score; a real completion requires matching authoritative identity and time', () => {
  for (const state of ['awaiting_processing', 'processing', 'needs_attention']) assert.equal(normalizeCompletionStatus(status({ state })).resultAvailable, false);
  assert.equal(normalizeCompletionStatus(status({ state: 'completed', resultAvailable: true, completedAt: observedAt })).state, 'completed');
  assert.throws(() => requireMatchingCompletionResult({ attemptId: id, serverAuthoritative: false, completedAt: observedAt }, id));
  assert.throws(() => requireMatchingCompletionResult({ attemptId: other, serverAuthoritative: true, completedAt: observedAt }, id));
  assert.throws(() => requireMatchingCompletionResult({ attemptId: id, serverAuthoritative: true }, id));
  const result = { attemptId: id, serverAuthoritative: true, completedAt: observedAt, rawScore: 1, maxScore: 2, rawPercentage: 50, passed: false };
  assert.equal(requireMatchingCompletionResult(result, id), result);
  for (const patch of [{ rawScore: undefined }, { maxScore: null }, { rawPercentage: undefined }, { rawPercentage: NaN }, { passed: undefined }]) {
    assert.throws(() => requireMatchingCompletionResult({ ...result, ...patch }, id));
  }
});

for (const [name, patch] of Object.entries({
  unknown: { state: 'grading_probably_running' }, fakeScore: { percentage: 0 },
  secret: { leaseToken: 'SENSITIVE_SENTINEL' }, futurePending: { deadline: '2026-10-16T09:00:00Z' },
  missingManaged: { expiryManaged: false }, invalidTime: { observedAt: 'yesterday' },
  missingResult: { state: 'completed' }, fakeResult: { resultAvailable: true },
})) test('status rejects ' + name + ' without exposing raw payload', () => {
  assert.throws(() => normalizeCompletionStatus(status(patch)), /Completion status could not be verified/);
});
test('status page enforces bounded unique owner watch identities and cursor shape', () => {
  assert.equal(normalizePendingCompletionPage(page()).items.length, 1);
  assert.throws(() => normalizePendingCompletionPage(page({ watched: [status({ attemptId: other })] }), [id]));
  assert.throws(() => normalizePendingCompletionPage(page({ watched: [] }), [id]));
  assert.throws(() => normalizePendingCompletionPage(page({ items: [status(), status()], returnedCount: 2 })));
  assert.throws(() => normalizePendingCompletionPage(page({ nextCursor: 'not-a-cursor' })));
  assert.throws(() => normalizePendingCompletionPage(page({ items: Array(21).fill(status()), returnedCount: 21 })));
  assert.throws(() => normalizeCompletionStatus(status(), other));
});
test('monotonic authority ignores local clock rollback, conservatively includes request latency and never reopens expiry', () => {
  let now = 200;
  const authority = createManagedCompletionAuthority({ now: () => now });
  authority.reset(id, 'synthetic-account');
  const active = status({ state: 'active', answeringAllowed: true, deadline: '2026-10-16T08:00:01.000Z' });
  authority.observe(active, 0);
  assert.equal(authority.remainingSeconds(), 1);
  const original = Date.now;
  try { Date.now = () => -900000000; assert.equal(authority.remainingSeconds(), 1); } finally { Date.now = original; }
  now = 1000;
  assert.equal(authority.isLocked(), true);
  authority.observe(active, 1000);
  assert.equal(authority.isLocked(), true);
  assert.throws(() => authority.observe(status({ expiryManaged: false, state: 'unmanaged' }), 1000));
  assert.throws(() => authority.observe({ ...active, deadline: '2026-10-16T08:00:05Z' }, 1000));
});
test('background authority suspends immediately and only a fresh server observation restores timely answering', () => {
  let now = 0;
  const a = createManagedCompletionAuthority({ now: () => now });
  a.reset(id, 'owner');
  const active = status({ state: 'active', answeringAllowed: true, deadline: '2026-10-16T08:01:00Z' });
  a.observe(active, now); assert.equal(a.isLocked(), false);
  a.suspend(); assert.equal(a.isLocked(), true);
  a.observe(active, now); assert.equal(a.isLocked(), false);
  now = 61000; a.suspend(); assert.equal(a.isExpired(), true);
});

function environment() {
  const listeners = new Set();
  class TrackedTarget extends EventTarget {
    addEventListener(type, fn, options) { listeners.add(fn + '|' + type); super.addEventListener(type, fn, options); }
    removeEventListener(type, fn, options) { listeners.delete(fn + '|' + type); super.removeEventListener(type, fn, options); }
  }
  const document = new TrackedTarget(), window = new TrackedTarget();
  document.visibilityState = 'visible';
  let online = true, nextId = 0;
  const timers = new Map();
  return { document, window, timers, listeners,
    options: { documentTarget: document, windowTarget: window, isOnline: () => online,
      setTimer: (fn) => { timers.set(++nextId, fn); return nextId; }, clearTimer: (key) => timers.delete(key), delays: [1, 2, 3, 4, 5] },
    hidden: (value) => { document.visibilityState = value ? 'hidden' : 'visible'; document.dispatchEvent(new Event('visibilitychange')); },
    offline: (value) => { online = !value; window.dispatchEvent(new Event(value ? 'offline' : 'online')); },
    fire: () => { const [key, fn] = timers.entries().next().value ?? []; if (fn) { timers.delete(key); fn(); } },
  };
}
const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };
test('rapid clicks and focus events coalesce; automatic polling finishes after six logical reads', async () => {
  const env = environment(), held = defer(); let requests = 0, active = 0, peak = 0;
  const c = createCompletionRefreshController({ ...env.options, read: async () => {
    requests++; active++; peak = Math.max(peak, active);
    if (requests === 1) await held.promise;
    active--; return {};
  } });
  c.start();
  for (let n = 0; n < 20; n++) { c.check(); env.hidden(true); env.hidden(false); }
  await settle(); assert.equal(requests, 1); held.resolve(); await settle();
  for (let n = 0; n < 8; n++) { env.fire(); await settle(); }
  assert.equal(requests, 6); assert.equal(peak, 1); assert.equal(env.timers.size, 0); c.dispose();
});
test('hidden/offline polling pauses without resetting the finite request budget; dispose removes active work', async () => {
  const env = environment(); let requests = 0, lateValues = 0, signal;
  const held = defer();
  const c = createCompletionRefreshController({ ...env.options, read: async (options) => { requests++; signal = options.signal; await held.promise; return {}; }, onValue: () => lateValues++ });
  assert.equal(env.listeners.size, 3);
  env.hidden(true); c.start(); assert.equal(requests, 0);
  env.hidden(false); env.offline(true); env.fire(); assert.equal(requests, 0);
  env.offline(false); env.fire(); await settle(); assert.equal(requests, 1);
  c.dispose(); assert.equal(signal.aborted, true); held.resolve(); await settle();
  assert.equal(lateValues, 0); assert.equal(env.timers.size, 0); assert.equal(env.listeners.size, 0);
  env.hidden(true); env.hidden(false); env.offline(false); assert.equal(env.timers.size, 0);
});
test('access denial stops reads; transient unavailability is not persisted processing failure', async () => {
  for (const code of ['unauthenticated', 'inactive_account', 'attempt_not_found']) {
    const env = environment(); let reads = 0;
    const c = createCompletionRefreshController({ ...env.options, read: () => { reads++; throw { code }; } });
    await c.start(); await c.check(); assert.equal(reads, 1); assert.equal(c.getSnapshot().denied, true); c.dispose();
  }
  const env = environment(); let reads = 0, observedError;
  const c = createCompletionRefreshController({ ...env.options, read: () => { reads++; throw { code: 'network_failure' }; }, onError: (e) => { observedError = e.code; } });
  await c.start(); assert.equal(observedError, 'network_failure'); assert.equal(c.getSnapshot().denied, false); await c.check(); assert.equal(reads, 2); c.dispose();
});
test('completed hand-off stops polling and stale pending responses cannot replace the observed result', async () => {
  const env = environment(); let values = 0;
  const c = createCompletionRefreshController({ ...env.options, read: async () => ({ done: true }), onValue: () => values++, shouldContinue: (v) => !v.done });
  await c.start(); await c.check(); env.fire(); assert.equal(values, 1); assert.equal(env.timers.size, 0); c.dispose();
});
test('status transport uses no-store and one bounded authentication recovery without Submit or saves', async () => {
  let requests = 0, refreshes = 0;
  const client = createProtectedExamClient({ getAccessToken: async ({ forceRefresh }) => { if (forceRefresh) refreshes++; return forceRefresh ? 'synthetic-refreshed-token' : 'synthetic-token'; },
    fetchImpl: async (url, options) => {
      requests++; assert.equal(options.method, 'GET'); assert.equal(options.cache, 'no-store');
      assert.equal(new URL(url, 'http://127.0.0.1').pathname.endsWith('/completion-status'), true);
      return requests === 1 ? json({ error: { code: 'unauthenticated' } }, 401) : json({ status: status() });
    } });
  assert.equal((await client.getCompletionStatus(id)).attemptId, id);
  assert.equal(requests, 2); assert.equal(refreshes, 1);
});
test('only explicit unsupported-contract evidence selects compatibility; other errors and malformed replies do not', async () => {
  for (const [httpStatus, code, fallback] of [[404, 'invalid_request', true], [501, 'status_contract_unsupported', true], [401, 'unauthenticated', false], [503, 'internal_failure', false], [404, 'attempt_not_found', false]]) {
    const client = createProtectedExamClient({ accessToken: 'synthetic-token', fetchImpl: async () => json({ error: { code } }, httpStatus) });
    try { await client.getCompletionStatus(id); assert.fail('EXPECTED_ERROR'); } catch (error) { assert.equal(isExplicitCompletionContractUnsupported(error), fallback); }
  }
  const client = createProtectedExamClient({ accessToken: 'synthetic-token', fetchImpl: async () => json({ status: { state: 'completed' } }) });
  await assert.rejects(client.getCompletionStatus(id), /Completion status could not be verified/);
});
test('Python save accepted before expiry can acknowledge afterward without permitting a late Run or retry', async () => {
  let allowed = true, saves = 0, runs = 0;
  const held = defer();
  const client = {
    getPythonWorkspace: async () => ({ itemId: other, exists: false, revision: 0, workspaceHash: null, workspace: null, updatedAt: null }),
    savePythonWorkspace: async () => { saves++; await held.promise; return { itemId: other, revision: 1, workspaceHash: 'a'.repeat(64), updatedAt: observedAt }; },
    requestPythonRun: async () => { runs++; throw Error('LATE_RUN_FORBIDDEN'); },
    getLatestPythonRun: async () => {}, getPythonRun: async () => {}, cancelPythonRun: async () => {},
  };
  const workspace = createPythonLabWorkspaceController({ attemptId: id, itemId: other, client, canInteract: () => allowed,
    presentation: { interactionVersion: 'executable-python-lab-v1', task: 'Synthetic task', starterWorkspace: { entryPoint: 'main.py', files: [{ path: 'main.py', content: 'pass' }] } } });
  await workspace.load();
  const run = workspace.requestRun();
  await settle(); assert.equal(saves, 1); allowed = false; held.resolve(); await run;
  assert.equal(workspace.getSnapshot().persisted, true); assert.equal(runs, 0);
  await workspace.flush(); await workspace.requestRun(); assert.equal(saves, 1); assert.equal(runs, 0);
  assert.equal(workspace.updateFile('main.py', 'late edit'), false);
});

test('manual freeze before deadline is read-only pending and gains no submission identity', () => {
  const frozen = status({ deadline: '2026-10-16T09:00:00Z', closureReason: 'manual_submission' });
  assert.equal(normalizeCompletionStatus(frozen).state, 'awaiting_processing');
  const authority = createManagedCompletionAuthority({ now: () => 0 });
  authority.reset(id, 'owner'); authority.observe(frozen, 0);
  assert.equal(authority.isLocked(), true);
  assert.equal(JSON.stringify(frozen).includes('submissionId'), false);
});
test('dispose before the first microtask starts no transport request', async () => {
  const env = environment(); let requests = 0;
  const c = createCompletionRefreshController({ ...env.options, read: async () => { requests++; return {}; } });
  c.start(); c.dispose(); await settle(); assert.equal(requests, 0);
});


const draftOwner = { accountId: 'synthetic-owner', attemptId: 'synthetic-attempt' };
const draftItem = (itemId, answer, revision) => ({ itemId, answer, revision });
function ownedDraft(items = [draftItem('tail', 'b', 3)]) {
  return reconcileProtectedAnswerDraft(createProtectedAnswerDraft(), draftOwner, items, { replace: true });
}
test('ordinary drafts preserve dirty false, empty, null and explicit undefined values without truthiness fallback', () => {
  for (const value of [false, '', [], null, undefined]) {
    let current = editProtectedAnswerDraft(ownedDraft(), draftOwner, 'tail', value);
    current = reconcileProtectedAnswerDraft(current, draftOwner, [draftItem('tail', 'new-server', 4)]);
    assert.equal(Object.hasOwn(current.answers, 'tail'), true);
    assert.deepEqual(current.answers.tail, value); assert.equal(current.revisions.tail, 3); assert.equal(current.dirtyIds.has('tail'), true);
  }
});
test('ordinary drafts keep dirty items outside a replaced prefix while refreshing clean and cleared items', () => {
  let current = ownedDraft([draftItem('tail', 'b', 3), draftItem('clean', 'old', 1)]);
  current = editProtectedAnswerDraft(current, draftOwner, 'tail', 'a');
  current = reconcileProtectedAnswerDraft(current, draftOwner, [draftItem('clean', undefined, 2)], { replace: true });
  assert.equal(current.answers.tail, 'a'); assert.equal(current.revisions.tail, 3);
  assert.equal(Object.hasOwn(current.answers, 'clean'), false); assert.equal(current.revisions.clean, 2);
});
test('ordinary drafts reject account and attempt transfers even when the item ID is identical', () => {
  const current = editProtectedAnswerDraft(ownedDraft(), draftOwner, 'tail', 'a');
  for (const owner of [{ ...draftOwner, accountId: 'other' }, { ...draftOwner, attemptId: 'other' }]) {
    assert.throws(() => reconcileProtectedAnswerDraft(current, owner, [draftItem('tail', 'x', 7)]), { code: 'unsaved_attempt' });
    assert.throws(() => editProtectedAnswerDraft(current, owner, 'tail', 'x'), { code: 'binding_mismatch' });
    assert.equal(acknowledgeProtectedAnswerDraft(current, owner, 'tail', { revision: 3, edit: 1 }, { itemId: 'tail', revision: 4 }), current);
  }
});
test('ordinary draft reconciliation commits against the current edit after a held read', async () => {
  let current = ownedDraft(); const snapshot = [draftItem('tail', 'server', 4)];
  let release; const held = new Promise((r) => { release = r; });
  const read = held.then(() => { current = reconcileProtectedAnswerDraft(current, draftOwner, snapshot); });
  current = editProtectedAnswerDraft(current, draftOwner, 'tail', 'a');
  current = editProtectedAnswerDraft(current, draftOwner, 'tail', 'newer-a');
  release(); await read; assert.equal(current.answers.tail, 'newer-a'); assert.equal(current.revisions.tail, 3);
});
test('ordinary draft matching acknowledgment alone clears the sent edit and advances its revision', () => {
  let current = editProtectedAnswerDraft(ownedDraft(), draftOwner, 'tail', 'a');
  current = acknowledgeProtectedAnswerDraft(current, draftOwner, 'tail', { revision: 3, edit: 1 }, { itemId: 'tail', revision: 4 });
  assert.equal(current.dirtyIds.size, 0); assert.equal(current.revisions.tail, 4);
  current = reconcileProtectedAnswerDraft(current, draftOwner, [draftItem('tail', 'a', 4)]);
  assert.equal(current.answers.tail, 'a'); assert.equal(current.dirtyIds.size, 0);
});
test('ordinary draft old acknowledgment cannot clean a newer edit or regress a later acknowledged base', () => {
  let current = editProtectedAnswerDraft(ownedDraft(), draftOwner, 'tail', 'a');
  current = editProtectedAnswerDraft(current, draftOwner, 'tail', 'c');
  const old = { revision: 3, edit: 1 };
  current = acknowledgeProtectedAnswerDraft(current, draftOwner, 'tail', old, { itemId: 'tail', revision: 4 });
  assert.equal(current.answers.tail, 'c'); assert.equal(current.dirtyIds.has('tail'), true); assert.equal(current.revisions.tail, 4);
  current = acknowledgeProtectedAnswerDraft(current, draftOwner, 'tail', { revision: 4, edit: 2 }, { itemId: 'tail', revision: 5 });
  const latest = current;
  current = acknowledgeProtectedAnswerDraft(current, draftOwner, 'tail', old, { itemId: 'tail', revision: 4 });
  assert.equal(current, latest); assert.equal(current.revisions.tail, 5);
});
test('ordinary draft invalid save item/revision acknowledgments preserve local intent', () => {
  const current = editProtectedAnswerDraft(ownedDraft(), draftOwner, 'tail', 'a');
  for (const saved of [{ itemId: 'other', revision: 4 }, { itemId: 'tail', revision: 9 }]) assert.throws(() => acknowledgeProtectedAnswerDraft(current, draftOwner, 'tail', { revision: 3, edit: 1 }, saved), { code: 'binding_mismatch' });
  assert.equal(current.answers.tail, 'a'); assert.equal(current.revisions.tail, 3); assert.equal(current.dirtyIds.size, 1);
});
test('ordinary draft missing payload is distinct from intentional clear and fails closed', () => {
  const current = ownedDraft(); current.dirtyIds.add('missing');
  assert.throws(() => reconcileProtectedAnswerDraft(current, draftOwner, [draftItem('missing', 'server', 1)]), { code: 'draft_unavailable' });
});
