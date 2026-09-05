import { createClient } from '@supabase/supabase-js';
import { spawn, spawnSync } from 'node:child_process';
import { sha256Canonical } from './backend-exam-publication/canonical-json.mjs';

const url=required('SUPABASE_URL'),anon=required('SUPABASE_ANON_KEY'),service=required('SUPABASE_SERVICE_ROLE_KEY'),database=required('SUPABASE_DB_URL');
const admin=client(service),owner=await createUser('owner'),learner=await createUser('learner'),other=await createUser('other'),lowlevel=await createUser('lowlevel'),concurrentLearner=await createUser('concurrent');
const org=crypto.randomUUID();
sql(`insert into public.organisations(id,name,organisation_type,status) values ('${org}','Issue 21 synthetic fixture','internal','active');
insert into public.memberships(user_id,organisation_id,role,status) values ('${owner.id}','${org}','platform_owner','active'),('${learner.id}','${org}','student','active'),('${concurrentLearner.id}','${org}','student','active');
insert into public.exam_catalog(exam_key,slug,title,lifecycle,exam_type) values ('rotationfixture','rotation-fixture','Synthetic rotation','test','certification');
insert into exam_delivery.exam_access_policies(canonical_exam_key,access_mode,enabled,enabled_at,require_assignment) values ('rotationfixture','open_authenticated',true,now(),false);`);

const ids=Array.from({length:12},(_,index)=>`synthetic-${index+1}`);
const forms=ids.reduce((out,id,index)=>{out[index%6].push(id);return out},Array.from({length:6},()=>[]));
const canonical=(profileKey,questionCount,questionIds)=>({
  contractVersion:'certsim-canonical-forms-v2',profileKey,questionCount,cycleLength:6,
  reservePolicy:'practice-only-until-versioned-rebalance',reserveQuestionIds:[],
  skillGroupTargets:{'synthetic-skill':questionCount},requiredObjectiveKeys:['synthetic-objective'],
  minimumCoverageTagCounts:{'synthetic-coverage':1},
  difficultyRequirements:{minimumMedium:0,minimumHardOrAdvanced:0,minimumAdvanced:0},
  forms:questionIds.map((members,index)=>({formKey:`F${index+1}`,ordinal:index+1,questionIds:members,membershipHash:sha256Canonical(members)})),
});
const full=canonical('rotation-full',2,forms);
const compact=canonical('rotation-compact',1,forms.map(([first])=>[first]));
const payload={
  packageSchemaVersion:'certsim-protected-package-v2',validationContractVersion:'certsim-protected-multi-exam-validation-v1',
  exam:{examKey:'rotation-fixture',packageVersion:'1.0.0',capabilities:['single-choice'],domains:[{key:'d1',name:'Synthetic'}]},
  source:{sourceHash:'1'.repeat(64),validationHash:'2'.repeat(64)},runtime:{generatorVersion:'certsim-ai901-weighted-generator-v2',scorerVersion:'certsim-ai901-exact-scorer-v2'},
  profiles:[
    {profileKey:'rotation-full',displayName:'Synthetic full',questionCount:2,timeLimitMinutes:10,selection:{standardQuestionCount:2,preserveRequiredGroups:true,canonicalForms:full,formalReleasePolicy:{review:'after_submission',answers:'after_submission'}}},
    {profileKey:'rotation-compact',displayName:'Synthetic compact',questionCount:1,timeLimitMinutes:10,selection:{standardQuestionCount:1,preserveRequiredGroups:true,canonicalForms:compact,formalReleasePolicy:{review:'after_submission',answers:'after_submission'}}},
  ],
  releasePolicy:{review:'after_submission',answers:'after_submission'},supportedReleasePolicies:['after_submission'],
  questions:ids.map((id,index)=>({id,type:'single-choice',domainKey:'d1',sectionKey:'d1',scored:true,group:null,
    presentation:{prompt:`Synthetic prompt ${index+1}`,difficulty:'easy',officialSkillGroup:'synthetic-skill',officialObjectiveKey:'synthetic-objective',coverageTags:['synthetic-coverage'],options:[{id:'a',text:'A'},{id:'b',text:'B'}]},
    privateScoring:{correctAnswer:'a'},privateReview:{explanation:'Synthetic explanation',remediation:'Synthetic remediation'}})),
};
const ownerClient=await signedIn(owner);
const request={publicationRequestId:crypto.randomUUID(),sourceCommitSha:'f'.repeat(40),packagePayload:payload,packageHash:sha256Canonical(payload)};
const published=await ownerClient.rpc('certsim_protected_publish_package',{p_request:request});
if(published.error||published.data?.classification!=='new_candidate') fail('CANONICAL_PUBLICATION_FAILED');
const replay=await ownerClient.rpc('certsim_protected_publish_package',{p_request:request});
if(replay.error||replay.data?.classification!=='idempotent_replay') fail('CANONICAL_PUBLICATION_REPLAY_FAILED');
sql(`select 1/((count(*)=12)::integer) from exam_delivery.package_forms f join exam_delivery.package_versions pv on pv.id=f.package_version_id where pv.exam_key='rotationfixture';
select 1/((count(*)=18)::integer) from exam_delivery.package_form_questions fq join exam_delivery.package_forms f on f.id=fq.form_id join exam_delivery.package_versions pv on pv.id=f.package_version_id where pv.exam_key='rotationfixture';`);

