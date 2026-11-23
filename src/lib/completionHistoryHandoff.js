import { appendUniqueHistory } from './historyPagination.js';
import { validateProtectedHistoryPage } from './protectedHistory.js';

// Existing validated history remains authoritative even if a stale pending
// representation is still waiting for its result transport.
export function hasCompletionHistory(items, result) {
  return items.some((item) => item.attemptId === result.attemptId &&
    item.serverAuthoritative === true && item.source === 'protected' && item.completedAt);
}
export function mergeCompletionHistoryPage(current, page, requestedCursor) {
  validateProtectedHistoryPage(page);
  const items = appendUniqueHistory(current.items, page.items).sort((a, b) =>
    Date.parse(b.completedAt) - Date.parse(a.completedAt) || b.attemptId.localeCompare(a.attemptId));
  // A lookup can revisit the head after reaching the end. Do not replace a
  // separately advanced UI tail with an unrelated lookup cursor.
  const nextCursor = items.length >= page.totalCount ? null :
    current.nextCursor === requestedCursor || current.nextCursor === null ? page.nextCursor : current.nextCursor;
  return { state: items.length ? 'ready' : 'empty', items, totalCount: page.totalCount, nextCursor, headRefreshNeeded: items.length < page.totalCount && nextCursor === null, message: '' };
}
