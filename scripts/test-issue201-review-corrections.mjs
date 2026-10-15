import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const databaseUrl = required('SUPABASE_DB_URL');
const databaseHost = new URL(databaseUrl).hostname;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(databaseHost)) {
  throw new Error('ISSUE86_DISPOSABLE_LOCAL_DATABASE_REQUIRED');
}
const psql = process.env.PSQL_PATH?.trim() || 'psql';
let assertions = 0;

const ids = {
  owner: '86000000-0000-4000-8000-000000000001',
  outsider: '86000000-0000-4000-8000-000000000002',
  organisation: '86000000-0000-4000-8000-000000000010',
  package: '86000000-0000-4000-8000-000000000020',
  profile: '86000000-0000-4000-8000-000000000021',
  executableQuestion: '86000000-0000-4000-8000-000000000022',
  ordinaryQuestion: '86000000-0000-4000-8000-000000000023',
  unansweredQuestion: '86000000-0000-4000-8000-000000000024',
  unansweredQuestionTwo: '86000000-0000-4000-8000-000000000025',
  unansweredQuestionThree: '86000000-0000-4000-8000-000000000026',
  unansweredQuestionFour: '86000000-0000-4000-8000-000000000027',
  unansweredQuestionFive: '86000000-0000-4000-8000-000000000028',
  unansweredQuestionSix: '86000000-0000-4000-8000-000000000029',
  ownerAttempt: '86000000-0000-4000-8000-000000000030',
  ownerItem: '86000000-0000-4000-8000-000000000031',
  ownerOrdinaryItem: '86000000-0000-4000-8000-000000000032',
  ownerUnansweredItem: '86000000-0000-4000-8000-000000000033',
  ownerUnansweredItemTwo: '86000000-0000-4000-8000-000000000034',
  ownerUnansweredItemThree: '86000000-0000-4000-8000-000000000035',
  ownerUnansweredItemFour: '86000000-0000-4000-8000-000000000036',
  ownerUnansweredItemFive: '86000000-0000-4000-8000-000000000037',
  ownerUnansweredItemSix: '86000000-0000-4000-8000-000000000038',
  outsiderAttempt: '86000000-0000-4000-8000-000000000040',
  outsiderItem: '86000000-0000-4000-8000-000000000041',
  abandonedAttempt: '86000000-0000-4000-8000-000000000050',
  abandonedItem: '86000000-0000-4000-8000-000000000051',
  saveOne: '86000000-0000-4000-8000-000000000060',
  staleSave: '86000000-0000-4000-8000-000000000061',
  saveTwo: '86000000-0000-4000-8000-000000000062',
  runRequest: '86000000-0000-4000-8000-000000000070',
  invalidRun: '86000000-0000-4000-8000-000000000071',
  invalidRunRequest: '86000000-0000-4000-8000-000000000072',
  run: '86000000-0000-4000-8000-000000000073',
  secondRun: '86000000-0000-4000-8000-000000000074',
  secondRunRequest: '86000000-0000-4000-8000-000000000075',
  cancel: '86000000-0000-4000-8000-000000000076',
  evidence: '86000000-0000-4000-8000-000000000080',
  materialization: '86000000-0000-4000-8000-000000000081',
  gradingSession: '86000000-0000-4000-8000-000000000082',
  liveClientRequest: '86000000-0000-4000-8000-000000000090',
  liveExecutionRequest: '86000000-0000-4000-8000-000000000091',
  replayExecutionRequest: '86000000-0000-4000-8000-000000000092',
  competingClientRequest: '86000000-0000-4000-8000-000000000093',
  competingExecutionRequest: '86000000-0000-4000-8000-000000000094',
  ordinaryResponse: '86000000-0000-4000-8000-000000000095',
  ordinaryResponseRequest: '86000000-0000-4000-8000-000000000096',
  submission: '86000000-0000-4000-8000-000000000097',
  conflictingSubmission: '86000000-0000-4000-8000-000000000098',
  allUnansweredAttempt: '86000000-0000-4000-8000-000000000100',
  allUnansweredItemOne: '86000000-0000-4000-8000-000000000101',
  allUnansweredItemTwo: '86000000-0000-4000-8000-000000000102',
  allUnansweredItemThree: '86000000-0000-4000-8000-000000000103',
  allUnansweredItemFour: '86000000-0000-4000-8000-000000000104',
  allUnansweredItemFive: '86000000-0000-4000-8000-000000000105',
  allUnansweredItemSix: '86000000-0000-4000-8000-000000000106',
  allUnansweredItemSeven: '86000000-0000-4000-8000-000000000107',
  allUnansweredSubmission: '86000000-0000-4000-8000-000000000108',
  expiredFrozenAttempt: '86000000-0000-4000-8000-000000000109',
  expiredFrozenSubmission: '86000000-0000-4000-8000-000000000110',
};

