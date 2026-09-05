import { expect, test } from '@playwright/test';

const selectedExamStorageKey = 'certsim.selectedExam.v1';

async function expectAlignedActionCards(page) {
  const cards = page.locator('.home-action-card');
  await expect(cards).toHaveCount(4);

  const geometry = await cards.evaluateAll((elements) => elements.map((card) => {
    const cardRect = card.getBoundingClientRect();
    const headingRect = card.querySelector('h3').getBoundingClientRect();
    const bodyRect = card.querySelector('p').getBoundingClientRect();
    const contentRect = card.querySelector('.home-action-card-content').getBoundingClientRect();
    const actionRect = card.querySelector('.home-action-card-action').getBoundingClientRect();

    return {
      top: cardRect.top,
      height: cardRect.height,
      bottom: cardRect.bottom,
      headingTop: headingRect.top,
      bodyTop: bodyRect.top,
      contentBottom: contentRect.bottom,
      actionTop: actionRect.top,
      actionBottom: actionRect.bottom,
    };
  }));

  const spread = (values) => Math.max(...values) - Math.min(...values);
  expect(spread(geometry.map(({ top }) => top))).toBeLessThanOrEqual(1);
  expect(spread(geometry.map(({ height }) => height))).toBeLessThanOrEqual(1);
  expect(spread(geometry.map(({ headingTop }) => headingTop))).toBeLessThanOrEqual(1);
  expect(spread(geometry.map(({ bodyTop }) => bodyTop))).toBeLessThanOrEqual(1);
  expect(spread(geometry.map(({ actionBottom }) => actionBottom))).toBeLessThanOrEqual(1);

  for (const item of geometry) {
    expect(item.actionTop).toBeGreaterThanOrEqual(item.contentBottom);
    expect(item.actionBottom).toBeLessThanOrEqual(item.bottom);
  }
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
});

test('neutral Home keeps four equal cards with aligned actions', async ({ page }) => {
  await page.addInitScript((key) => localStorage.removeItem(key), selectedExamStorageKey);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Certification Exam Simulator' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose an Exam' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose Exam First' })).toBeVisible();
  await expectAlignedActionCards(page);
});

test('stored exam badge and Continue action preserve card alignment', async ({ page }) => {
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: selectedExamStorageKey,
    value: 'ai901',
  });
  await page.goto('/');

  await expect(page.getByRole('button', { name: 'Continue Azure AI Fundamentals' })).toBeVisible();
  await expect(page.locator('.home-action-card').nth(1).locator('.status-badge')).toBeVisible();
  await expectAlignedActionCards(page);
});

test('cards stay aligned at the second desktop baseline and wrap safely on narrow screens', async ({ page }) => {
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: selectedExamStorageKey,
    value: 'ai901',
  });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  await expectAlignedActionCards(page);
  await page.screenshot({ path: 'test-results/issue74-home-final.png', fullPage: true });

  await page.setViewportSize({ width: 760, height: 1000 });
  await expect(page.locator('.home-action-card')).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('button', { name: 'Choose Exam First' })).toBeVisible();
});
