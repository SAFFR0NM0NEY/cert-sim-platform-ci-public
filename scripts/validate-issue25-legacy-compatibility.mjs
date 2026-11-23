import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { buildExamProgressRows, normalizeProgressResult } from '../src/lib/examReadinessRules.js';
import { aggregateWeakDomains } from '../src/lib/learnerAnalytics.js';
import { buildStudentProgressSnapshot } from '../src/lib/studentProgressService.js';
import { appendUniqueHistory } from '../src/lib/historyPagination.js';
import {
  normalizeProtectedHistoryResult,
  partitionProtectedHistory,
  validateProtectedHistoryPage,
} from '../src/lib/protectedHistory.js';

const migration = await readFile(
  new URL('../supabase/migrations/20260902170209_issue25_legacy_result_compatibility.sql', import.meta.url),
  'utf8',
);
const pageSource = await readFile(
  new URL('../src/protected/ProtectedSavedResultsPage.jsx', import.meta.url),
  'utf8',
);
const progressSource = await readFile(
  new URL('../src/lib/studentProgressService.js', import.meta.url),
  'utf8',
);

const historyItem = (attemptId, purpose, overrides = {}) => ({
  attemptId,
  examKey: 'az400',
  packageVersion: 'legacy',
  profileKey: 'az400-mvp-full-profile',
  purpose,
  actorClassification: null,
  completedAt: `2026-08-${attemptId.padStart(2, '0')}T10:00:00Z`,
  score: 40,
  percentage: 50,
  passed: false,
  domainSummary: {},
  serverAuthoritative: false,
  reviewStatus: 'withheld',
  source: 'legacy_authoritative',
  ...overrides,
});

const legacyAssessment = historyItem('01', 'self_directed_exam');
const legacyPractice = historyItem('02', 'weak_area');
const legacyPreview = historyItem('03', 'study_sandbox');
const legacyUnclassified = historyItem('04', 'unclassified', { percentage: null, score: null, passed: null });
const protectedAssessment = historyItem('05', 'assigned_assessment', {
  source: 'protected',
  serverAuthoritative: true,
  packageVersion: '1.0.0',
  percentage: 80,
  score: 64,
  passed: true,
  domainSummary: { delivery: { domain: 'Delivery', earnedPoints: 8, maxPoints: 10, percentage: 80 } },
});

const page = validateProtectedHistoryPage({
  items: [legacyAssessment, legacyPractice, legacyPreview, legacyUnclassified, protectedAssessment],
  returnedCount: 5,
  totalCount: 5,
  remainingCount: 0,
  nextCursor: null,
});
const normalized = page.items.map((item) => normalizeProtectedHistoryResult(item, 'learner-a'));
const partitioned = partitionProtectedHistory(normalized);
assert.deepEqual(partitioned.assessments.map(({ attemptId }) => attemptId), ['01', '05']);
assert.deepEqual(partitioned.practice.map(({ attemptId }) => attemptId), ['02', '03']);
assert.deepEqual(partitioned.historical.map(({ attemptId }) => attemptId), ['04']);
assert.equal(normalized.find(({ attemptId }) => attemptId === '04').rawPercentage, null);

const progress = buildExamProgressRows({
  results: normalized.map(normalizeProgressResult),
  students: [{ userId: 'learner-a' }],
});
assert.equal(progress[0].scopedAttemptCount, 2);
assert.equal(progress[0].latestScore, 800);
assert.equal(progress[0].bestScore, 800);
assert.equal(progress[0].averageScore, 650);
assert.equal(progress[0].passRate, 50);
assert.equal(progress[0].domainAverages.length, 1, 'Legacy overall scores without domains must not fabricate domain samples.');

assert.equal(appendUniqueHistory([legacyAssessment], [historyItem('06', 'self_directed_exam')]).length, 2);
assert.equal(appendUniqueHistory([legacyAssessment], [legacyAssessment]).length, 1);
assert.throws(() => validateProtectedHistoryPage({
  items: [{ ...legacyAssessment, serverAuthoritative: true }], returnedCount: 1,
  totalCount: 1, remainingCount: 0, nextCursor: null,
}), /invalid_history_authority/);

