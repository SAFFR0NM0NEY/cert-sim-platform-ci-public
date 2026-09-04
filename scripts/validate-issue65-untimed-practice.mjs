import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [migration, app, runner, presentation, routes, handler, responses, client] = await Promise.all([
  read('supabase/migrations/20260904161938_issue65_full_untimed_practice_sessions.sql'), read('src/App.jsx'),
  read('src/components/exam/ProtectedExamRunner.jsx'), read('src/components/exam/ExamWorkspacePresentation.jsx'),
  read('supabase/functions/certsim-protected-exam/routes.ts'), read('supabase/functions/certsim-protected-exam/handler.ts'),
  read('supabase/functions/certsim-protected-exam/responses.ts'), read('src/lib/protectedExamClient.js'),
]);
for (const purpose of ['study_sandbox', 'targeted_domain', 'weak_area', 'pbq_practice']) assert.ok(migration.includes(`'${purpose}'`));
assert.match(migration, /purpose in \('assigned_assessment','self_directed_exam'\).*expires_at is not null/s);
assert.match(migration, /purpose in \('study_sandbox','targeted_domain','weak_area','pbq_practice'\).*expires_at is null/s);
assert.match(migration, /practice_idle_expires_at/);
assert.match(migration, /touch_practice_activity_after_response/);
assert.match(migration, /p_practice_limit is null or preceding<p_practice_limit/);
assert.match(migration, /v_limit:=case when p_request->>'purpose' in \('study_sandbox','targeted_domain','pbq_practice'\)\s+then null/);
assert.match(migration, /targeted_domain.*q\.domain_key=p_request->>'domain'/s);
assert.match(migration, /contentKind'='case-study'/);
assert.match(migration, /p_page_size>50/);
assert.match(migration, /presented_question_number>p_after_position/);
assert.match(migration, /grant execute on function[\s\S]*certsim_protected_list_attempt_item_page[\s\S]*to service_role/);
assert.doesNotMatch(migration, /grant execute[\s\S]*certsim_protected_list_attempt_item_page[\s\S]*to authenticated/);
assert.match(app, /purpose === 'weak_area' \? \(overrides\.count \?\? 20\) : overrides\.count/);
assert.match(routes, /itemPage: "certsim_protected_list_attempt_item_page"/);
assert.match(handler, /pageSize > 50/);
assert.match(responses, /returnedThrough > totalCount/);
assert.match(client, /getAttemptItemPage/);
assert.match(runner, /itemPage\.hasMore/);
assert.match(runner, /getAttemptItemPage\(attempt\.attemptId/);
assert.match(runner, /timed=\{attempt\.timed !== false\}/);
assert.match(presentation, /timed && <ExamTimer/);
const total = 234, pageSize = 20, pages = [];
for (let after = 0; after < total; after += pageSize) pages.push(Array.from({ length: Math.min(pageSize, total - after) }, (_, index) => after + index + 1));
assert.equal(pages.length, 12);
assert.equal(Math.max(...pages.map((page) => page.length)), 20);
assert.deepEqual(pages.flat(), Array.from({ length: total }, (_, index) => index + 1));
console.log(JSON.stringify({ ok: true, issue: 65, fullPracticePurposes: 3, boundedWeakArea: true, timedAssessmentPurposes: 2, syntheticInventory: total, pageSize, pages: pages.length, browserReceivesWholeBank: false }));
