import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { buildExamOperationsCurrentState } from './backend-exam-publication/exam-operations-current-state.mjs';
import { createExamOperationsHealth } from './backend-exam-publication/exam-operations-health.mjs';
import { buildExamOperationsReadQuery } from './exam-operations/read-production-state.mjs';

const databaseUrl = required('SUPABASE_DB_URL');
const psql = process.env.PSQL_PATH?.trim() || 'psql';
const parsedUrl = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsedUrl.hostname)) {
  throw new Error('ISSUE133_DISPOSABLE_LOCAL_DATABASE_REQUIRED');
}

const ids = Object.freeze({
  owner: '13340000-0000-4000-8000-000000000001',
  learner: '13340000-0000-4000-8000-000000000002',
  other: '13340000-0000-4000-8000-000000000003',
  organisation: '13340000-0000-4000-8000-000000000004',
  predecessorPackage: '13340000-0000-4000-8000-000000000010',
  predecessorProfile: '13340000-0000-4000-8000-000000000011',
  predecessorQuestion: '13340000-0000-4000-8000-000000000012',
  successorPackage: '13340000-0000-4000-8000-000000000020',
  successorProfile: '13340000-0000-4000-8000-000000000021',
  successorQuestion: '13340000-0000-4000-8000-000000000022',
  feedbackAttempt: '13340000-0000-4000-8000-000000000030',
  feedbackItem: '13340000-0000-4000-8000-000000000031',
  withheldAttempt: '13340000-0000-4000-8000-000000000032',
  withheldItem: '13340000-0000-4000-8000-000000000033',
  idleExpiredAttempt: '13340000-0000-4000-8000-000000000034',
  assignment: '13340000-0000-4000-8000-000000000040',
});
const examKey = 'issue133fixture';
const profileKey = 'full';
const successorPackageHash = 'b'.repeat(64);
const successorValidationHash = 'd'.repeat(64);
let regressionRequestOrdinal = 200;

seedFixture();

const initialHash = scalar(`select exam_delivery.release_configuration_hash('${examKey}')`);
const releaseSet = {
  schemaVersion: 'certsim-exam-release-set-v1',
  examKey,
  targetPackageId: ids.successorPackage,
  catalogue: { currentVersion: '2.0.0', status: 'active' },
  profiles: [{
    profileKey,
    targetProfileId: ids.successorProfile,
    bindings: [
      'assigned_assessment', 'self_directed_exam', 'study_sandbox',
      'targeted_domain', 'weak_area', 'pbq_practice',
    ].map((purpose) => ({ purpose, action: 'MOVE' })),
    practicePolicies: [
      'self_directed_exam', 'study_sandbox', 'targeted_domain',
      'weak_area', 'pbq_practice',
    ].map((purpose) => ({
      purpose,
      accessMode: 'production_authorized',
      enabled: true,
      maximumCompletedAttempts: null,
      cooldownSeconds: 0,
      maximumConcurrentSessions: 1,
      maximumSessionItems: 10,
      immediateFeedback: purpose === 'study_sandbox',
      reviewReleasePolicy: purpose === 'study_sandbox'
        ? 'immediate_study_feedback' : 'after_submission',
      answerReleasePolicy: purpose === 'study_sandbox'
        ? 'immediate_study_feedback' : 'after_submission',
    })),
  }],
};
const releaseSetHash = scalar(`select exam_delivery.examops_json_hash(${jsonSql(releaseSet)})`);
const evidence = Object.freeze({
  examKey,
  targetPackageId: ids.successorPackage,
  releaseSet,
  releaseSetHash,
  manifestHash: 'e'.repeat(64),
  packageHash: successorPackageHash,
  validationHash: successorValidationHash,
  releaseDiffHash: 'f'.repeat(64),
  expectedCurrentStateHash: initialHash,
});

const preflight = ownerRpc('certsim_examops_preflight_exam_release', evidence);
assert.equal(preflight.ok, true);
assert.equal(preflight.outcome, 'SAFE_WITH_PREDECESSOR_PRESERVATION');
assert.equal(preflight.activeAttempts.displacedPractice, 2);