const gradingMaterial = {
  contractVersion: 'certsim-python-trusted-grading-v1',
  taskId: 'issue86-executable',
  maximumRawPoints: 5,
  rules: [{
    id: 'rule.synthetic', type: 'TOKEN', points: 5,
    compiled: {
      contractVersion: 'certsim-python-trusted-grading-v1',
      family: 'token_comment', target: 'process_records', anchor: 'For',
      anchorOccurrence: 1, relation: 'immediately_before_same_block',
      requiredConceptGroups: [['store', 'stores'], ['record', 'records'], ['batch', 'output']],
    },
  }],
};
const gradingMaterialDigest = createHash('sha256').update(canonicalJson(gradingMaterial)).digest('hex');
const executableScoring = {
  maximumRawPoints: 5,
  trustedGrading: { status: 'compiled', materialDigest: gradingMaterialDigest, gradingMaterial },
};

runSql(`
  insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
    ('00000000-0000-0000-0000-000000000000','${ids.owner}','authenticated','authenticated','owner-86@example.invalid','','{}','{}',now(),now()),
    ('00000000-0000-0000-0000-000000000000','${ids.outsider}','authenticated','authenticated','outsider-86@example.invalid','','{}','{}',now(),now());
  update public.profiles set status='active' where id in ('${ids.owner}','${ids.outsider}');
  insert into public.organisations(id,name,organisation_type,status)
    values('${ids.organisation}','Issue 86 disposable fixture','internal','active');
  insert into public.memberships(user_id,organisation_id,role,status) values
    ('${ids.owner}','${ids.organisation}','platform_owner','active'),
    ('${ids.outsider}','${ids.organisation}','platform_owner','active');

  insert into exam_delivery.package_versions(
    id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,
    package_schema_version,generator_version,scorer_version,created_at
  ) values(
    '${ids.package}','issue86fixture','1.0.0',repeat('1',40),repeat('2',64),repeat('3',64),
    'certsim-protected-package-v2','issue86','issue86',statement_timestamp()
  );
  insert into exam_delivery.package_profiles(
    id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config
  ) values('${ids.profile}','${ids.package}','python-r5','Issue 86 synthetic profile',8,60,'{}');
  insert into exam_delivery.package_questions(
    id,package_version_id,question_id,question_type,domain_key,section_key,
    source_ordinal,presentation_payload,content_hash
  ) values
    ('${ids.executableQuestion}','${ids.package}','issue86-executable','executable-python-lab-v1','d1','python',1,
      '{"interactionVersion":"executable-python-lab-v1"}',repeat('4',64)),
    ('${ids.ordinaryQuestion}','${ids.package}','issue86-ordinary','single-choice','d1','standard',2,
      '{"stem":"synthetic","options":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}',repeat('5',64)),
    ('${ids.unansweredQuestion}','${ids.package}','issue86-unanswered','executable-python-lab-v1','d1','python',3,
      '{"interactionVersion":"executable-python-lab-v1"}',repeat('f',64)),
    ('${ids.unansweredQuestionTwo}','${ids.package}','issue86-unanswered-2','executable-python-lab-v1','d1','python',4,
      '{"interactionVersion":"executable-python-lab-v1"}',repeat('0',64)),
    ('${ids.unansweredQuestionThree}','${ids.package}','issue86-unanswered-3','executable-python-lab-v1','d1','python',5,
      '{"interactionVersion":"executable-python-lab-v1"}',repeat('1',64)),
    ('${ids.unansweredQuestionFour}','${ids.package}','issue86-unanswered-4','executable-python-lab-v1','d1','python',6,
      '{"interactionVersion":"executable-python-lab-v1"}',repeat('2',64)),
    ('${ids.unansweredQuestionFive}','${ids.package}','issue86-unanswered-5','executable-python-lab-v1','d1','python',7,
      '{"interactionVersion":"executable-python-lab-v1"}',repeat('3',64)),
    ('${ids.unansweredQuestionSix}','${ids.package}','issue86-unanswered-6','executable-python-lab-v1','d1','python',8,
      '{"interactionVersion":"executable-python-lab-v1"}',repeat('4',64));
  insert into exam_delivery.package_question_protected_content(
    question_id,package_version_id,scoring_payload,review_payload,authoring_metadata
  ) values
    ('${ids.executableQuestion}','${ids.package}','${JSON.stringify(executableScoring)}','{}','{"scored":true}'),
    ('${ids.ordinaryQuestion}','${ids.package}','{"correctAnswer":"a"}',
      '{"explanation":"Synthetic explanation.","remediation":"Synthetic remediation."}','{"scored":true}'),
    ('${ids.unansweredQuestion}','${ids.package}','{"maximumRawPoints":7}','{}','{"scored":true}'),
    ('${ids.unansweredQuestionTwo}','${ids.package}','{"maximumRawPoints":7}','{}','{"scored":true}'),
    ('${ids.unansweredQuestionThree}','${ids.package}','{"maximumRawPoints":7}','{}','{"scored":true}'),
    ('${ids.unansweredQuestionFour}','${ids.package}','{"maximumRawPoints":7}','{}','{"scored":true}'),
    ('${ids.unansweredQuestionFive}','${ids.package}','{"maximumRawPoints":7}','{}','{"scored":true}'),
    ('${ids.unansweredQuestionSix}','${ids.package}','{"maximumRawPoints":7}','{}','{"scored":true}');
  insert into exam_delivery.package_profiles(id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config)
    values('86201000-0000-4000-8000-000000000021','${ids.package}','canonical','Synthetic canonical',8,60,'{}');
  insert into exam_delivery.package_forms(id,package_version_id,package_profile_id,form_key,form_ordinal,question_count,membership_hash,blueprint_contract)
    values('86201000-0000-4000-8000-000000000022','${ids.package}','86201000-0000-4000-8000-000000000021','form-a',1,8,repeat('c',64),'{}');
  insert into exam_delivery.package_form_questions(form_id,package_profile_id,package_version_id,package_question_id,presentation_ordinal)
    select '86201000-0000-4000-8000-000000000022','86201000-0000-4000-8000-000000000021','${ids.package}',id,source_ordinal
    from exam_delivery.package_questions where package_version_id='${ids.package}';
  update exam_delivery.package_versions set status='published',published_at=statement_timestamp()
    where id='${ids.package}';
  insert into exam_delivery.exam_profile_activations(
    package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by
  ) values('${ids.package}','${ids.profile}',true,'production',statement_timestamp(),'${ids.owner}');
  insert into exam_delivery.practice_policies(
    canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
    maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy
  ) values
    ('issue86fixture','1.0.0','python-r5','study_sandbox','open_authenticated',true,
      10,true,'immediate_study_feedback','immediate_study_feedback'),
    ('issue86fixture','1.0.0','python-r5','self_directed_exam','open_authenticated',true,
      10,false,'never','never');


`);

