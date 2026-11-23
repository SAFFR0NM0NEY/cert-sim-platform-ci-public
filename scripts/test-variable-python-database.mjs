import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { variablePythonCandidate } from './fixtures/variable-python-forms.mjs';
import { sha256Canonical } from './backend-exam-publication/canonical-json.mjs';
import { buildExamOperationsReadQuery } from './exam-operations/read-production-state.mjs';
import { buildExamOperationsCurrentState } from './backend-exam-publication/exam-operations-current-state.mjs';
import { validateExamOperationsCandidate } from './backend-exam-publication/exam-operations-candidate.mjs';
import { createExamOperationsReleaseDiff } from './backend-exam-publication/exam-operations-release-diff.mjs';

const database = process.env.SUPABASE_DB_URL, url = process.env.SUPABASE_URL;
if (!database || !url || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(database).hostname)
  || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw Error('DISPOSABLE_LOCAL_REQUIRED');
const client = key => createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const admin = client(process.env.SUPABASE_SERVICE_ROLE_KEY);
let assertions = 0;
const eq = (a, b) => { assert.deepEqual(a, b); assertions++; };
function sql(statement, allowFailure = false) {
  const r = spawnSync('psql', [database, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8' });
  if (r.status && !allowFailure) throw Error(`VARIABLE_SYNTHETIC_SQL_FAILED_${String(r.stderr).match(/ERROR:\s+([a-z_]+)/)?.[1] ?? 'unknown'}`);
  return allowFailure ? r.status : r.stdout.trim();
}
async function user(label) {
  const email = `variable-${label}-${crypto.randomUUID()}@example.invalid`, password = `T!${crypto.randomUUID()}a8`;
  const r = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (r.error) throw Error('SYNTHETIC_AUTH_FAILED');
  return { id: r.data.user.id, email, password };
}
const owner = await user('owner'), learner = await user('learner'), raceLearner = await user('race'), browserLearner = await user('browser'), assignedLearner=await user('assigned'), negativeLearner=await user('negative');
const ownerClient = client(process.env.SUPABASE_ANON_KEY);
assert.equal((await ownerClient.auth.signInWithPassword(owner)).error, null);
const org = crypto.randomUUID(), payload = variablePythonCandidate();
sql(`update public.profiles set status='active',default_role='platform_owner',user_type='platform' where id='${owner.id}';
insert into public.organisations(id,name,organisation_type,status) values('${org}','Synthetic variable forms','internal','active');
insert into public.memberships(user_id,organisation_id,role,status) values('${owner.id}','${org}','platform_owner','active'),('${learner.id}','${org}','student','active'),('${raceLearner.id}','${org}','student','active'),('${browserLearner.id}','${org}','student','active'),('${assignedLearner.id}','${org}','student','active'),('${negativeLearner.id}','${org}','student','active');
insert into public.exam_catalog(exam_key,slug,title,lifecycle,exam_type) values('inf303','inf303','Synthetic variable Python','test','certification');
insert into exam_delivery.exam_access_policies(canonical_exam_key,access_mode,enabled,enabled_at,require_assignment) values('inf303','open_authenticated',true,now(),false);`);
async function publish(candidate) {
  return ownerClient.rpc('certsim_protected_publish_package', { p_request: {
    publicationRequestId: crypto.randomUUID(), sourceCommitSha: 'c'.repeat(40), packagePayload: candidate, packageHash: sha256Canonical(candidate),
  } });
}
const published = await publish(payload);
if (published.error) throw Error(`VARIABLE_PUBLICATION_FAILED_${published.error.message}`);
eq(published.data.ok, true);
const invalidMutations = [
  c => { c.forms[0].questionCount=5; },
  c => { c.forms[0].rawMaximum=1; },
  c => { c.forms[0].blueprint.composition.standardQuestionCount=2; },
  c => { c.forms[0].membershipHash='0'.repeat(64); },
  c => { c.forms[0].questionIds[0]='unknown'; c.forms[0].membershipHash=sha256Canonical(c.forms[0].questionIds); },
  c => { c.forms[1].questionIds[0]=c.forms[0].questionIds[0]; c.forms[1].membershipHash=sha256Canonical(c.forms[1].questionIds); },
  c => { c.countPolicy.allowedCounts=[3,4,5]; },
  c => { c.countPolicy.maximum=4; },
  c => { c.countPolicy.minimum=0; },
  c => { c.countPolicy.maximum=Number.MAX_SAFE_INTEGER+1; },
  c => { c.forms[0].blueprint.domainCounts={}; },
  c => { c.forms[0].blueprint.requiredObjectiveKeys=['missing']; },
  c => { c.forms[0].blueprint.minimumCoverageTagCounts={absent:1}; },
  c => { c.forms[0].blueprint.difficultyRequirements.minimumAdvanced=1; },
  c => { c.forms[0].blueprint=null; },
  c => { c.contractVersion='unknown'; },
  c => { c.deliveryContract='unknown'; },
  c => { c.reserveQuestionIds=[]; },
];
for(const [index,mutate] of invalidMutations.entries()) {
  const invalid=structuredClone(payload); invalid.exam.examKey=`synthetic-variable-invalid-${index}`;
  mutate(invalid.profiles[0].selection.canonicalForms);
  const denied=await publish(invalid);
  eq(Boolean(denied.error),true);
  eq(sql(`select count(*) from exam_delivery.package_versions where exam_key='syntheticvariableinvalid${index}'`),'0');
}
eq(JSON.parse(sql(`select jsonb_agg(question_count order by form_ordinal) from exam_delivery.package_forms f join exam_delivery.package_versions v on v.id=f.package_version_id where v.exam_key='inf303'`)), [3,5]);
const packageId = sql(`select id from exam_delivery.package_versions where exam_key='inf303'`);
const profileId = sql(`select id from exam_delivery.package_profiles where package_version_id='${packageId}'`);
eq(sql("select has_function_privilege('anon','public.certsim_protected_count_contract(uuid,text,jsonb,text)','execute')"),'f');
eq(sql("select has_function_privilege('authenticated','public.certsim_protected_count_contract(uuid,text,jsonb,text)','execute')"),'f');
eq(sql("select has_function_privilege('service_role','public.certsim_protected_count_contract(uuid,text,jsonb,text)','execute')"),'t');
eq(sql("select has_function_privilege('service_role','exam_delivery.prepare_variable_python_forms(uuid)','execute')"),'f');
sql(`insert into exam_delivery.exam_profile_activations(package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by) values('${packageId}','${profileId}',true,'production',now(),'${owner.id}');
insert into exam_delivery.exam_entitlements(package_version_id,package_profile_id,target_type,learner_id,enabled,valid_from,reason_code,created_by) values
('${packageId}','${profileId}','learner','${learner.id}',true,now()-interval '1 minute','synthetic_variable','${owner.id}'),
('${packageId}','${profileId}','learner','${raceLearner.id}',true,now()-interval '1 minute','synthetic_variable','${owner.id}'),
('${packageId}','${profileId}','learner','${browserLearner.id}',true,now()-interval '1 minute','synthetic_variable','${owner.id}'),
('${packageId}','${profileId}','learner','${negativeLearner.id}',true,now()-interval '1 minute','synthetic_variable','${owner.id}');
insert into exam_delivery.practice_policies(canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,maximum_completed_attempts,maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy) values
('inf303','1.0.0','inf303-standard','self_directed_exam','production_authorized',true,null,50,false,'after_submission','after_submission'),
('inf303','1.0.0','inf303-standard','study_sandbox','production_authorized',true,null,50,true,'immediate_study_feedback','immediate_study_feedback');
insert into exam_delivery.package_profile_defaults(canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,configured_by) values
('inf303','inf303-standard','self_directed_exam','${packageId}','${profileId}','${owner.id}'),
('inf303','inf303-standard','assigned_assessment','${packageId}','${profileId}','${owner.id}'),
('inf303','inf303-standard','study_sandbox','${packageId}','${profileId}','${owner.id}');`);
const current=buildExamOperationsCurrentState(JSON.parse(sql(buildExamOperationsReadQuery('inf303',{genericReleaseOperations:true}))),'inf303');
const parity=createExamOperationsReleaseDiff({currentState:current.snapshot,candidateValidation:validateExamOperationsCandidate(payload),currentFingerprintIndex:current.privateComparisonIndex,candidateContract:payload});
eq(parity.overallChangeClassification,'NO_CHANGE');
eq(current.snapshot.currentPackage.profiles[0].forms.perForm.map(f=>[f.itemCount,f.rawMaximum]),[[3,6],[5,10]]);
const request = () => ({ examKey: 'inf303', profileId: 'inf303-standard', purpose: 'self_directed_exam', language: 'not_applicable', includePbqs:true,mixStrategy:'balanced',clientRequestId: crypto.randomUUID() });
async function operation(id, args, actor = learner.id) {
  const r = await admin.rpc('certsim_protected_count_contract', { p_actor_id: actor, p_operation: id, p_arguments: args, p_count_contract: 'certsim-authorised-form-count-v1' });
  if (r.error) throw Error(`VARIABLE_OPERATION_${id}_${r.error.message}`);
  if (r.data.ok === false) throw Error(`VARIABLE_OPERATION_${id}_${r.data.code}`);
  return r.data;
}
const unsupported = await admin.rpc('certsim_protected_start_practice', { p_actor_id: learner.id, p_request: request() });
eq(unsupported.error?.message, 'count_contract_required');
eq(sql(`select count(*) from exam_delivery.attempts where package_version_id='${packageId}'`), '0');
const preview = await operation('practiceAvailability', { p_request: request() });
eq(preview.countPolicy.allowedCounts, [3,5]);
for(const override of [{count:3},{count:5},{formId:crypto.randomUUID()},{questionCount:3}]) {
  const denied=await admin.rpc('certsim_protected_count_contract',{p_actor_id:learner.id,p_operation:'practiceStart',
    p_arguments:{p_request:{...request(),...override}},p_count_contract:'certsim-authorised-form-count-v1'});
  const rejection=denied.error?.message ?? (denied.data?.ok===false ? denied.data.code : null);
  // A contradictory legacy count may be rejected by existing request
  // validation before the new capability-specific guard is reached.
  eq(['count_override_forbidden','invalid_request'].includes(rejection),true);
  eq(sql(`select count(*) from exam_delivery.attempts where package_version_id='${packageId}'`),'0');
}
const lengths = [], cycles = [];
const sandbox=await operation('practiceStart',{p_request:{...request(),purpose:'study_sandbox',includePbqs:false}});
eq(sql(`select canonical_form_id is null from exam_delivery.attempts where id='${sandbox.attempt.attemptId}'`),'t');
eq(sandbox.items.length,9);
for (let turn = 0; turn < 3; turn++) {
  const startRequest = request();
  const started = await operation('practiceStart', { p_request: startRequest });
  const attempt = started.attempt, n = attempt.countContract.exactCount;
  lengths.push(n); cycles.push(sql(`select canonical_form_cycle from exam_delivery.attempts where id='${attempt.attemptId}'`));
  eq(started.items.length, n);
  eq((Date.parse(attempt.expiresAt) - Date.parse(attempt.startedAt))/1000, 2700);
  eq((await operation('practiceStart', { p_request: startRequest })).attempt.attemptId, attempt.attemptId);
  const resumed = await operation('resume', { p_attempt_id: attempt.attemptId });
  eq(resumed.attempt.countContract, attempt.countContract);
  eq(resumed.items.map(i => i.itemId), started.items.map(i => i.itemId));
  eq(resumed.attempt.expiresAt, attempt.expiresAt);
  if(turn===0) {
    const successor=structuredClone(payload); successor.exam.packageVersion='1.1.0';
    const publication=await publish(successor); eq(publication.error,null);
    const retained=await operation('resume',{p_attempt_id:attempt.attemptId});
    eq(retained.attempt.packageVersion,'1.0.0'); eq(retained.attempt.countContract,attempt.countContract); eq(retained.attempt.expiresAt,attempt.expiresAt);
  }
  const saved = await admin.rpc('certsim_protected_save_response', { p_actor_id: learner.id, p_attempt_id: attempt.attemptId, p_item_id: started.items[0].itemId,
    p_response: { answer: { a: true, b: true } }, p_expected_revision: 0, p_request_id: crypto.randomUUID() });
  if (saved.error) throw Error(`VARIABLE_SAVE_FAILED_${saved.error.message}`);
  eq(saved.data.revision, 1);
  const submission = crypto.randomUUID();
  const result = await admin.rpc('certsim_protected_submit_attempt', { p_actor_id: learner.id, p_attempt_id: attempt.attemptId, p_submission_id: submission });
  if (result.error) throw Error(`VARIABLE_SUBMIT_FAILED_${result.error.message}`);
  eq(result.data.ok, true);
  const replay=await admin.rpc('certsim_protected_submit_attempt',{p_actor_id:learner.id,p_attempt_id:attempt.attemptId,p_submission_id:submission});
  eq(replay.error,null);eq(replay.data.result,result.data.result);
  eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${attempt.attemptId}'`),'1');
  eq(sql(`select count(*) from public.exam_results where attempt_id='${attempt.attemptId}'`),'1');
  // Verify using persisted scoring authority, not a client-derived denominator.
  const scoring = JSON.parse(sql(`select jsonb_build_object('count',(result_summary->>'questionCount')::integer,'earned',raw_score,'maximum',max_score) from exam_delivery.attempt_results where attempt_id='${attempt.attemptId}'`));
  eq(scoring, { count: n, earned: 1, maximum: n*2 });
}
eq(lengths, [3,5,3]); eq(cycles, ['1','1','2']);
const failedRequest=request(), beforeFailure=sql(`select count(*) from exam_delivery.attempts where owner_id='${learner.id}'`);
sql(`create function public.variable_fail_item() returns trigger language plpgsql set search_path='' as $$begin
if exists(select 1 from exam_delivery.attempts a where a.id=new.attempt_id and a.owner_id='${learner.id}'::uuid) then raise exception 'synthetic_materialization_failure';end if;return new;end$$;
create trigger variable_fail_item before insert on exam_delivery.attempt_items for each row execute function public.variable_fail_item();`);
try { await assert.rejects(operation('practiceStart',{p_request:failedRequest}),/synthetic_materialization_failure/); assertions++; }
finally { sql('drop trigger variable_fail_item on exam_delivery.attempt_items;drop function public.variable_fail_item()'); }
eq(sql(`select count(*) from exam_delivery.attempts where owner_id='${learner.id}'`),beforeFailure);
eq(sql(`select count(*) from exam_delivery.attempts where client_request_id='${failedRequest.clientRequestId}'`),'0');
const retried=await operation('practiceStart',{p_request:failedRequest});
eq(retried.attempt.countContract.exactCount,5);
eq(sql(`select canonical_form_cycle from exam_delivery.attempts where id='${retried.attempt.attemptId}'`),'2');
const racedRequest = request();
// Hold the allocator's exact advisory lock until both real Start transactions
// have reached database lock waits. No timing guess decides the race outcome.
const lockProcess=spawn('psql',[database,'-XqAt','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe']});
await new Promise((resolve,reject)=>{
  let output=''; lockProcess.stdout.on('data',chunk=>{output+=chunk;if(output.includes('BARRIER_READY'))resolve();});
  lockProcess.once('error',reject); lockProcess.once('exit',code=>{if(code)reject(Error('START_BARRIER_FAILED'));});
  lockProcess.stdin.write(`select pg_advisory_lock(hashtextextended('${raceLearner.id}:${packageId}:${profileId}',0));select 'BARRIER_READY';\n`);
});
const racePromise=Promise.all([operation('practiceStart',{p_request:racedRequest},raceLearner.id),operation('practiceStart',{p_request:racedRequest},raceLearner.id)]);
try {
  const until=Date.now()+7000;
  while(Number(sql("select count(*) from pg_locks where locktype='advisory' and not granted"))<2) {
    if(Date.now()>until)throw Error('START_TRANSACTIONS_DID_NOT_REACH_BARRIER');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assertions++;
} finally { lockProcess.stdin.end("select pg_advisory_unlock_all();\n"); }
const raced=await racePromise;
eq(raced[0].attempt.attemptId,raced[1].attempt.attemptId);
eq(sql(`select count(*) from exam_delivery.attempts where owner_id='${raceLearner.id}'`),'1');
if (process.env.RUNNER_TEMP) await writeFile(path.join(process.env.RUNNER_TEMP,'variable-browser-account.json'),JSON.stringify(browserLearner),{mode:0o600});
if (process.env.RUNNER_TEMP) await writeFile(path.join(process.env.RUNNER_TEMP,'variable-negative-account.json'),JSON.stringify(negativeLearner),{mode:0o600});
sql('select exam_delivery.set_expiry_enrolment(true)');
const assigned=await ownerClient.rpc('certsim_create_live_assignment_v2',{p_request:{targetUserId:assignedLearner.id,organisationId:org,examKey:'inf303',packageVersion:'1.0.0',profileKey:'inf303-standard',maximumAttempts:1,reviewReleasePolicy:'after_submission',answerReleasePolicy:'after_submission',requestId:crypto.randomUUID()}});
eq(assigned.error,null);eq(assigned.data.ok,true);
const assignedStart=await operation('start',{p_exam_key:'inf303',p_profile_key:'inf303-standard',p_request_id:crypto.randomUUID(),p_assignment_id:assigned.data.assignmentId},assignedLearner.id);
eq(assignedStart.attempt.assignmentId,assigned.data.assignmentId);eq(assignedStart.attempt.purpose,'assigned_assessment');
eq(assignedStart.attempt.countContract.exactCount,3);
eq((Date.parse(assignedStart.attempt.expiresAt)-Date.parse(assignedStart.attempt.startedAt))/1000,2700);
eq(sql(`select (e.identity->>'form'=a.canonical_form_id::text) and (e.identity->>'cycle')::integer=a.canonical_form_cycle from exam_delivery.expiry_authority e join exam_delivery.attempts a on a.id=e.attempt_id where a.id='${assignedStart.attempt.attemptId}'`),'t');
const assignedResult=await admin.rpc('certsim_protected_submit_attempt',{p_actor_id:assignedLearner.id,p_attempt_id:assignedStart.attempt.attemptId,p_submission_id:crypto.randomUUID()});
eq(assignedResult.error,null);eq(assignedResult.data.result.questionCount,3);eq(assignedResult.data.result.rawScore,0);eq(assignedResult.data.result.maxScore,6);
console.log(JSON.stringify({ suite: 'variable-python-normal-database-path', assertions, lengths, cycles, normalStartSeconds: 2700, syntheticOnly: true }));
