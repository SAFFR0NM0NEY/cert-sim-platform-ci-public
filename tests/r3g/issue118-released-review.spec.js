import { expect, test } from '@playwright/test';

const harness = '/tests/r3g/issue118-released-review-harness.html';

test('Saved Results exposes only released review and requests the exact historical attempt', async ({ page }) => {
  await page.goto(`${harness}?mode=saved-released`);
  await expect(page.getByRole('heading', { name: 'Result summary' })).toBeVisible();
  await page.getByRole('button', { name: 'View released review' }).click();
  await expect(page.getByRole('heading', { name: 'Released question review' })).toBeVisible();
  expect(await page.evaluate(() => window.issue118Fixture.getReviewAttemptIds)).toEqual(['attempt-118-exact-fixture']);
  expect(await page.evaluate(() => window.issue118Fixture.mutations)).toBe(0);
  await page.getByRole('button', { name: 'Return to result summary' }).click();
  await expect(page.getByRole('heading', { name: 'Result summary' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Saved Results' }).click();
  await expect(page.getByTestId('back-count')).toHaveText('1');
});

test('withheld Saved Result has no review action or frontend bypass', async ({ page }) => {
  await page.goto(`${harness}?mode=saved-withheld`);
  await expect(page.getByText('Review').locator('..').getByText('Withheld')).toBeVisible();
  await expect(page.getByRole('button', { name: 'View released review' })).toHaveCount(0);
  expect(await page.evaluate(() => window.issue118Fixture.getReviewAttemptIds)).toEqual([]);
});

test('released endpoint failure is safe and does not mutate an attempt', async ({ page }) => {
  await page.goto(`${harness}?mode=saved-error`);
  await page.getByRole('button', { name: 'View released review' }).click();
  await expect(page.getByRole('alert')).toHaveText('Released question review could not be loaded. Return to this result summary and try again.');
  await expect(page.getByText('private provider failure detail')).toHaveCount(0);
  expect(await page.evaluate(() => window.issue118Fixture.mutations)).toBe(0);
});

test('workspace renders one item, supports direct and sequential navigation, and hides internal IDs', async ({ page }) => {
  await page.goto(`${harness}?mode=workspace`);
  await expect(page.getByTestId('released-review-item')).toHaveCount(1);
  await expect(page.getByText('Question 1 of 90')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Question 1, Correct' })).toHaveAttribute('aria-current', 'step');

  const questionSix = page.getByRole('button', { name: 'Question 6, Correct' });
  await questionSix.click();
  await expect(page.getByText('Review the released Security+ configuration.')).toBeVisible();
  await expect(page.getByText('Server A → Deny traffic')).toBeVisible();
  await expect(page.getByText('Server A → Allow HTTPS')).toBeVisible();
  await expect(questionSix).toHaveAttribute('aria-current', 'step');

  await questionSix.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Question 7, Incorrect' })).toHaveAttribute('aria-current', 'step');
  await expect(page.getByText('Review the released AZ-400 workspace decision.')).toBeVisible();
  await page.getByRole('button', { name: 'Question 7, Incorrect' }).press('ArrowLeft');
  await expect(page.getByText('Review the released Security+ configuration.')).toBeVisible();

  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Review the released AZ-400 workspace decision.')).toBeVisible();
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.getByText('Review the released Security+ configuration.')).toBeVisible();

  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toContain('8f5e0da6-c3be-4aa1-b6c4-a49f00e52318');
  expect(bodyText).not.toContain('695416e6-a5e5-4a79-8ae6-13c462e827f0');
  expect(bodyText).not.toContain('security-private-server');

  const palette = page.getByTestId('released-review-palette');
  await expect(palette.getByRole('button')).toHaveCount(90);
  const bounds = await palette.evaluate((element) => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
  expect(bounds.clientHeight).toBeLessThanOrEqual(224);
  expect(bounds.scrollHeight).toBeGreaterThan(bounds.clientHeight);
});

test('workspace keeps executable, malformed, and informational review safe', async ({ page }) => {
  await page.goto(`${harness}?mode=workspace`);
  await page.getByRole('button', { name: 'Question 8, Correct' }).click();
  await expect(page.getByRole('heading', { name: 'Python coding task' })).toBeVisible();
  await expect(page.getByText('Your saved workspace was graded server-side.')).toBeVisible();

  await page.getByRole('button', { name: 'Question 9, Unanswered' }).click();
  await expect(page.getByText('Answer details unavailable')).toHaveCount(2);
  await expect(page.getByText(/unknown-private-option|known-private-target/)).toHaveCount(0);

  await page.getByRole('button', { name: 'Question 10, Context' }).click();
  await expect(page.getByText('Released case-study context')).toBeVisible();
  await expect(page.getByText('This is contextual material and is not a scored response.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your response' })).toHaveCount(0);

  const fallbackStatus = page.getByRole('button', { name: 'Question 11, Server Reviewed' });
  await fallbackStatus.click();
  await expect(fallbackStatus).toHaveClass(/recorded/);
  await expect(page.getByText('Server Reviewed', { exact: true })).toHaveCount(2);
});
