import {expect,test} from '@playwright/test';
import {replyLegacyCompletionContract} from './legacy-completion-contract.js';
for(const width of [1440,390]){
 test(`activated SC-100 browse search direct routes and signed-out setup (${width}px)`,async({page})=>{
 await page.setViewportSize({width,height:1000});const starts=[];page.on('request',r=>{if(r.method()==='POST'&&/\/attempts(?:\?|$)/.test(r.url()))starts.push(r.url())});
 await page.route('https://**/*',r=>r.abort());await page.goto('/exams');await page.getByLabel('Search exams').fill('SC-100');await expect(page.getByText('Showing 1 of 9 certification exams')).toBeVisible();
 await page.getByRole('button',{name:/SC-100.*Cybersecurity Architect/i}).click();await expect(page).toHaveURL('/exams/sc100');
 await expect(page.getByRole('heading',{name:'Full Simulation',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Compact Simulation',exact:true})).toBeVisible();await expect(page.getByText('Not yet available',{exact:true})).toHaveCount(0);
 await page.goto('/exams/sc100/full');await expect(page.getByRole('heading',{name:'Full Simulation',exact:true})).toBeVisible();await expect(page.getByText('Timer',{exact:true}).locator('..')).toContainText('100 min');
 await expect(page.getByRole('button',{name:'Start exam',exact:true})).toBeDisabled();await page.goto('/exams/sc100/compact');await expect(page.getByText('Timer',{exact:true}).locator('..')).toContainText('50 min');await expect(page.getByRole('button',{name:'Start exam',exact:true})).toBeDisabled();await page.goto('/exams/sc100/full');await page.reload();await expect(page).toHaveURL('/exams/sc100/full');await expect(page.getByText(/60-question structure/)).toHaveCount(0);expect(starts).toEqual([]);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 });
 test(`SC-100 saved history retains authoritative score and profile (${width}px)`,async({page})=>{
 await page.setViewportSize({width,height:1000});await page.route('**/functions/v1/**',async r=>{if(await replyLegacyCompletionContract(r))return;return r.fulfill({contentType:'application/json',body:JSON.stringify({items:[{attemptId:'synthetic-sc100-result',examKey:'sc100',profileKey:'sc100-full',packageVersion:'1.0.0',purpose:'self_directed_exam',completedAt:'2026-11-05T07:00:00Z',percentage:80,score:50,rawMaximum:62,questionCount:50,source:'protected',serverAuthoritative:true}],returnedCount:1,totalCount:1,remainingCount:0,nextCursor:null})})});
 await page.goto('/tests/r3g/exam-mode-fidelity-harness.html?view=history&exam=sc100');const row=page.locator('.saved-result-item').filter({hasText:'SC-100'});await expect(row).toHaveCount(1);await expect(row).toContainText('Full Simulation');await expect(row).toContainText('80%');await expect(page.getByRole('option',{name:'SC-100 — Microsoft Cybersecurity Architect'})).toHaveCount(1);
 });
}

for(const width of [1440,390])test(`SC-100 Compact saved history preserves server score ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:1000});
 await page.route('**/functions/v1/**',async r=>{if(await replyLegacyCompletionContract(r))return;return r.fulfill({contentType:'application/json',body:JSON.stringify({items:[{attemptId:'synthetic-sc100-compact-result',examKey:'sc100',profileKey:'sc100-compact',packageVersion:'1.1.0',purpose:'self_directed_exam',completedAt:'2026-11-11T07:00:00Z',percentage:24/31*100,score:24,rawMaximum:31,questionCount:25,source:'protected',serverAuthoritative:true}],returnedCount:1,totalCount:1,remainingCount:0,nextCursor:null})})});
 await page.goto('/tests/r3g/exam-mode-fidelity-harness.html?view=history&exam=sc100');const row=page.locator('.saved-result-item').filter({hasText:'SC-100'});await expect(row).toHaveCount(1);await expect(row).toContainText('Compact Simulation');await expect(row).toContainText('77');
});
