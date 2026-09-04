import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [migration, continuationMigration, eligibilityMigration, routes, handler, responses, client, trainerService, trainerPage, studentPage, savedResults, pilotRunner] = await Promise.all([
  read('supabase/migrations/20260901102814_protected_access_history_staff_analytics.sql'),
  read('supabase/migrations/20260901122402_unify_attempt_continuation_authorization.sql'),
  read('supabase/migrations/20260901134555_bind_profile_eligibility_to_package_version.sql'),
  read('supabase/functions/certsim-protected-exam/routes.ts'),
  read('supabase/functions/certsim-protected-exam/handler.ts'),
  read('supabase/functions/certsim-protected-exam/responses.ts'),
  read('src/lib/protectedExamClient.js'),
  read('src/lib/trainerDashboardService.js'),
  read('src/components/trainer/TrainerDashboardPage.jsx'),
  read('src/components/trainer/TrainerStudentDetailPage.jsx'),
  read('src/protected/ProtectedSavedResultsPage.jsx'),
  read('scripts/run-protected-practice-pilot.mjs'),
]);

for (const table of ['exam_profile_activations', 'exam_entitlements', 'exam_preview_authorizations']) {
  assert.match(migration, new RegExp(`create table exam_delivery\\.${table}`));
  assert.match(migration, new RegExp(`alter table exam_delivery\\.${table} enable row level security`));
}
assert.match(migration, /revoke all on table exam_delivery\.exam_profile_activations,exam_delivery\.exam_entitlements,exam_delivery\.exam_preview_authorizations from public,anon,authenticated,service_role/);
for (const role of ['platform_owner', 'college_admin', 'campus_admin', 'trainer', 'student']) {
  assert.match(migration, new RegExp(`'${role}'`));
}
for (const target of ['learner', 'organisation', 'campus', 'group', 'module']) {
  assert.match(migration, new RegExp(`'${target}'`));
}
for (const purpose of ['assigned_assessment', 'self_directed_exam', 'study_sandbox', 'targeted_domain', 'weak_area', 'pbq_practice']) {
  assert.match(migration, new RegExp(`'${purpose}'`));
}
for (const fn of ['classify_actor', 'has_staff_profile_access', 'has_student_profile_entitlement', 'has_preview_profile_access', 'can_use_profile', 'staff_can_view_learner', 'list_history', 'list_staff_history', 'history_summary', 'practice_availability', 'start_practice']) {
  assert.match(migration, new RegExp(`create (?:or replace )?function exam_delivery\\.${fn}`));
}
assert.match(migration, /actor_classification text/);
assert.match(migration, /analytics_eligible boolean/);
assert.match(migration, /new\.actor_classification:=exam_delivery\.classify_actor\(new\.owner_id\)/);
assert.match(migration, /new\.analytics_eligible:=new\.actor_classification='student' and new\.purpose in \('assigned_assessment','self_directed_exam'\)/);
assert.match(migration, /attempt_actor_classification_immutable/);
assert.match(migration, /analytics_eligible is true/);
assert.match(migration, /a\.owner_id=p_actor_id/);
assert.equal((migration.match(/not exists\(select 1 from exam_delivery\.attempts protected_attempt where protected_attempt\.id=a\.id\)/g) ?? []).length, 2);
assert.match(migration, /m\.status='active'/);
assert.match(migration, /e\.enabled and \(e\.valid_from is null or e\.valid_from<=statement_timestamp\(\)\)/);
assert.match(migration, /e\.target_type='module' and false/);
assert.match(migration, /set search_path=''/);
assert.match(migration, /set statement_timeout='3s'/);
for (const grant of migration.match(/^grant execute[^;]+;/gim) ?? []) {
  assert.doesNotMatch(grant, /\bto\s+(?:public|anon|authenticated)\b/i);
}
assert.doesNotMatch(migration, /insert into exam_delivery\.(exam_profile_activations|exam_entitlements|exam_preview_authorizations)/i);
assert.doesNotMatch(migration, /delete\s+from|truncate/i);
assert.match(continuationMigration, /create or replace function exam_delivery\.authorize_attempt_continuation/);
assert.match(continuationMigration, /exam_delivery\.can_use_profile\(/);
assert.doesNotMatch(continuationMigration, /exam_delivery\.exam_access_learners/);
assert.match(continuationMigration, /a\.package_version_id,a\.package_profile_id/);
assert.match(continuationMigration, /'examKey',exam_delivery\.normalize_exam_key\(v\.exam_key\)/);
assert.match(continuationMigration, /'profileKey',v\.profile_key/);
assert.match(continuationMigration, /set search_path = ''/);
assert.match(continuationMigration, /set statement_timeout = '5s'/);
assert.match(continuationMigration, /revoke execute on function exam_delivery\.authorize_attempt_continuation\(uuid,text\)[\s\S]+from public,anon,authenticated,service_role/);
assert.doesNotMatch(continuationMigration, /insert\s+into|update\s+|delete\s+from|truncate/i);
assert.match(eligibilityMigration, /create function exam_delivery\.check_profile_eligibility\(/);
assert.match(eligibilityMigration, /p_package_version text[\s\S]+p_purpose exam_delivery\.attempt_purpose/);
assert.match(eligibilityMigration, /pv\.package_version=p_package_version/);
assert.match(eligibilityMigration, /pp\.profile_key=p_profile_key/);
assert.match(eligibilityMigration, /v_package_schema_version='certsim-protected-package-v1'[\s\S]+check_eligibility_ai901_v1/);
assert.match(eligibilityMigration, /exam_delivery\.can_use_profile\(\s*p_actor_id,v_package_version_id,v_package_profile_id,p_purpose/);
assert.match(eligibilityMigration, /p_purpose='assigned_assessment'[\s\S]+check_assessment_eligibility_v2/);
assert.match(eligibilityMigration, /security definer[\s\S]+set search_path = ''[\s\S]+set statement_timeout = '5s'/);
assert.match(eligibilityMigration, /create function public\.certsim_protected_check_profile_eligibility[\s\S]+security invoker/);
assert.match(eligibilityMigration, /revoke execute on function exam_delivery\.check_profile_eligibility[\s\S]+from public,anon,authenticated,service_role/);
assert.match(eligibilityMigration, /grant execute on function public\.certsim_protected_check_profile_eligibility[\s\S]+to service_role/);
assert.doesNotMatch(eligibilityMigration, /insert\s+into|update\s+|delete\s+from|truncate/i);

for (const source of [routes, handler, responses, client]) assert.match(source, /staffHistory|staff\/history|listStaffHistory/i);
assert.match(trainerService, /createProtectedExamClient/);
assert.match(trainerService, /analyticsEligible/);
assert.match(trainerPage, /result\.analyticsEligible !== false/);
assert.match(studentPage, /result\.analyticsEligible !== false/);
assert.match(savedResults, /totalCount/);
assert.match(savedResults, /nextCursor/);
assert.match(savedResults, /loadProtectedHistoryPage/);
assert.match(savedResults, /loadAllProtectedHistory\(client/);
assert.match(pilotRunner, /'availability-ai901-preview':[^{]+\{[^}]+availabilityOnly: true/);
assert.match(pilotRunner, /availabilityRequests: 1,[\s\S]+startRequests: 0/);
assert.match(pilotRunner, /const PROFILE_BINDINGS = Object\.freeze\(\[[\s\S]+\['ai901', '2\.0\.0'[\s\S]+\['az204', '1\.1\.0'[\s\S]+\['securityplussy0701', '1\.0\.0'[\s\S]+\['az400', '1\.0\.0'/);
assert.match(pilotRunner, /stageName === 'eligibility-unentitled'[\s\S]+access_not_granted/);
assert.match(pilotRunner, /requireStatus\(eligibility, 200\)[\s\S]+eligibility\.data\?\.eligible !== false/);
assert.match(pilotRunner, /packageVersion=\$\{packageVersion\}[\s\S]+purpose=self_directed_exam/);
assert.match(pilotRunner, /stageName === 'eligibility-profiles'[\s\S]+profileChecks: PROFILE_BINDINGS\.length[\s\S]+startRequests: 0/);
assert.match(pilotRunner, /'resume-ai901-preview':[^{]+\{[^}]+resumeOnly: true/);
assert.match(pilotRunner, /zeroStartRequests: Boolean\(config\.resumeOnly\)/);
assert.match(pilotRunner, /verifyStaffHistoryTraversal\(first\.data, second\.data, 25\)/);

console.log(JSON.stringify({
  ok: true,
  accessRoles: 5,
  entitlementTargets: 5,
  attemptPurposes: 6,
  hostedMutations: 0,
}));
