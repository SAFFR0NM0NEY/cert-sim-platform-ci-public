import { expect, test } from '@playwright/test';

const assignmentId = '15000000-0000-4000-8000-000000000001';

test('App preserves a syntactically valid assignment through dashboard and timed selection', async ({ page }) => {
  await page.goto(`/exams/az204?assignment=${assignmentId}`);
  await expect(page).toHaveURL(new RegExp(`/exams/az204\\?assignment=${assignmentId}$`));

  await page.getByRole('button', { name: 'Start Full' }).click();
  await expect(page).toHaveURL(new RegExp(`/exams/az204/[^?]+\\?assignment=${assignmentId}$`));
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`\\?assignment=${assignmentId}$`));
});

test('ordinary Browse Exams navigation clears assignment context', async ({ page }) => {
  await page.goto(`/exams/az204?assignment=${assignmentId}`);
  await page.getByRole('button', { name: /Browse Exams/i }).first().click();
  await expect(page).toHaveURL('/exams');
  await expect(page).not.toHaveURL(/assignment=/);
});

test('malformed assignment query is discarded rather than forwarded', async ({ page }) => {
  await page.goto('/exams/az204?assignment=not-a-uuid');
  await expect(page).toHaveURL('/exams/az204');
});
