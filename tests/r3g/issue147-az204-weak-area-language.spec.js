import { expect, test } from '@playwright/test';

const canonicalLanguages = new Set(['csharp', 'python', 'mixed']);

const examFixture = {
  az204: { packageVersion: '1.1.0', profileId: 'standard-profile' },
  ai901: { packageVersion: '3.0.0', profileId: 'ai901-controlled-beta-compact' },
  inf303: { packageVersion: '1.1.0', profileId: 'inf303-compact' },
};

function result(examKey, overrides = {}) {
  const fixture = examFixture[examKey];
  return {
    attemptId: `synthetic-${examKey}`,
    examKey,
    packageVersion: fixture.packageVersion,
    profileKey: fixture.profileId,
    purpose: 'self_directed_exam',
    completedAt: '2026-09-10T08:00:00.000Z',
    score: 550,
    percentage: 55,
    passed: false,
    domainSummary: { 'domain-x': { label: 'Domain X', earnedPoints: 55, maxPoints: 100, percentage: 55 } },
    serverAuthoritative: true,
    reviewStatus: 'withheld',
    source: 'protected',
    ...overrides,
  };
}

async function mockSavedResults(page, examKey, options = {}) {
  const availabilityRequests = [];
  const weakAreaRequests = [];
  let rejectedRequests = 0;
  const historyItems = options.historyItems ?? [result(examKey)];
  const discoveryDomains = options.discoveryDomains ?? [{ domainKey: 'domain-x', evidenceCount: 1, lowestPercentage: 55 }];
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.split('/certsim-protected-exam')[1];
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path.startsWith('/history')) return json({ items: historyItems, returnedCount: historyItems.length, totalCount: historyItems.length, remainingCount: 0, nextCursor: null });
    if (path.startsWith('/practice/weak-areas')) {
      weakAreaRequests.push(Object.fromEntries(url.searchParams));
      return json({ examKey, packageVersion: examFixture[examKey].packageVersion, profileKey: url.searchParams.get('profileId'), domains: discoveryDomains });
    }
    if (path.startsWith('/practice/availability')) {
      const request = Object.fromEntries(url.searchParams);
      availabilityRequests.push(request);
      if (examKey === 'az204' && !canonicalLanguages.has(request.language)) {
        rejectedRequests += 1;
        return json({ error: { code: 'invalid_request' } }, 400);
      }
      if (options.availabilityError) {
        return json({ error: { code: options.availabilityError } }, 409);
      }
      return json({ examKey, packageVersion: examFixture[examKey].packageVersion, profileKey: request.profileId, purpose: 'weak_area', selectedCount: 20, available: 20, adjustedCount: false });
    }
    return json({ error: { code: 'unexpected_fixture_route' } }, 500);
  });
  return { availabilityRequests, weakAreaRequests, rejectedRequests: () => rejectedRequests };
}

for (const language of ['csharp', 'python', 'mixed']) {
  test(`AZ-204 ${language} uses the same language for availability and start`, async ({ page }) => {
    const recorder = await mockSavedResults(page, 'az204');
    const legacyRequest = { examKey: 'az204', profileId: 'standard-profile', purpose: 'weak_area', domain: 'domain-x', count: 20, includePbqs: true, mixStrategy: 'balanced' };
    expect(canonicalLanguages.has(legacyRequest.language)).toBe(false);

    await page.goto(`/tests/r3g/protected-saved-results-harness.html?language=${language}`);
    await expect(page.getByLabel('Language')).toHaveValue(language);
    await expect(page.getByRole('button', { name: 'Start Weak Area Practice' })).toBeEnabled();
    expect(recorder.weakAreaRequests.at(-1)).toEqual({ examKey: 'az204', profileId: 'standard-profile' });
    expect(recorder.rejectedRequests()).toBe(0);
    expect(recorder.availabilityRequests.at(-1)).toMatchObject({
      examKey: 'az204', profileId: 'standard-profile', purpose: 'weak_area', domain: 'domain-x',
      count: '20', includePbqs: 'true', mixStrategy: 'balanced', language,
    });
    await page.getByRole('button', { name: 'Start Weak Area Practice' }).click();
    expect(JSON.parse(await page.getByTestId('started').textContent())).toEqual({
      examKey: 'az204', profileId: 'standard-profile', purpose: 'weak_area', domain: 'domain-x',
      count: 20, includePbqs: true, mixStrategy: 'balanced', language,
    });
  });
}

