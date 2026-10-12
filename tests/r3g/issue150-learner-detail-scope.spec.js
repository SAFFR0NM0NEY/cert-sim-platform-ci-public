import { test, expect } from '@playwright/test';

const membershipId = '15000000-0000-0000-0000-000000000210';

test('learner detail route is bookmarkable and preserves staff scope context', async ({ page }) => {
  const route = `/trainer/students/${membershipId}?organisation=15000000-0000-0000-0000-000000000100&campus=15000000-0000-0000-0000-000000000110&group=15000000-0000-0000-0000-000000000120&readiness=ready&q=learner&return=students`;
  await page.goto(route);
  await expect(page).toHaveURL(new RegExp(`/trainer/students/${membershipId}\\?`));
  await expect(page).toHaveURL(/organisation=15000000-0000-0000-0000-000000000100/);
  await expect(page).toHaveURL(/group=15000000-0000-0000-0000-000000000120/);
  await expect(page).toHaveURL(/return=students/);
  await expect(page.getByRole('heading', { name: 'Student Progress Detail', exact: true })).toBeVisible();
});
