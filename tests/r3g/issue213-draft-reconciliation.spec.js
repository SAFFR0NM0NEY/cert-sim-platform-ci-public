import { expect, test } from '@playwright/test';

// Real runner/helpers; only synthetic loopback transport is modeled. No source
// is stored by this fixture unless a matching explicit response PUT succeeds.
const user = '21300000-0000-4000-8000-000000000999';
const id = (n) => '21300000-0000-4000-8000-' + String(n).padStart(12, '0');
const releases = new Set();
test.afterEach(() => { for (const release of releases) release(); releases.clear(); });
function gate() {
  let enter, release, finish;
  const arrived = new Promise((r) => { enter = r; });
  const held = new Promise((r) => { release = r; });
  const finished = new Promise((r) => { finish = r; });
  releases.add(release);
  return { arrived, release, finished, wait: async () => { enter(); await held; }, finish };
}
async function fixture(page, { count = 21, multi = false, boolean = false } = {}) {
  const f = { count, active: null, nextId: 55, starts: [], resumes: [], pages: [], saves: [], otherMutations: [],
    stored: new Map([[21, { answer: boolean ? true : multi ? ['b'] : 'b', revision: 3 }]]), pageGate: null, resumeGate: null,
    saveGate: null, pageFailure: null, saveFailure: null, currentUser: user };
  const item = (n) => {
    const saved = f.stored.get(n);
    return { itemId: id(800 + n), questionId: 'draft-synthetic-' + n, questionNumber: n, domain: 'Synthetic domain',
      section: 'standard', revision: saved?.revision ?? 0, response: saved ? { answer: structuredClone(saved.answer) } : null,
      questionType: boolean ? 'true-false-single-v1' : multi ? 'multi-select' : 'single-choice', presentation: { question: 'Draft synthetic item ' + n, ...(boolean ? { statementId: 'synthetic-statement' } : {}),
        options: [{ id: 'a', text: 'Draft answer A' }, { id: 'b', text: 'Draft answer B' }, { id: 'c', text: 'Draft answer C' }] } };
  };
  const prefix = () => ({ attempt: f.active, items: Array.from({ length: Math.min(20, count) }, (_, i) => item(i + 1)),
    page: { afterPosition: 0, returnedThrough: Math.min(20, count), totalCount: count, hasMore: count > 20 } });
  await page.route('**/*', (r) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(r.request().url()).hostname) ? r.fallback() : r.abort('blockedbyclient'));
  await page.route('**/functions/v1/**', async (route) => {
    const request = route.request(), u = new URL(request.url()), path = u.pathname.split('/certsim-protected-exam')[1];
    let held;
    const json = async (body, status = 200) => {
      try { await route.fulfill({ status, contentType: 'application/json', headers: { 'cache-control': 'no-store' }, body: JSON.stringify(body) }); }
      finally { held?.finish(); }
    };
    if (path === '/practice/availability') return json({ examKey: u.searchParams.get('examKey'), packageVersion: '1.0.0',
      profileKey: u.searchParams.get('profileId'), profileName: 'Synthetic draft profile', purpose: 'study_sandbox',
      assignmentId: null, selectedCount: count, available: true, fixedProfileSize: false, adjustedCount: false, timed: false, timeLimitMinutes: null });
    if (path === '/practice/recoverable-sandboxes') return json({ candidates: [] });
    if (path === '/attempts/current-bindings') return json({ candidates: f.active ? [f.active] : [] });
    // The existing legacy contract explicitly lacks this exact status route.
    if (/^\/attempts\/[^/]+\/completion-status$/.test(path)) return json({ error: { code: 'invalid_request' } }, 404);
    if (path === '/practice/sessions' && request.method() === 'POST') {
      const body = request.postDataJSON(); f.starts.push(body);
      f.active = { attemptId: id(f.nextId), examKey: body.examKey, packageVersion: '1.0.0', profileKey: body.profileId,
        profileName: 'Synthetic draft profile', status: 'in_progress', startedAt: new Date().toISOString(), expiresAt: null,
        timeLimitMinutes: null, timed: false, itemCount: count, purpose: 'study_sandbox', assignmentId: null, languagePreference: null };
      return json(prefix(), 201);
    }
    if (/^\/attempts\/[^/]+$/.test(path) && request.method() === 'GET') {
      f.resumes.push(path); const payload = prefix();
      if (f.resumeGate) { held = f.resumeGate; f.resumeGate = null; await held.wait(); }
      return json(payload);
    }
    if (path?.endsWith('/items')) {
      const afterPosition = Number(u.searchParams.get('afterPosition')), pageSize = Number(u.searchParams.get('pageSize'));
      f.pages.push({ attemptId: path.split('/')[2], afterPosition, pageSize });
      const end = Math.min(count, afterPosition + pageSize);
      const payload = { items: Array.from({ length: end - afterPosition }, (_, i) => item(afterPosition + i + 1)),
        afterPosition, returnedThrough: end, totalCount: count, hasMore: end < count };
      if (f.pageGate) { held = f.pageGate; f.pageGate = null; await held.wait(); }
      if (f.pageFailure === 'abort') { try { await route.abort('failed'); } finally { held?.finish(); } return; }
      if (f.pageFailure) return json({ error: { code: 'internal_failure' } }, 503);
      return json(payload);
    }
    if (path?.endsWith('/response') && request.method() === 'PUT') {
      const body = request.postDataJSON(), n = Number(path.split('/')[4].slice(-12)) - 800;
      f.saves.push({ n, ...body });
      if (f.saveFailure) return json({ error: { code: f.saveFailure } }, 409);
      const saved = f.stored.get(n), revision = saved?.revision ?? 0;
      if (body.expectedRevision !== revision) return json({ error: { code: 'stale_response' } }, 409);
      f.stored.set(n, { answer: structuredClone(body.response.answer), revision: revision + 1 });
      if (f.saveGate) { held = f.saveGate; f.saveGate = null; await held.wait(); }
      return json({ itemId: id(800 + n), revision: revision + 1, updatedAt: new Date().toISOString(), ...f.ackOverride });
    }
    if (path?.endsWith('/flags')) return json({ itemIds: [] });
    if (!['GET', 'OPTIONS'].includes(request.method())) f.otherMutations.push(path);
    return json({ error: { code: 'unexpected_draft_fixture_route' } }, 500);
  });
  f.mount = async () => {
    await page.goto('/tests/r3g/issue201-learner-status-harness.html');
    await expect.poll(() => page.evaluate(() => typeof window.__mountLearnerStatusFixture)).toBe('function');
    await page.evaluate((config) => window.__mountLearnerStatusFixture(config), { session: { access_token: 'synthetic-draft-token', user: { id: user } }, kind: 'no-lab', count, purpose: 'study_sandbox', view: 'runner' });
    await page.getByRole('button', { name: 'Start practice', exact: true }).click();
    await shown(page, 1);
  };
  f.change = (next) => page.evaluate((config) => window.__changeLearnerStatusConfig(config), next);
  f.roundTrip = async () => {
    await f.change({ kind: 'lab' }); await expect(page.getByRole('button', { name: /Start (?:new|practice)/i }).first()).toBeVisible();
    await f.change({ kind: 'no-lab' }); await shown(page, 1);
  };
  return f;
}
const shown = (page, n) => expect(page.getByText('Draft synthetic item ' + n, { exact: true })).toBeVisible();
async function nextTo(page, first, last) { for (let n = first; n < last; n++) { await shown(page, n); await page.getByRole('button', { name: 'Next', exact: true }).click(); } await shown(page, last); }
const answer = (page, label, multi = false) => page.getByRole(multi ? 'checkbox' : 'radio', { name: 'Draft answer ' + label, exact: true });

