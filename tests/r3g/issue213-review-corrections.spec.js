import { expect, test } from '@playwright/test';

// Maintained versions of PR213's separate review probes. Only transport is
// simulated: the real runner, pending/history parents and production helpers run.
const uid = '21300000-0000-4000-8000-000000000999';
const id = (n) => '21300000-0000-4000-8000-' + String(n).padStart(12, '0');
const session = (user = uid) => ({ access_token: 'synthetic-correction-token', user: { id: user } });
const time = (n) => new Date(Date.parse('2026-10-16T05:00:00Z') - n * 1000).toISOString();
const deadline = (n) => new Date(Date.parse('2026-10-16T00:00:00Z') + (n >= 100 ? 103 - n : -n) * 1000).toISOString();
const history = (n) => ({ attemptId: id(n), examKey: 'pythonnextgeneration', packageVersion: '1.0.0',
  profileKey: 'pythonnextgeneration-no-lab', purpose: 'self_directed_exam', completedAt: time(n),
  source: 'protected', serverAuthoritative: true, score: 1, percentage: 50, passed: false,
  reviewStatus: 'withheld', domainSummary: {} });
const result = (n) => ({ attemptId: id(n), serverAuthoritative: true, examKey: 'pythonnextgeneration',
  profileKey: 'pythonnextgeneration-no-lab', rawPercentage: 50, rawScore: 1, maxScore: 2,
  questionCount: 1, answeredCount: 1, passed: false, completedAt: time(n), reviewStatus: 'withheld', domainBreakdown: {} });
const row = (n, state = 'awaiting_processing') => ({ contractVersion: 1, attemptId: id(n),
  examKey: 'pythonnextgeneration', packageVersion: '1.0.0', profileKey: 'pythonnextgeneration-no-lab',
  profileName: 'Synthetic pending ' + n, purpose: 'self_directed_exam', assignmentId: null,
  deadline: deadline(n), expiryManaged: true, closureReason: 'time_limit_expiry',
  answeringAllowed: false, state, resultAvailable: state === 'completed', completedAt: state === 'completed' ? time(n) : null });
