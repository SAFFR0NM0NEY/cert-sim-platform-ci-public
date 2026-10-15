const ARRAY_TYPES = new Set(['multi-select', 'reorder']);
const OBJECT_TYPES = new Set(['drag-drop-match', 'dropdown-code', 'dropdown-command']);

export const SUPPORTED_CONTROLLED_TYPES = Object.freeze([
  'single-choice',
  ...ARRAY_TYPES,
  ...OBJECT_TYPES,
]);

export function controlledResponseFor(questionType, presentation = {}) {
  if (questionType === 'single-choice') {
    const firstOption = Array.isArray(presentation?.options) ? presentation.options.find((option) => typeof option?.id === 'string') : null;
    return { answer: firstOption?.id ?? 'controlled-no-match' };
  }
  if (ARRAY_TYPES.has(questionType)) return { answer: [] };
  if (OBJECT_TYPES.has(questionType)) return { answer: {} };
  if (questionType.startsWith('pbq-')) return { answer: {} };
  if (questionType === 'case-study-context' || questionType === 'informational') return {};
  throw new Error('UNSUPPORTED_QUESTION_TYPE');
}

export function assertControlledSerialization() {
  for (const type of SUPPORTED_CONTROLLED_TYPES) {
    const serialized = JSON.stringify(controlledResponseFor(type));
    if (type === 'single-choice' && serialized !== '{"answer":"controlled-no-match"}') {
      throw new Error('CONTROLLED_STRING_SERIALIZATION_FAILED');
    }
    if (ARRAY_TYPES.has(type) && serialized !== '{"answer":[]}') {
      throw new Error('CONTROLLED_ARRAY_SERIALIZATION_FAILED');
    }
    if (OBJECT_TYPES.has(type) && serialized !== '{"answer":{}}') {
      throw new Error('CONTROLLED_OBJECT_SERIALIZATION_FAILED');
    }
  }
}