for(const [label,mutate] of [
  ['cross-form',(p)=>{p.profiles[0].selection.canonicalForms.forms[1].questionIds[0]=p.profiles[0].selection.canonicalForms.forms[0].questionIds[0];refresh(p.profiles[0].selection.canonicalForms.forms[1])}],
  ['reserve-collision',(p)=>{p.profiles.forEach(({selection})=>selection.canonicalForms.reserveQuestionIds=[ids[0]])}],
  ['wrong-blueprint',(p)=>{p.profiles[0].selection.canonicalForms.skillGroupTargets['synthetic-skill']=1}],
  ['missing-objective',(p)=>{p.profiles[0].selection.canonicalForms.requiredObjectiveKeys=['missing-objective']}],
  ['missing-coverage',(p)=>{p.profiles[0].selection.canonicalForms.minimumCoverageTagCounts={'missing-coverage':1}}],
  ['invalid-hash',(p)=>{p.profiles[0].selection.canonicalForms.forms[0].membershipHash='0'.repeat(64)}],
  ['release-mismatch',(p)=>{p.profiles[0].selection.formalReleasePolicy={review:'never',answers:'never'}}],
  ['empty-targets',(p)=>{p.profiles[0].selection.canonicalForms.skillGroupTargets={}}],
  ['fractional-target',(p)=>{p.profiles[0].selection.canonicalForms.skillGroupTargets['synthetic-skill']=1.5}],
  ['wrong-target-total',(p)=>{p.profiles[0].selection.canonicalForms.skillGroupTargets['synthetic-skill']=3}],
  ['duplicate-objective',(p)=>{p.profiles[0].selection.canonicalForms.requiredObjectiveKeys=['synthetic-objective','synthetic-objective']}],
  ['empty-objective',(p)=>{p.profiles[0].selection.canonicalForms.requiredObjectiveKeys=['']}],
  ['negative-coverage',(p)=>{p.profiles[0].selection.canonicalForms.minimumCoverageTagCounts['synthetic-coverage']=-1}],
  ['unexpected-difficulty-key',(p)=>{p.profiles[0].selection.canonicalForms.difficultyRequirements.unexpected=0}],
  ['missing-question-group',(p)=>{delete p.questions[0].presentation.officialSkillGroup}],
  ['undeclared-question-group',(p)=>{p.questions[0].presentation.officialSkillGroup='undeclared'}],
  ['missing-question-objective',(p)=>{delete p.questions[0].presentation.officialObjectiveKey}],
  ['malformed-coverage-tags',(p)=>{p.questions[0].presentation.coverageTags='synthetic-coverage'}],
  ['duplicate-coverage-tag',(p)=>{p.questions[0].presentation.coverageTags=['synthetic-coverage','synthetic-coverage']}],
  ['invalid-difficulty',(p)=>{p.questions[0].presentation.difficulty='expert'}],
  ['unexpected-contract-key',(p)=>{p.profiles[0].selection.canonicalForms.unexpected=true}],
  ['malformed-cycle',(p)=>{p.profiles[0].selection.canonicalForms.cycleLength='six'}],
  ['malformed-objectives',(p)=>{p.profiles[0].selection.canonicalForms.requiredObjectiveKeys={objective:true}}],
  ['empty-coverage-tag',(p)=>{p.questions[0].presentation.coverageTags=['']}],
]){
  const invalid=structuredClone(payload);invalid.exam.examKey=`rotation-${label}`;mutate(invalid);
  const invalidRequest={publicationRequestId:crypto.randomUUID(),sourceCommitSha:'e'.repeat(40),packagePayload:invalid,packageHash:sha256Canonical(invalid)};
  if(!(await ownerClient.rpc('certsim_protected_publish_package',{p_request:invalidRequest})).error) fail(`INVALID_${label.toUpperCase().replaceAll('-','_')}_ALLOWED`);
  sql(`select 1/((count(*)=0)::integer) from exam_delivery.package_versions where exam_key='rotation${label.replaceAll('-','')}';`);
}

