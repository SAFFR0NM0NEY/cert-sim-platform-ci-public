import { expect, test } from '@playwright/test';

test('real published presentation shape renders through the formal Lab workspace', async ({ page }) => {
  await page.goto('/tests/r3g/issue86-python-lab-harness.html?mode=real-shape');
  await page.getByRole('button', { name: 'Go to question 2' }).click();

  await expect(page.getByRole('heading', { name: 'Python coding task' })).toBeVisible();
  await expect(page.getByLabel('Lab instructions')).toContainText('learner-visible synthetic requirement');
  const editor = page.getByLabel(/Python source.*main\.py/);
  await expect(editor.locator('.cm-line')).toHaveText(['def synthetic_function():', '    return None', '']);
  await expect(page.getByTestId('python-code-editor').locator('.cm-editor')).toBeVisible();
  await expect(page.getByTestId('python-code-editor').locator('.cm-lineNumbers')).toBeVisible();
  expect(await editor.locator('.cm-line span').count()).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: 'Save code' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  await expect(page.getByText(/model solution|hidden test|grading rule|expected output|material digest/i)).toHaveCount(0);
});

test('reload resumes the same formal Lab attempt with the real presentation shape', async ({ page }) => {
  await page.goto('/tests/r3g/issue86-python-lab-harness.html?mode=real-shape-resume');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Go to question 2' }).click();

  const editor = page.getByLabel(/Python source.*main\.py/);
  await expect(editor.locator('.cm-line')).toHaveText(['def synthetic_function():', '    return None', '']);
  await editor.fill('print("saved before reload")\n');
  await page.getByRole('button', { name: 'Save code' }).click();
  await expect(page.getByText('Revision 1', { exact: true })).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Go to question 2' }).click();
  await expect(page.getByRole('heading', { name: 'Python coding task' })).toBeVisible();
  await expect(page.getByLabel(/Python source.*main\.py/)).toContainText('print("saved before reload")');
  await expect(page.getByText('Revision 1', { exact: true })).toBeVisible();
  const calls = await page.evaluate(() => window.__issue86PythonLabCalls);
  expect(calls.map(({ method }) => method)).toEqual(['getPythonWorkspace', 'getLatestPythonRun']);
});

test('starter workspace saves edited source and reports the disabled executor without fake output', async ({ page }) => {
  await page.goto('/tests/r3g/issue86-python-lab-harness.html?mode=starter');
  await expect(page.getByRole('heading', { name: 'Complete the browser-fixture Python task.' })).toBeVisible();
  const editor = page.getByLabel(/Python source.*main\.py/);
  await expect(editor).toContainText('print("starter")');
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
  await expect(page.getByLabel(/Python source.*main\.py/)).toContainText('print("restored")');

  const helper = page.getByRole('button', { name: /support\/helper\.py/ });
  await helper.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel(/Python source.*support\/helper\.py/)).toContainText('VALUE = 4');
});

test('revision conflict preserves local edits and requires an explicit recovery choice', async ({ page }) => {
  await page.goto('/tests/r3g/issue86-python-lab-harness.html?mode=conflict');
  const editor = page.getByLabel(/Python source.*main\.py/);
  await editor.fill('print("local")\n');
  await page.getByRole('button', { name: 'Save code' }).click();

  await expect(page.getByRole('heading', { name: 'A newer saved revision is available' })).toBeVisible();
  await expect(editor).toContainText('print("local")');
  await expect(page.getByRole('button', { name: 'Use server version' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep my edits' }).click();
  await expect(editor).toContainText('print("local")');
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
  await expect(editor).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByLabel('Program output')).toContainText('learner stdout');
  await expect(page.getByLabel('Program output')).toContainText('learner stderr');
  await expect(page.getByText('failed', { exact: true }).first()).toBeVisible();
  await expect(page.getByLabel('Execution status and result').getByText('2', { exact: true })).toBeVisible();
  await expect(editor).toContainText('print("starter")');
  await expect(page.getByText(/provider execution|request digest|grading rule|hidden test/i)).toHaveCount(0);
});

test('latest exact-revision run survives question navigation and full reload, then clears on a newer save', async ({ page }) => {
  const externalRequests = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4177/')) externalRequests.push(request.url());
  });
  await page.goto('/tests/r3g/issue86-python-lab-harness.html?mode=real-shape-run-restore');
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Go to question 2' }).click();
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Run result for Revision 1' })).toBeVisible();
  await expect(page.getByLabel('Program output')).toContainText('learner stdout');

  await page.getByRole('button', { name: 'Go to question 1' }).click();
  await page.getByRole('button', { name: 'Go to question 2' }).click();
  await expect(page.getByRole('heading', { name: 'Run result for Revision 1' })).toBeVisible();
  await expect(page.getByLabel('Program output')).toContainText('learner stdout');

  await page.reload();
  await page.getByRole('button', { name: 'Go to question 2' }).click();
  await expect(page.getByRole('heading', { name: 'Run result for Revision 1' })).toBeVisible();
  const editor = page.getByLabel(/Python source.*main\.py/);
  await editor.fill('print("new revision")\n');
  await page.getByRole('button', { name: 'Save code' }).click();
  await expect(page.getByText('Revision 2', { exact: true })).toBeVisible();
  await expect(page.getByText(/Current revision has not been run yet/)).toBeVisible();
  await expect(page.getByLabel('Program output')).toHaveCount(0);
  expect(externalRequests).toEqual([]);
});

test('released executable review shows safe result states without answer or grading disclosures', async ({ page }) => {
  await page.goto('/tests/r3g/issue86-python-lab-harness.html?mode=review');
  await expect(page.getByRole('heading', { name: 'Python coding task' })).toHaveCount(4);
  for (const status of ['Correct', 'Partial', 'Incorrect', 'Unanswered']) {
    await expect(page.getByText(status, { exact: true })).toBeVisible();
  }
  await expect(page.getByText('0 / 5', { exact: true })).toHaveCount(2);
  await expect(page.getByText(/Correct answer|Your response|model solution|hidden test|grading rule|workspace source/i)).toHaveCount(0);
  await expect(page.getByText(/safe-item-/i)).toHaveCount(0);
});
