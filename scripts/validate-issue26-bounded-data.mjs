import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadProtectedHistoryPage } from '../src/lib/protectedHistory.js';
import { buildStudentProgressSnapshot } from '../src/lib/studentProgressService.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [savedResults, history, progressService, responses, summaryMigration, trainerScope, trainerPage] = await Promise.all([
  read('src/protected/ProtectedSavedResultsPage.jsx'),
  read('src/lib/protectedHistory.js'),
  read('src/lib/studentProgressService.js'),
  read('supabase/functions/certsim-protected-exam/responses.ts'),
  read('supabase/migrations/20260902211457_learner_progress_summary_metrics.sql'),
  read('src/hooks/useTrainerScope.js'),
  read('src/components/trainer/TrainerDashboardPage.jsx'),
]);

let requests = 0;
const page = await loadProtectedHistoryPage({
  listHistory: async ({ cursor, examKey, pageSize }) => {
    requests += 1;
    assert.equal(cursor, null);
    assert.equal(examKey, 'az204');
    assert.equal(pageSize, 20);
    return { items: [], returnedCount: 0, totalCount: 0, remainingCount: 0, nextCursor: null };
  },
}, { examKey: 'az204', pageSize: 20 });
assert.equal(requests, 1, 'initial history rendering must use one bounded request');
assert.equal(page.totalCount, 0);

assert.match(savedResults, /pageSize: 20/);
assert.match(savedResults, /examKey: examFilter \|\| undefined/);
assert.match(savedResults, /appendUniqueHistory/);
assert.match(savedResults, /Load more results/);
assert.match(savedResults, /controller\.abort\(\)/);
assert.doesNotMatch(savedResults, /historyPageCount|setHistoryPage/);
assert.doesNotMatch(history, /MAX_HISTORY_PAGES|history_page_limit_exceeded/);
assert.doesNotMatch(progressService, /loadAllProtectedHistory/);
assert.match(progressService, /getHistorySummary/);
assert.match(progressService, /pageSize: 20/);
for (const field of ['averageScore', 'scoredCount', 'passedCount', 'needsReviewCount']) {
  assert.match(responses, new RegExp(`mapHistorySummary[\\s\\S]*${field}`));
  assert.match(summaryMigration, new RegExp(`'${field}'`));
}
assert.match(summaryMigration, /security definer set search_path='' set statement_timeout='5s'/);

const progress = buildStudentProgressSnapshot({
  rawResults: [],
  historySummaries: {
    az204: {
      averageScore: 780,
      best: { attemptId: 'best', completedAt: '2026-09-01T00:00:00Z', score: 860 },
      completedCount: 75,
      latest: { attemptId: 'latest', completedAt: '2026-09-02T00:00:00Z', score: 810 },
      needsReviewCount: 15,
      passedCount: 60,
      scoredCount: 75,
      weakDomains: {},
    },
  },
});
assert.equal(progress.progress.totalSavedAttempts, 75);
assert.equal(progress.examProgress[0].scopedAttemptCount, 75);
assert.equal(progress.examProgress[0].latestAttemptId, 'latest');

assert.match(trainerScope, /getTrainerScopePage\(selection/);
assert.match(trainerScope, /loadMoreAssignments/);
assert.doesNotMatch(trainerScope, /pageCount > 1000|do \{/);
assert.match(trainerPage, /Load more assignments/);

console.log(JSON.stringify({ ok: true, issue: 26, initialHistoryRequests: requests, myProgressExhaustiveTraversal: false, exhaustiveAssignmentTraversal: false }));