test('draft preservation: matching resume and later page keep unsaved A/revision3 with zero saves', async ({ page }) => {
  const f = await fixture(page); await f.mount(); await nextTo(page, 1, 21);
  await expect(answer(page, 'B')).toBeChecked(); await answer(page, 'A').check();
  await f.roundTrip();
  const held = gate(); f.pageGate = held;
  const navigation = nextTo(page, 1, 21); await held.arrived; held.release(); await held.finished; await navigation;
  const proof = { suite: 'maintained-dirty-tail-preservation', localASelected: await answer(page, 'A').isChecked(),
    oldBSelected: await answer(page, 'B').isChecked(), starts: f.starts.length, resumes: f.resumes.length, pageReads: f.pages,
    responseSaves: f.saves.length, otherMutations: f.otherMutations };
  console.log(JSON.stringify(proof));
  expect(f.starts).toHaveLength(1); expect(f.resumes).toHaveLength(1);
  expect(f.pages).toEqual([{ attemptId: id(55), afterPosition: 20, pageSize: 20 }, { attemptId: id(55), afterPosition: 20, pageSize: 20 }]);
  expect(f.saves).toEqual([]); expect(f.otherMutations).toEqual([]);
  await expect(answer(page, 'A')).toBeChecked(); await expect(answer(page, 'B')).not.toBeChecked();
});