const stageRequest = { ...evidence, requestId: '13340000-0000-4000-8000-000000000100' };
const beforeStageHash = scalar(`select exam_delivery.release_configuration_hash('${examKey}')`);
const stage = ownerRpc('certsim_examops_stage_exam_release', stageRequest);
assert.equal(stage.ok, true);
assert.equal(stage.resultState, 'succeeded');
assert.equal(scalar(`select exam_delivery.release_configuration_hash('${examKey}')`), beforeStageHash);
const stageEventCount = Number(scalar(`select count(*) from exam_delivery.exam_release_operation_events where operation_id='${stage.operationId}'`));
const stageReplay = ownerRpc('certsim_examops_stage_exam_release', stageRequest);
assert.equal(stageReplay.replayed, true);
assert.equal(stageReplay.operationId, stage.operationId);
assert.equal(Number(scalar(`select count(*) from exam_delivery.exam_release_operation_events where operation_id='${stage.operationId}'`)), stageEventCount);
const stageConflict = ownerRpc('certsim_examops_stage_exam_release', {
  ...stageRequest,
  manifestHash: '9'.repeat(64),
});
assert.equal(stageConflict.code, 'REQUEST_ID_PAYLOAD_CONFLICT');

const activationBase = { ...evidence, stageOperationId: stage.operationId };
run(`
create function public.issue133_fail_activation() returns trigger language plpgsql as $$
begin
  if new.package_version_id='${ids.successorPackage}'::uuid then
    raise exception 'issue133_test_activation_failure';
  end if;
  return new;
end $$;
create trigger issue133_fail_activation before update on exam_delivery.package_profile_defaults
for each row execute function public.issue133_fail_activation();
`);
const activationBeforeFailure = scalar(`select exam_delivery.release_configuration_hash('${examKey}')`);
const failedActivation = ownerRpc('certsim_examops_activate_exam_release', {
  ...activationBase,
  requestId: '13340000-0000-4000-8000-000000000101',
});
assert.equal(failedActivation.ok, false);
assert.equal(failedActivation.errorCode, 'POSTCONDITION_FAILED');
assert.equal(scalar(`select exam_delivery.release_configuration_hash('${examKey}')`), activationBeforeFailure);
run('drop trigger issue133_fail_activation on exam_delivery.package_profile_defaults; drop function public.issue133_fail_activation();');

const activation = ownerRpc('certsim_examops_activate_exam_release', {
  ...activationBase,
  requestId: '13340000-0000-4000-8000-000000000102',
});
assert.equal(activation.ok, true);
assert.equal(activation.resultState, 'succeeded');
assert.equal(scalar(`select count(*) from exam_delivery.package_profile_defaults where canonical_exam_key='${examKey}' and enabled and package_version_id='${ids.successorPackage}'`), '6');
assert.equal(scalar(`select count(*) from exam_delivery.practice_policies where canonical_exam_key='${examKey}' and enabled and package_version='2.0.0'`), '5');
const activationHealth = readHealth();
assert.equal(activationHealth.latestReleaseConfiguration.operationType, 'ACTIVATE');
assert.equal(activationHealth.latestReleaseConfiguration.packageVersion, '2.0.0');

const assignmentBefore = scalar(`select exam_delivery.examops_json_hash(to_jsonb(assignment)) from public.exam_assignments assignment where id='${ids.assignment}'`);
const assignmentStart = json(`select exam_delivery.start_assignment_attempt(
  '${ids.learner}','${examKey}','${profileKey}',
  '13340000-0000-4000-8000-000000000103','${ids.assignment}'
)::text`);
assert.equal(assignmentStart.ok, true);
assert.equal(assignmentStart.attempt.packageVersion, '1.0.0');
assert.equal(scalar(`select exam_delivery.examops_json_hash(to_jsonb(assignment)) from public.exam_assignments assignment where id='${ids.assignment}'`), assignmentBefore);

for (const operation of ['resume', 'save_response', 'check_item', 'submit']) {
  assert.equal(json(`select exam_delivery.authorize_attempt_continuation('${ids.feedbackAttempt}','${operation}')::text`).ok, true);
}
assert.equal(json(`select exam_delivery.resume_attempt('${ids.learner}','${ids.feedbackAttempt}')::text`).ok, true);
const saved = json(`select exam_delivery.save_response(
  '${ids.learner}','${ids.feedbackAttempt}','${ids.feedbackItem}',
  '{"answer":"a"}'::jsonb,0,'13340000-0000-4000-8000-000000000104'
)::text`);
assert.equal(saved.ok, true);
assert.equal(saved.revision, 1);
run(`update exam_delivery.practice_policies set enabled=false,access_mode='disabled',
  immediate_feedback=false,review_release_policy='never',answer_release_policy='never'
  where canonical_exam_key='${examKey}' and package_version='1.0.0' and purpose='study_sandbox';`);
