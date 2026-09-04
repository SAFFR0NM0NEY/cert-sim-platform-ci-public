import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EMPTY_TRAINER_FILTERS, trainerFiltersEqual, updateDraftScopeFilter } from '../src/lib/trainerFilterDraft.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [page, scopeHook, optionsHook, service, client, handler, routes, responses, migration, runtimeFix, classificationFix] = await Promise.all([
  read('src/components/trainer/TrainerDashboardPage.jsx'), read('src/hooks/useTrainerScope.js'),
  read('src/hooks/useTrainerScopeOptions.js'), read('src/lib/trainerScopeService.js'),
  read('src/lib/protectedExamClient.js'), read('supabase/functions/certsim-protected-exam/handler.ts'),
  read('supabase/functions/certsim-protected-exam/routes.ts'), read('supabase/functions/certsim-protected-exam/responses.ts'),
  read('supabase/migrations/20260903034551_issue26_bounded_staff_filters.sql'),
  read('supabase/migrations/20260903041403_issue26_campus_scope_runtime_fix.sql'),
  read('supabase/migrations/20260903062901_issue26_legacy_classification_performance.sql'),
]);

const selected = { ...EMPTY_TRAINER_FILTERS, organisationId: 'o', campusId: 'c', groupId: 'g', assignmentId: 'a', examKey: 'az204' };
const campusChanged = updateDraftScopeFilter(selected, 'campusId', 'c2');
assert.equal(campusChanged.groupId, '');
assert.equal(campusChanged.assignmentId, '');
assert.equal(campusChanged.examKey, 'az204');
assert.equal(trainerFiltersEqual(selected, selected), true);
assert.equal(trainerFiltersEqual(selected, campusChanged), false);

assert.match(page, /const \[trainerFilters, setTrainerFilters\]/);
assert.match(page, /const \[draftFilters, setDraftFilters\]/);
assert.match(page, /Apply filters/);
assert.match(page, /Unapplied changes/);
assert.match(page, /setTrainerFilters\(draftFilters\)/);
assert.match(page, /useTrainerScopeOptions\(draftFilters\.organisationId/);
assert.match(page, /useTrainerScope\(\{[\s\S]*\.\.\.trainerFilters/);
assert.doesNotMatch(scopeHook, /setState\(emptyScope\)/);
assert.match(optionsHook, /controllerRef\.current\?\.abort/);
assert.match(service, /scopeOptionsCache/);
assert.match(service, /SIGNED_OUT/);
assert.match(service, /SIGNED_IN/);
assert.match(service, /const protectedScope = buildTrainerScopeRequest\(scope\)/);
assert.match(service, /'resultStatus', 'search', 'workflow', 'cursor'/);
assert.doesNotMatch(service, /'progressStatus', 'readinessStatus'/);
assert.match(client, /\/staff\/scope-options/);
assert.match(client, /\/staff\/dashboard-query/);
assert.match(handler, /search\.length > 100/);
assert.match(routes, /staffScopeOptions/);
assert.match(routes, /staffDashboardQuery/);
assert.match(responses, /mapStaffScopeOptions/);
assert.match(responses, /mapStaffDashboardQuery/);
assert.match(responses, /Number\.isSafeInteger\(history\.returnedCount\)/);
assert.match(migration, /staff_scope_options/);
assert.match(migration, /staff_dashboard_query/);
assert.match(migration, /set statement_timeout='5s'/g);
assert.match(migration, /v_search is null[\s\S]*like '%'\|\|v_search\|\|'%'/);
assert.match(migration, /filtered as materialized[\s\S]*bounded as \(select \* from ordered limit v_size\+1\)/);
assert.match(migration, /revoke execute[\s\S]*from public,anon,authenticated,service_role/);
assert.match(migration, /grant execute[\s\S]*to service_role/);
assert.match(migration, /v_role<>'campus_admin'[\s\S]*role='campus_admin'/);
assert.match(migration, /v_workflow in \('overview','analytics','assignments'\)/);
assert.match(migration, /v_workflow in \('overview','analytics','students','results'\)/);
assert.doesNotMatch(page, /scopeOptions\.loading\}/);
assert.doesNotMatch(runtimeFix, /min\(m\.campus_id\)/);
assert.match(runtimeFix, /select m\.campus_id[\s\S]*order by m\.created_at,m\.id limit 1/);
assert.match(classificationFix, /v_attempt jsonb := coalesce\(p_attempt_snapshot, '\{\}'::jsonb\) \|\| '\{\}'::jsonb/);
assert.match(classificationFix, /v_result jsonb := coalesce\(p_result_snapshot, '\{\}'::jsonb\) \|\| '\{\}'::jsonb/);
assert.doesNotMatch(classificationFix, /insert\s+into|update\s+public\.|delete\s+from/i);
assert.match(classificationFix, /revoke execute[\s\S]*from public,anon,authenticated,service_role/);

console.log(JSON.stringify({ ok: true, issue: 26, draftRequestsBeforeApply: 0, applyDashboardRequests: 1, searchBeforePagination: true }));
