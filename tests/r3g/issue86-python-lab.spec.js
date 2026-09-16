import { expect, test } from '@playwright/test';

test('starter workspace saves edited source and reports the disabled executor without fake output', async ({ page }) => {
  await page.goto('/tests/r3g/issue86-python-lab-harness.html?mode=starter');
  await expect(page.getByRole('heading', { name: 'Complete the browser-fixture Python task.' })).toBeVisible();
  const editor = page.getByLabel(/Python source.*main\.py/);
  await expect(editor).toHaveValue('print("starter")\n');
  await editor.fill('print("learner edit")\n');
  await expect(page.getByRole('status').filter({ hasText: 'Unsaved changes' })).toBeVisible();

  await page.getByRole('button', { name: 'Save code' }).click();
  await expect(page.getByText('Revision 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByText('Python execution is not available yet. Your saved workspace is retained.')).toBeVisible();
  await expect(page.getByText('No execution result is available.')).toBeVisible();
  await expect(page.getByText(/stdout|stderr|provider execution|request digest/i)).toHaveCount(0);

  const calls = await page.evaluate(() => window.__issue86PythonLabCalls);
  expect(calls.map(({ method }) => method)).toEqual([
    'getPythonWorkspace', 'savePythonWorkspace', 'requestPythonRun',
  ]);
  expect(calls[1].args[2].files[0].content).toBe('print("learner edit")\n');
  expect(calls[2].args[2]).toBe(1);
});

test('server resume restores the exact latest revision and supports keyboard file selection', async ({ page }) => {
  await page.goto('/tests/r3g/issue86-python-lab-harness.html?mode=resume');
  await expect(page.getByText('Revision 4', { exact: true })).toBeVisible();
  await expect(page.getByLabel(/Python source.*main\.py/)).toHaveValue('print("restored")\n');

  const helper = page.getByRole('button', { name: /support\/helper\.py/ });
  await helper.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel(/Python source.*support\/helper\.py/)).toHaveValue('VALUE = 4\n');
});

test('revision conflict preserves local edits and requires an explicit recovery choice', async ({ page }) => {
  await page.goto('/tests/r3g/issue86-python-lab-harness.html?mode=conflict');
  const editor = page.getByLabel(/Python source.*main\.py/);
  await editor.fill('print("local")\n');
  await page.getByRole('button', { name: 'Save code' }).click();

  await expect(page.getByRole('heading', { name: 'A newer saved revision is available' })).toBeVisible();
  await expect(editor).toHaveValue('print("local")\n');
  await expect(page.getByRole('button', { name: 'Use server version' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep my edits' }).click();
  await expect(editor).toHaveValue('print("local")\n');
  await expect(page.getByText(/Revision 7.*Unsaved changes/)).toBeVisible();

  await page.getByRole('button', { name: 'Save code' }).click();
  await expect(page.getByText('Revision 8', { exact: true })).toBeVisible();
  const calls = await page.evaluate(() => window.__issue86PythonLabCalls);
  expect(calls.filter(({ method }) => method === 'savePythonWorkspace')).toHaveLength(2);
  expect(calls.at(-1).args[3]).toBe(7);
});

test('running state locks edits and terminal learner output is shown without internal data', async ({ page }) => {
  await page.goto('/tests/r3g/issue86-python-lab-harness.html?mode=output');
  const editor = page.getByLabel(/Python source.*main\.py/);
  await page.getByRole('button', { name: 'Run', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Running...' })).toBeDisabled();
  await expect(editor).toBeDisabled();
  await expect(page.getByLabel('Program output')).toContainText('learner stdout');
  await expect(page.getByLabel('Program output')).toContainText('learner stderr');
  await expect(page.getByText('failed', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('2', { exact: true })).toBeVisible();
  await expect(editor).toHaveValue('print("starter")\n');
  await expect(page.getByText(/provider execution|request digest|grading rule|hidden test/i)).toHaveCount(0);
});
