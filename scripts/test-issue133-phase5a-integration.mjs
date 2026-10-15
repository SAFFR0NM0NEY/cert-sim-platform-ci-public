import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const databaseUrl = required('SUPABASE_DB_URL');
const psql = process.env.PSQL_PATH?.trim() || 'psql';
const parsedUrl = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsedUrl.hostname)) {
  throw new Error('ISSUE133_PHASE5A_DISPOSABLE_LOCAL_DATABASE_REQUIRED');
}

const ids = Object.freeze({
  organisation: '1335a000-0000-4000-8000-000000000001',
  package: '1335a000-0000-4000-8000-000000000010',
  profile: '1335a000-0000-4000-8000-000000000011',
  successorPackage: '1335a000-0000-4000-8000-000000000012',
  successorProfile: '1335a000-0000-4000-8000-000000000013',
  owner: '1335a000-0000-4000-8000-000000000101',
  learner: '1335a000-0000-4000-8000-000000000102',
  developer: '1335a000-0000-4000-8000-000000000103',
  trainer: '1335a000-0000-4000-8000-000000000104',
  collegeAdmin: '1335a000-0000-4000-8000-000000000105',
  campusAdmin: '1335a000-0000-4000-8000-000000000106',
  reception: '1335a000-0000-4000-8000-000000000107',
  practiceAttempt: '1335a000-0000-4000-8000-000000000201',
  missingTimedAttempt: '1335a000-0000-4000-8000-000000000202',
  legacyReleaseRequest: '1335a000-0000-4000-8000-000000000400',
  stageOperation: '1335a000-0000-4000-8000-000000000401',
  stageRequest: '1335a000-0000-4000-8000-000000000402',
  activateOperation: '1335a000-0000-4000-8000-000000000403',
  activateRequest: '1335a000-0000-4000-8000-000000000404',
  rollbackOperation: '1335a000-0000-4000-8000-000000000405',
  rollbackRequest: '1335a000-0000-4000-8000-000000000406',
});
const examKey = 'issue133phase5a';

seedFixture();

const health = actorHealth(ids.owner);
assert.equal(health.ok, true);
assert.equal(health.examKey, examKey);
assert.equal(health.currentPackageVersion, '1.0.0');
assert.equal(health.currentStateStatus, 'CURRENT_STATE_VALID');
assert.equal(health.healthStatus, 'BLOCKED', 'missing continuation contract is the strongest warning');
assert.equal(health.currentContinuableAttempts, 2);
assert.equal(health.currentContinuationContracts, 1);
assert.equal(health.currentMissingContinuationContracts, 1);
assert.equal(health.currentTimedAttempts, 1);
assert.equal(health.currentPracticeAttempts, 1);
assert.equal(health.olderPackageContinuableAttempts, 0);
assert.equal(health.frozenSubmitCount, 0);
assert.equal(health.latestOperationType, null);
assert.equal(health.releaseEvidenceSource, 'legacy-release-configuration');
assert.equal(health.releaseEvidencePackageVersion, '1.0.0');
assert.deepEqual(health.telemetry, {
  DEPLOYMENT_CORRELATION: 'NOT_AVAILABLE',
  POST_RELEASE_HEALTH_EVENT: 'NOT_AVAILABLE',
  SAVE_FAILURE_TELEMETRY: 'NOT_AVAILABLE',
  SUBMIT_FAILURE_TELEMETRY: 'NOT_AVAILABLE',
});

const existingValidation = json(`select exam_delivery.validate_current_exam_release_configuration('${examKey}')::text`);
assert.equal(existingValidation.outcome, health.currentStateStatus);
assert.deepEqual(existingValidation.findingCodes, health.currentStateFindings);
assert.equal(existingValidation.defaultCount, health.enabledDefaultCount);
assert.equal(existingValidation.activationCount, health.productionActivationCount);
assert.equal(existingValidation.policyCount, health.usablePracticePolicyCount);

const ownerHistory = actorRpc(ids.owner, `
  select public.certsim_examops_list_release_operations('${examKey}',null,25)::text
`);
assert.equal(ownerHistory.ok, true);
assert.deepEqual(ownerHistory.operations, []);

