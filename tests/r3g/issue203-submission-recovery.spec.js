import { expect, test } from '@playwright/test';

const attemptId = '20300000-0000-4000-8000-000000000010';
const itemId = '20300000-0000-4000-8000-000000000011';
const workspaceHash = 'a'.repeat(64);
const retrySafeCodes = [
  'grading_failed',
  'grading_incomplete',
  'grading_reconciliation_required',
  'submission_in_progress',
];
const externalRequestsByPage = new WeakMap();

test.afterEach(async ({ page }) => {
  expect(externalRequestsByPage.get(page) ?? []).toEqual([]);
});

for (const code of retrySafeCodes) {
  test(`${code} keeps the real runner recoverable with one identity and no repeated save`, async ({ page }) => {
    const fixture = await installFixture(page, {
      profile: 'lab',
      submitActions: [{ error: code, status: 409 }, { result: authoritativeResult() }],
      rejectWorkspaceSaveAfter: 1,
    });
    await openAttempt(page, 'lab');
    await submitFinal(page);

    await expect(page.getByRole('heading', { name: 'Final submission needs confirmation' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue submission' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check result' })).toBeVisible();
    expect(fixture.workspaceSaves).toHaveLength(1);
    expect(fixture.responseSaves).toHaveLength(0);

    await page.getByRole('button', { name: 'Continue submission' }).click();
    await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toBeVisible();
    expect(fixture.submits).toHaveLength(2);
    expect(fixture.submits[1]).toEqual(fixture.submits[0]);
    expect(fixture.submits[0].attemptId).toBe(attemptId);
    expect(fixture.workspaceSaves).toHaveLength(1);
    expect(fixture.responseSaves).toHaveLength(0);
  });
}

test('initial response-save failure dispatches no Submit and remains a preparation error', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'no-lab',
    responseSaveError: 'stale_response',
  });
  await openAttempt(page, 'no-lab');
  await page.getByRole('radio', { name: 'Synthetic answer' }).check();
  await submitFinal(page);

  await expect(page.getByText(/Not saved:/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Final submission needs confirmation' })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Synthetic answer' })).toBeChecked();
  expect(fixture.responseSaves).toHaveLength(1);
  expect(fixture.submits).toHaveLength(0);
});

test('double clicks, timer expiry, and repeated pending responses never overlap or change identity', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    expiresInMs: 700,
    submitActions: [
      { error: 'submission_in_progress', status: 409 },
      { error: 'submission_in_progress', status: 409, delayMs: 900 },
      { result: authoritativeResult() },
    ],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);
  const continueButton = page.getByRole('button', { name: 'Continue submission' });
  await expect(continueButton).toBeVisible();

  await continueButton.evaluate((button) => { button.click(); button.click(); });
  await expect(page.getByRole('button', { name: 'Continuing submission...' })).toBeDisabled();
  await page.waitForTimeout(1_100);
  await expect(continueButton).toBeVisible();
  expect(fixture.maxConcurrentSubmits).toBe(1);
  expect(fixture.submits).toHaveLength(2);
  expect(new Set(fixture.submits.map(({ submissionId }) => submissionId)).size).toBe(1);

  await continueButton.click();
  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toBeVisible();
  expect(fixture.submits).toHaveLength(3);
  expect(new Set(fixture.submits.map(({ submissionId }) => submissionId)).size).toBe(1);
  expect(fixture.workspaceSaves).toHaveLength(1);
});

test('ambiguous Submit with a committed result reconciles without a second Submit', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    submitActions: [{ abort: true }],
    resultActions: [{ result: authoritativeResult() }],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);

  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toBeVisible();
  expect(fixture.submits).toHaveLength(1);
  expect(fixture.resultReads).toBe(1);
});

test('ambiguous Submit without a result stays unconfirmed and never fabricates success', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    submitActions: [{ abort: true }],
    resultActions: [{ error: 'attempt_not_found', status: 404 }],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);

  await expect(page.getByRole('heading', { name: 'Final submission needs confirmation' })).toBeVisible();
  await expect(page.getByText(/Completion is not yet confirmed/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toHaveCount(0);
  expect(fixture.submits).toHaveLength(1);
  expect(fixture.resultReads).toBe(1);
});

