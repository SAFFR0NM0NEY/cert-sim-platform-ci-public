import {test,expect} from '@playwright/test';
for(const width of [1440,390])test(`protected question typography and neutral domain label ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});await page.goto('/tests/r3g/python-fidelity-harness.html?fixture=long-code');const prompt=page.locator('.question-card h3'),code=prompt.locator('.supplied-multiline-text');await expect(prompt).toHaveCSS('font-size','16px');await expect(prompt).toHaveCSS('font-weight','400');await expect(code).toHaveCSS('font-size','16px');await expect(code).toHaveCSS('font-weight','400');await expect(code).toHaveCSS('white-space','pre');expect(await code.textContent()).toBe(await page.evaluate(()=>window.fidelityFixture));await expect(page.locator('.domain-label')).toHaveText('Domain label unavailable');expect(await code.evaluate(e=>e.scrollWidth>e.clientWidth)).toBe(true);await code.focus();await page.keyboard.press('ArrowRight');await expect.poll(()=>code.evaluate(e=>e.scrollLeft)).toBeGreaterThan(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.evaluate(()=>document.documentElement.style.fontSize='200%');await expect(prompt).toHaveCSS('font-size','32px');await expect(code).toHaveCSS('font-size','32px');expect(await code.textContent()).toBe(await page.evaluate(()=>window.fidelityFixture));
 await page.goto('/tests/r3g/python-fidelity-harness.html?fixture=single&version=0.0.0');await expect(page.locator('.domain-label')).toHaveText('Domain label unavailable');await expect(page.locator('.question-card h3')).toHaveCSS('font-size','16px');
});

for (const width of [1440, 390]) for (const scale of ['100%', '200%']) for (const mode of ['completion', 'legacy-code', 'legacy-command']) {
 test(`structured code keyboard scroll ${mode} ${width}px ${scale}`, async ({page}) => {
  await page.setViewportSize({width,height:1000});
  await page.goto(`/tests/r3g/python-fidelity-harness.html?mode=${mode}`);
  await page.evaluate(scale => document.documentElement.style.fontSize = scale, scale);
  const block = page.locator('pre.code-block, pre.command-block');
  const original = await block.textContent();
  expect(await block.evaluate(e => e.scrollWidth > e.clientWidth)).toBe(true);
  // Reach the region through ordinary sequential keyboard navigation, never focus().
  for (let n = 0; n < 8 && !(await block.evaluate(e => e === document.activeElement)); n++) await page.keyboard.press('Tab');
  await expect(block).toBeFocused();
  await expect(block).toHaveCSS('outline-style', 'solid');
  const initial = await block.evaluate(e => e.scrollLeft);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => block.evaluate(e => e.scrollLeft)).toBeGreaterThan(initial);
  // Chromium keyboard scrolling animates. Do not reverse direction halfway
  // through the preceding key's animation and mistake its tail for a failure.
  let previous = -1, stableSamples = 0;
  await expect.poll(async () => {
   const position = await block.evaluate(e => e.scrollLeft);
   stableSamples = position === previous ? stableSamples + 1 : 0;
   previous = position;
   return stableSamples;
  }, {intervals: [50]}).toBeGreaterThanOrEqual(3);
  const right = await block.evaluate(e => e.scrollLeft);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => block.evaluate(e => e.scrollLeft)).toBeLessThan(right);
  await page.keyboard.press('Tab');
  await expect(block.locator('select')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  await expect(block).not.toBeFocused();
  expect(await block.textContent()).toBe(original);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
 });
}
