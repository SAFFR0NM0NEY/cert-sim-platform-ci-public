import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { aggregateWeakDomains } from '../src/lib/learnerAnalytics.js';
import {
  buildExamProgressRows,
  normalizeProgressResult,
} from '../src/lib/examReadinessRules.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [page, app, service, history] = await Promise.all([
  read('src/protected/ProtectedSavedResultsPage.jsx'),
  read('src/App.jsx'),
  read('src/lib/studentProgressService.js'),
  read('src/lib/protectedHistory.js'),
]);

const assessment = (purpose, earnedPoints, maxPoints, completedAt) => ({
  attemptId: `${purpose}-${completedAt}`,
  examKey: 'az204',
  examTitle: 'AZ-204',
  profileKey: 'standard-profile',
  purpose,
  completedAt,
  submittedAt: completedAt,
  percentage: 50,
  rawPercentage: 50,
  source: 'protected',
  serverAuthoritative: true,
  userId: 'learner',
  domainSummary: { compute: { domain: 'Compute', earnedPoints, maxPoints, percentage: 50 } },
  domainBreakdown: { compute: { domain: 'Compute', earnedPoints, maxPoints, percentage: 50 } },
});

const eligible = [
  assessment('assigned_assessment', 1, 2, '2026-09-01T00:00:00Z'),
  assessment('self_directed_exam', 9, 10, '2026-09-02T00:00:00Z'),
];
const weak = aggregateWeakDomains([...eligible, assessment('weak_area', 0, 100, '2026-09-03T00:00:00Z')]);
assert.equal(weak.length, 0, 'Weighted authoritative assessment evidence is 10/12 and not weak; practice must be excluded.');

const progress = buildExamProgressRows({
  results: eligible.map(normalizeProgressResult),
  assignments: [],
  students: [{ userId: 'learner' }],
});
assert.equal(Math.round(progress[0].domainAverages[0].averagePercentage), 83);

assert.match(page, /loadAllProtectedHistory/);
assert.match(page, /results\.filter\(isAssessmentResult\)/);
assert.match(page, /purpose: 'weak_area'/);
assert.match(page, /getPracticeAvailability/);
assert.match(page, /No eligible completed assessments/);
assert.match(page, /role="alert"/);
assert.match(page, /Review Missed First/);
assert.match(page, /Balanced Mix/);
assert.match(page, /New Questions First/);
assert.match(page, /selectCurrentWeakAreaProfile/);
assert.match(page, /profileId, domain, questionCount/);
assert.doesNotMatch(page, /profileId: latest\.profileKey/);
assert.match(app, /profileId: plan\?\.profileId/);
assert.match(app, /domain: plan\?\.domain/);
assert.match(service, /loadProtectedHistoryPage/);
assert.match(service, /getHistorySummary/);
assert.doesNotMatch(service, /loadAllProtectedHistory/);
assert.match(history, /duplicate_history_item/);
assert.doesNotMatch(page, /startAttempt|replacePractice|submitAttempt|saveResponse/);

console.log(JSON.stringify({ ok: true, issue: 25, weightedDomainPercentage: 83, productionLifecycleRequests: 0 }));
