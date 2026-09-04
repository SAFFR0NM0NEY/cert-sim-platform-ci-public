export function getServerRemainingSeconds(attempt, now = Date.now()) {
  const expiresAt = Date.parse(attempt?.expiresAt ?? '');
  return Number.isFinite(expiresAt) ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : 0;
}

export function getProtectedRunnerCounts(items = [], answers = {}, flaggedIds = []) {
  const itemIds = new Set(items.map((item) => item.id));
  return {
    total: items.length,
    answered: Object.keys(answers).filter((id) => itemIds.has(id)).length,
    flagged: [...new Set(flaggedIds)].filter((id) => itemIds.has(id)).length,
  };
}