test('Check result reads only the result endpoint and accepts only an authoritative result', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    submitActions: [{ error: 'grading_failed', status: 503 }],
    resultActions: [{ result: authoritativeResult() }],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);
  await page.getByRole('button', { name: 'Check result' }).click();

  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toBeVisible();
  expect(fixture.submits).toHaveLength(1);
  expect(fixture.resultReads).toBe(1);
  expect(fixture.workspaceSaves).toHaveLength(1);
});

test('Check result with no committed result remains pending without another Submit', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    submitActions: [{ error: 'submission_in_progress', status: 409 }],
    resultActions: [{ error: 'attempt_not_found', status: 404 }],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);
  await page.getByRole('button', { name: 'Check result' }).click();

  await expect(page.getByRole('heading', { name: 'Final submission needs confirmation' })).toBeVisible();
  await expect(page.getByText(/No authoritative result is available yet/i)).toBeVisible();
  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toHaveCount(0);
  expect(fixture.submits).toHaveLength(1);
  expect(fixture.resultReads).toBe(1);
});

test('transient Check result failure keeps locked result recovery for a later authoritative read', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    submitActions: [{ error: 'grading_failed', status: 503 }],
    resultActions: [{ abort: true }, { abort: true }, { result: authoritativeResult() }],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);
  await page.getByRole('button', { name: 'Check result' }).click();

  await expect(page.getByRole('heading', { name: 'Final submission needs confirmation' })).toBeVisible();
  await expect(page.getByText(/completion could not be checked/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue submission' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check result' })).toBeVisible();
  expect(fixture.submits).toHaveLength(1);
  expect(fixture.resultReads).toBe(2);
  expect(fixture.workspaceSaves).toHaveLength(1);
  expect(fixture.responseSaves).toHaveLength(0);

  await page.getByRole('button', { name: 'Check result' }).click();
  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toBeVisible();
  expect(fixture.submits).toHaveLength(1);
  expect(fixture.resultReads).toBe(3);
  expect(fixture.workspaceSaves).toHaveLength(1);
  expect(fixture.responseSaves).toHaveLength(0);
});

test('ambiguous Submit with an unavailable automatic lookup becomes result-check-only recovery', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    submitActions: [{ abort: true }],
    resultActions: [{ abort: true }, { abort: true }, { result: authoritativeResult() }],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);

  await expect(page.getByRole('heading', { name: 'Final submission needs confirmation' })).toBeVisible();
  await expect(page.getByText(/completion could not be checked/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue submission' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check result' })).toBeVisible();
  expect(fixture.submits).toHaveLength(1);
  expect(fixture.resultReads).toBe(2);

  await page.getByRole('button', { name: 'Check result' }).click();
  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toBeVisible();
  expect(fixture.submits).toHaveLength(1);
  expect(fixture.resultReads).toBe(3);
  expect(fixture.workspaceSaves).toHaveLength(1);
  expect(fixture.responseSaves).toHaveLength(0);
});

test('successful Submit with an unavailable follow-up lookup remains check-only until validated', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    submitActions: [{}],
    resultActions: [{ abort: true }, { abort: true }, { result: authoritativeResult() }],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);

  await expect(page.getByRole('heading', { name: 'Final submission needs confirmation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue submission' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check result' })).toBeVisible();
  expect(fixture.submits).toHaveLength(1);
  expect(fixture.resultReads).toBe(2);

  await page.getByRole('button', { name: 'Check result' }).click();
  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toBeVisible();
  expect(fixture.submits).toHaveLength(1);
  expect(fixture.resultReads).toBe(3);
  expect(fixture.workspaceSaves).toHaveLength(1);
  expect(fixture.responseSaves).toHaveLength(0);
});

for (const [code, status] of [
  ['not_allowlisted', 503],
  ['unauthenticated', 401],
  ['invalid_lifecycle_transition', 409],
  ['submission_conflict', 409],
]) {
  test(`result lookup ${code} remains fail-closed`, async ({ page }) => {
    const fixture = await installFixture(page, {
      profile: 'lab',
      submitActions: [{ error: 'grading_failed', status: 503 }],
      resultActions: [{ error: code, status }],
    });
    await openAttempt(page, 'lab');
    await submitFinal(page);
    await page.getByRole('button', { name: 'Check result' }).click();

    await expect(page.getByRole('button', { name: 'Continue submission' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Check result' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Return to exam dashboard' })).toBeVisible();
    expect(fixture.submits).toHaveLength(1);
  });
}

test('result attempt mismatch remains fail-closed', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    submitActions: [{ error: 'grading_failed', status: 503 }],
    resultActions: [{ result: authoritativeResult({ attemptId: '20300000-0000-4000-8000-000000000099' }) }],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);
  await page.getByRole('button', { name: 'Check result' }).click();

  await expect(page.getByRole('button', { name: 'Continue submission' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Check result' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Return to exam dashboard' })).toBeVisible();
  expect(fixture.submits).toHaveLength(1);
});

