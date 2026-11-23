import { test, expect } from '@playwright/test';

async function regionMetrics(region) {
  return region.evaluate(el => {
    const bounds = el.getBoundingClientRect();
    const container = el.closest('section, .option-row, .true-false-statement, .question-card, .released-review-card').getBoundingClientRect();
    return { viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, client: el.clientWidth, scroll: el.scrollWidth, left: bounds.left, right: bounds.right, containerLeft: container.left, containerRight: container.right, regionX: el.scrollLeft, windowX: window.scrollX };
  });
}

async function assertKeyboardScroll(page, region) {
  await region.focus();
  await expect(region).toBeFocused();
  expect(await region.evaluate(el => getComputedStyle(el).outlineStyle)).not.toBe('none');
  const initial = await regionMetrics(region);
  const beginning = await region.evaluate(el => {
    const r = document.createRange(); r.setStart(el.firstChild, 0); r.setEnd(el.firstChild, 1);
    return { text: r.getBoundingClientRect().left, viewport: el.getBoundingClientRect().left };
  });
  expect(beginning.text).toBeGreaterThanOrEqual(beginning.viewport - 1);
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await regionMetrics(region)).regionX).toBeGreaterThan(initial.regionX);
  await page.waitForTimeout(200);
  const forward = await regionMetrics(region);
  expect(forward.windowX).toBe(0);
  const max = forward.scroll - forward.client;
  const presses = Math.ceil(max / (forward.regionX - initial.regionX)) + 3;
  expect(presses).toBeLessThan(1000); // Finite fixture/work budget, not a polling loop.
  for (let i = 0; i < presses; i++) await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await regionMetrics(region)).regionX).toBeGreaterThanOrEqual(max - 1);
  const end = await region.evaluate(el => {
    const text = el.firstChild.textContent;
    let offset = 0, longest = { length: 0, index: 0 };
    for (const line of text.split('\n')) {
      if (line.length > longest.length) longest = { length: line.length, index: offset + line.search(/\s*$/) - 1 };
      offset += line.length + 1;
    }
    const r = document.createRange(); r.setStart(el.firstChild, longest.index); r.setEnd(el.firstChild, longest.index + 1);
    return { character: r.getBoundingClientRect().toJSON(), viewport: el.getBoundingClientRect().toJSON() };
  });
  expect(end.character.left).toBeGreaterThanOrEqual(end.viewport.left - 1);
  expect(end.character.right).toBeLessThanOrEqual(end.viewport.right + 1);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await regionMetrics(region)).regionX).toBeLessThan(max - 1);
  expect((await regionMetrics(region)).windowX).toBe(0);
  await page.keyboard.press('Tab');
  await expect(region).not.toBeFocused();
  console.log(JSON.stringify({ case: 'keyboard-content-access', viewport: initial.viewport, client: initial.client, scroll: initial.scroll, firstMove: forward.regionX, endReached: max, reversed: true, tabExited: true, windowX: 0 }));
}

async function assertBoundedText(page, region, original) {
  expect(await region.textContent()).toBe(original);
  const metric = await regionMetrics(region);
  expect(metric.document).toBeLessThanOrEqual(metric.viewport + 1);
  expect(metric.left).toBeGreaterThanOrEqual(metric.containerLeft - 1);
  expect(metric.right).toBeLessThanOrEqual(metric.containerRight + 1);
  for (const selector of ['html', 'body']) {
    expect(await page.locator(selector).evaluate(el => getComputedStyle(el).overflowX)).not.toMatch(/hidden|clip/);
  }
  if (metric.scroll > metric.client + 1) await assertKeyboardScroll(page, region);
}

