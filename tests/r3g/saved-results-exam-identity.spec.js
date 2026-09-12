import { expect, test } from '@playwright/test';

const historyItem = (overrides) => ({
  attemptId: 'attempt-fixture',
  examKey: 'ai901',
  packageVersion: '3.0.0',
  profileKey: 'full',
  purpose: 'self_directed_exam',
  completedAt: '2026-09-06T08:00:00.000Z',
  score: 800,
  percentage: 80,
  passed: true,
  domainSummary: {},
  serverAuthoritative: true,
  reviewStatus: 'withheld',
  source: 'protected',
  ...overrides,
});

test('Saved Results shows canonical exam identities and filters with canonical values', async ({ page }) => {
  const filters = [];
  const allItems = [
    historyItem({ attemptId: 'ai901-current' }),
    historyItem({
      attemptId: 'security-practice',
      examKey: 'securityplussy0701',
      purpose: 'study_sandbox',
      percentage: 70,
    }),
    historyItem({
      attemptId: 'az400-legacy',
      examKey: 'AZ 400',
      source: 'legacy_authoritative',
      serverAuthoritative: false,
      packageVersion: null,
      percentage: 65,
      passed: false,
    }),
  ];

  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.split('/certsim-protected-exam')[1];
    if (!path.startsWith('/history')) {
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unexpected_fixture_route' } }) });
    }
    const examKey = url.searchParams.get('examKey') ?? '';
    filters.push(examKey);
    const items = examKey === 'security-plus-sy0-701' ? [allItems[1]] : allItems;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items, returnedCount: items.length, totalCount: items.length, remainingCount: 0, nextCursor: null }),
    });
  });

  await page.goto('/tests/r3g/protected-saved-results-harness.html');
  await expect(page.getByRole('button', { name: /^AI-901 — Azure AI Fundamentals/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^SY0-701 — Security\+/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^AZ-400 — Designing and Implementing Microsoft DevOps Solutions/ })).toBeVisible();
  await expect(page.getByText('Historical account result', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /^SY0-701 — Security\+ 70% · Practice/ })).toBeVisible();
  await expect(page.getByText('Certification exam', { exact: true })).toHaveCount(0);
  await expect(page.getByText('securityplussy0701', { exact: false })).toHaveCount(0);

  await page.getByLabel('Exam').selectOption('security-plus-sy0-701');
  await expect(page.getByRole('button', { name: /^SY0-701 — Security\+/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^AI-901 — Azure AI Fundamentals/ })).toHaveCount(0);
  expect(filters).toContain('security-plus-sy0-701');
});
