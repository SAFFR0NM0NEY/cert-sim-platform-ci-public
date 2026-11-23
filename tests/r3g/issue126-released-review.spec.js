import { expect, test } from '@playwright/test';

test('reorder review renders learner and correct order as readable ordered lists', async ({ page }) => {
  await page.goto('/tests/r3g/issue126-released-review-harness.html?mode=reorder');
  const lists = page.getByRole('list');
  await expect(lists).toHaveCount(2);
  await expect(lists.nth(0).getByRole('listitem')).toHaveText(['Step B', 'Step A']);
  await expect(lists.nth(1).getByRole('listitem')).toHaveText(['Step A', 'Step B']);
  await expect(page.getByText(/step-a|step-b|correctOrder|answer:/)).toHaveCount(0);
});

test('legacy dropdown review maps positional scoring and both option schemas', async ({ page }) => {
  await page.goto('/tests/r3g/issue126-released-review-harness.html?mode=dropdown');
  const lists = page.getByRole('list');
  await expect(lists).toHaveCount(2);
  await expect(lists.nth(0).getByRole('listitem')).toHaveText(['Blank One → beta', 'Blank 2 → Option One']);
  await expect(lists.nth(1).getByRole('listitem')).toHaveText(['Blank One → alpha', 'Blank 2 → Option Two']);
  await expect(page.getByText(/blank-a|blank-b|option-a|option-b|correctAnswer/)).toHaveCount(0);
});

test('dropdown-command review uses the same safe readable mapping', async ({ page }) => {
  await page.goto('/tests/r3g/issue126-released-review-harness.html?mode=command');
  await expect(page.getByRole('list').nth(0).getByRole('listitem')).toHaveText(['Command argument → --safe']);
  await expect(page.getByRole('list').nth(1).getByRole('listitem')).toHaveText(['Command argument → --review']);
  await expect(page.getByText(/blank-a|option-a|option-b|correctOptionIdsByBlank/)).toHaveCount(0);
});

test('unknown structured identifiers fail closed', async ({ page }) => {
  await page.goto('/tests/r3g/issue126-released-review-harness.html?mode=malformed');
  await expect(page.getByText('Answer details unavailable')).toHaveCount(1);
  await expect(page.getByText(/private-unknown/)).toHaveCount(0);
});

test('informational items use the no-response convention', async ({ page }) => {
  await page.goto('/tests/r3g/issue126-released-review-harness.html?mode=informational');
  await expect(page.getByText('No response recorded')).toHaveCount(2);
  await expect(page.getByText('Answer details unavailable')).toHaveCount(0);
});

test('unsupported authoritative type with a string fails closed', async ({ page }) => {
  await page.goto('/tests/r3g/issue126-released-review-harness.html?mode=unsupportedString');
  await expect(page.getByText('Answer details unavailable')).toHaveCount(2);
  await expect(page.getByText('opaque-private-id')).toHaveCount(0);
});

test('unsupported authoritative type with an array fails closed', async ({ page }) => {
  await page.goto('/tests/r3g/issue126-released-review-harness.html?mode=unsupportedArray');
  await expect(page.getByText('Answer details unavailable')).toHaveCount(2);
  await expect(page.getByText(/opaque-a|opaque-b/)).toHaveCount(0);
});

test('unsupported authoritative type with an object remains fail closed', async ({ page }) => {
  await page.goto('/tests/r3g/issue126-released-review-harness.html?mode=unsupportedObject');
  await expect(page.getByText('Answer details unavailable')).toHaveCount(2);
  await expect(page.getByText('opaque-private-id')).toHaveCount(0);
});

test('supported single-choice still resolves readable option text', async ({ page }) => {
  await page.goto('/tests/r3g/issue126-released-review-harness.html?mode=choice');
  await expect(page.getByRole('list').nth(0).getByRole('listitem')).toHaveText(['Readable answer']);
  await expect(page.getByRole('list').nth(1).getByRole('listitem')).toHaveText(['Other answer']);
  await expect(page.getByText(/option-a|option-b/)).toHaveCount(0);
});