const checked = json(`select exam_delivery.check_practice_item(
  '${ids.learner}','${ids.feedbackAttempt}','${ids.feedbackItem}',1,
  '13340000-0000-4000-8000-000000000105'
)::text`);
assert.equal(checked.ok, true);
const submitted = json(`select exam_delivery.submit_attempt_v2(
  '${ids.learner}','${ids.feedbackAttempt}','13340000-0000-4000-8000-000000000106'
)::text`);
assert.equal(submitted.ok, true);
const releasedReview = json(`select exam_delivery.get_review('${ids.learner}','${ids.feedbackAttempt}')::text`);
assert.equal(releasedReview.ok, true);
assert.deepEqual(releasedReview.review.items[0].correctAnswer, { correctAnswer: 'a' });

run(`update exam_delivery.practice_policies set immediate_feedback=true,
  review_release_policy='after_submission',answer_release_policy='after_submission'
  where canonical_exam_key='${examKey}' and package_version='1.0.0' and purpose='weak_area';`);
const withheldSave = json(`select exam_delivery.save_response(
  '${ids.learner}','${ids.withheldAttempt}','${ids.withheldItem}',
  '{"answer":"a"}'::jsonb,0,'13340000-0000-4000-8000-000000000107'
)::text`);
assert.equal(withheldSave.ok, true);
assert.equal(json(`select exam_delivery.check_practice_item(
  '${ids.learner}','${ids.withheldAttempt}','${ids.withheldItem}',1,
  '13340000-0000-4000-8000-000000000108'
)::text`).code, 'review_unavailable');

for (const operation of ['resume', 'save_response', 'check_item', 'submit']) {
  assert.equal(
    json(`select exam_delivery.authorize_attempt_continuation('${ids.idleExpiredAttempt}','${operation}')::text`).code,
    'invalid_lifecycle_transition',
  );
}

const successorAttempt = scalar(`
  insert into exam_delivery.attempts(
    owner_id,package_version_id,package_profile_id,client_request_id,status,
    generator_version,scorer_version,created_at,started_at,expires_at,purpose,
    attribution_source
  ) values(
    '${ids.learner}','${ids.successorPackage}','${ids.successorProfile}',
    '13340000-0000-4000-8000-000000000109','in_progress',
    'certsim-az400-case-workspace-generator-v1','certsim-az400-authoritative-scorer-v1',
    statement_timestamp(),statement_timestamp(),statement_timestamp()+interval '30 minutes',
    'self_directed_exam','personal_self_directed'
  ) returning id
`);
assert.equal(json(`select exam_delivery.authorize_attempt_continuation('${successorAttempt}','resume')::text`).ok, true);

const successorHash = scalar(`select exam_delivery.release_configuration_hash('${examKey}')`);
run(`
create function public.issue133_fail_rollback() returns trigger language plpgsql as $$
begin
  raise exception 'issue133_test_rollback_failure';
end $$;
create trigger issue133_fail_rollback before update on exam_delivery.practice_policies
for each row when (old.canonical_exam_key='${examKey}') execute function public.issue133_fail_rollback();
`);
const failedRollback = ownerRpc('certsim_examops_rollback_exam_release', {
  requestId: '13340000-0000-4000-8000-000000000110',
  examKey,
  rollbackOfOperationId: activation.operationId,
  expectedCurrentStateHash: successorHash,
});
assert.equal(failedRollback.ok, false);
assert.equal(failedRollback.errorCode, 'POSTCONDITION_FAILED');
assert.equal(scalar(`select exam_delivery.release_configuration_hash('${examKey}')`), successorHash);
run('drop trigger issue133_fail_rollback on exam_delivery.practice_policies; drop function public.issue133_fail_rollback();');

