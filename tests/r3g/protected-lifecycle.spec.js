import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';

const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deadline = new Date(Date.now() + 120 * 60_000).toISOString();
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const option = [{ id: 'a', text: 'Option A' }, { id: 'b', text: 'Option B' }];
const makeItem = (index, type, section, questionNumber) => ({ itemId: `item-${index}`, questionId: `source-${index}`, questionNumber, questionType: type, domain: 'Sanitized domain', section, response: null, revision: 0, presentation: type === 'case-study-context' ? { title: `Case ${index}`, content: 'Sanitized case.', facts: [] } : type.startsWith('pbq-') ? { type, title: `Lab ${index}`, scenario: 'Sanitized.', instructions: ['Choose.'], tasks: { prompt: 'Choose.', answerOptions: option.map(({ id, text }) => ({ id, label: text })) }, safetyNote: 'Fixture.' } : { question: `Sanitized question ${index}`, options: option } });
const items = [makeItem(1,'case-study-context','case-1',null), ...Array.from({length:6},(_,i)=>makeItem(i+2,'single-choice','case-1',i+1)), makeItem(8,'case-study-context','case-2',null), ...Array.from({length:6},(_,i)=>makeItem(i+9,'single-choice','case-2',i+7)), ...Array.from({length:66},(_,i)=>makeItem(i+15,'single-choice','standard',i+13)), makeItem(81,'pbq-siem','pbq',79), makeItem(82,'pbq-workspace','pbq',80)];

