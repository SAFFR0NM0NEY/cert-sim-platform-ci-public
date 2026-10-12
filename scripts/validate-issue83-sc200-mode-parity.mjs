import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sc200ExamDefinition } from '../src/exams/examRegistry.protected.js';
import { getProtectedProfileMetadata } from '../src/exams/protectedProfileMetadata.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [migration, app, setup, runner, handler, responses] = await Promise.all([
  read('supabase/migrations/20260907072022_issue83_sc200_mode_parity.sql'),
  read('src/App.jsx'),
  read('src/components/exam/ProtectedTargetedDomainSetup.jsx'),
  read('src/components/exam/ProtectedExamRunner.jsx'),
  read('supabase/functions/certsim-protected-exam/handler.ts'),
  read('supabase/functions/certsim-protected-exam/responses.ts'),
]);

assert.equal(sc200ExamDefinition.domainSummary, '3 domains · 9 objective groups');
assert.deepEqual(sc200ExamDefinition.strictBetaProfiles.map(({ routeAction }) => routeAction), ['full', 'compact']);
assert.equal(sc200ExamDefinition.objectiveGroups.length, 3);
assert.deepEqual(sc200ExamDefinition.objectiveGroups.map(({ objectives }) => objectives.length), [4, 3, 2]);
assert.equal(new Set(sc200ExamDefinition.objectiveGroups.flatMap(({ objectives }) => objectives)).size, 9);
const sc200Metadata = getProtectedProfileMetadata('sc200');
assert.equal(sc200Metadata.packageVersion, '1.1.0');
assert.deepEqual(sc200Metadata.profiles.map(({ id, totalScoredQuestions, timeLimitMinutes, canonicalFormCount }) => [id, totalScoredQuestions, timeLimitMinutes, canonicalFormCount]), [
  ['sc200-full', 50, 100, 6], ['sc200-compact', 25, 50, 6],
]);
assert.match(setup, /<optgroup[\s\S]*Complete domain[\s\S]*group\.objectives/);
assert.match(setup, /server confirms the scope and available question count/);
assert.match(app, /objective: normalizeDomainKey\(objective\)/);
assert.match(runner, /practiceRequest\.objective/);
assert.match(handler, /objective[\s\S]*length > 160/);
assert.match(responses, /"objectiveCounts"[\s\S]*"confirmedDomain"[\s\S]*"confirmedObjective"/);

for (const token of [
  'skillGroupTargetsByForm', 'practice_availability', 'target_objective',
  'materialize_attempt_items_issue21_unrotated_base',
  'transition_live_assignment_v2', "package_version='1.0.0'", "packageVersion'<>'1.1.0'",
  "status='archived'", "reviewReleasePolicy'<>'after_submission'",
]) assert.match(migration, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(migration, /revoke execute[\s\S]*transition_live_assignment_v2[\s\S]*public,anon,authenticated,service_role/);
assert.match(migration, /grant execute on function public\.certsim_transition_live_assignment_v2\(jsonb\) to authenticated/);
assert.doesNotMatch(migration, /grant execute on function exam_delivery\.transition_live_assignment_v2/);
assert.equal((migration.match(/'sc200','1\.1\.0','sc200-(?:full|compact)'/g) ?? []).length, 2);

console.log(JSON.stringify({ ok: true, issue: 83, profiles: 2, objectiveGroups: 9, assignmentTransition: 'atomic-reviewed-boundary' }));