const order = (key) => (a, b) => Date.parse(b[key]) - Date.parse(a[key]) || b.attemptId.localeCompare(a.attemptId);
const cursorFor = (v, key) => v[key] + '|' + v.attemptId;
const after = (v, key, cursor) => {
  if (!cursor) return true;
  const [stamp, attemptId] = cursor.split('|');
  return Date.parse(v[key]) < Date.parse(stamp) || (Date.parse(v[key]) === Date.parse(stamp) && v.attemptId < attemptId);
};
const activeBarriers = new Set();
test.afterEach(() => { for (const release of activeBarriers) release(); activeBarriers.clear(); });
function barrier() {
  let entered, release, settled;
  const arrived = new Promise((r) => { entered = r; });
  const hold = new Promise((r) => { release = r; });
  const finished = new Promise((r) => { settled = r; });
  activeBarriers.add(release);
  return { arrived, release, finished, wait: async (request) => { entered(request); await hold; }, settled };
}
async function fixture(page, options = {}) {
  const f = { statuses: new Map(), history: [], completed: new Set(), resultFailures: new Set(),
    gets: [], listRequests: [], historyRequests: [], resultRequests: [], mutations: [], statusGates: new Map(),
    startGate: null, historyGate: null, historyFailures: new Map(), historyReads: [], statusOverrides: new Map(), statusFailures: new Set(), availabilityGate: null,
    activeStart: null, candidates: [], ...options };
  page.on('requestfinished', (r) => f.statusGates.get(r.url().match(/attempts\/([^/]+)\/completion-status/)?.[1])?.settled());
  page.on('requestfailed', (r) => f.statusGates.get(r.url().match(/attempts\/([^/]+)\/completion-status/)?.[1])?.settled());
  await page.route('**/*', (route) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.fallback() : route.abort('blockedbyclient'));
  await page.route('**/functions/v1/**', async (route) => {
    const req = route.request(), u = new URL(req.url()), p = u.pathname.split('/certsim-protected-exam')[1];
    let heldGate = null;
    const json = async (value, status = 200) => {
      try { await route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(value) }); }
      finally { heldGate?.settled(); }
    };
    if (req.method() === 'GET') f.gets.push(p);
    if (!['GET', 'OPTIONS'].includes(req.method())) f.mutations.push(p);
    if (p === '/history') {
      const cursor = u.searchParams.get('cursor'); f.historyRequests.push(cursor);
      f.historyReads.push({ cursor, examKey: u.searchParams.get('examKey'), pageSize: Number(u.searchParams.get('pageSize')) });
      if (f.historyGate) { const gate = f.historyGate; f.historyGate = null; heldGate = gate; await gate.wait(req); }
      const failure = f.historyFailures.get((u.searchParams.get('examKey') ?? '') + '|' + (cursor ?? 'head'));
      if (failure === 'abort') { try { await route.abort('failed'); } finally { heldGate?.settled(); } return; }
      if (failure || f.historyFailure) return json({ error: { code: 'internal_failure' } }, 503);
      const all = [...f.history].filter((v) => !u.searchParams.get('examKey') || v.examKey === u.searchParams.get('examKey')).sort(order('completedAt'));
      const remaining = all.filter((v) => after(v, 'completedAt', cursor)), items = remaining.slice(0, Number(u.searchParams.get('pageSize')));
      return json({ items, returnedCount: items.length, totalCount: all.length, remainingCount: remaining.length - items.length,
        nextCursor: remaining.length > items.length ? cursorFor(items.at(-1), 'completedAt') : null });
    }
    if (p === '/completion-status/pending') {
      const cursor = u.searchParams.get('cursor'), watch = (u.searchParams.get('watch') ?? '').split(',').filter(Boolean);
      f.listRequests.push({ cursor, watch });
      if (f.listGate) { const gate = f.listGate; f.listGate = null; heldGate = gate; await gate.wait(req); }
      const observedAt = new Date().toISOString();
      const all = [...f.statuses.values()].filter((v) => ['awaiting_processing', 'processing', 'needs_attention'].includes(v.state) && (!u.searchParams.get('examKey') || v.examKey === u.searchParams.get('examKey'))).sort(order('deadline'));
      const remaining = all.filter((v) => after(v, 'deadline', cursor)), items = remaining.slice(0, 20).map((v) => ({ ...v, observedAt }));
      if (f.emptyWindow && !cursor) return json({ contractVersion: 1, observedAt, items: [], watched: [], returnedCount: 0, nextCursor: deadline(0) + '|' + id(900) });
      return json({ contractVersion: 1, observedAt, items, watched: watch.map((v) => ({ ...f.statuses.get(v), observedAt })),
        returnedCount: items.length, nextCursor: remaining.length > items.length ? cursorFor(items.at(-1), 'deadline') : null });
    }
    if (p?.endsWith('/completion-status')) {
      const attemptId = p.split('/')[2], gate = f.statusGates.get(attemptId);
      if (gate) { heldGate = gate; await gate.wait(req); }
      if (f.statusFailures.has(attemptId)) return json({ error: { code: 'internal_failure' } }, 503);
      if (f.statusOverrides.has(attemptId)) return json({ status: { ...f.statusOverrides.get(attemptId), observedAt: new Date().toISOString() } });
      const active = f.activeStart?.attemptId === attemptId ? f.activeStart : f.candidates.find((c) => c.attemptId === attemptId);
      return json({ status: active ? { ...row(Number(attemptId.slice(-12))), ...active, contractVersion: 1,
        // Only the safe completion DTO crosses the real client's strict parser.
        ...Object.fromEntries(Object.keys(active).filter((k) => !Object.keys(row(1)).includes(k)).map((k) => [k, undefined])),
        deadline: active.expiresAt, observedAt: new Date().toISOString(), state: 'active',
        expiryManaged: true, closureReason: null, answeringAllowed: true, resultAvailable: false, completedAt: null }
        : { ...f.statuses.get(attemptId), observedAt: new Date().toISOString() } });
    }
    if (p?.endsWith('/result')) {
      const attemptId = p.split('/')[2]; f.resultRequests.push(attemptId);
      if (f.resultGate) { const gate = f.resultGate; f.resultGate = null; heldGate = gate; await gate.wait(req); }
      if (f.resultFailures.has(attemptId)) return json({ error: { code: 'internal_failure' } }, 503);
      return json({ result: result(Number(attemptId.slice(-12))) });
    }
    if (p === '/practice/recoverable-sandboxes') return json({ candidates: f.recoverables ?? [] });
    if (p === '/attempts/current') {
      const attempt = f.activeStart;
      if (f.currentGate) { heldGate = f.currentGate; await f.currentGate.wait(req); }
      return json({ attempt, items: [question(attempt.attemptId)] });
    }
    if (/^\/practice\/sessions\/[^/]+\/recover$/.test(p)) {
      if (f.recoveryGate) { heldGate = f.recoveryGate; await f.recoveryGate.wait(req); }
      return json({ attemptId: p.split('/')[3], status: 'in_progress' });
    }
    if (p?.endsWith('/response')) {
      if (f.saveGate) { heldGate = f.saveGate; await f.saveGate.wait(req); }
      return json({ itemId: p.split('/')[4], revision: 1, updatedAt: new Date().toISOString() });
    }
    if (p === '/attempts/current-bindings') return json({ candidates: f.candidates });
    if (p === '/practice/availability') {
      if (f.availabilityGate) { const gate = f.availabilityGate; f.availabilityGate = null; heldGate = gate; await gate.wait(req); }
      if (f.availabilityError) return json({ error: { code: f.availabilityError } }, f.availabilityError === 'internal_failure' ? 503 : 403);
      return json({ examKey: u.searchParams.get('examKey'), packageVersion: '1.0.0', profileKey: u.searchParams.get('profileId'),
        profileName: 'Synthetic', purpose: u.searchParams.get('purpose'), assignmentId: u.searchParams.get('assignmentId'),
        selectedCount: 1, available: true, fixedProfileSize: false, adjustedCount: false });
    }
    if (p === '/practice/sessions' || p === '/practice/sessions/replace') {
      const body = req.postDataJSON();
      const attempt = { attemptId: id(f.nextStartId ?? 55), examKey: body.examKey, packageVersion: '1.0.0',
        profileKey: body.profileId, profileName: 'Synthetic started profile', status: 'in_progress',
        startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + (f.startExpiryMs ?? 120000)).toISOString(),
        timeLimitMinutes: 1, timed: true, itemCount: 1, purpose: body.purpose, languagePreference: body.language ?? null, assignmentId: body.assignmentId ?? null };
      f.activeStart = attempt;
      if (f.startGate) { heldGate = f.startGate; await f.startGate.wait(req); }
      if (f.startFailure) return json({ error: { code: 'internal_failure' } }, 503);
      return json({ attempt, items: [question(attempt.attemptId)] }, 201);
    }
    if (/^\/attempts\/[^/]+$/.test(p)) {
      const attempt = f.candidates.find((c) => c.attemptId === p.split('/')[2]);
      return json({ attempt, items: [question(attempt.attemptId)] });
    }
    if (p?.endsWith('/flags')) return json({ itemIds: [] });
    return json({ error: { code: 'unexpected_fixture_route' } }, 500);
  });
  f.mount = async (view = 'history', extra = {}) => {
    await page.goto('/tests/r3g/issue201-learner-status-harness.html');
    await expect.poll(() => page.evaluate(() => typeof window.__mountLearnerStatusFixture)).toBe('function');
    await page.evaluate((config) => window.__mountLearnerStatusFixture(config), { session: session(), kind: 'no-lab', count: 1, view, ...extra });
  };
  f.change = (config) => page.evaluate((next) => window.__changeLearnerStatusConfig(next), config);
  f.complete = (n) => { f.statuses.set(id(n), row(n, 'completed')); if (!f.history.some((v) => v.attemptId === id(n))) f.history.push(history(n)); };
  return f;
}
function question(attemptId) { return { itemId: id(500 + Number(attemptId.slice(-12))), questionId: 'synthetic-' + attemptId,
  questionNumber: 1, domain: 'Synthetic domain', section: 'standard', revision: 0, response: null, questionType: 'single-choice',
  presentation: { question: 'Synthetic question for ' + attemptId, options: [{ id: 'a', text: 'Synthetic answer' }] } }; }
