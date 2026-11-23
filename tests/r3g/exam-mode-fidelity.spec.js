import {test,expect} from '@playwright/test';
import {replyLegacyCompletionContract} from './legacy-completion-contract.js';
import {readFile} from 'node:fs/promises';
test('AZ400 ordinary and sectioned full profiles remain distinct across dashboard setup history result and PDF',async({page})=>{
  await page.goto('/tests/r3g/exam-mode-fidelity-harness.html?view=dashboard&exam=az400');
  const cards=page.locator('.exam-mode-card');
  await expect(cards.filter({has:page.getByRole('heading',{name:'Full Simulation',exact:true})})).toHaveCount(1);
  const sectioned=cards.filter({has:page.getByRole('heading',{name:'Sectioned Full Simulation',exact:true})});
  await expect(sectioned).toHaveCount(1);
  await expect(sectioned.getByText('Scored items',{exact:true}).locator('..')).toContainText('80');
  await expect(sectioned.getByText('Timer',{exact:true}).locator('..')).toContainText('120 minutes');
  await expect(sectioned.getByText('PBQs',{exact:true}).locator('..')).toContainText('2');
  await expect(sectioned.getByText('Case studies',{exact:true}).locator('..')).toContainText('2');
  for(const [route,label] of [['full','Full Simulation'],['sectioned','Sectioned Full Simulation']]){
    await page.goto('/exams/az400/'+route);
    await expect(page.getByRole('heading',{name:label,exact:true})).toBeVisible();
    await expect(page.getByText('Timer',{exact:true}).locator('..')).toContainText('120 min');
  }
  const profiles=[['az400-mvp-full-profile','Full','Full Simulation'],['az400-sectioned-full-exam-profile','Sectioned','Sectioned Full Simulation']];
  await page.route('**/functions/v1/**',async r=>{
    if(await replyLegacyCompletionContract(r))return;
    const path=new URL(r.request().url()).pathname;
    if(path.endsWith('/print-summary')){
      const [key,name]=path.includes('sectioned-result')?profiles[1]:profiles[0];
      return r.fulfill({contentType:'application/json',body:JSON.stringify({exam:{key:'az400',version:'1.0.0'},profile:{key,name},purpose:'self_directed_exam',completedAt:'2026-10-29T10:00:00Z',score:80,rawMaximum:100,questionCount:80,percentage:80,passed:true,reviewStatus:'withheld',source:'protected',serverAuthoritative:true,domainSummary:{}})});
    }
    return r.fulfill({contentType:'application/json',body:JSON.stringify({items:profiles.map(([profileKey],i)=>({attemptId:i?'sectioned-result':'ordinary-result',examKey:'az400',profileKey,packageVersion:'1.0.0',purpose:'self_directed_exam',completedAt:'2026-10-29T10:00:00Z',percentage:80,score:80,source:'protected',serverAuthoritative:true})),returnedCount:2,totalCount:2,remainingCount:0,nextCursor:null})});
  });
  await page.goto('/tests/r3g/exam-mode-fidelity-harness.html?view=history&exam=az400');
  await expect(page.locator('.saved-result-item').filter({hasText:'Sectioned Full Simulation'})).toHaveCount(1);
  await expect(page.locator('.saved-result-item').filter({hasText:'Full Simulation'})).toHaveCount(2);
  for(const [i,[,,label]] of profiles.entries()){
    await page.goto('/tests/r3g/exam-mode-fidelity-harness.html?view=history&exam=az400&attempt='+(i?'sectioned-result':'ordinary-result'));
    await expect(page.getByText('Exam profile',{exact:true}).locator('..')).toHaveText('Exam profile'+label);
    const downloaded=page.waitForEvent('download',{timeout:10000});
    await page.getByRole('button',{name:'Download PDF',exact:true}).click();
    const pdf=(await readFile(await (await downloaded).path())).toString('latin1');
    expect(pdf).toContain('Profile: '+label);
    if(i)expect(pdf).not.toContain('(Profile: Full Simulation)');
  }
});
test('published signed-out setup uses shared simulation names without changing1.1.0 timers',async({page})=>{
  for(const [route,name,minutes] of [['full','Full Simulation',120],['compact','Compact Simulation',60]]){
    await page.goto('/exams/inf303/'+route);
    await expect(page.getByRole('heading',{name,exact:true})).toBeVisible();
    await expect(page.getByText('Timer',{exact:true}).locator('..')).toContainText(minutes+' min');
  }
});
test('all eight dashboards preserve published configurations and label Compact',async({page})=>{
  await mockActiveCatalogue(page, '1.1.0');
  for(const exam of ['inf303','sc200','az204','security-plus-sy0-701','az400','ai901','pythonnextgeneration','sc100']){
    await page.goto('/tests/r3g/exam-mode-fidelity-harness.html?view=dashboard&exam='+exam);
    await expect(page.getByRole('heading',{name:'Timed Attempts',exact:true})).toBeVisible();
    if(exam==='inf303'){
      await expect(page.getByText(/Current server configuration: 1.1.0/)).toBeVisible();
      const full=page.locator('.exam-mode-card').filter({has:page.getByRole('heading',{name:'Full Simulation',exact:true})});
      await expect(full).toContainText('40');await expect(full).toContainText('120 minutes');
      const compact=page.locator('.exam-mode-card').filter({has:page.getByRole('heading',{name:'Compact Simulation',exact:true})});
      await expect(compact).toContainText('20');await expect(compact).toContainText('60 minutes');await expect(compact).toContainText('shorter timed examination simulation');
    }
  }
});