test('staff assessment history remains visible but cannot invent a weak-area option', async ({ page }) => {
  const recorder = await mockSavedResults(page, 'az204', {
    historyItems: [result('az204', { actorClassification: 'staff' })],
    discoveryDomains: [],
  });
  await page.goto('/tests/r3g/protected-saved-results-harness.html?language=csharp');
  await expect(page.locator('.saved-result-item')).toHaveCount(1);
  await expect(page.getByText('Complete a marked exam with missed questions or a domain below 70% before starting Weak Area Practice.')).toBeVisible();
  await expect(page.getByLabel('Weak domain')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start Weak Area Practice' })).toBeDisabled();
  expect(recorder.weakAreaRequests).toHaveLength(1);
  expect(recorder.availabilityRequests).toHaveLength(0);
});

test('mapped predecessor evidence exposes only the current-package domain', async ({ page }) => {
  const recorder = await mockSavedResults(page, 'az204', {
    historyItems: [result('az204', {
      packageVersion: '1.0.0',
      domainSummary: { 'predecessor-domain': { label: 'Predecessor Domain', earnedPoints: 40, maxPoints: 100, percentage: 40 } },
    })],
    discoveryDomains: [{ domainKey: 'current-domain', evidenceCount: 1, lowestPercentage: 40 }],
  });
  await page.goto('/tests/r3g/protected-saved-results-harness.html?language=mixed');
  await expect(page.getByLabel('Weak domain')).toHaveValue('current-domain');
  await expect(page.getByRole('button', { name: 'Start Weak Area Practice' })).toBeEnabled();
  expect(recorder.availabilityRequests.at(-1)?.domain).toBe('current-domain');
  expect(recorder.availabilityRequests.at(-1)?.domain).not.toBe('predecessor-domain');
});

test('unmapped predecessor evidence produces no invented weak domain or availability request', async ({ page }) => {
  const recorder = await mockSavedResults(page, 'az204', {
    historyItems: [result('az204', {
      packageVersion: '1.0.0',
      domainSummary: { 'unmapped-domain': { label: 'Unmapped Domain', earnedPoints: 10, maxPoints: 100, percentage: 10 } },
    })],
    discoveryDomains: [],
  });
  await page.goto('/tests/r3g/protected-saved-results-harness.html?language=python');
  await expect(page.getByText('Complete a marked exam with missed questions or a domain below 70% before starting Weak Area Practice.')).toBeVisible();
  await expect(page.getByLabel('Weak domain')).toHaveCount(0);
  expect(recorder.availabilityRequests).toHaveLength(0);
});

test('unclassified historical activity remains visible and is excluded before discovery', async ({ page }) => {
  const recorder = await mockSavedResults(page, 'az204', {
    historyItems: [result('az204', { purpose: 'unclassified', source: 'legacy_authoritative', serverAuthoritative: false })],
  });
  await page.goto('/tests/r3g/protected-saved-results-harness.html?language=csharp');
  await expect(page.locator('.saved-result-item')).toHaveCount(1);
  await expect(page.getByText('Complete a marked exam with missed questions or a domain below 70% before starting Weak Area Practice.')).toBeVisible();
  expect(recorder.weakAreaRequests).toHaveLength(0);
  expect(recorder.availabilityRequests).toHaveLength(0);
});

test('no_weak_areas remains a specific safe client message instead of an internal failure', async ({ page }) => {
  await mockSavedResults(page, 'az204', { availabilityError: 'no_weak_areas' });
  await page.goto('/tests/r3g/protected-saved-results-harness.html?language=csharp');
  await expect(page.getByText('Complete a marked exam with missed questions or a domain below 70% before starting Weak Area Practice.')).toBeVisible();
  await expect(page.getByText('The protected exam request failed.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start Weak Area Practice' })).toBeDisabled();
});