const packageId=sqlValue("select id from exam_delivery.package_versions where exam_key='rotationfixture'");
const fullProfile=sqlValue(`select id from exam_delivery.package_profiles where package_version_id='${packageId}' and profile_key='rotation-full'`);
const compactProfile=sqlValue(`select id from exam_delivery.package_profiles where package_version_id='${packageId}' and profile_key='rotation-compact'`);
sql(`insert into exam_delivery.exam_profile_activations(package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by) values
('${packageId}','${fullProfile}',true,'production',now(),'${owner.id}'),('${packageId}','${compactProfile}',true,'production',now(),'${owner.id}');
insert into exam_delivery.exam_entitlements(package_version_id,package_profile_id,target_type,learner_id,enabled,valid_from,reason_code,created_by) values
('${packageId}','${fullProfile}','learner','${learner.id}',true,now()-interval '1 minute','issue21_fixture','${owner.id}'),
('${packageId}','${compactProfile}','learner','${learner.id}',true,now()-interval '1 minute','issue21_fixture','${owner.id}'),
('${packageId}','${fullProfile}','learner','${concurrentLearner.id}',true,now()-interval '1 minute','issue21_fixture','${owner.id}');
insert into exam_delivery.practice_policies(canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,maximum_completed_attempts,maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy) values
('rotationfixture','1.0.0','rotation-full','self_directed_exam','production_authorized',true,null,10,false,'after_submission','after_submission'),
('rotationfixture','1.0.0','rotation-full','study_sandbox','production_authorized',true,null,10,true,'immediate_study_feedback','immediate_study_feedback');`);

const baseRequest={examKey:'rotation-fixture',profileId:'rotation-full',purpose:'self_directed_exam',language:'not_applicable',includePbqs:true,mixStrategy:'balanced'};
const concurrentRequests=[1,2].map(()=>({...baseRequest,clientRequestId:crypto.randomUUID()}));
const concurrentStarts=await Promise.all(concurrentRequests.map((p_request)=>admin.rpc('certsim_protected_start_practice',{p_actor_id:concurrentLearner.id,p_request})));
const concurrentIds=new Set(concurrentStarts.filter(({data})=>data?.ok===true).map(({data})=>data.attempt.attemptId));
if(concurrentIds.size!==1) fail('CONCURRENT_PUBLIC_START_BOUNDARY_FAILED');
sql(`select 1/((count(*)=1)::integer) from exam_delivery.attempts where owner_id='${concurrentLearner.id}' and status='in_progress'; update exam_delivery.attempts set status='voided' where owner_id='${concurrentLearner.id}' and status='in_progress';`);

