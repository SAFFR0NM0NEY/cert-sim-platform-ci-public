import { appendUniqueHistory } from './historyPagination.js';

const HISTORY_PAGE_SIZE = 50;
const HISTORY_SOURCES = new Set(['protected', 'legacy_authoritative']);
const HISTORY_PURPOSES = new Set([
  'assigned_assessment',
  'self_directed_exam',
  'study_sandbox',
  'targeted_domain',
  'weak_area',
  'pbq_practice',
  'unclassified',
]);

export function validateProtectedHistoryPage(page) {
  if (!page || typeof page !== 'object' || Array.isArray(page)) throw new Error('invalid_history_page');
  if (!Array.isArray(page.items)) throw new Error('invalid_history_rows');
  if (!Number.isSafeInteger(page.returnedCount) || page.returnedCount !== page.items.length) throw new Error('invalid_history_count');
  if (!Number.isSafeInteger(page.totalCount) || page.totalCount < page.items.length) throw new Error('invalid_history_total');
  if (!Number.isSafeInteger(page.remainingCount) || page.remainingCount < 0) throw new Error('invalid_history_remaining');
  if (page.nextCursor !== null && typeof page.nextCursor !== 'string') throw new Error('invalid_history_cursor');
  page.items.forEach(validateProtectedHistoryItem);
  return page;
}
export function validateProtectedHistoryItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid_history_item');
  if (!item.attemptId || !item.examKey || !item.completedAt || !HISTORY_SOURCES.has(item.source)) throw new Error('invalid_history_item');
  if (typeof item.serverAuthoritative !== 'boolean') throw new Error('invalid_history_authority');
  if (item.source === 'protected' && item.serverAuthoritative !== true) throw new Error('invalid_history_authority');
  if (item.source === 'legacy_authoritative' && item.serverAuthoritative !== false) throw new Error('invalid_history_authority');
  if (!HISTORY_PURPOSES.has(item.purpose)) throw new Error('invalid_history_classification');
  return item;
}

export async function loadAllProtectedHistory(client, { examKey, signal } = {}) {
  let cursor = null;
  let items = [];
  let totalCount = null;
  const seenCursors = new Set();
  while (true) {
    const page = validateProtectedHistoryPage(await client.listHistory({ cursor, examKey, pageSize: HISTORY_PAGE_SIZE }, { signal }));
    totalCount ??= page.totalCount;
    if (page.totalCount !== totalCount) throw new Error('unstable_history_total');
    const combined = appendUniqueHistory(items, page.items);
    if (combined.length !== items.length + page.items.length) throw new Error('duplicate_history_item');
    items = combined;
    if (!page.nextCursor) {
      if (items.length !== totalCount || page.remainingCount !== 0) throw new Error('incomplete_history_traversal');
      return { items, totalCount };
    }
    if (seenCursors.has(page.nextCursor)) throw new Error('repeated_history_cursor');
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

export async function loadProtectedHistoryPage(client, { cursor = null, examKey, pageSize = 20, signal } = {}) {
  return validateProtectedHistoryPage(await client.listHistory({ cursor, examKey, pageSize }, { signal }));
}

export function normalizeProtectedHistoryResult(item, userId = '') {
  validateProtectedHistoryItem(item);
  return {
    attemptId: item.attemptId,
    userId,
    examKey: item.examKey,
    examTitle: item.examKey,
    packageVersion: item.packageVersion,
    profileId: item.profileKey,
    profileLabel: item.profileKey,
    purpose: item.purpose,
    submittedAt: item.completedAt,
    savedAt: item.completedAt,
    rawScore: item.score,
    rawPercentage: item.percentage,
    score: item.score,
    passed: typeof item.passed === 'boolean' ? item.passed : null,
    domainBreakdown: item.domainSummary ?? {},
    serverAuthoritative: item.serverAuthoritative,
    source: item.source,
    historySource: item.source,
    reviewStatus: item.reviewStatus,
  };
}

export function partitionProtectedHistory(items = []) {
  return items.reduce((result, item) => {
    if (['assigned_assessment', 'self_directed_exam'].includes(item.purpose)) result.assessments.push(item);
    else if (['study_sandbox', 'targeted_domain', 'weak_area', 'pbq_practice'].includes(item.purpose)) result.practice.push(item);
    else result.historical.push(item);
    return result;
  }, { assessments: [], practice: [], historical: [] });
}
