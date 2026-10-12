import { expect, test } from '@playwright/test';

test('Security+ released PBQ renders readable learner and correct selections', async ({ page }) => {
  await page.goto('/tests/r3g/issue155-released-pbq-review-harness.html?mode=security');
  const lists = page.getByRole('list');
  await expect(lists).toHaveCount(2);
  await expect(lists.nth(0).getByRole('listitem')).toHaveText(['Server A → Deny traffic']);
  await expect(lists.nth(1).getByRole('listitem')).toHaveText(['Server A → Allow HTTPS']);
  await expect(page.getByText(/security-server|security-allow|security-deny|expectedMap|strategy/)).toHaveCount(0);
  await expect(page.getByText('Answer details unavailable')).toHaveCount(0);
});

test('AZ-400 workspace PBQ resolves decision prompts and option labels', async ({ page }) => {
  await page.goto('/tests/r3g/issue155-released-pbq-review-harness.html?mode=az400');
  const lists = page.getByRole('list');
  await expect(lists).toHaveCount(2);
  await expect(lists.nth(0).getByRole('listitem')).toHaveText(['Deployment environment → Staging']);
  await expect(lists.nth(1).getByRole('listitem')).toHaveText(['Deployment environment → Production']);
  await expect(page.getByText(/workspace-environment|workspace-production|workspace-staging|expectedMap|strategy/)).toHaveCount(0);
  await expect(page.getByText('Answer details unavailable')).toHaveCount(0);
});

test('unknown PBQ IDs and scoring shapes fail closed without leaking values', async ({ page }) => {
  await page.goto('/tests/r3g/issue155-released-pbq-review-harness.html?mode=malformed');
  await expect(page.getByText('Answer details unavailable')).toHaveCount(2);
  await expect(page.getByText(/private-option-id|future-private-strategy|target-a|safe-a/)).toHaveCount(0);
});

test('empty learner response stays distinct from missing correct answer', async ({ page }) => {
  await page.goto('/tests/r3g/issue155-released-pbq-review-harness.html?mode=empty');
  await expect(page.getByText('No response recorded')).toHaveCount(1);
  await expect(page.getByText('Answer details unavailable')).toHaveCount(1);
  await expect(page.getByText(/evidence-a|select-a/)).toHaveCount(0);
});

test('sanitized exact-whole-state answers render unavailable without raw state', async ({ page }) => {
  await page.goto('/tests/r3g/issue155-released-pbq-review-harness.html?mode=wholeState');
  const answers = page.locator('dd');
  await expect(answers).toHaveText(['Answer details unavailable', 'Answer details unavailable']);
  await expect(page.getByText('No response recorded')).toHaveCount(0);
  await expect(page.getByText(/ready|true|displayUnavailable|exact-whole-state/)).toHaveCount(0);
});

test('live command-label collision prefers the explicit label and preserves an empty learner response', async ({ page }) => {
  await page.goto('/tests/r3g/issue155-released-pbq-review-harness.html?mode=commandCollision');
  await expect(page.getByText('No response recorded')).toHaveCount(1);
  await expect(page.getByText('Containment action')).toHaveCount(1);
  await expect(page.getByText('Isolate host')).toHaveCount(1);
  await expect(page.getByText('Inspect server configuration', { exact: true })).toHaveCount(1);
  await expect(page.getByText('inspect server', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Answer details unavailable')).toHaveCount(0);
});

test('different explicit labels for one command identity remain unavailable', async ({ page }) => {
  await page.goto('/tests/r3g/issue155-released-pbq-review-harness.html?mode=ambiguousCommand');
  await expect(page.getByText('Answer details unavailable')).toHaveCount(2);
  await expect(page.getByText(/Inspect server|Review server policy|ambiguous-action|ambiguous-isolate/)).toHaveCount(0);
});
