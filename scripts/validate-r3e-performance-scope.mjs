import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [migration, handler, responses, page, roleUtils, scopeHook, scopeService, filterDraft, runner, assignments] = await Promise.all([
  read('supabase/migrations/20260901224945_r3e_assignment_scoped_performance.sql'),
  read('supabase/functions/certsim-protected-exam/handler.ts'),
  read('supabase/functions/certsim-protected-exam/responses.ts'),
  read('src/components/trainer/TrainerDashboardPage.jsx'),
  read('src/lib/roleUtils.js'),
  read('src/hooks/useTrainerScope.js'),
  read('src/lib/trainerScopeService.js'),
  read('src/lib/trainerFilterDraft.js'),
  read('src/components/exam/ProtectedExamRunner.jsx'),
  read('src/lib/examAssignmentService.js'),
]);

for (const role of ['platform_owner', 'developer', 'college_admin', 'campus_admin', 'trainer']) assert.match(migration, new RegExp(`'${role}'`));
for (const denied of ['reception', 'student']) assert.doesNotMatch(roleUtils.match(/hasScopedPerformanceDashboardAccess[\s\S]*?\n}/)?.[0] ?? '', new RegExp(`'${denied}'`));
assert.match(roleUtils, /hasScopedPerformanceDashboardAccess[\s\S]*?'developer'/);
assert.match(migration, /source_assignment_id uuid references public\.exam_assignments\(id\) on delete restrict/);
assert.match(migration, /guard_attempt_attribution_immutability/);
assert.match(migration, /v_existing\.source_assignment_id=p_assignment_id/);
assert.match(migration, /v_assignment\.student_user_id=p_actor_id/);
assert.match(migration, /m\.group_id=v_assignment\.group_id/);
assert.match(migration, /v_assignment\.profile_id<>p_profile_key/);
assert.match(migration, /attribution_source='assignment'/);
assert.match(migration, /a\.source_assignment_id=v_assignment/);
assert.match(migration, /limit v_size\+1/);
assert.match(migration, /order by a\.created_at desc,a\.id desc/);
assert.match(migration, /invalid_cursor/);
assert.doesNotMatch(migration, /update exam_delivery\.attempts set source_assignment_id|delete from exam_delivery\.attempts/i);
assert.match(handler, /staffDashboardScope/);
assert.match(handler, /body\.assignmentId == null \? \{\} : \{ p_assignment_id: assertUuid/);
assert.match(handler, /assignmentId == null \? \{\} : \{ p_assignment_id: assertUuid/);
assert.doesNotMatch(migration, /drop function public\.certsim_protected_(start_attempt|discover_current_attempt)/);
assert.match(responses, /mapStaffDashboardScope/);
for (const label of ['Organisation', 'Campus', 'Group\/class', 'Assignment']) assert.match(page, new RegExp(`label="${label}"`));
assert.doesNotMatch(page, /label="Exam"[\s\S]{0,160}value=\{trainerFilters\.examTitle\}/);
assert.match(page, /scopedPerformance\.assignments[\s\S]*?label: name/);
assert.match(page, /updateScopeFilter\('organisationId'/);
assert.match(filterDraft, /organisationId: \['campusId', 'groupId', 'assignmentId', 'examKey'\]/);
assert.match(scopeHook, /requestId !== requestRef\.current/);
assert.match(scopeHook, /getTrainerScopePage\(selection/);
assert.match(scopeHook, /loadMoreAssignments/);
assert.doesNotMatch(scopeHook, /pageCount > 1000/);
assert.match(scopeHook, /existingIds/);
assert.match(scopeHook, /repeated cursor/);
assert.match(scopeService, /TRAINER_SCOPE_PAGE_SIZE = 50/);
assert.match(runner, /assignmentId,/);
assert.match(assignments, /\?assignment=\$\{encodeURIComponent\(row\.id\)\}/);

console.log(JSON.stringify({ ok: true, issue: 23, immutableAttribution: true, stablePagination: true, protectedDto: true }));
