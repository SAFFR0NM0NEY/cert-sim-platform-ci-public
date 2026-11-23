export function isPBQQuestion(question) {
  return String(question?.type ?? '').startsWith('pbq-');
}
