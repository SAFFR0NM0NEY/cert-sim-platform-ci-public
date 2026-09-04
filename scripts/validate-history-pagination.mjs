import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  appendUniqueHistory,
  paginateStableHistory,
  visibleHistoryItems,
} from '../src/lib/historyPagination.js';

const createRows = (count) => Array.from({ length: count }, (_, index) => ({
  attemptId: `attempt-${String(count - index).padStart(3, '0')}`,
  completedAt: new Date(Date.UTC(2026, 7, 31, 12, 0, count - index)).toISOString(),
}));

for (const total of [26, 76]) {
  const source = createRows(total);
  let cursor = null;
  let collected = [];
  do {
    const page = paginateStableHistory(source, cursor, 10);
    collected = appendUniqueHistory(collected, page.items);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(collected.length, total, `all ${total} records should remain reachable`);
  assert.equal(new Set(collected.map(({ attemptId }) => attemptId)).size, total);
}

const tied = [
  { attemptId: 'c', completedAt: '2026-08-31T12:00:00.000Z' },
  { attemptId: 'a', completedAt: '2026-08-31T12:00:00.000Z' },
  { attemptId: 'b', completedAt: '2026-08-31T12:00:00.000Z' },
];
assert.deepEqual(paginateStableHistory(tied, null, 3).items.map(({ attemptId }) => attemptId), ['c', 'b', 'a']);

const stableSource = createRows(21);
const first = paginateStableHistory(stableSource, null, 10);
const inserted = { attemptId: 'attempt-new', completedAt: '2026-09-01T00:00:00.000Z' };
const second = paginateStableHistory([inserted, ...stableSource], first.nextCursor, 10);
assert.equal(second.items.some(({ attemptId }) => first.items.some((item) => item.attemptId === attemptId)), false);
assert.deepEqual(visibleHistoryItems(stableSource, 'recent', 10), stableSource.slice(0, 10));
assert.equal(visibleHistoryItems(stableSource, 'all', 10).length, 21);

const files = await Promise.all([
  readFile(new URL('../src/lib/savedResultsService.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/trainerDashboardService.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/protected/ProtectedSavedResultsPage.jsx', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20260830075212_protected_practice_history_and_language.sql', import.meta.url), 'utf8'),
]);
const combined = files.join('\n');
for (const token of [".order('submitted_at'", ".order('id'", '(a.completed_at,a.id)<', 'limit least(greatest(p_page_size,1),50)+1', 'All Time']) {
  assert.match(combined, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}
assert.match(files[3], /a\.purpose in \('assigned_assessment','self_directed_exam'\)/);
assert.match(files[3], /a\.owner_id=p_actor_id/);
assert.match(files[3], /set statement_timeout='5s'/);
assert.doesNotMatch(files[3].match(/create function exam_delivery\.print_summary[\s\S]*?create function public\./)?.[0] ?? '', /question|answer|explanation|protected/);
for (const forbidden of ['correctAnswer', 'scoringRules', 'protectedPayload']) {
  assert.equal(files[2].includes(forbidden), false);
}
assert.match(files[2], /Load more results/);
assert.match(files[2], /loadProtectedHistoryPage\(client/);
assert.doesNotMatch(files[2], /historyPageCount|setHistoryPage/);

console.log('History pagination validation passed.');
