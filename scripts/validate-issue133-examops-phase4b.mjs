import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const migrationName = '20260920124528_issue133_examops_phase4b.sql';
const migration = await readFile(`supabase/migrations/${migrationName}`, 'utf8');
const integration = await readFile('scripts/test-issue133-phase4b-integration.mjs', 'utf8');
const upgrade = await readFile('scripts/test-issue133-phase4b-upgrade.mjs', 'utf8');
const pgTap = await readFile('supabase/tests/backend_exam_delivery_issue133_phase4b.sql', 'utf8');
const healthRead = await readFile('scripts/exam-operations/read-production-state.mjs', 'utf8');
const docs = await readFile('docs/CERTSIM_EXAM_OPERATIONS_PHASE4B.md', 'utf8');
const workflow = await readFile('.github/workflows/backend-exam-delivery-db-validation.yml', 'utf8');
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const migrations = (await readdir('supabase/migrations')).filter((name) => name.endsWith('.sql')).sort();

assert.equal(migrations.length, 91);
assert.equal(migrations.at(-3), migrationName);
assert.ok(Number(migrationName.slice(0, 14)) > 20260917185333);
assert.doesNotMatch(migration, /\b(?:az400|sc200|inf303|sc100)\b/i);
assert.doesNotMatch(migration, /inject(?:ed)?[_ -]?failure|fault[_ -]?injection/i);

for (const table of [
  'exam_release_operations',
  'exam_release_operation_events',
  'attempt_continuation_contracts',
]) {
  assert.match(migration, new RegExp(`create table exam_delivery\\.${table}\\b`, 'i'));
  assert.match(migration, new RegExp(`alter table exam_delivery\\.${table} enable row level security`, 'i'));
}
for (const functionName of [
  'build_attempt_continuation_contract',
  'authorize_attempt_continuation',
  'release_configuration_snapshot',
  'release_configuration_hash',
  'validate_current_exam_release_configuration',
  'preflight_exam_release',
  'stage_exam_release',
  'activate_exam_release',
  'rollback_exam_release',
  'list_exam_release_operations',
]) {
  assert.match(migration, new RegExp(`create(?: or replace)? function exam_delivery\\.${functionName}\\b`, 'i'));
}
for (const wrapper of [
  'certsim_examops_preflight_exam_release',
  'certsim_examops_stage_exam_release',
  'certsim_examops_activate_exam_release',
  'certsim_examops_rollback_exam_release',
  'certsim_examops_list_release_operations',
]) {
  assert.match(migration, new RegExp(`create function public\\.${wrapper}\\b`, 'i'));
}
assert.match(migration, /unique\s*\(operation_id,sequence\)/i);
assert.match(migration, /request_id uuid not null unique/i);
assert.match(migration, /create trigger guard_exam_release_operation_update/i);
assert.match(migration, /create trigger guard_exam_release_operation_events_append_only/i);
assert.match(migration, /create trigger guard_attempt_continuation_contracts_immutable/i);
assert.match(migration, /create trigger create_attempt_continuation_contract_after_insert[\s\S]+after insert on exam_delivery\.attempts/i);
assert.match(
  migration,
  /lock table exam_delivery\.attempts\s+in share row exclusive mode\s+nowait;/i,
);
const attemptLockOffset = migration.search(/lock table exam_delivery\.attempts/i);
const backfillOffset = migration.search(/do \$\$\s*declare\s+v_attempt record;/i);
const futureInsertTriggerOffset = migration.search(/create trigger create_attempt_continuation_contract_after_insert/i);
assert.ok(attemptLockOffset >= 0 && attemptLockOffset < backfillOffset);
assert.ok(backfillOffset < futureInsertTriggerOffset);
assert.match(migration, /raise exception 'BLOCKED_CONTINUATION_RISK'/);
assert.match(migration, /practice_idle_expires_at>statement_timestamp\(\)/i);
assert.match(migration, /python_submission_grading_sessions/i);
assert.match(migration, /pg_try_advisory_xact_lock/i);
assert.match(migration, /RELEASE_OPERATION_BUSY/);
assert.match(migration, /REQUEST_ID_PAYLOAD_CONFLICT/);
assert.match(migration, /RELEASE_STATE_CHANGED/);
assert.match(migration, /BLOCKED_CURRENT_STATE_INVALID/);
assert.match(migration, /CURRENT_PACKAGE_AMBIGUOUS/);
assert.match(migration, /CURRENT_ACTIVATION_MISSING/);
assert.match(migration, /PRACTICE_POLICY_MISSING_OR_DISABLED/);
assert.match(migration, /previous_state_snapshot/i);
assert.match(migration, /v_restored_package_id[\s\S]+target_package_id[\s\S]+v_restored_package_id/i);
assert.match(migration, /POSTCONDITION_FAILED/);
assert.match(migration, /certsim-exam-release-set-v1/);
assert.match(migration, /v_binding_count<>6/);
assert.match(migration, /v_policy_count<>5/);
assert.match(migration, /contract_version='live-v2'[\s\S]+v_assignment\.package_version_id/i);
assert.match(migration, /from exam_delivery\.attempt_continuation_contracts contract[\s\S]+contract\.immediate_feedback/i);
assert.match(migration, /review_release_policy in \('after_submission','immediate_study_feedback'\)/i);
assert.doesNotMatch(
  functionBody(migration, 'authorize_attempt_continuation'),
  /practice_policies|exam_profile_activations|package_profile_defaults|can_use_profile|check_eligibility/i,
);

