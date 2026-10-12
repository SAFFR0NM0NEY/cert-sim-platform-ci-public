import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
const databaseUrl=process.env.SUPABASE_DB_URL;
if (!databaseUrl || !['127.0.0.1','localhost','[::1]'].includes(new URL(databaseUrl).hostname)) throw Error('DISPOSABLE_LOOPBACK_DATABASE_REQUIRED');
const psql=process.env.PSQL_PATH || 'psql';
const ids = Object.freeze({
  owner: '20140000-0000-4000-8000-000000000001',
  learner: '20140000-0000-4000-8000-000000000002',
  other: '20140000-0000-4000-8000-000000000003',
  organisation: '20140000-0000-4000-8000-000000000004',
  predecessorPackage: '20140000-0000-4000-8000-000000000010',
  predecessorProfile: '20140000-0000-4000-8000-000000000011',
  predecessorQuestion: '20140000-0000-4000-8000-000000000012',
  successorPackage: '20140000-0000-4000-8000-000000000020',
  successorProfile: '20140000-0000-4000-8000-000000000021',
  successorQuestion: '20140000-0000-4000-8000-000000000022',
  feedbackAttempt: '20140000-0000-4000-8000-000000000030',
  feedbackItem: '20140000-0000-4000-8000-000000000031',
  withheldAttempt: '20140000-0000-4000-8000-000000000032',
  withheldItem: '20140000-0000-4000-8000-000000000033',
  idleExpiredAttempt: '20140000-0000-4000-8000-000000000034',
  assignment: '20140000-0000-4000-8000-000000000040',
});
const examKey = 'issue201fixture';
const profileKey = 'full';

