import { expect, test } from '@playwright/test';

const summary = (reviewStatus = 'withheld') => ({
  exam: { key: 'ai901', version: '3.0.0' },
  profile: { key: 'ai901-full', name: 'Full' },
  purpose: 'self_directed_exam',
  completedAt: '2026-09-08T08:00:00.000Z',
  score: 178.32,
  percentage: 99.06,
  passed: true,
  domainSummary: {
    vision: { domainLabel: 'Computer Vision', earnedPoints: 178.32, maxPoints: 180, percentage: 99.06 },
  },
  completionStatus: 'completed',
  serverAuthoritative: true,
  reviewStatus,
  source: 'protected',
});

for (const reviewStatus of ['released', 'withheld']) {
  test(`protected Saved Result downloads a valid ${reviewStatus} summary PDF after reopen`, async ({ page }) => {
    await page.route('**/functions/v1/certsim-protected-exam/attempts/attempt-fixture/print-summary', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(summary(reviewStatus)),
    }));

    await page.goto('/tests/r3g/protected-saved-results-harness.html?attemptId=attempt-fixture');
    await expect(page.getByRole('button', { name: 'Print result summary' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Download PDF' })).toBeVisible();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download PDF' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^CertSim-ai901-Saved-Result-2026-09-08\.pdf$/);
    const path = await download.path();
    const bytes = await import('node:fs/promises').then(({ readFile }) => readFile(path));
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.byteLength).toBeGreaterThan(1500);
    await expect(page.getByText(/Downloaded CertSim-ai901-Saved-Result/)).toBeVisible();
  });
}

test('protected Saved Result exposes a visible PDF failure and keeps Print available', async ({ page }) => {
  await page.route('**/functions/v1/certsim-protected-exam/attempts/attempt-fixture/print-summary', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ...summary(), serverAuthoritative: false }),
  }));
  await page.goto('/tests/r3g/protected-saved-results-harness.html?attemptId=attempt-fixture');
  await page.getByRole('button', { name: 'Download PDF' }).click();
  await expect(page.getByRole('alert')).toHaveText('PDF download failed. Use Print as a fallback.');
  await expect(page.getByRole('button', { name: 'Print result summary' })).toBeVisible();
});
