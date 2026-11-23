import {test,expect} from '@playwright/test';
for(const width of [1440,390])for(const scale of ['100%','200%'])for(const response of ['single','multi']){
 test(`protected unbroken option ${response} ${width}px ${scale}`,async({page})=>{
  await page.setViewportSize({width,height:1000});
  await page.goto(`/tests/r3g/python-fidelity-harness.html?fixture=unbroken-choice&response=${response}`);
  await page.evaluate(scale=>document.documentElement.style.fontSize=scale,scale);
  const choice=page.locator('.option-row > span').first();
  await expect(choice).toHaveText(await page.evaluate(()=>window.fidelityOption));
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const inputs=page.locator(`.option-row input[type=${response==='multi'?'checkbox':'radio'}]`);
  await inputs.nth(0).check();await expect(inputs.nth(0)).toBeChecked();
  if(response==='multi'){
   await inputs.nth(1).check();await inputs.nth(2).click();
   await expect(inputs.nth(1)).toBeChecked();await expect(inputs.nth(2)).not.toBeChecked();
  }
  expect(await choice.textContent()).toBe(await page.evaluate(()=>window.fidelityOption));
 });
}