// Review reproduction uses public start/save/prepare/submit and fixed trusted
// completion/evidence entry points; the package and grading material above are
// synthetic fixture setup. No provider is invoked.
const before = process.argv.includes('--expect-before');
const formProfile='86201000-0000-4000-8000-000000000021';
runSql(`
 insert into exam_delivery.exam_profile_activations(package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by)
 values('${ids.package}','${formProfile}',true,'production',now(),'${ids.owner}');
 insert into exam_delivery.exam_access_policies(canonical_exam_key,access_mode,enabled,enabled_at)
 values('issue86fixture','open_authenticated',true,now());
 insert into exam_delivery.package_profile_defaults(canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,configured_by)
 values('issue86fixture','canonical','assigned_assessment','${ids.package}','${formProfile}','${ids.owner}'),
 ('issue86fixture','python-r5','self_directed_exam','${ids.package}','${ids.profile}','${ids.owner}');
 select exam_delivery.set_expiry_enrolment(true);
`);
const formRequest=crypto.randomUUID();
const formSql=`set role service_role;select public.certsim_protected_start_attempt('${ids.owner}','issue86fixture','canonical','${formRequest}')`;
if(process.argv.includes('--seed-worker-executable')){
 equal(rpc(formSql).ok,true,'worker fixture uses ordinary canonical executable start');
 const untouched=rpc(`set role service_role;select public.certsim_protected_start_practice('${ids.outsider}','${JSON.stringify({examKey:'issue86fixture',profileId:'python-r5',purpose:'self_directed_exam',count:8,language:'not_applicable',includePbqs:true,mixStrategy:'balanced',clientRequestId:crypto.randomUUID()})}'::jsonb)`);
 equal(untouched.ok,true,'worker fixture uses ordinary untouched Lab start');
 console.log(JSON.stringify({suite:'issue201-worker-executable-fixture',started:2,providerCalls:0,syntheticOnly:true}));
 process.exit(0);
}
if(before){
 expectFailure(formSql,/expiry_authority_immutable/,'normal canonical start fails before correction');
 equal(scalar(`select count(*) from exam_delivery.attempts where client_request_id='${formRequest}'`),'0','failed canonical start rolls back attempt');
 console.log('REVIEW_BEFORE_CANONICAL_START=FAIL_REPRODUCED_expiry_authority_immutable');
}else{
 const started=rpc(formSql);equal(started.ok,true,'normal canonical start succeeds');
 const attemptId=started.attempt.attemptId;
 const frozen=rpc(`select jsonb_build_object('matches',e.identity=exam_delivery.expiry_identity(a),'formSet',a.canonical_form_id is not null,'cycle',a.canonical_form_cycle,'items',(select count(*) from exam_delivery.attempt_items where attempt_id=a.id)) from exam_delivery.attempts a join exam_delivery.expiry_authority e on e.attempt_id=a.id where a.id='${attemptId}'`);
 equal(frozen,{matches:true,formSet:true,cycle:1,items:8},'completed server-assigned form and cycle are frozen');
 equal(rpc(formSql).attempt.attemptId,attemptId,'normal start replay keeps identity');
 expectFailure(`update exam_delivery.attempts set canonical_form_cycle=2 where id='${attemptId}'`,/immutable/,'canonical cycle remains immutable');
 expectFailure(`update exam_delivery.attempts set canonical_form_id=null,canonical_form_cycle=null where id='${attemptId}'`,/immutable/,'canonical form cannot be removed');
 runSql(`create function public.issue201_test_creation_fault() returns trigger language plpgsql as $$begin raise exception 'synthetic_creation_fault';end$$;
 create trigger issue201_test_creation_fault after insert on exam_delivery.attempt_items for each row execute function public.issue201_test_creation_fault();`);
 const rollbackRequest=crypto.randomUUID();
 expectFailure(`set role service_role;select public.certsim_protected_start_attempt('${ids.outsider}','issue86fixture','canonical','${rollbackRequest}')`,/synthetic_creation_fault/,'materialization fault rolls back normal start');
 equal(scalar(`select count(*) from exam_delivery.attempts where client_request_id='${rollbackRequest}'`),'0','failed creation leaves no attempt');
 equal(scalar('select count(*) from exam_delivery.expiry_authority'),'1','failed creation leaves no partial authority');
 runSql('drop trigger issue201_test_creation_fault on exam_delivery.attempt_items;drop function public.issue201_test_creation_fault()');
 const earlyRequest=crypto.randomUUID();
 expectFailure(`begin;set constraints all immediate;set role service_role;select public.certsim_protected_start_attempt('${ids.outsider}','issue86fixture','canonical','${earlyRequest}');commit`,/expiry_initialization_incomplete/,'early constraint evaluation fails closed before allocation');
 equal(scalar(`select count(*) from exam_delivery.attempts where client_request_id='${earlyRequest}'`),'0','early freeze cannot commit an incomplete attempt');
 console.log('REVIEW_AFTER_CANONICAL_START=PASS_complete_identity_atomic_creation_immutable');
}
const startLab=actor=>rpc(`set role service_role;select public.certsim_protected_start_practice('${actor}','${JSON.stringify({examKey:'issue86fixture',profileId:'python-r5',purpose:'self_directed_exam',count:8,language:'not_applicable',includePbqs:true,mixStrategy:'balanced',clientRequestId:crypto.randomUUID()})}'::jsonb)`);
const lab=startLab(ids.owner);equal(lab.ok,true,'normal timed Lab start succeeds');
const labId=lab.attempt.attemptId;
equal(scalar(`select count(*) from exam_delivery.expiry_authority where attempt_id='${labId}'`),'1','Lab is enrolled');
const labItem=scalar(`select id from exam_delivery.attempt_items where attempt_id='${labId}' and package_question_id='${ids.executableQuestion}'`);
const ordinaryItem=scalar(`select id from exam_delivery.attempt_items where attempt_id='${labId}' and package_question_id='${ids.ordinaryQuestion}'`);
const saved=rpc(`set role service_role;select public.certsim_protected_save_python_workspace('${ids.owner}','${labId}','${labItem}','{"entryPoint":"main.py","files":[{"path":"main.py","content":"pass"}]}',0,'${crypto.randomUUID()}')`);
equal(saved.ok,true,'normal workspace save succeeds');
equal(rpc(`set role service_role;select public.certsim_protected_save_response('${ids.owner}','${labId}','${ordinaryItem}','{"answer":"a"}',0,'${crypto.randomUUID()}')`).ok,true,'ordinary answer persists normally');
const submission=crypto.randomUUID();
const prepare=()=>rpc(`set role service_role;select public.certsim_service_prepare_python_submission_grading('${ids.owner}','${labId}','${submission}')`);
const prepared=prepare();equal(prepared.ok,true,'manual grading preparation succeeds');equal(prepared.items.length,1,'only workspace-backed task needs evidence');
const grade=prepared.items[0];
const submit=()=>rpc(`set role service_role;select public.certsim_protected_submit_attempt('${ids.owner}','${labId}','${submission}')`);
equal(submit().code,'grading_incomplete','saved workspace without evidence cannot score');
equal(scalar(`select count(*) from exam_delivery.attempt_results where attempt_id='${labId}'`),'0','missing evidence creates no result');
const requestDigest='6'.repeat(64),resultDigest='8'.repeat(64);
equal(rpc(`set role service_role;select public.certsim_service_materialize_python_submission_grading('${ids.owner}','${labId}','${submission}','${labItem}','${grade.runId}','${requestDigest}')`).claimed,true,'fixed materialization claims frozen task');
equal(rpc(`set role service_role;select public.certsim_service_complete_python_execution('${grade.runId}','${requestDigest}','execution.${grade.executionRequestId}','${resultDigest}','completed','completed','','',0,true)`).state,'completed','synthetic trusted execution completes without provider');
equal(submit().code,'grading_incomplete','terminal execution without verified evidence still cannot score');
const evidence=rpc(`set role service_role;select public.certsim_service_persist_verified_python_grading_evidence('${grade.gradingSessionId}','${grade.runId}','${grade.materializationId}','${grade.gradingSessionId}','${requestDigest}','${resultDigest}','${gradingMaterialDigest}','certsim-python-trusted-grading-v1',4,5,'[{"ruleId":"rule.synthetic","earnedRawPoints":4,"maximumRawPoints":5}]')`);
equal(evidence.ok,true,'verified evidence persists through fixed entry point');
equal(prepare().ready,true,'workspace task is ready with verified bound evidence');
const submitted=submit();
if(before){
 equal(submitted.code,'grading_incomplete','unanswered tasks wrongly prevent manual completion before correction');
 equal(scalar(`select count(*) from exam_delivery.attempt_results where attempt_id='${labId}'`),'0','before failure leaves no result');
 console.log('REVIEW_BEFORE_MIXED_LAB_MANUAL=FAIL_REPRODUCED_grading_incomplete_despite_verified_saved_task');
}else{
 equal(submitted.ok,true,'mixed Lab manual submission succeeds');
 equal(rpc(`select jsonb_build_array(raw_score,max_score,(result_summary->>'answeredCount')::integer) from exam_delivery.attempt_results where attempt_id='${labId}'`),[5,48,2],'unanswered tasks retain established scoring and denominator');
 equal(scalar(`select count(*) from exam_delivery.python_lab_workspaces where attempt_id='${labId}'`),'1','six untouched tasks remain workspace-free');
 equal(scalar(`select count(*) from exam_delivery.python_submission_grading_runs where attempt_id='${labId}'`),'1','no grading work manufactured for unanswered tasks');
 equal(submit().ok,true,'same manual identity replays one result');
 equal(scalar(`select count(*) from exam_delivery.attempt_results where attempt_id='${labId}'`),'1','manual replay creates no duplicate');
 console.log('REVIEW_AFTER_MIXED_LAB_MANUAL=PASS_bound_evidence_plus_existing_unanswered_scoring');
}
const empty=startLab(ids.outsider);equal(empty.ok,true,'normal entirely unanswered Lab starts');
const emptyId=empty.attempt.attemptId,emptySubmission=crypto.randomUUID();
equal(rpc(`set role service_role;select public.certsim_service_prepare_python_submission_grading('${ids.outsider}','${emptyId}','${emptySubmission}')`),{ok:true,required:true,ready:true,completed:false,items:[]},'existing preparation freezes identity but creates no grading jobs for unanswered Lab');
const emptyResult=rpc(`set role service_role;select public.certsim_protected_submit_attempt('${ids.outsider}','${emptyId}','${emptySubmission}')`);
if(before)equal(emptyResult.code,'grading_incomplete','blanket session requirement reproduces entirely unanswered failure');
else{
 equal(emptyResult.ok,true,'unanswered Lab submits by existing scoring');
 equal(rpc(`select jsonb_build_array(raw_score,max_score) from exam_delivery.attempt_results where attempt_id='${emptyId}'`),[0,48],'genuinely unanswered Lab uses existing zero-earned denominator');
 equal(scalar(`select count(*) from exam_delivery.python_submission_grading_sessions where attempt_id='${emptyId}'`),'1','existing manual preparation session retained');
 equal(scalar(`select count(*) from exam_delivery.python_submission_grading_runs where attempt_id='${emptyId}'`),'0','unanswered items need no grading jobs');
 equal(scalar(`select count(*) from exam_delivery.python_grading_evidence e join exam_delivery.python_execution_runs r on r.id=e.run_id where r.attempt_id='${emptyId}'`),'0','unanswered scoring manufactures no evidence');
}
runSql('select exam_delivery.set_expiry_enrolment(false)');
console.log(JSON.stringify({suite:'issue201-source-review',mode:before?'failing-before-reproduced':'passing-after',assertions,providerCalls:0,syntheticOnly:true}));
function required(name) {
  const value=process.env[name]?.trim();
  if(!value) throw new Error(`Missing ${name}`);
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function execute(sql) {
  return spawnSync(psql, ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', databaseUrl], {
    input: `${sql.trim()}\n`,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function runSql(sql) {
  const result = execute(sql);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'psql failed');
  return result.stdout.trim();
}

function scalar(sql) {
  return runSql(sql).split(/\r?\n/).at(-1)?.trim() ?? '';
}

function rpc(sql) {
  return JSON.parse(scalar(sql));
}

function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message);
  assertions += 1;
}

function match(actual, pattern, message) {
  assert.match(actual, pattern, message);
  assertions += 1;
}

function expectFailure(sql, pattern, message) {
  const result = execute(sql);
  assert.notEqual(result.status, 0, `${message}: statement unexpectedly succeeded`);
  assert.match(`${result.stderr}\n${result.stdout}`, pattern, message);
  assertions += 1;
}