test('future release dashboard supports existing authorized count-policy projection',async({page})=>{
  await mockActiveCatalogue(page, '1.3.0');
  await page.goto('/tests/r3g/exam-mode-fidelity-harness.html?view=dashboard&future=true');
  const full=page.locator('.exam-mode-card').filter({has:page.getByRole('heading',{name:'Full Simulation',exact:true})});
  await expect(full).toContainText('34 or 36');await expect(full).toContainText('45 minutes');
  await expect(full).not.toContainText('120 minutes');
  await expect(full).not.toContainText('36 standard questions');
  const compact=page.locator('.exam-mode-card').filter({has:page.getByRole('heading',{name:'Compact Simulation',exact:true})});
  await expect(compact).toContainText('25 minutes');
});

for(const count of [34,36])test('saved detail and PDF retain selected count/raw maximum '+count,async({page})=>{
  const maximum=count+17;
  await page.route('**/*',r=>['localhost','127.0.0.1'].includes(new URL(r.request().url()).hostname)?r.fallback():r.abort());
  await page.route('**/functions/v1/**/print-summary',r=>r.fulfill({contentType:'application/json',body:JSON.stringify({
    exam:{key:'inf303',version:'1.3.0'},profile:{key:'inf303-standard',name:'Full Simulation'},purpose:'self_directed_exam',
    completedAt:'2026-10-29T10:45:00Z',questionCount:count,answeredCount:count-1,score:maximum-2,rawMaximum:maximum,
    percentage:95,passed:true,reviewStatus:'withheld',serverAuthoritative:true,source:'protected',domainSummary:{},
  })}));
  await page.goto('/tests/r3g/exam-mode-fidelity-harness.html?view=history&attempt=synthetic-result');
  await expect(page.getByText('Full Simulation',{exact:true})).toBeVisible();
  await expect(page.getByText('Questions',{exact:true}).locator('..')).toContainText(String(count));
  await expect(page.getByText('Raw points',{exact:true}).locator('..')).toContainText(`${maximum-2} / ${maximum}`);
  const download=page.waitForEvent('download',{timeout:10000});await page.getByRole('button',{name:'Download PDF',exact:true}).click();
  const file=await download;
  expect(file.suggestedFilename()).toContain('CertSim-inf303-Saved-Result');
  const pdf=(await readFile(await file.path())).toString('latin1');
  expect(pdf).toContain('Questions: '+count);expect(pdf).toContain(`Raw points: ${maximum-2} / ${maximum}`);
});

