import { expect, test } from '@playwright/test';

test('Browse Exams exposes the content-free Python Next Generation dashboard and profiles', async ({ page }) => {
  await page.goto('/exams');

  const search = page.getByLabel('Search exams');
  const pythonNextGenerationCard = page.getByRole('button', {
    name: /Python Python Next Generation Certiport/i,
  });
  await expect(pythonNextGenerationCard).toBeVisible();

  await search.fill('Python');
  await expect(page.getByText('Showing 2 of 7 certification exams')).toBeVisible();
  await expect(pythonNextGenerationCard).toBeVisible();

  await search.fill('Python Next Generation');
  await expect(page.getByText('Showing 1 of 7 certification exams')).toBeVisible();
  await expect(pythonNextGenerationCard).toBeVisible();

  await search.fill('Certiport');
  await expect(pythonNextGenerationCard).toBeVisible();
  await pythonNextGenerationCard.click();

  await expect(page).toHaveURL('/exams/python-next-generation');
  await expect(page.getByRole('heading', { name: 'Python Next Generation', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start No-Lab' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start Lab' })).toBeVisible();
  await expect(page.getByText('7', { exact: true })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL('/exams/python-next-generation');
  await expect(page.getByRole('button', { name: 'Start No-Lab' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start Lab' })).toBeVisible();
});
