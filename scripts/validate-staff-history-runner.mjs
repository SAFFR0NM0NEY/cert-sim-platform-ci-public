import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyStaffHistoryPage, verifyStaffHistoryTraversal } from './protected-exam-pilot/staff-history-verifier.mjs';

const protectedRow = (attemptId) => ({ attemptId, source: 'protected', serverAuthoritative: true });
const legacyRow = (attemptId) => ({ attemptId, source: 'legacy_authoritative', serverAuthoritative: false });
const page = (items, { totalCount = items.length, remainingCount = 0, nextCursor = null } = {}) => ({
  items, returnedCount: items.length, totalCount, remainingCount, nextCursor,
});

const [mapperSource, verifierSource] = await Promise.all([
  readFile(new URL('../supabase/functions/certsim-protected-exam/responses.ts', import.meta.url), 'utf8'),
  readFile(new URL('./protected-exam-pilot/staff-history-verifier.mjs', import.meta.url), 'utf8'),
]);
const staffMapper = mapperSource.match(/export function mapStaffHistory[\s\S]+?\r?\n}\r?\n/)?.[0] ?? '';
for (const field of ['items', 'nextCursor', 'returnedCount', 'totalCount', 'remainingCount']) assert.match(staffMapper, new RegExp(`\\b${field}\\b`));
assert.doesNotMatch(staffMapper, /\bok\b/);
assert.doesNotMatch(verifierSource, /page\.ok|\['ok'\]|"ok"/);

const mixed = page([protectedRow('protected-1'), legacyRow('legacy-1')]);
assert.deepEqual(verifyStaffHistoryPage(mixed), {
  attemptIds: new Set(['protected-1', 'legacy-1']), protectedCount: 1, legacyCount: 1,
  hasMore: false, nextCursor: null,
});
assert.throws(() => verifyStaffHistoryPage({ ...mixed, ok: true }));
for (const required of ['items', 'nextCursor', 'returnedCount', 'totalCount', 'remainingCount']) {
  const malformed = { ...mixed };
  delete malformed[required];
  assert.throws(() => verifyStaffHistoryPage(malformed));
}
for (const candidate of [
  { ...protectedRow('p'), serverAuthoritative: false },
  { ...legacyRow('l'), serverAuthoritative: true },
  { attemptId: 'missing', source: 'protected' },
  { ...protectedRow('null'), serverAuthoritative: null },
  { ...protectedRow('string'), serverAuthoritative: 'true' },
  { ...protectedRow('number'), serverAuthoritative: 1 },
  { ...protectedRow('unknown'), source: 'other' },
]) assert.throws(() => verifyStaffHistoryPage(page([candidate])));

assert.throws(() => verifyStaffHistoryPage(page([protectedRow('same'), legacyRow('same')])));
const firstItems = Array.from({ length: 25 }, (_, index) => index % 2 ? legacyRow(`first-${index}`) : protectedRow(`first-${index}`));
const first = page(firstItems, { totalCount: 108, remainingCount: 83, nextCursor: 'cursor-1' });
const second = page([legacyRow('second-1'), protectedRow('second-2')], { totalCount: 108, remainingCount: 81, nextCursor: 'cursor-2' });
const traversal = verifyStaffHistoryTraversal(first, second);
assert.equal(traversal.firstPageCount, 25);
assert.equal(traversal.secondPageCount, 2);
assert.equal(traversal.totalCount, 108);
assert.equal(traversal.duplicates, 0);
assert.equal(traversal.olderHistoryReachable, true);
assert.throws(() => verifyStaffHistoryTraversal(first, page([legacyRow('first-1')], { totalCount: 108, remainingCount: 82, nextCursor: 'cursor-2' })));
assert.throws(() => verifyStaffHistoryTraversal(first, page([legacyRow('second')], { totalCount: 108, remainingCount: 82, nextCursor: 'cursor-1' })));
assert.throws(() => verifyStaffHistoryTraversal(first, page([legacyRow('second')], { totalCount: 107, remainingCount: 82, nextCursor: 'cursor-2' })));
assert.throws(() => verifyStaffHistoryTraversal(first, page([legacyRow('second')], { totalCount: 108, remainingCount: 81, nextCursor: 'cursor-2' })));
assert.throws(() => verifyStaffHistoryTraversal(page(Array.from({ length: 25 }, (_, index) => protectedRow(`only-${index}`)), { totalCount: 26, remainingCount: 1, nextCursor: 'only-1' }), page([protectedRow('only-next')], { totalCount: 26 })));
assert.doesNotThrow(() => verifyStaffHistoryPage(page([legacyRow('end')]), { previousCursor: 'cursor-last' }));
assert.throws(() => verifyStaffHistoryPage(page([legacyRow('end')], { nextCursor: 'unexpected' })));

console.log(JSON.stringify({ ok: true, fixtures: 22, publicDtoFields: 5, mixedSources: true, paginationPages: 2, duplicatesAccepted: 0 }));
