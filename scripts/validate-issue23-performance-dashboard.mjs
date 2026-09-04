import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const page = read('src/components/trainer/TrainerDashboardPage.jsx');
const assignments = read('src/lib/examAssignmentService.js');
const service = read('src/lib/trainerDashboardService.js');
const mapper = read('supabase/functions/certsim-protected-exam/responses.ts');
const migration = read('supabase/migrations/20260902175259_issue23_performance_dashboard_contract.sql');
const historyMigration = read('supabase/migrations/20260902181321_issue23_scoped_assessment_history.sql');

assert.match(service, /IS_PROTECTED_DELIVERY\s*\?\s*\[createOkResult\(\[\]\), createOkResult\(null\)\]/);
assert.doesNotMatch(service, /async function readProtectedStaffAnalytics/);
assert.match(page, /mergeScopedAssignments\(scopedPerformance\.assignments, trackedAssignments\)/);
for (const field of ['assignmentId', 'purpose', 'rawScore']) assert.match(page, new RegExp(`${field}: item\\.`));
assert.match(page, /examKey: normalizeTrainerExamKey\(item\.examKey\)/);
assert.match(page, /profileId: item\.profileKey/);
assert.match(page, /serverAuthoritative: item\.serverAuthoritative === true/);
assert.match(page, /historySource: item\.source/);
assert.match(page, /selectedAssignment[\s\S]*normalizeTrainerExamKey\(result\.examKey\)/);
assert.match(page, /allFilteredResults[\s\S]*slice\(0, 25\)/);
assert.match(page, /useDebouncedValue\(trainerFilters\.search, 200\)/);
assert.match(page, /analyticsEligible: true/);
assert.match(page, /attemptKind: 'assessment'/);
assert.match(page, /securityplussy0701[\s\S]*?'security-plus-sy0-701'/);
assert.match(assignments, /getTrainerScopePage\(\{[\s\S]*?assignmentId: assignment\.id/);
assert.match(assignments, /normalizeScopedAssignmentResults\(scopedResult\.data\?\.history\?\.items, students\)/);
assert.match(assignments, /serverAuthoritative: item\.serverAuthoritative/);
assert.match(assignments, /source: item\.source/);
assert.match(mapper, /\["assigned_assessment", "self_directed_exam"\]/);
assert.match(mapper, /item\.source === "protected" && item\.serverAuthoritative === true/);
assert.match(mapper, /item\.source === "legacy_authoritative" && item\.serverAuthoritative === false/);
assert.match(migration, /visible_learners as materialized/);
assert.match(migration, /join visible_learners vl on vl\.learner_id=a\.owner_id/);
assert.match(migration, /a\.analytics_eligible is true and a\.purpose='assigned_assessment'/);
assert.match(migration, /'assignmentId',source_assignment_id/);
assert.match(migration, /'examKey',exam_delivery\.normalize_exam_key\(exam_key\)/);
assert.doesNotMatch(migration, /update\s+exam_delivery\.attempts|delete\s+from\s+exam_delivery\.attempts/i);
assert.doesNotMatch(migration, /grant execute[\s\S]*to authenticated|grant execute[\s\S]*to anon/i);
assert.match(historyMigration, /visible_learners as materialized/);
assert.match(historyMigration, /a\.purpose in \('assigned_assessment','self_directed_exam'\)/);
assert.match(historyMigration, /classified\.purpose in \('assigned_assessment','self_directed_exam'\)/);
assert.match(historyMigration, /false,'legacy_authoritative'/);
assert.match(historyMigration, /v_assignment is null/);
const scopeHook = read('src/hooks/useTrainerScope.js');
assert.match(scopeHook, /controllerRef\.current\?\.abort\(\)/);
assert.match(scopeHook, /selection\.assignmentId[\s\S]*selection\.campusId[\s\S]*selection\.organisationId/);
assert.match(page, /useTrainerScope\(\{[\s\S]*\.\.\.trainerFilters/);
assert.doesNotMatch(historyMigration, /update\s+exam_delivery\.attempts|delete\s+from\s+exam_delivery\.attempts/i);

console.log(JSON.stringify({
  ok: true,
  issue: 23,
  assignmentScopedAnalytics: true,
  legacyHistoryMaterialized: true,
  lifecycleRequests: 0,
}));
