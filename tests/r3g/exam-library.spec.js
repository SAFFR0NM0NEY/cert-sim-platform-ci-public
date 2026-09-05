import { expect, test } from '@playwright/test';

const cards = (page) => page.locator('.exam-selector-card');
const count = (page) => page.locator('.exam-library-count');
const cardByCode = (page, code) => cards(page).filter({
  has: page.locator('.exam-selector-code', { hasText: code }),
});

test.beforeEach(async ({ page }) => {
  await page.goto('/exams');
  await expect(page.getByRole('heading', { name: 'Exam Library' })).toBeVisible();
});

test('search, filters, sorting, count, reset, and guidance separation compose', async ({ page }) => {
  await expect(cards(page)).toHaveCount(4);
  await expect(count(page)).toContainText('Showing 4 of 4 certification exams');
  await expect(page.getByRole('heading', { name: 'IT Direction Assessment' })).toBeVisible();

  const search = page.getByLabel('Search exams');
  await search.fill('  ai 901  ');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first().locator('.exam-selector-code')).toHaveText('AI-901');
  await expect(cards(page).first().locator('.exam-selector-title')).toHaveText('Azure AI Fundamentals');
  await expect(count(page)).toContainText('Showing 1 of 4 certification exams');

  await page.getByLabel('Vendor').selectOption('CompTIA');
  await expect(cards(page)).toHaveCount(0);
  await expect(count(page)).toContainText('Showing 0 of 4 certification exams');
  await expect(page.getByRole('heading', { name: 'No certification exams match' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'IT Direction Assessment' })).toBeVisible();

  await page.getByRole('button', { name: 'Reset search and filters' }).click();
  await expect(search).toHaveValue('');
  await expect(page.getByLabel('Vendor')).toHaveValue('all');
  await expect(page.getByLabel('Status')).toHaveValue('all');
  await expect(page.getByLabel('Sort by')).toHaveValue('recommended');
  await expect(cards(page)).toHaveCount(4);
  await expect(count(page)).toContainText('Showing 4 of 4 certification exams');

  await page.getByLabel('Vendor').selectOption('Microsoft');
  await page.getByLabel('Status').selectOption('controlledBeta');
  await page.getByLabel('Sort by').selectOption('name');
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).nth(0)).toContainText('AZ-400');
  await expect(cards(page).nth(1).locator('.exam-selector-code')).toHaveText('AI-901');
  await expect(cards(page).nth(1).locator('.exam-selector-title')).toHaveText('Azure AI Fundamentals');
});

test('cards render canonical code, short title, and vendor as separate fields', async ({ page }) => {
  const expected = [
    ['AZ-204', 'Developing Solutions for Microsoft Azure', 'Microsoft'],
    ['SY0-701', 'Security+', 'CompTIA'],
    ['AZ-400', 'Designing and Implementing Microsoft DevOps Solutions', 'Microsoft'],
    ['AI-901', 'Azure AI Fundamentals', 'Microsoft'],
  ];

  for (const [code, shortTitle, vendor] of expected) {
    const card = cardByCode(page, code);
    await expect(card).toHaveCount(1);
    await expect(card.locator('.exam-selector-code')).toHaveText(code);
    await expect(card.locator('.exam-selector-title')).toHaveText(shortTitle);
    await expect(card.locator('.exam-selector-vendor')).toHaveText(vendor);
  }

  await expect(cardByCode(page, 'AI-901').locator('.exam-selector-title')).not.toHaveText('Microsoft Azure AI Fundamentals');
  await expect(cardByCode(page, 'SY0-701').locator('.exam-selector-title')).not.toHaveText('CompTIA Security+ (SY0-701)');
  await expect(page.locator('.exam-selector-grid')).not.toContainText('security-plus-sy0-701');
  await expect(page.locator('.exam-selector-grid')).not.toContainText('securityplussy0701');
});

test('filtered selection and browser history preserve explicit navigation', async ({ page }) => {
  await page.getByLabel('Search exams').fill('AI-901');
  await cards(page).first().click();
  await expect(page).toHaveURL('/exams/ai901');
  await expect(page.getByRole('button', { name: 'Back to Exam Library' })).toBeVisible();

  await page.getByRole('button', { name: 'Back to Exam Library' }).click();
  await expect(page).toHaveURL('/exams');
  await expect(cards(page)).toHaveCount(4);

  await page.getByLabel('Search exams').fill('Security+');
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first().locator('.exam-selector-code')).toHaveText('SY0-701');
  await expect(cards(page).first().locator('.exam-selector-title')).toHaveText('Security+');
  await cards(page).first().click();
  await expect(page).toHaveURL('/exams/security-plus');
  await page.goBack();
  await expect(page).toHaveURL('/exams');
  await expect(page.getByRole('heading', { name: 'Exam Library' })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL('/exams/security-plus');

  await page.goto('/exams');
  await page.reload();
  await expect(page).toHaveURL('/exams');
  await expect(page.getByRole('heading', { name: 'Exam Library' })).toBeVisible();
});