test('result-check and submission-retry actions stay mutually exclusive', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    submitActions: [{ error: 'grading_failed', status: 503 }],
    resultActions: [{ error: 'attempt_not_found', status: 404, delayMs: 500 }],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);
  const checkButton = page.getByRole('button', { name: 'Check result' });
  await checkButton.click();
  await expect(page.getByRole('button', { name: 'Checking result...' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Continue submission' })).toBeDisabled();
  await page.getByRole('button', { name: 'Continue submission' }).evaluate((button) => button.click());
  await expect(page.getByRole('button', { name: 'Check result' })).toBeVisible();

  expect(fixture.submits).toHaveLength(1);
  expect(fixture.resultReads).toBe(1);
  expect(fixture.maxConcurrentResultReads).toBe(1);
});

test('account change during result lookup aborts and ignores the late result', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    submitActions: [{ error: 'grading_failed', status: 503 }],
    resultActions: [{ result: authoritativeResult(), delayMs: 600 }],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);
  await page.getByRole('button', { name: 'Check result' }).click();
  await page.evaluate(() => window.__setIssue203UserId('20300000-0000-4000-8000-000000000099'));

  await expect(page.getByText(/signed-in account changed/i)).toBeVisible();
  await page.waitForTimeout(750);
  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toHaveCount(0);
  expect(fixture.submits).toHaveLength(1);
});

test('actual attempt change during result lookup cannot apply the old result', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    submitActions: [{ error: 'grading_failed', status: 503 }],
    resultActions: [{ result: authoritativeResult(), delayMs: 600 }],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);
  await page.getByRole('button', { name: 'Check result' }).click();
  fixture.resumeAttemptId = '20300000-0000-4000-8000-000000000088';
  await page.evaluate(() => window.__reinitializeIssue203Attempt());

  await expect(page.getByRole('region', { name: /Python exam workspace/i })).toBeVisible();
  await page.waitForTimeout(750);
  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toHaveCount(0);
  expect(fixture.submits).toHaveLength(1);
});

test('unmount during result lookup ignores the late result', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    submitActions: [{ error: 'grading_failed', status: 503 }],
    resultActions: [{ result: authoritativeResult(), delayMs: 600 }],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);
  await page.getByRole('button', { name: 'Check result' }).click();
  await page.evaluate(() => window.__unmountIssue203Runner());

  await expect(page.getByRole('heading', { name: 'Issue 203 fixture dashboard' })).toBeVisible();
  await page.waitForTimeout(750);
  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toHaveCount(0);
  expect(fixture.submits).toHaveLength(1);
});

test('account change during initial preparation dispatches no Submit', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'no-lab',
    responseSaveActions: [{ delayMs: 500 }],
  });
  await openAttempt(page, 'no-lab');
  await page.getByRole('radio', { name: 'Synthetic answer' }).check();
  await submitFinal(page);
  await page.evaluate(() => window.__setIssue203UserId('20300000-0000-4000-8000-000000000099'));

  await expect(page.getByText(/signed-in account changed before final submission/i)).toBeVisible();
  expect(fixture.responseSaves).toHaveLength(1);
  expect(fixture.submits).toHaveLength(0);
});

test('an in-flight navigation save blocks overlapping submission preparation and dispatch', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'no-lab',
    responseSaveActions: [{ delayMs: 500 }],
  });
  await openAttempt(page, 'no-lab');
  await page.getByRole('radio', { name: 'Synthetic answer' }).check();
  await page.getByRole('button', { name: 'Submit exam' }).click();
  await page.evaluate(() => {
    window.__pendingIssue203Navigation = window.__requestIssue203Navigation();
  });
  await expect.poll(() => fixture.responseSaves.length).toBe(1);
  await page.getByRole('button', { name: 'Submit Final Attempt' }).click();

  await expect(page.getByRole('heading', { name: 'Issue 203 fixture dashboard' })).toBeVisible();
  expect(fixture.responseSaves).toHaveLength(1);
  expect(fixture.submits).toHaveLength(0);
});