test('changing AZ-204 language refreshes availability and preserves the selected start language', async ({ page }) => {
  const recorder = await mockSavedResults(page, 'az204');
  await page.goto('/tests/r3g/protected-saved-results-harness.html?language=csharp');
  await expect(page.getByRole('button', { name: 'Start Weak Area Practice' })).toBeEnabled();
  await page.getByLabel('Language').selectOption('python');
  await expect(page.getByTestId('language-preference')).toHaveText('python');
  await expect.poll(() => recorder.availabilityRequests.at(-1)?.language).toBe('python');
  await expect(page.getByRole('button', { name: 'Start Weak Area Practice' })).toBeEnabled();
  await page.getByRole('button', { name: 'Start Weak Area Practice' }).click();
  expect(JSON.parse(await page.getByTestId('started').textContent()).language).toBe('python');
});

test('missing AZ-204 language reproduces rejection before a valid selection enables start', async ({ page }) => {
  const recorder = await mockSavedResults(page, 'az204');
  await page.goto('/tests/r3g/protected-saved-results-harness.html?language=');
  await expect(page.getByText('Select a valid AZ-204 coding language before starting practice.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start Weak Area Practice' })).toBeDisabled();
  expect(recorder.availabilityRequests).toHaveLength(0);

  const legacyStatus = await page.evaluate(async () => {
    const query = new URLSearchParams({
      examKey: 'az204',
      profileId: 'standard-profile',
      purpose: 'weak_area',
      domain: 'domain-x',
      count: '20',
      includePbqs: 'true',
      mixStrategy: 'balanced',
    });
    return (await fetch(`/functions/v1/certsim-protected-exam/practice/availability?${query}`)).status;
  });
  expect(legacyStatus).toBe(400);
  expect(recorder.rejectedRequests()).toBe(1);

  await page.getByLabel('Language').selectOption('csharp');
  await expect.poll(() => recorder.availabilityRequests.at(-1)?.language).toBe('csharp');
  await expect(page.getByRole('button', { name: 'Start Weak Area Practice' })).toBeEnabled();
  await page.getByRole('button', { name: 'Start Weak Area Practice' }).click();
  expect(JSON.parse(await page.getByTestId('started').textContent()).language).toBe('csharp');
});

test('invalid AZ-204 language fails closed before availability or start', async ({ page }) => {
  const recorder = await mockSavedResults(page, 'az204');
  await page.goto('/tests/r3g/protected-saved-results-harness.html?language=CSHARP');
  await expect(page.getByLabel('Language')).toHaveValue('');
  await expect(page.getByText('Select a valid AZ-204 coding language before starting practice.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start Weak Area Practice' })).toBeDisabled();
  expect(recorder.availabilityRequests).toHaveLength(0);
  await expect(page.getByTestId('started')).toHaveCount(0);
});

for (const examKey of ['ai901', 'inf303']) {
  test(`${examKey} remains language-free for availability and start`, async ({ page }) => {
    const recorder = await mockSavedResults(page, examKey);
    await page.goto('/tests/r3g/protected-saved-results-harness.html?language=python');
    await expect(page.getByLabel('Language')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Start Weak Area Practice' })).toBeEnabled();
    expect(recorder.availabilityRequests.at(-1)).not.toHaveProperty('language');
    await page.getByRole('button', { name: 'Start Weak Area Practice' }).click();
    expect(JSON.parse(await page.getByTestId('started').textContent())).not.toHaveProperty('language');
  });
}
