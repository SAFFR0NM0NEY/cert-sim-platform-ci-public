import { test, expect } from '@playwright/test';

test('Training Dashboard subordinate routes are direct, bookmarkable pages', async ({ page }) => {
  for (const route of [
    '/trainer/dashboard',
    '/trainer/dashboard/analytics',
    '/trainer/dashboard/assignments',
    '/trainer/dashboard/students',
    '/trainer/dashboard/results',
  ]) {
    await page.goto(route);
    await expect(page).toHaveURL(new RegExp(`${route.replaceAll('/', '\\/')}$`));
    await expect(page).toHaveTitle('Training Dashboard | CertSim Platform');
    await expect(page.getByRole('heading', { name: 'Training Dashboard', exact: true })).toBeVisible();
  }
});
