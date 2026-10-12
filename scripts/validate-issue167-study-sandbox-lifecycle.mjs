import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { getProtectedExitContract } from '../src/lib/protectedLifecycle.js';

const migrationDirectory = new URL('../supabase/migrations/', import.meta.url);
const migrationNames = (await readdir(migrationDirectory)).filter((name) => name.endsWith('.sql')).sort();
const issue167Migrations = migrationNames.filter((name) => name.endsWith('_issue167_study_sandbox_lifecycle_recovery.sql'));
const issue167HotfixMigrations = migrationNames.filter((name) => name.endsWith('_issue167_resume_rpc_volatility_fix.sql'));

assert.equal(migrationNames.length, 90, 'Issue #133 Phase 5A must move the checked-in migration count from 89 to 90');
assert.equal(issue167Migrations.length, 1, 'Issue #167 must contain exactly one lifecycle migration');
assert.equal(issue167HotfixMigrations.length, 1, 'Issue #167 B4A must contain exactly one resume volatility hotfix migration');
assert.equal(migrationNames.at(-10), issue167HotfixMigrations[0], 'Issue #167 B4A must remain immediately before the Issue #86 R5 migration');
assert.equal(migrationNames.at(-9), '20260914120212_issue86_python_lab_orchestration.sql', 'Issue #86 R5 must remain immediately before the Modal integration migration');
assert.equal(migrationNames.at(-8), '20260915063933_issue86_modal_execution_completion.sql', 'Issue #86 Modal integration must remain immediately before trusted grading completion');
assert.equal(migrationNames.at(-7), '20260916103000_issue86_trusted_grading_completion.sql', 'Issue #86 trusted grading completion must remain immediately before release preparation');
assert.equal(migrationNames.at(-6), '20260916155319_issue86_python_next_generation_release_prep.sql', 'Issue #86 release preparation must remain immediately before the access correction');
assert.equal(migrationNames.at(-5), '20260917074357_platform_owner_protected_exam_bypass.sql', 'Platform Owner access correction must remain immediately before the submission semantics migration');
assert.equal(migrationNames.at(-4), '20260917121244_issue86_executable_submission_run_restore.sql', 'Issue #86 submission semantics must remain immediately before live submission recovery');
assert.equal(migrationNames.at(-3), '20260917185333_issue86_live_submit_recovery.sql', 'Issue #86 live submission recovery must remain immediately before Phase 4B');
assert.equal(migrationNames.at(-2), '20260920124528_issue133_examops_phase4b.sql', 'Issue #133 Phase 4B must remain immediately before Phase 5A');
assert.equal(migrationNames.at(-1), '20260921044626_issue133_phase5a_operator_readonly.sql', 'Issue #133 Phase 5A must remain the exact migration tail');