const pending = (page) => page.getByRole('region', { name: 'Pending work', exact: true });
async function refresh(page) {
  await page.getByRole('button', { name: 'Refresh pending status', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh pending status', exact: true })).toBeEnabled();
}
async function settle(page) { await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); }

test('review A: position21 of22 hands off without discarding loaded history', async ({ page }) => {
  const f = await fixture(page);
  f.statuses.set(id(21), row(21)); f.history = [...Array.from({ length: 20 }, (_, i) => history(i + 1)), history(22)];
  await f.mount(); await expect(pending(page).getByText(/Synthetic pending 21$/)).toBeVisible();
  await page.getByRole('combobox').first().selectOption('all');
  f.complete(21); await refresh(page);
  await expect(pending(page).getByText(/Synthetic pending 21$/)).toHaveCount(0);
  await expect(page.locator('.saved-result-item')).toHaveCount(22);
  expect(f.historyRequests).toContain(cursorFor(history(20), 'completedAt'));
  expect(f.mutations).toEqual([]);
});

test('review B: full watch page plus two insertions keeps all27 reachable', async ({ page }) => {
  const f = await fixture(page);
  for (let n = 1; n <= 25; n++) f.statuses.set(id(n), row(n));
  await f.mount(); await expect(pending(page).locator('li')).toHaveCount(20);
  const seen = new Set();
  const collect = async () => (await pending(page).locator('li span').allTextContents()).forEach((v) => seen.add(v.trim()));
  await collect(); f.statuses.set(id(101), row(101)); f.statuses.set(id(102), row(102));
  await refresh(page); await collect();
  // Page navigation briefly resets busy before its new effect starts. Hold
  // each transport and wait for the actual rendered page, not that idle gap.
  const nextGate = barrier(); f.listGate = nextGate;
  await page.getByRole('button', { name: 'Next pending page', exact: true }).click();
  await nextGate.arrived; nextGate.release(); await nextGate.finished;
  await expect(pending(page).locator('li')).toHaveCount(5);
  await expect(pending(page).getByText(/Synthetic pending 25$/)).toBeVisible();
  await collect();
  const newest = page.getByRole('button', { name: 'Check newest pending work', exact: true });
  if (await newest.count()) {
    const newestGate = barrier(); f.listGate = newestGate;
    await newest.click(); await newestGate.arrived; newestGate.release(); await newestGate.finished;
    await expect(pending(page).locator('li')).toHaveCount(20);
    await expect(pending(page).getByText(/Synthetic pending 101$/)).toBeVisible();
    await expect(pending(page).getByText(/Synthetic pending 102$/)).toBeVisible();
    await collect();
  }
  expect(seen.size).toBe(27);
  await expect(newest).toBeVisible();
  expect(f.listRequests.every((v) => v.watch.length <= 20)).toBe(true);
  expect(f.mutations).toEqual([]);
});

test('review C: held old profile status cannot initialize a newer same-account view', async ({ page }) => {
  const f = await fixture(page), gate = barrier();
  f.statusGates.set(id(55), gate);
  await f.mount('runner'); await page.getByRole('button', { name: /Start exam/i }).click(); await gate.arrived;
  await f.change({ kind: 'lab' });
  await expect(page.getByRole('button', { name: /Start exam/i })).toBeVisible();
  gate.release(); await gate.finished; await settle(page);
  await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Start exam/i })).toBeVisible();
  expect(f.mutations).toHaveLength(1);
});

test('A: an already loaded later-page history row retires without refetching page1', async ({ page }) => {
  const f = await fixture(page);
  f.statuses.set(id(21), row(21)); f.history = [...Array.from({ length: 20 }, (_, i) => history(i + 1)), history(22)];
  await f.mount(); await expect(pending(page).locator('li')).toHaveCount(1);
  f.complete(21); f.resultFailures.add(id(21)); await refresh(page);
  await page.getByRole('combobox').first().selectOption('all');
  await page.getByRole('button', { name: 'Load more results', exact: true }).click();
  await expect(page.locator('.saved-result-item')).toHaveCount(22);
  const reads = f.historyRequests.length;
  f.resultFailures.clear(); await refresh(page);
  await expect(pending(page).locator('li')).toHaveCount(0);
  expect(f.historyRequests.length).toBe(reads);
  await expect(page.locator('.saved-result-item')).toHaveCount(22);
});
test('A: an unloaded older completion makes one resumable history-page step per check', async ({ page }) => {
  const f = await fixture(page);
  f.statuses.set(id(61), row(61)); f.history = [...Array.from({ length: 60 }, (_, i) => history(i + 1)), history(62)];
  await f.mount(); await expect(pending(page).locator('li')).toHaveCount(1);
  f.complete(61);
  for (let n = 0; n < 3; n++) await refresh(page);
  await expect(pending(page).locator('li')).toHaveCount(0);
  await page.getByRole('combobox').first().selectOption('all');
  await expect(page.locator('.saved-result-item')).toHaveCount(62);
  expect(f.historyRequests.slice(0, 4)).toEqual([null, cursorFor(history(20), 'completedAt'), cursorFor(history(40), 'completedAt'), cursorFor(history(60), 'completedAt')]);
});
test('A: an unavailable first result does not monopolize the next completed hand-off', async ({ page }) => {
  const f = await fixture(page);
  f.statuses.set(id(21), row(21)); f.statuses.set(id(22), row(22)); f.history = Array.from({ length: 20 }, (_, i) => history(i + 1));
  await f.mount(); await expect(pending(page).locator('li')).toHaveCount(2);
  f.complete(21); f.complete(22); f.resultFailures.add(id(21));
  await refresh(page); await refresh(page);
  expect(f.resultRequests).toContain(id(22));
  // A second turn advances its history lookup beyond the newest20.
  await refresh(page); await refresh(page);
  await expect(pending(page).getByText(/Synthetic pending 22$/)).toHaveCount(0);
  await expect(pending(page).getByText(/Synthetic pending 21$/)).toBeVisible();
  expect(f.resultRequests).toContain(id(22));
  f.resultFailures.clear(); await refresh(page);
  await expect(pending(page).locator('li')).toHaveCount(0);
  await page.getByRole('combobox').first().selectOption('all');
  await expect(page.locator('.saved-result-item')).toHaveCount(22);
});
test('A: transient history failure preserves progress, loaded rows and new-arrival continuation', async ({ page }) => {
  const f = await fixture(page);
  f.statuses.set(id(21), row(21)); f.history = [...Array.from({ length: 20 }, (_, i) => history(i + 1)), history(22)];
  await f.mount(); await expect(pending(page).locator('li')).toHaveCount(1);
  await page.getByRole('combobox').first().selectOption('all');
  f.complete(21); f.historyFailure = true; await refresh(page);
  await expect(page.locator('.saved-result-item')).toHaveCount(20);
  f.historyFailure = false; f.history.push(history(0)); await refresh(page);
  await expect(pending(page).locator('li')).toHaveCount(0);
  await expect(page.locator('.saved-result-item')).toHaveCount(22);
  await page.getByRole('button', { name: 'Load more results', exact: true }).click();
  await expect(page.locator('.saved-result-item')).toHaveCount(23);
  const labels = await page.locator('.saved-result-item').allTextContents();
  expect(labels[0]).toContain(await page.evaluate((stamp) => new Date(stamp).toLocaleString(), time(0)));
  expect(f.historyRequests.filter((v) => v === cursorFor(history(20), 'completedAt')).length).toBeGreaterThanOrEqual(2);
});
for (const change of ['filter', 'account']) test('A/B: delayed hand-off cannot update a new ' + change + ' scope', async ({ page }) => {
  const f = await fixture(page), gate = barrier();
  f.statuses.set(id(21), row(21)); f.history = Array.from({ length: 20 }, (_, i) => history(i + 1));
  await f.mount(); await expect(pending(page).locator('li')).toHaveCount(1);
  f.complete(21); f.historyGate = gate;
  const click = page.getByRole('button', { name: 'Refresh pending status', exact: true }).click();
  const request = await gate.arrived; await click;
  const done = gate.finished;
  if (change === 'filter') await page.getByRole('combobox').nth(1).selectOption('inf303');
  else { f.statuses.clear(); f.history = []; await f.change({ session: session(id(998)) }); }
  gate.release(); await done; await settle(page);
  await expect(page.locator('.saved-result-item')).toHaveCount(0);
  await expect(pending(page).locator('li')).toHaveCount(0);
});

