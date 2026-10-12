import { expect, test } from '@playwright/test';

const selectedExamStorageKey = 'certsim.selectedExam.v1';

async function controlStyles(locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      borderWidth: style.borderWidth,
      boxSizing: style.boxSizing,
      cursor: style.cursor,
      display: style.display,
      lineHeight: style.lineHeight,
      minHeight: style.minHeight,
      opacity: style.opacity,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      overflowWrap: style.overflowWrap,
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      paddingTop: style.paddingTop,
      whiteSpace: style.whiteSpace,
    };
  });
}

function expectSharedActionContract(styles) {
  expect(['flex', 'inline-flex']).toContain(styles.display);
  expect(styles).toMatchObject({
    borderRadius: '8px',
    borderWidth: '1px',
    boxSizing: 'border-box',
    minHeight: '44px',
    overflowWrap: 'anywhere',
    paddingLeft: '18px',
    paddingRight: '18px',
    paddingTop: '10px',
    whiteSpace: 'normal',
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
});

test('shared actions, navigation, disabled state, and keyboard focus retain their hierarchy', async ({ page }) => {
  await page.addInitScript((key) => localStorage.removeItem(key), selectedExamStorageKey);
  await page.goto('/');

  const primary = page.locator('.home-action-card').first().getByRole('button', { name: 'Browse Exams' });
  const secondary = page.getByRole('button', { name: 'Choose an Exam' });
  const activeNavigation = page.locator('.header-navigation-button[aria-current="page"]');
  expectSharedActionContract(await controlStyles(primary));
  expectSharedActionContract(await controlStyles(secondary));

  const activeStyles = await controlStyles(activeNavigation);
  const primaryRestingBackground = (await controlStyles(primary)).backgroundColor;
  const secondaryRestingBackground = (await controlStyles(secondary)).backgroundColor;
  expect(activeStyles.minHeight).toBe('44px');
  expect(activeStyles.borderWidth).toBe('1px');
  expect(activeStyles.borderRadius).toBe('8px');
  expect(activeStyles.backgroundColor).not.toBe(secondaryRestingBackground);

  await primary.hover();
  expect((await controlStyles(primary)).backgroundColor).not.toBe(primaryRestingBackground);
  await secondary.hover();
  expect((await controlStyles(secondary)).backgroundColor).not.toBe(secondaryRestingBackground);

  await primary.focus();
  const focused = await controlStyles(primary);
  expect(focused.outlineStyle).toBe('solid');
  expect(focused.outlineWidth).toBe('3px');
  await expect(page.getByRole('heading', { name: 'Certification Exam Simulator' })).toHaveCSS('outline-style', 'none');

  await page.screenshot({ path: 'test-results/issue76-home.png', fullPage: true });
  await page.goto('/exams');
  const reset = page.getByRole('button', { name: 'Reset search and filters' });
  const resetBeforeHover = await controlStyles(reset);
  expect(resetBeforeHover.opacity).toBe('0.55');
  expect(resetBeforeHover.cursor).toBe('not-allowed');
  await reset.hover({ force: true });
  expect((await controlStyles(reset)).backgroundColor).toBe(resetBeforeHover.backgroundColor);
  await page.screenshot({ path: 'test-results/issue76-exam-library.png', fullPage: true });

  await page.goto('/account');
  await expect(page.getByRole('heading', { name: 'Account' })).toBeVisible();
  expect((await controlStyles(page.locator('.header-navigation-button[aria-current="page"]'))).minHeight).toBe('44px');
  await page.screenshot({ path: 'test-results/issue76-account.png', fullPage: true });
});

test('long labels wrap safely and setup actions retain the shared minimum target', async ({ page }) => {
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: selectedExamStorageKey,
    value: 'ai901',
  });
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.goto('/');

  const continueButton = page.getByRole('button', { name: 'Continue Azure AI Fundamentals' });
  expect(await continueButton.evaluate((element) => ({
    contained: element.scrollWidth <= element.clientWidth,
    whiteSpace: getComputedStyle(element).whiteSpace,
  }))).toEqual({ contained: true, whiteSpace: 'normal' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.goto('/exams/ai901');
  const setupActions = page.locator('.primary-button:visible, .secondary-button:visible');
  expect(await setupActions.count()).toBeGreaterThan(0);
  for (const action of await setupActions.all()) {
    expect(Number.parseFloat((await controlStyles(action)).minHeight)).toBeGreaterThanOrEqual(44);
  }
});
