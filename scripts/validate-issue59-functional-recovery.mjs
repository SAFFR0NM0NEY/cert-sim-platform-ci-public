import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createProtectedExamClient } from '../src/lib/protectedExamClient.js';
import {
  collectProtectedHistoryPages,
  matchResultsToAssignments,
} from '../src/lib/assignmentProgressService.js';
import { applyAuthoritativeAnalytics } from '../src/hooks/useTrainerAnalytics.js';
import { getTrainerAnalyticsSnapshot } from '../src/lib/trainerAnalyticsService.js';
import {
  normalizeExamScopeKey,
  percentageToComparableReadinessScore,
} from '../src/lib/examReadinessRules.js';
import { buildTrainerScopeRequest, mergeHistoryPages } from '../src/lib/trainerScopeService.js';
import { resolvePracticeRequest } from '../src/lib/protectedPracticeRequest.js';
import { buildAuthoritativeAssignmentProgress } from '../src/lib/examAssignmentService.js';
import {
  applyHistorySummaries,
  getStudentProgressAssignmentSnapshot,
} from '../src/lib/studentProgressService.js';

const [migration, runner, client, edgeHandler, edgeResponses, registry, profileService,
  assignmentProgress, analyticsHook, dashboard, app, studentProgressHook,
  studentProgressService, trainerScopeHook] = await Promise.all([
  read('supabase/migrations/20260903161929_issue_59_functional_recovery.sql'),
  read('src/components/exam/ProtectedExamRunner.jsx'),
  read('src/lib/protectedExamClient.js'),
  read('supabase/functions/certsim-protected-exam/handler.ts'),
  read('supabase/functions/certsim-protected-exam/responses.ts'),
  read('src/exams/examRegistry.protected.js'),
  read('src/lib/profileService.js'),
  read('src/lib/assignmentProgressService.js'),
  read('src/hooks/useTrainerAnalytics.js'),
  read('src/components/trainer/TrainerDashboardPage.jsx'),
  read('src/App.jsx'),
  read('src/hooks/useStudentProgress.js'),
  read('src/lib/studentProgressService.js'),
  read('src/hooks/useTrainerScope.js'),
]);

for (const token of [
  'source_assignment_id uuid references public.exam_assignments(id) on delete restrict',
  'exam_entitlements_source_assignment_profile_unique',
  'reconcile_assignment_entitlements',
  'sync_exam_assignment_entitlements',
  'sync_profile_activation_assignments',
  'learner_weak_domain_evidence',
  "when 'securityplus' then 'securityplussy0701'",
  "interval '365 days'",
  "p.status = 'active'",
  'staff_dashboard_aggregates',
  "attempt.source_assignment_id is null",
  "attempt.purpose in ('assigned_assessment','self_directed_exam')",
  'profileComposition',
  'abandon_attempt',
  'protected_question_reports',
]) assert.ok(migration.includes(token), `missing Issue #59 migration contract: ${token}`);