seedSuccessfulStage();
const stageHealth = actorHealth(ids.owner);
assert.equal(stageHealth.latestOperationType, 'STAGE');
assert.equal(stageHealth.latestOperationStatus, 'succeeded');
assert.equal(stageHealth.latestOperationTargetVersion, '2.0.0');
assert.equal(stageHealth.releaseEvidenceSource, 'legacy-release-configuration');
assert.equal(stageHealth.releaseEvidenceStage, 'standard_active_exam_v1');
assert.equal(stageHealth.releaseEvidencePackageVersion, '1.0.0');
const stageHistory = actorRpc(ids.owner, `
  select public.certsim_examops_list_release_operations('${examKey}',null,25)::text
`);
assert.equal(stageHistory.operations[0].operationType, 'STAGE');

seedSuccessfulActivate();
const activateHealth = actorHealth(ids.owner);
assert.equal(activateHealth.latestOperationType, 'ACTIVATE');
assert.equal(activateHealth.releaseEvidenceSource, 'generic-exam-operations');
assert.equal(activateHealth.releaseEvidenceStage, 'ACTIVATE');
assert.equal(activateHealth.releaseEvidencePackageVersion, '2.0.0');

seedSuccessfulRollback();
const rollbackHealth = actorHealth(ids.owner);
assert.equal(rollbackHealth.latestOperationType, 'ROLLBACK');
assert.equal(rollbackHealth.releaseEvidenceSource, 'generic-exam-operations');
assert.equal(rollbackHealth.releaseEvidenceStage, 'ROLLBACK');
assert.equal(rollbackHealth.releaseEvidencePackageVersion, '1.0.0');

const serialized = JSON.stringify(health);
for (const forbidden of [
  'ownerId', 'learnerId', 'attemptId', 'assignmentId', 'membershipId',
  'questionId', 'questionText', 'answerKey', 'responsePayload', 'scoringPayload',
  'reviewPayload', 'authoringMetadata', '@example.invalid', ids.owner,
  ids.learner, ids.practiceAttempt, ids.missingTimedAttempt,
]) assert.equal(serialized.includes(forbidden), false, `safe output excludes ${forbidden}`);

for (const [label, actor] of Object.entries({
  learner: ids.learner,
  developer: ids.developer,
  trainer: ids.trainer,
  collegeAdmin: ids.collegeAdmin,
  campusAdmin: ids.campusAdmin,
  reception: ids.reception,
})) {
  const denied = execute(`begin; set local role authenticated;
    select set_config('request.jwt.claim.sub','${actor}',true);
    select public.certsim_examops_get_health('${examKey}')::text;
    rollback;`);
  assert.notEqual(denied.status, 0, `${label} must be denied`);
  assert.match(denied.stderr, /examops_forbidden/i, `${label} gets the stable denial`);
}

const anonymous = execute(`set role anon; select public.certsim_examops_get_health('${examKey}')::text;`);
assert.notEqual(anonymous.status, 0);
assert.match(anonymous.stderr, /permission denied for function certsim_examops_get_health/i);

for (const role of ['authenticated', 'service_role']) {
  const direct = execute(`set role ${role}; select exam_delivery.get_exam_operations_health('${ids.owner}','${examKey}')::text;`);
  assert.notEqual(direct.status, 0, `${role} cannot invoke private health`);
  assert.match(direct.stderr, /permission denied for (schema exam_delivery|function get_exam_operations_health)/i);
}

console.log(JSON.stringify({
  phase: 'Issue #133 Phase 5A database integration',
  platformOwnerHealth: 'PASS',
  learnerDenied: 'PASS',
  developerDenied: 'PASS',
  otherStaffDenied: 'PASS',
  anonymousDenied: 'PASS',
  privateAuthenticatedDenied: 'PASS',
  privateServiceRoleDenied: 'PASS',
  safeOutput: 'PASS',
  phase4bCurrentStateSemantics: 'PASS',
  continuationAggregateMath: 'PASS',
  emptyLedger: 'PASS',
  successfulStageExcludedFromReleaseEvidence: 'PASS',
  successfulActivateReleaseEvidence: 'PASS',
  successfulRollbackReleaseEvidence: 'PASS',
  protectedPayloadsPrinted: 0,
  productionMutations: 0,
}, null, 2));

