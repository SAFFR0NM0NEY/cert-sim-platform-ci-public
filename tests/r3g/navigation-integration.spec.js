import { test, expect } from '@playwright/test';
test('actual Header controls and popstate save before navigation and fail closed', async ({ page }) => {
  await page.goto('/tests/r3g/navigation-harness.html');
  for (const destination of ['Home','Browse Exams','Account','Privacy','Terms']) {
    await page.getByRole(destination === 'Privacy' || destination === 'Terms' ? 'link' : 'button', { name:destination, exact:true }).click();
    await expect(page.getByRole('heading',{name:destination})).toBeVisible();
  }
  await page.evaluate(()=>window.dispatchEvent(new PopStateEvent('popstate')));
  await expect(page.getByRole('heading',{name:'browser history'})).toBeVisible();
  await page.evaluate(()=>window.__failNextNavigation());
  await page.getByRole('button',{name:'Home',exact:true}).click();
  await expect(page.getByRole('heading',{name:'browser history'})).toBeVisible();
  const record = await page.evaluate(()=>window.__navigationRecorder);
  expect(record.saves).toEqual(['Home','Browse Exams','Account','Privacy','Terms','browser history','Home']);
  expect(record.navigations).toEqual(['Home','Browse Exams','Account','Privacy','Terms','browser history']);
  expect(record.submits).toBe(0); expect(record.starts).toBe(0);
});