const successorPackageHash='b'.repeat(64),successorValidationHash='d'.repeat(64);
const passed=[];
function pass(name){passed.push(name);console.log(`PASS ${name}`);}
function execute(sql){return spawnSync(psql,[databaseUrl,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],{input:sql,encoding:'utf8'});}
function run(sql){const r=execute(sql);if(r.status!==0)throw Error(r.stderr);return r.stdout.trim();}
function scalar(sql){return run(sql);}
function json(sql){return JSON.parse(run(sql));}
function reject(sql,pattern){const r=execute(sql);assert.notEqual(r.status,0);assert.match(r.stderr,pattern);}
function sqlJson(x){return "'"+JSON.stringify(x).replaceAll("'","''")+"'::jsonb";}
function uid(n){return '20160000-0000-4000-8000-'+String(n).padStart(12,'0');}
function seedFixture() {
  run(`
begin;
insert into auth.users(id,email,raw_user_meta_data) values
  ('${ids.owner}','issue201-owner@example.invalid','{}'::jsonb),
  ('${ids.learner}','issue201-learner@example.invalid','{}'::jsonb),
  ('${ids.other}','issue201-other@example.invalid','{}'::jsonb);
insert into public.profiles(id,email,user_type,default_role,status) values
  ('${ids.owner}','issue201-owner@example.invalid','platform','platform_owner','active'),
  ('${ids.learner}','issue201-learner@example.invalid','individual','student','active'),
  ('${ids.other}','issue201-other@example.invalid','individual','student','active')
on conflict(id) do update set status='active';
insert into public.organisations(id,name,organisation_type,status)
values('${ids.organisation}','Issue 133 disposable fixture','internal','active');
insert into public.memberships(user_id,organisation_id,role,status) values
  ('${ids.owner}','${ids.organisation}','platform_owner','active'),
  ('${ids.learner}','${ids.organisation}','student','active'),
  ('${ids.other}','${ids.organisation}','student','active');

insert into exam_delivery.package_versions(
  id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,
  package_schema_version,generator_version,scorer_version,status,
  declared_review_release_policy,declared_answer_release_policy
) values
  ('${ids.predecessorPackage}','${examKey}','1.0.0','${'1'.repeat(40)}','${'c'.repeat(64)}','${'a'.repeat(64)}',
   'certsim-protected-package-v2','certsim-az400-case-workspace-generator-v1','certsim-az400-authoritative-scorer-v1','draft','after_submission','after_submission'),
  ('${ids.successorPackage}','${examKey}','2.0.0','${'2'.repeat(40)}','${successorValidationHash}','${successorPackageHash}',
   'certsim-protected-package-v2','certsim-az400-case-workspace-generator-v1','certsim-az400-authoritative-scorer-v1','draft','after_submission','after_submission');
insert into exam_delivery.package_profiles(
  id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config
) values
  ('${ids.predecessorProfile}','${ids.predecessorPackage}','${profileKey}','Predecessor full',1,30,'{}'::jsonb),
  ('${ids.successorProfile}','${ids.successorPackage}','${profileKey}','Successor full',1,30,'{}'::jsonb);
insert into exam_delivery.package_questions(
  id,package_version_id,question_id,question_type,domain_key,source_ordinal,presentation_payload,content_hash
) values
  ('${ids.predecessorQuestion}','${ids.predecessorPackage}','fixture-predecessor','single-choice','d1',1,
   '{"prompt":"Synthetic fixture","options":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}'::jsonb,'${'3'.repeat(64)}'),
  ('${ids.successorQuestion}','${ids.successorPackage}','fixture-successor','single-choice','d1',1,
   '{"prompt":"Synthetic fixture","options":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}'::jsonb,'${'4'.repeat(64)}');
insert into exam_delivery.package_question_protected_content(
  question_id,package_version_id,scoring_payload,review_payload,authoring_metadata
) values
  ('${ids.predecessorQuestion}','${ids.predecessorPackage}','{"correctAnswer":"a"}'::jsonb,
   '{"explanation":"Synthetic fixture","correctAnswer":"a"}'::jsonb,'{"scored":true}'::jsonb),
  ('${ids.successorQuestion}','${ids.successorPackage}','{"correctAnswer":"a"}'::jsonb,
   '{"explanation":"Synthetic fixture","correctAnswer":"a"}'::jsonb,'{"scored":true}'::jsonb);
insert into exam_delivery.package_questions(id,package_version_id,question_id,question_type,domain_key,source_ordinal,presentation_payload,content_hash)
values('${uid(900)}','${ids.predecessorPackage}','fixture-partial','multi-select','d1',2,
'{"prompt":"Synthetic fixture","options":[{"id":"a","text":"A"},{"id":"b","text":"B"},{"id":"c","text":"C"}],"requiredSelections":2}',repeat('a',64)),
('${uid(901)}','${ids.predecessorPackage}','fixture-executable','executable-python-lab-v1','d1',3,'{"prompt":"Synthetic fixture"}',repeat('b',64));
insert into exam_delivery.package_questions(id,package_version_id,question_id,question_type,domain_key,source_ordinal,presentation_payload,content_hash)
select '${uid(902)}',package_version_id,'fixture-unanswered',question_type,domain_key,4,presentation_payload,repeat('c',64)
from exam_delivery.package_questions where id='${uid(900)}';
insert into exam_delivery.package_question_protected_content(question_id,package_version_id,scoring_payload,review_payload,authoring_metadata)
values('${uid(900)}','${ids.predecessorPackage}','{"model":"per-correct-option-no-negative-v1","correctAnswers":["a","b"],"selectionCap":2,"maximumRawPoints":2}','{"explanation":"Synthetic fixture"}','{"scored":true}'),
('${uid(901)}','${ids.predecessorPackage}','{"maximumRawPoints":1}','{"explanation":"Synthetic fixture"}','{"scored":true}');
insert into exam_delivery.package_question_protected_content(question_id,package_version_id,scoring_payload,review_payload,authoring_metadata)
select '${uid(902)}',package_version_id,scoring_payload,review_payload,authoring_metadata
from exam_delivery.package_question_protected_content where question_id='${uid(900)}';
update exam_delivery.package_versions set status='published',published_at=statement_timestamp()
where id in ('${ids.predecessorPackage}','${ids.successorPackage}');

insert into public.exam_catalog(exam_key,slug,title,lifecycle,exam_type,current_version,status)
values('${examKey}','issue201-fixture','Issue 133 fixture','production_ready','certification','1.0.0','active');
insert into exam_delivery.exam_profile_activations(
  package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by
) values('${ids.predecessorPackage}','${ids.predecessorProfile}',true,'production',statement_timestamp(),'${ids.owner}');
insert into exam_delivery.package_profile_defaults(
  canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,enabled,configured_by
)
select '${examKey}','${profileKey}',purpose,'${ids.predecessorPackage}','${ids.predecessorProfile}',true,'${ids.owner}'
from unnest(enum_range(null::exam_delivery.attempt_purpose)) purpose;
insert into exam_delivery.practice_policies(
  canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
  maximum_completed_attempts,cooldown_seconds,maximum_concurrent_sessions,
  maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy
) values
  ('${examKey}','1.0.0','${profileKey}','self_directed_exam','production_authorized',true,null,0,1,10,false,'after_submission','after_submission'),
  ('${examKey}','1.0.0','${profileKey}','study_sandbox','production_authorized',true,null,0,1,10,true,'immediate_study_feedback','immediate_study_feedback'),
  ('${examKey}','1.0.0','${profileKey}','targeted_domain','production_authorized',true,null,0,1,10,false,'after_submission','after_submission'),
  ('${examKey}','1.0.0','${profileKey}','weak_area','production_authorized',true,null,0,1,10,false,'never','never'),
  ('${examKey}','1.0.0','${profileKey}','pbq_practice','production_authorized',true,null,0,1,10,false,'after_submission','after_submission');

insert into public.exam_assignments(
  id,organisation_id,student_user_id,exam_key,profile_id,title,assignment_type,status,
  available_from,due_at,assigned_by,contract_version,package_version_id,
  package_profile_id,maximum_attempts,review_release_policy,answer_release_policy,
  creation_request_id
) values(
  '${ids.assignment}','${ids.organisation}','${ids.learner}','${examKey}','${profileKey}',
  'Issue 133 exact assignment','assessment','active',statement_timestamp()-interval '1 minute',
  statement_timestamp()+interval '1 day','${ids.owner}','live-v2','${ids.predecessorPackage}',
  '${ids.predecessorProfile}',2,'after_submission','never',
  '20140000-0000-4000-8000-000000000041'
);

insert into exam_delivery.attempts(
  id,owner_id,package_version_id,package_profile_id,client_request_id,status,
  generator_version,scorer_version,created_at,started_at,expires_at,purpose,
  practice_last_activity_at,practice_idle_expires_at,attribution_source
) values
  ('${ids.feedbackAttempt}','${ids.learner}','${ids.predecessorPackage}','${ids.predecessorProfile}',
   '20140000-0000-4000-8000-000000000130','in_progress','certsim-az400-case-workspace-generator-v1',
   'certsim-az400-authoritative-scorer-v1',statement_timestamp(),statement_timestamp(),null,
   'study_sandbox',statement_timestamp(),statement_timestamp()+interval '2 hours','personal_self_directed'),
  ('${ids.withheldAttempt}','${ids.learner}','${ids.predecessorPackage}','${ids.predecessorProfile}',
   '20140000-0000-4000-8000-000000000132','in_progress','certsim-az400-case-workspace-generator-v1',
   'certsim-az400-authoritative-scorer-v1',statement_timestamp(),statement_timestamp(),null,
   'weak_area',statement_timestamp(),statement_timestamp()+interval '2 hours','personal_self_directed'),
  ('${ids.idleExpiredAttempt}','${ids.learner}','${ids.predecessorPackage}','${ids.predecessorProfile}',
   '20140000-0000-4000-8000-000000000134','in_progress','certsim-az400-case-workspace-generator-v1',
   'certsim-az400-authoritative-scorer-v1',statement_timestamp()-interval '2 hours',
   statement_timestamp()-interval '2 hours',null,'pbq_practice',statement_timestamp()-interval '2 hours',
   statement_timestamp()-interval '1 minute','personal_self_directed');
insert into exam_delivery.attempt_items(
  id,attempt_id,package_version_id,package_question_id,presented_question_number,
  option_order,presentation_snapshot,presentation_hash
) values
  ('${ids.feedbackItem}','${ids.feedbackAttempt}','${ids.predecessorPackage}','${ids.predecessorQuestion}',1,
   '[]'::jsonb,'{"prompt":"Synthetic fixture","options":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}'::jsonb,'${'5'.repeat(64)}'),
  ('${ids.withheldItem}','${ids.withheldAttempt}','${ids.predecessorPackage}','${ids.predecessorQuestion}',1,
   '[]'::jsonb,'{"prompt":"Synthetic fixture","options":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}'::jsonb,'${'6'.repeat(64)}');
insert into exam_delivery.attempt_item_protected_content(
  attempt_item_id,attempt_id,scoring_snapshot,review_snapshot,protected_snapshot_hash
) values
  ('${ids.feedbackItem}','${ids.feedbackAttempt}','{"correctAnswer":"a"}'::jsonb,
   '{"explanation":"Synthetic fixture","correctAnswer":"a"}'::jsonb,'${'7'.repeat(64)}'),
  ('${ids.withheldItem}','${ids.withheldAttempt}','{"correctAnswer":"a"}'::jsonb,
   '{"explanation":"Synthetic fixture","correctAnswer":"a"}'::jsonb,'${'8'.repeat(64)}');
commit;
  `);
}