function seedFixture() {
  const users = [
    [ids.owner, 'platform', 'platform_owner'],
    [ids.learner, 'individual', 'student'],
    [ids.developer, 'platform', 'developer'],
    [ids.trainer, 'organisation', 'trainer'],
    [ids.collegeAdmin, 'organisation', 'college_admin'],
    [ids.campusAdmin, 'organisation', 'campus_admin'],
    [ids.reception, 'organisation', 'reception'],
  ];
  const authRows = users.map(([id], index) =>
    `('${id}','issue133-phase5a-${index}@example.invalid','{}'::jsonb)`).join(',\n');
  const profileRows = users.map(([id, userType, role], index) =>
    `('${id}','issue133-phase5a-${index}@example.invalid','${userType}','${role}','active')`).join(',\n');
  const membershipRows = users.map(([id, , role]) =>
    `('${id}','${ids.organisation}','${role}','active')`).join(',\n');

  run(`
begin;
insert into auth.users(id,email,raw_user_meta_data) values ${authRows};
insert into public.profiles(id,email,user_type,default_role,status) values ${profileRows}
on conflict(id) do update set
  email=excluded.email,
  user_type=excluded.user_type,
  default_role=excluded.default_role,
  status=excluded.status;
insert into public.organisations(id,name,organisation_type,status)
values('${ids.organisation}','Issue 133 Phase 5A disposable fixture','internal','active');
insert into public.memberships(user_id,organisation_id,role,status) values ${membershipRows};

insert into exam_delivery.package_versions(
  id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,
  package_schema_version,generator_version,scorer_version,status,
  declared_review_release_policy,declared_answer_release_policy
) values(
  '${ids.package}','${examKey}','1.0.0','${'1'.repeat(40)}','${'2'.repeat(64)}','${'3'.repeat(64)}',
  'certsim-protected-package-v2','certsim-python-standard-canonical-forms-v1',
  'certsim-versioned-structured-partial-v1','draft','after_submission','after_submission'
),(
  '${ids.successorPackage}','${examKey}','2.0.0','${'4'.repeat(40)}','${'5'.repeat(64)}','${'6'.repeat(64)}',
  'certsim-protected-package-v2','certsim-python-standard-canonical-forms-v1',
  'certsim-versioned-structured-partial-v1','draft','after_submission','after_submission'
);
insert into exam_delivery.package_profiles(
  id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config
) values
  ('${ids.profile}','${ids.package}','full','Synthetic full profile',1,30,'{}'::jsonb),
  ('${ids.successorProfile}','${ids.successorPackage}','full','Synthetic successor profile',1,30,'{}'::jsonb);
update exam_delivery.package_versions set status='published',published_at=statement_timestamp()
where id in ('${ids.package}','${ids.successorPackage}');
insert into public.exam_catalog(exam_key,slug,title,lifecycle,exam_type,current_version,status)
values('${examKey}','issue133-phase5a','Issue 133 Phase 5A fixture','production_ready','certification','1.0.0','active');
insert into exam_delivery.exam_profile_activations(
  package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by
) values('${ids.package}','${ids.profile}',true,'production',statement_timestamp(),'${ids.owner}');
insert into exam_delivery.exam_release_configuration_requests(
  request_id,actor_id,canonical_exam_key,package_version_id,package_profile_id,
  release_stage,configured_at
) values(
  '${ids.legacyReleaseRequest}','${ids.owner}','${examKey}','${ids.package}','${ids.profile}',
  'standard_active_exam_v1',statement_timestamp()-interval '10 minutes'
);
insert into exam_delivery.package_profile_defaults(
  canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,enabled,configured_by
)
select '${examKey}','full',purpose,'${ids.package}','${ids.profile}',true,'${ids.owner}'
from unnest(enum_range(null::exam_delivery.attempt_purpose)) purpose;
insert into exam_delivery.practice_policies(
  canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
  maximum_completed_attempts,cooldown_seconds,maximum_concurrent_sessions,
  maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy
) values
  ('${examKey}','1.0.0','full','self_directed_exam','production_authorized',true,null,0,1,10,false,'after_submission','after_submission'),
  ('${examKey}','1.0.0','full','study_sandbox','production_authorized',true,null,0,1,10,true,'immediate_study_feedback','immediate_study_feedback'),
  ('${examKey}','1.0.0','full','targeted_domain','production_authorized',true,null,0,1,10,false,'after_submission','after_submission'),
  ('${examKey}','1.0.0','full','weak_area','production_authorized',true,null,0,1,10,false,'never','never'),
  ('${examKey}','1.0.0','full','pbq_practice','production_authorized',true,null,0,1,10,false,'after_submission','after_submission');

insert into exam_delivery.attempts(
  id,owner_id,package_version_id,package_profile_id,client_request_id,status,
  generator_version,scorer_version,created_at,started_at,expires_at,purpose,
  practice_last_activity_at,practice_idle_expires_at,attribution_source
) values(
  '${ids.practiceAttempt}','${ids.learner}','${ids.package}','${ids.profile}',
  '1335a000-0000-4000-8000-000000000301','in_progress',
  'certsim-python-standard-canonical-forms-v1','certsim-versioned-structured-partial-v1',
  statement_timestamp(),statement_timestamp(),null,'study_sandbox',
  statement_timestamp(),statement_timestamp()+interval '2 hours','personal_self_directed'
);
alter table exam_delivery.attempts disable trigger create_attempt_continuation_contract_after_insert;
insert into exam_delivery.attempts(
  id,owner_id,package_version_id,package_profile_id,client_request_id,status,
  generator_version,scorer_version,created_at,started_at,expires_at,purpose,
  attribution_source
) values(
  '${ids.missingTimedAttempt}','${ids.learner}','${ids.package}','${ids.profile}',
  '1335a000-0000-4000-8000-000000000302','in_progress',
  'certsim-python-standard-canonical-forms-v1','certsim-versioned-structured-partial-v1',
  statement_timestamp(),statement_timestamp(),statement_timestamp()+interval '30 minutes',
  'self_directed_exam','personal_self_directed'
);
alter table exam_delivery.attempts enable trigger create_attempt_continuation_contract_after_insert;
commit;
  `);
}

