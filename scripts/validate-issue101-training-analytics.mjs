import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../supabase/migrations/20260907152537_issue101_authoritative_trainer_analytics.sql', import.meta.url), 'utf8');
const boundedMigration = readFileSync(new URL('../supabase/migrations/20260907175904_issue101_bounded_training_dashboard_learners.sql', import.meta.url), 'utf8');
const mapper = readFileSync(new URL('../supabase/functions/certsim-protected-exam/responses.ts', import.meta.url), 'utf8');
const hook = readFileSync(new URL('../src/hooks/useTrainerAnalytics.js', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../src/components/trainer/TrainerDashboardPage.jsx', import.meta.url), 'utf8');

for (const required of [
  "attempt.status = 'completed'",
  "attempt.analytics_eligible",
  "attempt.purpose in ('assigned_assessment','self_directed_exam')",
  "classified.purpose in ('assigned_assessment','self_directed_exam')",
  "sum(coalesce((domain.value->>'earnedPoints')::numeric, 0))",
  "sum(coalesce((domain.value->>'maxPoints')::numeric, 0))",
  'sum(coalesce(row.raw_score,0))*100.0/sum(coalesce(row.max_score,0))',
  "set search_path = ''",
  "set statement_timeout = '12s'",
  'revoke execute on function exam_delivery.staff_dashboard_aggregates(uuid,jsonb) from public, anon, authenticated, service_role',
]) assert.ok(migration.includes(required), `Missing Issue #101 contract: ${required}`);

assert.ok(mapper.includes('rawEarnedPoints: normalizeNonNegativeNumber(domain.rawEarnedPoints)'));
assert.ok(mapper.includes('rawMaximumPoints: normalizeNonNegativeNumber(domain.rawMaximumPoints)'));
assert.ok(hook.includes('rawEarnedPoints: domain.rawEarnedPoints ?? null'));
assert.ok(dashboard.includes('number < 100 && Math.round(number) === 100'));

for (const required of [
  'staff_dashboard_learner_page',
  "v_size integer := coalesce(nullif(p_request->>'learnerPageSize','')::integer, 25)",
  "v_size < 1 or v_size > 50",
  "lower(display_name),learner_id,exam_key",
  "'membershipId',membership_id",
  "'assignmentSummaries'",
  "'filteredCount',(select count(*) from candidates)",
  "p_full - 'learners' - 'assignmentLearners'",
  "'readinessSummary'",
  "'activitySummary'",
  "v_page - 'learnerIds'",
  "set search_path = ''",
  "set statement_timeout = '12s'",
]) assert.ok(boundedMigration.includes(required), `Missing bounded Issue #101 contract: ${required}`);
assert.ok(mapper.includes('mapStaffLearnerPage'));
assert.ok(mapper.includes('returnedCount > pageSize'));
assert.ok(hook.includes('const boundedLearners = pageItems.map'));
assert.ok(dashboard.includes('<LearnerPageControls scope={scopedPerformance} />'));
assert.ok(dashboard.includes("onNavigateSection?.('detail', attemptId)"));
assert.ok(!dashboard.includes('const result = await loadResultDetail(attemptId)'));

const percentage = (rows) => rows.reduce((sum, row) => sum + row.earned, 0) * 100 /
  rows.reduce((sum, row) => sum + row.maximum, 0);
const oldAverage = (rows) => rows.reduce((sum, row) => sum + row.earned * 100 / row.maximum, 0) / rows.length;

const contradiction = [{ earned: 2, maximum: 3 }, { earned: 1, maximum: 1 }];
assert.equal(percentage(contradiction), 75);
assert.notEqual(Number(oldAverage(contradiction).toFixed(2)), 75);
const falseHundred = [{ earned: 199, maximum: 200 }];
assert.equal(Math.round(percentage(falseHundred)), 100);
assert.ok(percentage(falseHundred) < 100);
assert.equal(percentage([{ earned: 200, maximum: 200 }]), 100);

const purposes = ['assigned_assessment', 'self_directed_exam', 'study_sandbox', 'targeted_domain', 'weak_area', 'pbq_practice'];
assert.deepEqual(purposes.filter((purpose) => ['assigned_assessment', 'self_directed_exam'].includes(purpose)), ['assigned_assessment', 'self_directed_exam']);

const learners = Array.from({ length: 120 }, (_, learner) => ({
  learner,
  results: Array.from({ length: 8 }, (_, attempt) => ({
    purpose: attempt % 4 === 0 ? 'weak_area' : attempt % 3 === 0 ? 'assigned_assessment' : 'self_directed_exam',
    status: attempt === 7 ? 'in_progress' : 'completed',
    packageVersion: attempt % 2 ? '1.0.0' : '1.1.0',
    domain: attempt % 2 ? 'detect' : 'respond',
    earned: (learner + attempt) % 9,
    maximum: 10,
  })),
}));
const authoritative = learners.flatMap((row) => row.results).filter((row) =>
  row.status === 'completed' && ['assigned_assessment', 'self_directed_exam'].includes(row.purpose));
assert.equal(authoritative.length, 600);
assert.equal(new Set(authoritative.map((row) => row.packageVersion)).size, 2);
assert.ok(percentage(authoritative) >= 0 && percentage(authoritative) < 100);

const pageSize = 25;
const boundedPage = learners.slice(0, pageSize);
assert.equal(boundedPage.length, 25);
assert.equal(learners.length, 120);
assert.equal(Math.ceil(learners.length / pageSize), 5);

console.log(JSON.stringify({
  ok: true,
  fixtureLearners: learners.length,
  authoritativeAssessmentRows: authoritative.length,
  excludedPracticeOrIncompleteRows: 360,
  oldMultiSelectAverage: Number(oldAverage(contradiction).toFixed(2)),
  rawPointAverage: percentage(contradiction),
  falseHundredUnrounded: percentage(falseHundred),
  boundedPageSize: boundedPage.length,
  fullScopeTotal: learners.length,
}));
