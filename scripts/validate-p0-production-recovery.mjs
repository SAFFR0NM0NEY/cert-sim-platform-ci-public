import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { applyHistorySummaries, buildStudentProgressSnapshot } from '../src/lib/studentProgressService.js';
import { createProtectedExamClient } from '../src/lib/protectedExamClient.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [app, css, dashboard, resultPage, edgeErrors, migration] = await Promise.all([
  read('src/App.jsx'), read('src/styles/global.css'),
  read('src/components/trainer/TrainerDashboardPage.jsx'),
  read('src/components/exam/ProtectedExamRunner.jsx'),
  read('supabase/functions/certsim-protected-exam/errors.ts'),
  read('supabase/migrations/20260903084553_p0_production_recovery_52_57.sql'),
]);

const summaries = { ai901: {
  completedCount: 2, scoredCount: 2, passedCount: 2, needsReviewCount: 0,
  latest: { attemptId: 'latest', completedAt: '2026-09-02T00:00:00Z', score: 45, percentage: 90 },
  best: { attemptId: 'best', completedAt: '2026-09-01T00:00:00Z', score: 49, percentage: 98 },
  averageScore: 47, averagePercentage: 94, weakDomains: {},
} };
const [row] = applyHistorySummaries([{ examScopeKey: 'ai901' }], summaries);
assert.deepEqual([row.latestScore, row.bestScore, row.averageScore, row.passRate], [90, 98, 94, 100]);
assert.notEqual(row.readinessStatus, 'at-risk');
const snapshot = buildStudentProgressSnapshot({ authUser: { id: 'learner' }, historySummaries: summaries });
assert.deepEqual([snapshot.progress.latestScore, snapshot.progress.bestScore, snapshot.progress.averageScore], [90, 98, 94]);

const mixed = {
  short: { ...summaries.ai901, scoredCount: 1, averageScore: 45, averagePercentage: 90 },
  long: { ...summaries.ai901, scoredCount: 1, averageScore: 72, averagePercentage: 80 },
};
assert.equal(buildStudentProgressSnapshot({ authUser: { id: 'learner' }, historySummaries: mixed }).progress.averageScore, 85);

assert.match(dashboard, /Boolean\(trainerFilters\.organisationId\)/);
assert.match(dashboard, /scopeOptions\.organisations\?\.\[0\]\?\.id/);
assert.match(edgeErrors, /scope_required: 400/);
assert.match(app, /dataset\.routeFocusTarget/);
assert.match(css, /\[data-route-focus-target='true'\]:focus/);
assert.doesNotMatch(css, /(?:^|,)\s*(?:h1|h2):focus[^\{]*\{[^}]*outline:\s*none/mi);
for (const label of ['Percentage', 'Scaled score', 'Raw points', 'Answered', 'Pass mark', 'Performance by domain']) assert.match(resultPage, new RegExp(label));
assert.match(resultPage, /View released review/);
assert.match(resultPage, /requireProtectedAuthoritativeResult/);

for (const signature of ['list_flags\\(uuid,uuid\\)', 'set_flag\\(uuid,uuid,uuid,boolean,uuid\\)', 'report_question_issue\\(uuid,uuid,uuid,text,uuid\\)']) assert.match(migration, new RegExp(signature));
assert.match(migration, /grant execute[\s\S]*to service_role/);
assert.doesNotMatch(migration, /grant execute[\s\S]*to (?:public|anon|authenticated)/i);
assert.match(migration, /purpose='self_directed_exam'[\s\S]*release_status='withheld'/);
assert.doesNotMatch(migration, /delete\s+from|update\s+exam_delivery\.attempt_results|update\s+public\.exam_results/i);

const mappedErrors = [];
for (const [code, status] of [['stale_response', 409], ['attempt_expired', 409], ['invalid_lifecycle_transition', 409], ['scope_required', 400]]) {
  const client = createProtectedExamClient({ accessToken: 'synthetic', fetchImpl: async () => ({ ok: false, status, json: async () => ({ error: { code } }) }) });
  await assert.rejects(client.listFlags('attempt'), (error) => {
    mappedErrors.push(error.code);
    return error.code === code && error.httpStatus === status && !/protected exam request failed/i.test(error.message);
  });
}
assert.deepEqual(mappedErrors, ['stale_response', 'attempt_expired', 'invalid_lifecycle_transition', 'scope_required']);

console.log(JSON.stringify({ ok: true, issues: [53, 54, 55, 56, 57], scoreUnits: 'percentage' }));
