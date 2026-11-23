export function getProtectedItemSection(item) {
  if (item?.type === 'case-study-info') return 'case-study';
  if (String(item?.type ?? '').startsWith('pbq-')) return 'pbq';
  if (typeof item?.caseStudyId === 'string' && item.caseStudyId.trim()) return 'case-study';
  if (/case/i.test(String(item?.section ?? ''))) return 'case-study';
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

export function assertProtectedAttemptInventory(profile, items, attempt) {
  if (attempt?.countContract != null || profile?.countPolicy != null) {
    return assertVariableFormInventory(attempt?.countContract, items);
  }
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

export function assertVariableFormInventory(contract, items) {
  const fail = () => { throw Object.assign(new Error('Protected attempt inventory binding is invalid.'), { code: 'attempt_inventory_mismatch' }); };
  const types = [...(contract?.version === 'certsim-authorised-form-count-v2' ? ['single-choice'] : []), 'true-false-single-v1', 'true-false-composite-v1', 'matching-v1', 'code-dropdown-completion-v1'];
  const { exactCount: n, allowedCounts: allowed, bindings, composition } = contract ?? {};
  if (!['certsim-authorised-form-count-v1','certsim-authorised-form-count-v2'].includes(contract?.version) || contract.mode !== 'variable'
      || !Number.isSafeInteger(n) || n < 1 || n > 50
      || !Array.isArray(allowed) || allowed.length < 2 || new Set(allowed).size !== allowed.length
      || allowed.some((v, i) => !Number.isSafeInteger(v) || v < 1 || v > 50 || (i > 0 && v <= allowed[i - 1])) || !allowed.includes(n)
      || !Array.isArray(bindings) || bindings.length !== n || !Array.isArray(items) || items.length !== n
      || composition?.standardQuestionCount !== n
      || ['caseStudyCount', 'caseStudyQuestionCount', 'pbqCount', 'executableCount'].some(k => composition?.[k] !== 0)) fail();
  const seenItems = new Set(), seenQuestions = new Set();
  bindings.forEach((binding, index) => {
    const item = items[index];
    if (!binding || typeof binding.itemId !== 'string' || !binding.itemId || typeof binding.questionId !== 'string' || !binding.questionId
        || seenItems.has(binding.itemId) || seenQuestions.has(binding.questionId)
        || binding.questionNumber !== index + 1 || !types.includes(binding.questionType)
        || item?.id !== binding.itemId || item.sourceQuestionId !== binding.questionId
        || item.questionNumber !== binding.questionNumber || item.type !== binding.questionType) fail();
    seenItems.add(binding.itemId); seenQuestions.add(binding.questionId);
  });
  return getProtectedAttemptInventory(items);
}