const rollback = ownerRpc('certsim_examops_rollback_exam_release', {
  requestId: '13340000-0000-4000-8000-000000000111',
  examKey,
  rollbackOfOperationId: activation.operationId,
  expectedCurrentStateHash: successorHash,
});
assert.equal(rollback.ok, true);
assert.equal(rollback.resultState, 'succeeded');
assert.equal(rollback.targetPackageId, ids.predecessorPackage);
assert.equal(scalar(`select exam_delivery.release_configuration_hash('${examKey}')`), initialHash);
assert.equal(json(`select exam_delivery.authorize_attempt_continuation('${successorAttempt}','resume')::text`).ok, true);
assert.equal(scalar(`select count(*) from exam_delivery.package_profile_defaults where canonical_exam_key='${examKey}' and enabled and package_version_id='${ids.predecessorPackage}'`), '6');
assert.equal(scalar(`select target_package_id from exam_delivery.exam_release_operations where id='${rollback.operationId}'`), ids.predecessorPackage);
const rollbackHealth = readHealth();
assert.equal(rollbackHealth.latestReleaseConfiguration.operationType, 'ROLLBACK');
assert.equal(rollbackHealth.latestReleaseConfiguration.packageVersion, '1.0.0');
assert.equal(rollbackHealth.currentPackage.packageVersion, '1.0.0');

assertCurrentStateBlocked({
  name: 'ambiguousDefaults',
  expectedCode: 'CURRENT_PACKAGE_AMBIGUOUS',
  mutate: `update exam_delivery.package_profile_defaults
    set package_version_id='${ids.successorPackage}',package_profile_id='${ids.successorProfile}'
    where canonical_exam_key='${examKey}' and purpose='pbq_practice'`,
  restore: `update exam_delivery.package_profile_defaults
    set package_version_id='${ids.predecessorPackage}',package_profile_id='${ids.predecessorProfile}'
    where canonical_exam_key='${examKey}' and purpose='pbq_practice'`,
});
assertCurrentStateBlocked({
  name: 'missingActivation',
  expectedCode: 'CURRENT_ACTIVATION_MISSING',
  mutate: `update exam_delivery.exam_profile_activations
    set enabled=false,disabled_at=statement_timestamp()
    where package_version_id='${ids.predecessorPackage}'
      and package_profile_id='${ids.predecessorProfile}'
      and activation_kind='production'`,
  restore: `update exam_delivery.exam_profile_activations
    set enabled=true,enabled_at=statement_timestamp(),disabled_at=null
    where package_version_id='${ids.predecessorPackage}'
      and package_profile_id='${ids.predecessorProfile}'
      and activation_kind='production'`,
});
assertCurrentStateBlocked({
  name: 'missingPolicy',
  expectedCode: 'PRACTICE_POLICY_MISSING_OR_DISABLED',
  mutate: `delete from exam_delivery.practice_policies
    where canonical_exam_key='${examKey}' and package_version='1.0.0'
      and profile_key='${profileKey}' and purpose='weak_area'`,
  restore: `insert into exam_delivery.practice_policies(
      canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
      maximum_completed_attempts,cooldown_seconds,maximum_concurrent_sessions,
      maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy
    ) values(
      '${examKey}','1.0.0','${profileKey}','weak_area','production_authorized',true,
      null,0,1,10,false,'never','never'
    )`,
});
assertCurrentStateBlocked({
  name: 'disabledPolicy',
  expectedCode: 'PRACTICE_POLICY_MISSING_OR_DISABLED',
  mutate: `update exam_delivery.practice_policies
    set enabled=false,access_mode='disabled'
    where canonical_exam_key='${examKey}' and package_version='1.0.0'
      and profile_key='${profileKey}' and purpose='study_sandbox'`,
  restore: `update exam_delivery.practice_policies
    set enabled=true,access_mode='production_authorized'
    where canonical_exam_key='${examKey}' and package_version='1.0.0'
      and profile_key='${profileKey}' and purpose='study_sandbox'`,
});
assertCurrentStateBlocked({
  name: 'catalogueMismatch',
  expectedCode: 'CURRENT_CATALOGUE_VERSION_MISMATCH',
  mutate: `update public.exam_catalog set current_version='9.9.9'
    where exam_key='${examKey}'`,
  restore: `update public.exam_catalog set current_version='1.0.0'
    where exam_key='${examKey}'`,
});
assertCurrentStateBlocked({
  name: 'unpublishedCurrentPackage',
  expectedCode: 'CURRENT_PACKAGE_NOT_PUBLISHED',
  mutate: `alter table exam_delivery.package_versions
      disable trigger guard_package_version_immutability;
    update exam_delivery.package_versions set status='draft',published_at=null
      where id='${ids.predecessorPackage}';
    alter table exam_delivery.package_versions
      enable trigger guard_package_version_immutability`,
  restore: `alter table exam_delivery.package_versions
      disable trigger guard_package_version_immutability;
    update exam_delivery.package_versions
      set status='published',published_at=statement_timestamp()
      where id='${ids.predecessorPackage}';
    alter table exam_delivery.package_versions
      enable trigger guard_package_version_immutability`,
});
assertCurrentStateBlocked({
  name: 'unsupportedCurrentRuntime',
  expectedCode: 'CURRENT_RUNTIME_UNSUPPORTED',
  mutate: `alter table exam_delivery.package_versions
      disable trigger guard_package_version_immutability;
    update exam_delivery.package_versions set generator_version='unsupported-current-generator'
      where id='${ids.predecessorPackage}';
    alter table exam_delivery.package_versions
      enable trigger guard_package_version_immutability`,
  restore: `alter table exam_delivery.package_versions
      disable trigger guard_package_version_immutability;
    update exam_delivery.package_versions
      set generator_version='certsim-az400-case-workspace-generator-v1'
      where id='${ids.predecessorPackage}';
    alter table exam_delivery.package_versions
      enable trigger guard_package_version_immutability`,
});