test('B: full watched page closes one row and retains a failed completed hand-off across navigation', async ({ page }) => {
  const f = await fixture(page);
  for (let n = 1; n <= 25; n++) f.statuses.set(id(n), row(n));
  await f.mount(); await expect(pending(page).locator('li')).toHaveCount(20);
  f.statuses.set(id(1), { ...row(1, 'closed'), closureReason: 'closed' });
  f.complete(2); f.resultFailures.add(id(2)); await refresh(page);
  await expect(pending(page).getByText(/Synthetic pending 1$/)).toHaveCount(0);
  await page.getByRole('button', { name: 'Next pending page', exact: true }).click();
  await expect(pending(page).locator('li')).toHaveCount(6);
  await expect(pending(page).getByText(/Synthetic pending 2$/)).toBeVisible();
  f.resultFailures.clear(); await refresh(page);
  await expect(pending(page).getByText(/Synthetic pending 2$/)).toHaveCount(0);
  await expect(page.locator('.saved-result-item')).toHaveCount(1);
  expect(f.listRequests.every((v) => v.watch.length <= 20)).toBe(true);
});
test('B: empty bounded scan window retains its next cursor and reaches the next page', async ({ page }) => {
  const f = await fixture(page, { emptyWindow: true });
  f.statuses.set(id(1), row(1)); f.statuses.set(id(2), row(2));
  await f.mount(); await expect(pending(page).getByText('No pending attempts in this page. Check the next page.', { exact: true })).toBeVisible();
  f.emptyWindow = false;
  await page.getByRole('button', { name: 'Next pending page', exact: true }).click();
  await expect(pending(page).locator('li')).toHaveCount(2);
  expect(f.listRequests.at(-1).cursor).toBe(deadline(0) + '|' + id(900));
});
test('B: identical deadlines, repeated refresh and selected checks preserve the ID tie-break cursor', async ({ page }) => {
  const f = await fixture(page);
  for (let n = 1; n <= 25; n++) f.statuses.set(id(n), { ...row(n), deadline: deadline(0) });
  await f.mount(); await expect(pending(page).locator('li')).toHaveCount(20);
  await refresh(page); await refresh(page);
  await pending(page).locator('li').last().getByRole('button', { name: 'Check status', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh pending status', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Next pending page', exact: true }).click();
  await expect(pending(page).locator('li')).toHaveCount(5);
  expect(f.listRequests.at(-1).cursor).toBe(deadline(0) + '|' + id(6));
  await expect(pending(page).getByText(/Synthetic pending 6$/)).toHaveCount(0);
});
test('B: retained hand-offs are bounded20 plus page20 and block further navigation visibly', async ({ page }) => {
  const f = await fixture(page);
  for (let n = 1; n <= 40; n++) { f.statuses.set(id(n), row(n)); f.resultFailures.add(id(n)); }
  await f.mount(); await expect(pending(page).locator('li')).toHaveCount(20);
  for (let n = 1; n <= 20; n++) f.complete(n);
  await refresh(page); await page.getByRole('button', { name: 'Next pending page', exact: true }).click();
  await expect(pending(page).locator('li')).toHaveCount(40);
  for (let n = 21; n <= 40; n++) f.complete(n);
  await refresh(page);
  await expect(page.getByRole('button', { name: 'Check newest pending work', exact: true })).toBeDisabled();
  await expect(pending(page).getByText(/Continue checking completed work before changing pages/)).toBeVisible();
  expect(f.listRequests.every((v) => v.watch.length <= 20)).toBe(true);
});
test('B: delayed old discovery page cannot populate a changed filter', async ({ page }) => {
  const f = await fixture(page), gate = barrier();
  for (let n = 1; n <= 25; n++) f.statuses.set(id(n), row(n));
  f.listGate = gate; await f.mount(); const request = await gate.arrived;
  const done = gate.finished;
  await page.getByRole('combobox').nth(1).selectOption('inf303');
  gate.release(); await done; await settle(page);
  await expect(pending(page).locator('li')).toHaveCount(0);
});

