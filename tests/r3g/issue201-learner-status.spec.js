import { expect, test } from '@playwright/test';

// UI-only transport races supplement, never replace, the real SQL/Edge/worker
// central acceptance in test-issue201-learner-status-integration.mjs.
const id = '20110000-0000-4000-8000-000000000001';
const item = '20110000-0000-4000-8000-000000000002';
const user = '20110000-0000-4000-8000-000000000003';
const otherUser = '20110000-0000-4000-8000-000000000004';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const session = (account = user) => ({ access_token: 'synthetic-status-token', user: { id: account } });

async function install(page, options = {}) {
  const f = { started: Boolean(options.expired), completed: false, phase: 'awaiting_processing',
    statusUnavailable: false, resultUnavailable: false, historyUnavailable: false, authDenied: false,
    deadline: new Date(Date.now() - 1000).toISOString(), saves: 0, workspaceSaves: 0, runs: 0,
    submits: [], resumes: 0, currentReads: 0, statusReads: 0, listReads: 0, workerCalls: 0,
    activeStatus: 0, maxActiveStatus: 0, external: [], ...options };
  const kind = options.kind ?? 'no-lab', count = options.count ?? 1;
  const profileKey = kind === 'lab' ? 'pythonnextgeneration-lab' : 'pythonnextgeneration-no-lab';
  const attempt = () => ({ attemptId: id, examKey: 'pythonnextgeneration', packageVersion: '1.0.0', profileKey,
    profileName: 'Synthetic profile', status: 'in_progress', startedAt: new Date().toISOString(), expiresAt: f.deadline,
    timeLimitMinutes: 1, timed: true, itemCount: count, purpose: 'self_directed_exam', languagePreference: null, assignmentId: null });
  const dto = () => ({
    contractVersion: 1, attemptId: id, examKey: 'pythonnextgeneration', packageVersion: '1.0.0',
    profileKey, profileName: 'Synthetic profile', purpose: 'self_directed_exam', assignmentId: null,
    deadline: f.deadline, observedAt: new Date().toISOString(), expiryManaged: true,
    closureReason: f.manualFrozen ? 'manual_submission' : Date.now() < Date.parse(f.deadline) ? null : 'time_limit_expiry',
    answeringAllowed: !f.completed && !f.manualFrozen && Date.now() < Date.parse(f.deadline),
    state: f.completed ? 'completed' : !f.manualFrozen && Date.now() < Date.parse(f.deadline) ? 'active' : f.phase,
    resultAvailable: f.completed, completedAt: f.completed ? f.completedAt ?? new Date().toISOString() : null,
  });
  const result = () => ({ attemptId: id, serverAuthoritative: true, examKey: 'pythonnextgeneration', profileKey,
    rawPercentage: 50, rawScore: 1, maxScore: 2, questionCount: count, answeredCount: 1,
    passed: false, completedAt: f.completedAt ?? new Date().toISOString(), reviewStatus: 'withheld', domainBreakdown: {} });
  const questions = () => Array.from({ length: count }, (_, index) => ({
    itemId: index ? '20110000-0000-4000-8000-000000000005' : item,
    questionId: 'synthetic-' + index, questionNumber: index + 1, domain: 'Synthetic domain', section: 'standard',
    revision: 0, response: null, questionType: kind === 'lab' && index === 0 ? 'executable-python-lab-v1' : 'single-choice',
    presentation: kind === 'lab' && index === 0 ? {
      interactionVersion: 'executable-python-lab-v1', task: 'Synthetic Python task', instructions: ['Use saved work.'],
      starterWorkspace: { entryPoint: 'main.py', files: [{ path: 'main.py', content: 'pass' }] },
    } : { question: 'Synthetic question ' + (index + 1), options: [{ id: 'a', text: 'Synthetic answer' }] },
  }));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.fallback();
    f.external.push('blocked'); return route.abort('blockedbyclient');
  });
  await page.route('**/functions/v1/**', async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname.split('/certsim-protected-exam')[1];
    const url = new URL(req.url());
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(value) });
    if (!path) { f.workerCalls++; return json({ error: { code: 'forbidden_fixture_worker' } }, 403); }
    if (path.includes('/completion-status')) {
      f.activeStatus++; f.maxActiveStatus = Math.max(f.maxActiveStatus, f.activeStatus);
      try {
        if (path === '/completion-status/pending') f.listReads++; else f.statusReads++;
        if (f.statusDelay) await wait(f.statusDelay);
        if (f.authDenied) return await json({ error: { code: 'unauthenticated' } }, 401);
        if (f.statusUnavailable) return await json({ error: { code: 'internal_failure' } }, 503);
        if (f.malformed) return await json({ contractVersion: 999 });
        if (path !== '/completion-status/pending') return await json({ status: dto() });
        const current = dto();
        const watchedIds = url.searchParams.get('watch')?.split(',') ?? [];
        const observedAt = current.observedAt;
        const items = f.started && !f.completed && current.state !== 'active' ? [{ ...current, observedAt }] : [];
        return await json({ contractVersion: 1, observedAt, items, watched: watchedIds.includes(id) ? [{ ...current, observedAt }] : [],
          returnedCount: items.length, nextCursor: null });
      } finally { f.activeStatus--; }
    }
    if (path === '/attempts/current-bindings') { f.currentReads++; return json({ candidates: f.started ? [{ ...attempt(), selectedCount: count, fixedProfileSize: false, profileComposition: {}, replacementPermitted: false }] : [] }); }
    if (path === '/practice/availability') return json({ ...attempt(), selectedCount: count, available: true, fixedProfileSize: false, adjustedCount: false });
    if (path === '/practice/sessions') {
      f.started = true; f.deadline = new Date(Date.now() + (f.expiresInMs ?? 1700)).toISOString();
      return json({ attempt: attempt(), items: questions() }, 201);
    }
    if (path === '/attempts/' + id) { f.resumes++; return json({ attempt: attempt(), items: questions() }); }
    if (path.endsWith('/flags')) return json({ itemIds: [] });
    if (path.endsWith('/response')) {
      f.saves++;
      if (f.saveDenied) return json({ error: { code: 'attempt_expired' } }, 409);
      if (f.saveDelay) await wait(f.saveDelay);
      return json({ itemId: item, revision: 1, updatedAt: new Date().toISOString() });
    }
    if (path.endsWith('/python/workspace') && req.method() === 'GET') return json({ itemId: item, exists: false, revision: 0, workspaceHash: null, workspace: null, updatedAt: null });
    if (path.endsWith('/python/workspace') && req.method() === 'PUT') {
      f.workspaceSaves++;
      if (f.saveDelay) await wait(f.saveDelay);
      return json({ itemId: item, revision: 1, workspaceHash: 'a'.repeat(64), updatedAt: new Date().toISOString() });
    }
    if (path.endsWith('/python/runs')) { f.runs++; return json({ error: { code: 'executor_disabled' } }, 503); }
    if (path.endsWith('/submit')) {
      f.submits.push(req.postDataJSON().submissionId);
      if (f.submits.length === 1 && f.submitDelay) await wait(f.submitDelay);
      if (f.submits.length === 1 && f.submitError) return json({ error: { code: f.submitError } }, 409);
      f.completed = true; return json({ result: result() });
    }
    if (path.endsWith('/result')) {
      if (f.resultUnavailable) return json({ error: { code: 'internal_failure' } }, 503);
      return f.completed ? json({ result: result() }) : json({ error: { code: 'attempt_not_found' } }, 404);
    }
    if (path === '/history') {
      if (f.historyUnavailable) return json({ error: { code: 'internal_failure' } }, 503);
      const items = f.completed ? [{ attemptId: id, examKey: 'pythonnextgeneration', packageVersion: '1.0.0', profileKey,
        purpose: 'self_directed_exam', completedAt: new Date().toISOString(), source: 'protected', serverAuthoritative: true,
        score: 1, percentage: 50, passed: false, reviewStatus: 'withheld', domainSummary: {} }] : [];
      return json({ items, returnedCount: items.length, totalCount: items.length, remainingCount: 0, nextCursor: null });
    }
    return json({ error: { code: 'unexpected_fixture_route' } }, 500);
  });
  f.mount = async (view = 'runner') => {
    await page.goto('/tests/r3g/issue201-learner-status-harness.html');
    await page.waitForFunction(() => typeof window.__mountLearnerStatusFixture === 'function');
    await page.evaluate((config) => window.__mountLearnerStatusFixture(config), { session: session(), kind, count, view });
  };
  f.start = async () => { await f.mount(); await page.getByRole('button', { name: /Start exam/i }).click(); await expect(page.getByRole('region', { name: /Python exam workspace/i })).toBeVisible(); };
  return f;
}
test('managed timeout never submits; fresh history discovers pending and hands off one authoritative completion', async ({ page }) => {
  const f = await install(page); await f.start();
  await expect(page.getByRole('heading', { name: 'Time expired', exact: true })).toBeVisible();
  expect(f.submits).toHaveLength(0); expect(f.saves).toBe(0); expect(f.workerCalls).toBe(0);
  await page.getByRole('button', { name: 'Return home', exact: true }).click();
  await page.getByRole('button', { name: 'Open Saved Results' }).click();
  await expect(page.getByRole('heading', { name: 'Pending work' })).toBeVisible();
  await expect(page.getByText('Your saved work is awaiting marking.', { exact: true })).toBeVisible();
  expect(f.resumes).toBe(0); expect(f.submits).toHaveLength(0);
  f.completed = true;
  await page.getByRole('button', { name: 'Refresh pending status' }).click();
  await expect(page.locator('.saved-result-item')).toHaveCount(1);
  await expect(page.getByText('Your saved work is awaiting marking.', { exact: true })).toHaveCount(0);
  expect(f.submits).toHaveLength(0); expect(f.maxActiveStatus).toBe(1); expect(f.external).toHaveLength(0);
});
test('known expired managed launch inspects status without current reconciliation, resume, saves or Submit', async ({ page }) => {
  const f = await install(page, { expired: true }); await f.mount();
  await expect(page.getByRole('heading', { name: 'Time expired', exact: true })).toBeVisible();
  expect(f.currentReads).toBe(0); expect(f.resumes).toBe(0); expect(f.saves).toBe(0); expect(f.submits).toHaveLength(0);
});
test('durable attention is distinct from unavailable status and no score or review is manufactured', async ({ page }) => {
  const f = await install(page, { expired: true, phase: 'needs_attention' }); await f.mount('history');
  await expect(page.getByText('Marking needs attention. A final result is not available yet.', { exact: true })).toBeVisible();
  expect(await page.locator('.saved-result-item').count()).toBe(0);
  f.statusUnavailable = true;
  await page.getByRole('button', { name: 'Refresh pending status' }).click();
  await expect(page.getByText('Pending status is unavailable. This does not mean there are no pending attempts.')).toBeVisible();
  await expect(page.getByText('Marking needs attention. A final result is not available yet.', { exact: true })).toBeVisible();
  expect(f.submits).toHaveLength(0); expect(f.resumes).toBe(0);
});
test('temporary result or history failure retains the pending entry until both matching contracts succeed', async ({ page }) => {
  const f = await install(page, { expired: true }); await f.mount('history');
  await expect(page.getByText('Your saved work is awaiting marking.', { exact: true })).toBeVisible();
  f.completed = true; f.resultUnavailable = true;
  await page.getByRole('button', { name: 'Refresh pending status' }).click();
  await expect(page.getByText('A completed result or its history entry could not be verified yet. Its pending entry is retained.')).toBeVisible();
  f.resultUnavailable = false; f.historyUnavailable = true;
  await page.getByRole('button', { name: 'Refresh pending status' }).click();
  await expect(page.getByText('A completed result or its history entry could not be verified yet. Its pending entry is retained.')).toBeVisible();
  f.historyUnavailable = false;
  await page.getByRole('button', { name: 'Refresh pending status' }).click();
  await expect(page.locator('.saved-result-item')).toHaveCount(1);
});
test('accepted in-flight response save cannot restore answering after expiry', async ({ page }) => {
  const f = await install(page, { count: 2, expiresInMs: 900, saveDelay: 1300 }); await f.start();
  await page.getByRole('radio', { name: 'Synthetic answer' }).check();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Time expired', exact: true })).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByRole('radio')).toHaveCount(0);
  expect(f.saves).toBe(1); expect(f.submits).toHaveLength(0);
});
test('denied late save is not retried or turned into a completed result', async ({ page }) => {
  const f = await install(page, { count: 2, saveDenied: true, expiresInMs: 1200 }); await f.start();
  await page.getByRole('radio', { name: 'Synthetic answer' }).check();
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Time expired', exact: true })).toBeVisible();
  expect(f.saves).toBe(1); expect(f.submits).toHaveLength(0);
});
test('Python Run waiting on a timely save cannot dispatch after deadline', async ({ page }) => {
  const f = await install(page, { kind: 'lab', expiresInMs: 1100, saveDelay: 1500 }); await f.start();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Time expired', exact: true })).toBeVisible();
  await page.waitForTimeout(1600);
  expect(f.workspaceSaves).toBe(1); expect(f.runs).toBe(0); expect(f.submits).toHaveLength(0);
});
test('timely manual submission may finish after expiry with one Submit and one result', async ({ page }) => {
  const f = await install(page, { expiresInMs: 1400, submitDelay: 1900 }); await f.start();
  await page.getByRole('radio', { name: 'Synthetic answer' }).check();
  await page.getByRole('button', { name: 'Submit exam', exact: true }).click();
  await page.getByRole('button', { name: 'Submit Final Attempt' }).click();
  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toBeVisible();
  expect(f.submits).toHaveLength(1); expect(f.saves).toBe(1);
  await page.waitForTimeout(1000);
  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toBeVisible();
});
test('expiry retains original-ID manual recovery without resaving or duplicate automatic Submit', async ({ page }) => {
  const f = await install(page, { expiresInMs: 1400, submitDelay: 1900, submitError: 'grading_incomplete' }); await f.start();
  await page.getByRole('radio', { name: 'Synthetic answer' }).check();
  await page.getByRole('button', { name: 'Submit exam', exact: true }).click();
  await page.getByRole('button', { name: 'Submit Final Attempt' }).click();
  await expect(page.getByRole('button', { name: 'Continue submission' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue submission' }).click();
  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toBeVisible();
  expect(f.submits).toHaveLength(2); expect(new Set(f.submits).size).toBe(1); expect(f.saves).toBe(1);
});
test('local wall-clock rollback cannot extend managed answering', async ({ page }) => {
  const f = await install(page, { expiresInMs: 1400 }); await f.start();
  await page.evaluate(() => { const original = Date.now; Date.now = () => original() - 3600000; });
  await expect(page.getByRole('heading', { name: 'Time expired', exact: true })).toBeVisible();
  expect(f.submits).toHaveLength(0);
});
test('returning after a hidden deadline never briefly re-enables answering', async ({ page }) => {
  const f = await install(page, { expiresInMs: 1200 }); await f.start();
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(1500);
  const editable = await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange'));
    return [...document.querySelectorAll('input[type=radio]')].some((input) => !input.matches(':disabled'));
  });
  expect(editable).toBe(false);
  await expect(page.getByRole('heading', { name: 'Time expired', exact: true })).toBeVisible();
  expect(f.submits).toHaveLength(0);
});
test('malformed status cannot select legacy fallback or open editable questions', async ({ page }) => {
  const f = await install(page, { malformed: true }); await f.mount();
  await expect(page.getByText('Completion status could not be verified.', { exact: true })).toBeVisible();
  expect(f.currentReads).toBe(0); expect(f.started).toBe(false); expect(f.submits).toHaveLength(0);
});
test('pending polling stops on auth denial and account change; stale replies cannot show old work', async ({ page }) => {
  const f = await install(page, { expired: true }); await f.mount('history');
  await expect(page.getByText('Your saved work is awaiting marking.', { exact: true })).toBeVisible();
  f.authDenied = true;
  await page.getByRole('button', { name: 'Refresh pending status' }).click();
  await expect(page.getByText('Pending status access is unavailable. Sign in with the authorised account.')).toBeVisible();
  const before = f.listReads;
  await page.waitForTimeout(2500);
  expect(f.listReads).toBe(before);
  f.authDenied = false; f.statusDelay = 500;
  await page.evaluate((next) => window.__changeLearnerStatusSession(next), session(otherUser));
  await page.evaluate(() => window.__mountLearnerStatusFixture({ session: null, view: 'history', kind: 'no-lab', count: 1 }));
  await page.waitForTimeout(700);
  await expect(page.getByRole('heading', { name: 'Sign in to view Saved Results' })).toBeVisible();
  await expect(page.getByText('Your saved work is awaiting marking.', { exact: true })).toHaveCount(0);
});
test('offline/hidden pending view does not schedule overlapping reads; rapid checks coalesce', async ({ page, context }) => {
  const f = await install(page, { expired: true }); await f.mount('history');
  await expect(page.getByText('Your saved work is awaiting marking.', { exact: true })).toBeVisible();
  await context.setOffline(true);
  await page.waitForTimeout(2600);
  const before = f.listReads;
  await page.waitForTimeout(2500);
  expect(f.listReads).toBe(before);
  await context.setOffline(false);
  f.statusDelay = 250;
  const button = page.getByRole('button', { name: 'Refresh pending status' });
  await button.evaluate((b) => { b.click(); b.click(); b.click(); });
  await page.waitForTimeout(700);
  expect(f.maxActiveStatus).toBe(1); expect(f.workerCalls).toBe(0); expect(f.submits).toHaveLength(0);
});

test('cold remount of a durable timely manual freeze stays read-only without guessing its lost ID', async ({ page }) => {
  const f = await install(page, { expired: true, manualFrozen: true, deadline: new Date(Date.now() + 60000).toISOString() });
  await f.mount();
  await expect(page.getByRole('heading', { name: 'Submission pending', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue submission', exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio')).toHaveCount(0);
  expect(f.currentReads).toBe(0); expect(f.resumes).toBe(0); expect(f.saves).toBe(0); expect(f.submits).toHaveLength(0);
});

test('deadline and completion on different dates remain separate instants without a reporting-day rewrite', async ({ page }) => {
  const deadline = '2026-10-15T23:59:00.000Z', completedAt = '2026-10-16T00:01:00.000Z';
  const f = await install(page, { expired: true, deadline });
  await f.mount('history');
  await expect(page.locator('time[datetime="' + deadline + '"]')).toBeVisible();
  f.completed = true; f.completedAt = completedAt; f.resultUnavailable = true;
  await page.getByRole('button', { name: 'Refresh pending status' }).click();
  const pending = page.getByRole('region', { name: 'Pending work' });
  await expect(pending.locator('time[datetime="' + deadline + '"]')).toBeVisible();
  await expect(pending.locator('time[datetime="' + completedAt + '"]')).toBeVisible();
  await expect(pending.getByText(/50%|Passed|Download PDF/)).toHaveCount(0);
});