test('Check result rejects a non-authoritative result and fails closed', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    submitActions: [{ error: 'submission_in_progress', status: 409 }],
    resultActions: [{ result: authoritativeResult({ serverAuthoritative: false }) }],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);
  await page.getByRole('button', { name: 'Check result' }).click();

  await expect(page.getByRole('button', { name: 'Continue submission' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Return to exam dashboard' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toHaveCount(0);
  expect(fixture.submits).toHaveLength(1);
  expect(fixture.resultReads).toBe(1);
});

test('post-expiry continuation is decided by the existing backend response', async ({ page }) => {
  const accepted = await installFixture(page, {
    profile: 'lab',
    expiresInMs: 600,
    submitActions: [{ error: 'submission_in_progress', status: 409 }, { result: authoritativeResult() }],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Continue submission' }).click();
  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toBeVisible();
  expect(accepted.submits).toHaveLength(2);
});

test('post-expiry lifecycle denial fails closed without a retry bypass', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    expiresInMs: 600,
    submitActions: [
      { error: 'submission_in_progress', status: 409 },
      { error: 'invalid_lifecycle_transition', status: 409 },
    ],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Continue submission' }).click();

  await expect(page.getByText(/can no longer accept that action/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue submission' })).toHaveCount(0);
  expect(fixture.submits).toHaveLength(2);
});

for (const code of ['submission_conflict', 'grading_material_invalid', 'grading_binding_mismatch']) {
  test(`${code} remains terminal and receives no blind retry control`, async ({ page }) => {
    const fixture = await installFixture(page, {
      profile: 'lab',
      submitActions: [{ error: code, status: 409 }],
    });
    await openAttempt(page, 'lab');
    await submitFinal(page);

    await expect(page.getByRole('button', { name: 'Continue submission' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Return to exam dashboard' })).toBeVisible();
    expect(fixture.submits).toHaveLength(1);
  });
}

test('bounded token refresh keeps the same attempt and submission identity', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    submitActions: [
      { error: 'submission_in_progress', status: 409 },
      { error: 'unauthenticated', status: 401, rotateToken: true },
      { result: authoritativeResult() },
    ],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);
  await page.getByRole('button', { name: 'Continue submission' }).click();

  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toBeVisible();
  expect(fixture.submits).toHaveLength(3);
  expect(new Set(fixture.submits.map(({ submissionId }) => submissionId)).size).toBe(1);
  expect(fixture.submits.map(({ authorization }) => authorization)).toEqual([
    'Bearer issue203-fixture-token',
    'Bearer issue203-fixture-token',
    'Bearer issue203-rotated-token',
  ]);
  expect(fixture.workspaceSaves).toHaveLength(1);
});

test('account change aborts an unresolved request and ignores its late result', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    submitActions: [
      { error: 'submission_in_progress', status: 409 },
      { result: authoritativeResult(), delayMs: 700 },
    ],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);
  await page.getByRole('button', { name: 'Continue submission' }).click();
  await page.evaluate(() => window.__setIssue203UserId('20300000-0000-4000-8000-000000000099'));

  await expect(page.getByText(/signed-in account changed/i)).toBeVisible();
  await page.waitForTimeout(900);
  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue submission' })).toHaveCount(0);
  expect(fixture.submits).toHaveLength(2);
});

test('unmount prevents a late result and pending navigation performs no save or lifecycle action', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'lab',
    submitActions: [
      { error: 'submission_in_progress', status: 409 },
      { result: authoritativeResult(), delayMs: 700 },
    ],
  });
  await openAttempt(page, 'lab');
  await submitFinal(page);
  const navigationAllowed = await page.evaluate(() => window.__requestIssue203Navigation());
  expect(navigationAllowed).toBe(false);
  expect(fixture.workspaceSaves).toHaveLength(1);
  expect(fixture.abandons).toBe(0);

  await page.getByRole('button', { name: 'Continue submission' }).click();
  await page.evaluate(() => window.__unmountIssue203Runner());
  await expect(page.getByRole('heading', { name: 'Issue 203 fixture dashboard' })).toBeVisible();
  await page.waitForTimeout(900);
  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toHaveCount(0);
});

