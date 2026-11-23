import {test,expect} from '@playwright/test';import {createClient} from '@supabase/supabase-js';import {readFile,writeFile} from 'node:fs/promises';import path from 'node:path';
test.describe.configure({mode:'serial'});
for(const n of [3,5])test('native mixed real runner whole form '+n,async({page})=>{
 if(!process.env.RUNNER_TEMP||!['localhost','127.0.0.1'].includes(new URL(process.env.SUPABASE_URL).hostname))throw Error('DISPOSABLE_REQUIRED');
 const account=JSON.parse(await readFile(path.join(process.env.RUNNER_TEMP,'mixed-browser-account.json'),'utf8')),client=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 const login=await client.auth.signInWithPassword(account);if(login.error)throw Error('SYNTHETIC_AUTH_FAILED');const session=login.data.session,starts=[],resumes=[],results=[],saves=[];
 await page.route('**/*',r=>['localhost','127.0.0.1','[::1]'].includes(new URL(r.request().url()).hostname)?r.fallback():r.abort('blockedbyclient'));
 page.on('response',async r=>{if(!r.ok()||!r.url().includes('/functions/v1/certsim-protected-exam/'))return;const p=new URL(r.url()).pathname;
 if(p.endsWith('/practice/sessions')&&r.request().method()==='POST')starts.push(await r.json());
 if(/\/attempts\/[0-9a-f-]{36}$/i.test(p)&&r.request().method()==='GET')resumes.push(await r.json());
 if(p.endsWith('/submit'))results.push(await r.json());if(p.endsWith('/response')&&r.request().method()==='PUT')saves.push(await r.json());});
 const mount=async()=>{await page.goto('/tests/r3g/variable-python-harness.html');await page.waitForFunction(()=>typeof window.__mountVariableFixture==='function');await page.evaluate(s=>window.__mountVariableFixture(s),session);};
 await mount();await page.getByRole('button',{name:/start.*(exam|practice|attempt)/i}).click();await expect.poll(()=>starts.length).toBe(1);
 const a=starts[0];expect(a.items.length).toBe(n);expect(a.attempt.countContract.version).toBe('certsim-authorised-form-count-v2');
 const wrong=page.getByRole('radio',{name:/Synthetic incorrect choice/});await wrong.focus();await wrong.press('Space');await expect(wrong).toBeChecked();
 const save=page.waitForResponse(r=>r.ok()&&r.request().method()==='PUT'&&r.url().endsWith('/response'));await page.getByRole('button',{name:'Next',exact:true}).click();await save;
 await mount();await expect(page.getByRole('radio',{name:/Synthetic incorrect choice/})).toBeChecked();await expect.poll(()=>resumes.length).toBeGreaterThan(0);expect(resumes.at(-1).attempt.attemptId).toBe(a.attempt.attemptId);expect(starts.length).toBe(1);
 for(let i=0;i<n;i++){
  await expect(page.locator('.mobile-exam-tools span')).toHaveText('Item '+(i+1)+' of '+n);
  switch(a.items[i].questionType){
   case 'single-choice':await page.getByRole('radio',{name:/Synthetic correct choice/}).check();break;
   case 'true-false-single-v1':await page.getByRole('radiogroup',{name:'Statement 1',exact:true}).getByRole('radio',{name:'True',exact:true}).check();break;
   case 'true-false-composite-v1':await page.getByRole('radiogroup',{name:'Statement 1',exact:true}).getByRole('radio',{name:'True',exact:true}).check();await page.getByRole('radiogroup',{name:'Statement 2',exact:true}).getByRole('radio',{name:'False',exact:true}).check();break;
   case 'matching-v1':await page.getByRole('combobox',{name:'Match for Synthetic source A',exact:true}).selectOption('x');await expect(page.getByRole('combobox',{name:'Match for Synthetic source B',exact:true}).locator('option[value="x"]')).toHaveJSProperty('disabled',true);await page.getByRole('combobox',{name:'Match for Synthetic source B',exact:true}).selectOption('y');break;
   case 'code-dropdown-completion-v1':await page.getByRole('combobox',{name:'Code blank a',exact:true}).selectOption('x');await page.getByRole('combobox',{name:'Code blank b',exact:true}).selectOption('x');break;
   default:throw Error('SYNTHETIC_TYPE_REQUIRED');
  }
  if(i<n-1){const saved=page.waitForResponse(r=>r.ok()&&r.request().method()==='PUT'&&r.url().endsWith('/response'));await page.getByRole('button',{name:'Next',exact:true}).click();await saved;await expect(page.locator('.mobile-exam-tools span')).toHaveText('Item '+(i+2)+' of '+n);}
 }
 await page.getByRole('button',{name:'Submit exam',exact:true}).click();await page.getByRole('button',{name:'Submit Final Attempt',exact:true}).click();await expect.poll(()=>results.length).toBe(1);
 const r=results[0].result??results[0];expect(r.questionCount).toBe(n);expect(r.maxScore).toBe(n===3?5:9);expect(r.rawScore).toBe(r.maxScore);
 expect(saves.some(s=>s.revision===2)).toBe(true);
 const proof={suite:'mixed-variable-real-edge-react',count:n,rawScore:r.rawScore,maximum:r.maxScore,wrongChoiceSavedThenCorrected:true,keyboardNativeChoice:true,genuineResume:true,oneStart:true,syntheticOnly:true};
 await writeFile(path.join(process.env.RUNNER_TEMP,'mixed-browser-'+n+'-proof.json'),JSON.stringify(proof));console.log(JSON.stringify(proof));
});

