// Synthetic SC100 profile/successor integration on the existing disposable stack.
import {createClient} from '@supabase/supabase-js';
import {spawnSync} from 'node:child_process';
import {assertDisposableTargets} from './assert-disposable-targets.mjs';
import {syntheticSc100,syntheticSc100Compact} from './sc100-compatibility/synthetic-fixture.mjs';
import {sha256Canonical as sha} from './backend-exam-publication/canonical-json.mjs';
const url=process.env.SUPABASE_URL,db=process.env.SUPABASE_DB_URL;assertDisposableTargets(url,db);
const client=key=>createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}}),admin=client(process.env.SUPABASE_SERVICE_ROLE_KEY);
let assertions=0;const gate=(v,c)=>{assertions++;if(!v)throw Error(c)};
const sql=(statement,scalar=false)=>{const r=spawnSync('psql',[db,'-X','-v','ON_ERROR_STOP=1','-Atc',statement],{encoding:'utf8'});gate(r.status===0,'SC100_SQL_FIXTURE_OR_ASSERTION_FAILED');return scalar?r.stdout.trim():undefined;};
const jsonSql=v=>"'"+JSON.stringify(v).replaceAll("'","''")+"'::jsonb";
const rpc=async(c,name,args)=>{const r=await c.rpc(name,args);const code=/^[A-Z0-9]{5}$/.test(r.error?.code??'')?r.error.code:'UNKNOWN';const check=/^[a-z][a-z0-9_]+$/.test(r.error?.message??'')?r.error.message:'REDACTED';gate(!r.error,'SC100_RPC_'+name.toUpperCase()+'_'+code+'_'+check);return r.data;};
async function actor(label){const email=`sc100-${label}-${crypto.randomUUID()}@example.invalid`,password=`S!${crypto.randomUUID()}`;const r=await admin.auth.admin.createUser({email,password,email_confirm:true});gate(!r.error&&r.data?.user,'SC100_SYNTHETIC_AUTH');return{id:r.data.user.id,email,password};}
const owner=await actor('owner'),student=await actor('student'),inactive=await actor('inactive'),other=await actor('other'),trainer=await actor('trainer');
const org=crypto.randomUUID(),campus=crypto.randomUUID(),group=crypto.randomUUID(),otherGroup=crypto.randomUUID();
sql(`insert into public.organisations(id,name,organisation_type,status) values('${org}','SC100 synthetic','internal','active');
insert into public.campuses(id,organisation_id,name,status) values('${campus}','${org}','Synthetic campus','active');
insert into public.groups(id,organisation_id,campus_id,name,status) values('${group}','${org}','${campus}','Target','active'),('${otherGroup}','${org}','${campus}','Other','active');
insert into public.memberships(user_id,organisation_id,campus_id,group_id,role,status) values
('${owner.id}','${org}',null,null,'platform_owner','active'),('${student.id}','${org}','${campus}','${group}','student','active'),
('${inactive.id}','${org}','${campus}','${group}','student','suspended'),('${other.id}','${org}','${campus}','${otherGroup}','student','active'),('${trainer.id}','${org}','${campus}','${group}','trainer','active');`);
const ownerClient=client(process.env.SUPABASE_ANON_KEY);gate(!(await ownerClient.auth.signInWithPassword({email:owner.email,password:owner.password})).error,'SC100_OWNER_SIGN_IN');
const unrelatedHash = () => sql(`select exam_delivery.examops_json_hash(jsonb_build_object(
 'attempts',(select jsonb_agg(to_jsonb(a) order by a.id) from exam_delivery.attempts a join exam_delivery.package_versions v on v.id=a.package_version_id where v.exam_key<>'sc100'),
 'results',(select jsonb_agg(to_jsonb(r) order by r.attempt_id) from exam_delivery.attempt_results r join exam_delivery.attempts a on a.id=r.attempt_id join exam_delivery.package_versions v on v.id=a.package_version_id where v.exam_key<>'sc100'),
 'defaults',(select jsonb_agg(to_jsonb(d) order by d.canonical_exam_key,d.profile_key,d.purpose) from exam_delivery.package_profile_defaults d where d.canonical_exam_key<>'sc100')))`,true);