test('normal No-Lab manual submission and result rendering remain unchanged', async ({ page }) => {
  const fixture = await installFixture(page, {
    profile: 'no-lab',
    submitActions: [{ result: authoritativeResult({
      profileKey: 'pythonnextgeneration-no-lab',
      reviewStatus: 'withheld',
    }) }],
  });
  await openAttempt(page, 'no-lab');
  await page.getByRole('radio', { name: 'Synthetic answer' }).check();
  await submitFinal(page);

  await expect(page.getByRole('heading', { name: /protected attempt complete/i })).toBeVisible();
  await expect(page.getByText('Question review and answers are withheld for this attempt.')).toBeVisible();
  expect(fixture.responseSaves).toHaveLength(1);
  expect(fixture.workspaceSaves).toHaveLength(0);
  expect(fixture.submits).toHaveLength(1);
});

async function openAttempt(page, profile) {
  await page.goto(`/tests/r3g/issue203-submission-recovery-harness.html?profile=${profile}`);
  await page.getByRole('button', { name: /Start exam/i }).click();
  await expect(page.getByRole('region', { name: /Python exam workspace/i })).toBeVisible();
}

async function submitFinal(page) {
  await page.getByRole('button', { name: 'Submit exam' }).click();
  await page.getByRole('button', { name: 'Submit Final Attempt' }).click();
}

async function installFixture(page, {
  profile,
  submitActions = [{ result: authoritativeResult() }],
  resultActions = [],
  responseSaveError = '',
  responseSaveActions = [],
  rejectWorkspaceSaveAfter = Number.POSITIVE_INFINITY,
  expiresInMs = 60_000,
}) {
  const fixture = {
    abandons: 0,
    externalRequests: [],
    maxConcurrentSubmits: 0,
    maxConcurrentResultReads: 0,
    resumeAttemptId: '',
    responseSaves: [],
    resultReads: 0,
    submits: [],
    workspaceSaves: [],
  };
  let activeSubmits = 0;
  let activeResultReads = 0;
  let responseSaveIndex = 0;
  let submitIndex = 0;
  let resultIndex = 0;
  const profileKey = profile === 'no-lab'
    ? 'pythonnextgeneration-no-lab'
    : 'pythonnextgeneration-lab';
  const item = profile === 'no-lab' ? standardItem() : labItem();
  const attempt = {
    attemptId,
    examKey: 'pythonnextgeneration',
    packageVersion: '1.0.0',
    profileKey,
    profileName: profile === 'no-lab' ? 'No-Lab' : 'Lab',
    status: 'in_progress',
    startedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    timeLimitMinutes: 50,
    timed: true,
    itemCount: 1,
    purpose: 'self_directed_exam',
    languagePreference: null,
  };

  externalRequestsByPage.set(page, fixture.externalRequests);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      fixture.externalRequests.push(request.url());
    }
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return route.fallback();
    return route.abort('blockedbyclient');
  });

  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/certsim-protected-exam')[1];
    const body = request.postDataJSON?.() ?? null;
    const json = (value, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(value),
    });
    if (path.startsWith('/attempts/current-bindings')) return json({
      candidates: fixture.resumeAttemptId ? [{ ...attempt, attemptId: fixture.resumeAttemptId }] : [],
    });
    if (path.startsWith('/practice/availability')) return json({
      examKey: 'pythonnextgeneration', packageVersion: '1.0.0', profileKey,
      purpose: 'self_directed_exam', available: true, selectedCount: 1,
      adjustedCount: true, profileQuestionCount: profile === 'no-lab' ? 35 : 31,
      timeLimitMinutes: 50, fixedProfileSize: false, domainCounts: {},
      missedCount: 0, newCount: 1, pbqCount: 0, languages: [],
    });
    if (path === '/practice/sessions') return json({
      attempt,
      items: [item],
      page: { returnedThrough: 1, totalCount: 1, hasMore: false },
    }, 201);
    if (fixture.resumeAttemptId && path === `/attempts/${fixture.resumeAttemptId}` && request.method() === 'GET') {
      return json({
        attempt: { ...attempt, attemptId: fixture.resumeAttemptId },
        items: [item],
        page: { returnedThrough: 1, totalCount: 1, hasMore: false },
      });
    }
    if (path.endsWith('/flags')) return json({ itemIds: [] });
    if (path.endsWith('/python/workspace') && request.method() === 'GET') return json({
      itemId, exists: false, revision: 0, workspaceHash: null, workspace: null, updatedAt: null,
    });
    if (path.endsWith('/python/workspace') && request.method() === 'PUT') {
      fixture.workspaceSaves.push(body);
      if (fixture.workspaceSaves.length > rejectWorkspaceSaveAfter) {
        return json({ error: { code: 'invalid_lifecycle_transition' } }, 409);
      }
      return json({ itemId, revision: 1, workspaceHash, updatedAt: new Date().toISOString() });
    }
    if (path.endsWith('/response') && request.method() === 'PUT') {
      fixture.responseSaves.push(body);
      const action = responseSaveActions[Math.min(responseSaveIndex, responseSaveActions.length - 1)] ?? {};
      responseSaveIndex += 1;
      if (action.delayMs) await page.waitForTimeout(action.delayMs);
      if (action.error) return json({ error: { code: action.error } }, action.status ?? 409);
      if (responseSaveError) return json({ error: { code: responseSaveError } }, 409);
      return json({ itemId, revision: 1, updatedAt: new Date().toISOString() });
    }
    if (path.endsWith('/submit') && request.method() === 'POST') {
      const action = submitActions[Math.min(submitIndex, submitActions.length - 1)];
      submitIndex += 1;
      activeSubmits += 1;
      fixture.maxConcurrentSubmits = Math.max(fixture.maxConcurrentSubmits, activeSubmits);
      fixture.submits.push({
        attemptId,
        submissionId: body.submissionId,
        authorization: request.headers().authorization,
      });
      try {
        if (action.delayMs) await page.waitForTimeout(action.delayMs);
        if (action.rotateToken) {
          await page.evaluate(() => window.__setIssue203AccessToken('issue203-rotated-token'));
        }
        if (action.abort) return route.abort('failed');
        if (action.error) return json({ error: { code: action.error } }, action.status ?? 409);
        return json({ result: action.result });
      } catch {
        return undefined;
      } finally {
        activeSubmits -= 1;
      }
    }
    if (path.endsWith('/result') && request.method() === 'GET') {
      fixture.resultReads += 1;
      activeResultReads += 1;
      fixture.maxConcurrentResultReads = Math.max(fixture.maxConcurrentResultReads, activeResultReads);
      const action = resultActions[Math.min(resultIndex, resultActions.length - 1)] ?? {
        error: 'attempt_not_found', status: 404,
      };
      resultIndex += 1;
      try {
        if (action.delayMs) await page.waitForTimeout(action.delayMs);
        if (action.abort) return route.abort('failed');
        if (action.error) return json({ error: { code: action.error } }, action.status ?? 404);
        return json({ result: action.result });
      } catch {
        return undefined;
      } finally {
        activeResultReads -= 1;
      }
    }
    if (path.endsWith('/abandon')) {
      fixture.abandons += 1;
      return json({ ok: true });
    }
    return json({ error: { code: 'unexpected_fixture_route' } }, 500);
  });
  return fixture;
}

