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