test('Compact history displays simulation alongside unchanged formal classification',async({page})=>{
  await page.route('**/*',r=>['localhost','127.0.0.1'].includes(new URL(r.request().url()).hostname)?r.fallback():r.abort());
  await page.route('**/functions/v1/**',async r=>{
    if(await replyLegacyCompletionContract(r))return;
    return r.fulfill({contentType:'application/json',body:JSON.stringify({items:[{attemptId:'synthetic-compact',examKey:'inf303',profileKey:'inf303-compact',packageVersion:'1.1.0',purpose:'self_directed_exam',completedAt:'2026-10-29T10:45:00Z',percentage:80,score:40,source:'protected',serverAuthoritative:true}],returnedCount:1,totalCount:1,remainingCount:0,nextCursor:null})});
  });
  await page.goto('/tests/r3g/exam-mode-fidelity-harness.html?view=history');
  await expect(page.locator('.saved-result-item')).toContainText('Compact Simulation');
  await expect(page.locator('.saved-result-item')).toContainText('Exam attempt');
});
for(const [count,compact,version,minutes] of [[34,false,'1.3.0',45],[36,false,'1.3.0',45],[20,true,'1.3.0',25],[20,true,'1.1.0',60]])test('server profile setup, Start and Resume '+count+' '+version,async({page})=>{
  const key=compact?'inf303-compact':'inf303-standard';
  let active=false,starts=0,saved=false;
  const startedAt=new Date().toISOString(),expiresAt=new Date(Date.parse(startedAt)+minutes*60000).toISOString();
  const items=Array.from({length:count},(_,i)=>({itemId:'item-'+i,questionId:'synthetic-'+i,questionNumber:i+1,questionType:'single-choice',revision:i===0&&saved?1:0,response:null,presentation:{question:'Synthetic item '+(i+1),options:[{id:'a',text:'Synthetic choice'}]}}));
  const attempt={attemptId:'21400000-0000-4000-8000-000000000002',examKey:'inf303',packageVersion:version,profileKey:key,profileName:compact?'Compact':'Full Simulation',purpose:'self_directed_exam',startedAt,expiresAt,timed:true,
    ...(!compact?{countContract:{version:'certsim-authorised-form-count-v2',mode:'variable',exactCount:count,allowedCounts:[34,36],composition:{standardQuestionCount:count,caseStudyCount:0,caseStudyQuestionCount:0,pbqCount:0,executableCount:0},bindings:items.map(i=>({itemId:i.itemId,questionId:i.questionId,questionNumber:i.questionNumber,questionType:i.questionType}))}}:{})};
  await page.route('**/*',r=>['localhost','127.0.0.1'].includes(new URL(r.request().url()).hostname)?r.fallback():r.abort());
  await page.route('**/functions/v1/**',async r=>{
    if(await replyLegacyCompletionContract(r))return;
    const path=new URL(r.request().url()).pathname.split('/certsim-protected-exam')[1];
    const json=body=>r.fulfill({contentType:'application/json',body:JSON.stringify(body)});
    if(path==='/attempts/current-bindings')return json({candidates:active?[{...attempt,itemCount:count,selectedCount:count,replacementPermitted:false}]:[]});
    if(path==='/practice/availability')return json({examKey:'inf303',packageVersion:version,profileKey:key,purpose:'self_directed_exam',available:true,selectedCount:compact?20:36,timeLimitMinutes:minutes,timed:true,fixedProfileSize:true,profileComposition:{questionCount:compact?20:36,standardQuestionCount:compact?20:36,caseStudyCount:0,caseStudyQuestionCount:0,pbqCount:0},...(!compact?{countPolicy:{allowedCounts:[34,36]}}:{})});
    if(path==='/practice/sessions'){active=true;starts++;expect(r.request().postDataJSON().purpose).toBe('self_directed_exam');return json({attempt,items});}
    if(path?.endsWith('/flags'))return json({itemIds:[]});
    if(path?.endsWith('/response')){saved=true;return json({attemptId:attempt.attemptId,itemId:items[0].itemId,revision:1});}
    if(path==='/attempts/'+attempt.attemptId)return json({attempt,items:items.map((i,n)=>n===0&&saved?{...i,response:{answer:'a'},revision:1}:i)});
    return json({});
  });
  const url='/tests/r3g/exam-mode-fidelity-harness.html?profile='+key;
  await page.goto(url);
  if(!compact)await expect(page.getByText('34 or 36 — server assigned at Start',{exact:true})).toBeVisible();
  await expect(page.getByText(minutes+' min',{exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:compact?'Compact Simulation':'Full Simulation',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Start exam',exact:true}).click();
  await expect(page.locator('.profile-header-note')).toContainText(count+' scored questions');
  await expect(page.locator('.profile-header-note')).toContainText(minutes+' min');
  await expect(page.locator('.timer strong')).toHaveText(new RegExp('^'+(minutes-1)+':|^'+minutes+':00'));
  await page.getByRole('radio',{name:'Synthetic choice',exact:true}).check();await page.getByRole('button',{name:'Next',exact:true}).click();
  await expect.poll(()=>saved).toBe(true);await page.goto(url);
  await expect(page.getByRole('radio',{name:'Synthetic choice',exact:true})).toBeChecked();
  await expect(page.locator('.profile-header-note')).toContainText(count+' scored questions');
  await expect(page.locator('.profile-header-note')).toContainText(minutes+' min');expect(starts).toBe(1);
});

async function mockActiveCatalogue(page, version='1.1.0') {
  await page.route('**/functions/v1/**/practice/availability?**',async route=>{
    const url=new URL(route.request().url());expect(url.searchParams.get('includePbqs')).toBe('false');expect(url.searchParams.has('count')).toBe(false);const profileKey=url.searchParams.get('profileId'),full=profileKey==='inf303-standard';
    await route.fulfill({contentType:'application/json',body:JSON.stringify({examKey:'inf303',profileKey,packageVersion:version,purpose:'self_directed_exam',timed:true,fixedProfileSize:!(version==='1.3.0'&&full),selectedCount:full?(version==='1.1.0'?40:36):20,timeLimitMinutes:version==='1.1.0'?(full?120:60):(full?45:25),...(version==='1.3.0'&&full?{countPolicy:{allowedCounts:[34,36]}}:{})})});
  });
}
test('dashboard refresh observes activation and becomes neutral on denied reads',async({page})=>{
  let version='1.1.0',denied=false;
  await page.route('**/functions/v1/**',async route=>{
    const url=new URL(route.request().url());expect(url.searchParams.get('includePbqs')).toBe('false');expect(url.searchParams.has('count')).toBe(false);expect(route.request().method()).toBe('GET');
    if(denied)return route.fulfill({status:403,contentType:'application/json',body:'{}'});
    const profileKey=url.searchParams.get('profileId'),full=profileKey==='inf303-standard';
    return route.fulfill({contentType:'application/json',body:JSON.stringify({examKey:'inf303',profileKey,packageVersion:version,purpose:'self_directed_exam',timed:true,fixedProfileSize:!(version==='1.3.0'&&full),selectedCount:full?(version==='1.1.0'?40:36):20,timeLimitMinutes:version==='1.1.0'?(full?120:60):(full?45:25),...(version==='1.3.0'&&full?{countPolicy:{allowedCounts:[34,36]}}:{})})});
  });
  await page.goto('/tests/r3g/exam-mode-fidelity-harness.html?view=dashboard');
  await expect(page.getByText('Current server configuration: 1.1.0.')).toBeVisible();
  version='1.3.0';await page.getByRole('button',{name:'Refresh configuration'}).click();
  await expect(page.getByText('34 or 36',{exact:true})).toBeVisible();
  await expect(page.getByText('25 minutes',{exact:true})).toBeVisible();
  denied=true;await page.getByRole('button',{name:'Refresh configuration'}).click();
  await expect(page.getByText('Confirmed during setup',{exact:true})).toHaveCount(4);
  await expect(page.getByText(/Current server configuration:/)).toHaveCount(0);
});
test('signed out dashboard does not invent current catalogue or make reads',async({page})=>{
  let calls=0;await page.route('**/functions/v1/**',r=>{calls++;return r.abort();});
  await page.goto('/tests/r3g/exam-mode-fidelity-harness.html?view=dashboard&signedOut=true');
  await expect(page.getByText('Confirmed during setup',{exact:true})).toHaveCount(4);expect(calls).toBe(0);
});

test('real app home and Python dashboard render without runtime errors',async({page})=>{
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  for(const path of ['/','/exams/inf303']){
    await page.goto(path,{waitUntil:'networkidle'});
    await expect(page.locator('body')).not.toBeEmpty();
    expect(errors).toEqual([]);
  }
});
