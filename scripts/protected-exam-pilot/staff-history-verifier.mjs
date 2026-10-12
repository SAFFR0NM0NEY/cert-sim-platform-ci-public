const SOURCES = Object.freeze({
  protected: true,
  legacy_authoritative: false,
});
const PAGE_FIELDS = new Set(['items', 'nextCursor', 'returnedCount', 'totalCount', 'remainingCount']);

export function verifyStaffHistoryPage(page, { expectedPageSize, previousCursor = null, seenAttemptIds = new Set() } = {}) {
  if (!page || typeof page !== 'object' || Array.isArray(page)
    || Object.keys(page).some((key) => !PAGE_FIELDS.has(key))
    || [...PAGE_FIELDS].some((key) => !Object.hasOwn(page, key))
    || !Array.isArray(page.items)) fail('STAFF_HISTORY_PAGE_INVALID');
  if (!Number.isInteger(page.totalCount) || page.totalCount < 0
    || !Number.isInteger(page.returnedCount) || page.returnedCount !== page.items.length
    || !Number.isInteger(page.remainingCount) || page.remainingCount < 0) fail('STAFF_HISTORY_METADATA_INVALID');
  if (expectedPageSize != null && page.items.length > expectedPageSize) fail('STAFF_HISTORY_PAGE_UNBOUNDED');

  const pageIds = new Set();
  let protectedCount = 0;
  let legacyCount = 0;
  for (const item of page.items) {
    if (!item || typeof item.attemptId !== 'string' || !item.attemptId) fail('STAFF_HISTORY_IDENTITY_INVALID');
    if (!Object.hasOwn(SOURCES, item.source)) fail('STAFF_HISTORY_SOURCE_INVALID');
    if (typeof item.serverAuthoritative !== 'boolean') fail('STAFF_HISTORY_AUTHORITY_INVALID');
    if (item.serverAuthoritative !== SOURCES[item.source]) fail('STAFF_HISTORY_CLASSIFICATION_CONTRADICTORY');
    if (pageIds.has(item.attemptId)) fail('STAFF_HISTORY_DUPLICATE_WITHIN_PAGE');
    if (seenAttemptIds.has(item.attemptId)) fail('STAFF_HISTORY_DUPLICATE_ACROSS_PAGES');
    pageIds.add(item.attemptId);
    if (item.source === 'protected') protectedCount += 1;
    else legacyCount += 1;
  }

  const hasMore = page.remainingCount > 0;
  if (hasMore && (typeof page.nextCursor !== 'string' || !page.nextCursor || page.nextCursor === previousCursor)) {
    fail('STAFF_HISTORY_CURSOR_INVALID');
  }
  if (!hasMore && page.nextCursor != null) fail('STAFF_HISTORY_END_CURSOR_INVALID');
  if (page.totalCount < page.returnedCount + page.remainingCount) fail('STAFF_HISTORY_TOTAL_INVALID');

  return {
    attemptIds: pageIds,
    protectedCount,
    legacyCount,
    hasMore,
    nextCursor: page.nextCursor ?? null,
  };
}

export function verifyStaffHistoryTraversal(first, second, pageSize = 25) {
  const firstResult = verifyStaffHistoryPage(first, { expectedPageSize: pageSize });
  if (!firstResult.hasMore || first.items.length !== pageSize || first.totalCount <= first.items.length) {
    fail('STAFF_HISTORY_FIRST_PAGE_NOT_BOUNDED');
  }
  const secondResult = verifyStaffHistoryPage(second, {
    expectedPageSize: pageSize,
    previousCursor: firstResult.nextCursor,
    seenAttemptIds: firstResult.attemptIds,
  });
  if (second.totalCount !== first.totalCount
    || first.remainingCount !== second.returnedCount + second.remainingCount) {
    fail('STAFF_HISTORY_PAGINATION_METADATA_UNSTABLE');
  }
  if (firstResult.protectedCount + secondResult.protectedCount === 0
    || firstResult.legacyCount + secondResult.legacyCount === 0) {
    fail('STAFF_HISTORY_MIXED_CLASSIFICATION_MISSING');
  }
  return {
    firstPageCount: first.items.length,
    secondPageCount: second.items.length,
    totalCount: first.totalCount,
    remainingCount: second.remainingCount,
    protectedCount: firstResult.protectedCount + secondResult.protectedCount,
    legacyCount: firstResult.legacyCount + secondResult.legacyCount,
    olderHistoryReachable: second.items.length > 0,
    stableCursorTraversal: true,
    duplicates: 0,
  };
}

function fail(code) { throw new Error(code); }
