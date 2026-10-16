import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [migration, runner, client, page, scopeHook, identity, handler, routes, responses] = await Promise.all([
  read('supabase/migrations/20260902052516_r3f_scoped_analytics_and_attempt_reconciliation.sql'),
  read('src/components/exam/ProtectedExamRunner.jsx'),
  read('src/lib/protectedExamClient.js'),
  read('src/components/trainer/TrainerDashboardPage.jsx'),
  read('src/hooks/useTrainerScope.js'),
  read('src/lib/studentAttemptIdentity.js'),
  read('supabase/functions/certsim-protected-exam/handler.ts'),
  read('supabase/functions/certsim-protected-exam/routes.ts'),
  read('supabase/functions/certsim-protected-exam/responses.ts'),
]);

assert.match(migration, /a\.attribution_source='assignment'/);
assert.match(migration, /a\.source_organisation_id=v_org/);
assert.match(migration, /a\.source_campus_id=v_campus/);
assert.match(migration, /a\.source_group_id=v_group/);
assert.match(migration, /ea\.id=v_assignment/);
assert.match(migration, /v_group is null or a\.group_id=v_group/);
assert.match(migration, /v_role<>'trainer'/);
assert.doesNotMatch(migration, /update\s+exam_delivery\.attempts|delete\s+from\s+exam_delivery\.attempts/i);
assert.match(migration, /security definer[\s\S]*set search_path=''[\s\S]*set statement_timeout='5s'/);
assert.match(migration, /revoke execute[\s\S]*from public,anon,authenticated,service_role/);
assert.match(migration, /grant execute[\s\S]*to service_role/);

assert.match(routes, /currentBindings/);
assert.match(handler, /p_actor_id: actorId, p_exam_key: examKey, p_purpose: purpose/);
assert.match(responses, /mapCurrentAttemptBindings/);
const bindingMapper = responses.match(/mapCurrentAttemptBindings[\s\S]*?\n}/)?.[0] ?? '';
assert.match(bindingMapper, /attemptId/);
assert.match(bindingMapper, /expiresAt/);
assert.match(bindingMapper, /replacementPermitted/);
assert.match(client, /listCurrentAttemptBindings/);
assert.match(runner, /candidates\.length === 1/);
assert.match(runner, /setState\('resume-choice'\)/);
assert.match(runner, /No new attempt will be started/);
assert.doesNotMatch(runner, /listCurrentAttemptBindings[\s\S]{0,600}startPractice/);

assert.doesNotMatch(scopeHook, /setState\(emptyScope\);[\s\S]*setLoading\(true\)/);
assert.match(scopeHook, /setLoading\(true\);[\s\S]*getTrainerScopePage/);
assert.match(page, /normalizeScopedHistory\(scopedPerformance\.history/);
assert.match(page, /Personal, purchase, staff, and unattributed history is excluded/);
assert.doesNotMatch(page, /authoritativeAnalytics/);
assert.match(identity, /identity\.isAuthenticated/);
assert.doesNotMatch(identity.match(/canUseSignedInStudentIdentity[\s\S]*?\n}/)?.[0] ?? '', /getIdentityEmail/);

console.log(JSON.stringify({ ok: true, issues: [23, 24, 25, 29], historicalRowsRewritten: false }));