test('routed protected runner recovers technical refresh, then abandons explicitly without a result', async ({ page }) => {
  const recorder = { starts: [], saves: [], flags: [], issues: [], submits: [], abandons: [], resumes: [], bindings: [], deadline };
  let active = false; let saved = null; let flagged = false;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request = route.request(); const url = new URL(request.url()); const routePath = url.pathname.split('/certsim-protected-exam')[1]; const method = request.method(); const body = request.postDataJSON?.() ?? null;
    const json = (value, status=200) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(value) });
    if (routePath.startsWith('/practice/availability')) return json({ examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', purpose:'self_directed_exam', available:true, selectedCount:80, adjustedCount:false, profileQuestionCount:80, timeLimitMinutes:120, fixedProfileSize:true, domainCounts:{}, missedCount:0, newCount:80, pbqCount:2, languages:['not_applicable'] });
    if (routePath.startsWith('/attempts/current-bindings')) { recorder.bindings.push(active); return json({ candidates: active ? [{ attemptId, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', purpose:'self_directed_exam', languagePreference:null, startedAt:'2026-09-02T10:00:00.000Z', expiresAt:deadline, replacementPermitted:true }] : [] }); }
    if (routePath === '/practice/sessions' && method === 'POST') { recorder.starts.push(body); active=true; return json({ attempt:{ attemptId, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', status:'in_progress', startedAt:'2026-09-02T10:00:00.000Z', expiresAt:deadline, timeLimitMinutes:120, purpose:'self_directed_exam', languagePreference:null }, items }, 201); }
    if (routePath === `/attempts/${attemptId}`) { recorder.resumes.push({ attemptId }); return json({ attempt:{ attemptId, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', status:'in_progress', startedAt:'2026-09-02T10:00:00.000Z', expiresAt:deadline, timeLimitMinutes:120, purpose:'self_directed_exam', languagePreference:null }, items:items.map((item)=>item.itemId==='item-15' ? {...item,response:saved?.response??null,revision:saved?.revision??0}:item) }); }
    if (routePath.endsWith('/flags') && method === 'GET') return json({ itemIds: flagged ? ['item-15'] : [] });
    if (routePath.includes('/response') && method === 'PUT') { saved={ response:body.response, revision:body.expectedRevision+1 }; recorder.saves.push({ itemId:'item-15', expectedRevision:body.expectedRevision, revision:saved.revision, response:body.response }); return json({ itemId:'item-15', revision:saved.revision, updatedAt:new Date().toISOString() }); }
    if (routePath.includes('/flag') && method === 'PUT') { flagged=body.flagged; recorder.flags.push({ itemId:'item-15', flagged }); return json({ itemId:'item-15', flagged, updatedAt:new Date().toISOString() }); }
    if (routePath.includes('/issue') && method === 'POST') { recorder.issues.push({ itemId:'item-15', received:Boolean(body.message) }); return json({ received:true }); }
    if (routePath === `/attempts/${attemptId}/abandon` && method === 'POST') { recorder.abandons.push(body); active=false; return json({ attemptId, status:'abandoned', abandonedAt:new Date().toISOString() }); }
    if (routePath.endsWith('/submit')) { recorder.submits.push(body); return json({}); }
    return json({ error:{ code:'unexpected_fixture_route' } },500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html');
  await page.getByRole('button', { name:/Start/ }).click();
  await expect(page.getByText(/119:/)).toBeVisible();
  await expect(page.getByRole('button', { name:'Go to question 13' })).toHaveText('13');
  await page.getByRole('button', { name:'Go to question 13' }).click();
  await expect(page.getByText('Standard Questions: Question 13 of 66')).toBeVisible();
  await page.locator('.question-card input[type="radio"]').first().check();
  await page.getByRole('button', { name:'Flag for review' }).click();
  await page.getByRole('button', { name:'Report question issue' }).click(); await page.getByLabel('What appears to be wrong?').fill('Sanitized issue'); await page.getByRole('button', { name:'Send report' }).click();
  await page.getByRole('button', { name:'Go to question 14' }).click();
  await page.reload();
  await expect(page.getByText(/119:/)).toBeVisible();
  await page.getByRole('button', { name:'Go to question 13' }).click();
  await expect(page.locator('.question-card input[type="radio"]').first()).toBeChecked();
  await expect(page.getByRole('button', { name:'Remove flag' })).toBeVisible();
  await expect(page.getByText(/119:/)).toBeVisible();
  const ledger = { startMutations:recorder.starts.length, attemptFingerprint:hash(attemptId), savedRevision:recorder.saves.at(-1)?.revision??null, expectedRevision:recorder.saves.at(-1)?.expectedRevision??null, submittedOnExit:recorder.submits.length, resumeOperations:recorder.resumes.length, resumedAttemptFingerprint:hash(recorder.resumes.at(-1)?.attemptId), responseRestored:await page.locator('.question-card input[type="radio"]').first().isChecked(), flagRestored:await page.getByRole('button',{name:'Remove flag'}).isVisible(), profileFingerprint:hash(recorder.starts[0]?.profileId), languageFingerprint:hash(recorder.starts[0]?.language ?? null), questionOrderFingerprint:hash(items.map((item)=>item.questionId)), optionOrderFingerprint:hash(items.map((item)=>item.presentation.options?.map((entry)=>entry.id)??[])), deadlineFingerprint:hash(deadline), secondStartMutations:Math.max(0,recorder.starts.length-1), flagMutations:recorder.flags.length, issueMutations:recorder.issues.length };
  expect(ledger).toMatchObject({startMutations:1,savedRevision:1,expectedRevision:0,submittedOnExit:0,resumeOperations:1,responseRestored:true,flagRestored:true,secondStartMutations:0,flagMutations:1,issueMutations:1});
  expect(recorder.starts[0]).not.toHaveProperty('language');
  expect(ledger.attemptFingerprint).toBe(ledger.resumedAttemptFingerprint);
  page.once('dialog',(dialog)=>dialog.accept());
  await page.getByRole('button', { name:'End attempt' }).click();
  await expect(page.getByRole('heading', { name:'Selected exam dashboard' })).toBeVisible();
  expect(recorder.abandons).toHaveLength(1);
  expect(recorder.submits).toHaveLength(0);
});

const az204Items = [
  ...Array.from({ length: 43 }, (_, index) => makeItem(index + 1, 'single-choice', 'standard', index + 1)),
  makeItem(44, 'case-study-context', 'az204-long-case', null),
  ...Array.from({ length: 7 }, (_, index) => makeItem(index + 45, 'single-choice', 'az204-long-case', index + 44)),
];
const az204Attempt = (id, language, assignmentId = null) => ({ attemptId:id, assignmentId, examKey:'az204', packageVersion:'1.1.0', profileKey:'standard-profile', profileName:'Standard', status:'in_progress', startedAt:'2026-09-02T12:00:00.000Z', expiresAt:deadline, timeLimitMinutes:120, purpose:'self_directed_exam', languagePreference:language });

test('untimed targeted practice uses authoritative setup semantics and refreshes domain availability', async ({ page }) => {
  const requests = [];
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.split('/certsim-protected-exam')[1];
    const json = (value) => route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(value) });
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates:[] });
    if (path.startsWith('/practice/availability')) {
      requests.push(Object.fromEntries(url.searchParams));
      return json({ examKey:'az204', packageVersion:'1.1.0', profileKey:'standard-profile', purpose:'targeted_domain', selectedCount:59, timed:false, timeLimitMinutes:null, adjustedCount:false });
    }
    return route.fulfill({ status:500, contentType:'application/json', body:JSON.stringify({ error:{ code:'unexpected_fixture_route' } }) });
  });
  await page.goto('/tests/r3g/protected-runner-harness.html?exam=az204&purpose=targeted_domain&domain=develop-azure-compute-solutions');
  await expect(page.getByRole('heading',{name:'Practice details'})).toBeVisible();
  await expect(page.getByText('Untimed',{exact:true})).toBeVisible();
  await expect(page.getByText('59',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Start practice'})).toBeEnabled();
  await expect(page.getByText(/original server timer continues/)).toHaveCount(0);
  await page.getByLabel('Practice domain').selectOption('Develop for Azure storage');
  await expect.poll(() => requests.at(-1)?.domain).toBe('develop-for-azure-storage');
});

test('explicit App assignment context reaches the protected start mutation unchanged', async ({ page }) => {
  const assignmentId = '15000000-0000-4000-8000-000000000001';
  const starts = [];
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/certsim-protected-exam')[1];
    const body = request.postDataJSON?.();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path.startsWith('/practice/availability')) {
      expect(new URL(request.url()).searchParams.get('assignmentId')).toBe(assignmentId);
      return json({ examKey:'az204', packageVersion:'1.1.0', profileKey:'standard-profile', purpose:'self_directed_exam', available:true, selectedCount:50, adjustedCount:false, profileQuestionCount:50, timeLimitMinutes:120, fixedProfileSize:true, domainCounts:{}, missedCount:0, newCount:50, pbqCount:0, languages:['csharp','python','mixed'] });
    }
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates: [] });
    if (path === '/practice/sessions') {
      starts.push(body);
      return json({ attempt: az204Attempt(attemptId, 'csharp', assignmentId), items: az204Items }, 201);
    }
    if (path.endsWith('/flags')) return json({ itemIds: [] });
    return json({ error: { code: 'unexpected_fixture_route' } }, 500);
  });
  await page.goto(`/tests/r3g/protected-runner-harness.html?exam=az204&assignment=${assignmentId}`);
  await page.getByRole('button', { name: 'Start exam' }).click();
  await expect(page.getByText('Standard Questions: Question 1 of 43')).toBeVisible();
  expect(starts).toHaveLength(1);
  expect(starts[0].assignmentId).toBe(assignmentId);
});

test('AZ-204 keeps one language selector, resumes locked C#, and starts one explicit Python replacement', async ({ page }) => {
  const oldId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; const nextId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  let replacements=0; let resumes=0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request=route.request(); const path=new URL(request.url()).pathname.split('/certsim-protected-exam')[1]; const body=request.postDataJSON?.();
    const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(path.startsWith('/practice/availability')) return json({examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',purpose:'self_directed_exam',available:true,selectedCount:50,adjustedCount:false,profileQuestionCount:50,timeLimitMinutes:120,fixedProfileSize:true,domainCounts:{},missedCount:0,newCount:50,pbqCount:0,languages:['csharp','python','mixed']});
    if(path.startsWith('/attempts/current-bindings')) return json({candidates:[{attemptId:oldId,examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',profileName:'Standard',purpose:'self_directed_exam',languagePreference:'csharp',startedAt:'2026-09-02T12:00:00.000Z',expiresAt:deadline,replacementPermitted:true}]});
    if(path===`/attempts/${oldId}`){resumes+=1;return json({attempt:az204Attempt(oldId,'csharp'),items:az204Items});}
    if(path==='/practice/sessions/replace'){replacements+=1;expect(body).toMatchObject({examKey:'az204',profileId:'standard-profile',language:'python'});return json({attempt:az204Attempt(nextId,'python'),items:az204Items},201);}
    if(path.endsWith('/flags')) return json({itemIds:[]});
    return json({error:{code:'unexpected_fixture_route'}},500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html?exam=az204&language=python');
  await expect(page.locator('.coding-language-panel')).toHaveCount(1);
  await page.getByRole('radio',{name:/^Python\b/}).check();
  await expect(page.getByRole('button',{name:/Resume attempt.*Standard.*csharp/i})).toBeVisible();
  await expect(page.getByRole('button',{name:'Start new attempt'})).toBeVisible();
  page.once('dialog',(dialog)=>dialog.accept());
  await page.getByRole('button',{name:'Start new attempt'}).dblclick();
  await expect(page.getByText('Standard Questions: Question 1 of 43')).toBeVisible();
  expect(replacements).toBe(1); expect(resumes).toBe(0);
});

for (const [activeLanguage, selectedLanguage] of [
  ['csharp', 'mixed'],
  ['python', 'csharp'],
  ['mixed', 'python'],
]) {
  test(`AZ-204 keeps active ${activeLanguage} separate from new ${selectedLanguage}`, async ({ page }) => {
    const oldId='abababab-abab-4bab-8bab-abababababab'; const nextId='cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    const requests=[]; let resumes=0; let availabilityReads=0; let confirmation='';
    await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
      const request=route.request(); const path=new URL(request.url()).pathname.split('/certsim-protected-exam')[1]; const body=request.postDataJSON?.();
      const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
      if(path.startsWith('/practice/availability')) { availabilityReads+=1; return json({examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',purpose:'self_directed_exam',available:true,selectedCount:50,adjustedCount:false,profileQuestionCount:50,timeLimitMinutes:120,fixedProfileSize:true,domainCounts:{},missedCount:0,newCount:50,pbqCount:0,languages:['csharp','python','mixed']}); }
      if(path.startsWith('/attempts/current-bindings')) return json({candidates:[{attemptId:oldId,examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',profileName:'Standard',purpose:'self_directed_exam',languagePreference:activeLanguage,startedAt:'2026-09-02T12:00:00.000Z',expiresAt:deadline,replacementPermitted:true}]});
      if(path===`/attempts/${oldId}`){resumes+=1;return json({attempt:az204Attempt(oldId,activeLanguage),items:az204Items});}
      if(path==='/practice/sessions/replace'){requests.push(body);return json({attempt:az204Attempt(nextId,selectedLanguage),items:az204Items},201);}
      if(path.endsWith('/flags')) return json({itemIds:[]});
      return json({error:{code:'unexpected_fixture_route'}},500);
    });
    page.on('dialog',async (dialog)=>{confirmation=dialog.message();await dialog.accept();});
    await page.goto(`/tests/r3g/protected-runner-harness.html?exam=az204&language=${selectedLanguage}`);
    await expect(page.getByRole('button',{name:new RegExp(`Resume attempt.*${activeLanguage}`,'i')})).toBeVisible();
    await page.getByRole('radio',{name:new RegExp(`^${selectedLanguage === 'csharp' ? 'C#' : selectedLanguage}`,'i')}).check();
    await expect(page.getByRole('radio',{name:new RegExp(`^${selectedLanguage === 'csharp' ? 'C#' : selectedLanguage}`,'i')})).toBeChecked();
    expect({requests:requests.length,resumes,availabilityReads}).toEqual({requests:0,resumes:0,availabilityReads:0});
    await page.getByRole('button',{name:'Start new attempt'}).click();
  await expect(page.getByText('Standard Questions: Question 1 of 43')).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({examKey:'az204',profileId:'standard-profile',language:selectedLanguage});
    expect(confirmation.toLowerCase()).toContain(selectedLanguage === 'csharp' ? 'csharp' : selectedLanguage);
    expect(confirmation.toLowerCase()).toContain(activeLanguage === 'csharp' ? 'csharp' : activeLanguage);
    expect(resumes).toBe(0);
  });
}

test('AZ-204 stale availability cannot reset a learner-selected new-attempt language', async ({ page }) => {
  const oldId='12121212-1212-4212-8212-121212121212'; const nextId='34343434-3434-4434-8434-343434343434';
  const replacements=[]; let availabilityReads=0; let resumes=0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request=route.request(); const path=new URL(request.url()).pathname.split('/certsim-protected-exam')[1]; const body=request.postDataJSON?.();
    const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(path.startsWith('/practice/availability')) { availabilityReads+=1; await new Promise((resolve)=>setTimeout(resolve,150)); return json({examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',purpose:'self_directed_exam',available:true,selectedCount:50,adjustedCount:false,profileQuestionCount:50,timeLimitMinutes:120,fixedProfileSize:true,domainCounts:{},missedCount:0,newCount:50,pbqCount:0,languages:['csharp','python','mixed']}); }
    if(path.startsWith('/attempts/current-bindings')) return json({candidates:[{attemptId:oldId,examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',profileName:'Standard',purpose:'self_directed_exam',languagePreference:'csharp',startedAt:'2026-09-02T12:00:00.000Z',expiresAt:deadline,replacementPermitted:true}]});
    if(path===`/attempts/${oldId}`){resumes+=1;return json({attempt:az204Attempt(oldId,'csharp'),items:az204Items});}
    if(path==='/practice/sessions/replace'){replacements.push(body);return json({attempt:az204Attempt(nextId,'python'),items:az204Items},201);}
    if(path.endsWith('/flags')) return json({itemIds:[]});
    return json({error:{code:'unexpected_fixture_route'}},500);
  });
    await page.goto('/tests/r3g/protected-runner-harness.html?exam=az204&language=mixed');
  await page.getByRole('radio',{name:/^Python\b/}).check();
  await expect(page.getByRole('radio',{name:/^Python\b/})).toBeChecked();
  await expect(page.getByRole('button',{name:/Resume attempt.*csharp/i})).toBeVisible();
  await expect(page.getByRole('radio',{name:/^Python\b/})).toBeChecked();
  expect({availabilityReads,resumes,replacements:replacements.length}).toEqual({availabilityReads:0,resumes:0,replacements:0});
  page.once('dialog',(dialog)=>dialog.accept());
  await page.getByRole('button',{name:'Start new attempt'}).click();
  await expect(page.getByText('Standard Questions: Question 1 of 43')).toBeVisible();
  expect(replacements).toHaveLength(1);
  expect(replacements[0].language).toBe('python');
});

for (const assigned of [true, false]) {
  test(`ambiguous ${assigned ? 'assigned' : 'unassigned'} replacement recovery preserves exact context`, async ({ page }) => {
    const oldId='71717171-7171-4171-8171-717171717171';
    const nextId='72727272-7272-4272-8272-727272727272';
    const assignmentId=assigned ? '15000000-0000-4000-8000-000000000001' : null;
    let replacements=0; const recoveryQueries=[];
    await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
      const request=route.request(); const url=new URL(request.url()); const path=url.pathname.split('/certsim-protected-exam')[1];
      const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
      if(path.startsWith('/attempts/current-bindings')) return json({candidates:[{attemptId:oldId,assignmentId,examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',profileName:'Standard',purpose:'self_directed_exam',languagePreference:'csharp',startedAt:'2026-09-02T12:00:00.000Z',expiresAt:deadline,replacementPermitted:true}]});
      if(path==='/practice/sessions/replace') { replacements+=1; return json({error:{code:'internal_failure'}},503); }
      if(path.startsWith('/attempts/current')) {
        recoveryQueries.push(Object.fromEntries(url.searchParams));
        return json({attempt:az204Attempt(nextId,'python',assignmentId),items:az204Items});
      }
      if(path.endsWith('/flags')) return json({itemIds:[]});
      return json({error:{code:'unexpected_fixture_route'}},500);
    });
    const suffix=assigned ? `&assignment=${assignmentId}` : '';
    await page.goto(`/tests/r3g/protected-runner-harness.html?exam=az204&language=python${suffix}`);
    await page.getByRole('radio',{name:/^Python\b/}).check();
    page.once('dialog',(dialog)=>dialog.accept());
    await page.getByRole('button',{name:'Start new attempt'}).click();
  await expect(page.getByText('Standard Questions: Question 1 of 43')).toBeVisible();
    expect(replacements).toBe(1);
    expect(recoveryQueries).toHaveLength(1);
    expect(recoveryQueries[0]).toMatchObject({packageVersion:'1.1.0',profileId:'standard-profile',purpose:'self_directed_exam',language:'python'});
    if(assigned) expect(recoveryQueries[0].assignmentId).toBe(assignmentId);
    else expect(recoveryQueries[0]).not.toHaveProperty('assignmentId');
  });
}

test('AZ-204 automatically recovers the single matching-language attempt', async ({ page }) => {
  const oldId='56565656-5656-4656-8656-565656565656'; let resumes=0; let starts=0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request=route.request(); const path=new URL(request.url()).pathname.split('/certsim-protected-exam')[1];
    const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(path.startsWith('/practice/availability')) return json({examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',purpose:'self_directed_exam',available:true,selectedCount:50,adjustedCount:false,profileQuestionCount:50,timeLimitMinutes:120,fixedProfileSize:true,domainCounts:{},missedCount:0,newCount:50,pbqCount:0,languages:['csharp','python','mixed']});
    if(path.startsWith('/attempts/current-bindings')) return json({candidates:[{attemptId:oldId,examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',profileName:'Standard',purpose:'self_directed_exam',languagePreference:'python',startedAt:'2026-09-02T12:00:00.000Z',expiresAt:deadline,replacementPermitted:true}]});
    if(path===`/attempts/${oldId}`){resumes+=1;return json({attempt:az204Attempt(oldId,'python'),items:az204Items});}
    if(path==='/practice/sessions'){starts+=1;return json({error:{code:'unexpected_start'}},500);}
    if(path.endsWith('/flags')) return json({itemIds:[]});
    return json({error:{code:'unexpected_fixture_route'}},500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html?exam=az204&language=python');
  await expect(page.getByText('Standard Questions: Question 1 of 43')).toBeVisible();
  await expect(page.getByRole('button',{name:/Resume attempt/})).toHaveCount(0);
  expect({resumes,starts}).toEqual({resumes:1,starts:0});
});

test('non-language technical entry automatically resumes without replacement', async ({ page }) => {
  const oldId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'; let resumes=0; let replacements=0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request=route.request(); const path=new URL(request.url()).pathname.split('/certsim-protected-exam')[1]; const body=request.postDataJSON?.();
    const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(path.startsWith('/practice/availability')) return json({examKey:'az400',packageVersion:'1.0.0',profileKey:'az400-sectioned-full-exam-profile',purpose:'self_directed_exam',available:true,selectedCount:80,adjustedCount:false,profileQuestionCount:80,timeLimitMinutes:120,fixedProfileSize:true,domainCounts:{},missedCount:0,newCount:80,pbqCount:2,languages:[]});
    if(path.startsWith('/attempts/current-bindings')) return json({candidates:[{attemptId:oldId,examKey:'az400',packageVersion:'1.0.0',profileKey:'az400-sectioned-full-exam-profile',profileName:'Sectioned',purpose:'self_directed_exam',languagePreference:null,startedAt:'2026-09-02T12:00:00.000Z',expiresAt:deadline,replacementPermitted:true}]});
    if(path===`/attempts/${oldId}`){resumes+=1;return json({attempt:{attemptId:oldId,examKey:'az400',packageVersion:'1.0.0',profileKey:'az400-sectioned-full-exam-profile',profileName:'Sectioned',status:'in_progress',startedAt:'2026-09-02T12:00:00.000Z',expiresAt:deadline,timeLimitMinutes:120,purpose:'self_directed_exam',languagePreference:null},items});}
    if(path==='/practice/sessions/replace'){replacements+=1;return json({error:{code:'unexpected_replace'}},500);}
    if(path.endsWith('/flags')) return json({itemIds:[]});
    return json({error:{code:'unexpected_fixture_route'}},500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html');
  await expect(page.getByRole('region',{name:'AZ-400 exam workspace'})).toBeVisible();
  expect({resumes,replacements}).toEqual({resumes:1,replacements:0});
});

test('stale advertised resume recovers inline to Start exam without a terminal screen', async ({ page }) => {
  const staleId='dddddddd-dddd-4ddd-8ddd-dddddddddddd'; let bindingReads=0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const path=new URL(route.request().url()).pathname.split('/certsim-protected-exam')[1];
    const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(path.startsWith('/practice/availability')) return json({examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',purpose:'self_directed_exam',available:true,selectedCount:50,adjustedCount:false,profileQuestionCount:50,timeLimitMinutes:120,fixedProfileSize:true,domainCounts:{},missedCount:0,newCount:50,pbqCount:0,languages:['csharp','python','mixed']});
    if(path.startsWith('/attempts/current-bindings')){bindingReads+=1;return json({candidates:bindingReads===1?[{attemptId:staleId,examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',profileName:'Standard',purpose:'self_directed_exam',languagePreference:'csharp',startedAt:'2026-09-02T12:00:00.000Z',expiresAt:deadline,replacementPermitted:true}]:[]});}
    if(path===`/attempts/${staleId}`) return json({error:{code:'attempt_not_found'}},404);
    return json({error:{code:'unexpected_fixture_route'}},500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html?exam=az204');
  await expect(page.getByRole('button',{name:'Start exam'})).toBeVisible();
  await expect(page.getByText(/No resumable protected attempt/)).toHaveCount(0);
  await expect(page.locator('.coding-language-panel')).toHaveCount(1);
});