function seedSuccessfulStage() {
  run(`
insert into exam_delivery.exam_release_operations(
  id,request_id,request_hash,actor_id,canonical_exam_key,operation_type,target_package_id,
  release_set,release_set_hash,manifest_hash,package_hash,validation_hash,
  release_diff_hash,expected_current_state_hash,result_state,created_at,started_at,completed_at
) values(
  '${ids.stageOperation}','${ids.stageRequest}','${'4'.repeat(64)}','${ids.owner}','${examKey}','STAGE','${ids.successorPackage}',
  '{}'::jsonb,'${'5'.repeat(64)}','${'6'.repeat(64)}','${'7'.repeat(64)}','${'8'.repeat(64)}',
  '${'9'.repeat(64)}','${'a'.repeat(64)}','succeeded',statement_timestamp()-interval '3 minutes',
  statement_timestamp()-interval '3 minutes',statement_timestamp()-interval '3 minutes'
);
  `);
}

function seedSuccessfulActivate() {
  run(`
insert into exam_delivery.exam_release_operations(
  id,request_id,request_hash,actor_id,canonical_exam_key,operation_type,target_package_id,stage_operation_id,
  release_set,release_set_hash,manifest_hash,package_hash,validation_hash,
  release_diff_hash,expected_current_state_hash,result_state,created_at,started_at,completed_at
) values(
  '${ids.activateOperation}','${ids.activateRequest}','${'b'.repeat(64)}','${ids.owner}','${examKey}','ACTIVATE',
  '${ids.successorPackage}','${ids.stageOperation}',
  '{}'::jsonb,'${'c'.repeat(64)}','${'d'.repeat(64)}','${'e'.repeat(64)}','${'f'.repeat(64)}',
  '${'1'.repeat(64)}','${'2'.repeat(64)}','succeeded',statement_timestamp()-interval '2 minutes',
  statement_timestamp()-interval '2 minutes',statement_timestamp()-interval '2 minutes'
);
  `);
}

function seedSuccessfulRollback() {
  run(`
insert into exam_delivery.exam_release_operations(
  id,request_id,request_hash,actor_id,canonical_exam_key,operation_type,target_package_id,rollback_of_operation_id,
  release_set,release_set_hash,manifest_hash,package_hash,validation_hash,
  release_diff_hash,expected_current_state_hash,result_state,created_at,started_at,completed_at
) values(
  '${ids.rollbackOperation}','${ids.rollbackRequest}','${'3'.repeat(64)}','${ids.owner}','${examKey}','ROLLBACK',
  '${ids.package}','${ids.activateOperation}',
  '{}'::jsonb,'${'4'.repeat(64)}','${'5'.repeat(64)}','${'6'.repeat(64)}','${'7'.repeat(64)}',
  '${'8'.repeat(64)}','${'9'.repeat(64)}','succeeded',statement_timestamp()-interval '1 minute',
  statement_timestamp()-interval '1 minute',statement_timestamp()-interval '1 minute'
);
  `);
}

function actorHealth(actorId) {
  return actorRpc(actorId, `select public.certsim_examops_get_health('${examKey}')::text`);
}

function actorRpc(actorId, sql) {
  return json(`begin; set local role authenticated;
    select set_config('request.jwt.claim.sub','${actorId}',true);
    ${sql};
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

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