test('draft prefix: current matching resume retains its dirty value and expected revision', async ({ page }) => {
  const f = await fixture(page, { count: 1 }); f.stored.set(1, { answer: 'b', revision: 3 });
  await f.mount(); await answer(page, 'A').check(); await f.roundTrip();
  await expect(answer(page, 'A')).toBeChecked(); expect(f.saves).toEqual([]);
  await page.getByRole('button', { name: 'Save & exit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Exam dashboard', exact: true })).toBeVisible();
  expect(f.saves).toHaveLength(1); expect(f.saves[0]).toMatchObject({ n: 1, response: { answer: 'a' }, expectedRevision: 3 });
});
test('draft multiple: matching resumes preserve ordinary drafts across three supported pages', async ({ page }) => {
  const f = await fixture(page, { count: 41 }); f.stored.set(1, { answer: 'b', revision: 3 }); f.stored.set(41, { answer: 'b', revision: 3 });
  await f.mount(); await nextTo(page, 1, 41); await answer(page, 'A').check();
  await f.roundTrip(); await answer(page, 'C').check(); await f.roundTrip();
  await expect(answer(page, 'C')).toBeChecked(); expect(f.saves).toEqual([]);
  await nextTo(page, 1, 41); await expect(answer(page, 'A')).toBeChecked();
  await expect(page.locator('.question-navigator .nav-grid button')).toHaveCount(41);
  expect(f.saves).toHaveLength(1); expect(f.saves[0]).toMatchObject({ n: 1, expectedRevision: 3, response: { answer: 'c' } });
  expect(f.resumes).toHaveLength(2); expect(f.starts).toHaveLength(1); expect(f.otherMutations).toEqual([]);
});
test('draft clear: an intentionally empty selection stays dirty through later-page reads', async ({ page }) => {
  const f = await fixture(page, { multi: true }); await f.mount(); await nextTo(page, 1, 21);
  await answer(page, 'B', true).uncheck(); await f.roundTrip(); await nextTo(page, 1, 21);
  for (const label of ['A', 'B', 'C']) await expect(answer(page, label, true)).not.toBeChecked();
  expect(f.saves).toEqual([]);
  await page.getByRole('button', { name: 'Save & exit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Exam dashboard', exact: true })).toBeVisible();
  expect(f.saves[0]).toMatchObject({ n: 21, expectedRevision: 3, response: { answer: [] } });
});
test('draft false: supported boolean false survives resume/page reads and serializes as false', async ({ page }) => {
  const f = await fixture(page, { boolean: true }); await f.mount(); await nextTo(page, 1, 21);
  await page.getByRole('radio', { name: 'False', exact: true }).check();
  await f.roundTrip(); await nextTo(page, 1, 21);
  await expect(page.getByRole('radio', { name: 'False', exact: true })).toBeChecked(); expect(f.saves).toEqual([]);
  await page.getByRole('button', { name: 'Save & exit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Exam dashboard', exact: true })).toBeVisible();
  expect(f.saves[0]).toMatchObject({ n: 21, expectedRevision: 3, response: { answer: false } });
});
test('draft clean: later server answers and revisions refresh normally', async ({ page }) => {
  const f = await fixture(page); await f.mount(); await nextTo(page, 1, 21);
  f.stored.set(21, { answer: 'c', revision: 4 }); await f.roundTrip(); await nextTo(page, 1, 21);
  await expect(answer(page, 'C')).toBeChecked(); expect(f.saves).toEqual([]);
  await answer(page, 'A').check(); await page.getByRole('button', { name: 'Save & exit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Exam dashboard', exact: true })).toBeVisible();
  expect(f.saves[0]).toMatchObject({ expectedRevision: 4, response: { answer: 'a' } });
});
test('draft repeated: repeated matching resume/page reads retain intent without duplicate items', async ({ page }) => {
  const f = await fixture(page); await f.mount(); await nextTo(page, 1, 21); await answer(page, 'A').check();
  for (let n = 0; n < 2; n++) { await f.roundTrip(); await nextTo(page, 1, 21); await expect(answer(page, 'A')).toBeChecked(); }
  await expect(page.locator('.question-navigator .nav-grid button')).toHaveCount(21);
  expect(f.saves).toEqual([]); expect(f.resumes).toHaveLength(2); expect(f.pages).toHaveLength(3); expect(f.starts).toHaveLength(1);
});
test('draft held read: current dirty answer survives a held older page snapshot', async ({ page }) => {
  const f = await fixture(page); await f.mount(); await nextTo(page, 1, 21); await answer(page, 'A').check(); await f.roundTrip();
  const held = gate(); f.pageGate = held; const nav = nextTo(page, 1, 21); await held.arrived;
  f.stored.set(21, { answer: 'c', revision: 4 });
  await expect(page.getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
  held.release(); await held.finished; await nav; await expect(answer(page, 'A')).toBeChecked(); expect(f.saves).toEqual([]);
});
for (const failure of ['failure', 'abort']) test('draft page ' + failure + ': preserves local intent and permits safe retry', async ({ page }) => {
  const f = await fixture(page); await f.mount(); await nextTo(page, 1, 21); await answer(page, 'A').check(); await f.roundTrip();
  await nextTo(page, 1, 20); f.pageFailure = failure;
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.locator('.status-note[role="alert"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled();
  f.pageFailure = null; await page.getByRole('button', { name: 'Next', exact: true }).click(); await shown(page, 21);
  await expect(answer(page, 'A')).toBeChecked(); expect(f.saves).toEqual([]); expect(f.otherMutations).toEqual([]);
});
test('draft stale page: prior attempt/view cannot apply or unlock a newer item-page read', async ({ page }) => {
  const f = await fixture(page); await f.mount(); await nextTo(page, 1, 20);
  const old = gate(); f.pageGate = old;
  await page.getByRole('button', { name: 'Next', exact: true }).click(); await old.arrived;
  await f.change({ kind: 'lab' }); await expect(page.getByRole('button', { name: 'Start practice', exact: true })).toBeEnabled();
  f.nextId = 77; f.stored.set(21, { answer: 'c', revision: 4 });
  await page.getByRole('button', { name: 'Start practice', exact: true }).click(); await shown(page, 1);
  await nextTo(page, 1, 20); const current = gate(); f.pageGate = current;
  await page.getByRole('button', { name: 'Next', exact: true }).click(); await current.arrived;
  old.release(); await old.finished;
  await expect(page.getByRole('button', { name: 'Saving...', exact: true })).toBeDisabled();
  current.release(); await current.finished; await shown(page, 21); await expect(answer(page, 'C')).toBeChecked();
  expect(f.starts).toHaveLength(2); expect(f.saves).toEqual([]); expect(f.otherMutations).toEqual([]);
});
for (const scope of ['account', 'logout', 'unmount']) test('draft stale page: held old page cannot publish after ' + scope, async ({ page }) => {
  const f = await fixture(page); await f.mount(); await nextTo(page, 1, 20);
  const held = gate(); f.pageGate = held;
  await page.getByRole('button', { name: 'Next', exact: true }).click(); await held.arrived;
  if (scope === 'unmount') await page.evaluate(() => window.__mountLearnerStatusFixture({ session: null, view: 'home', kind: 'no-lab', count: 21, purpose: 'study_sandbox' }));
  else await f.change({ session: scope === 'logout' ? null : { access_token: 'synthetic-other-token', user: { id: id(998) } } });
  held.release(); await held.finished;
  await expect(page.getByText('Draft synthetic item 21', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('radio')).toHaveCount(0); expect(f.saves).toEqual([]); expect(f.otherMutations).toEqual([]);
});
test('draft explicit save: A uses revision3, settles only on matching acknowledgment and reopens from server', async ({ page }) => {
  const f = await fixture(page); await f.mount(); await nextTo(page, 1, 21); await answer(page, 'A').check();
  await f.roundTrip(); await nextTo(page, 1, 21); expect(f.saves).toEqual([]);
  const held = gate(); f.saveGate = held;
  await page.getByRole('button', { name: 'Save & exit', exact: true }).click(); await held.arrived;
  await expect(page.getByRole('heading', { name: 'Exam dashboard', exact: true })).toHaveCount(0);
  expect(f.saves).toHaveLength(1); expect(f.saves[0]).toMatchObject({ n: 21, response: { answer: 'a' }, expectedRevision: 3 });
  held.release(); await held.finished;
  await expect(page.getByRole('heading', { name: 'Exam dashboard', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open exam', exact: true }).click(); await shown(page, 1); await nextTo(page, 1, 21);
  await expect(answer(page, 'A')).toBeChecked();
  expect(f.stored.get(21)).toEqual({ answer: 'a', revision: 4 });
  expect(await page.evaluate(() => window.__leaveLearnerStatusFixture())).toBe(true);
  expect(f.saves).toHaveLength(1); expect(f.starts).toHaveLength(1); expect(f.otherMutations).toEqual([]);
  console.log(JSON.stringify({ suite: 'draft-explicit-save', saves: f.saves.length, expectedRevision: f.saves[0].expectedRevision, localPayload: f.saves[0].response.answer, acknowledgedRevision: f.stored.get(21).revision, starts: f.starts.length }));
});
test('draft conflict: newer server revision does not rebase or clean local A and never retries automatically', async ({ page }) => {
  const f = await fixture(page); await f.mount(); await nextTo(page, 1, 21); await answer(page, 'A').check();
  f.stored.set(21, { answer: 'c', revision: 4 }); await f.roundTrip(); await nextTo(page, 1, 21);
  await expect(answer(page, 'A')).toBeChecked(); expect(f.saves).toEqual([]);
  await page.getByRole('button', { name: 'Save & exit', exact: true }).click();
  await expect(page.getByText(/Not saved:/)).toBeVisible(); await expect(answer(page, 'A')).toBeChecked();
  expect(f.saves).toHaveLength(1); expect(f.saves[0]).toMatchObject({ expectedRevision: 3, response: { answer: 'a' } });
  expect(f.stored.get(21)).toEqual({ answer: 'c', revision: 4 });
  await f.roundTrip(); await nextTo(page, 1, 21); await expect(answer(page, 'A')).toBeChecked();
  expect(f.saves).toHaveLength(1); expect(f.otherMutations).toEqual([]);
  console.log(JSON.stringify({ suite: 'draft-conflict', saves: f.saves.length, expectedRevision: f.saves[0].expectedRevision, serverRevision: f.stored.get(21).revision, localRetained: await answer(page, 'A').isChecked(), automaticRetries: f.saves.length - 1 }));
});
test('draft save failure: local intent and its original revision remain recoverable', async ({ page }) => {
  const f = await fixture(page); await f.mount(); await nextTo(page, 1, 21); await answer(page, 'A').check();
  await f.roundTrip(); await nextTo(page, 1, 21); f.saveFailure = 'response_conflict';
  await page.getByRole('button', { name: 'Save & exit', exact: true }).click(); await expect(page.getByText(/Not saved:/)).toBeVisible();
  await expect(answer(page, 'A')).toBeChecked(); expect(f.saves).toHaveLength(1);
  f.saveFailure = null; await page.getByRole('button', { name: 'Save & exit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Exam dashboard', exact: true })).toBeVisible();
  expect(f.saves).toHaveLength(2); expect(f.saves.every((s) => s.expectedRevision === 3 && s.response.answer === 'a')).toBe(true);
});
for (const invalid of ['item', 'revision']) test('draft invalid ' + invalid + ' acknowledgment does not clear local intent', async ({ page }) => {
  const f = await fixture(page); await f.mount(); await nextTo(page, 1, 21); await answer(page, 'A').check();
  f.ackOverride = invalid === 'item' ? { itemId: id(999) } : { revision: 99 };
  await page.getByRole('button', { name: 'Save & exit', exact: true }).click(); await expect(page.getByText(/Not saved:/)).toBeVisible();
  await expect(answer(page, 'A')).toBeChecked(); expect(f.saves).toHaveLength(1);
  await f.change({ kind: 'lab' }); await expect(page.getByRole('button', { name: 'Start practice', exact: true })).toBeDisabled();
  expect(f.otherMutations).toEqual([]);
});
test('draft unloaded consumer: exits cannot discard or serialize a dirty item without its definition', async ({ page }) => {
  const f = await fixture(page); await f.mount(); await nextTo(page, 1, 21); await answer(page, 'A').check(); await f.roundTrip();
  expect(await page.evaluate(() => window.__leaveLearnerStatusFixture())).toBe(false);
  await page.getByRole('button', { name: 'Save & exit', exact: true }).click();
  await expect(page.getByText(/Unsaved answers on another item/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Submit exam', exact: true })).toHaveCount(0);
  expect(f.saves).toEqual([]); expect(f.otherMutations).toEqual([]);
  await nextTo(page, 1, 21); await expect(answer(page, 'A')).toBeChecked();
  await page.getByRole('button', { name: 'Save & exit', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Exam dashboard', exact: true })).toBeVisible();
  expect(f.saves).toHaveLength(1); expect(f.saves[0]).toMatchObject({ n: 21, expectedRevision: 3, response: { answer: 'a' } });
});


test('draft newer edit: old same-attempt page cannot overwrite an edit made after a fresh resume/page load', async ({ page }) => {
  const f = await fixture(page); await f.mount(); await nextTo(page, 1, 20);
  const old = gate(); f.pageGate = old;
  await page.getByRole('button', { name: 'Next', exact: true }).click(); await old.arrived;
  await f.roundTrip(); await nextTo(page, 1, 21); await answer(page, 'A').check();
  old.release(); await old.finished;
  await expect(answer(page, 'A')).toBeChecked(); await expect(answer(page, 'B')).not.toBeChecked();
  expect(f.saves).toEqual([]); expect(f.pages).toHaveLength(2); expect(f.resumes).toHaveLength(1); expect(f.starts).toHaveLength(1);
});
test('draft newer edit: obsolete save acknowledgment cannot clean or rebase a newer current edit', async ({ page }) => {
  const f = await fixture(page); await f.mount(); await nextTo(page, 1, 21); await answer(page, 'A').check();
  const old = gate(); f.saveGate = old;
  await page.getByRole('button', { name: 'Previous', exact: true }).click(); await old.arrived;
  expect(f.stored.get(21)).toEqual({ answer: 'a', revision: 4 });
  await f.roundTrip(); await nextTo(page, 1, 21); await answer(page, 'C').check();
  old.release(); await old.finished;
  await expect(answer(page, 'C')).toBeChecked();
  await page.getByRole('button', { name: 'Save & exit', exact: true }).click();
  await expect(page.getByText(/Not saved:/)).toBeVisible(); await expect(answer(page, 'C')).toBeChecked();
  expect(f.saves).toHaveLength(2);
  expect(f.saves[0]).toMatchObject({ expectedRevision: 3, response: { answer: 'a' } });
  expect(f.saves[1]).toMatchObject({ expectedRevision: 3, response: { answer: 'c' } });
  expect(f.otherMutations).toEqual([]);
});
