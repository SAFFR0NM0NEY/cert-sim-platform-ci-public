import {test,expect} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {readFile,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
test.describe.configure({mode:'serial'});
const before=process.env.PRACTICE_CORRECTION_PHASE==='before';
function sql(input){const r=spawnSync('psql',[process.env.SUPABASE_DB_URL,'-XqAt','-v','ON_ERROR_STOP=1'],{input,encoding:'utf8'});if(r.status)throw Error('SYNTHETIC_SQL_FAILED');return r.stdout.trim();}
for(const legacy of [false,true])for(const policy of ['omitted','false','true'])test(`actual ${legacy?'legacy':'new'} sandbox ${policy}: Start Resume later reserve page Save check`,async({page})=>{
 if(!process.env.RUNNER_TEMP||!['127.0.0.1','localhost'].includes(new URL(process.env.SUPABASE_URL).hostname))throw Error('DISPOSABLE_REQUIRED');
 const accounts=JSON.parse(await readFile(path.join(process.env.RUNNER_TEMP,'practice-matching-accounts.json'),'utf8')),account=accounts.find(a=>a.legacy===legacy&&a.policy===policy);
 sql(`update exam_delivery.package_profile_defaults d set package_version_id=p.id,package_profile_id=pp.id from exam_delivery.package_versions p join exam_delivery.package_profiles pp on pp.package_version_id=p.id where d.canonical_exam_key='inf303' and d.profile_key='inf303-standard' and d.purpose='study_sandbox' and p.exam_key='inf303' and p.package_version='${account.packageVersion}' and pp.profile_key='inf303-standard';`);
 const authClient=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),auth=await authClient.auth.signInWithPassword(account);if(auth.error)throw Error('SYNTHETIC_AUTH_FAILED');
 const session=auth.data.session,headers={Authorization:`Bearer ${session.access_token}`,apikey:process.env.SUPABASE_ANON_KEY};
 const starts=[],resumes=[],pages=[],saves=[],checks=[],requests=[];
 await page.route('**/*',r=>['127.0.0.1','localhost','[::1]'].includes(new URL(r.request().url()).hostname)?r.fallback():r.abort('blockedbyclient'));
 page.on('request',r=>{if(r.url().includes('/functions/v1/certsim-protected-exam/'))requests.push({method:r.method(),path:new URL(r.url()).pathname});});
 page.on('response',async r=>{const p=new URL(r.url()).pathname;if(!p.includes('/functions/v1/certsim-protected-exam/')||!r.ok())return;
  if(p.endsWith('/practice/sessions')&&r.request().method()==='POST')starts.push(await r.json());
  if(/\/attempts\/[0-9a-f-]{36}$/i.test(p)&&r.request().method()==='GET')resumes.push(await r.json());
  if(p.endsWith('/items')&&r.request().method()==='GET')pages.push(await r.json());
  if(p.endsWith('/response')&&r.request().method()==='PUT')saves.push(await r.json());
  if(p.endsWith('/check'))checks.push(await r.json());
 });
 const mount=async()=>{await page.goto('/tests/r3g/variable-python-harness.html');await page.waitForFunction(()=>typeof window.__mountVariableFixture==='function');await page.evaluate(s=>window.__mountVariableFixture(s,'inf303-standard','study_sandbox'),session);};
 await mount();await expect(page.getByRole('button',{name:'Start practice',exact:true})).toBeVisible();await page.getByRole('button',{name:'Start practice',exact:true}).click();await expect.poll(()=>starts.length).toBe(1);
 const first=starts[0],id=first.attempt.attemptId,item=first.items[0];
 expect(first.attempt.purpose).toBe('study_sandbox');expect(first.attempt.countContract).toBeUndefined();expect(first.attempt.timed).toBe(false);expect(first.attempt.expiresAt).toBeNull();expect(first.attempt.itemCount).toBe(30);expect(first.items.length).toBe(20);expect(first.page.hasMore).toBe(true);
 const effective=policy==='omitted'?(legacy||before?undefined:false):policy==='true';
 expect(item.presentation.allowTargetReuse).toBe(effective);
 expect(sql(`select canonical_form_id is null and canonical_form_cycle is null from exam_delivery.attempts where id='${id}'`)).toBe('t');
 const inventory=sql(`select md5(string_agg(id::text||presentation_hash,',' order by presented_question_number)) from exam_delivery.attempt_items where attempt_id='${id}'`);
 const left=page.getByRole('combobox',{name:'Match for Synthetic source A',exact:true}),right=page.getByRole('combobox',{name:'Match for Synthetic source B',exact:true});
 const optionState=async()=>{await left.selectOption('x');await expect(left.locator('option[value="x"]')).toHaveJSProperty('disabled',false);await expect(right.locator('option[value="x"]')).toHaveJSProperty('disabled',effective===false);await left.selectOption('');await expect(right.locator('option[value="x"]')).toHaveJSProperty('disabled',false);await left.selectOption('y');await expect(right.locator('option[value="x"]')).toHaveJSProperty('disabled',false);await left.selectOption('x');};
 await optionState();let rejectedUiSave=0;
 if(before&&!legacy&&policy==='omitted'){
  await right.selectOption('x');const bad=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/response'));await page.getByRole('button',{name:'Next',exact:true}).click();expect((await bad).ok()).toBe(false);rejectedUiSave++;
  expect(sql(`select count(*) from exam_delivery.attempt_responses where attempt_id='${id}' and attempt_item_id='${item.itemId}'`)).toBe('0');await right.selectOption('');
  const disagreement={suite:'practice-original-ui-save-disagreement',sourceHead:'f6ae1c4da1e1e0b40efeacf778fbc09fce0c5bf7',duplicateOptionEnabled:true,rejectedSaves:1,successfulSaves:saves.length,persistedResponses:0,saveRequests:requests.filter(r=>r.method==='PUT'&&r.path.endsWith('/response')).length,startRequests:starts.length,syntheticOnly:true};console.log(JSON.stringify(disagreement));await writeFile(path.join(process.env.RUNNER_TEMP,'practice-before-disagreement.json'),JSON.stringify(disagreement),{mode:0o600});
 }
 const next=async()=>{await page.getByRole('button',{name:'Next',exact:true}).click();};
 const saved=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/response')&&r.ok());await next();await saved;
 expect(sql(`select revision from exam_delivery.attempt_responses where attempt_id='${id}' and attempt_item_id='${item.itemId}'`)).toBe('1');
 const successor=spawnSync(process.execPath,['scripts/publish-practice-successor.mjs',policy,legacy?'legacy':'new'],{encoding:'utf8'});expect(successor.status).toBe(0);
 await mount();await expect(left).toHaveValue('x');await expect(right).toHaveValue('');expect(starts.length).toBe(1);await expect.poll(()=>resumes.length).toBeGreaterThan(0);expect(resumes.at(-1).attempt.attemptId).toBe(id);expect(resumes.at(-1).items[0].revision).toBe(1);expect(resumes.at(-1).items[0].presentation.allowTargetReuse).toBe(effective);
 const responseState=()=>sql(`select response_payload::text||':'||revision from exam_delivery.attempt_responses where attempt_id='${id}' and attempt_item_id='${item.itemId}'`),prior=responseState();
 let forgedSaveStatus=null;
 if(policy!=='true'){const bad=await page.request.put(`${process.env.SUPABASE_URL}/functions/v1/certsim-protected-exam/attempts/${id}/items/${item.itemId}/response`,{headers,data:{response:{answer:{a:'x',b:'x'}},expectedRevision:1,requestId:crypto.randomUUID()}});forgedSaveStatus=bad.status();expect(bad.ok()).toBe(false);expect(responseState()).toBe(prior);}
 await right.selectOption(policy==='true'?'x':'y');const check=page.waitForResponse(r=>r.url().endsWith('/check')&&r.ok());await page.getByRole('button',{name:'Check saved answer',exact:true}).click();await check;await expect.poll(()=>checks.length).toBe(1);expect(checks[0].earnedPoints).toBe(2);expect(checks[0].maxPoints).toBe(2);expect(checks[0].revision).toBe(2);
 for(let i=0;i<20;i++)await next();await expect.poll(()=>pages.length).toBeGreaterThan(0);const later=pages[0];expect(later.afterPosition).toBe(20);expect(later.totalCount).toBe(30);expect(later.items.length).toBe(10);expect(later.hasMore).toBe(false);
 const reserveIndex=later.items.findIndex(i=>!account.memberIds.includes(i.questionId));expect(reserveIndex).toBeGreaterThanOrEqual(0);for(let i=0;i<reserveIndex;i++)await next();const reserve=later.items[reserveIndex];expect(reserve.presentation.allowTargetReuse).toBe(effective);expect(reserve.questionNumber).toBe(21+reserveIndex);
 await optionState();await right.selectOption(policy==='true'?'x':'y');const laterCheck=page.waitForResponse(r=>r.url().endsWith('/check')&&r.ok());await page.getByRole('button',{name:'Check saved answer',exact:true}).click();await laterCheck;await expect.poll(()=>checks.length).toBe(2);expect(checks[1].earnedPoints).toBe(2);expect(checks[1].revision).toBe(1);
 await page.getByRole('button',{name:'Previous',exact:true}).click();await next();await expect(left).toHaveValue('x');await expect(right).toHaveValue(policy==='true'?'x':'y');
 for(let n=0;n<2;n++){const repeated=await page.request.get(`${process.env.SUPABASE_URL}/functions/v1/certsim-protected-exam/attempts/${id}/items?afterPosition=20&pageSize=20`,{headers});expect(repeated.ok()).toBe(true);const data=await repeated.json();expect(data.items.find(i=>i.itemId===reserve.itemId).revision).toBe(1);expect(data.items.find(i=>i.itemId===reserve.itemId).presentation.allowTargetReuse).toBe(effective);}
 const other=accounts.find(a=>a.id!==account.id),otherAuth=await authClient.auth.signInWithPassword(other);if(otherAuth.error)throw Error('SYNTHETIC_AUTH_FAILED');const denied=await page.request.get(`${process.env.SUPABASE_URL}/functions/v1/certsim-protected-exam/attempts/${id}/items?afterPosition=20&pageSize=20`,{headers:{...headers,Authorization:`Bearer ${otherAuth.data.session.access_token}`}});expect(denied.ok()).toBe(false);
 expect(sql(`select md5(string_agg(id::text||presentation_hash,',' order by presented_question_number)) from exam_delivery.attempt_items where attempt_id='${id}'`)).toBe(inventory);
 expect(sql(`select count(*) from exam_delivery.attempts where owner_id='${account.id}'`)).toBe('1');expect(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${id}'`)).toBe('0');expect(starts.length).toBe(1);expect(requests.some(r=>/replace|abandon|submit/.test(r.path))).toBe(false);
 const proof={suite:'practice-matching-real-edge-react',phase:before?'before':'after',legacy,policy,generatorVersion:account.generatorVersion,startCount:starts.length,resumeCount:resumes.length,pageReads:pages.length,repeatedPageReads:2,uiSaveRequests:requests.filter(r=>r.method==='PUT'&&r.path.endsWith('/response')).length,successfulSaves:saves.length,rejectedUiSave,forgedSaveRequests:policy==='true'?0:1,forgedSaveStatus,wrongOwnerPageStatus:denied.status(),checkRequests:checks.length,firstRevision:2,laterReserveRevision:1,totalItems:30,initialItems:20,laterItems:10,formalAllocation:false,firstAndReserveCredit:2,successorPublishedAndOriginalPinned:true,snapshotHashesUnchanged:true,syntheticOnly:true};console.log(JSON.stringify(proof));await writeFile(path.join(process.env.RUNNER_TEMP,`practice-${before?'before':'after'}-${legacy?'legacy':'new'}-${policy}.json`),JSON.stringify(proof),{mode:0o600});
});

test('actual delayed practice page cannot cross account/attempt remount',async({page})=>{
 if(!process.env.RUNNER_TEMP||!['127.0.0.1','localhost'].includes(new URL(process.env.SUPABASE_URL).hostname))throw Error('DISPOSABLE_REQUIRED');
 const accounts=JSON.parse(await readFile(path.join(process.env.RUNNER_TEMP,'practice-matching-accounts.json'),'utf8'));
 const old=accounts.find(a=>!a.legacy&&a.policy==='omitted'),other=accounts.find(a=>a.legacy&&a.policy==='true');
 const login=async a=>{const c=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),r=await c.auth.signInWithPassword(a);if(r.error)throw Error('SYNTHETIC_AUTH_FAILED');return r.data.session;};
 const oldSession=await login(old),otherSession=await login(other),oldId=sql(`select id from exam_delivery.attempts where owner_id='${old.id}'`);let starts=0;
 await page.route('**/*',r=>['127.0.0.1','localhost','[::1]'].includes(new URL(r.request().url()).hostname)?r.fallback():r.abort('blockedbyclient'));
 page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname.endsWith('/practice/sessions'))starts++;});
 await page.goto('/tests/r3g/variable-python-harness.html');await page.waitForFunction(()=>typeof window.__mountVariableFixture==='function');await page.evaluate(s=>window.__mountVariableFixture(s,'inf303-standard','study_sandbox'),oldSession);
 await expect(page.getByRole('combobox',{name:'Match for Synthetic source A',exact:true})).toHaveValue('x');
 for(let n=0;n<19;n++)await page.getByRole('button',{name:'Next',exact:true}).click();
 let release,arrived,done;const hold=new Promise(r=>release=r),hit=new Promise(r=>arrived=r),finished=new Promise(r=>done=r);
 await page.route(new RegExp(`/attempts/${oldId}/items\\?`),async route=>{const response=await route.fetch();arrived();await hold;try{await route.fulfill({response});}catch{}finally{done();}});
 await page.getByRole('button',{name:'Next',exact:true}).click();await hit;
 await page.evaluate(s=>window.__mountVariableFixture(s,'inf303-standard','study_sandbox'),otherSession);
 try{await expect(page.locator('.mobile-exam-tools span')).toHaveText('Item 1 of 20');await expect(page.getByRole('combobox',{name:'Match for Synthetic source B',exact:true})).toHaveValue('x');}finally{release();}
 await finished;await expect(page.locator('.mobile-exam-tools span')).toHaveText('Item 1 of 20');await expect(page.getByRole('button',{name:'Previous',exact:true})).toBeDisabled();expect(starts).toBe(0);
 const proof={suite:'practice-stale-page-account-fence',phase:before?'before':'after',delayedOldPageIgnored:true,otherAttemptPreserved:true,startCount:0,syntheticOnly:true};console.log(JSON.stringify(proof));await writeFile(path.join(process.env.RUNNER_TEMP,`practice-${before?'before':'after'}-stale-page.json`),JSON.stringify(proof),{mode:0o600});
});