const firstRequest={...baseRequest,clientRequestId:crypto.randomUUID()};
const first=await admin.rpc('certsim_protected_start_practice',{p_actor_id:learner.id,p_request:firstRequest});
assertStarted(first,2,'FIRST_START');
const firstId=first.data.attempt.attemptId;
if('canonicalFormId' in first.data.attempt||JSON.stringify(first.data).includes('canonical_form')) fail('FORM_ID_EXPOSED');
const firstReplay=await admin.rpc('certsim_protected_start_practice',{p_actor_id:learner.id,p_request:firstRequest});
if(firstReplay.error||firstReplay.data?.attempt?.attemptId!==firstId) fail('START_REPLAY_FAILED');
const resumed=await admin.rpc('certsim_protected_resume_attempt',{p_actor_id:learner.id,p_attempt_id:firstId});
if(resumed.error||JSON.stringify(resumed.data?.items)!==JSON.stringify(first.data.items)) fail('RESUME_PARITY_FAILED');
const deniedResume=await admin.rpc('certsim_protected_resume_attempt',{p_actor_id:other.id,p_attempt_id:firstId});
expectDenied(deniedResume,'CROSS_LEARNER_RESUME');
const injected=await admin.rpc('certsim_protected_start_practice',{p_actor_id:learner.id,p_request:{...baseRequest,canonicalFormId:crypto.randomUUID(),clientRequestId:crypto.randomUUID()}});
if(injected.error||injected.data?.ok!==false||injected.data?.code!=='invalid_request') fail('CLIENT_FORM_ID_ACCEPTED');
const injectedReplacement=await admin.rpc('certsim_protected_replace_current_practice_attempt',{p_actor_id:learner.id,p_request:{...baseRequest,canonical_form_id:crypto.randomUUID(),clientRequestId:crypto.randomUUID()}});
if(injectedReplacement.error||injectedReplacement.data?.ok!==false||injectedReplacement.data?.code!=='invalid_request') fail('CLIENT_REPLACEMENT_FORM_ID_ACCEPTED');

const rollbackRequest={...baseRequest,clientRequestId:crypto.randomUUID()};
sql(`create function exam_delivery.issue21_reject_attempt() returns trigger language plpgsql set search_path='' as $$begin if new.client_request_id='${rollbackRequest.clientRequestId}'::uuid then raise exception 'synthetic_replacement_failure';end if;return new;end$$; create trigger issue21_reject_attempt before insert on exam_delivery.attempts for each row execute function exam_delivery.issue21_reject_attempt();`);
const rolledBack=await admin.rpc('certsim_protected_replace_current_practice_attempt',{p_actor_id:learner.id,p_request:rollbackRequest});
if(rolledBack.error||rolledBack.data?.ok!==false) fail('REPLACEMENT_FAILURE_NOT_MAPPED');
sql(`drop trigger issue21_reject_attempt on exam_delivery.attempts; drop function exam_delivery.issue21_reject_attempt();`);
const afterRollback=await admin.rpc('certsim_protected_resume_attempt',{p_actor_id:learner.id,p_attempt_id:firstId});
if(afterRollback.error||afterRollback.data?.attempt?.attemptId!==firstId) fail('REPLACEMENT_ROLLBACK_LOST_OLD_ATTEMPT');

const replacementRequest={...baseRequest,clientRequestId:crypto.randomUUID()};
const replacement=await admin.rpc('certsim_protected_replace_current_practice_attempt',{p_actor_id:learner.id,p_request:replacementRequest});
assertStarted(replacement,2,'REPLACEMENT');
const replacementId=replacement.data.attempt.attemptId;
if(replacementId===firstId) fail('REPLACEMENT_REUSED_ATTEMPT');
sql(`select 1/((a.canonical_form_id is distinct from b.canonical_form_id)::integer) from exam_delivery.attempts a,exam_delivery.attempts b where a.id='${firstId}' and b.id='${replacementId}';`);
const deniedReplace=await admin.rpc('certsim_protected_replace_current_practice_attempt',{p_actor_id:other.id,p_request:{...baseRequest,clientRequestId:crypto.randomUUID()}});
expectDenied(deniedReplace,'CROSS_LEARNER_REPLACE');
await complete(replacement,learner.id);
const released=await admin.rpc('certsim_protected_get_review',{p_actor_id:learner.id,p_attempt_id:replacementId});
if(released.error||released.data?.ok!==true) fail('SELF_DIRECTED_REVIEW_NOT_RELEASED');
const deniedResult=await admin.rpc('certsim_protected_get_result',{p_actor_id:other.id,p_attempt_id:replacementId});
expectDenied(deniedResult,'CROSS_LEARNER_RESULT');

const practiceRequest={examKey:'rotation-fixture',profileId:'rotation-full',purpose:'study_sandbox',language:'not_applicable',includePbqs:true,mixStrategy:'balanced',clientRequestId:crypto.randomUUID()};
const practiceStarted=await admin.rpc('certsim_protected_start_practice',{p_actor_id:learner.id,p_request:practiceRequest});
assertStarted(practiceStarted,12,'PRACTICE_START');
sql(`select 1/((canonical_form_id is null and canonical_form_cycle is null)::integer) from exam_delivery.attempts where id='${practiceStarted.data.attempt.attemptId}';`);
await complete(practiceStarted,learner.id);

