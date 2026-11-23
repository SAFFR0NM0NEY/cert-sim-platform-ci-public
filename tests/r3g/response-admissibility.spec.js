import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test.describe.configure({ mode: 'serial' });
for (const policy of ['omitted','false','true']) test(`real React/Edge matching ${policy} and four-family full credit`, async ({ page }) => {
  if (!process.env.RUNNER_TEMP || !['127.0.0.1','localhost'].includes(new URL(process.env.SUPABASE_URL).hostname)) throw Error('DISPOSABLE_BROWSER_REQUIRED');
  const account = JSON.parse(await readFile(path.join(process.env.RUNNER_TEMP, 'response-browser-accounts.json'), 'utf8')).find(a => a.policy === policy);
  const binding = spawnSync('psql', [process.env.SUPABASE_DB_URL, '-XqAt', '-v', 'ON_ERROR_STOP=1'], {
    input: `update exam_delivery.package_profile_defaults d set package_version_id=p.id,package_profile_id=pp.id from exam_delivery.package_versions p join exam_delivery.package_profiles pp on pp.package_version_id=p.id where d.canonical_exam_key='inf303' and d.profile_key='inf303-standard' and p.exam_key='inf303' and p.package_version='${account.packageVersion}' and pp.profile_key='inf303-standard';`, encoding: 'utf8' });
  expect(binding.status).toBe(0);
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const auth = await client.auth.signInWithPassword({ email: account.email, password: account.password });
  if (auth.error) throw Error('SYNTHETIC_AUTH_FAILED');
  const session = auth.data.session, starts = [], results = [], saves = [];
  await page.route('**/*', route => ['127.0.0.1','localhost','[::1]'].includes(new URL(route.request().url()).hostname) ? route.fallback() : route.abort('blockedbyclient'));
  page.on('response', async r => {
    if (!r.url().includes('/functions/v1/certsim-protected-exam/') || !r.ok()) return;
    if (r.url().endsWith('/practice/sessions')) starts.push(await r.json());
    if (r.url().endsWith('/submit')) results.push(await r.json());
    if (r.url().endsWith('/response') && r.request().method() === 'PUT') saves.push(await r.json());
  });
  await page.goto('/tests/r3g/variable-python-harness.html');
  await page.waitForFunction(() => typeof window.__mountVariableFixture === 'function');
  await page.evaluate(session => window.__mountVariableFixture(session), session);
  await expect(page.getByText('4 or 5 — server assigned at Start', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /start.*(exam|practice|attempt)/i }).click();
  await expect.poll(() => starts.length).toBe(1);
  expect(starts[0].items.map(i => i.questionType)).toEqual(['true-false-single-v1','true-false-composite-v1','matching-v1','code-dropdown-completion-v1']);
  const a = starts[0].attempt, matching = starts[0].items[2];
  expect(a.packageVersion).toBe(account.packageVersion);
  const expectedReuse = policy === 'omitted' && process.env.RESPONSE_CORRECTION_PHASE === 'before' ? undefined : policy === 'true';
  expect(matching.presentation.allowTargetReuse).toBe(expectedReuse);
  expect((Date.parse(a.expiresAt)-Date.parse(a.startedAt))/1000).toBe(2700);
  const nextSaved = async () => {
    const response = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith('/response') && r.ok());
    await page.getByRole('button', { name: 'Next', exact: true }).click(); await response;
  };
  await page.getByRole('radiogroup', { name: 'Statement 1', exact: true }).getByRole('radio', { name: 'True', exact: true }).check();
  await nextSaved();
  await page.getByRole('radiogroup', { name: 'Statement 1', exact: true }).getByRole('radio', { name: 'True', exact: true }).check();
  await page.getByRole('radiogroup', { name: 'Statement 2', exact: true }).getByRole('radio', { name: 'False', exact: true }).check();
  await nextSaved();
  const left = page.getByRole('combobox', { name: 'Match for Synthetic source A', exact: true });
  const right = page.getByRole('combobox', { name: 'Match for Synthetic source B', exact: true });
  await left.selectOption('x');
  await expect(left).toHaveValue('x');
  const duplicateOption = right.locator('option[value="x"]');
  const before = process.env.RESPONSE_CORRECTION_PHASE === 'before';
  // This Playwright version's control matcher reports native options enabled
  // even with a disabled attribute. Assert the browser's actual option property.
  await expect(duplicateOption).toHaveJSProperty('disabled', !(policy === 'true' || (before && policy === 'omitted')));
  // Persist a partial response through the actual mounted runner, then a wrong
  // admissible response, then the full correct response, retaining original ID.
  await nextSaved(); await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await left.selectOption('y'); await right.selectOption(policy === 'true' ? 'y' : 'x');
  await nextSaved(); await page.getByRole('button', { name: 'Previous', exact: true }).click();
  if (policy !== 'true') {
    const forbidden = await page.request.put(`${process.env.SUPABASE_URL}/functions/v1/certsim-protected-exam/attempts/${a.attemptId}/items/${matching.itemId}/response`, {
      headers: { Authorization: `Bearer ${session.access_token}`, apikey: process.env.SUPABASE_ANON_KEY },
      data: { response: { answer: { a: 'x', b: 'x' } }, expectedRevision: 2, requestId: crypto.randomUUID() },
    });
    expect(forbidden.ok()).toBe(false);
  }
  // Clear the second selection before selecting the distinct correct pair.
  await right.selectOption(''); await left.selectOption('x'); await right.selectOption(policy === 'true' ? 'x' : 'y');
  await nextSaved();
  await page.getByRole('combobox', { name: 'Code blank a', exact: true }).selectOption('x');
  await page.getByRole('combobox', { name: 'Code blank b', exact: true }).selectOption('x');
  await page.getByRole('button', { name: 'Submit exam', exact: true }).click();
  await page.getByRole('button', { name: 'Submit Final Attempt', exact: true }).click();
  await expect.poll(() => results.length).toBe(1);
  const result = results[0].result ?? results[0];
  expect(result.questionCount).toBe(4); expect(result.rawScore).toBe(8); expect(result.maxScore).toBe(8);
  const revisions = saves.filter(s => s.revision != null).map(s => s.revision);
  expect(revisions).toContain(3);
  const summary = await page.request.get(`${process.env.SUPABASE_URL}/functions/v1/certsim-protected-exam/attempts/${a.attemptId}/print-summary`, {
    headers: { Authorization: `Bearer ${session.access_token}`, apikey: process.env.SUPABASE_ANON_KEY },
  });
  expect(summary.ok()).toBe(true);
  console.log(JSON.stringify({ suite: 'response-react-edge-full-credit', phase: before ? 'before' : 'after', policy,
    selectedCount: 4, rawScore: 8, rawMaximum: 8, matchingRevision: 3, actualMountedSave: true, syntheticOnly: true }));
});
