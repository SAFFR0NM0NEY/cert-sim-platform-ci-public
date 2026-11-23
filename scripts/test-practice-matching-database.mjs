import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createClient} from '@supabase/supabase-js';
import {practiceMatchingCandidate,PRACTICE_POLICIES} from './fixtures/practice-matching.mjs';
import {sha256Canonical} from './backend-exam-publication/canonical-json.mjs';
const db=process.env.SUPABASE_DB_URL,api=process.env.SUPABASE_URL;
for(const v of [db,api])if(!v||!['127.0.0.1','localhost','[::1]'].includes(new URL(v).hostname))throw Error('DISPOSABLE_REQUIRED');
if(!process.env.RUNNER_TEMP)throw Error('DISPOSABLE_TEMP_REQUIRED');
const client=k=>createClient(api,k,{auth:{persistSession:false,autoRefreshToken:false}}),admin=client(process.env.SUPABASE_SERVICE_ROLE_KEY);
let assertions=0;const eq=(a,b)=>{assert.deepEqual(a,b);assertions++;};
function sql(input){const r=spawnSync('psql',[db,'-XqAt','-v','ON_ERROR_STOP=1'],{input,encoding:'utf8'});if(r.status)throw Error('SYNTHETIC_SQL_FAILED');return r.stdout.trim();}
async function user(){const email=`sandbox-${crypto.randomUUID()}@example.invalid`,password=`T!${crypto.randomUUID()}f8`;const r=await admin.auth.admin.createUser({email,password,email_confirm:true});eq(r.error,null);return {id:r.data.user.id,email,password};}
const owner=await user(),org=crypto.randomUUID();
sql(`update public.profiles set status='active',default_role='platform_owner',user_type='platform' where id='${owner.id}';insert into public.organisations(id,name,organisation_type,status) values('${org}','Synthetic sandbox','internal','active');insert into public.memberships(user_id,organisation_id,role,status) values('${owner.id}','${org}','platform_owner','active');`);
const publisher=client(process.env.SUPABASE_ANON_KEY);eq((await publisher.auth.signInWithPassword(owner)).error,null);
const accounts=[];
for(const legacy of [false,true])for(const policy of PRACTICE_POLICIES){
 const account=await user(),c=practiceMatchingCandidate(policy,legacy);
 sql(`insert into public.memberships(user_id,organisation_id,role,status) values('${account.id}','${org}','student','active');`);
 const published=await publisher.rpc('certsim_protected_publish_package',{p_request:{publicationRequestId:crypto.randomUUID(),sourceCommitSha:'e'.repeat(40),packagePayload:c,packageHash:sha256Canonical(c)}});eq(published.error,null);eq(published.data.ok,true);
 const pkg=sql(`select id from exam_delivery.package_versions where exam_key='inf303' and package_version='${c.exam.packageVersion}'`),profile=sql(`select id from exam_delivery.package_profiles where package_version_id='${pkg}' and profile_key='inf303-standard'`);
 sql(`insert into public.exam_catalog(exam_key,slug,title,lifecycle,exam_type) values('inf303','inf303','Synthetic sandbox','test','certification') on conflict(exam_key) do nothing;
 insert into exam_delivery.exam_access_policies(canonical_exam_key,access_mode,enabled,enabled_at,require_assignment) values('inf303','open_authenticated',true,now(),false) on conflict(canonical_exam_key) do nothing;
 insert into exam_delivery.exam_profile_activations(package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by) values('${pkg}','${profile}',true,'production',now(),'${owner.id}');
 insert into exam_delivery.exam_entitlements(package_version_id,package_profile_id,target_type,learner_id,enabled,valid_from,reason_code,created_by) values('${pkg}','${profile}','learner','${account.id}',true,now()-interval '1 minute','synthetic_sandbox','${owner.id}');
 insert into exam_delivery.practice_policies(canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,maximum_completed_attempts,maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy) values('inf303','${c.exam.packageVersion}','inf303-standard','study_sandbox','production_authorized',true,null,50,true,'immediate_study_feedback','immediate_study_feedback');
 insert into exam_delivery.package_profile_defaults(canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,configured_by) values('inf303','inf303-standard','study_sandbox','${pkg}','${profile}','${owner.id}') on conflict(canonical_exam_key,profile_key,purpose) do update set package_version_id=excluded.package_version_id,package_profile_id=excluded.package_profile_id;`);
 accounts.push({...account,policy,legacy,generatorVersion:c.runtime.generatorVersion,packageVersion:c.exam.packageVersion,memberIds:c.profiles[0].selection.canonicalForms.forms.flatMap(f=>f.questionIds)});
}
await writeFile(path.join(process.env.RUNNER_TEMP,'practice-matching-accounts.json'),JSON.stringify(accounts),{mode:0o600});
await writeFile(path.join(process.env.RUNNER_TEMP,'practice-matching-publisher.json'),JSON.stringify(owner),{mode:0o600});
console.log(JSON.stringify({suite:'practice-matching-normal-publication',assertions,packages:accounts.length,itemsPerPackage:30,syntheticOnly:true}));
