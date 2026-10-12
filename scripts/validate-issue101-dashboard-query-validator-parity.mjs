import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [handler, service, migration, tests] = await Promise.all([
  readFile('supabase/functions/certsim-protected-exam/handler.ts', 'utf8'),
  readFile('src/lib/trainerScopeService.js', 'utf8'),
  readFile('supabase/migrations/20260907175904_issue101_bounded_training_dashboard_learners.sql', 'utf8'),
  readFile('supabase/functions/certsim-protected-exam/tests/function_test.ts', 'utf8'),
]);

const supportedFields = [
  'organisationId', 'campusId', 'groupId', 'assignmentId', 'examKey',
  'resultStatus', 'readinessStatus', 'search', 'workflow', 'cursor',
  'learnerCursor', 'pageSize', 'learnerPageSize',
];
for (const field of supportedFields) assert.match(handler, new RegExp(`"${field}"`));
assert.match(service, /pageSize: TRAINER_SCOPE_PAGE_SIZE, learnerPageSize: TRAINER_LEARNER_PAGE_SIZE/);
assert.match(service, /TRAINER_SCOPE_PAGE_SIZE = 50/);
assert.match(service, /TRAINER_LEARNER_PAGE_SIZE = 25/);
assert.match(migration, /v_size integer := coalesce\(nullif\(p_request->>'learnerPageSize',''\)::integer, 25\)/);
assert.match(migration, /v_size < 1 or v_size > 50/);
for (const status of ['ready', 'almost-ready', 'needs-review', 'at-risk', 'insufficient-data', 'not-started']) {
  assert.match(handler, new RegExp(`"${status}"`));
  assert.match(migration, new RegExp(`'${status}'`));
}
assert.match(migration, /decode\(p_request->>'learnerCursor','base64'\)/);
assert.doesNotMatch(handler, /decode\([^\n]*learnerCursor|atob\([^\n]*learnerCursor/);
assert.match(tests, /organisationId=.*workflow=analytics&pageSize=50&learnerPageSize=25/);
assert.match(tests, /readinessStatus=not-started&learnerCursor=opaque-cursor/);
assert.match(tests, /"unknown=value"/);

console.log(JSON.stringify({ ok: true, issue: 101, contract: 'staff-dashboard-query-validator-parity' }));
