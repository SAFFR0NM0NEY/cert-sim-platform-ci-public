const CORRECT_SINGLE_KEYS = ['correctOptionId', 'correctAnswer'];
const CORRECT_MULTIPLE_KEYS = ['correctOptionIds', 'correctAnswers'];

export function resolveReleasedChoiceTexts(presentation, value, { correct = false } = {}) {
  const question = asObject(presentation);
  const questionType = String(question.type ?? '').toLowerCase();

  if (!['single-choice', 'multi-select'].includes(questionType)) {
    return { status: 'not-applicable', texts: [] };
  }

  const options = Array.isArray(question.options) ? question.options : [];
  const optionTextById = new Map();

  for (const option of options) {
    const safeOption = asObject(option);
    const id = typeof safeOption.id === 'string' ? safeOption.id : '';
    const text = typeof safeOption.text === 'string' ? safeOption.text.trim() : '';

    if (!id || !text || optionTextById.has(id)) {
      return { status: 'invalid', texts: [] };
    }

    optionTextById.set(id, text);
  }

  const answer = correct
    ? readCorrectOptionIds(value, questionType)
    : readResponseOptionIds(value, questionType);

  if (answer.status !== 'resolved') {
    return answer;
  }

  if (new Set(answer.ids).size !== answer.ids.length) {
    return { status: 'invalid', texts: [] };
  }

  const texts = answer.ids.map((id) => optionTextById.get(id));
  if (texts.some((text) => !text)) {
    return { status: 'invalid', texts: [] };
  }

  return { status: 'resolved', texts };
}

export function resolveReleasedMatchingPairs(presentation, value, { correct = false } = {}) {
  const question = asObject(presentation);
  if (String(question.type ?? '').toLowerCase() !== 'drag-drop-match') {
    return { status: 'not-applicable', pairs: [] };
  }

  const prompts = indexIdTextCollection(question.prompts);
  const options = indexIdTextCollection(question.options);
  if (prompts.status !== 'resolved' || options.status !== 'resolved') {
    return { status: 'invalid', pairs: [] };
  }

  const source = asObject(value);
  const rawPairs = correct
    ? source.correctPairs ?? source.correctPairsByPrompt
    : source.answer;

  if (!correct && Object.keys(source).length === 0) return { status: 'empty', pairs: [] };
  if (!rawPairs || typeof rawPairs !== 'object' || Array.isArray(rawPairs)) {
    return { status: 'invalid', pairs: [] };
  }

  const pairEntries = Object.entries(rawPairs);
  if (pairEntries.length === 0) {
    return correct ? { status: 'invalid', pairs: [] } : { status: 'empty', pairs: [] };
  }
  if (new Set(pairEntries.map(([, rightId]) => rightId)).size !== pairEntries.length) {
    return { status: 'invalid', pairs: [] };
  }

  const pairByPromptId = new Map(pairEntries);
  if ([...pairByPromptId.keys()].some((id) => !prompts.textById.has(id)) ||
      [...pairByPromptId.values()].some((id) => typeof id !== 'string' || !options.textById.has(id))) {
    return { status: 'invalid', pairs: [] };
  }

  return {
    status: 'resolved',
    pairs: prompts.ids
      .filter((promptId) => pairByPromptId.has(promptId))
      .map((promptId) => ({
        leftText: prompts.textById.get(promptId),
        rightText: options.textById.get(pairByPromptId.get(promptId)),
      })),
  };
}

export function resolveReleasedTrueFalse(presentation, value, { correct = false } = {}) {
  const question = asObject(presentation);
  const type = String(question.type ?? question.interactionVersion ?? '').toLowerCase();
  if (!['true-false-single-v1', 'true-false-composite-v1'].includes(type)) return { status: 'not-applicable', entries: [] };
  const source = asObject(value);
  if (type === 'true-false-single-v1') {
    const raw = correct ? source.correctValue : source.answer;
    if (raw === undefined && !correct && Object.keys(source).length === 0) return { status: 'empty', entries: [] };
    if (typeof raw !== 'boolean') return { status: 'invalid', entries: [] };
    return { status: 'resolved', entries: [{ label: '', text: raw ? 'True' : 'False' }] };
  }
  const statements = indexIdTextCollection(question.statements);
  if (statements.status !== 'resolved') return { status: 'invalid', entries: [] };
  const answers = correct ? asObject(source.correctValuesByStatement) : asObject(source.answer);
  if (!correct && Object.keys(source).length === 0) return { status: 'empty', entries: [] };
  if (Object.keys(answers).length === 0) return correct ? { status: 'invalid', entries: [] } : { status: 'empty', entries: [] };
  if (Object.keys(answers).some((id) => !statements.textById.has(id)) || Object.values(answers).some((entry) => typeof entry !== 'boolean')) return { status: 'invalid', entries: [] };
  return { status: 'resolved', entries: statements.ids.filter((id) => Object.hasOwn(answers, id)).map((id) => ({ label: statements.textById.get(id), text: answers[id] ? 'True' : 'False' })) };
}