const staleStageRequest = {
  ...evidence,
  requestId: '13340000-0000-4000-8000-000000000112',
  expectedCurrentStateHash: initialHash,
};
const staleStage = ownerRpc('certsim_examops_stage_exam_release', staleStageRequest);
assert.equal(staleStage.ok, true);
run(`update public.exam_catalog set status='draft' where exam_key='${examKey}'`);
const staleStateHash = scalar(`select exam_delivery.release_configuration_hash('${examKey}')`);
const staleActivation = ownerRpc('certsim_examops_activate_exam_release', {
  ...staleStageRequest,
  requestId: '13340000-0000-4000-8000-000000000113',
  stageOperationId: staleStage.operationId,
});
assert.equal(staleActivation.ok, false);
assert.equal(staleActivation.errorCode, 'RELEASE_STATE_CHANGED');
assert.equal(scalar(`select exam_delivery.release_configuration_hash('${examKey}')`), staleStateHash);
run(`update public.exam_catalog set status='active' where exam_key='${examKey}'`);
assert.equal(scalar(`select exam_delivery.release_configuration_hash('${examKey}')`), initialHash);

const busyRequest = {
  ...evidence,
  requestId: '13340000-0000-4000-8000-000000000114',
  expectedCurrentStateHash: initialHash,
};
const lockHolder = spawn(psql, ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', databaseUrl], {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
lockHolder.stdin.end(`begin; select pg_advisory_xact_lock(hashtextextended('certsim-exam-release:${examKey}',0)); select 'LOCKED'; select pg_sleep(20); rollback;\n`);
await waitForMarker(lockHolder.stdout, 'LOCKED');
const busy = ownerRpc('certsim_examops_stage_exam_release', busyRequest);
assert.equal(busy.code, 'RELEASE_OPERATION_BUSY');
lockHolder.kill();
await waitForExit(lockHolder);

const history = ownerListRpc();
assert.equal(history.ok, true);
assert.ok(history.operations.length >= 7);
assert.ok(history.operations.every((operation) => !JSON.stringify(operation).includes(ids.learner)));
assert.equal(scalar(`select count(*) from exam_delivery.attempts where package_version_id in ('${ids.predecessorPackage}','${ids.successorPackage}')`), '5');
assert.equal(scalar(`select count(*) from exam_delivery.attempt_continuation_contracts contract join exam_delivery.attempts attempt on attempt.id=contract.attempt_id where attempt.package_version_id in ('${ids.predecessorPackage}','${ids.successorPackage}')`), '5');

const unauthorized = execute(`begin; set local role authenticated; select set_config('request.jwt.claim.sub','${ids.other}',true); select public.certsim_examops_stage_exam_release(${jsonSql({ ...evidence, requestId: '13340000-0000-4000-8000-000000000115' })}); rollback;`);
assert.notEqual(unauthorized.status, 0);
assert.match(unauthorized.stderr, /examops_forbidden/);

console.log(JSON.stringify({
  ok: true,
  realRpc: 'PASS',
  requestReplay: 'PASS',
  requestConflict: 'PASS',
  sameExamConcurrency: 'PASS',
  staleStateHash: 'PASS',
  activationAtomicity: 'PASS',
  rollbackAtomicity: 'PASS',
  ambiguousDefaults: 'PASS',
  missingActivation: 'PASS',
  missingPolicy: 'PASS',
  disabledPolicy: 'PASS',
  catalogueMismatch: 'PASS',
  unpublishedCurrentPackage: 'PASS',
  unsupportedCurrentRuntime: 'PASS',
  rollbackHistoryPredecessor: 'PASS',
  predecessorContinuation: 'PASS',
  successorContinuationAfterRollback: 'PASS',
  exactAssignmentAfterCutover: 'PASS',
  frozenFeedbackReviewAnswer: 'PASS',
  practiceIdleExpiry: 'PASS',
  authorizationBoundary: 'PASS',
  protectedPayloadsPrinted: 0,
  productionMutations: 0,
}, null, 2));

function seedFixture() {
  run(`
begin;
insert into auth.users(id,email,raw_user_meta_data) values
  ('${ids.owner}','issue133-owner@example.invalid','{}'::jsonb),
  ('${ids.learner}','issue133-learner@example.invalid','{}'::jsonb),
  ('${ids.other}','issue133-other@example.invalid','{}'::jsonb);
insert into public.profiles(id,email,user_type,default_role,status) values
  ('${ids.owner}','issue133-owner@example.invalid','platform','platform_owner','active'),
  ('${ids.learner}','issue133-learner@example.invalid','individual','student','active'),
  ('${ids.other}','issue133-other@example.invalid','individual','student','active')
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
update exam_delivery.package_versions set status='published',published_at=statement_timestamp()
where id in ('${ids.predecessorPackage}','${ids.successorPackage}');

insert into public.exam_catalog(exam_key,slug,title,lifecycle,exam_type,current_version,status)
values('${examKey}','issue133-fixture','Issue 133 fixture','production_ready','certification','1.0.0','active');
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
  '13340000-0000-4000-8000-000000000041'
);

insert into exam_delivery.attempts(
  id,owner_id,package_version_id,package_profile_id,client_request_id,status,
  generator_version,scorer_version,created_at,started_at,expires_at,purpose,
  practice_last_activity_at,practice_idle_expires_at,attribution_source
) values
  ('${ids.feedbackAttempt}','${ids.learner}','${ids.predecessorPackage}','${ids.predecessorProfile}',
   '13340000-0000-4000-8000-000000000130','in_progress','certsim-az400-case-workspace-generator-v1',
   'certsim-az400-authoritative-scorer-v1',statement_timestamp(),statement_timestamp(),null,
   'study_sandbox',statement_timestamp(),statement_timestamp()+interval '2 hours','personal_self_directed'),
  ('${ids.withheldAttempt}','${ids.learner}','${ids.predecessorPackage}','${ids.predecessorProfile}',
   '13340000-0000-4000-8000-000000000132','in_progress','certsim-az400-case-workspace-generator-v1',
   'certsim-az400-authoritative-scorer-v1',statement_timestamp(),statement_timestamp(),null,
   'weak_area',statement_timestamp(),statement_timestamp()+interval '2 hours','personal_self_directed'),
  ('${ids.idleExpiredAttempt}','${ids.learner}','${ids.predecessorPackage}','${ids.predecessorProfile}',
   '13340000-0000-4000-8000-000000000134','in_progress','certsim-az400-case-workspace-generator-v1',
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

function assertCurrentStateBlocked({ name, expectedCode, mutate, restore }) {
  run(mutate);
  const validation = json(`select exam_delivery.validate_current_exam_release_configuration('${examKey}')::text`);
  assert.equal(validation.ok, false, `${name} validator`);
  assert.equal(validation.outcome, 'BLOCKED_CURRENT_STATE_INVALID', `${name} outcome`);
  assert.ok(validation.findingCodes.includes(expectedCode), `${name} finding`);
  const unhealthyHash = scalar(`select exam_delivery.release_configuration_hash('${examKey}')`);
  const unchangedFingerprint = configurationFingerprint();

  const stageRequest = {
    ...evidence,
    requestId: nextRegressionRequestId(),
    expectedCurrentStateHash: unhealthyHash,
  };
  const blockedStage = ownerRpc('certsim_examops_stage_exam_release', stageRequest);
  assert.equal(blockedStage.ok, false, `${name} stage`);
  assert.equal(blockedStage.preflight.outcome, 'BLOCKED_CURRENT_STATE_INVALID', `${name} stage outcome`);
  assert.ok(blockedStage.preflight.findingCodes.includes(expectedCode), `${name} stage finding`);
  assert.equal(configurationFingerprint(), unchangedFingerprint, `${name} stage mutation`);

  const syntheticStageRequestId = nextRegressionRequestId();
  const syntheticStageId = scalar(`
    insert into exam_delivery.exam_release_operations(
      request_id,request_hash,actor_id,canonical_exam_key,operation_type,
      target_package_id,release_set,release_set_hash,manifest_hash,package_hash,
      validation_hash,release_diff_hash,expected_current_state_hash,
      preflight_result,result_state,started_at,completed_at
    ) values(
      '${syntheticStageRequestId}','${'7'.repeat(64)}','${ids.owner}','${examKey}','STAGE',
      '${ids.successorPackage}',${jsonSql(releaseSet)},'${releaseSetHash}',
      '${evidence.manifestHash}','${evidence.packageHash}','${evidence.validationHash}',
      '${evidence.releaseDiffHash}','${unhealthyHash}',
      '{"ok":true,"outcome":"SYNTHETIC_DB_REGRESSION_STAGE"}'::jsonb,
      'succeeded',statement_timestamp(),statement_timestamp()
    ) returning id
  `);
  const blockedActivation = ownerRpc('certsim_examops_activate_exam_release', {
    ...evidence,
    requestId: nextRegressionRequestId(),
    stageOperationId: syntheticStageId,
    expectedCurrentStateHash: unhealthyHash,
  });
  assert.equal(blockedActivation.ok, false, `${name} activate`);
  assert.equal(blockedActivation.preflight.outcome, 'BLOCKED_CURRENT_STATE_INVALID', `${name} activate outcome`);
  assert.ok(blockedActivation.preflight.findingCodes.includes(expectedCode), `${name} activate finding`);
  assert.equal(configurationFingerprint(), unchangedFingerprint, `${name} activate mutation`);

  run(restore);
  const restored = json(`select exam_delivery.validate_current_exam_release_configuration('${examKey}')::text`);
  assert.equal(restored.ok, true, `${name} restore`);
  assert.equal(restored.currentPackageVersion, '1.0.0', `${name} restored package`);
}

function configurationFingerprint() {
  return scalar(`select exam_delivery.examops_json_hash(
    exam_delivery.release_configuration_snapshot('${examKey}') || jsonb_build_object(
      'packageState',coalesce((
        select jsonb_agg(jsonb_build_object(
          'packageVersion',package.package_version,
          'status',package.status,
          'packageSchemaVersion',package.package_schema_version,
          'generatorVersion',package.generator_version,
          'scorerVersion',package.scorer_version
        ) order by package.package_version)
        from exam_delivery.package_versions package
        where exam_delivery.normalize_exam_key(package.exam_key)='${examKey}'
      ),'[]'::jsonb)
    )
  )`);
}

function readHealth() {
  const rawState = json(buildExamOperationsReadQuery(examKey, {
    genericReleaseOperations: true,
  }));
  return createExamOperationsHealth(
    buildExamOperationsCurrentState(rawState, examKey),
  );
}

function nextRegressionRequestId() {
  const suffix = String(regressionRequestOrdinal).padStart(12, '0');
  regressionRequestOrdinal += 1;
  return `13340000-0000-4000-8000-${suffix}`;
}

function ownerRpc(functionName, request) {
  return json(`begin; set local role authenticated;
    select set_config('request.jwt.claim.sub','${ids.owner}',true);
    select public.${functionName}(${jsonSql(request)})::text;
    commit;`);
}

function ownerListRpc() {
  return json(`begin; set local role authenticated;
    select set_config('request.jwt.claim.sub','${ids.owner}',true);
    select public.certsim_examops_list_release_operations('${examKey}',null,50)::text;
    commit;`);
}

function execute(sql) {
  return spawnSync(psql, ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', databaseUrl], {
    input: `${sql.trim()}\n`,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function run(sql) {
  const result = execute(sql);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'psql failed');
  return result.stdout.trim();
}

function scalar(sql) {
  return run(sql).split(/\r?\n/).filter(Boolean).at(-1)?.trim() ?? '';
}

function json(sql) {
  return JSON.parse(scalar(sql));
}

function jsonSql(value) {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function waitForMarker(stream, marker) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('ISSUE133_LOCK_TIMEOUT')), 10_000);
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output += chunk;
      if (output.includes(marker)) {
        clearTimeout(timeout);
        resolve();
      }
    });
    stream.on('error', reject);
  });
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}
