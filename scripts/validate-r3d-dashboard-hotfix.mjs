import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { composeTrainerDashboardSnapshot, dashboardSummaryValue } from '../src/lib/trainerDashboardSnapshot.js';

const ok = (data, pagination) => ({ ok: true, data, pagination });
const failed = (message) => ({ ok: false, message });
const complete = composeTrainerDashboardSnapshot({
  identity: { isPlatformOwner: true },
  groupsResult: ok([{ id: 'group' }]),
  studentsResult: ok([{ userId: 'student' }]),
  historyResult: ok([{ attemptId: 'protected' }, { attemptId: 'legacy' }], { hasMore: true, nextCursor: 'cursor', pageSize: 25, totalCount: 108 }),
  analyticsResult: ok({ scopeComplete: true, totals: { visibleLearners: 13 } }),
});
assert.equal(complete.groups.length, 1);
assert.equal(complete.students.length, 1);
assert.equal(complete.results.length, 2);
assert.equal(complete.resultsPagination.totalCount, 108);
assert.equal(complete.authoritativeAnalytics.totals.visibleLearners, 13);
assert.deepEqual(Object.values(complete.sectionErrors), ['', '', '', '']);

const partial = composeTrainerDashboardSnapshot({
  identity: { isPlatformOwner: true },
  groupsResult: ok([{ id: 'group' }]),
  studentsResult: failed('Students unavailable.'),
  historyResult: ok([{ attemptId: 'protected' }], { hasMore: false, nextCursor: null, pageSize: 25, totalCount: 1 }),
  analyticsResult: failed('Analytics unavailable.'),
});
assert.equal(partial.groups.length, 1);
assert.equal(partial.results.length, 1);
assert.equal(partial.students.length, 0);
assert.equal(partial.authoritativeAnalytics, null);
assert.equal(partial.sectionErrors.students, 'Students unavailable.');
assert.equal(partial.sectionErrors.analytics, 'Analytics unavailable.');
assert.equal(dashboardSummaryValue({ loading: false, error: partial.sectionErrors.students, value: 0 }), 'Unavailable');
assert.equal(dashboardSummaryValue({ loading: true, error: '', value: 0 }), 'Loading…');
assert.equal(dashboardSummaryValue({ loading: false, error: '', value: 0 }), 0);

const migration = await readFile(new URL('../supabase/migrations/20260901214515_r3d_staff_analytics_contract.sql', import.meta.url), 'utf8');
const edge = await readFile(new URL('../supabase/functions/certsim-protected-exam/responses.ts', import.meta.url), 'utf8');
const service = await readFile(new URL('../src/lib/trainerDashboardService.js', import.meta.url), 'utf8');
assert.match(migration, /count\(distinct learner_id\) filter\(where analytics_eligible\) assessed_learner_count/);
assert.match(migration, /count\(\*\) filter\(where analytics_eligible and not passed\) needs_review_count/);
assert.match(migration, /set search_path=''/);
assert.match(migration, /set statement_timeout='12s'/);
assert.match(migration, /grant execute on function exam_delivery\.staff_analytics\(uuid\) to service_role/);
assert.match(edge, /normalizeCount/);
assert.match(edge, /normalizePercentage/);
assert.match(service, /composeTrainerDashboardSnapshot/);
const analyticsMapper = edge.slice(edge.indexOf('export function mapStaffAnalytics'), edge.indexOf('export function mapHistorySummary'));
assert.doesNotMatch(analyticsMapper, /questionText|correctAnswer|protectedSnapshot|scoringRules/);
console.log('PASS R3D dashboard hotfix validation');
