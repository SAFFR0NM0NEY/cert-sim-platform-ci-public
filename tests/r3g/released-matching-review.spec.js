import { expect, test } from '@playwright/test';
const opaqueIds = /left-a|left-b|right-x|right-y|correctPairs|answer:/;
for (const mode of ['correct', 'incorrect']) test(`${mode} released matching review uses readable semantic pair lists`, async ({ page }) => {
  await page.goto(`/tests/r3g/released-matching-review-harness.html?mode=${mode}`);
  const lists = page.getByRole('list');
  await expect(lists).toHaveCount(2);
  await expect(lists.nth(1).getByRole('listitem')).toHaveText(['Detect objects in an image → Azure AI Vision', 'Extract text from a document → Document Intelligence']);
  await expect(page.getByText(opaqueIds)).toHaveCount(0);
});
test('released matching review remains readable after history reopen', async ({ page }) => {
  await page.goto('/tests/r3g/released-matching-review-harness.html?mode=correct'); await page.reload();
  await expect(page.getByRole('list').nth(0).getByRole('listitem')).toHaveText(['Detect objects in an image → Azure AI Vision', 'Extract text from a document → Document Intelligence']);
  await expect(page.getByText(opaqueIds)).toHaveCount(0);
});
test('withheld matching review exposes no answer content', async ({ page }) => {
  await page.goto('/tests/r3g/released-matching-review-harness.html?mode=withheld');
  await expect(page.getByRole('status')).toContainText('withheld');
  await expect(page.getByText(/Azure AI Vision|Document Intelligence|left-a|right-x/)).toHaveCount(0);
});
test('malformed matching IDs fail closed', async ({ page }) => {
  await page.goto('/tests/r3g/released-matching-review-harness.html?mode=malformed');
  await expect(page.getByText('Answer details unavailable')).toHaveCount(1);
  await expect(page.getByText(opaqueIds)).toHaveCount(0);
});