async function assertReviewControls(page) {
  await expect(page.locator('.review-status').first()).toBeVisible();
  const badge = await page.locator('.review-status').first().boundingBox();
  expect(badge.x).toBeGreaterThanOrEqual(0);
  expect(badge.x + badge.width).toBeLessThanOrEqual(page.viewportSize().width + 1);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Second ordinary non-Python question.' })).toBeVisible();
  await page.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(page.locator('.released-review-palette-button').first()).toHaveAttribute('aria-current', 'step');
  await page.getByRole('button', { name: 'Return to result summary' }).click();
  await expect(page.getByRole('status')).toHaveText('Returned to result summary');
  expect(await page.evaluate(() => window.scrollX)).toBe(0);
}

for (const width of [390, 1440, 860, 861, 320]) {
  test(`review reproduction contains exact long multiline prose at ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1020 });
    await page.goto('/tests/r3g/python-fidelity-harness.html?mode=review&fixture=long-prose');
    const region = page.locator('.released-review-title-row .supplied-multiline-text');
    await expect(region).toBeVisible();
    const before = await regionMetrics(region);
    await region.focus();
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(200); // Allow the browser's native scroll animation to settle.
    const moved = await regionMetrics(region);
    console.log(JSON.stringify({ case: 'review-reproduction', width, before, moved }));
    await page.screenshot({ path: test.info().outputPath(`review-long-multiline-${width}.png`), fullPage: true });
    expect(before.document).toBeLessThanOrEqual(before.viewport + 1); // CSS pixel rounding only.
    expect(before.right).toBeLessThanOrEqual(before.containerRight + 1);
    expect(before.scroll).toBeGreaterThan(before.client);
    expect(moved.regionX).toBeGreaterThan(0);
    expect(moved.windowX).toBe(0);
    expect(await region.textContent()).toBe(await page.evaluate(() => window.fidelityFixture));
    // Start the complete keyboard sequence from the beginning using a real key.
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await regionMetrics(region)).regionX).toBe(0);
    await assertKeyboardScroll(page, region);
    await assertReviewControls(page);
  });
}

for (const width of [390, 1440]) {
  for (const [mode, fixture] of [['active','long-code'], ['active','token'], ['composite','long-code'], ['review','long-code'], ['review','token'], ['review','short'], ['active','single']]) {
    test(`bounded ${mode} ${fixture} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1020 });
      await page.goto(`/tests/r3g/python-fidelity-harness.html?mode=${mode}&fixture=${fixture}`);
      await expect(page.locator(mode === 'review' ? '.released-review-card' : '.question-card')).toBeVisible();
      const original = await page.evaluate(() => window.fidelityFixture);
      const regions = page.locator('.supplied-multiline-text');
      if (mode === 'review') {
        await expect(regions).toHaveCount(3); // Prompt, released learner answer and permitted correct answer.
        await expect(page.locator('.released-review-answer-grid')).not.toContainText('Answer details unavailable');
      }
      for (let i = 0; i < await regions.count(); i++) await assertBoundedText(page, regions.nth(i), original);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
      if (fixture === 'long-code') {
        const heading = page.locator(mode === 'review' ? '.released-review-title-row h3' : '.question-card h3');
        const geometry = await heading.evaluate(el => {
          const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
          const at = i => { const r = document.createRange(); r.setStart(node,i); r.setEnd(node,i+1); return r.getBoundingClientRect().toJSON(); };
          return { first: at(0), comment: at(node.textContent.indexOf('#')), loop: at(node.textContent.indexOf('for')), print: at(node.textContent.indexOf('print')) };
        });
        expect(geometry.comment.x).toBeGreaterThan(geometry.first.x);
        expect(geometry.loop.y).toBeGreaterThan(geometry.comment.y);
        expect(geometry.print.y - geometry.loop.y).toBeGreaterThan(geometry.loop.y - geometry.comment.y);
      }
      if (mode === 'review') await assertReviewControls(page);
      else {
        await page.getByRole('radio').first().press('Space');
        await expect(page.getByRole('radio').first()).toBeChecked();
      }
      await page.screenshot({ path: test.info().outputPath(`${mode}-${fixture}-${width}.png`), fullPage: true });
    });
  }
}

