import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PROTECTED_ATTEMPT_PURPOSES, PROTECTED_LANGUAGE_PREFERENCES, protectedExamContract } from '../src/lib/protectedExamContract.js';
import { discoverStage1Result, verifyStage1Result } from './protected-exam-pilot/stage1-result-verifier.mjs';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [migration, separation, continuation, discovery, expiry, authority, routes, handler, responses, client, protectedResults, publisher, app, pilot] = await Promise.all([
  read('supabase/migrations/20260830075212_protected_practice_history_and_language.sql'),
  read('supabase/migrations/20260830093145_separate_practice_assessment_authorization.sql'),
  read('supabase/migrations/20260830102456_purpose_aware_attempt_continuation.sql'),
  read('supabase/migrations/20260830113215_purpose_aware_current_attempt_discovery.sql'),
  read('supabase/migrations/20260830121020_expired_practice_replacement_lifecycle.sql'),
  read('supabase/migrations/20260830131152_protected_result_authority_marker.sql'),
  read('supabase/functions/certsim-protected-exam/routes.ts'), read('supabase/functions/certsim-protected-exam/handler.ts'),
  read('supabase/functions/certsim-protected-exam/responses.ts'), read('src/lib/protectedExamClient.js'),
  read('src/protected/ProtectedSavedResultsPage.jsx'), read('scripts/publish-protected-package.mjs'),
  read('src/App.jsx'),
  read('scripts/run-protected-practice-pilot.mjs'),
]);
assert.deepEqual(PROTECTED_ATTEMPT_PURPOSES, ['assigned_assessment','self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice']);
assert.deepEqual(PROTECTED_LANGUAGE_PREFERENCES, ['csharp','python','mixed']);
assert.equal(protectedExamContract.packageVersions.az204, '1.1.0');
for (const token of ['practice_policies','attempts_one_active_purpose_idx','guard_attempt_purpose_immutability','practice_feedback_releases','practice_availability','prune_practice_selection','start_practice','check_practice_item','list_history','history_summary','print_summary']) assert.match(migration, new RegExp(token));
for (const purpose of PROTECTED_ATTEMPT_PURPOSES) assert.match(migration, new RegExp(purpose));
for (const route of ['/practice/availability','/practice/sessions','/history','/print-summary']) assert.ok(routes.includes(route.replaceAll('/', '\\/')) || routes.includes(route));
for (const method of ['getPracticeAvailability','startPractice','checkPracticeItem','listHistory','getHistorySummary','getPrintableSummary']) assert.match(client, new RegExp(method));
assert.match(handler, /PRACTICE_PURPOSES/); assert.match(handler, /missed-heavy/); assert.match(handler, /new-heavy/);
assert.match(responses, /mapPrintSummary/); assert.doesNotMatch(responses, /scoring_snapshot|protected_payload/);
assert.match(protectedResults, /Account results/); assert.match(protectedResults, /Historical browser-only results/);
assert.match(publisher, /--package-version=/);
assert.match(app, /purpose:\s*'self_directed_exam'/);
assert.doesNotMatch(app, /purpose:\s*'self_directed_exam',[\s\S]{0,160}?count:/);
for (const stage of ['resume-self-directed', 'self-directed', 'sandbox', 'targeted', 'weak', 'security-pbq', 'az400-case']) assert.ok(pilot.includes(stage));
assert.match(pilot, /'recover-sandbox'/);
assert.match(pilot, /config\.recoverFeedback[\s\S]*?item\.revision[\s\S]*?item\.response/);
assert.match(pilot, /responsesSaved:\s*config\.recoverFeedback \? 0/);
assert.match(migration, /on conflict\(attempt_id,attempt_item_id,response_revision\) do update set request_id=exam_delivery\.practice_feedback_releases\.request_id/);
assert.equal((client.match(/checkPracticeItem:/g) ?? []).length, 1);
assert.match(pilot, /zeroStartRequests/);
assert.match(pilot, /--confirm-contained-g3b2/);
assert.match(pilot, /persistSession:\s*false/);
for (const token of ['practice_attempt_expirations','practice_window_expired','pg_advisory_xact_lock',"status='expired'",'response_count','maximum_completed_attempts']) assert.match(expiry, new RegExp(token));
assert.match(expiry, /protected_assignment_id is not null/);
assert.match(expiry, /revoke all on table exam_delivery\.practice_attempt_expirations[\s\S]*public,anon,authenticated,service_role/);
assert.match(expiry, /create trigger guard_practice_attempt_expirations_mutation/);
assert.doesNotMatch(expiry, /delete\s+from|truncate|drop\s+table/i);
assert.match(pilot, /autoRefreshToken:\s*false/);
assert.match(pilot, /signOut\(\{ scope: 'global' \}\)/);
assert.doesNotMatch(pilot, /service[_-]?role|secret[_-]?key/i);
assert.match(migration, /enable row level security/g);
assert.match(migration, /from public,anon,authenticated,service_role/);
assert.doesNotMatch(migration, /insert into exam_delivery\.practice_policies/i);
for (const token of ['materialize_attempt_items', 'start_attempt_v2', 'start_practice', "'assigned_assessment'"]) assert.ok(separation.includes(token));
assert.match(separation, /protected_assignment_id[\s\S]*?null,v_request_id/);
assert.match(separation, /revoke execute on function exam_delivery\.materialize_attempt_items\(uuid,uuid,integer\)[\s\S]*?public, anon, authenticated, service_role/);
assert.doesNotMatch(separation, /require_assignment\s*=\s*false/i);
assert.doesNotMatch(separation, /insert into exam_delivery\.(practice_policies|exam_access_learners|protected_assignments)/i);
for (const operation of ['resume','save_response','check_item','submit']) assert.match(continuation, new RegExp(`'${operation}'`));
assert.match(continuation, /authorize_attempt_continuation\(\s*p_attempt_id uuid,\s*p_operation text/);
assert.match(continuation, /rename to check_assessment_eligibility_v2/);
assert.match(continuation, /package_schema_version='certsim-protected-package-v2'[\s\S]*?check_eligibility\(v\.owner_id/);
assert.match(continuation, /purpose='assigned_assessment'/);
assert.match(continuation, /practice_policies/);
assert.match(continuation, /ownerId/);
assert.match(continuation, /set_config\('certsim\.attempt_continuation_id'/);
assert.match(continuation, /get_review/);
assert.match(continuation, /review_release_policy<>'never'/);
assert.match(continuation, /revoke execute on function exam_delivery\.authorize_attempt_continuation[\s\S]*?public,anon,authenticated,service_role/);
assert.doesNotMatch(continuation, /insert into exam_delivery\.(practice_policies|exam_access_policies|exam_access_learners|protected_assignments)/i);
for (const token of ['discover_current_attempt','p_package_version','p_purpose','p_language','authorize_attempt_continuation','attempt_not_found','attempt_conflict']) assert.match(discovery, new RegExp(token));
assert.match(discovery, /a\.owner_id=p_actor_id/);
assert.match(discovery, /a\.status='in_progress'/);
assert.match(discovery, /statement_timestamp\(\)<a\.expires_at/);
assert.match(discovery, /limit 2/);
assert.match(discovery, /resume_current_attempt_ai901_v1/);
assert.doesNotMatch(discovery, /check_(?:assessment_)?eligibility/);
assert.doesNotMatch(discovery, /insert|update|delete/i);
assert.match(discovery, /revoke execute on function exam_delivery\.discover_current_attempt[\s\S]*?public,anon,authenticated,service_role/);
assert.match(handler, /p_package_version:[\s\S]*?p_purpose:[\s\S]*?p_language:/);
assert.match(pilot, /packageVersion:[\s\S]*?purpose:[\s\S]*?language:/);
assert.match(authority, /'serverAuthoritative', ar\.server_authoritative/);
assert.match(authority, /ar\.server_authoritative = true/);
assert.match(authority, /set search_path = ''/);
assert.match(authority, /set statement_timeout = '15s'/);
assert.doesNotMatch(authority, /p_request|insert|update|delete/i);
assert.match(responses, /"serverAuthoritative"/);
assert.match(pilot, /result\.data\.result\.serverAuthoritative !== true/);
const stage1 = { attemptId: 'internal-only', examKey: 'az204', packageVersion: '1.1.0', profileKey: 'compact-profile', purpose: 'self_directed_exam', serverAuthoritative: true };
assert.equal(discoverStage1Result([stage1]), stage1);
for (const key of ['examKey', 'packageVersion', 'profileKey', 'purpose']) {
  assert.throws(() => discoverStage1Result([{ ...stage1, [key]: 'wrong' }]));
}
assert.throws(() => discoverStage1Result([]));
assert.throws(() => discoverStage1Result([stage1, { ...stage1 }]));
assert.doesNotThrow(() => discoverStage1Result([{ ...stage1, status: undefined, languagePreference: undefined }]));
for (const marker of [undefined, false, null, 'true', 1]) {
  assert.throws(() => verifyStage1Result(stage1, { status: 200, data: { result: { attemptId: stage1.attemptId, examKey: stage1.examKey, profileKey: stage1.profileKey, serverAuthoritative: marker } } }));
}
const verifiedStage1 = verifyStage1Result(stage1, { status: 200, data: { result: { attemptId: stage1.attemptId, examKey: stage1.examKey, profileKey: stage1.profileKey, serverAuthoritative: true } } });
assert.deepEqual(verifiedStage1, { ok: true, stage: 'stage1-read-only-result-verification', historyCandidateCount: 1, historyBindingVerified: true, resultRequests: 1, resultBoundToDiscoveredEntry: true, serverAuthoritative: true, lifecycleRequests: 0 });
assert.doesNotMatch(JSON.stringify(verifiedStage1), /internal-only|question|answer|explanation|snapshot|response/i);
assert.doesNotMatch(pilot, /profileId === 'compact-profile'|item\.status === 'completed'|item\.languagePreference === 'mixed'|exactBinding:\s*true/);
console.log(JSON.stringify({ ok: true, purposes: PROTECTED_ATTEMPT_PURPOSES.length, fixedEdgeOperations: 6, productionMutations: 0 }));
