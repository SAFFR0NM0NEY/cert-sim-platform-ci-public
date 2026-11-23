import { expect, test } from '@playwright/test';

const opaqueIds = /private-statement|source-a|source-b|target-a|target-b|blank-a|option-a|correctValuesByStatement|correctTargetIdsBySource|correctOptionIdsByBlank|answer:/;

for (const mode of ['single', 'composite', 'matching', 'code']) {
  test(`Python Standard ${mode} review renders readable presentation text`, async ({ page }) => {
    await page.goto(`/tests/r3g/python-standard-review-harness.html?mode=${mode}`);
    await expect(page.getByRole('list')).toHaveCount(2);
    await expect(page.getByText(opaqueIds)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('list')).toHaveCount(2);
    await expect(page.getByText(opaqueIds)).toHaveCount(0);
  });
}

test('Python Standard structured review fails closed for an unknown identity', async ({ page }) => {
  await page.goto('/tests/r3g/python-standard-review-harness.html?mode=malformed');
  await expect(page.getByText('Answer details unavailable')).toHaveCount(1);
  await expect(page.getByText(opaqueIds)).toHaveCount(0);
});

test('withheld Python Standard review exposes no answer text', async ({ page }) => {
  await page.goto('/tests/r3g/python-standard-review-harness.html?mode=withheld');
  await expect(page.getByRole('status')).toContainText('withheld');
  await expect(page.getByText(/True|False|list|tuple|print|input/)).toHaveCount(0);
});