export function resolveReleasedStructuredPairs(presentation, value, { correct = false } = {}) {
  const question = asObject(presentation);
  const type = String(question.type ?? question.interactionVersion ?? '').toLowerCase();
  if (!['matching-v1', 'code-dropdown-completion-v1'].includes(type)) return { status: 'not-applicable', pairs: [] };
  const left = type === 'matching-v1' ? indexIdTextCollection(question.sources) : indexBlankCollection(question.blanks);
  if (left.status !== 'resolved') return { status: 'invalid', pairs: [] };
  const rightByLeft = type === 'matching-v1'
    ? new Map(left.ids.map((id) => [id, indexIdTextCollection(question.targets)]))
    : left.optionIndexes;
  if ([...rightByLeft.values()].some((entry) => entry.status !== 'resolved')) return { status: 'invalid', pairs: [] };
  const source = asObject(value);
  const answers = correct ? asObject(source[type === 'matching-v1' ? 'correctTargetIdsBySource' : 'correctOptionIdsByBlank']) : asObject(source.answer);
  if (!correct && Object.keys(source).length === 0) return { status: 'empty', pairs: [] };
  if (Object.keys(answers).length === 0) return correct ? { status: 'invalid', pairs: [] } : { status: 'empty', pairs: [] };
  if (Object.keys(answers).some((id) => !left.textById.has(id)) || Object.entries(answers).some(([id, answerId]) => typeof answerId !== 'string' || !rightByLeft.get(id)?.textById.has(answerId))) return { status: 'invalid', pairs: [] };
  return { status: 'resolved', pairs: left.ids.filter((id) => Object.hasOwn(answers, id)).map((id) => ({ leftText: left.textById.get(id), rightText: rightByLeft.get(id).textById.get(answers[id]) })) };
}

function indexIdTextCollection(value) {
  if (!Array.isArray(value) || value.length === 0) return { status: 'invalid' };
  const ids = [];
  const textById = new Map();
  for (const entry of value) {
    const item = asObject(entry);
    const id = typeof item.id === 'string' ? item.id : '';
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!id || !text || textById.has(id)) return { status: 'invalid' };
    ids.push(id);
    textById.set(id, text);
  }
  return { status: 'resolved', ids, textById };
}

function indexBlankCollection(value) {
  if (!Array.isArray(value) || value.length === 0) return { status: 'invalid' };
  const ids = [];
  const textById = new Map();
  const optionIndexes = new Map();
  for (const entry of value) {
    const blank = asObject(entry);
    const id = typeof blank.id === 'string' ? blank.id : '';
    const text = typeof blank.label === 'string' ? blank.label.trim() : '';
    const options = indexIdTextCollection(blank.options);
    if (!id || !text || textById.has(id) || options.status !== 'resolved') return { status: 'invalid' };
    ids.push(id); textById.set(id, text); optionIndexes.set(id, options);
  }
  return { status: 'resolved', ids, textById, optionIndexes };
}

function readCorrectOptionIds(value, questionType) {
  const source = asObject(value);
  const keys = questionType === 'single-choice' ? CORRECT_SINGLE_KEYS : CORRECT_MULTIPLE_KEYS;
  const key = keys.find((candidate) => Object.hasOwn(source, candidate));
  if (!key) return { status: 'invalid', texts: [] };
  return normalizeIds(source[key], questionType);
}

function readResponseOptionIds(value, questionType) {
  const source = asObject(value);
  if (!Object.hasOwn(source, 'answer')) {
    return Object.keys(source).length === 0
      ? { status: 'empty', texts: [] }
      : { status: 'invalid', texts: [] };
  }
  return normalizeIds(source.answer, questionType);
}

function normalizeIds(value, questionType) {
  const ids = questionType === 'single-choice'
    ? [value]
    : Array.isArray(value) ? value : [];

  if (ids.length === 0 || ids.some((id) => typeof id !== 'string' || !id)) {
    return { status: 'invalid', texts: [] };
  }

  return { status: 'resolved', ids, texts: [] };
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