const jeanEquivalent = [
  ...Array.from({ length: 7 }, (_, index) => historyItem(`s${index}`, 'self_directed_exam', {
    examKey: index === 0 ? 'securityplussy0701' : 'security-plus-sy0-701',
    percentage: 60 + index,
    score: 60 + index,
    passed: index >= 3,
    domainSummary: index < 4 ? { architecture: { domain: 'Security Architecture', earnedPoints: 6, maxPoints: 10, percentage: 60 } } : {},
  })),
  ...Array.from({ length: 2 }, (_, index) => historyItem(`a${index}`, 'self_directed_exam', {
    examKey: 'ai901', percentage: 70 + index, score: 70 + index, passed: true,
    domainSummary: { ai: { domain: 'AI workloads', earnedPoints: 7, maxPoints: 10, percentage: 70 } },
  })),
  historyItem('z1', 'self_directed_exam', {
    examKey: 'az400', percentage: 80, score: 80, passed: true,
    domainSummary: { sourceControl: { domain: 'Source control', earnedPoints: 8, maxPoints: 10, percentage: 80 } },
  }),
  historyItem('p1', 'self_directed_exam', {
    examKey: 'az204', source: 'protected', serverAuthoritative: true,
    percentage: 90, score: 90, passed: true,
    domainSummary: { compute: { domain: 'Compute', earnedPoints: 9, maxPoints: 10, percentage: 90 } },
  }),
];
const jeanSnapshot = buildStudentProgressSnapshot({
  authUser: { id: 'learner-a', email: 'masked@example.invalid' },
  rawResults: jeanEquivalent.map((item) => normalizeProtectedHistoryResult(item, 'learner-a')),
});
assert.equal(jeanSnapshot.progress.totalSavedAttempts, 11);
assert.equal(jeanSnapshot.progress.examsAttemptedCount, 4);
assert.equal(jeanSnapshot.progress.domainSampleCount, 8, JSON.stringify(jeanSnapshot.examProgress.map((row) => [row.examScopeKey, row.scopedAttemptCount, row.domainSampleCount])));
assert.equal(jeanSnapshot.assessmentHistory.length, 11);
assert.equal(jeanSnapshot.examProgress.find((row) => row.examScopeKey === 'security-plus-sy0-701').scopedAttemptCount, 7);
assert.equal(jeanSnapshot.examProgress.find((row) => row.examScopeKey === 'security-plus-sy0-701').fullReadinessAvailable, true);
assert.equal(jeanSnapshot.examProgress.find((row) => row.examScopeKey === 'ai901').readinessStatus, 'insufficient-data');
assert.equal(jeanSnapshot.examProgress.find((row) => row.examScopeKey === 'ai901').scopedAttemptCount, 2);
assert.equal(aggregateWeakDomains(jeanEquivalent.filter((item) => item.examKey.includes('security'))).length, 1);

for (const marker of [
  'classify_legacy_result',
  "'self_directed_exam'",
  "'weak_area'",
  "'study_sandbox'",
  "'targeted_domain'",
  "'pbq_practice'",
  "'unclassified'",
  "a.status='submitted'",
  'p_raw_score is not null or p_raw_percentage is not null',
  "not exists(select 1 from exam_delivery.attempts",
  "set search_path=''",
  "set statement_timeout='8s'",
  'from public,anon,authenticated,service_role',
  'to service_role',
]) assert.match(migration, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

assert.doesNotMatch(migration, /\b(insert\s+into|update\s+public\.exam_|delete\s+from|alter\s+table|create\s+policy)\b/i);
assert.match(pageSource, /results\.filter\(isAssessmentResult\)/);
assert.match(pageSource, /Historical exam attempt/);
assert.match(pageSource, /results\.filter\(isAssessmentResult\)/);
assert.match(progressSource, /saved before and after protected delivery/);
assert.doesNotMatch(pageSource, /startAttempt|replacePractice|submitAttempt|saveResponse/);

console.log(JSON.stringify({
  ok: true,
  issue: 25,
  fixtures: 5,
  eligibleAssessments: 2,
  practiceRows: 2,
  unclassifiedRows: 1,
  rawLegacyRowsMutated: 0,
  lifecycleRequests: 0,
}));
