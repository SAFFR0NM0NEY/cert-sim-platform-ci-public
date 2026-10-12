import { test, expect } from '@playwright/test';

test('AI-901 dashboard and profile routes use current safe package metadata', async ({ page }) => {
  await page.goto('/exams/ai901');
  await expect(page.getByText('Question bank').locator('..')).toContainText('334 items');
  await page.goto('/exams/ai901/full');
  await expect(page).toHaveURL('/exams/ai901/full');
  await expect(page.getByText('Scored questions', { exact: true }).locator('..')).toContainText('50');
  await expect(page.getByText('Timer').locator('..')).toContainText('45 min');
  await page.goto('/exams/ai901/compact');
  await expect(page).toHaveURL('/exams/ai901/compact');
  await expect(page.getByText('Scored questions', { exact: true }).locator('..')).toContainText('25');
  await expect(page.getByText('Timer').locator('..')).toContainText('25 min');
});

test('SC-200 dashboard count remains on its accepted 1.1.0 metadata', async ({ page }) => {
  await page.goto('/exams/sc200');
  await expect(page.getByText('Question bank').locator('..')).toContainText('300 items');
});
