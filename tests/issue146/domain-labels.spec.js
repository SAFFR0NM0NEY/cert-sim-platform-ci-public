import {test,expect} from '@playwright/test';
for(const view of ['learner','staff']) for(const width of [1440,390]) test(`${view} domain labels and unchanged metrics at ${width}px`,async({page})=>{
 const errors=[];page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});page.on('pageerror',error=>errors.push(error.message));
 await page.setViewportSize({width,height:1000});
 await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
 await page.goto(`/tests/issue146/index.html?view=${view}`);
 await expect(page.getByRole('heading',{name:view==='staff'?'Student Progress Detail':'My Progress',exact:true})).toBeVisible();
 await expect(page.getByText(/Develop Azure compute solutions/).first()).toBeVisible();
 await expect(page.getByText(/Domain label unavailable/).first()).toBeVisible();
 await expect(page.getByText(/AI Agents/).first()).toBeVisible();
 await expect(page.locator('body')).not.toContainText('develop-azure-compute-solutions');
 await expect(page.locator('body')).not.toContainText('domain-1');
 await expect(page.locator('body')).not.toContainText('ai-agents');
 await expect(page.locator('body')).toContainText('63%');
 await expect(page.locator('body')).toContainText('680');
 expect(errors).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