const assignmentId=crypto.randomUUID();
sql(`update exam_delivery.exam_access_policies set access_mode='assignment_required',require_assignment=true where canonical_exam_key='rotationfixture';
insert into exam_delivery.protected_assignments(id,learner_id,organisation_id,package_version_id,package_profile_id,status,available_from,expires_at,maximum_attempts,review_release_policy,answer_release_policy,assigned_by) values ('${assignmentId}','${learner.id}','${org}','${packageId}','${fullProfile}','active',now()-interval '1 minute',now()+interval '1 day',1,'never','never','${owner.id}');`);
const assigned=await admin.rpc('certsim_protected_start_attempt',{p_actor_id:learner.id,p_exam_key:'rotation-fixture',p_profile_key:'rotation-full',p_request_id:crypto.randomUUID()});
assertStarted(assigned,2,'ASSIGNED_START');
await complete(assigned,learner.id);
const assignedReview=await admin.rpc('certsim_protected_get_review',{p_actor_id:learner.id,p_attempt_id:assigned.data.attempt.attemptId});
if(assignedReview.error||(assignedReview.data?.reasonCode??assignedReview.data?.code)!=='review_unavailable') fail('ASSIGNED_REVIEW_RELEASE_NOT_WITHHELD');
sql(`select 1/((count(distinct canonical_form_id)=3)::integer) from exam_delivery.attempts where owner_id='${learner.id}' and package_profile_id='${fullProfile}' and canonical_form_id is not null;`);

const allocated=[];
for(let index=0;index<7;index+=1){
  const purpose=index%2?'assigned_assessment':'self_directed_exam';
  const attempt=createAttempt(fullProfile,purpose);
  sql(`select 1/((exam_delivery.materialize_attempt_items('${attempt.id}','${attempt.request}',null)=2)::integer); update exam_delivery.attempts set status='voided' where id='${attempt.id}';`);
  allocated.push(sqlValue(`select canonical_form_cycle||':'||canonical_form_id from exam_delivery.attempts where id='${attempt.id}'`));
}
if(new Set(allocated.slice(0,6).map((entry)=>entry.split(':')[1])).size!==6||!allocated[6].startsWith('2:')||allocated[5].split(':')[1]===allocated[6].split(':')[1]) fail('ROTATION_CYCLE_FAILED');

const compactAttempt=createAttempt(compactProfile,'self_directed_exam');
sql(`select 1/((exam_delivery.materialize_attempt_items('${compactAttempt.id}','${compactAttempt.request}',null)=1)::integer); update exam_delivery.attempts set status='voided' where id='${compactAttempt.id}';`);
const beforePractice=sqlValue(`select count(*) from exam_delivery.attempts where owner_id='${lowlevel.id}' and canonical_form_id is not null`);
const practice=createAttempt(fullProfile,'study_sandbox');
sql(`select exam_delivery.materialize_attempt_items('${practice.id}','${practice.request}',2); update exam_delivery.attempts set status='voided' where id='${practice.id}';`);
if(sqlValue(`select count(*) from exam_delivery.attempts where owner_id='${lowlevel.id}' and canonical_form_id is not null`)!==beforePractice) fail('PRACTICE_CONSUMED_FORM');

const failed=createAttempt(fullProfile,'self_directed_exam');
sql(`create function exam_delivery.issue21_reject_item() returns trigger language plpgsql set search_path='' as $$begin raise exception 'synthetic_failure';end$$; create trigger issue21_reject_item before insert on exam_delivery.attempt_items for each row execute function exam_delivery.issue21_reject_item();`);
if(sqlStatus(`select exam_delivery.materialize_attempt_items('${failed.id}','${failed.request}',null)`)===0) fail('FAILED_MATERIALIZATION_ALLOWED');
sql(`drop trigger issue21_reject_item on exam_delivery.attempt_items; drop function exam_delivery.issue21_reject_item(); select 1/((canonical_form_id is null)::integer) from exam_delivery.attempts where id='${failed.id}'; update exam_delivery.attempts set status='voided' where id='${failed.id}';`);

