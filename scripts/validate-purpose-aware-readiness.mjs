import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ASSESSMENT_ATTEMPT_PURPOSES,
  PRACTICE_ATTEMPT_PURPOSES,
  classifyAttempt,
  getAttemptKindLabel,
  isAssessmentResult,
} from '../src/lib/attemptPurpose.js';
import { buildExamProgressRows, normalizeProgressResult } from '../src/lib/examReadinessRules.js';
import { getTrainerAnalyticsSnapshot } from '../src/lib/trainerAnalyticsService.js';
import { appendUniqueHistory, paginateStableHistory } from '../src/lib/historyPagination.js';

const migration = await readFile(
  new URL('../supabase/migrations/20260901082946_purpose_aware_readiness_and_weak_area.sql', import.meta.url),
  'utf8',
);
const baseResult = {
  attemptId: 'assessment-1', userId: 'learner-1', examKey: 'az204',
  examTitle: 'AZ-204', submittedAt: '2026-01-02T00:00:00Z',
  scaledScore: 800, rawPercentage: 80, passed: true,
  domainBreakdown: { compute: { percentage: 80 } },
};

for (const purpose of ASSESSMENT_ATTEMPT_PURPOSES) {
  assert.equal(isAssessmentResult({ purpose }), true, purpose);
  assert.equal(classifyAttempt({ purpose }).kind, 'assessment');
}
for (const purpose of PRACTICE_ATTEMPT_PURPOSES) {
  assert.equal(isAssessmentResult({ purpose }), false, purpose);
  assert.equal(classifyAttempt({ purpose }).kind, 'practice');
  assert.equal(getAttemptKindLabel({ purpose }), 'Practice');
}
assert.equal(classifyAttempt({ modeLabel: 'Weak Area Practice' }).purpose, 'weak_area');
assert.equal(classifyAttempt({ modeLabel: 'Old full mock' }).kind, 'legacy-unclassified');
assert.equal(isAssessmentResult({ modeLabel: 'Old full mock' }), false);
assert.equal(getAttemptKindLabel({ modeLabel: 'Old full mock' }), 'Historical attempt (type unavailable)');

const mixedResults = [
  { ...baseResult, purpose: 'assigned_assessment' },
  ...PRACTICE_ATTEMPT_PURPOSES.map((purpose, index) => ({
    ...baseResult, attemptId: `practice-${index}`, purpose,
    submittedAt: `2026-01-0${index + 3}T00:00:00Z`, scaledScore: 100,
    rawPercentage: 10, passed: false,
    domainBreakdown: { compute: { percentage: 10 } },
  })),
];
const progress = buildExamProgressRows({ results: mixedResults.map(normalizeProgressResult) })[0];
assert.equal(progress.scopedAttemptCount, 1);
assert.equal(progress.latestAttemptId, 'assessment-1');
assert.equal(progress.bestScore, 800);
assert.equal(progress.passRate, 100);
assert.equal(progress.domainAverages[0].averagePercentage, 80);

const trainer = getTrainerAnalyticsSnapshot({
  results: mixedResults,
  students: [{ userId: 'learner-1', displayName: 'Learner', status: 'active' }],
});
assert.equal(trainer.totals.results, 1);
assert.equal(trainer.examAnalytics[0].totalAttempts, 1);
assert.equal(trainer.activityAnalytics.mostActiveStudents[0].totalAttempts, 1);

const productionShapedTrainer = getTrainerAnalyticsSnapshot({
  assignments: [{
    id: 'assignment-ai901', examKey: 'ai901', examTitle: 'AI-901', groupId: 'group-a',
    targetStudents: Array.from({ length: 7 }, (_, index) => ({ userId: `scope-${index + 1}`, groupId: 'group-a' })),
  }],
  students: Array.from({ length: 7 }, (_, index) => ({
    userId: `scope-${index + 1}`, displayName: `Learner ${index + 1}`, groupId: 'group-a', status: 'active',
  })),
  results: [
    { ...baseResult, attemptId: 'legacy-alias', userId: 'scope-1', examKey: 'AI-901', examTitle: 'AI-901', purpose: 'self_directed_exam', assignmentId: '' },
    { ...baseResult, attemptId: 'legacy-zero', userId: 'scope-2', examKey: 'ai901', examTitle: 'AI-901', purpose: 'self_directed_exam', assignmentId: '', scaledScore: 0, rawPercentage: 0, passed: false },
    { ...baseResult, attemptId: 'protected-self', userId: 'scope-3', examKey: 'ai901', examTitle: 'AI-901', purpose: 'self_directed_exam', assignmentId: '' },
    { ...baseResult, attemptId: 'protected-assigned', userId: 'scope-4', examKey: 'ai901', examTitle: 'AI-901', purpose: 'assigned_assessment', assignmentId: 'assignment-ai901' },
  ],
});
assert.equal(productionShapedTrainer.totals.students, 7);
assert.equal(productionShapedTrainer.totals.results, 4);
assert.equal(productionShapedTrainer.assignmentReadiness[0].submittedCount, 1);
assert.equal(productionShapedTrainer.assignmentReadiness[0].notStartedCount, 6);
assert.equal(productionShapedTrainer.studentReadiness.find((row) => row.userId === 'scope-1').scopedAttemptCount, 1);
assert.equal(productionShapedTrainer.studentReadiness.find((row) => row.userId === 'scope-2').latestScore, 0);

const history = mixedResults.map((item) => ({ ...item, completedAt: item.submittedAt }));
history.push({ ...baseResult, attemptId: 'legacy-unclassified', completedAt: '2026-01-01T00:00:00Z' });
const first = paginateStableHistory(history, null, 4);
const second = paginateStableHistory(history, first.nextCursor, 4);
assert.equal(appendUniqueHistory(first.items, second.items).length, history.length);
assert.ok(first.items.some((item) => item.purpose === 'weak_area'));

assert.equal((migration.match(/prior\.purpose in \('assigned_assessment','self_directed_exam'\)/g) ?? []).length, 2);
assert.match(migration, /a\.status='completed'[\s\S]+a\.purpose in \('assigned_assessment','self_directed_exam'\)/);
assert.doesNotMatch(migration, /delete\s+from|update\s+exam_delivery\.attempts|insert\s+into\s+exam_delivery\.attempts/i);
assert.doesNotMatch(migration, /grant\s+|revoke\s+|alter\s+table|create\s+policy/i);

console.log(JSON.stringify({ ok: true, assessmentPurposes: 2, practicePurposes: 4, historyPurposesRetained: 6 }));