const unrelatedBefore=unrelatedHash();
const old=syntheticSc100(),candidate=syntheticSc100Compact();
for(const pkg of [old,candidate]){const p=await rpc(ownerClient,'certsim_protected_publish_package',{p_request:{publicationRequestId:crypto.randomUUID(),sourceCommitSha:'b'.repeat(40),packagePayload:pkg,packageHash:sha(pkg)}});gate(p.classification==='new_candidate','SC100_PUBLICATION');}
const oldPublishedHash=sql("select exam_delivery.examops_json_hash(to_jsonb(v)) from exam_delivery.package_versions v where exam_key='sc100' and package_version='1.0.0'",true);
sql(`insert into exam_delivery.exam_release_candidates(canonical_exam_key,package_version,profile_key,release_template,catalogue_slug,catalogue_title,catalogue_vendor,catalogue_exam_type,catalogue_source_type) values('sc100','1.0.0','sc100-full','standard_active_exam_v1','sc100','SC100 synthetic','Synthetic','certification','official_source');`);
gate((await rpc(ownerClient,'certsim_configure_exam_release_stage',{p_request:{examKey:'sc100',packageVersion:'1.0.0',profileKey:'sc100-full',releaseStage:'standard_active_exam_v1',requestId:crypto.randomUUID()}})).configured===true,'SC100_PREDECESSOR_CONFIG');
const scope={target_organisation_id:org,target_campus_id:campus,target_group_id:group,target_student_user_id:null};
gate(await rpc(ownerClient,'can_manage_exam_assignment_scope',scope)===true,'SC100_OWNER_SCOPE');
async function assign(profile){const catalogueId=sql("select id from public.exam_catalog where exam_key='sc100'",true);const r=await ownerClient.from('exam_assignments').insert({assigned_by:owner.id,assignment_type:'practice',organisation_id:org,campus_id:campus,group_id:group,student_user_id:null,exam_catalog_id:catalogueId,exam_key:'sc100',profile_id:profile,title:'SC100 synthetic group practice',status:'active',available_from:null,due_at:null}).select('id').single();gate(!r.error&&r.data?.id,'SC100_NATIVE_GROUP_ASSIGNMENT');return r.data.id;}
const fullAssignment=await assign('sc100-full');
gate(sql("select has_column_privilege('authenticated','public.exam_assignments','due_at','UPDATE')",true)==='t','SC100_CANONICAL_DUE_AT_GRANT');
const request=(profile,purpose='self_directed_exam')=>({examKey:'sc100',profileId:profile,purpose,language:'not_applicable',includePbqs:true,mixStrategy:'balanced',clientRequestId:crypto.randomUUID()});
const start=async(profile,purpose)=>{const r=await rpc(admin,'certsim_protected_start_practice',{p_actor_id:student.id,p_request:request(profile,purpose)});gate(r.ok===true&&r.attempt?.attemptId,'SC100_START');return r;};
const historic=await start('sc100-full','study_sandbox'),historicId=historic.attempt.attemptId;
const historicItem=historic.items[0],historicResponse={answer:historicItem.questionType==='multi-select'?['a']:'a'};gate((await rpc(admin,'certsim_protected_save_response',{p_actor_id:student.id,p_attempt_id:historicId,p_item_id:historicItem.itemId,p_response:historicResponse,p_expected_revision:0,p_request_id:crypto.randomUUID()})).revision===1,'SC100_HISTORIC_SAVE');
const historicContract=sql(`select exam_delivery.examops_json_hash(to_jsonb(c)) from exam_delivery.attempt_continuation_contracts c where attempt_id='${historicId}'`,true);gate(historicContract.length===64,'SC100_FROZEN_PREDECESSOR_CONTRACT');
const targetId=sql("select id from exam_delivery.package_versions where exam_key='sc100' and package_version='1.1.0'",true);
const profiles=JSON.parse(sql(`select jsonb_agg(jsonb_build_object('profileKey',profile_key,'targetProfileId',id,'count',question_count)) from exam_delivery.package_profiles where package_version_id='${targetId}'`,true));
const purposes=['assigned_assessment','self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice'];
const releaseSet={schemaVersion:'certsim-exam-release-set-v1',examKey:'sc100',targetPackageId:targetId,catalogue:{currentVersion:'1.1.0',status:'active'},profiles:profiles.map(p=>({profileKey:p.profileKey,targetProfileId:p.targetProfileId,bindings:purposes.map(purpose=>({purpose,action:'MOVE'})),practicePolicies:purposes.slice(1).map(purpose=>({purpose,accessMode:'production_authorized',enabled:true,maximumCompletedAttempts:null,cooldownSeconds:0,maximumConcurrentSessions:1,maximumSessionItems:p.count,immediateFeedback:purpose==='study_sandbox',reviewReleasePolicy:purpose==='study_sandbox'?'immediate_study_feedback':'after_submission',answerReleasePolicy:purpose==='study_sandbox'?'immediate_study_feedback':'after_submission'}))}))};
const evidence={examKey:'sc100',targetPackageId:targetId,releaseSet,releaseSetHash:sql(`select exam_delivery.examops_json_hash(${jsonSql(releaseSet)})`,true),manifestHash:'c'.repeat(64),packageHash:sha(candidate),validationHash:candidate.source.validationHash,releaseDiffHash:'d'.repeat(64),expectedCurrentStateHash:sql("select exam_delivery.release_configuration_hash('sc100')",true)};
const pre=await rpc(ownerClient,'certsim_examops_preflight_exam_release',{p_request:evidence});gate(pre.ok===true,'SC100_SUCCESSOR_PREFLIGHT');
const stage=await rpc(ownerClient,'certsim_examops_stage_exam_release',{p_request:{...evidence,requestId:crypto.randomUUID()}});gate(stage.ok===true&&stage.resultState==='succeeded','SC100_SUCCESSOR_STAGE');
const activated=await rpc(ownerClient,'certsim_examops_activate_exam_release',{p_request:{...evidence,stageOperationId:stage.operationId,requestId:crypto.randomUUID()}});gate(activated.ok===true&&activated.resultState==='succeeded','SC100_SUCCESSOR_ACTIVATE');
gate(sql(`select exam_delivery.examops_json_hash(to_jsonb(c)) from exam_delivery.attempt_continuation_contracts c where attempt_id='${historicId}'`,true)===historicContract,'SC100_HISTORIC_CONTRACT_DRIFT');
const resumedOld=await rpc(admin,'certsim_protected_resume_attempt',{p_actor_id:student.id,p_attempt_id:historicId});gate(resumedOld.ok===true&&resumedOld.attempt.packageVersion==='1.0.0'&&resumedOld.items.some(i=>i.itemId===historicItem.itemId&&i.revision===1),'SC100_PREDECESSOR_CONTINUATION');
const compactAssignment=await assign('sc100-compact');
for(const profile of profiles){for(const [actor,allowed] of [[student,true],[inactive,false],[other,false],[trainer,false],[owner,true]]){const a=await rpc(admin,'certsim_protected_practice_availability',{p_actor_id:actor.id,p_request:request(profile.profileKey)});gate(allowed?a.ok===true&&a.selectedCount===profile.count:a.ok===false&&a.code==='access_not_granted','SC100_ROLE_AVAILABILITY');}}
const byId=new Map(candidate.questions.map(q=>[q.id,q])),completed=[];
for(const profile of profiles){const formIds=new Set();for(let cycle=0;cycle<6;cycle++){
 const r=await start(profile.profileKey),id=r.attempt.attemptId;gate(r.attempt.packageVersion==='1.1.0'&&r.items.length===profile.count,'SC100_SELECTED_COUNT_VERSION');
 gate(Math.round((Date.parse(r.attempt.expiresAt)-Date.parse(r.attempt.startedAt))/1000)===(profile.profileKey==='sc100-full'?6000:3000),'SC100_SERVER_TIMER');
 formIds.add(sql(`select canonical_form_id from exam_delivery.attempts where id='${id}'`,true));
 let partial=false,unanswered=false,expected=0,maximum=0;
 for(const item of r.items){const q=byId.get(item.questionId);gate(!!q,'SC100_ITEM_BINDING');maximum+=q.privateScoring.maximumRawPoints;
  if(q.type==='single-choice'&&!unanswered){unanswered=true;continue;}
  let answer=q.type==='single-choice'?'a':['a','b'];let earned=q.privateScoring.maximumRawPoints;if(q.type==='multi-select'&&!partial){partial=true;answer=['a'];earned=1;}expected+=earned;
  const saved=await rpc(admin,'certsim_protected_save_response',{p_actor_id:student.id,p_attempt_id:id,p_item_id:item.itemId,p_response:{answer},p_expected_revision:0,p_request_id:crypto.randomUUID()});gate(saved.revision===1,'SC100_SAVE');
 }
 const resumed=await rpc(admin,'certsim_protected_resume_attempt',{p_actor_id:student.id,p_attempt_id:id});gate(resumed.ok===true&&resumed.items.filter(i=>i.revision===1).length===profile.count-1,'SC100_RESUME');
 const submitted=await rpc(admin,'certsim_protected_submit_attempt',{p_actor_id:student.id,p_attempt_id:id,p_submission_id:crypto.randomUUID()});gate(submitted.result?.serverAuthoritative===true,'SC100_SUBMIT');
 sql(`select 1/((raw_score=${expected} and max_score=${maximum} and server_authoritative)::integer) from exam_delivery.attempt_results where attempt_id='${id}'`);
 gate(profile.profileKey!=='sc100-compact'||maximum===31,'SC100_COMPACT_RAW_MAX');
 const result=await rpc(admin,'certsim_protected_get_result',{p_actor_id:student.id,p_attempt_id:id});gate(result.result?.serverAuthoritative===true&&result.result?.attemptId===id,'SC100_RESULT');
 const review=await rpc(admin,'certsim_protected_get_review',{p_actor_id:student.id,p_attempt_id:id});gate(review.ok===true,'SC100_RELEASED_REVIEW');completed.push(id);
 const denied=await rpc(admin,'certsim_protected_resume_attempt',{p_actor_id:other.id,p_attempt_id:id});gate(denied.ok===false,'SC100_CROSS_USER_DENIED');
 }gate(formIds.size===6,'SC100_SIX_DISTINCT_FORMS');}
