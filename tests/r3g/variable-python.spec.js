import { test, expect } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
test.describe.configure({mode:'serial'});
test('actual disposable Edge and React select, resume, save and complete both lengths', async ({ page }) => {
  if (!process.env.RUNNER_TEMP || !['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL).hostname)) throw Error('DISPOSABLE_BROWSER_REQUIRED');
  const account = JSON.parse(await readFile(path.join(process.env.RUNNER_TEMP,'variable-browser-account.json'),'utf8'));
  const client = createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const auth = await client.auth.signInWithPassword({email:account.email,password:account.password});
  if (auth.error) throw Error('SYNTHETIC_BROWSER_AUTH_FAILED');
  const session = auth.data.session, starts = [], results = [], requests = [];
  let recoveredLostAcknowledgment=false;
  await page.route('**/*', route => {
    const host = new URL(route.request().url()).hostname;
    return ['localhost','127.0.0.1','[::1]'].includes(host) ? route.fallback() : route.abort('blockedbyclient');
  });
  let loseFirstAcknowledgment=true, committedBeforeLoss;
  await page.route('**/functions/v1/certsim-protected-exam/practice/sessions',async route=>{
    const response=await route.fetch();
    if(loseFirstAcknowledgment && route.request().method()==='POST' && response.status()===201) {
      committedBeforeLoss=await response.json();loseFirstAcknowledgment=false;
      return route.abort('failed');
    }
    return route.fulfill({response});
  });
  page.on('response', async response => {
    if (!response.url().includes('/functions/v1/certsim-protected-exam/')) return;
    const pathname = new URL(response.url()).pathname;
    if (pathname.endsWith('/practice/sessions') && response.ok()) starts.push(await response.json());
    if (pathname.endsWith('/attempts/current') && response.ok() && committedBeforeLoss && starts.length===0) {
      const recovered=await response.json();
      if(recovered.attempt?.attemptId===committedBeforeLoss.attempt.attemptId){starts.push(recovered);recoveredLostAcknowledgment=true;}
    }
    if (pathname.endsWith('/submit') && response.ok()) results.push(await response.json());
  });
  page.on('request', request => {
    if (request.method()==='POST' && new URL(request.url()).pathname.endsWith('/practice/sessions')) requests.push(request.postDataJSON());
  });
  const mount = async () => {
    await page.goto('/tests/r3g/variable-python-harness.html');
    await page.waitForFunction(() => typeof window.__mountVariableFixture === 'function');
    await page.evaluate(s => window.__mountVariableFixture(s),session);
  };
  await mount();
  for (const n of [3,5]) {
    await expect(page.getByText('3 or 5 — server assigned at Start',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:/start.*(exam|practice|attempt)/i}).click();
    await expect(page.getByRole('radiogroup',{name:'Statement 1',exact:true})).toBeVisible();
    await expect.poll(() => starts.length).toBe(n===3?1:2);
    const started = starts.at(-1);
    expect(started.attempt.countContract.exactCount).toBe(n);
    expect(started.items.length).toBe(n);
    expect(requests.at(-1)).not.toHaveProperty('count');
    expect(requests.at(-1)).not.toHaveProperty('formId');
    const attemptId = started.attempt.attemptId, expiry = started.attempt.expiresAt;
    if(n===3) {
      expect(committedBeforeLoss.attempt.attemptId).toBe(attemptId);
      expect(committedBeforeLoss.attempt.expiresAt).toBe(expiry);
      expect(committedBeforeLoss.attempt.countContract).toEqual(started.attempt.countContract);
      expect(new Set(requests.map(r=>r.clientRequestId)).size).toBe(1);
      expect(recoveredLostAcknowledgment).toBe(true);
    }
    await page.getByRole('radiogroup',{name:'Statement 1',exact:true}).getByRole('radio',{name:'True',exact:true}).check();
    await page.getByRole('radiogroup',{name:'Statement 2',exact:true}).getByRole('radio',{name:'True',exact:true}).check();
    const savedResponse = page.waitForResponse(r => r.request().method()==='PUT' && r.url().endsWith('/response') && r.ok());
    await page.getByRole('button',{name:'Next',exact:true}).click();
    await savedResponse;
    await page.getByRole('button',{name:'Previous',exact:true}).click();
    await mount();
    await expect(page.getByRole('radiogroup',{name:'Statement 1',exact:true}).getByRole('radio',{name:'True',exact:true})).toBeChecked();
    // Read the real authorized Resume response, retaining the original attempt.
    const resumed = await page.request.get(`${process.env.SUPABASE_URL}/functions/v1/certsim-protected-exam/attempts/${attemptId}`,{
      headers:{Authorization:`Bearer ${session.access_token}`,apikey:process.env.SUPABASE_ANON_KEY,'x-client-info':'certsim-authorised-form-count-v1'},
    });
    expect(resumed.ok()).toBe(true);
    const body=await resumed.json();
    expect(body.attempt.attemptId).toBe(attemptId); expect(body.attempt.expiresAt).toBe(expiry); expect(body.attempt.countContract.exactCount).toBe(n);
    for(let i=1;i<n;i++) await page.getByRole('button',{name:'Next',exact:true}).click();
    await page.getByRole('button',{name:'Submit exam',exact:true}).click();
    const modal = page.getByRole('dialog',{name:'Review before submitting'});
    await expect(modal.locator('dt').filter({hasText:'Total scored items'}).locator('..').locator('dd')).toHaveText(String(n));
    await page.getByRole('button',{name:'Submit Final Attempt',exact:true}).click();
    await expect.poll(() => results.length).toBe(n===3?1:2);
    const result=results.at(-1).result ?? results.at(-1);
    expect(result.questionCount).toBe(n); expect(result.rawScore).toBe(1); expect(result.maxScore).toBe(n*2);
    const review=await page.request.get(`${process.env.SUPABASE_URL}/functions/v1/certsim-protected-exam/attempts/${attemptId}/review`,{
      headers:{Authorization:`Bearer ${session.access_token}`,apikey:process.env.SUPABASE_ANON_KEY},
    });
    expect(review.ok()).toBe(true);
    const released=await review.json();
    expect(released.review.items.map(i=>i.itemId)).toEqual(started.items.map(i=>i.itemId));
    await page.getByRole('button',{name:'Return home',exact:true}).click();
    await page.getByRole('button',{name:'Saved Results',exact:true}).click();
    await page.getByRole('button',{name:/Saved result/}).first().click();
    await expect(page.getByRole('heading',{name:'Result summary',exact:true})).toBeVisible();
    await expect(page.locator('dt').filter({hasText:/^Questions$/}).locator('..').locator('dd')).toHaveText(String(n));
    await expect(page.locator('dt').filter({hasText:/^Raw points$/}).locator('..').locator('dd')).toHaveText(`1 / ${n*2}`);
    await expect(page.locator('dt').filter({hasText:/^Answered$/}).locator('..').locator('dd')).toHaveText(`1 / ${n}`);
    await mount();
  }
  expect(starts.map(s=>s.attempt.countContract.exactCount)).toEqual([3,5]);
});

async function fixtureSession(file) {
  const account=JSON.parse(await readFile(path.join(process.env.RUNNER_TEMP,file),'utf8'));
  const client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  const signed=await client.auth.signInWithPassword({email:account.email,password:account.password});
  if(signed.error)throw Error('SYNTHETIC_BROWSER_AUTH_FAILED');
  return signed.data.session;
}
async function mountSession(page,session) {
  await page.goto('/tests/r3g/variable-python-harness.html');
  await page.waitForFunction(()=>typeof window.__mountVariableFixture==='function');
  await page.evaluate(s=>window.__mountVariableFixture(s),session);
}
test('late same-count Start response cannot cross an actual account change',async({page})=>{
  const oldSession=await fixtureSession('variable-browser-account.json'),newSession=await fixtureSession('variable-negative-account.json');
  let ready,release,oldPayload,newPayload;
  const oldReady=new Promise(resolve=>{ready=resolve;}),barrier=new Promise(resolve=>{release=resolve;});
  let first=true;
  await page.route('**/functions/v1/certsim-protected-exam/practice/sessions',async route=>{
    const response=await route.fetch(),payload=await response.json();
    if(first){first=false;oldPayload=payload;ready();await barrier;try{await route.fulfill({response});}catch{/* The previous account's request was aborted by its scope. */}}
    else{newPayload=payload;await route.fulfill({response});}
  });
  await mountSession(page,oldSession);
  await expect(page.getByText('3 or 5 — server assigned at Start',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:/start.*(exam|practice|attempt)/i}).click();
  await oldReady;
  try {
    await page.evaluate(s=>window.__mountVariableFixture(s),newSession);
    await expect(page.getByText('3 or 5 — server assigned at Start',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:/start.*(exam|practice|attempt)/i}).click();
    await expect(page.getByRole('radiogroup',{name:'Statement 1',exact:true})).toBeVisible();
  } finally { release(); }
  expect(oldPayload.attempt.countContract.exactCount).toBe(3);
  expect(newPayload.attempt.countContract.exactCount).toBe(3);
  expect(newPayload.attempt.attemptId).not.toBe(oldPayload.attempt.attemptId);
  await expect(page.getByRole('radiogroup',{name:'Statement 1',exact:true}).getByRole('radio',{name:'True',exact:true})).toHaveAttribute('name',`${newPayload.items[0].itemId}-a`);
  const closed=await page.request.post(`${process.env.SUPABASE_URL}/functions/v1/certsim-protected-exam/attempts/${oldPayload.attempt.attemptId}/abandon`,{
    headers:{Authorization:`Bearer ${oldSession.access_token}`,apikey:process.env.SUPABASE_ANON_KEY},data:{requestId:crypto.randomUUID()},
  });
  expect(closed.ok()).toBe(true);
});
for(const corruption of ['wrong-member','missing-count'])test(`actual runner rejects ${corruption} on Resume without a new Start`,async({page})=>{
  const session=await fixtureSession('variable-negative-account.json');let starts=0;
  page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname.endsWith('/practice/sessions'))starts++;});
  await page.route(/\/certsim-protected-exam\/attempts\/[a-f0-9-]+$/,async route=>{
    const response=await route.fetch(),payload=await response.json();
    if(corruption==='wrong-member')payload.items[0].questionId='synthetic-wrong-member';
    else delete payload.attempt.countContract;
    await route.fulfill({response,json:payload});
  });
  await mountSession(page,session);
  await expect(page.getByText('Protected attempt inventory binding is invalid.',{exact:true})).toBeVisible();
  await expect(page.getByRole('radiogroup')).toHaveCount(0);
  const startButtons=page.getByRole('button',{name:/start.*(exam|practice|attempt)/i});
  for(let index=0;index<await startButtons.count();index++)await expect(startButtons.nth(index)).toBeDisabled();
  expect(starts).toBe(0);
});