const assignmentContext = '15000000-0000-4000-8000-000000000001';
assert.deepEqual(resolvePracticeRequest({ assignmentId: assignmentContext, practiceRequest: {
  purpose: 'self_directed_exam', includePbqs: true, mixStrategy: 'balanced', language: 'csharp',
} }), { request: { purpose: 'self_directed_exam', includePbqs: true, mixStrategy: 'balanced', language: 'csharp', assignmentId: assignmentContext }, error: null });
assert.equal(resolvePracticeRequest({ assignmentId: assignmentContext, practiceRequest: {
  purpose: 'self_directed_exam', assignmentId: '16000000-0000-4000-8000-000000000001',
} }).error?.code, 'binding_mismatch');
assert.equal(resolvePracticeRequest({ assignmentId: assignmentContext, practiceRequest: {
  purpose: 'weak_area', assignmentId: assignmentContext,
} }).request.assignmentId, undefined);
assert.match(migration, /start_practice_issue59_attribution_base/);
assert.match(migration, /v_existing\.source_assignment_id=v_assignment_id/);
assert.match(migration, /v_existing\.source_assignment_id is null/);
assert.match(migration, /'assignmentId',v\.source_assignment_id/);
assert.match(migration, /learnersWithActivity'.*activity_count > 0/s);
assert.match(migration, /decided_count > 0 then passed_count\*100\.0\/decided_count/);

assert.doesNotMatch(migration, /update\s+exam_delivery\.attempt_results|delete\s+from\s+(exam_delivery\.attempts|exam_delivery\.attempt_results|public\.exam_results)/i);
assert.match(runner, /purpose:\s*'self_directed_exam'/);
assert.match(runner, /End this attempt\?/);
assert.match(runner, /client\.abandonAttempt/);
assert.doesNotMatch(runner, /Exit and resume later/);
assert.match(client, /abandonAttempt:/);
assert.match(edgeHandler, /matched\.id === "abandon"/);
assert.match(edgeResponses, /mapAbandonedAttempt/);
assert.match(edgeResponses, /profileComposition/);
assert.match(registry, /supportsStudySandbox:\s*true/);
assert.match(registry, /supportsTargetedPractice:\s*true/);
assert.match(profileService, /getCurrentProfile\(user\)/);
assert.match(profileService, /getCurrentMemberships\(user\)/);
assert.match(assignmentProgress, /getMyProtectedAssignmentHistory/);
assert.match(assignmentProgress, /MAX_PROTECTED_HISTORY_PAGES/);
assert.match(analyticsHook, /completeScopeAnalytics/);
assert.match(dashboard, /completeScopeAnalytics:\s*scopedPerformance\.analytics/);
assert.match(app, /learnerAssignmentId/);
assert.match(app, /getRouteTargetForPath\(window\.location\.pathname, window\.location\.search\)/);
assert.match(app, /\?assignment=\$\{encodeURIComponent\(assignmentId\)\}/);
assert.match(app, /assignmentId=\{learnerAssignmentId\}/);
assert.doesNotMatch(runner, /window\.location\.search/);
assert.match(studentProgressHook, /identity:\s*authSession/);
assert.match(studentProgressHook, /userId:\s*authSession\.user\?\.id/);
assert.match(studentProgressService, /loadAssignmentProgress\(\{ identity, userId \}\)/);
assert.match(trainerScopeHook, /historyNextCursor/);
assert.match(trainerScopeHook, /loadMoreHistory/);
assert.match(dashboard, /Load more results/);
assert.match(migration, /prior\.package_version_id=v_attempt\.package_version_id/);
assert.match(migration, /v_assignment_continuation/);
assert.match(migration, /'code','assignment_conflict'/);
assert.match(runner, /Recovering your protected attempt/);
assert.match(runner, /language: configuredRequest\.language,[\s\S]*configuredRequest\.assignmentId/);
assert.match(migration, /old\.activation_kind = 'production'[\s\S]*new\.activation_kind = 'production'/);
assert.match(migration, /classify_legacy_result[\s\S]*learner_weak_domain_evidence/);
assert.match(migration, /target_domain and \(missed or weak_domain\)/);

for (const alias of ['security-plus', 'security-plus-sy0-701', 'securityplussy0701']) {
  assert.equal(normalizeExamScopeKey(alias), 'security-plus-sy0-701');
}
assert.equal(percentageToComparableReadinessScore(90), 900);
assert.equal(percentageToComparableReadinessScore(64), 640);

const [readySummary] = applyHistorySummaries([{ examScopeKey: 'az204' }], {
  az204: {
    averagePercentage: 90,
    best: { percentage: 98 },
    completedCount: 5,
    latest: { percentage: 90, completedAt: '2026-01-05T00:00:00Z' },
    needsReviewCount: 0,
    passedCount: 5,
    weakDomains: [{ domainId: 'one', percentage: 75 }],
  },
});
assert.equal(readySummary.averageScore, 90, 'learner display must remain percentage based');
assert.equal(readySummary.bestScore, 98);
assert.equal(readySummary.readinessStatus, 'ready');

const [atRiskSummary] = applyHistorySummaries([{ examScopeKey: 'az204' }], {
  az204: {
    averagePercentage: 64,
    best: { percentage: 70 },
    completedCount: 5,
    latest: { percentage: 64, completedAt: '2026-01-05T00:00:00Z' },
    needsReviewCount: 1,
    passedCount: 4,
    weakDomains: [],
  },
});
assert.equal(atRiskSummary.averageScore, 64);
assert.equal(atRiskSummary.readinessStatus, 'at-risk');

const resolvedIdentity = { memberships: [{ role: 'student', status: 'active' }] };
let receivedAssignmentIdentity = null;
const enrichedProgress = await getStudentProgressAssignmentSnapshot({
  baseSnapshot: { results: [], student: { userId: 'learner-1' } },
  identity: resolvedIdentity,
  userId: 'learner-1',
  loadAssignmentProgress: async (request) => {
    receivedAssignmentIdentity = request;
    return {
      ok: true,
      data: {
        assignments: [{ id: 'assignment-1', examKey: 'az204', studentUserId: 'learner-1' }],
        summary: { total: 1, 'not-started': 1 },
      },
    };
  },
});
assert.equal(enrichedProgress.ok, true);
assert.deepEqual(receivedAssignmentIdentity, { identity: resolvedIdentity, userId: 'learner-1' });
assert.equal(enrichedProgress.data.assignmentLoadWarning, '');
assert.equal(enrichedProgress.data.assignments.length, 1);

const firstHistoryPage = Array.from({ length: 50 }, (_, index) => ({ attemptId: `attempt-${index}` }));
const secondHistoryPage = Array.from({ length: 38 }, (_, index) => ({ attemptId: `attempt-${index + 50}` }));
assert.equal(mergeHistoryPages(firstHistoryPage, secondHistoryPage).length, 88);
assert.throws(
  () => mergeHistoryPages(firstHistoryPage, [{ attemptId: 'attempt-49' }]),
  /duplicate or malformed/,
);

const serializedHistoryScope = buildTrainerScopeRequest({
  organisationId: 'org-1', examKey: 'az204', workflow: 'results', cursor: 'C1', ignored: 'no',
});
assert.deepEqual(serializedHistoryScope, {
  organisationId: 'org-1', examKey: 'az204', workflow: 'results', cursor: 'C1',
});
let requestedDashboardUrl = '';
const paginationClient = createProtectedExamClient({
  accessToken: 'synthetic-token',
  fetchImpl: async (url) => {
    requestedDashboardUrl = String(url);
    return { ok: true, status: 200, json: async () => ({ history: { items: secondHistoryPage, nextCursor: null } }) };
  },
});
await paginationClient.getStaffDashboardQuery({ ...serializedHistoryScope, pageSize: 50 });
assert.match(requestedDashboardUrl, /cursor=C1/);
assert.match(requestedDashboardUrl, /organisationId=org-1/);
assert.match(requestedDashboardUrl, /examKey=az204/);
assert.match(requestedDashboardUrl, /workflow=results/);
assert.equal(mergeHistoryPages(firstHistoryPage, secondHistoryPage).length, 88);
const serializedAssignmentScope = buildTrainerScopeRequest({
  organisationId: 'org-1', workflow: 'assignments', cursor: 'A1', pageSize: 999,
});
await paginationClient.getStaffDashboardQuery({ ...serializedAssignmentScope, pageSize: 50 });
assert.match(requestedDashboardUrl, /cursor=A1/);
assert.match(requestedDashboardUrl, /workflow=assignments/);
assert.doesNotMatch(requestedDashboardUrl, /pageSize=999/);

let readCalls = 0;
const retryingReadClient = createProtectedExamClient({
  accessToken: 'synthetic-token',
  fetchImpl: async (_url, options) => {
    readCalls += 1;
    assert.equal(options.method, 'GET');
    return readCalls === 1
      ? { ok: false, status: 503, json: async () => ({ error: { code: 'internal_failure' } }) }
      : { ok: true, status: 200, json: async () => ({ items: [] }) };
  },
});
await retryingReadClient.listHistory();
assert.equal(readCalls, 2, 'a transient read may retry exactly once');

let deniedReadCalls = 0;
const deniedReadClient = createProtectedExamClient({
  accessToken: 'synthetic-token',
  fetchImpl: async () => {
    deniedReadCalls += 1;
    return { ok: false, status: 401, json: async () => ({ error: { code: 'unauthenticated' } }) };
  },
});
await assert.rejects(() => deniedReadClient.listHistory(), /session has expired/i);
assert.equal(deniedReadCalls, 1, 'authentication failures must not retry');

let mutationCalls = 0;
const mutationClient = createProtectedExamClient({
  accessToken: 'synthetic-token',
  fetchImpl: async () => {
    mutationCalls += 1;
    return { ok: false, status: 503, json: async () => ({ error: { code: 'internal_failure' } }) };
  },
});
await assert.rejects(
  () => mutationClient.replacePractice({ clientRequestId: 'synthetic' }),
  /protected exam request failed/i,
);
assert.equal(mutationCalls, 1, 'mutations must never be automatically retried');
assert.equal((runner.match(/client\.replacePractice\(configuredRequest/g) ?? []).length, 1,
  'language replacement must issue at most one mutation');

const historyPages = [
  { items: Array.from({ length: 50 }, (_, index) => ({ attemptId: `page-1-${index}` })), nextCursor: 'next-50' },
  { items: [{ attemptId: 'assignment-completion', assignmentId: 'assignment-1', examKey: 'az204' }], nextCursor: null },
];
const collected = await collectProtectedHistoryPages({
  listHistory: async ({ cursor }) => historyPages[cursor ? 1 : 0],
});
assert.equal(collected.complete, true);
assert.equal(collected.items.length, 51, 'assignment enrichment must continue beyond the first 50 rows');

const assignment = { id: 'assignment-1', examKey: 'az204', studentUserId: 'learner-1', createdAt: '2026-01-01T00:00:00Z' };
const [matched] = matchResultsToAssignments([assignment], [{
  attemptId: 'attempt-1', assignmentId: 'assignment-1', examKey: 'az204', userId: 'learner-1', submittedAt: '2026-01-02T00:00:00Z',
}], []);
assert.equal(matched.progressStatus, 'completed', 'explicit protected assignment provenance must produce Attempted status');

const [securityMatched] = matchResultsToAssignments([{
  id: 'security-assignment', examKey: 'security-plus', studentUserId: 'learner-1', createdAt: '2026-01-01T00:00:00Z',
}], [{
  attemptId: 'security-attempt', assignmentId: 'security-assignment', examKey: 'securityplussy0701',
  userId: 'learner-1', submittedAt: '2026-01-02T00:00:00Z',
}], []);
assert.equal(securityMatched.progressStatus, 'completed', 'all Security+ aliases must share assignment completion scope');

const aggregate = applyAuthoritativeAnalytics({ readinessSummary: [
  { id: 'ready' }, { id: 'almost-ready' }, { id: 'needs-review' }, { id: 'at-risk' }, { id: 'insufficient-data' }, { id: 'not-started' },
], totals: {} }, {
  scopeComplete: true,
  totals: { historicalActivity: 75, visibleLearners: 1 },
  learners: [{ learnerId: 'learner-1', examKey: 'az204', activityCount: 75, assessmentCount: 75, historicalCount: 0, needsReviewCount: 0, latestActivity: '2026-01-02T00:00:00Z', latestPercentage: 90, bestPercentage: 95, averagePercentage: 88, passRate: 100, domains: [{ domainKey: 'compute', averagePercentage: 82, sampleCount: 75 }] }],
  exams: [{ examKey: 'az204', assessmentCount: 75, assessedLearnerCount: 1, averagePercentage: 88, passRate: 100, bestPercentage: 95, lowestPercentage: 75, historicalCount: 0, needsReviewCount: 0 }],
  groups: [{ groupId: 'group-1', assessmentCount: 75, assessedLearnerCount: 1, averagePercentage: 88, passRate: 100, domains: [{ examKey: 'az204', domainKey: 'compute', sampleCount: 75, studentCount: 0, weakCount: 0, averagePercentage: 82 }] }],
  assignments: [{ assignmentId: 'assignment-1', assessmentCount: 75, assessedLearnerCount: 1, averagePercentage: 88, passRate: 100, needsReviewCount: 0 }],
  assignmentLearners: [{ assignmentId: 'assignment-1', learnerId: 'learner-1', assignmentAttemptCount: 75 }],
  domains: [{ examKey: 'az204', domainKey: 'compute', sampleCount: 75, studentCount: 0, weakCount: 0, averagePercentage: 82 }],
}, [{ userId: 'learner-1', groupId: 'group-1', status: 'active' }], [{ id: 'group-1', name: 'G' }], [{ id: 'assignment-1', examKey: 'az204', totalStudents: 1 }]);
assert.equal(aggregate.studentReadiness[0].readinessStatus, 'ready');
assert.equal(aggregate.groupAnalytics[0].totalAttempts, 75);
assert.equal(aggregate.assignmentReadiness[0].submittedCount, 1);
assert.equal(aggregate.weakAreaAnalytics.domainPerformance[0].attemptCount, 75);

const parityStudent = { userId: 'learner-parity', groupId: 'group-parity', groupName: 'Parity', status: 'active' };
const parityAssignment = {
  id: 'assignment-parity', examKey: 'az204', examTitle: 'AZ-204', groupId: 'group-parity',
  totalStudents: 1, createdAt: '2026-01-01T00:00:00Z', targetStudents: [parityStudent],
};
const parityResults = Array.from({ length: 5 }, (_, index) => ({
  attemptId: `parity-${index}`,
  assignmentId: 'assignment-parity',
  userId: 'learner-parity',
  examKey: 'az204',
  examTitle: 'AZ-204',
  purpose: 'assigned_assessment',
  scaledScore: 900,
  rawPercentage: 90,
  passed: true,
  submittedAt: `2026-01-0${index + 2}T00:00:00Z`,
  domainBreakdown: {
    weighted: index === 0
      ? { earnedPoints: 1, maxPoints: 2, percentage: 50 }
      : { earnedPoints: 8, maxPoints: 8, percentage: 100 },
    weak: { earnedPoints: 3, maxPoints: 5, percentage: 60 },
  },
}));
const parityBaseline = getTrainerAnalyticsSnapshot({
  assignments: [parityAssignment],
  groups: [{ id: 'group-parity', name: 'Parity' }],
  results: parityResults,
  students: [parityStudent],
});
const parityAggregate = applyAuthoritativeAnalytics(parityBaseline, {
  scopeComplete: true,
  totals: { historicalActivity: 5, visibleLearners: 1 },
  learners: [{
    learnerId: 'learner-parity', examKey: 'az204', activityCount: 5,
    assessmentCount: 5, historicalCount: 0, needsReviewCount: 0, passedCount: 5,
    latestActivity: '2026-01-06T00:00:00Z', latestPercentage: 90,
    bestPercentage: 90, lowestPercentage: 90, averagePercentage: 90, passRate: 100,
    domains: [
      { domainKey: 'weighted', averagePercentage: 90, sampleCount: 5 },
      { domainKey: 'weak', averagePercentage: 60, sampleCount: 5 },
    ],
  }],
  exams: [{ examKey: 'az204', assessmentCount: 5, assessedLearnerCount: 1, averagePercentage: 90, passRate: 100, bestPercentage: 90, lowestPercentage: 90, historicalCount: 0, needsReviewCount: 0 }],
  groups: [{ groupId: 'group-parity', assessmentCount: 5, assessedLearnerCount: 1, averagePercentage: 90, passRate: 100, domains: [{ examKey: 'az204', domainKey: 'weak', sampleCount: 5, studentCount: 1, weakCount: 5, averagePercentage: 60 }] }],
  assignments: [{ assignmentId: 'assignment-parity', assessmentCount: 5, assessedLearnerCount: 1, averagePercentage: 90, passRate: 100, needsReviewCount: 0 }],
  assignmentLearners: [{ assignmentId: 'assignment-parity', learnerId: 'learner-parity', assignmentAttemptCount: 5 }],
  domains: [
    { examKey: 'az204', domainKey: 'weighted', sampleCount: 5, studentCount: 0, weakCount: 0, averagePercentage: 90 },
    { examKey: 'az204', domainKey: 'weak', sampleCount: 5, studentCount: 1, weakCount: 5, averagePercentage: 60 },
  ],
}, [parityStudent], [{ id: 'group-parity', name: 'Parity' }], [parityAssignment]);
assert.equal(parityAggregate.studentReadiness[0].readinessStatus, parityBaseline.studentReadiness[0].readinessStatus);
assert.equal(parityAggregate.studentReadiness[0].domainAverages[1].averagePercentage, 90);
assert.equal(parityAggregate.examAnalytics[0].totalAttempts, parityBaseline.examAnalytics[0].totalAttempts);
assert.equal(parityAggregate.groupAnalytics[0].totalAttempts, parityBaseline.groupAnalytics[0].totalAttempts);
assert.equal(parityAggregate.assignmentReadiness[0].submittedCount, parityBaseline.assignmentReadiness[0].submittedCount);
assert.equal(parityAggregate.weakAreaAnalytics.commonWeakAreas[0].occurrences, 5);
assert.equal(parityAggregate.activityAnalytics.mostActiveStudents[0].totalAttempts, parityBaseline.activityAnalytics.mostActiveStudents[0].totalAttempts);

const adversarialStudents = [
  { userId: 'learner-a', groupId: 'group-a', groupName: 'Group A', status: 'active' },
  { userId: 'learner-b', groupId: 'group-a', groupName: 'Group A', status: 'active' },
  { userId: 'learner-c', groupId: 'group-a', groupName: 'Group A', status: 'active' },
];
const adversarialAssignments = [
  { id: 'new-az204', examKey: 'az204', examTitle: 'AZ-204', groupId: 'group-a', totalStudents: 3,
    createdAt: '2026-08-01T00:00:00Z', targetStudents: adversarialStudents },
  { id: 'new-ai901', examKey: 'ai901', examTitle: 'AI-901', groupId: 'group-a', totalStudents: 3,
    createdAt: '2026-08-01T00:00:00Z', dueAt: '2026-08-15T00:00:00Z', targetStudents: adversarialStudents },
];
const adversarialResults = [
  ...Array.from({ length: 64 }, (_, index) => ({
    attemptId: `a-${index}`, assignmentId: 'new-az204', userId: 'learner-a', examKey: 'az204', examTitle: 'AZ-204',
    purpose: 'self_directed_exam', scaledScore: 900, rawPercentage: 90, passed: true,
    submittedAt: `2026-07-${String((index % 28) + 1).padStart(2, '0')}T${String(index % 24).padStart(2, '0')}:00:00Z`,
    domainBreakdown: { lowest: { percentage: 75 }, strongest: { percentage: 90 } },
  })),
  { attemptId: 'b-assigned', assignmentId: 'new-az204', userId: 'learner-b', examKey: 'az204', examTitle: 'AZ-204',
    purpose: 'self_directed_exam', scaledScore: 720, rawPercentage: 72, passed: true,
    submittedAt: '2026-08-02T00:00:00Z', domainBreakdown: { lowest: { percentage: 60 }, strongest: { percentage: 90 } } },
];
const adversarialBaseline = getTrainerAnalyticsSnapshot({
  assignments: adversarialAssignments, groups: [{ id: 'group-a', name: 'Group A' }],
  results: adversarialResults, students: adversarialStudents,
});
const adversarialAuthoritative = applyAuthoritativeAnalytics(adversarialBaseline, {
  scopeComplete: true,
  totals: { historicalActivity: 65, visibleLearners: 3 },
  learners: [
    { learnerId: 'learner-a', examKey: 'az204', activityCount: 64, assessmentCount: 64, historicalCount: 0,
      needsReviewCount: 0, passedCount: 64, latestActivity: '2026-07-28T06:00:00Z', latestAttemptId: 'a-63',
      latestPercentage: 90, bestPercentage: 90, averagePercentage: 90, passRate: 100,
      domains: [{ domainKey: 'lowest', averagePercentage: 75, sampleCount: 64 }, { domainKey: 'strongest', averagePercentage: 90, sampleCount: 64 }] },
    { learnerId: 'learner-b', examKey: 'az204', activityCount: 1, assessmentCount: 1, historicalCount: 0,
      needsReviewCount: 0, passedCount: 1, latestActivity: '2026-08-02T00:00:00Z', latestAttemptId: 'b-assigned',
      latestPercentage: 72, bestPercentage: 72, averagePercentage: 72, passRate: 100,
      domains: [{ domainKey: 'lowest', averagePercentage: 60, sampleCount: 1 }, { domainKey: 'strongest', averagePercentage: 90, sampleCount: 1 }] },
    { learnerId: 'learner-c', examKey: 'az204', activityCount: 5, assessmentCount: 5, historicalCount: 0,
      needsReviewCount: 0, passedCount: 5, latestActivity: '2026-07-20T00:00:00Z', latestAttemptId: 'c-older',
      latestPercentage: 90, bestPercentage: 95, averagePercentage: 90, passRate: 100, domains: [] },
    ...adversarialStudents.map((student) => ({ learnerId: student.userId, examKey: 'ai901', activityCount: 0,
      assessmentCount: 0, historicalCount: 0, needsReviewCount: 0, passedCount: 0, latestActivity: null,
      latestAttemptId: null, latestPercentage: null, bestPercentage: null, averagePercentage: null, passRate: null, domains: [] })),
  ],
  exams: [{ examKey: 'az204', assessmentCount: 65, assessedLearnerCount: 2, averagePercentage: 89.72,
    passRate: 100, bestPercentage: 90, lowestPercentage: 72, historicalCount: 0, needsReviewCount: 1 }],
  groups: [{ groupId: 'group-a', assessmentCount: 65, assessedLearnerCount: 2, averagePercentage: 89.72,
    passRate: 100, domains: [{ examKey: 'az204', domainKey: 'lowest', sampleCount: 65, studentCount: 1, weakCount: 1, averagePercentage: 74.77 }] }],
  assignments: [{ assignmentId: 'new-az204', assessmentCount: 65, assessedLearnerCount: 2, averagePercentage: 89.72, passRate: 100, needsReviewCount: 0 },
    { assignmentId: 'new-ai901', assessmentCount: 0, assessedLearnerCount: 0, averagePercentage: null, passRate: null, needsReviewCount: 0 }],
  assignmentLearners: [
    ...adversarialStudents.map((student) => ({ assignmentId: 'new-az204', learnerId: student.userId,
      assignmentAttemptCount: student.userId === 'learner-a' ? 64 : student.userId === 'learner-b' ? 1 : 0,
      latestAssignmentAttemptId: student.userId === 'learner-a' ? 'a-63' : student.userId === 'learner-b' ? 'b-assigned' : null })),
    ...adversarialStudents.map((student) => ({ assignmentId: 'new-ai901', learnerId: student.userId, assignmentAttemptCount: 0 })),
  ],
  domains: [{ examKey: 'az204', domainKey: 'lowest', sampleCount: 65, studentCount: 1, weakCount: 1, averagePercentage: 74.77 }],
}, adversarialStudents, [{ id: 'group-a', name: 'Group A' }], adversarialAssignments);
const learnerA = adversarialAuthoritative.studentReadiness.find((row) => row.userId === 'learner-a' && row.examScopeKey === 'az204');
const learnerC = adversarialAuthoritative.studentReadiness.find((row) => row.userId === 'learner-c' && row.examScopeKey === 'ai901');
assert.equal(learnerA.readinessStatus, adversarialBaseline.studentReadiness.find((row) => row.userId === 'learner-a' && row.examScopeKey === 'az204').readinessStatus);
assert.equal(learnerA.activityAttemptCount, 64);
assert.equal(learnerA.latestAttemptId, 'a-63');
assert.equal(learnerA.weakestDomain.averagePercentage, 75);
assert.equal(learnerA.weakDomains.length, 0);
assert.equal(learnerA.assignmentSummaries[0].status, 'submitted');
assert.equal(adversarialAuthoritative.studentReadiness.find((row) => row.userId === 'learner-c' && row.examScopeKey === 'az204').assignmentSummaries[0].status, 'not-started');
assert.equal(learnerC.readinessStatus, 'at-risk');
assert.equal(adversarialAuthoritative.assignmentReadiness[0].submittedCount, 2);
assert.equal(adversarialAuthoritative.assignmentReadiness[0].notStartedCount, 1);
assert.equal(adversarialAuthoritative.examAnalytics[0].needsReviewCount, 1, 'a passing 72% remains an analytics needs-review indicator');
assert.ok(adversarialAuthoritative.groupAnalytics[0].completionRate <= 100);

const assignmentDetail = buildAuthoritativeAssignmentProgress(adversarialAssignments[0], adversarialStudents, {
  learners: adversarialAuthoritative.studentReadiness.filter((row) => row.examScopeKey === 'az204').map((row) => ({
    learnerId: row.userId, examKey: 'az204', assessmentCount: row.scopedAttemptCount,
    averagePercentage: row.averageScore == null ? null : row.averageScore / 10,
    bestPercentage: row.bestScore == null ? null : row.bestScore / 10,
    latestPercentage: row.latestScore == null ? null : row.latestScore / 10,
    latestActivity: row.latestAttemptDate, latestAttemptId: row.latestAttemptId,
    needsReviewCount: 0, passRate: row.passRate, domains: row.domainAverages,
  })),
  assignments: [{ assignmentId: 'new-az204', totalStudents: 3, assessmentCount: 65, averagePercentage: 89.72 }],
  assignmentLearners: adversarialStudents.map((student) => ({
    assignmentId: 'new-az204', learnerId: student.userId,
    assignmentAttemptCount: student.userId === 'learner-a' ? 64 : student.userId === 'learner-b' ? 1 : 0,
    latestAssignmentAttemptId: student.userId === 'learner-a' ? 'a-63' : student.userId === 'learner-b' ? 'b-assigned' : null,
  })),
});
assert.equal(assignmentDetail.totalStudents, 3);
assert.equal(assignmentDetail.assessmentCount, 65);
assert.equal(assignmentDetail.submittedCount, 2);
assert.equal(assignmentDetail.notStartedCount, 1);
assert.equal(assignmentDetail.studentRows.find((row) => row.userId === 'learner-a').assignmentAttemptCount, 64);
assert.equal(assignmentDetail.studentRows.find((row) => row.userId === 'learner-b').latestAttemptId, 'b-assigned');

console.log(JSON.stringify({
  ok: true,
  issue: 59,
  assignmentProvenance: true,
  canonicalSecurityPlusIdentity: true,
  completeBoundedAnalytics: true,
  serverAuthoritativeAbandon: true,
  protectedPractice: true,
  boundedReadRetry: true,
  mutationRetry: false,
  assignmentRouteState: true,
  readinessUnits: 'percent-display/comparable-evaluation',
  staffHistoryPagination: true,
}));

async function read(relativePath) {
  return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}