const history=await rpc(admin,'certsim_protected_list_history',{p_actor_id:student.id,p_exam_key:'sc100',p_cursor:null,p_page_size:50});gate(completed.every(id=>history.items.some(i=>i.attemptId===id)),'SC100_HISTORY');
sql(`select 1/((count(*)=12)::integer) from exam_delivery.package_profile_defaults where canonical_exam_key='sc100' and enabled;select 1/((count(*)=10)::integer) from exam_delivery.practice_policies where canonical_exam_key='sc100' and package_version='1.1.0' and enabled;
select 1/((count(*)=1 and bool_and(due_at is null and profile_id='sc100-full'))::integer) from public.exam_assignments where id='${fullAssignment}';select 1/((count(*)=1 and bool_and(due_at is null and profile_id='sc100-compact'))::integer) from public.exam_assignments where id='${compactAssignment}';`);
gate(unrelatedHash()===unrelatedBefore,'SC100_UNRELATED_HISTORY_DRIFT');
const modified=structuredClone(old);modified.questions[0].presentation.prompt='Changed synthetic immutable-version fixture';modified.source.sourceHash=sha(modified.questions);
const immutable=await ownerClient.rpc('certsim_protected_publish_package',{p_request:{publicationRequestId:crypto.randomUUID(),sourceCommitSha:'b'.repeat(40),packagePayload:modified,packageHash:sha(modified)}});gate(immutable.error?.code==='23505','SC100_IMMUTABLE_VERSION_IDENTITY_REJECTION');
gate(sql("select exam_delivery.examops_json_hash(to_jsonb(v)) from exam_delivery.package_versions v where exam_key='sc100' and package_version='1.0.0'",true)===oldPublishedHash,'SC100_PUBLISHED_PREDECESSOR_DRIFT');
console.log(JSON.stringify({ok:true,fixture:'synthetic-only',assertions,fullForms:6,compactForms:6,counts:[50,25],timerSeconds:[6000,3000],compactRawMaxima:Array(6).fill(31),oldVersionContinuation:true,nativeGroupAssignments:2,roleCases:10,history:completed.length,realProviderCalls:0,productionActions:0}));
