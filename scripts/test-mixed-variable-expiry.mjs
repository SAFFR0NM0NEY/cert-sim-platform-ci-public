import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createClient } from '@supabase/supabase-js';
const database=process.env.SUPABASE_DB_URL,api=process.env.SUPABASE_URL;
for(const value of [database,api]) if(!value || !['127.0.0.1','localhost','[::1]'].includes(new URL(value).hostname)) throw Error('DISPOSABLE_LOOPBACK_REQUIRED');
let assertions=0;
const eq=(a,b)=>{assert.deepEqual(a,b);assertions++;};
function sql(input){const r=spawnSync('psql',[database,'-XqAt','-v','ON_ERROR_STOP=1'],{input,encoding:'utf8'});if(r.status)throw Error('SYNTHETIC_EXPIRY_SQL_FAILED');return r.stdout.trim();}
const account=JSON.parse(await readFile(path.join(process.env.RUNNER_TEMP,'mixed-expiry-account.json'),'utf8'));
const client=createClient(api,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const signed=await client.auth.signInWithPassword({email:account.email,password:account.password});
if(signed.error)throw Error('SYNTHETIC_EXPIRY_AUTH_FAILED');
const headers={Authorization:`Bearer ${signed.data.session.access_token}`,apikey:process.env.SUPABASE_ANON_KEY,'Content-Type':'application/json','x-client-info':'certsim-authorised-form-count-v2'};
async function edge(route,body,method=body?'POST':'GET'){const r=await fetch(`${api}/functions/v1/certsim-protected-exam${route}`,{method,headers,...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();if(!r.ok)throw Error(`SYNTHETIC_EXPIRY_EDGE_${data.error?.code}`);return data;}
const oldId=sql(`select id from exam_delivery.attempts where owner_id='${account.id}' and status='in_progress'`);
if(oldId)await edge(`/attempts/${oldId}/abandon`,{requestId:crypto.randomUUID()});
sql('select exam_delivery.set_expiry_enrolment(true)');
// Established isolated clock technique, only for this fresh attempt. The normal
// 2700-second Start assertion is separate and is never rewritten after Start.
sql(`create function public.variable_fixture_clock() returns trigger language plpgsql set search_path='' as $$begin
if new.owner_id='${account.id}'::uuid then new.expires_at=clock_timestamp()+interval '4 seconds';end if;return new;end$$;
create trigger variable_fixture_clock before insert on exam_delivery.attempts for each row execute function public.variable_fixture_clock();`);
const started=await edge('/practice/sessions',{examKey:'inf303',profileId:'inf303-standard',purpose:'self_directed_exam',language:'not_applicable',includePbqs:true,mixStrategy:'balanced',clientRequestId:crypto.randomUUID()});
sql('drop trigger variable_fixture_clock on exam_delivery.attempts;drop function public.variable_fixture_clock();');
const id=started.attempt.attemptId,n=started.attempt.countContract.exactCount;
// The materialization rollback probe retried its three-item form, then this
// fixture normally abandoned it; allocation selects its five-item sibling.
eq(n,5);
await edge(`/attempts/${id}/items/${started.items[0].itemId}/response`,{response:{answer:'yes'},expectedRevision:0,requestId:crypto.randomUUID()},'PUT');
eq(sql(`select count(*) from exam_delivery.expiry_authority where attempt_id='${id}'`),'1');
await new Promise(resolve=>setTimeout(resolve,4300));
const pending=await edge(`/attempts/${id}/completion-status`);
eq(pending.status.state,'awaiting_processing');
sql('select exam_delivery.set_expiry_worker(true)');
async function worker(){const r=await fetch(`${api}/functions/v1/certsim-expiry-worker`,{method:'POST',headers:{apikey:process.env.SUPABASE_SERVICE_ROLE_KEY}});if(!r.ok)throw Error('SYNTHETIC_EXPIRY_WORKER_FAILED');return r.json();}
eq((await worker()).completed,1);
eq((await worker()).completed,0);
eq(JSON.parse(sql(`select jsonb_build_array((result_summary->>'questionCount')::integer,raw_score,max_score) from exam_delivery.attempt_results where attempt_id='${id}'`)),[5,1,9]);
eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${id}'`),'1');
eq(sql(`select count(*) from public.exam_results where attempt_id='${id}'`),'1');
eq((await edge(`/attempts/${id}/completion-status`)).status.state,'completed');
const history=await edge('/history?examKey=inf303&pageSize=20');
eq(history.items.filter(item=>item.attemptId===id).length,1);
const summary=await edge(`/attempts/${id}/print-summary`);
eq(summary.questionCount,n);eq(summary.rawMaximum,n===5?9:5);eq(summary.answeredCount,1);
console.log(JSON.stringify({suite:'mixed-variable-no-submit-expiry',assertions,selectedCount:n,rawMaximum:9,earned:1,submitCalls:0,syntheticClock:true,syntheticOnly:true}));
const expiryAssertions=assertions;
const admin=createClient(api,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
sql(`create function public.variable_race_clock() returns trigger language plpgsql set search_path='' as $$begin
if new.owner_id='${account.id}'::uuid then new.expires_at=clock_timestamp()+interval '4 seconds';end if;return new;end$$;
create trigger variable_race_clock before insert on exam_delivery.attempts for each row execute function public.variable_race_clock();`);
const race=await edge('/practice/sessions',{examKey:'inf303',profileId:'inf303-standard',purpose:'self_directed_exam',language:'not_applicable',includePbqs:true,mixStrategy:'balanced',clientRequestId:crypto.randomUUID()});
sql('drop trigger variable_race_clock on exam_delivery.attempts;drop function public.variable_race_clock();');
const raceId=race.attempt.attemptId,submission=crypto.randomUUID();
eq(race.attempt.countContract.exactCount,3);
await edge(`/attempts/${raceId}/items/${race.items[0].itemId}/response`,{response:{answer:'yes'},expectedRevision:0,requestId:crypto.randomUUID()},'PUT');
const prepared=await admin.rpc('certsim_service_prepare_python_submission_grading',{p_actor_id:account.id,p_attempt_id:raceId,p_submission_id:submission});
eq(prepared.error,null);eq(prepared.data.ok,true);
await new Promise(resolve=>setTimeout(resolve,4300));
const claim=await admin.rpc('certsim_service_claim_next_expiry');eq(claim.error,null);eq(claim.data.attemptId,raceId);
const holder=spawn('psql',[database,'-XqAt','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']});
await new Promise((resolve,reject)=>{
  let out='';holder.stdout.on('data',chunk=>{out+=chunk;if(out.includes('RACE_READY'))resolve();});holder.once('error',reject);
  holder.once('exit',code=>{if(code)reject(Error('SYNTHETIC_RACE_BARRIER_FAILED'));});
  holder.stdin.write(`begin;select id from exam_delivery.attempts where id='${raceId}' for update;select 'RACE_READY';\n`);
});
const contenders=Promise.allSettled([
  edge(`/attempts/${raceId}/submit`,{submissionId:submission}),
  admin.rpc('certsim_service_finish_expiry',{p_attempt_id:raceId,p_token:claim.data.leaseToken}).then(r=>{if(r.error)throw Error('SYNTHETIC_RACE_FINALIZER_FAILED');return r.data;}),
]);
try {
  const until=Date.now()+6000;
  while(Number(sql("select count(*) from pg_stat_activity where wait_event_type='Lock'"))<2) {
    if(Date.now()>until)throw Error('RACE_CONTENDERS_DID_NOT_REACH_BARRIER');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assertions++;
} finally {holder.stdin.end('commit;\n');}
const outcomes=await contenders;eq(outcomes.every(r=>r.status==='fulfilled'),true);
eq(outcomes[0].value.result.questionCount,3);eq(outcomes[0].value.result.maxScore,5);eq(outcomes[1].value.outcome,'completed');
eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${raceId}'`),'1');
eq(sql(`select count(*) from public.exam_results where attempt_id='${raceId}'`),'1');
eq(sql(`select reason||':'||(submission_id='${submission}'::uuid) from exam_delivery.expiry_bindings where attempt_id='${raceId}'`),'manual:true');
eq(JSON.parse(sql(`select jsonb_build_array((result_summary->>'questionCount')::integer,raw_score,max_score) from exam_delivery.attempt_results where attempt_id='${raceId}'`)),[3,1,5]);
sql('select exam_delivery.set_expiry_worker(false);select exam_delivery.set_expiry_enrolment(false)');
console.log(JSON.stringify({suite:'mixed-variable-manual-finalizer-race',assertions:assertions-expiryAssertions,selectedCount:3,rawMaximum:5,earned:1,submitCalls:1,barrier:true,oneResult:true,syntheticOnly:true}));

await writeFile(path.join(process.env.RUNNER_TEMP,'mixed-expiry-proof.json'),JSON.stringify({suite:'mixed-variable-expiry-and-race',assertions,noSubmit:{count:5,earned:1,maximum:9,submitCalls:0},manualRace:{count:3,earned:1,maximum:5,oneResult:true,barrier:true},syntheticOnly:true,productionActions:0}));