function attempt(n,seconds=60,{executable=false,purpose='self_directed_exam',status='in_progress'}={}) {
  const owner=uid(n+10000), id=uid(n), item=uid(n+20000), second=uid(n+30000);
  run(`insert into auth.users(id,email,raw_user_meta_data) values('${owner}','fixture-${n}@example.invalid','{}');
    insert into public.profiles(id,email,user_type,default_role,status) values('${owner}','fixture-${n}@example.invalid','individual','student','active') on conflict(id) do update set status='active';
    insert into exam_delivery.attempts(id,owner_id,package_version_id,package_profile_id,client_request_id,status,generator_version,scorer_version,created_at,started_at,expires_at,purpose,practice_last_activity_at,practice_idle_expires_at,attribution_source)
    values('${id}','${owner}','${ids.predecessorPackage}','${ids.predecessorProfile}','${id}','${status}','certsim-az400-case-workspace-generator-v1','${executable?'certsim-python-trusted-grading-v1':'certsim-selected-response-partial-v1'}',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '2 hours',${purpose==='self_directed_exam'?"clock_timestamp()+interval '"+seconds+" seconds'":'null'},'${purpose}',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 minute','personal_self_directed');
    insert into exam_delivery.attempt_items(id,attempt_id,package_version_id,package_question_id,presented_question_number,option_order,presentation_snapshot,presentation_hash)
    select '${item}','${id}',package_version_id,id,1,'[]',presentation_payload,repeat('c',64) from exam_delivery.package_questions where id='${uid(executable?901:900)}';
    insert into exam_delivery.attempt_item_protected_content(attempt_item_id,attempt_id,scoring_snapshot,review_snapshot,protected_snapshot_hash)
    select '${item}','${id}',scoring_payload,review_payload,repeat('d',64) from exam_delivery.package_question_protected_content where question_id='${uid(executable?901:900)}';`);
  if (!executable) run(`insert into exam_delivery.attempt_items(id,attempt_id,package_version_id,package_question_id,presented_question_number,option_order,presentation_snapshot,presentation_hash)
    select '${second}','${id}',package_version_id,id,2,'[]',presentation_payload,repeat('c',64) from exam_delivery.package_questions where id='${uid(902)}';
    insert into exam_delivery.attempt_item_protected_content(attempt_item_id,attempt_id,scoring_snapshot,review_snapshot,protected_snapshot_hash)
    select '${second}','${id}',scoring_payload,review_payload,repeat('d',64) from exam_delivery.package_question_protected_content where question_id='${uid(902)}';`);
  return {id,owner,item};
}
function call(name,args){return json('select exam_delivery.'+name+'('+args+')::text');}
function claim(a){return json(`set role service_role;select exam_delivery.claim_expiry('${a.id}')::text;`);}
function finish(a,c){return json(`set role service_role;select exam_delivery.finalize_expiry('${a.id}','${c.leaseToken}')::text;`);}
function saveSql(a,request=50000){return `select exam_delivery.save_response('${a.owner}','${a.id}','${a.item}','{"answer":["a","c"]}',0,'${uid(request)}')::text;`;}
function submitSql(a,id=60000){return `select exam_delivery.submit_attempt_v2('${a.owner}','${a.id}','${uid(id)}')::text;`;}
function asyncSql(sql){
 const child=spawn(psql,[databaseUrl,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']});
 let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve(out.trim()):reject(Error(err)));});
 child.stdin.end(sql);return done;
}
async function holder(a,operation='') {
 const child=spawn(psql,[databaseUrl,'-X','-q','-A','-t','-v','ON_ERROR_STOP=1']);
 let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve(out):reject(Error(err)));});
 child.stdin.write(`begin;select id from exam_delivery.attempts where id='${a.id}' for update;${operation}select 'LOCK_READY';\n`);
 const until=Date.now()+5000;
 while(!out.includes('LOCK_READY')){if(Date.now()>until)throw Error('holder failed: '+err);await new Promise(r=>setTimeout(r,20));}
 return {release:async()=>{child.stdin.end('commit;\n');return done;}};
}
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitForLock(a){
  const until=Date.now()+1500;
  while(scalar(`select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%${a.id}%'`)==='0'){
    if(Date.now()>until)throw Error('competing session did not reach lock');await delay(20);
  }
}
seedFixture();
if (process.argv.includes('--seed-upgrade')) {
  const legacy=attempt(99,3600);
  assert.equal(scalar(`select count(*) from exam_delivery.attempts where id='${legacy.id}'`),'1');
  console.log('SYNTHETIC_UPGRADE_FIXTURE=PASS');
  process.exit(0);
}
assert.equal(scalar('select enabled from exam_delivery.expiry_activation'),'f');
assert.equal(scalar('select count(*) from exam_delivery.expiry_authority'),'0');
const legacy=attempt(1,-1);
assert.equal(claim(legacy).code,'not_enrolled');
assert.equal(JSON.parse(run(submitSql(legacy))).code,'invalid_lifecycle_transition');
const disabledTimely=attempt(18);
assert.equal(JSON.parse(run(saveSql(disabledTimely,50018))).ok,true);
assert.equal(JSON.parse(run(submitSql(disabledTimely,60018))).ok,true);
assert.equal(claim(disabledTimely).code,'not_enrolled');
pass('disabled parity / no enrolment or backfill');
run('select exam_delivery.set_expiry_enrolment(true)');
run(`insert into auth.users(id,email,raw_user_meta_data) values('${uid(10023)}','legacy-fixture@example.invalid','{}');
insert into exam_delivery.package_versions(id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,package_schema_version,generator_version,scorer_version)
values('${uid(920)}','issue201legacy','1.0.0',repeat('f',40),repeat('f',64),repeat('9',64),'certsim-protected-package-v1','synthetic-generator','synthetic-scorer');
insert into exam_delivery.package_profiles(id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config)
values('${uid(921)}','${uid(920)}','full','Synthetic legacy',1,30,'{}');
update exam_delivery.package_versions set status='published',published_at=clock_timestamp() where id='${uid(920)}';
insert into exam_delivery.attempts(id,owner_id,package_version_id,package_profile_id,client_request_id,generator_version,scorer_version,created_at,started_at,expires_at,purpose)
values('${uid(23)}','${uid(10023)}','${uid(920)}','${uid(921)}','${uid(23)}','synthetic-generator','synthetic-scorer',clock_timestamp(),clock_timestamp(),clock_timestamp()+interval '1 hour','assigned_assessment');`);
assert.equal(claim({id:uid(23)}).code,'not_enrolled');
pass('legacy package creation remains unchanged after activation');
const sandbox=attempt(2,60,{purpose:'study_sandbox'});
assert.equal(claim(sandbox).code,'not_enrolled');
assert.equal(claim(legacy).code,'not_enrolled');
const a=attempt(3,2);
assert.equal(JSON.parse(run(saveSql(a))).ok,true);
await delay(2200);
assert.equal(JSON.parse(run(saveSql(a,50001))).code,'invalid_lifecycle_transition');
const c=claim(a);assert.equal(c.ok,true);assert.equal(finish(a,c).ok,true);
assert.deepEqual(json(`select jsonb_build_array(raw_score,max_score)::text from exam_delivery.attempt_results where attempt_id='${a.id}'`),[1,4]);
assert.equal(scalar(`select reason||':'||(effective_at=(select expires_at from exam_delivery.attempts where id='${a.id}')) from exam_delivery.expiry_bindings where attempt_id='${a.id}'`),'time_limit_expiry:true');
assert.equal(finish(a,c).ok,true);
for(const t of ['exam_delivery.attempt_results','exam_delivery.review_snapshots','public.exam_results','public.exam_attempts','public.exam_reports']) assert.equal(scalar(`select count(*) from ${t} where ${t.endsWith('exam_attempts')?'id':'attempt_id'}='${a.id}'`),'1');
pass('timely partial credit / unanswered denominator / result projections / ambiguous commit replay');
const late=attempt(4,2);const h=await holder(late);const waiting=asyncSql(saveSql(late,50002));await waitForLock(late);assert.equal(scalar(`select clock_timestamp()<expires_at from exam_delivery.attempts where id='${late.id}'`),'t');await delay(2300);await h.release();assert.equal(JSON.parse(await waiting).code,'invalid_lifecycle_transition');
assert.equal(scalar(`select count(*) from exam_delivery.attempt_responses where attempt_id='${late.id}'`),'0');
pass('request before deadline / lock acquired after deadline denied');
const timely=attempt(5,2);const th=await holder(timely,saveSql(timely,50003));await delay(2300);const tc=asyncSql(`select exam_delivery.claim_expiry('${timely.id}')::text`);await th.release();assert.equal(finish(timely,JSON.parse(await tc)).ok,true);assert.equal(Number(scalar(`select raw_score from exam_delivery.attempt_results where attempt_id='${timely.id}'`)),1);
pass('guarded acceptance before expiry / commit after expiry included');
const manual=attempt(6,2);const mh=await holder(manual,submitSql(manual,60001));await delay(2300);const mc=asyncSql(`select exam_delivery.claim_expiry('${manual.id}')::text`);await mh.release();assert.equal(JSON.parse(await mc).completed,true);assert.equal(JSON.parse(run(submitSql(manual,60001))).ok,true);assert.equal(JSON.parse(run(submitSql(manual,60002))).code,'submission_conflict');assert.equal(scalar(`select reason from exam_delivery.expiry_bindings where attempt_id='${manual.id}'`),'manual');
pass('manual submission wins race / same identity / duplicate rejection');
const prepped=attempt(7,2);assert.equal(call('prepare_python_submission_grading',`'${prepped.owner}','${prepped.id}','${uid(60003)}'`).ok,true);await delay(2300);const pc=claim(prepped);assert.equal(finish(prepped,pc).ok,true);assert.equal(scalar(`select reason||':'||submission_id from exam_delivery.expiry_bindings where attempt_id='${prepped.id}'`),'manual:'+uid(60003));
pass('timely manual preparation reused by expiry finalizer');
const retry=attempt(8,1);await delay(1200);const r1=claim(retry);assert.equal(claim(retry).code,'lease_active');assert.equal(call('retry_expiry',`'${retry.id}','${r1.leaseToken}'`).ok,true);const r2=claim(retry);assert.equal(finish(retry,r1).code,'stale_lease');assert.equal(call('retry_expiry',`'${retry.id}','${r1.leaseToken}'`).code,'stale_lease');assert.equal(finish(retry,r2).ok,true);
pass('retry generation / stale lease holder rejected');
const lease=attempt(9,1);await delay(1200);const l1=claim(lease);await delay(30100);const l2=claim(lease);assert.equal(l2.generation,2);assert.equal(finish(lease,l1).code,'stale_lease');assert.equal(finish(lease,l2).ok,true);
pass('real expired lease reclaimed');
const rollback=attempt(10,1);await delay(1200);const rc=claim(rollback);
run(`create function public.issue201_fail() returns trigger language plpgsql as $$ begin if new.attempt_id='${rollback.id}'::uuid then raise exception 'synthetic_projection_failure'; end if;return new;end $$;create trigger issue201_fail before insert on public.exam_reports for each row execute function public.issue201_fail();`);
reject(`select exam_delivery.finalize_expiry('${rollback.id}','${rc.leaseToken}')`,/synthetic_projection_failure/);
for(const t of ['exam_delivery.attempt_results','exam_delivery.expiry_bindings','exam_delivery.review_snapshots','public.exam_results','public.exam_reports'])assert.equal(scalar(`select count(*) from ${t} where attempt_id='${rollback.id}'`),'0');
assert.equal(scalar(`select status from exam_delivery.attempts where id='${rollback.id}'`),'in_progress');
run('drop trigger issue201_fail on public.exam_reports;drop function public.issue201_fail()');assert.equal(finish(rollback,rc).ok,true);
pass('atomic rollback / no partial projections / same-claim retry');
const workerWins=attempt(15,1);await delay(1200);const wc=claim(workerWins);
const wh=await holder(workerWins,`select exam_delivery.finalize_expiry('${workerWins.id}','${wc.leaseToken}')::text;`);
const manualWait=asyncSql(submitSql(workerWins,60010));await wh.release();assert.equal(JSON.parse(await manualWait).code,'submission_conflict');
assert.equal(scalar(`select reason from exam_delivery.expiry_bindings where attempt_id='${workerWins.id}'`),'time_limit_expiry');
pass('finalizer wins manual race / expiry reason preserved');
const duplicate=attempt(16,1);await delay(1200);const dc=claim(duplicate);
const dupe=await Promise.all([1,2].map(()=>asyncSql(`select exam_delivery.finalize_expiry('${duplicate.id}','${dc.leaseToken}')::text`)));
assert.ok(dupe.every(x=>JSON.parse(x).ok));assert.equal(scalar(`select count(*) from exam_delivery.attempt_results where attempt_id='${duplicate.id}'`),'1');
pass('two-session duplicate finalizers converge');
const exhausted=attempt(17,1);await delay(1200);
for(let i=1;i<=5;i++){const ex=claim(exhausted);assert.equal(ex.generation,i);assert.equal(call('retry_expiry',`'${exhausted.id}','${ex.leaseToken}'`).ok,true);}
assert.equal(claim(exhausted).code,'claim_exhausted');pass('bounded retries');
for(const [n,status] of [[11,'abandoned'],[12,'voided']]){const x=attempt(n,1);run(`update exam_delivery.attempts set status='${status}' where id='${x.id}'`);await delay(1200);assert.equal(claim(x).code,'not_due');}
pass('abandoned / voided / practice idle / historical / completed exclusions');
const lazy=attempt(13,1);await delay(1200);run(`select exam_delivery.reconcile_expired_formal_attempts('${lazy.owner}','${ids.predecessorProfile}','assigned_assessment','zz')`);assert.equal(scalar(`select status from exam_delivery.attempts where id='${lazy.id}'`),'in_progress');assert.equal(finish(lazy,claim(lazy)).ok,true);pass('lazy reconciliation cannot strand enrolled attempt');
const python=attempt(14,1,{executable:true});assert.equal(JSON.parse(run(submitSql(python,60014))).code,'grading_incomplete');await delay(1200);const py=claim(python);assert.equal(finish(python,py).code,'executable_finalization_unsupported');assert.equal(scalar(`select count(*) from exam_delivery.attempt_results where attempt_id='${python.id}'`),'0');assert.equal(scalar(`select count(*) from exam_delivery.python_submission_grading_sessions where attempt_id='${python.id}'`),'0');pass('executable pending / no zero score or grading session');
const frozenReview=attempt(19,1);await delay(1200);
run(`update exam_delivery.practice_policies set review_release_policy='never',answer_release_policy='never' where canonical_exam_key='${examKey}' and purpose='self_directed_exam'`);
assert.equal(finish(frozenReview,claim(frozenReview)).ok,true);
assert.equal(scalar(`select release_status from exam_delivery.review_snapshots where attempt_id='${frozenReview.id}'`),'released');
run(`update exam_delivery.practice_policies set review_release_policy='after_submission',answer_release_policy='after_submission' where canonical_exam_key='${examKey}' and purpose='self_directed_exam'`);
pass('frozen review policy survives mutable default changes');
const assigned={id:uid(20),owner:ids.learner,item:uid(20020)};
run(`insert into exam_delivery.attempts(id,owner_id,package_version_id,package_profile_id,client_request_id,generator_version,scorer_version,created_at,started_at,expires_at,purpose,source_assignment_id,source_organisation_id,assignment_review_release_policy,assignment_answer_release_policy)
values('${assigned.id}','${assigned.owner}','${ids.predecessorPackage}','${ids.predecessorProfile}','${assigned.id}','certsim-az400-case-workspace-generator-v1','certsim-selected-response-partial-v1',clock_timestamp()-interval '2 hours',clock_timestamp()-interval '2 hours',clock_timestamp()+interval '1 second','assigned_assessment','${ids.assignment}','${ids.organisation}','never','never');
insert into exam_delivery.attempt_items(id,attempt_id,package_version_id,package_question_id,presented_question_number,option_order,presentation_snapshot,presentation_hash)
select '${assigned.item}','${assigned.id}',package_version_id,id,1,'[]',presentation_payload,repeat('c',64) from exam_delivery.package_questions where id='${uid(900)}';
insert into exam_delivery.attempt_item_protected_content(attempt_item_id,attempt_id,scoring_snapshot,review_snapshot,protected_snapshot_hash)
select '${assigned.item}','${assigned.id}',scoring_payload,review_payload,repeat('d',64) from exam_delivery.package_question_protected_content where question_id='${uid(900)}';`);
assert.equal(JSON.parse(run(saveSql(assigned,50020))).ok,true);await delay(1200);assert.equal(finish(assigned,claim(assigned)).ok,true);
assert.equal(scalar(`select source_assignment_id||':'||source_organisation_id from exam_delivery.attempts where id='${assigned.id}'`),ids.assignment+':'+ids.organisation);
assert.equal(scalar(`select release_status from exam_delivery.review_snapshots where attempt_id='${assigned.id}'`),'withheld');
pass('assignment attribution and never-release policy preserved');
const frozenPython=attempt(21,1,{executable:true});
run(`insert into exam_delivery.python_submission_grading_sessions(attempt_id,submission_id) values('${frozenPython.id}','${uid(60021)}')`);
await delay(1200);assert.equal(finish(frozenPython,claim(frozenPython)).pending,true);
assert.equal(scalar(`select submission_id from exam_delivery.expiry_bindings where attempt_id='${frozenPython.id}'`),uid(60021));
assert.equal(scalar(`select count(*) from exam_delivery.python_submission_grading_sessions where attempt_id='${frozenPython.id}'`),'1');
assert.equal(scalar(`select count(*) from exam_delivery.attempt_results where attempt_id='${frozenPython.id}'`),'0');
pass('existing pre-expiry Python identity retained without provider use');
const deliberate=attempt(22,1);
assert.equal(call('prepare_python_submission_grading',`'${deliberate.owner}','${deliberate.id}','${uid(60022)}'`).ok,true);
assert.equal(call('prepare_python_submission_grading',`null,'${deliberate.id}','${uid(60022)}'`).code,'invalid_request');
run(`update exam_delivery.attempts set status='abandoned' where id='${deliberate.id}'`);
assert.equal(call('prepare_python_submission_grading',`'${deliberate.owner}','${deliberate.id}','${uid(60022)}'`).code,'invalid_lifecycle_transition');
await delay(1200);assert.equal(claim(deliberate).code,'not_due');
pass('bound manual identity does not revive deliberate abandonment');
for(const role of ['anon','authenticated','service_role']){
 for(const table of ['expiry_authority','expiry_bindings','expiry_processing','expiry_events','expiry_activation'])reject(`set role ${role};select * from exam_delivery.${table}`,/permission denied/);
 reject(`set role ${role};select exam_delivery.set_expiry_enrolment(true)`,/permission denied/);
}
for(const role of ['anon','authenticated'])reject(`set role ${role};select exam_delivery.claim_expiry('${python.id}')`,/permission denied/);
reject(`set role authenticated;set request.jwt.claims='{"sub":"${ids.owner}","app_metadata":{"role":"platform_owner"}}';select exam_delivery.set_expiry_enrolment(true)`,/permission denied/);
reject(`set role service_role;select exam_delivery.score_expiry_non_executable('${a.owner}','${a.id}','${uid(9)}')`,/permission denied/);
reject(`select exam_delivery.save_response('${ids.other}','${python.id}','${python.item}','{}',0,'${uid(55555)}')`,/attempt_not_found/);
reject(`update exam_delivery.expiry_authority set deadline=clock_timestamp() where attempt_id='${a.id}'`,/append_only_mutation_denied/);
reject(`delete from exam_delivery.expiry_events where attempt_id='${a.id}'`,/append_only_mutation_denied/);
reject(`update exam_delivery.expiry_bindings set reason='manual' where attempt_id='${a.id}'`,/append_only_mutation_denied/);
reject(`update exam_delivery.attempts set scorer_version='synthetic-drift' where id='${a.id}'`,/immutable/);
pass('anonymous / learner / staff-role grants / service least privilege / cross-user / immutable authority and events');
run('select exam_delivery.set_expiry_enrolment(false)');
console.log(JSON.stringify({suite:'issue201-foundation',passed:passed.length,productionActions:0,providerCalls:0,syntheticOnly:true}));
