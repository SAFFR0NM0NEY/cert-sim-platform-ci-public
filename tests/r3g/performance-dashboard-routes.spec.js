import { test, expect } from '@playwright/test';

test('Performance Dashboard subordinate routes are direct, bookmarkable pages', async ({ page }) => {
  for (const route of [
    '/trainer/dashboard',
    '/trainer/dashboard/analytics',
    '/trainer/dashboard/assignments',
    '/trainer/dashboard/students',
    '/trainer/dashboard/results',
  ]) {
    await page.goto(route);
    await expect(page).toHaveURL(new RegExp(`${route.replaceAll('/', '\\/')}$`));
    await expect(page.getByRole('heading', { name: 'Performance Dashboard', exact: true })).toBeVisible();
  }
});
