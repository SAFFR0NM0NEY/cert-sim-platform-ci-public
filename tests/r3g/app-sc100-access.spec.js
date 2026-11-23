import {expect,test} from '@playwright/test';
import {installIdentityAndProtectedRoutes} from './sc100-access-fixture.js';
for(const width of [1440,390])for(const status of [200,403,503])test(`SC-100 server availability ${status} controls setup at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});
 const evidence=await installIdentityAndProtectedRoutes(page,{id:'84000000-0000-4000-8000-000000000001',role:'student',availabilityStatus:status,selectedCount:50});
 if(status===503)await page.route('**/practice/availability?*',r=>r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'service_unavailable'}})}));
 await page.goto('/exams/sc100/full');

 if(status===200){await expect(page.getByRole('button',{name:'Start exam',exact:true})).toBeEnabled();await expect.poll(()=>evidence.availability?.profileId).toBe('sc100-full');await expect(page.getByText('Timer',{exact:true}).locator('..')).toContainText('100 min');}
 else {if(status===503)await expect(page.getByText('The protected exam request failed.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Start exam',exact:true})).toHaveCount(0);if(status===403)await expect(page.getByText('This protected exam requires an active assignment or entitlement.')).toBeVisible();}
 expect(evidence.attemptPosts).toBe(0);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

// Routed UI proof consumes server decisions; group authorization itself is
// asserted by test-protected-access-history-integration.mjs in disposable DB.
for (const [scenario, role, status] of [
 ['entitled-group', 'student', 200],
 ['unrelated-group', 'student', 403],
 ['inactive-membership', 'student', 403],
 ['owner', 'platform_owner', 200],
 ['staff-without-exam-access', 'trainer', 403],
]) test(`shared access decision: ${scenario}`, async ({ page }) => {
 const evidence = await installIdentityAndProtectedRoutes(page, {
  id: '84000000-0000-4000-8000-000000000001', role,
  availabilityStatus: status, selectedCount: 50,
 });
 await page.goto('/exams/sc100/full');
 if (status === 200) {
  await expect(page.getByRole('button', {name: 'Start exam', exact: true})).toBeEnabled();
  await expect(page.getByText('Timer', {exact: true}).locator('..')).toContainText('100 min');
 } else {
  await expect(page.getByRole('button', {name: 'Start exam', exact: true})).toHaveCount(0);
  await expect(page.getByText('This protected exam requires an active assignment or entitlement.')).toBeVisible();
 }
 expect(evidence.attemptPosts).toBe(0);
});

for(const width of [1440,390]) for(const status of [200,403,503]) test(`SC-100 Compact server availability ${status} at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});
 const evidence=await installIdentityAndProtectedRoutes(page,{id:'84000000-0000-4000-8000-000000000001',role:'student',availabilityStatus:status,selectedCount:25,packageVersion:'1.1.0',timeLimitMinutes:50});
 if(status===503)await page.route('**/practice/availability?*',r=>r.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'service_unavailable'}})}));
 await page.goto('/exams/sc100/compact');
 await expect(page.getByRole('heading',{name:'Compact Simulation',exact:true})).toBeVisible();
 if(status===200){await expect(page.getByRole('button',{name:'Start exam',exact:true})).toBeEnabled();await expect.poll(()=>evidence.availability?.profileId).toBe('sc100-compact');await expect(page.getByText('Timer',{exact:true}).locator('..')).toContainText('50 min');await page.reload();await expect(page.getByRole('button',{name:'Start exam',exact:true})).toBeEnabled();}
 else {await expect(page.getByRole('button',{name:'Start exam',exact:true})).toHaveCount(0);if(status===403)await expect(page.getByText('This protected exam requires an active assignment or entitlement.')).toBeVisible();}
 expect(evidence.attemptPosts).toBe(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
