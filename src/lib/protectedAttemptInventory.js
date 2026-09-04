export function getProtectedItemSection(item) {
  if (item?.type === 'case-study-info' || /case/i.test(String(item?.section ?? ''))) return 'case-study';
  if (String(item?.type ?? '').startsWith('pbq-')) return 'pbq';
  return 'standard';
}

export function getProtectedAttemptInventory(items = []) {
  const scored = items.filter((item) => item?.type !== 'case-study-info');
  return Object.freeze({
    totalScoredQuestions: scored.length,
    standardQuestionCount: scored.filter((item) => getProtectedItemSection(item) === 'standard').length,
    caseStudyQuestionCount: scored.filter((item) => getProtectedItemSection(item) === 'case-study').length,
    caseStudyCount: items.filter((item) => item?.type === 'case-study-info').length,
    pbqCount: scored.filter((item) => getProtectedItemSection(item) === 'pbq').length,
  });
}

export function assertProtectedAttemptInventory(profile, items) {
  const actual = getProtectedAttemptInventory(items);
  const expected = {
    totalScoredQuestions: profile?.totalScoredQuestions,
    standardQuestionCount: profile?.standardQuestionCount,
    caseStudyQuestionCount: profile?.caseStudyQuestionCount ?? 0,
    caseStudyCount: profile?.caseStudyCount ?? 0,
    pbqCount: profile?.pbqCount ?? 0,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (Number.isInteger(value) && actual[key] !== value) {
      throw Object.assign(new Error('Protected attempt inventory does not match the selected profile.'), {
        code: 'attempt_inventory_mismatch',
      });
    }
  }
  return actual;
}