const source = await readFile(new URL(`../supabase/migrations/${issue167Migrations[0]}`, import.meta.url), 'utf8');
const lower = source.toLowerCase();
assert.equal(canonicalSha256(source), '5ce820c7c6fe9f72d742a748f81e27c279ff8ac7de16a512a78d0d7713883518');
const hotfixSource = await readFile(new URL(`../supabase/migrations/${issue167HotfixMigrations[0]}`, import.meta.url), 'utf8');
const hotfixLower = hotfixSource.toLowerCase();
assert.equal(canonicalSha256(hotfixSource), 'a4afd13f8ef4aebfe25523bb7eb0cc34cd5a5aeb1ae5ef3b8fcbe9b8138adf84');
assert.deepEqual(
  [...hotfixLower.matchAll(/^alter function ([^(]+\([^;]+\)) volatile;$/gm)].map((match) => match[1]),
  [
    'public.certsim_protected_resume_attempt(uuid, uuid)',
    'exam_delivery.resume_current_attempt(uuid, text, text)',
    'public.certsim_protected_resume_current_attempt(uuid, text, text)',
  ],
  'B4A must alter only the three audited resume-chain declarations',
);
assert.equal((hotfixLower.match(/^alter function\b/gm) ?? []).length, 3);
assert.match(hotfixLower, /notify pgrst, 'reload schema';/);
assert.doesNotMatch(hotfixLower, /\b(?:create|replace|drop|grant|revoke|insert|update|delete|truncate|merge)\b/);

for (const object of [
  'exam_delivery.attempt_abandonment_events',
  'exam_delivery.attempt_recovery_events',
  'exam_delivery.abandon_attempt',
  'exam_delivery.recover_study_sandbox',
  'exam_delivery.list_recoverable_study_sandboxes',
  'exam_delivery.get_attempt_lifecycle_summary',
  'public.certsim_protected_recover_study_sandbox',
  'public.certsim_protected_list_recoverable_study_sandboxes',
  'public.certsim_protected_get_attempt_lifecycle_summary',
]) {
  assert.ok(lower.includes(object), `missing Issue #167 object: ${object}`);
}

assert.match(source, /foreign key \(attempt_id, actor_id\)[\s\S]+references exam_delivery\.attempts\(id, owner_id\)[\s\S]+on delete restrict/g);
assert.match(source, /foreign key \(package_version_id, package_profile_id\)[\s\S]+references exam_delivery\.package_profiles\(package_version_id, id\)[\s\S]+on delete restrict/g);
assert.match(source, /unique \(actor_id, request_id\)/g);
assert.match(source, /previous_status = 'in_progress'/);
assert.match(source, /previous_status = 'abandoned'/);
assert.match(source, /next_status = 'in_progress'/);
assert.match(source, /purpose = 'study_sandbox'/);
assert.match(source, /learner_discarded_study_sandbox/);
assert.match(source, /historical_study_sandbox_recovery/);
assert.match(source, /guard_attempt_abandonment_events_mutation/);
assert.match(source, /guard_attempt_recovery_events_mutation/);
assert.match(source, /attempts_owner_profile_abandoned_sandbox_recovery_idx/);
assert.match(source, /issue167_recovery_event_id/);
assert.match(source, /issue167-study-sandbox:/);
assert.doesNotMatch(source, /issue167_(?:recovery_)?bypass/i);
for (const wrapper of [
  'certsim_protected_recover_study_sandbox',
  'certsim_protected_list_recoverable_study_sandboxes',
  'certsim_protected_get_attempt_lifecycle_summary',
]) {
  assert.match(source, new RegExp(`create function public\\.${wrapper}[\\s\\S]+?security definer[\\s\\S]+?set search_path = ''`));
}

for (const table of ['attempt_abandonment_events', 'attempt_recovery_events']) {
  assert.match(source, new RegExp(`alter table exam_delivery\\.${table} enable row level security`));
  assert.match(source, new RegExp(`revoke all on table exam_delivery\\.${table}[\\s\\S]+from public, anon, authenticated, service_role`));
}

const recoveryBody = source.match(/create function exam_delivery\.recover_study_sandbox[\s\S]+?\n\$\$;/)?.[0] ?? '';
assert.doesNotMatch(recoveryBody, /insert into exam_delivery\.attempts/i, 'recovery must retain the original attempt row');
assert.match(recoveryBody, /set status = 'in_progress',[\s\S]+practice_last_activity_at = v_now,[\s\S]+practice_idle_expires_at = v_now \+ interval '30 days'/);
assert.match(recoveryBody, /attempt_results/);
assert.match(recoveryBody, /review_snapshots/);
assert.match(recoveryBody, /attempt_replacements/);
assert.match(recoveryBody, /practice_attempt_expirations/);
assert.match(recoveryBody, /attempt_abandonment_events/);
assert.match(recoveryBody, /can_use_profile/);

const discoveryBody = source.match(/create function exam_delivery\.list_recoverable_study_sandboxes[\s\S]+?\n\$\$;/)?.[0] ?? '';
const summaryBody = source.match(/create function exam_delivery\.get_attempt_lifecycle_summary[\s\S]+?\n\$\$;/)?.[0] ?? '';
for (const safeBody of [discoveryBody, summaryBody]) {
  assert.doesNotMatch(safeBody, /response_payload|presentation_snapshot|scoring_snapshot|review_payload|question_id|attempt_item_id/i);
}
assert.match(discoveryBody, /limit least\(greatest\(coalesce\(p_limit, 8\), 1\), 20\)/);

const historicalWrites = source.match(/(?:update|insert into|delete from)\s+exam_delivery\.attempts/gi) ?? [];
assert.equal(historicalWrites.length, 2, 'only the audited abandon and explicit recovery functions may update attempts');
for (const table of ['attempt_abandonment_events', 'attempt_recovery_events']) {
  const inserts = [...source.matchAll(new RegExp(`insert into exam_delivery\\.${table}[\\s\\S]*?;`, 'gi'))];
  assert.equal(inserts.length, 1, `${table} must have one runtime insert and no backfill`);
  assert.match(inserts[0][0], /\) values \(/i, `${table} insert must be row-scoped, not a historical SELECT backfill`);
}

const [routes, handler, responses, client, runner, presentation, details, postgrestIntegration, workflow] = await Promise.all([
  readFile(new URL('../supabase/functions/certsim-protected-exam/routes.ts', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/certsim-protected-exam/handler.ts', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/certsim-protected-exam/responses.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/protectedExamClient.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/exam/ProtectedExamRunner.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/exam/ExamWorkspacePresentation.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/exam/StudentDetails.jsx', import.meta.url), 'utf8'),
  readFile(new URL('./test-issue167-resume-postgrest-integration.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../.github/workflows/backend-exam-delivery-db-validation.yml', import.meta.url), 'utf8'),
]);

for (const route of [
  'lifecycle-summary',
  'recoverable-sandboxes',
  'practiceRecover',
]) assert.ok(routes.includes(route), `missing Issue #167 Edge route ${route}`);
for (const rpc of [
  'certsim_protected_get_attempt_lifecycle_summary',
  'certsim_protected_list_recoverable_study_sandboxes',
  'certsim_protected_recover_study_sandbox',
]) assert.ok(routes.includes(rpc), `missing Issue #167 fixed RPC ${rpc}`);
for (const mapper of ['mapAttemptLifecycleSummary', 'mapRecoverableStudySandboxes', 'mapStudySandboxRecovery']) {
  assert.ok(handler.includes(mapper) && responses.includes(`function ${mapper}`), `missing Issue #167 mapper ${mapper}`);
}
assert.match(handler, /p_actor_id: actorId/);
assert.match(handler, /p_limit: 8/);
assert.match(client, /getAttemptLifecycleSummary:/);
assert.match(client, /listRecoverableStudySandboxes:/);
assert.match(client, /recoverStudySandbox:[\s\S]*method: 'POST'[\s\S]*requestId/);
assert.match(runner, /async function saveAndExit\(\)[\s\S]*await saveItem\(currentItemId\)[\s\S]*onExit\?\.\(\)/);
assert.doesNotMatch(runner.match(/async function saveAndExit\(\)[\s\S]*?\n  }/)?.[0] ?? '', /abandonAttempt/);
assert.match(runner, /async function prepareSandboxDiscard\(\)[\s\S]*getAttemptLifecycleSummary/);
assert.match(runner, /discardRequest\.current\.requestId/);
assert.match(runner, /const \[discardOutcomeAmbiguous, setDiscardOutcomeAmbiguous\] = useState\(false\)/);
assert.match(runner, /if \(lifecycleLock\.current \|\| discardOutcomeAmbiguous\) return;/);
assert.match(runner, /disabled=\{lifecycleOperation === 'discarding' \|\| discardOutcomeAmbiguous\}/);
assert.match(runner, /isAmbiguousProtectedMutation\(error\)[\s\S]*setDiscardOutcomeAmbiguous\(true\)/);
assert.match(presentation, /fieldset className="protected-interaction-fieldset" disabled=\{interactionDisabled\}/);
assert.match(runner, /recoveryRequest\.current\.requestId/);
assert.match(runner, /listCurrentAttemptBindings[\s\S]*listRecoverableStudySandboxes/);
assert.match(details, /Save & exit preserves this same Study Sandbox[\s\S]*30-day inactivity window[\s\S]*Discard saved sandbox is permanent/);
assert.match(postgrestIntegration, /ISSUE167_DISPOSABLE_LOCAL_(?:DATABASE|POSTGREST)_REQUIRED/g);
assert.match(postgrestIntegration, /\/rest\/v1\/rpc\/certsim_protected_resume_attempt/);
assert.match(postgrestIntegration, /method:\s*'POST'/);
assert.match(postgrestIntegration, /POSTGREST_RESUME_SQLSTATE_25006/);
assert.match(postgrestIntegration, /practice_last_activity_at/);
assert.match(postgrestIntegration, /saved-response-167-b4a/);
assert.match(postgrestIntegration, /attempt_results|review_snapshots/);
assert.match(workflow, /SUPABASE_URL="\$API_URL" SUPABASE_SERVICE_ROLE_KEY="\$SERVICE_ROLE_KEY" SUPABASE_DB_URL="\$DB_URL" node scripts\/test-issue167-resume-postgrest-integration\.mjs/);
assert.doesNotMatch(postgrestIntegration, /supabase\.co|certsimplatform\.com|qngnoctsdhzcpagesvxz/i);

assert.deepEqual(Object.fromEntries([
  'assigned_assessment',
  'self_directed_exam',
  'study_sandbox',
  'targeted_domain',
  'weak_area',
  'pbq_practice',
].map((purpose) => [purpose, getProtectedExitContract(purpose).label])), {
  assigned_assessment: 'End attempt',
  self_directed_exam: 'End attempt',
  study_sandbox: 'Save & exit',
  targeted_domain: 'End practice',
  weak_area: 'End practice',
  pbq_practice: 'End practice',
});

console.log(`Issue #167 lifecycle contract and B4A resume volatility hotfix validated in ${issue167Migrations[0]} and ${issue167HotfixMigrations[0]}.`);

function canonicalSha256(value) {
  return createHash('sha256').update(value.replaceAll('\r\n', '\n')).digest('hex');
}