for (const [name, config] of [['profile', { kind: 'lab' }], ['exam', { examId: 'inf303' }], ['assignment', { assignmentId: id(777) }], ['purpose', { purpose: 'study_sandbox' }], ['language', { language: 'python' }]]) {
  for (const ordering of ['before', 'after']) test('C: held old status rejects ' + name + ' change ' + ordering + ' new initialization', async ({ page }) => {
    const f = await fixture(page), old = barrier(), newer = barrier();
    f.statusGates.set(id(55), old);
    await f.mount('runner'); await page.getByRole('button', { name: /Start exam/i }).click(); await old.arrived;
    if (ordering === 'before') f.availabilityGate = newer;
    await f.change(config);
    if (ordering === 'before') { await newer.arrived; old.release(); await old.finished; await settle(page); newer.release(); }
    else { await expect(page.getByRole('button', { name: /Start (?:exam|practice)/i })).toBeVisible(); old.release(); await old.finished; }
    await settle(page);
    await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Start (?:exam|practice)/i })).toBeVisible();
    expect(f.mutations).toHaveLength(1);
  });
}
test('C: profile A to B to A still rejects the first A response', async ({ page }) => {
  const f = await fixture(page), gate = barrier();
  f.statusGates.set(id(55), gate);
  await f.mount('runner'); await page.getByRole('button', { name: /Start exam/i }).click(); await gate.arrived;
  await f.change({ kind: 'lab' }); await expect(page.getByRole('button', { name: /Start exam/i })).toBeVisible();
  await f.change({ kind: 'no-lab' }); await expect(page.getByRole('button', { name: /Start exam/i })).toBeVisible();
  gate.release(); await gate.finished; await settle(page);
  await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toHaveCount(0);
  expect(f.mutations).toHaveLength(1);
});
for (const change of ['logout', 'account', 'unmount']) test('C: old start response cannot issue follow-on reads after ' + change, async ({ page }) => {
  const f = await fixture(page), gate = barrier();
  f.startGate = gate;
  await f.mount('runner'); await page.getByRole('button', { name: /Start exam/i }).click(); const request = await gate.arrived;
  const done = gate.finished;
  if (change === 'unmount') await page.evaluate(() => window.__mountLearnerStatusFixture({ session: null, view: 'home', kind: 'no-lab', count: 1 }));
  else await f.change({ session: change === 'logout' ? null : session(id(998)) });
  gate.release(); await done; await settle(page);
  await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toHaveCount(0);
  expect(f.gets.filter((p) => p === '/attempts/' + id(55) + '/completion-status')).toHaveLength(0);
});
test('C: old failure and finally cannot replace or unlock a newer held start', async ({ page }) => {
  const f = await fixture(page), old = barrier(), newer = barrier();
  f.statusGates.set(id(55), old); f.statusFailures.add(id(55));
  await f.mount('runner'); await page.getByRole('button', { name: /Start exam/i }).click(); await old.arrived;
  await f.change({ kind: 'lab' }); await expect(page.getByRole('button', { name: /Start exam/i })).toBeVisible();
  f.nextStartId = 77; f.statusGates.set(id(77), newer);
  await page.getByRole('button', { name: /Start exam/i }).click(); await newer.arrived;
  old.release(); await old.finished; await settle(page);
  await expect(page.getByRole('button', { name: 'Starting exam...', exact: true })).toBeDisabled();
  newer.release(); await newer.finished;
  await expect(page.getByText('Synthetic question for ' + id(77), { exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic question for ' + id(55), { exact: true })).toHaveCount(0);
  expect(f.mutations).toHaveLength(2);
});
test('C: rapid explicit attempt choices apply only the newer selection', async ({ page }) => {
  const f = await fixture(page);
  const expiresAt = new Date(Date.now() + 120000).toISOString();
  f.candidates = [71, 72].map((n) => ({ attemptId: id(n), examKey: 'pythonnextgeneration', packageVersion: '1.0.0',
    profileKey: 'pythonnextgeneration-no-lab', profileName: 'Synthetic choice ' + n, status: 'in_progress', startedAt: new Date().toISOString(),
    expiresAt, timeLimitMinutes: 1, timed: true, itemCount: 1, purpose: 'self_directed_exam', assignmentId: null, languagePreference: null }));
  await f.mount('runner'); await expect(page.getByRole('button', { name: /Resume attempt/ })).toHaveCount(2);
  await page.getByRole('button', { name: /Resume attempt/ }).first().evaluate((first) => {
    const second = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Synthetic choice 72'));
    first.click(); second.click();
  });
  await expect(page.getByText('Synthetic question for ' + id(72), { exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic question for ' + id(71), { exact: true })).toHaveCount(0);
  expect(f.mutations).toHaveLength(0);
});
test('manual preparation: held save crosses deadline without Submit or stuck status controls', async ({ page }) => {
  const f = await fixture(page, { startExpiryMs: 1400 }), gate = barrier();
  f.saveGate = gate;
  await page.clock.install();
  await f.mount('runner'); await page.getByRole('button', { name: /Start exam/i }).click();
  await page.getByRole('radio', { name: 'Synthetic answer' }).check();
  await page.getByRole('button', { name: 'Submit exam', exact: true }).click();
  await page.getByRole('button', { name: 'Submit Final Attempt', exact: true }).click();
  const request = await gate.arrived;
  // Advance the real component's monotonic timer deterministically.
  await page.clock.runFor(1600);
  await expect(page.getByRole('heading', { name: 'Time expired', exact: true })).toBeVisible();
  gate.release(); await request.response().then((r) => r?.finished());
  await expect(page.getByRole('button', { name: 'Check status', exact: true })).toBeEnabled();
  await expect(page.getByRole('radio')).toHaveCount(0);
  expect(f.mutations.filter((p) => p.endsWith('/response'))).toHaveLength(1);
  expect(f.mutations.filter((p) => p.endsWith('/submit'))).toHaveLength(0);
});

for (const change of ['account', 'logout']) test('C: account guard rejects an old held status after ' + change, async ({ page }) => {
  const f = await fixture(page), gate = barrier();
  f.statusGates.set(id(55), gate);
  await f.mount('runner'); await page.getByRole('button', { name: /Start exam/i }).click(); await gate.arrived;
  await f.change({ session: change === 'logout' ? null : session(id(998)) });
  gate.release(); await gate.finished; await settle(page);
  await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toHaveCount(0);
  expect(f.mutations).toHaveLength(1);
});
test('C: ambiguous-start recovery captures original context before its current-attempt read', async ({ page }) => {
  const f = await fixture(page, { startFailure: true }), gate = barrier();
  f.currentGate = gate;
  await f.mount('runner'); await page.getByRole('button', { name: /Start exam/i }).click(); const request = await gate.arrived;
  const done = gate.finished;
  await f.change({ kind: 'lab' }); await expect(page.getByRole('button', { name: /Start exam/i })).toBeVisible();
  gate.release(); await done; await settle(page);
  await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toHaveCount(0);
  expect(f.activeStart.attemptId).toBe(id(55)); // Ignored response does not undo server allocation.
  expect(f.gets.filter((p) => p === '/attempts/' + id(55) + '/completion-status')).toHaveLength(0);
  expect(f.mutations).toEqual(['/practice/sessions']);
});
test('C: an explicit replacement response cannot initialize a changed exam view', async ({ page }) => {
  const f = await fixture(page), gate = barrier();
  f.candidates = [{ attemptId: id(71), examKey: 'az204', packageVersion: '1.0.0', profileKey: 'standard-profile',
    profileName: 'Synthetic C# alternative', status: 'in_progress', startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 120000).toISOString(), itemCount: 1, purpose: 'self_directed_exam',
    languagePreference: 'python', assignmentId: null, replacementPermitted: true }];
  page.on('dialog', (dialog) => dialog.accept());
  await f.mount('runner', { examId: 'az204', profileId: 'standard-profile', language: 'csharp' });
  f.startGate = gate;
  await page.getByRole('button', { name: 'Start new attempt', exact: true }).click(); const request = await gate.arrived;
  const done = gate.finished;
  await f.change({ examId: 'inf303', profileId: undefined, language: undefined });
  await expect(page.getByRole('button', { name: /Start exam/i })).toBeVisible();
  gate.release(); await done; await settle(page);
  await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toHaveCount(0);
  expect(f.mutations).toEqual(['/practice/sessions/replace']);
});
test('C: Study Sandbox recovery response cannot resume under a changed view', async ({ page }) => {
  const f = await fixture(page), gate = barrier();
  f.recoverables = [{ attemptId: id(81), examKey: 'pythonnextgeneration', packageVersion: '1.0.0',
    profileKey: 'pythonnextgeneration-no-lab', profileName: 'Synthetic saved sandbox', purpose: 'study_sandbox',
    languagePreference: null, startedAt: time(81), lastActivityAt: time(80), itemCount: 1, savedResponseCount: 1, recoverable: true }];
  f.recoveryGate = gate;
  await f.mount('runner', { purpose: 'study_sandbox' });
  await page.getByRole('button', { name: /Recover.*sandbox/i }).click(); const request = await gate.arrived;
  const done = gate.finished;
  await f.change({ kind: 'lab', purpose: 'self_directed_exam' });
  await expect(page.getByRole('button', { name: /Start exam/i })).toBeVisible();
  gate.release(); await done; await settle(page);
  await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toHaveCount(0);
  expect(f.gets.filter((p) => p === '/attempts/' + id(81) + '/completion-status')).toHaveLength(0);
  expect(f.mutations).toEqual(['/practice/sessions/' + id(81) + '/recover']);
});
test('B: actual pending component stops after six automatic refresh pipelines', async ({ page }) => {
  const f = await fixture(page);
  f.statuses.set(id(1), row(1));
  await page.clock.install();
  await f.mount(); await expect(pending(page).locator('li')).toHaveCount(1);
  for (const delay of [2000, 4000, 8000, 16000, 30000]) {
    await page.clock.runFor(delay + 20);
    await expect(page.getByRole('button', { name: 'Refresh pending status', exact: true })).toBeEnabled();
  }
  expect(f.listRequests).toHaveLength(6);
  await page.clock.fastForward(120000);
  expect(f.listRequests).toHaveLength(6);
  await refresh(page); expect(f.listRequests).toHaveLength(7);
});

test('post-switch runner: fully loaded attempt yields usable current-profile Start', async ({ page }) => {
  const f = await fixture(page), gate = barrier();
  await f.mount('runner'); await page.getByRole('button', { name: /Start exam/i }).click();
  await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toBeEnabled();
  f.availabilityGate = gate;
  await f.change({ kind: 'lab' }); await gate.arrived;
  await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toHaveCount(0);
  gate.release(); await gate.finished;
  await expect(page.getByRole('status')).toContainText('Ready to start');
  console.log(JSON.stringify({ suite: 'post-switch-loaded-runner', stage: 'current-discovery-settled',
    startButtons: await page.getByRole('button', { name: /Start exam/i }).count(),
    staleQuestions: await page.getByRole('radio', { name: 'Synthetic answer' }).count(),
    reads: f.gets.length, mutations: f.mutations.length }));
  await expect(page.getByRole('button', { name: /Start exam/i })).toBeEnabled();
  f.nextStartId = 77;
  const nextStart = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/practice/sessions'));
  await page.getByRole('button', { name: /Start exam/i }).click();
  expect((await nextStart).postDataJSON()).toMatchObject({ profileId: 'pythonnextgeneration-lab', purpose: 'self_directed_exam' });
  await expect(page.getByText('Synthetic question for ' + id(77), { exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic question for ' + id(55), { exact: true })).toHaveCount(0);
  expect(f.mutations).toEqual(['/practice/sessions', '/practice/sessions']);
});

test('post-switch history: old Load more retires and the new filter loads its remaining10', async ({ page }) => {
  const f = await fixture(page), gate = barrier();
  f.history = [...Array.from({ length: 40 }, (_, i) => history(i + 1)),
    ...Array.from({ length: 30 }, (_, i) => ({ ...history(i + 101), examKey: 'inf303', profileKey: 'standard-profile' }))];
  await f.mount(); await expect(page.locator('.saved-result-item')).toHaveCount(10);
  await page.getByRole('combobox').first().selectOption('all');
  f.historyGate = gate;
  await page.getByRole('button', { name: 'Load more results', exact: true }).click(); await gate.arrived;
  await page.getByRole('combobox').nth(1).selectOption('inf303');
  gate.release(); await gate.finished;
  await expect(page.getByText('All Time · 20 of 30 loaded', { exact: true })).toBeVisible();
  const more = page.locator('.saved-pagination button');
  console.log(JSON.stringify({ suite: 'post-switch-history-filter', stage: 'current-first-page-settled',
    rows: await page.locator('.saved-result-item').count(), moreDisabled: await more.isDisabled(),
    reads: f.historyRequests.length, mutations: f.mutations.length }));
  await expect(more).toBeEnabled(); await more.click();
  await expect(page.getByText('All Time · 30 of 30 loaded', { exact: true })).toBeVisible();
  await expect(page.locator('.saved-result-item')).toHaveCount(30);
  expect((await page.locator('.saved-result-item').allTextContents()).every((text) => text.startsWith('INF-303'))).toBe(true);
  expect(f.historyRequests.at(-1)).toBe(cursorFor(history(120), 'completedAt'));
  expect(f.mutations).toEqual([]);
});

function transitionCandidate(n, extra = {}) {
  return { attemptId: id(n), examKey: 'pythonnextgeneration', packageVersion: '1.0.0',
    profileKey: 'pythonnextgeneration-lab', profileName: 'Synthetic current choice ' + n, status: 'in_progress',
    startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString(),
    timeLimitMinutes: 1, timed: true, itemCount: 1, purpose: 'self_directed_exam', assignmentId: null,
    languagePreference: null, ...extra };
}
async function loadedTransitionRunner(page, f, extra = {}) {
  await f.mount('runner', extra);
  await page.getByRole('button', { name: /Start (?:exam|practice)/i }).click();
  await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toBeEnabled();
}
function transitionHistory() {
  return [...Array.from({ length: 40 }, (_, i) => history(i + 1)),
    ...Array.from({ length: 30 }, (_, i) => ({ ...history(i + 101), examKey: 'inf303', profileKey: 'standard-profile' }))];
}
async function allTransitionHistory(page, f) {
  f.history = transitionHistory(); await f.mount();
  await expect(page.locator('.saved-result-item')).toHaveCount(10);
  await page.getByRole('combobox').first().selectOption('all');
}
const historyMore = (page) => page.locator('.saved-pagination button');
const historyTotal = (page, loaded, total) => page.getByText('All Time · ' + loaded + ' of ' + total + ' loaded', { exact: true });

test('post-switch runner: settled resume choices load the selected current attempt', async ({ page }) => {
  const f = await fixture(page);
  await loadedTransitionRunner(page, f);
  f.candidates = [transitionCandidate(71), transitionCandidate(72)];
  await f.change({ kind: 'lab' });
  await expect(page.getByRole('button', { name: /Resume attempt/ })).toHaveCount(2);
  await page.getByRole('button', { name: /Synthetic current choice 72/ }).click();
  await expect(page.getByText('Synthetic question for ' + id(72), { exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toBeEnabled();
  expect(f.gets).toContain('/attempts/' + id(72));
  expect(f.mutations).toEqual(['/practice/sessions']);
});
test('post-switch runner: current managed pending work owns status controls', async ({ page }) => {
  const f = await fixture(page);
  await loadedTransitionRunner(page, f);
  f.statuses.set(id(88), { ...row(88), profileKey: 'pythonnextgeneration-lab' });
  await f.change({ kind: 'lab' });
  await expect(page.getByRole('heading', { name: 'Time expired', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check status', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Check status', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Check status', exact: true })).toBeEnabled();
  expect(f.gets).toContain('/attempts/' + id(88) + '/completion-status');
  expect(f.mutations).toEqual(['/practice/sessions']);
});
for (const code of ['inactive_account', 'internal_failure']) test('post-switch runner: settled ' + code + ' exposes safe exit', async ({ page }) => {
  const f = await fixture(page);
  await loadedTransitionRunner(page, f);
  f.availabilityError = code;
  await f.change({ kind: 'lab' });
  await expect(page.getByRole('button', { name: 'Return to exam dashboard', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Checking selected exam', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Return to exam dashboard', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Exam dashboard', exact: true })).toBeVisible();
  expect(f.mutations).toEqual(['/practice/sessions']);
});
for (const [name, initial, next, body] of [
  ['exam', {}, { examId: 'inf303', profileId: 'inf303-standard' }, { examKey: 'inf303', profileId: 'inf303-standard' }],
  ['assignment', {}, { purpose: 'self_directed_exam', assignmentId: id(777) }, { purpose: 'self_directed_exam', assignmentId: id(777) }],
  ['language', { examId: 'az204', profileId: 'standard-profile', language: 'csharp' }, { language: 'python' }, { examKey: 'az204', language: 'python' }],
]) test('post-switch runner: loaded ' + name + ' change uses the exact new launch context', async ({ page }) => {
  const f = await fixture(page); await loadedTransitionRunner(page, f, initial);
  await f.change(next);
  await expect(page.getByRole('button', { name: /Start (?:exam|practice)/i })).toBeEnabled();
  f.nextStartId = 77;
  const request = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/practice/sessions'));
  await page.getByRole('button', { name: /Start (?:exam|practice)/i }).click();
  expect((await request).postDataJSON()).toMatchObject(body);
  await expect(page.getByText('Synthetic question for ' + id(77), { exact: true })).toBeVisible();
  expect(f.mutations).toEqual(['/practice/sessions', '/practice/sessions']);
});
for (const ordering of ['before', 'after']) test('post-switch runner: loaded A to B to A rejects B ' + ordering + ' A settles', async ({ page }) => {
  const f = await fixture(page), gate = barrier();
  await loadedTransitionRunner(page, f);
  f.availabilityGate = gate; await f.change({ kind: 'lab' }); await gate.arrived;
  await f.change({ kind: 'no-lab' });
  if (ordering === 'before') { gate.release(); await gate.finished; }
  await expect(page.getByRole('button', { name: /Start exam/i })).toBeEnabled();
  if (ordering === 'after') { gate.release(); await gate.finished; await settle(page); }
  await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toHaveCount(0);
  f.nextStartId = 77;
  const request = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/practice/sessions'));
  await page.getByRole('button', { name: /Start exam/i }).click();
  expect((await request).postDataJSON().profileId).toBe('pythonnextgeneration-no-lab');
  await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toBeEnabled();
  expect(f.mutations).toHaveLength(2);
});
test('post-switch runner: returning to loaded A performs a genuine matching resume', async ({ page }) => {
  const f = await fixture(page); await loadedTransitionRunner(page, f);
  await f.change({ kind: 'lab' }); await expect(page.getByRole('button', { name: /Start exam/i })).toBeEnabled();
  f.candidates = [transitionCandidate(55, { profileKey: 'pythonnextgeneration-no-lab' })];
  const reads = f.gets.length;
  await f.change({ kind: 'no-lab' });
  await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toBeEnabled();
  expect(f.gets.slice(reads)).toContain('/attempts/' + id(55));
  expect(f.mutations).toEqual(['/practice/sessions']);
});
test('post-switch runner: obsolete timer and held visibility read cannot re-enter old expiry', async ({ page }) => {
  const f = await fixture(page), old = barrier();
  await page.clock.install();
  await loadedTransitionRunner(page, f);
  f.statusGates.set(id(55), old);
  await page.evaluate(() => window.dispatchEvent(new Event('online'))); await old.arrived;
  f.statusOverrides.set(id(55), row(55));
  await f.change({ kind: 'lab' });
  await expect(page.getByRole('button', { name: /Start exam/i })).toBeEnabled();
  old.release(); await old.finished;
  await page.clock.fastForward(180000); await settle(page);
  await expect(page.getByRole('button', { name: /Start exam/i })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Time expired', exact: true })).toHaveCount(0);
  expect(f.mutations).toEqual(['/practice/sessions']);
});
test('post-switch runner: unsaved original answers block discard and survive matching resume', async ({ page }) => {
  const f = await fixture(page); await loadedTransitionRunner(page, f);
  await page.getByRole('radio', { name: 'Synthetic answer' }).check();
  await f.change({ kind: 'lab' });
  await expect(page.getByRole('button', { name: /Start exam/i })).toBeDisabled();
  expect(await page.evaluate(() => window.__leaveLearnerStatusFixture())).toBe(false);
  expect(f.mutations).toEqual(['/practice/sessions']);
  f.candidates = [transitionCandidate(55, { profileKey: 'pythonnextgeneration-no-lab' })];
  await f.change({ kind: 'no-lab' });
  await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toBeChecked();
  expect(await page.evaluate(() => window.__leaveLearnerStatusFixture())).toBe(true);
  await expect(page.getByRole('heading', { name: 'Exam dashboard', exact: true })).toBeVisible();
  expect(f.mutations.filter((p) => p.endsWith('/response'))).toHaveLength(1);
  expect(f.mutations.filter((p) => p.endsWith('/submit') || p.includes('abandon') || p.includes('replace'))).toHaveLength(0);
});
test('post-switch runner: held navigation save cannot cause a late exit or reopen old content', async ({ page }) => {
  const f = await fixture(page), gate = barrier(); await loadedTransitionRunner(page, f);
  await page.getByRole('radio', { name: 'Synthetic answer' }).check(); f.saveGate = gate;
  const leave = page.evaluate(() => window.__leaveLearnerStatusFixture()); await gate.arrived;
  await f.change({ kind: 'lab' }); gate.release(); await gate.finished;
  expect(await leave).toBe(false);
  await expect(page.getByRole('button', { name: /Start exam/i })).toBeDisabled();
  await expect(page.getByRole('radio')).toHaveCount(0);
  expect(f.mutations.filter((p) => p.endsWith('/response'))).toHaveLength(1);
  expect(f.mutations.filter((p) => p.endsWith('/submit') || p.includes('abandon') || p.includes('replace'))).toHaveLength(0);
});

for (const outcome of ['success', 'failure', 'abort']) test('post-switch history: stale ' + outcome + ' cannot unlock a newer pagination operation', async ({ page }) => {
  const f = await fixture(page), old = barrier(), newer = barrier();
  await allTransitionHistory(page, f);
  f.historyGate = old;
  if (outcome !== 'success') f.historyFailures.set('|' + cursorFor(history(20), 'completedAt'), outcome);
  await historyMore(page).click(); await old.arrived;
  await page.getByRole('combobox').nth(1).selectOption('inf303');
  await expect(historyTotal(page, 20, 30)).toBeVisible();
  f.historyGate = newer;
  await historyMore(page).click(); await newer.arrived;
  old.release(); await old.finished; await settle(page);
  await expect(historyMore(page)).toBeDisabled();
  await expect(historyTotal(page, 20, 30)).toBeVisible();
  newer.release(); await newer.finished;
  await expect(historyTotal(page, 30, 30)).toBeVisible();
  expect((await page.locator('.saved-result-item').allTextContents()).every((t) => t.startsWith('INF-303'))).toBe(true);
  expect(f.historyReads.every((r) => r.pageSize === 20)).toBe(true);
  expect(f.historyReads.length).toBeLessThanOrEqual(5);
});
test('post-switch history: A to B to A never revives the first A pagination owner', async ({ page }) => {
  const f = await fixture(page), old = barrier(), current = barrier();
  await allTransitionHistory(page, f);
  f.historyGate = old; await historyMore(page).click(); await old.arrived;
  await page.getByRole('combobox').nth(1).selectOption('inf303'); await expect(historyTotal(page, 20, 30)).toBeVisible();
  await page.getByRole('combobox').nth(1).selectOption(''); await expect(historyTotal(page, 20, 70)).toBeVisible();
  f.historyGate = current; await historyMore(page).click(); await current.arrived;
  old.release(); await old.finished; await settle(page);
  await expect(historyMore(page)).toBeDisabled();
  await expect(historyTotal(page, 20, 70)).toBeVisible();
  current.release(); await current.finished; await expect(historyTotal(page, 40, 70)).toBeVisible();
  expect(f.mutations).toEqual([]);
});
for (const outcome of ['empty', 'single', 'error']) test('post-switch history: new ' + outcome + ' first page retires old busy and error state', async ({ page }) => {
  const f = await fixture(page), old = barrier(); await allTransitionHistory(page, f);
  f.historyGate = old; await historyMore(page).click(); await old.arrived;
  if (outcome === 'empty') f.history = f.history.filter((r) => r.examKey !== 'inf303');
  if (outcome === 'single') f.history = f.history.filter((r) => r.examKey !== 'inf303' || Number(r.attemptId.slice(-12)) <= 110);
  if (outcome === 'error') f.historyFailures.set('inf303|head', 'failure');
  await page.getByRole('combobox').nth(1).selectOption('inf303');
  if (outcome === 'error') await expect(page.locator('.form-panel > [role="alert"]')).toBeVisible();
  else await expect(historyTotal(page, outcome === 'empty' ? 0 : 10, outcome === 'empty' ? 0 : 10)).toBeVisible();
  old.release(); await old.finished; await settle(page);
  await expect(historyMore(page)).toHaveCount(0);
  f.historyFailures.clear();
  await page.getByRole('combobox').nth(1).selectOption('');
  await expect(historyMore(page)).toBeEnabled();
  await historyMore(page).click();
  await expect(page.locator('.saved-result-item')).toHaveCount(40);
});
for (const outcome of ['failure', 'abort']) test('post-switch history: current pagination ' + outcome + ' settles and retry is usable', async ({ page }) => {
  const f = await fixture(page); await allTransitionHistory(page, f);
  const key = '|' + cursorFor(history(20), 'completedAt'); f.historyFailures.set(key, outcome);
  await historyMore(page).click();
  await expect(historyMore(page)).toBeEnabled();
  await expect(historyTotal(page, 20, 70)).toBeVisible();
  f.historyFailures.clear(); await historyMore(page).click();
  await expect(historyTotal(page, 40, 70)).toBeVisible();
  expect(f.historyReads.length).toBeLessThanOrEqual(5);
});
for (const change of ['logout', 'account', 'unmount']) test('post-switch history: held pagination cannot leak into ' + change, async ({ page }) => {
  const f = await fixture(page), old = barrier(); await allTransitionHistory(page, f);
  f.historyGate = old; await historyMore(page).click(); await old.arrived;
  f.history = [];
  if (change === 'unmount') await page.evaluate(() => window.__mountLearnerStatusFixture({ session: null, view: 'home', kind: 'no-lab', count: 1 }));
  else await f.change({ session: change === 'logout' ? null : session(id(998)) });
  old.release(); await old.finished; await settle(page);
  await expect(page.locator('.saved-result-item')).toHaveCount(0);
  await expect(historyMore(page)).toHaveCount(0);
  if (change === 'logout') await expect(page.getByRole('heading', { name: 'Sign in to view Saved Results', exact: true })).toBeVisible();
  if (change === 'unmount') await expect(page.getByRole('heading', { name: 'Exam dashboard', exact: true })).toBeVisible();
  expect(f.mutations).toEqual([]);
});
test('post-switch history: synchronous duplicate clicks enqueue only one page', async ({ page }) => {
  const f = await fixture(page), gate = barrier(); await allTransitionHistory(page, f);
  f.historyGate = gate;
  await historyMore(page).evaluate((b) => { b.click(); b.click(); });
  await gate.arrived; expect(f.historyRequests).toHaveLength(2);
  gate.release(); await gate.finished; await expect(historyTotal(page, 40, 70)).toBeVisible();
  expect(f.historyRequests).toHaveLength(2); await expect(historyMore(page)).toBeEnabled();
});
test('post-switch history: queued completion hand-off preserves a paginating history tail', async ({ page }) => {
  const f = await fixture(page), gate = barrier();
  f.history = [...Array.from({ length: 20 }, (_, i) => history(i + 1)), history(22),
    ...Array.from({ length: 30 }, (_, i) => ({ ...history(i + 101), examKey: 'inf303', profileKey: 'standard-profile' }))];
  f.statuses.set(id(21), row(21)); await f.mount(); await expect(pending(page).locator('li')).toHaveCount(1);
  await page.getByRole('combobox').first().selectOption('all');
  f.historyGate = gate; await historyMore(page).click(); await gate.arrived;
  f.complete(21);
  const refreshClick = page.getByRole('button', { name: 'Refresh pending status', exact: true }).click();
  await refreshClick; gate.release(); await gate.finished;
  await expect(pending(page).locator('li')).toHaveCount(0);
  await expect(historyTotal(page, 40, 52)).toBeVisible();
  await historyMore(page).click(); await expect(historyTotal(page, 52, 52)).toBeVisible();
  expect(f.historyRequests).toHaveLength(3);
  expect(f.mutations).toEqual([]);
});

test('post-switch runner: language input A to B to A does not revive an old local override', async ({ page }) => {
  const f = await fixture(page);
  await loadedTransitionRunner(page, f, { examId: 'az204', profileId: 'standard-profile', language: 'csharp' });
  let gate = barrier(); f.availabilityGate = gate;
  await f.change({ profileId: 'compact-profile' }); await gate.arrived; gate.release(); await gate.finished;
  await expect(page.getByRole('button', { name: /Start exam/i })).toBeEnabled();
  gate = barrier(); f.availabilityGate = gate;
  await page.locator('input[name="coding-language"][value="python"]').check(); await gate.arrived; gate.release(); await gate.finished;
  await expect(page.getByRole('button', { name: /Start exam/i })).toBeEnabled();
  for (const language of ['mixed', 'csharp']) {
    gate = barrier(); f.availabilityGate = gate;
    await f.change({ language }); await gate.arrived; gate.release(); await gate.finished;
    await expect(page.getByRole('button', { name: /Start exam/i })).toBeEnabled();
  }
  await expect(page.locator('input[name="coding-language"][value="csharp"]')).toBeChecked();
  f.nextStartId = 77;
  const request = page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith('/practice/sessions'));
  await page.getByRole('button', { name: /Start exam/i }).click();
  expect((await request).postDataJSON()).toMatchObject({ profileId: 'compact-profile', language: 'csharp' });
  await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toBeEnabled();
  expect(f.mutations).toEqual(['/practice/sessions', '/practice/sessions']);
});