const concurrentA=createAttempt(compactProfile,'assigned_assessment','voided');
const concurrentB=createAttempt(compactProfile,'self_directed_exam','voided');
await Promise.all([allocate(concurrentA.id),allocate(concurrentB.id)]);
sql(`select 1/((count(distinct canonical_form_id)=2)::integer) from exam_delivery.attempts where id in ('${concurrentA.id}','${concurrentB.id}');
select 1/((count(*)=0)::integer) from information_schema.role_table_grants where table_schema='exam_delivery' and table_name in ('package_forms','package_form_questions','package_reserve_questions') and grantee in ('anon','authenticated','service_role');`);
await ownerClient.auth.signOut({scope:'global'});
console.log(JSON.stringify({ok:true,publication:'atomic',forms:12,memberships:18,formalCycle:allocated.length,cycleTwo:true,compactIndependent:true,practiceConsumesForm:false,failedMaterializationConsumesForm:false,concurrentStartsSerialized:true,browserFormAccess:false}));

function createAttempt(profile,purpose,status='in_progress'){const id=crypto.randomUUID(),request=crypto.randomUUID(),formal=['assigned_assessment','self_directed_exam'].includes(purpose);sql(`insert into exam_delivery.attempts(id,owner_id,package_version_id,package_profile_id,client_request_id,status,purpose,generator_version,scorer_version,created_at,started_at,expires_at,practice_last_activity_at,practice_idle_expires_at) values ('${id}','${lowlevel.id}','${packageId}','${profile}','${request}','${status}','${purpose}','certsim-ai901-weighted-generator-v2','certsim-ai901-exact-scorer-v2',now(),now(),${formal?"now()+interval '10 minutes'":'null'},${formal?'null':'now()'},${formal?'null':"now()+interval '30 days'"})`);return{id,request}}
function refresh(form){form.membershipHash=sha256Canonical(form.questionIds)}
function allocate(id){return new Promise((resolve,reject)=>{const child=spawn('psql',[database,'-v','ON_ERROR_STOP=1','-c',`select exam_delivery.allocate_canonical_form('${id}')`],{stdio:'ignore'});child.on('exit',(code)=>code===0?resolve():reject(new Error('CONCURRENT_ALLOCATION_FAILED')))})}
function client(key){return createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}})}
function required(name){const value=process.env[name]?.trim();if(!value)fail(`MISSING_${name}`);return value}
function fail(code){throw new Error(code)}
function sql(statement){if(sqlStatus(statement)!==0)fail('SQL_FIXTURE_FAILED')}
function sqlStatus(statement){return spawnSync('psql',[database,'-v','ON_ERROR_STOP=1','-c',statement],{stdio:'ignore'}).status}
function sqlValue(statement){const result=spawnSync('psql',[database,'-v','ON_ERROR_STOP=1','-Atc',statement],{encoding:'utf8'});if(result.status!==0)fail('SQL_FIXTURE_FAILED');return result.stdout.trim()}
async function createUser(label){const email=`issue21-${label}-${crypto.randomUUID()}@example.invalid`,password=`T!${crypto.randomUUID()}g8`;const result=await admin.auth.admin.createUser({email,password,email_confirm:true});if(result.error)fail('AUTH_FIXTURE_FAILED');return{id:result.data.user.id,email,password}}
async function signedIn(user){const result=client(anon);const auth=await result.auth.signInWithPassword({email:user.email,password:user.password});if(auth.error)fail('SIGN_IN_FAILED');return result}
function assertStarted(result,count,label){if(result.error||result.data?.ok!==true||result.data?.items?.length!==count)fail(`${label}_FAILED`)}
function expectDenied(result,label){if(result.error||result.data?.ok!==false)fail(`${label}_NOT_DENIED`)}
async function complete(started,actor){for(const item of started.data.items){const saved=await admin.rpc('certsim_protected_save_response',{p_actor_id:actor,p_attempt_id:started.data.attempt.attemptId,p_item_id:item.itemId,p_response:{answer:'a'},p_expected_revision:0,p_request_id:crypto.randomUUID()});if(saved.error||saved.data?.revision!==1)fail('LIFECYCLE_SAVE_FAILED')}const submitted=await admin.rpc('certsim_protected_submit_attempt',{p_actor_id:actor,p_attempt_id:started.data.attempt.attemptId,p_submission_id:crypto.randomUUID()});if(submitted.error||submitted.data?.ok!==true||!submitted.data?.result)fail('LIFECYCLE_SUBMIT_FAILED')}
