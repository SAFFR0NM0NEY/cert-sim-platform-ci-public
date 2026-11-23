export const HISTORY_RANGE_RECENT = 'recent';
export const HISTORY_RANGE_ALL = 'all';

export function normalizeHistoryRange(value) {
  return value === HISTORY_RANGE_ALL ? HISTORY_RANGE_ALL : HISTORY_RANGE_RECENT;
}

export function createHistoryCursor(item, {
  idKey = 'attemptId',
  timestampKey = 'submittedAt',
} = {}) {
  const attemptId = item?.[idKey];
  const timestamp = item?.[timestampKey];
  return attemptId && timestamp ? { attemptId, timestamp } : null;
}

export function appendUniqueHistory(current = [], incoming = []) {
  const seen = new Set(current.map((item) => item?.attemptId).filter(Boolean));
  return [...current, ...incoming.filter((item) => {
    if (!item?.attemptId || seen.has(item.attemptId)) return false;
    seen.add(item.attemptId);
    return true;
  })];
}

export function visibleHistoryItems(items = [], range = HISTORY_RANGE_RECENT, recentSize = 10) {
  return normalizeHistoryRange(range) === HISTORY_RANGE_ALL
    ? items
    : items.slice(0, recentSize);
}

export function paginateStableHistory(items = [], cursor = null, pageSize = 10) {
  const ordered = [...items].sort((left, right) =>
    String(right.completedAt).localeCompare(String(left.completedAt)) ||
    String(right.attemptId).localeCompare(String(left.attemptId)));
  const eligible = cursor
    ? ordered.filter((item) =>
        item.completedAt < cursor.timestamp ||
        (item.completedAt === cursor.timestamp && item.attemptId < cursor.attemptId))
    : ordered;
  const page = eligible.slice(0, pageSize);
  return {
    items: page,
    nextCursor: eligible.length > pageSize
      ? createHistoryCursor(page.at(-1), { timestampKey: 'completedAt' })
      : null,
  };
}
