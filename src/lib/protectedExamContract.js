const EXAM_IDENTITIES = Object.freeze({
  sc200: 'sc200',
  ai901: 'ai901',
  az204: 'az204',
  az400: 'az400',
  'security-plus-sy0-701': 'securityplussy0701',
});
export const PROTECTED_ATTEMPT_PURPOSES = Object.freeze(['assigned_assessment', 'self_directed_exam', 'study_sandbox', 'targeted_domain', 'weak_area', 'pbq_practice']);
export const PROTECTED_LANGUAGE_PREFERENCES = Object.freeze(['csharp', 'python', 'mixed']);

const PROFILE_IDENTITIES = Object.freeze({
  sc200: Object.freeze([
    'sc200-full',
  ]),
  ai901: Object.freeze([
    'ai901-controlled-beta-compact',
    'ai901-controlled-beta-full',
  ]),
  az204: Object.freeze([
    'full-profile',
    'compact-profile',
    'standard-profile',
    'case-heavy-profile',
  ]),
  az400: Object.freeze([
    'az400-mvp-full-profile',
    'az400-mvp-compact-profile',
    'az400-sectioned-full-exam-profile',
  ]),
  securityplussy0701: Object.freeze([
    'strict-beta-full',
    'strict-beta-compact',
  ]),
});

const SAFE_PRESENTATION_TYPES = new Set([
  'single-choice', 'multi-select', 'reorder', 'drag-drop-match',
  'dropdown-code', 'dropdown-command', 'case-study-context', 'informational',
  'pbq-terminal', 'pbq-multi-host-terminal', 'pbq-firewall', 'pbq-siem',
  'pbq-network-diagram', 'pbq-config-panel', 'pbq-hotspot',
  'pbq-drag-drop-match', 'pbq-ordering', 'pbq-workspace',
]);

const BLOCKED_PRESENTATION_KEYS = new Set([
  'acceptedanswer', 'acceptedanswers', 'answer', 'answerkey', 'answers',
  'correctanswer', 'correctanswers', 'correctness', 'correctorder',
  'correctpairs', 'expectedactions', 'expectedanswer', 'expectedanswers',
  'explanation', 'hiddenanswermetadata', 'iscorrect', 'maxpoints',
  'partialcredit', 'points', 'remediation', 'rubric', 'score', 'scoring',
  'scoringkey', 'scoringkeys', 'scoringrules', 'weight', 'weights',
  'protectedpayload', 'protectedsnapshot', 'packagehash', 'validationhash',
  'publicationrequestid', 'internaluuid',
]);

export function getProtectedExamKey(frontendExamId) {
  return EXAM_IDENTITIES[String(frontendExamId ?? '').trim()] ?? '';
}

export function getProtectedProfileKey(frontendExamId, profileId) {
  const examKey = getProtectedExamKey(frontendExamId);
  const normalized = String(profileId ?? '').trim();
  return PROFILE_IDENTITIES[examKey]?.includes(normalized) ? normalized : '';
}


export function isProtectedExamSupported(frontendExamId) {
  return Boolean(getProtectedExamKey(frontendExamId));
}

export function toPresentationQuestion(item) {
  assertObject(item, 'invalid_attempt_item');
  assertObject(item.presentation, 'invalid_presentation');
  assertPresentationSafe(item.presentation);
  if (!SAFE_PRESENTATION_TYPES.has(item.questionType)) {
    throw new Error('unsupported_question_type');
  }

  const presentation = structuredClone(item.presentation);
  const type = ['case-study-context', 'informational'].includes(item.questionType)
    ? 'case-study-info'
    : item.questionType;
  return {
    ...presentation,
    id: item.itemId,
    sourceQuestionId: item.questionId,
    questionNumber: item.questionNumber,
    type,
    domain: item.domain ?? presentation.domain ?? '',
    section: item.section ?? '',
    revision: Number.isSafeInteger(item.revision) ? item.revision : 0,
  };
}

export function serializeProtectedResponse(question, answer) {
  const type = question?.type;
  if (!SAFE_PRESENTATION_TYPES.has(type === 'case-study-info' ? 'case-study-context' : type)) {
    throw new Error('unsupported_question_type');
  }
  if (type === 'case-study-info' || type === 'informational') return null;
  if (type === 'single-choice') return { answer: answer ?? '' };
  if (['multi-select', 'reorder'].includes(type)) {
    return { answer: Array.isArray(answer) ? [...answer] : [] };
  }
  if (['drag-drop-match', 'dropdown-code', 'dropdown-command'].includes(type)) {
    return {
      answer: answer && typeof answer === 'object' && !Array.isArray(answer)
        ? structuredClone(answer)
        : {},
    };
  }
  if (Array.isArray(answer)) return { selectedOrder: [...answer] };
  if (answer && typeof answer === 'object') {
    const response = structuredClone(answer);
    const allowedKeys = ['selectedAnswer', 'selectedAnswers', 'selectedOrder', 'executedCommands'];
    const selected = Object.fromEntries(
      Object.entries(response).filter(([key]) => allowedKeys.includes(key)),
    );
    return Object.keys(selected).length ? selected : { selectedAnswers: response };
  }
  return { selectedAnswer: answer ?? '' };
}

export function deserializeProtectedResponse(question, response) {
  if (response === null || response === undefined) return undefined;
  assertObject(response, 'invalid_protected_response');

  const type = question?.type;
  if (!SAFE_PRESENTATION_TYPES.has(type === 'case-study-info' ? 'case-study-context' : type)) {
    throw new Error('unsupported_question_type');
  }
  if (type === 'case-study-info' || type === 'informational') return undefined;
  if (['single-choice', 'multi-select', 'reorder', 'drag-drop-match', 'dropdown-code', 'dropdown-command'].includes(type)) {
    return structuredClone(response.answer);
  }
  if (type === 'pbq-ordering') {
    return Array.isArray(response.selectedOrder) ? [...response.selectedOrder] : [];
  }
  if (response.selectedAnswers && typeof response.selectedAnswers === 'object' && !Array.isArray(response.selectedAnswers)) {
    return structuredClone(response.selectedAnswers);
  }
  if (Array.isArray(response.executedCommands)) {
    return {
      selectedAnswer: response.selectedAnswer ?? '',
      executedCommands: [...response.executedCommands],
    };
  }
  return response.selectedAnswer ?? '';
}

export function requireProtectedAuthoritativeResult(value) {
  assertObject(value, 'invalid_protected_result');
  if (value.serverAuthoritative !== true) {
    throw new Error('untrusted_protected_result');
  }
  return value;
}

export function assertPresentationSafe(value, depth = 0) {
  if (depth > 12) throw new Error('invalid_presentation');
  if (Array.isArray(value)) {
    value.forEach((entry) => assertPresentationSafe(entry, depth + 1));
    return true;
  }
  if (!value || typeof value !== 'object') return true;
  Object.entries(value).forEach(([key, entry]) => {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (BLOCKED_PRESENTATION_KEYS.has(normalizedKey)) throw new Error('protected_field_detected');
    assertPresentationSafe(entry, depth + 1);
  });
  return true;
}

export const protectedExamContract = Object.freeze({
  examIdentities: EXAM_IDENTITIES,
  profileIdentities: PROFILE_IDENTITIES,
  endpoint: 'certsim-protected-exam',
});

function assertObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(code);
  }
}
