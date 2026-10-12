import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
const db=process.env.SUPABASE_DB_URL,api=process.env.SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY;
for(const url of [db,api]) if(!url||!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw Error('DISPOSABLE_LOOPBACK_REQUIRED');
const psql=process.env.PSQL_PATH||'psql'; let assertions=0;
function sql(s){const r=spawnSync(psql,[db,'-XqAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=sqlstate'],{input:s,encoding:'utf8',windowsHide:true});if(r.status)throw Error('fixture_sql_failed '+r.stderr.replaceAll('SENSITIVE_SENTINEL','<redacted>').replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi,'<opaque>'));return r.stdout.trim();}
function json(s){return JSON.parse(sql(s).split(/\r?\n/).at(-1));}
function eq(a,b){try{assert.deepEqual(a,b);}catch{const safe=v=>JSON.stringify(v)?.replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi,'<opaque>').replaceAll('SENSITIVE_SENTINEL','<redacted>');throw Error(`worker_assertion_${assertions+1}: ${safe(a)} expected ${safe(b)}`);}assertions++;}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function worker(headers={apikey:key},suffix='',body){const r=await fetch(`${api}/functions/v1/certsim-expiry-worker${suffix}`,{method:'POST',headers,...(body?{body}: {})});const data=await r.json();assert.ok(!JSON.stringify(data).includes('SENSITIVE_SENTINEL'));return {status:r.status,data};}
async function rpc(name,args={},credential=key){const r=await fetch(`${api}/rest/v1/rpc/${name}`,{method:'POST',headers:{apikey:credential,Authorization:`Bearer ${credential}`,'Content-Type':'application/json'},body:JSON.stringify(args)});if(!r.ok)return {denied:r.status};return r.json();}
if(process.argv.includes('--disabled-config')) {const r=await worker();eq({status:r.status,code:r.data.code,state:r.data.state},{status:200,code:undefined,state:'disabled'});eq(sql('select count(*) from exam_delivery.expiry_events'),'0');console.log('WORKER_HTTP_DISABLED_CONFIG=PASS');process.exit(0);}
const owner=randomUUID(),pkg=randomUUID(),profile=randomUUID(),canonical=randomUUID(),form=randomUUID(),organisation=randomUUID();
sql(`insert into auth.users(id,email,raw_user_meta_data) values('${owner}','worker@example.invalid','{}');update public.profiles set status='active',default_role='platform_owner',user_type='platform' where id='${owner}';
insert into public.organisations(id,name,organisation_type,status) values('${organisation}','Synthetic worker organisation','internal','active');
insert into public.memberships(user_id,organisation_id,role,status) values('${owner}','${organisation}','platform_owner','active');
insert into exam_delivery.package_versions(id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,package_schema_version,generator_version,scorer_version,status,declared_review_release_policy,declared_answer_release_policy)
values('${pkg}','issue201worker','1.0.0',repeat('1',40),repeat('2',64),repeat('3',64),'certsim-protected-package-v2','certsim-az400-case-workspace-generator-v1','certsim-selected-response-partial-v1','draft','after_submission','after_submission');
insert into exam_delivery.package_profiles(id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config) values
('${profile}','${pkg}','full','Synthetic noncanonical',8,1,'{}'),('${canonical}','${pkg}','canonical','Synthetic canonical',8,1,'{}');
insert into exam_delivery.package_questions(id,package_version_id,question_id,question_type,domain_key,source_ordinal,presentation_payload,content_hash)
select gen_random_uuid(),'${pkg}','synthetic-'||n,'multi-select','d1',n,'{"prompt":"Synthetic SENSITIVE_SENTINEL","options":[{"id":"a","text":"A"},{"id":"b","text":"B"},{"id":"c","text":"C"}],"requiredSelections":2}',repeat('4',64) from generate_series(1,8) n;
insert into exam_delivery.package_question_protected_content(question_id,package_version_id,scoring_payload,review_payload,authoring_metadata)
select id,'${pkg}','{"model":"per-correct-option-no-negative-v1","correctAnswers":["a","b"],"selectionCap":2,"maximumRawPoints":2}','{"explanation":"Synthetic SENSITIVE_SENTINEL"}','{"scored":true}' from exam_delivery.package_questions where package_version_id='${pkg}';
insert into exam_delivery.package_forms(id,package_version_id,package_profile_id,form_key,form_ordinal,question_count,membership_hash,blueprint_contract) values('${form}','${pkg}','${canonical}','a',1,8,repeat('5',64),'{}');
insert into exam_delivery.package_form_questions(form_id,package_profile_id,package_version_id,package_question_id,presentation_ordinal) select '${form}','${canonical}','${pkg}',id,source_ordinal from exam_delivery.package_questions where package_version_id='${pkg}';
update exam_delivery.package_versions set status='published',published_at=clock_timestamp() where id='${pkg}';
insert into public.exam_catalog(exam_key,slug,title,lifecycle,exam_type,current_version,status) values('issue201worker','worker-fixture','Synthetic worker','production_ready','certification','1.0.0','active');
insert into exam_delivery.exam_access_policies(canonical_exam_key,access_mode,enabled,enabled_at) values('issue201worker','open_authenticated',true,now());
insert into exam_delivery.exam_profile_activations(package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by) values('${pkg}','${profile}',true,'production',now(),'${owner}'),('${pkg}','${canonical}',true,'production',now(),'${owner}');
insert into exam_delivery.package_profile_defaults(canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,configured_by) values
('issue201worker','full','assigned_assessment','${pkg}','${profile}','${owner}'),('issue201worker','canonical','assigned_assessment','${pkg}','${canonical}','${owner}'),('issue201worker','full','self_directed_exam','${pkg}','${profile}','${owner}');
insert into exam_delivery.practice_policies(canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy) values('issue201worker','1.0.0','full','self_directed_exam','open_authenticated',true,10,false,'after_submission','after_submission');
-- Test-only deadline compression at ordinary creation, not historical mutation.
create function public.issue201_worker_fixture_clock() returns trigger language plpgsql as $$begin if new.package_version_id='${pkg}'::uuid then new.expires_at=clock_timestamp()+interval '3 seconds';end if;return new;end$$;
create trigger issue201_worker_fixture_clock before insert on exam_delivery.attempts for each row execute function public.issue201_worker_fixture_clock();`);
function start({self=false,canon=false}={}) {const request=randomUUID();const r=self?json(`set role service_role;select public.certsim_protected_start_practice('${owner}','${JSON.stringify({examKey:'issue201worker',profileId:'full',purpose:'self_directed_exam',count:8,language:'not_applicable',includePbqs:true,mixStrategy:'balanced',clientRequestId:request})}')`):json(`set role service_role;select public.certsim_protected_start_attempt('${owner}','issue201worker','${canon?'canonical':'full'}','${request}')`);eq(r.ok,true);return r.attempt.attemptId;}
// Different owners avoid normal active-attempt reuse; use the existing supported
// lifecycle to abandon only fixture attempts where a fresh start is needed.
function newOwner(){const id=randomUUID();sql(`insert into auth.users(id,email,raw_user_meta_data) values('${id}','${id}@example.invalid','{}');update public.profiles set status='active',default_role='platform_owner',user_type='platform' where id='${id}';insert into public.memberships(user_id,organisation_id,role,status) values('${id}','${organisation}','platform_owner','active');`);return id;}
function fresh(canon=false,self=false){const id=newOwner(),request=randomUUID();const r=self?json(`set role service_role;select public.certsim_protected_start_practice('${id}','${JSON.stringify({examKey:'issue201worker',profileId:'full',purpose:'self_directed_exam',count:8,language:'not_applicable',includePbqs:true,mixStrategy:'balanced',clientRequestId:request})}')`):json(`set role service_role;select public.certsim_protected_start_attempt('${id}','issue201worker','${canon?'canonical':'full'}','${request}')`);eq(r.ok,true);return {id:r.attempt.attemptId,owner:id};}
const historical=start();eq(sql(`select count(*) from exam_delivery.expiry_authority where attempt_id='${historical}'`),'0');
sql('select exam_delivery.set_expiry_enrolment(true)');
const central=fresh(true), item=sql(`select id from exam_delivery.attempt_items where attempt_id='${central.id}' order by presented_question_number limit 1`);
eq(json(`set role service_role;select public.certsim_protected_save_response('${central.owner}','${central.id}','${item}','{"answer":["a","c"]}',0,'${randomUUID()}')`).ok,true);
await sleep(3200);
const events=sql('select count(*) from exam_delivery.expiry_events');eq((await worker()).data.state,'disabled');eq(sql('select count(*) from exam_delivery.expiry_events'),events);
sql('select exam_delivery.set_expiry_worker(true)');
const first=await worker();eq({status:first.status,state:first.data.state,completed:first.data.completed},{status:200,state:'idle',completed:1});
eq(json(`select jsonb_build_array(raw_score,max_score) from exam_delivery.attempt_results where attempt_id='${central.id}'`),[1,16]);
eq(sql(`select count(*) from public.exam_results where attempt_id='${central.id}'`),'1');eq(sql(`select count(*) from public.exam_reports where attempt_id='${central.id}'`),'1');
eq(sql(`select reason||':'||(effective_at=(select expires_at from exam_delivery.attempts where id='${central.id}')) from exam_delivery.expiry_bindings where attempt_id='${central.id}'`),'time_limit_expiry:true');
eq((await worker()).data.completed,0);eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${central.id}'`),'1');
console.log('WORKER_BROWSER_INDEPENDENT=PASS_normal_start_saved_partial_no_submit_one_result');
const batch=Array.from({length:7},(_,n)=>fresh(n%2===0,n%2===1));await sleep(3200);
eq((await worker()).data.claimed,5);eq((await worker()).data.completed,2);
const future=fresh();eq((await worker()).data.claimed,0);await sleep(3200);
const concurrent=Array.from({length:8},()=>fresh());await sleep(3200);
const both=await Promise.all([worker(),worker()]);eq(both.reduce((n,r)=>n+r.data.completed,0),9);
eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id in (${concurrent.map(a=>`'${a.id}'`).join(',')})`),'8');
console.log('WORKER_BATCH_CONCURRENCY=PASS_limit_five_distinct_results');
// Claim/reconcile over actual PostgREST operations; no log of opaque references.
const crash=fresh();await sleep(3200);let claim=await rpc('certsim_service_claim_next_expiry');
if(claim.outcome==='empty')claim=await rpc('certsim_service_claim_next_expiry');eq(claim.attemptId,crash.id);
eq((await worker()).data.claimed,0);await sleep(30_200);
let newer=await rpc('certsim_service_claim_next_expiry');if(newer.outcome==='empty')newer=await rpc('certsim_service_claim_next_expiry');eq(newer.attemptId,crash.id);
eq((await rpc('certsim_service_reconcile_expiry',{p_attempt_id:crash.id,p_token:claim.leaseToken})).outcome,'stale');
eq((await rpc('certsim_service_finish_expiry',{p_attempt_id:crash.id,p_token:newer.leaseToken})).outcome,'completed');
eq((await rpc('certsim_service_reconcile_expiry',{p_attempt_id:crash.id,p_token:claim.leaseToken})).outcome,'completed');
eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${crash.id}'`),'1');
console.log('WORKER_LEASE_RECONCILIATION=PASS_crash_reclaim_stale_lost_committed_response');
const bad=fresh(),good=fresh();await sleep(3200);
sql(`create function public.issue201_worker_fault() returns trigger language plpgsql as $$begin if new.attempt_id='${bad.id}'::uuid then raise exception 'synthetic transient' using errcode='40001';end if;return new;end$$;create trigger issue201_worker_fault before insert on public.exam_reports for each row execute function public.issue201_worker_fault();`);
const isolation=await worker();eq(isolation.data.completed,1);eq(isolation.data.deferred,1);eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${bad.id}'`),'0');eq(sql(`select state||':'||(retry_after>clock_timestamp()) from exam_delivery.expiry_processing where attempt_id='${bad.id}'`),'retry:true');
eq((await worker()).data.claimed,0);sql('drop trigger issue201_worker_fault on public.exam_reports;drop function public.issue201_worker_fault()');
const abandon=fresh();await sleep(3200);let ac=await rpc('certsim_service_claim_next_expiry');if(ac.outcome==='empty')ac=await rpc('certsim_service_claim_next_expiry');eq(ac.attemptId,abandon.id);
sql(`update exam_delivery.attempts set status='abandoned' where id='${abandon.id}'`);eq((await rpc('certsim_service_finish_expiry',{p_attempt_id:abandon.id,p_token:ac.leaseToken})).outcome,'blocked');eq(sql(`select status from exam_delivery.attempts where id='${abandon.id}'`),'abandoned');
// Real concurrent row locks: the leading locked record cannot block the next.
const leading=fresh(),behind=fresh();await sleep(3200);
const lock=spawn(psql,[db,'-XqAt','-v','ON_ERROR_STOP=1']);let output='';lock.stdout.on('data',b=>output+=b);
const lockedDone=new Promise((resolve,reject)=>{lock.on('error',reject);lock.on('close',n=>n?reject(Error('lock fixture failed')):resolve());});
lock.stdin.write(`begin;select id from exam_delivery.attempts where id='${leading.id}' for update;select 'READY';\n`);
for(let n=0;!output.includes('READY');n++){if(n>100)throw Error('lock fixture not ready');await sleep(20);}
const skip=await worker();eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${behind.id}'`),'1');eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${leading.id}'`),'0');
lock.stdin.end('commit;\n');await lockedDone;
await worker();await worker();eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${leading.id}'`),'1');
// Timely manual freeze survives until worker processing, with no new identity.
const frozen=fresh(false,true),submission=randomUUID();
eq(json(`set role service_role;select public.certsim_service_prepare_python_submission_grading('${frozen.owner}','${frozen.id}','${submission}')`).ok,true);
await sleep(3200);await worker();await worker();
eq(sql(`select reason||':'||submission_id from exam_delivery.expiry_bindings where attempt_id='${frozen.id}'`),'manual:'+submission);
// Exercise the original real manual Lab suite in the same isolated database,
// then prove executable attempts are excluded even with no workspace.
const lab=spawnSync(process.execPath,['scripts/test-issue201-review-corrections.mjs'],{env:process.env,encoding:'utf8'});if(lab.status)throw Error(lab.stderr);console.log(lab.stdout.trim().split(/\r?\n/).at(-1));
const pyBefore=sql(`select count(*) from exam_delivery.attempt_results r join exam_delivery.attempts a on a.id=r.attempt_id where a.package_version_id='86000000-0000-4000-8000-000000000020'`);
await worker();eq(sql(`select count(*) from exam_delivery.expiry_processing p join exam_delivery.attempt_items i on i.attempt_id=p.attempt_id join exam_delivery.package_questions q on q.id=i.package_question_id where q.question_type='executable-python-lab-v1' and p.generation<>0`),'0');
eq(sql(`select count(*) from exam_delivery.attempt_results r join exam_delivery.attempts a on a.id=r.attempt_id where a.package_version_id='86000000-0000-4000-8000-000000000020'`),pyBefore);
console.log('WORKER_LOCK_MANUAL_EXECUTABLE=PASS_skip_locked_frozen_identity_no_python_processing');
// The original fixed claim operation exercises the unchanged generation cap
// without a 450-second wait. New discovery's real backoff denial was tested.
sql(`create function public.issue201_worker_fault() returns trigger language plpgsql as $$begin if new.attempt_id='${bad.id}'::uuid then raise exception 'synthetic transient' using errcode='40001';end if;return new;end$$;create trigger issue201_worker_fault before insert on public.exam_reports for each row execute function public.issue201_worker_fault();`);
for(let generation=2;generation<=5;generation++) {
 const bc=json(`set role service_role;select exam_delivery.claim_expiry('${bad.id}')`);
 eq(bc.ok,true);eq((await rpc('certsim_service_finish_expiry',{p_attempt_id:bad.id,p_token:bc.leaseToken})).outcome,generation===5?'exhausted':'deferred');
 eq(sql(`select generation from exam_delivery.expiry_processing where attempt_id='${bad.id}'`),String(generation));
}
sql('drop trigger issue201_worker_fault on public.exam_reports;drop function public.issue201_worker_fault()');
eq((await worker()).data.claimed,0);eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${bad.id}'`),'0');
sql('select exam_delivery.set_expiry_enrolment(true)');const permanent=fresh(),survivor=fresh();await sleep(3200);
sql(`create function public.issue201_worker_fault() returns trigger language plpgsql as $$begin if new.attempt_id='${permanent.id}'::uuid then raise exception 'synthetic contract violation' using errcode='23514';end if;return new;end$$;create trigger issue201_worker_fault before insert on public.exam_reports for each row execute function public.issue201_worker_fault();`);
await worker();await worker();eq(sql(`select state from exam_delivery.expiry_processing where attempt_id='${permanent.id}'`),'unsupported');eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${permanent.id}'`),'0');eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${survivor.id}'`),'1');
sql('drop trigger issue201_worker_fault on public.exam_reports;drop function public.issue201_worker_fault()');
console.log('WORKER_FAILURE_BOUNDS=PASS_backoff_five_generations_blocked_contract_isolation');
const raced=fresh(),racedSubmission=randomUUID();eq(json(`set role service_role;select public.certsim_service_prepare_python_submission_grading('${raced.owner}','${raced.id}','${racedSubmission}')`).ok,true);await sleep(3200);
let raceClaim;for(let n=0;n<4;n++){raceClaim=await rpc('certsim_service_claim_next_expiry');if(raceClaim.outcome==='claimed')break;}eq(raceClaim.attemptId,raced.id);
eq(json(`set role service_role;select public.certsim_protected_submit_attempt('${raced.owner}','${raced.id}','${racedSubmission}')`).ok,true);
eq((await rpc('certsim_service_finish_expiry',{p_attempt_id:raced.id,p_token:raceClaim.leaseToken})).outcome,'completed');eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${raced.id}'`),'1');
// Seventy synthetic blocked records exceed the hard 64-entry scan window.
// Creation is new fixture data, not historical enrolment or authority repair.
sql(`begin;insert into exam_delivery.attempts(id,owner_id,package_version_id,package_profile_id,client_request_id,status,generator_version,scorer_version,created_at,started_at,expires_at,purpose)
select gen_random_uuid(),'${owner}','${pkg}','${profile}',gen_random_uuid(),'in_progress','certsim-az400-case-workspace-generator-v1','certsim-selected-response-partial-v1',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '3 seconds','assigned_assessment' from generate_series(1,70);commit;
update exam_delivery.expiry_processing p set state='claimed',generation=1,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '30 seconds' from exam_delivery.attempts a where a.id=p.attempt_id and a.owner_id='${owner}' and p.state='pending';
update exam_delivery.expiry_processing p set state='unsupported',lease_token=null,lease_until=null from exam_delivery.attempts a where a.id=p.attempt_id and a.owner_id='${owner}' and p.state='claimed';`);
const tail=fresh();await sleep(3200);for(let n=0;n<5;n++)await worker();eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${tail.id}'`),'1');
console.log('WORKER_CURSOR_MANUAL_RACE=PASS_bounded_window_progress_manual_completion');
// Disabled shutdown preserves all pending records; existing live claims may
// complete, but the worker itself acquires no new work after gate shutdown.
sql('select exam_delivery.set_expiry_worker(false)');const preserved=sql(`select md5(jsonb_agg(to_jsonb(p) order by attempt_id)::text) from exam_delivery.expiry_processing p`);eq((await worker()).data.state,'disabled');eq(sql(`select md5(jsonb_agg(to_jsonb(p) order by attempt_id)::text) from exam_delivery.expiry_processing p`),preserved);
for(const credentials of [{},{apikey:process.env.SUPABASE_ANON_KEY},{apikey:'forged','x-role':'service_role'}])eq((await worker(credentials)).status,401);
eq((await worker({apikey:key},'?limit=999')).status,400);eq((await worker({apikey:key},'','SENSITIVE_SENTINEL')).status,400);
for(const role of ['anon','authenticated','service_role']) {
 const r=spawnSync(psql,[db,'-XqAt','-v','ON_ERROR_STOP=1'],{input:`set role ${role};select * from exam_delivery.expiry_worker_control`,encoding:'utf8'});eq(r.status===0,false);
 const denied=spawnSync(psql,[db,'-XqAt','-v','ON_ERROR_STOP=1'],{input:`set role ${role};select exam_delivery.set_expiry_worker(true)`,encoding:'utf8'});eq(denied.status===0,false);
}
for(const name of ['certsim_service_claim_next_expiry','certsim_service_finish_expiry','certsim_service_reconcile_expiry'])eq((await rpc(name,name.includes('claim')?{}:{p_attempt_id:central.id,p_token:randomUUID()},process.env.SUPABASE_ANON_KEY)).denied!==undefined,true);
// Real signed Auth sessions (learner, staff and UI owner) are not service keys.
for(const role of ['student','trainer','platform_owner']) {
 const email=`worker-${role}-${randomUUID()}@example.invalid`,password=randomUUID();
 const created=await fetch(`${api}/auth/v1/admin/users`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({email,password,email_confirm:true,app_metadata:{role}})});eq(created.ok,true);
 const actor=await created.json();sql(`update public.profiles set status='active' where id='${actor.id}';insert into public.memberships(user_id,organisation_id,role,status) values('${actor.id}','${organisation}','${role}','active');`);
 const login=await fetch(`${api}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password})});eq(login.ok,true);const token=(await login.json()).access_token;
 eq((await worker({apikey:process.env.SUPABASE_ANON_KEY,Authorization:`Bearer ${token}`})).status,401);
 eq((await worker({apikey:token,Authorization:`Bearer ${token}`})).status,401);
 for(const name of ['certsim_service_claim_next_expiry','certsim_service_finish_expiry','certsim_service_reconcile_expiry']) {
  const denied=await fetch(`${api}/rest/v1/rpc/${name}`,{method:'POST',headers:{apikey:process.env.SUPABASE_ANON_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(name.includes('claim')?{}:{p_attempt_id:central.id,p_token:randomUUID()})});eq(denied.ok,false);
 }
}
sql('select exam_delivery.set_expiry_enrolment(false)');
console.log(JSON.stringify({suite:'issue201-worker-integration',assertions,productionActions:0,providerCalls:0,syntheticOnly:true}));