for (const marker of [
  'requestReplay', 'sameExamConcurrency', 'staleStateHash', 'activationAtomicity',
  'rollbackAtomicity', 'predecessorContinuation', 'successorContinuationAfterRollback',
  'exactAssignmentAfterCutover', 'frozenFeedbackReviewAnswer', 'practiceIdleExpiry',
  'authorizationBoundary', 'ambiguousDefaults', 'missingActivation', 'missingPolicy',
  'disabledPolicy', 'catalogueMismatch', 'unpublishedCurrentPackage',
  'unsupportedCurrentRuntime', 'rollbackHistoryPredecessor',
]) assert.match(integration, new RegExp(marker));
assert.match(integration, /spawn\(psql/);
assert.match(integration, /issue133_fail_activation/);
assert.match(integration, /issue133_fail_rollback/);
assert.doesNotMatch(integration, /https?:\/\//i);

for (const purpose of [
  'assigned_assessment', 'self_directed_exam', 'study_sandbox',
  'targeted_domain', 'weak_area', 'pbq_practice',
]) assert.match(upgrade, new RegExp(purpose));
assert.match(upgrade, /backfilledContracts:\s*8/);
assert.match(upgrade, /BLOCKED_CONTINUATION_RISK/);
assert.match(upgrade, /ISSUE133_WRITER_LOCK_HELD/);
assert.match(upgrade, /could not obtain lock on relation/);
assert.match(upgrade, /contendedMigrationPartialObjects:\s*0/);
assert.match(upgrade, /postMigrationAttemptContractGuarantee:\s*'PASS'/);
assert.match(upgrade, /contractBuilderFailureRollsBackAttempt:\s*'PASS'/);
assert.match(upgrade, /lockDurationRuns/);
assert.match(upgrade, /-1', '-v', 'ON_ERROR_STOP=1'/);
assert.match(pgTap, /continuation authorization excludes mutable new-start configuration/);
assert.match(pgTap, /historical assignment launch remains bounded to published packages/);

assert.match(healthRead, /genericReleaseOperations/);
assert.match(healthRead, /exam_delivery\.exam_release_operations/);
assert.match(healthRead, /where operation\.result_state='succeeded'/);
assert.match(healthRead, /operation\.operation_type in \('ACTIVATE','ROLLBACK'\)/);
assert.match(healthRead, /latestReleaseConfiguration',coalesce/);
assert.match(docs, /PRODUCTION-APPLIED AND ACCEPTED/);
assert.match(docs, /89th migration in source[\s\S]+hosted production/i);
assert.match(docs, /SAVE_FAILURE_TELEMETRY = `NOT_AVAILABLE`/);
assert.match(docs, /production-applied authority contract/i);
assert.match(docs, /SHARE ROW EXCLUSIVE/);
assert.match(docs, /NOWAIT/);
assert.match(workflow, /backend_exam_delivery_issue133_phase4b\.sql/);
assert.match(workflow, /test-issue133-phase4b-integration\.mjs/);

assert.equal(packageJson.scripts['validate:issue133:phase4b'], 'node scripts/validate-issue133-examops-phase4b.mjs');
assert.equal(packageJson.scripts['test:issue133-phase4b-db'], 'node scripts/test-issue133-phase4b-integration.mjs');
assert.equal(packageJson.scripts['test:issue133-phase4b-upgrade'], 'node scripts/test-issue133-phase4b-upgrade.mjs');

console.log('PASS Issue #133 Phase 4B static contract validation');
console.log('  one generic migration, immutable continuation authority, atomic release operations, and local proof harnesses are present');

function functionBody(sql, functionName) {
  const match = sql.match(new RegExp(
    `create(?: or replace)? function exam_delivery\\.${functionName}\\([\\s\\S]*?\\$\\$;`,
    'i',
  ));
  assert.ok(match, `${functionName} definition missing`);
  return match[0];
}
