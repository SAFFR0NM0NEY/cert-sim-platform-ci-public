import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {writeFile} from 'node:fs/promises';import path from 'node:path';import {createClient} from '@supabase/supabase-js';
import {mixedVariableCandidate,MIXED_INVALID_CASES,syntheticMixedAnswer} from './fixtures/mixed-variable-forms.mjs';
import {sha256Canonical} from './backend-exam-publication/canonical-json.mjs';
import {validateExamOperationsCandidate} from './backend-exam-publication/exam-operations-candidate.mjs';
import {buildExamOperationsReadQuery} from './exam-operations/read-production-state.mjs';
import {buildExamOperationsCurrentState} from './backend-exam-publication/exam-operations-current-state.mjs';
import {createExamOperationsReleaseDiff} from './backend-exam-publication/exam-operations-release-diff.mjs';
const api=process.env.SUPABASE_URL,db=process.env.SUPABASE_DB_URL;
for(const v of [api,db])if(!v||!['localhost','127.0.0.1','[::1]'].includes(new URL(v).hostname))throw Error('DISPOSABLE_REQUIRED');
if(!process.env.RUNNER_TEMP)throw Error('DISPOSABLE_TEMP_REQUIRED');
let assertions=0;const eq=(a,b)=>{assert.deepEqual(a,b);assertions++;};
const sql=input=>{const r=spawnSync('psql',[db,'-XqAt','-v','ON_ERROR_STOP=1'],{input,encoding:'utf8'});if(r.status)throw Error('MIXED_SYNTHETIC_SQL_FAILED_'+(r.stderr.match(/ERROR:\s+([a-z_]+)/)?.[1]||'unknown'));return r.stdout.trim();};
const admin=createClient(api,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const client=()=>createClient(api,process.env.SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
async function user(){const email='mixed-'+crypto.randomUUID()+'@example.invalid',password='T!'+crypto.randomUUID()+'s7';const r=await admin.auth.admin.createUser({email,password,email_confirm:true});eq(r.error,null);return {id:r.data.user.id,email,password};}
const owner=await user(),learner=await user(),browser=await user(),race=await user(),expiry=await user(),org=crypto.randomUUID();
sql(`update public.profiles set status='active',default_role='platform_owner',user_type='platform' where id='${owner.id}';
insert into public.organisations(id,name,organisation_type,status) values('${org}','Synthetic mixed','internal','active');
insert into public.memberships(user_id,organisation_id,role,status) values('${owner.id}','${org}','platform_owner','active'),${[learner,browser,race,expiry].map(u=>`('${u.id}','${org}','student','active')`).join(',')};
insert into public.exam_catalog(exam_key,slug,title,lifecycle,exam_type) values('inf303','inf303','Synthetic mixed Python','test','certification');
insert into exam_delivery.exam_access_policies(canonical_exam_key,access_mode,enabled,enabled_at,require_assignment) values('inf303','open_authenticated',true,now(),false);`);
const publisher=client();eq((await publisher.auth.signInWithPassword(owner)).error,null);
let publicationTransportRetries=0;
async function publish(c){
 const request={publicationRequestId:crypto.randomUUID(),sourceCommitSha:'c'.repeat(40),packagePayload:c,packageHash:sha256Canonical(c)};
 for(let attempt=0;attempt<3;attempt++){
  const r=await publisher.rpc('certsim_protected_publish_package',{p_request:request});
  if(!(r.status===0&&!r.error?.code&&String(r.error?.message).includes('fetch'))||attempt===2)return r;
  publicationTransportRetries++;await new Promise(resolve=>setTimeout(resolve,250));
 }
}

const matrix=[];
for(const [name,change] of MIXED_INVALID_CASES)for(const index of [0,8]){
 const c=mixedVariableCandidate();c.exam.packageVersion='invalid-'+matrix.length;change(c.questions[index]);
 const v=validateExamOperationsCandidate(c),r=await publish(c);eq(v.ok,false);eq(Boolean(r.error)||r.data?.ok===false,true);
 // Generic validation can reject earlier; all database rejections must remain controlled.
 if(r.error?.code!=='22023')console.log(JSON.stringify({suite:'mixed-publication-diagnostic',case:name,reserve:index===8,httpStatus:r.status,errorState:r.error?.code||'missing',safeMessage:/^[a-z_]+$/.test(r.error?.message||'')?r.error.message:'non_sql_error',messageClass:(r.error?.message||'').includes('fetch')?'fetch':(r.error?.message||'').includes('<html')?'html':'other'}));
 eq(r.error?.code??'22023','22023');
 eq(sql(`select count(*) from exam_delivery.package_versions where package_version='${c.exam.packageVersion}'`),'0');
 matrix.push({case:name,reserve:index===8,preflight:false,published:false,sqlstate:r.error?.code??'22023'});
}
const payload=mixedVariableCandidate(),published=await publish(payload);if(published.error)throw Error('MIXED_PUBLISH_'+published.error.message);eq(published.data.ok,true);
const pkg=sql("select id from exam_delivery.package_versions where exam_key='inf303' and package_version='1.0.0'"),profile=sql(`select id from exam_delivery.package_profiles where package_version_id='${pkg}'`);
sql(`insert into exam_delivery.exam_profile_activations(package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by) values('${pkg}','${profile}',true,'production',now(),'${owner.id}');
insert into exam_delivery.exam_entitlements(package_version_id,package_profile_id,target_type,learner_id,enabled,valid_from,reason_code,created_by) values ${[learner,browser,race,expiry].map(u=>`('${pkg}','${profile}','learner','${u.id}',true,now()-interval '1 minute','synthetic_mixed','${owner.id}')`).join(',')};
insert into exam_delivery.practice_policies(canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,maximum_completed_attempts,maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy) values
('inf303','1.0.0','inf303-standard','self_directed_exam','production_authorized',true,null,50,false,'after_submission','after_submission'),
('inf303','1.0.0','inf303-standard','study_sandbox','production_authorized',true,null,50,true,'immediate_study_feedback','immediate_study_feedback');
insert into exam_delivery.package_profile_defaults(canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,configured_by) values
('inf303','inf303-standard','self_directed_exam','${pkg}','${profile}','${owner.id}'),('inf303','inf303-standard','study_sandbox','${pkg}','${profile}','${owner.id}');`);
const request=()=>({examKey:'inf303',profileId:'inf303-standard',purpose:'self_directed_exam',language:'not_applicable',includePbqs:true,mixStrategy:'balanced',clientRequestId:crypto.randomUUID()});
async function rpcOp(op,args,actor=learner.id,version=2){return admin.rpc(version===2?'certsim_protected_mixed_count_contract':'certsim_protected_count_contract',{p_actor_id:actor,p_operation:op,p_arguments:args,p_count_contract:'certsim-authorised-form-count-v'+version});}
const unsupported=await rpcOp('practiceStart',{p_request:request()},learner.id,1);eq(unsupported.error?.message,'count_contract_required');eq(sql(`select count(*) from exam_delivery.attempts where owner_id='${learner.id}'`),'0');
const oldSandbox=await rpcOp('practiceStart',{p_request:{...request(),purpose:'study_sandbox'}},learner.id,1);eq(oldSandbox.error?.message,'count_contract_required');
for(const override of [{count:3},{formId:crypto.randomUUID()},{questionCount:3}]){
 const r=await rpcOp('practiceStart',{p_request:{...request(),...override}});eq(Boolean(r.error)||r.data?.ok===false,true);eq(sql(`select count(*) from exam_delivery.attempts where owner_id='${learner.id}'`),'0');
}
for(const role of ['anon','authenticated'])eq(sql(`select has_function_privilege('${role}','public.certsim_protected_mixed_count_contract(uuid,text,jsonb,text)','execute')`),'f');
eq(sql("select has_function_privilege('service_role','exam_delivery.prepare_mixed_variable_forms(uuid)','execute')"),'f');
const current=buildExamOperationsCurrentState(JSON.parse(sql(buildExamOperationsReadQuery('inf303',{genericReleaseOperations:true}))),'inf303');
eq(createExamOperationsReleaseDiff({currentState:current.snapshot,candidateValidation:validateExamOperationsCandidate(payload),currentFingerprintIndex:current.privateComparisonIndex,candidateContract:payload}).overallChangeClassification,'NO_CHANGE');
const auth=client();const logged=await auth.auth.signInWithPassword(learner);eq(logged.error,null);const headers={Authorization:'Bearer '+logged.data.session.access_token,apikey:process.env.SUPABASE_ANON_KEY,'x-client-info':'certsim-authorised-form-count-v2','content-type':'application/json'};
async function edge(route,data,method=data?'POST':'GET'){
 const r=await fetch(api+'/functions/v1/certsim-protected-exam'+route,{method,headers,body:data?JSON.stringify(data):undefined});const b=await r.json();if(!r.ok)throw Error('MIXED_EDGE_'+r.status+'_'+b.error?.code);return b;
}
const results=[];
for(let turn=0;turn<4;turn++){
 const req=request(),a=await edge('/practice/sessions',req),id=a.attempt.attemptId,n=a.items.length,max=n===3?5:9;
 eq(n,turn%2===0?3:5);eq(a.attempt.countContract.version,'certsim-authorised-form-count-v2');eq(a.attempt.countContract.exactCount,n);
 eq((Date.parse(a.attempt.expiresAt)-Date.parse(a.attempt.startedAt))/1000,2700);
 eq((await edge('/practice/sessions',req)).attempt.attemptId,id);
 const choice=a.items.find(i=>i.questionType==='single-choice');
 const bad=await fetch(api+'/functions/v1/certsim-protected-exam/attempts/'+id+'/items/'+choice.itemId+'/response',{method:'PUT',headers,body:JSON.stringify({response:{answer:'unknown'},expectedRevision:0,requestId:crypto.randomUUID()})});eq(bad.ok,false);
 if(turn<3)for(const item of a.items){
  const response=syntheticMixedAnswer(item,turn===2&&item.questionType==='single-choice');
  eq((await edge('/attempts/'+id+'/items/'+item.itemId+'/response',{response,expectedRevision:0,requestId:crypto.randomUUID()},'PUT')).revision,1);
 }
 if(turn===0){const successor=structuredClone(payload);successor.exam.packageVersion='1.1.0';eq((await publish(successor)).error,null);}
 const resumed=await edge('/attempts/'+id);eq(resumed.attempt.countContract,a.attempt.countContract);eq(resumed.attempt.expiresAt,a.attempt.expiresAt);eq(resumed.attempt.packageVersion,'1.0.0');
 const submission=crypto.randomUUID(),r=await edge('/attempts/'+id+'/submit',{submissionId:submission});const earned=turn===3?0:turn===2?max-1:max;
 const persisted=JSON.parse(sql(`select jsonb_build_array(raw_score,max_score,(result_summary->>'questionCount')::integer) from exam_delivery.attempt_results where attempt_id='${id}'`));eq(persisted,[earned,max,n]);
 const itemCredit=[];
 for(const item of a.items){
  const q=payload.questions.find(q=>q.id===item.questionId),expectedMaximum={'single-choice':1,'true-false-single-v1':1,'true-false-composite-v1':2,'matching-v1':2,'code-dropdown-completion-v1':3}[item.questionType];
  const actual=JSON.parse(sql(`select exam_delivery.score_package_v2_response('${q.type}',$scoring$${JSON.stringify(q.privateScoring)}$scoring$::jsonb,coalesce((select response_payload from exam_delivery.attempt_responses where attempt_id='${id}' and attempt_item_id='${item.itemId}'),'{}'::jsonb),true)`));
  const expectedEarned=turn===3||turn===2&&item.questionType==='single-choice'?0:expectedMaximum;
  eq(actual.maximum,expectedMaximum);eq(actual.earned,expectedEarned);itemCredit.push({type:item.questionType,earned:actual.earned,maximum:actual.maximum});
 }
 const replay=await edge('/attempts/'+id+'/submit',{submissionId:submission});eq(replay.result,r.result);
 eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${id}'`),'1');eq(sql(`select count(*) from public.exam_results where attempt_id='${id}'`),'1');
 const summary=await edge('/attempts/'+id+'/print-summary');eq(summary.rawMaximum,max);eq(summary.questionCount,n);
 const review=await edge('/attempts/'+id+'/review');eq(Boolean(review),true);
 const history=await edge('/history?examKey=inf303&pageSize=20');eq(history.items.some(x=>x.attemptId===id),true);
 results.push({count:n,earned,maximum:max,mode:turn===3?'unanswered':turn===2?'wrong-native':'full',itemCredit});
}
const sandbox=await edge('/practice/sessions',{...request(),purpose:'study_sandbox',includePbqs:false});eq(sandbox.items.length,9);eq(sandbox.attempt.countContract,undefined);
eq(sql(`select canonical_form_id is null from exam_delivery.attempts where id='${sandbox.attempt.attemptId}'`),'t');eq(sandbox.items.find(i=>i.questionType==='matching-v1').presentation.allowTargetReuse,false);
const reserve=sandbox.items.find(i=>i.questionId===payload.questions[8].id);eq(Boolean(reserve),true);
eq((await edge('/attempts/'+sandbox.attempt.attemptId+'/items/'+reserve.itemId+'/response',{response:{answer:'yes'},expectedRevision:0,requestId:crypto.randomUUID()},'PUT')).revision,1);
// Concurrent real normal Starts; durable request replay must yield one attempt.
const concurrent=request(),started=await Promise.all([rpcOp('practiceStart',{p_request:concurrent},race.id),rpcOp('practiceStart',{p_request:concurrent},race.id)]);eq(started[0].error,null);eq(started[1].error,null);eq(started[0].data.attempt.attemptId,started[1].data.attempt.attemptId);
eq(sql(`select count(*) from exam_delivery.attempts where owner_id='${race.id}'`),'1');
// Fail within the actual materializer; no unusable attempt or consumed form commits.
sql(`create function public.mixed_fail_item() returns trigger language plpgsql set search_path='' as $$begin if exists(select 1 from exam_delivery.attempts a where a.id=new.attempt_id and a.owner_id='${expiry.id}') then raise exception 'synthetic_materialization_failure';end if;return new;end$$;
create trigger mixed_fail_item before insert on exam_delivery.attempt_items for each row execute function public.mixed_fail_item();`);
const failed=await rpcOp('practiceStart',{p_request:request()},expiry.id);eq(Boolean(failed.error),true);
sql('drop trigger mixed_fail_item on exam_delivery.attempt_items;drop function public.mixed_fail_item()');eq(sql(`select count(*) from exam_delivery.attempts where owner_id='${expiry.id}'`),'0');
eq((await rpcOp('practiceStart',{p_request:request()},expiry.id)).data.attempt.countContract.exactCount,3);
await writeFile(path.join(process.env.RUNNER_TEMP,'mixed-browser-account.json'),JSON.stringify(browser),{mode:0o600});
await writeFile(path.join(process.env.RUNNER_TEMP,'mixed-expiry-account.json'),JSON.stringify(expiry),{mode:0o600});
const proof={suite:'mixed-variable-normal-edge-database',assertions,publicationTransportRetries,publicationMatrix:matrix,results,practiceNativeReserveSaved:true,concurrentIdempotentStart:true,materializationRollback:true,syntheticOnly:true,productionActions:0};
await writeFile(path.join(process.env.RUNNER_TEMP,'mixed-database-proof.json'),JSON.stringify(proof));console.log(JSON.stringify({suite:proof.suite,assertions,matrixRows:matrix.length,results,syntheticOnly:true}));