for (const mode of ['active', 'review']) {
  test(`supplied Python structure is visible in ${mode}`, async ({ page }) => {
    await page.goto(`/tests/r3g/python-fidelity-harness.html?mode=${mode}`);
    const heading = page.locator(mode === 'active' ? '.question-card h3' : '.released-review-card h3');
    const geometry = await heading.evaluate((el) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const node = walker.nextNode();
      const rect = (start) => { const r = document.createRange(); r.setStart(node, start); r.setEnd(node, start + 1); return r.getBoundingClientRect().toJSON(); };
      return { first: rect(0), comment: rect(node.textContent.indexOf('#')), loop: rect(node.textContent.indexOf('for')), print: rect(node.textContent.indexOf('print')), last: rect(node.textContent.indexOf('else')) };
    });
    expect(geometry.comment.y).toBeGreaterThan(geometry.first.y);
    expect(geometry.comment.x).toBeGreaterThan(geometry.first.x);
    expect(geometry.loop.x).toBeCloseTo(geometry.comment.x, 0);
    expect(geometry.print.y - geometry.loop.y).toBeGreaterThan(geometry.loop.y - geometry.comment.y);
    expect(geometry.last.y).toBeGreaterThan(geometry.print.y);
    const original = await page.evaluate(() => window.fidelityCode);
    expect(await heading.textContent()).toBe(original);
    const answer = page.locator(mode === 'active' ? '.option-row span' : '.released-answer-list li').first();
    await expect(answer).toHaveText(original);
    const answerGeometry = await answer.evaluate((el) => {
      const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
      const rect = start => { const r = document.createRange(); r.setStart(node,start); r.setEnd(node,start+1); return r.getBoundingClientRect().toJSON(); };
      return { first: rect(0), comment: rect(node.textContent.indexOf('#')) };
    });
    expect(answerGeometry.comment.y).toBeGreaterThan(answerGeometry.first.y);
    expect(answerGeometry.comment.x).toBeGreaterThan(answerGeometry.first.x);
    expect(await answer.evaluate((el) => getComputedStyle(el.querySelector('span') ?? el).whiteSpace)).toMatch(/pre|break-spaces/);
    await page.screenshot({ path: test.info().outputPath(`python-fidelity-${mode}.png`), fullPage: true });
  });
}

test('structured completion retains code and keyboard selection; prose stays ordinary', async ({ page }) => {
  await page.goto('/tests/r3g/python-fidelity-harness.html?mode=completion');
  const code = page.locator('pre code');
  expect(await code.textContent()).toContain('    if n > 0:\n\n\tprint(');
  const select = page.getByRole('combobox');
  await select.focus();
  await select.selectOption('n');
  await expect(select).toHaveValue('n');
  await expect(select).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('completion-mobile.png'), fullPage: true });
  await page.goto('/tests/r3g/python-fidelity-harness.html');
  const prose = page.getByText('Ordinary prose stays readable.');
  await expect(prose.locator('.supplied-multiline-text')).toHaveCount(0);
  await page.locator('.supplied-multiline-text').first().focus();
  await expect(page.locator('.supplied-multiline-text').first()).toBeFocused();
});

test('composite statement code keeps supplied line geometry', async ({ page }) => {
  await page.goto('/tests/r3g/python-fidelity-harness.html?mode=composite');
  const supplied = page.locator('.true-false-statement .supplied-multiline-text').first();
  expect(await supplied.textContent()).toBe(await page.evaluate(() => window.fidelityCode));
  const positions = await supplied.evaluate(el => {
    const node = el.firstChild;
    const at = i => { const r = document.createRange(); r.setStart(node,i); r.setEnd(node,i+1); return r.getBoundingClientRect().y; };
    return [at(0), at(node.textContent.indexOf('#'))];
  });
  expect(positions[1]).toBeGreaterThan(positions[0]);
  await page.getByRole('radio').first().check();
  await expect(page.getByRole('radio').first()).toBeChecked();
});
