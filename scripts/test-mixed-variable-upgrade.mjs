import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {readFile,writeFile} from 'node:fs/promises';import path from 'node:path';import {createClient} from '@supabase/supabase-js';
import {variablePythonCandidate} from './fixtures/variable-python-forms.mjs';import {mixedVariableCandidate} from './fixtures/mixed-variable-forms.mjs';import {sha256Canonical} from './backend-exam-publication/canonical-json.mjs';
const api=process.env.SUPABASE_URL,db=process.env.SUPABASE_DB_URL;for(const v of [api,db])if(!v||!['localhost','127.0.0.1','[::1]'].includes(new URL(v).hostname))throw Error('DISPOSABLE_REQUIRED');
let assertions=0;const eq=(a,b)=>{assert.deepEqual(a,b);assertions++;};const sql=input=>{const r=spawnSync('psql',[db,'-XqAt','-v','ON_ERROR_STOP=1'],{input,encoding:'utf8'});if(r.status)throw Error('MIXED_UPGRADE_SQL_FAILED');return r.stdout.trim();};
const admin=createClient(api,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}),file=path.join(process.env.RUNNER_TEMP,'mixed-prior97-private.json');
if(process.argv.includes('--after')){
 eq(sql('select count(*) from supabase_migrations.schema_migrations'),process.env.CERTSIM_VALIDATION_MIGRATIONS||'98');const before=JSON.parse(await readFile(file,'utf8'));
 for(const version of [1,2]){const r=await admin.rpc(version===1?'certsim_protected_count_contract':'certsim_protected_mixed_count_contract',{p_actor_id:before.actor,p_operation:'resume',p_arguments:{p_attempt_id:before.attempt.attemptId},p_count_contract:'certsim-authorised-form-count-v'+version});
 eq(r.error,null);eq(r.data.attempt,before.attempt);eq(r.data.items.map(i=>[i.itemId,i.questionId,i.questionType,i.revision,i.response]),before.items);}
 const proof={suite:'mixed-upgrade97-to98-pinned-v2',assertions,oldBackendMixedRejected:true,newShimMissingOn97:true,pinnedV2Unchanged:true,legacyAndNewNegotiationResume:true,syntheticOnly:true};
 await writeFile(path.join(process.env.RUNNER_TEMP,'mixed-upgrade-proof.json'),JSON.stringify(proof));console.log(JSON.stringify(proof));
}else{
 eq(sql('select count(*) from supabase_migrations.schema_migrations'),'97');
 async function user(){const email='mixed-upgrade-'+crypto.randomUUID()+'@example.invalid',password='T!'+crypto.randomUUID()+'a8',r=await admin.auth.admin.createUser({email,password,email_confirm:true});eq(r.error,null);return {id:r.data.user.id,email,password};}
 const owner=await user(),learner=await user(),org=crypto.randomUUID(),publisher=createClient(api,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
 sql(`update public.profiles set status='active',default_role='platform_owner',user_type='platform' where id='${owner.id}';insert into public.organisations(id,name,organisation_type,status) values('${org}','Synthetic upgrade','internal','active');insert into public.memberships(user_id,organisation_id,role,status) values('${owner.id}','${org}','platform_owner','active'),('${learner.id}','${org}','student','active');`);
 eq((await publisher.auth.signInWithPassword(owner)).error,null);
 async function publish(c){return publisher.rpc('certsim_protected_publish_package',{p_request:{publicationRequestId:crypto.randomUUID(),sourceCommitSha:'c'.repeat(40),packagePayload:c,packageHash:sha256Canonical(c)}});}
 eq((await publish(mixedVariableCandidate())).error?.code,'22023');
 const c=variablePythonCandidate();c.exam.packageVersion='2.0.0';eq((await publish(c)).error,null);
 const pkg=sql("select id from exam_delivery.package_versions where package_version='2.0.0'"),profile=sql(`select id from exam_delivery.package_profiles where package_version_id='${pkg}'`);
 sql(`insert into public.exam_catalog(exam_key,slug,title,lifecycle,exam_type) values('inf303','inf303','Synthetic upgrade','test','certification');insert into exam_delivery.exam_access_policies(canonical_exam_key,access_mode,enabled,enabled_at,require_assignment) values('inf303','open_authenticated',true,now(),false);
 insert into exam_delivery.exam_profile_activations(package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by) values('${pkg}','${profile}',true,'production',now(),'${owner.id}');
 insert into exam_delivery.exam_entitlements(package_version_id,package_profile_id,target_type,learner_id,enabled,valid_from,reason_code,created_by) values('${pkg}','${profile}','learner','${learner.id}',true,now()-interval '1 minute','synthetic_upgrade','${owner.id}');
 insert into exam_delivery.practice_policies(canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,maximum_completed_attempts,maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy) values('inf303','2.0.0','inf303-standard','self_directed_exam','production_authorized',true,null,50,false,'after_submission','after_submission');
 insert into exam_delivery.package_profile_defaults(canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,configured_by) values('inf303','inf303-standard','self_directed_exam','${pkg}','${profile}','${owner.id}');`);
 const absent=await admin.rpc('certsim_protected_mixed_count_contract',{p_actor_id:learner.id,p_operation:'resume',p_arguments:{p_attempt_id:crypto.randomUUID()},p_count_contract:'certsim-authorised-form-count-v2'});eq(absent.error?.code,'PGRST202');
 const a=await admin.rpc('certsim_protected_count_contract',{p_actor_id:learner.id,p_operation:'practiceStart',p_arguments:{p_request:{examKey:'inf303',profileId:'inf303-standard',purpose:'self_directed_exam',language:'not_applicable',includePbqs:true,mixStrategy:'balanced',clientRequestId:crypto.randomUUID()}},p_count_contract:'certsim-authorised-form-count-v1'});eq(a.error,null);
 const saved=await admin.rpc('certsim_protected_save_response',{p_actor_id:learner.id,p_attempt_id:a.data.attempt.attemptId,p_item_id:a.data.items[0].itemId,p_response:{answer:{a:true}},p_expected_revision:0,p_request_id:crypto.randomUUID()});eq(saved.error,null);
 const resumed=await admin.rpc('certsim_protected_count_contract',{p_actor_id:learner.id,p_operation:'resume',p_arguments:{p_attempt_id:a.data.attempt.attemptId},p_count_contract:'certsim-authorised-form-count-v1'});eq(resumed.error,null);
 await writeFile(file,JSON.stringify({actor:learner.id,attempt:resumed.data.attempt,items:resumed.data.items.map(i=>[i.itemId,i.questionId,i.questionType,i.revision,i.response])}),{mode:0o600});
 console.log(JSON.stringify({suite:'mixed-prior97-real-v2-start',assertions,oldBackendMixedRejected:true,newShimMissing:true,syntheticOnly:true}));
}

