export function normalizeKeyedStructuredAnswer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => (
    entry !== '' && entry !== null && entry !== undefined
  )));
}

export function updateKeyedStructuredAnswer(value, key, entry) {
  const next = normalizeKeyedStructuredAnswer(value);
  if (entry === '' || entry === null || entry === undefined) {
    delete next[key];
  } else {
    next[key] = entry;
  }
  return next;
}

export function getStructuredResponseState(question, value) {
  if (!['true-false-composite-v1', 'matching-v1', 'code-dropdown-completion-v1'].includes(question?.type)) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unanswered';
  const requiredIds = question.type === 'true-false-composite-v1'
    ? question.statements?.map(({ id }) => id)
    : question.type === 'matching-v1'
      ? question.sources?.map(({ id }) => id)
      : question.blanks?.map(({ id }) => id);
  const answered = (requiredIds ?? []).filter((id) => value[id] !== null && value[id] !== undefined && value[id] !== '').length;
  if (answered === 0) return 'unanswered';
  return answered === requiredIds.length ? 'answered' : 'incomplete';
}
