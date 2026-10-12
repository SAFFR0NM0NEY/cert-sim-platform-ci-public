import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ai901ExamDefinition,
  az204ExamDefinition,
  az400ExamDefinition,
  securityPlusSy0701ExamDefinition,
} from '../src/exams/examRegistry.protected.js';
import { AI901_PROTECTED_PACKAGE_V2 } from '../src/lib/ai901ProtectedPackageV2.js';

const expected = new Map([
  ['ai901/ai901-controlled-beta-compact', [25, 25]],
  ['ai901/ai901-controlled-beta-full', [50, 45]],
  ['az204/full-profile', [60, 150]],
  ['az204/compact-profile', [40, 100]],
  ['az204/standard-profile', [50, 120]],
  ['az204/case-heavy-profile', [50, 130]],
  ['security-plus-sy0-701/strict-beta-full', [90, 90]],
  ['security-plus-sy0-701/strict-beta-compact', [45, 60]],
  ['az400/az400-mvp-full-profile', [80, 120]],
  ['az400/az400-mvp-compact-profile', [60, 90]],
  ['az400/az400-sectioned-full-exam-profile', [80, 120]],
]);

const actual = new Map();
for (const exam of [ai901ExamDefinition, az204ExamDefinition, securityPlusSy0701ExamDefinition, az400ExamDefinition]) {
  for (const profile of [exam.profiles.fullMock, ...exam.profiles.realisticRandom].filter(Boolean)) {
    actual.set(`${exam.id}/${profile.id}`, [profile.totalScoredQuestions, profile.timeLimitMinutes]);
  }
}
assert.deepEqual(actual, expected);
assert.deepEqual(expected.get('ai901/ai901-controlled-beta-compact'), [25, 25]);
assert.equal(AI901_PROTECTED_PACKAGE_V2.packageHash, '00d2005b9807ca3050bf84e7f3bd1c579415274f9ba29f2534825eb3340e75ec');
assert.equal(AI901_PROTECTED_PACKAGE_V2.validationHash, '4936a875ef9cd5ae263f47c21bc556cc4b65dd827f31b2513765cca24394c84f');

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [migration, recoveryMigration, handler, responses, app, pilot] = await Promise.all([
  read('supabase/migrations/20260901114217_purpose_aware_fixed_profile_counts.sql'),
  read('supabase/migrations/20260903161929_issue_59_functional_recovery.sql'),
  read('supabase/functions/certsim-protected-exam/handler.ts'),
  read('supabase/functions/certsim-protected-exam/responses.ts'),
  read('src/App.jsx'),
  read('scripts/run-protected-practice-pilot.mjs'),
]);

assert.match(migration, /v_fixed:=v_purpose='self_directed_exam'/);
assert.match(migration, /v_requested:=v_profile_count/);
assert.match(migration, /p_request \? 'count'[\s\S]*?p_request->>'count'<>v_profile_count::text/);
assert.match(migration, /p_request->>'count' not in \('10','20','30','40','all'\)/);
assert.match(migration, /'profileQuestionCount',v_profile_count/);
assert.match(migration, /'timeLimitMinutes',v_time_limit/);
assert.match(migration, /'fixedProfileSize',v_fixed/);
assert.match(migration, /security definer set search_path='' set statement_timeout='5s'/);
assert.match(migration, /grant execute on function exam_delivery\.practice_availability\(uuid,jsonb\) to service_role/);
assert.doesNotMatch(migration, /insert into|delete from|create policy/i);

// The browser registry is display metadata. The published package profile and
// the server materializer are authoritative for delivered composition.
assert.match(recoveryMigration, /p\.selection_config->>'normalScoredQuestionCount'/);
assert.match(recoveryMigration, /p\.selection_config->>'pbqCount'/);
assert.match(recoveryMigration, /fixed_profile_case_keys\(v_attempt\.package_version_id,p_request_id,v_attempt\.question_count,v_attempt\.selection_config\)/);
assert.match(recoveryMigration, /group_size='long' and class_rank<=v_long/);
assert.match(recoveryMigration, /group_size='short' and class_rank<=v_short/);
assert.match(recoveryMigration, /scored_size=v_case_target\/v_case_count/);
assert.match(recoveryMigration, /v_scored<>v_case_target/);
assert.doesNotMatch(recoveryMigration, /security-plus[^\n]{0,120}(?:43|85)/i);

assert.match(handler, /const fixedProfile = value\.purpose === "self_directed_exam"/);
assert.match(handler, /\[10, 20, 30, 40\][\s\S]*?value\.count !== "all"/);
assert.match(responses, /"profileQuestionCount"[\s\S]*?"timeLimitMinutes"[\s\S]*?"fixedProfileSize"/);
assert.doesNotMatch(app, /purpose:\s*'self_directed_exam',[\s\S]{0,160}?count:/);
assert.match(pilot, /'ai901-preview':[\s\S]*?expectedCount:\s*25[\s\S]*?expectedMinutes:\s*25/);
assert.match(pilot, /delete body\.expectedCount; delete body\.expectedMinutes/);
assert.match(pilot, /availability\.data\?\.profileQuestionCount !== config\.expectedCount/);
assert.match(pilot, /scored\.length !== config\.expectedCount/);

console.log(JSON.stringify({ ok: true, fixedProfiles: actual.size, ai901CompactQuestions: 25, flexibleCounts: [10, 20, 30, 40, 'all'], packageHashesChanged: false }));