function standardItem() {
  return {
    itemId,
    questionId: '20300000-0000-4000-8000-000000000012',
    questionNumber: 1,
    questionType: 'single-choice',
    domain: 'Synthetic domain',
    section: 'standard',
    response: null,
    revision: 0,
    presentation: {
      question: 'Choose the synthetic answer.',
      options: [{ id: 'synthetic', text: 'Synthetic answer' }],
    },
  };
}

function labItem() {
  return {
    itemId,
    questionId: '20300000-0000-4000-8000-000000000013',
    questionNumber: 1,
    questionType: 'executable-python-lab-v1',
    domain: 'Synthetic domain',
    section: 'standard',
    response: null,
    revision: 0,
    presentation: {
      interactionVersion: 'executable-python-lab-v1',
      task: 'Complete the synthetic Python task.',
      instructions: ['Use only the synthetic fixture.'],
      starterWorkspace: {
        entryPoint: 'main.py',
        files: [{ path: 'main.py', content: 'print("synthetic")\n' }],
      },
      allowedFilenames: ['main.py'],
    },
  };
}

function authoritativeResult(overrides = {}) {
  return {
    attemptId,
    examKey: 'pythonnextgeneration',
    profileKey: 'pythonnextgeneration-lab',
    completedAt: new Date().toISOString(),
    questionCount: 1,
    answeredCount: 1,
    rawScore: 1,
    maxScore: 1,
    rawPercentage: 100,
    scaledScore: 1000,
    passed: true,
    passMark: 700,
    domainBreakdown: [],
    reviewStatus: 'withheld',
    serverAuthoritative: true,
    ...overrides,
  };
}
