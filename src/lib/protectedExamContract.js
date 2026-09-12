import { normalizeKeyedStructuredAnswer } from './structuredResponse.js';

const EXAM_IDENTITIES = Object.freeze({
  sc200: 'sc200',
  ai901: 'ai901',
  az204: 'az204',
  az400: 'az400',
  'security-plus-sy0-701': 'securityplussy0701',
  inf303: 'inf303',
});
export const PROTECTED_ATTEMPT_PURPOSES = Object.freeze(['assigned_assessment', 'self_directed_exam', 'study_sandbox', 'targeted_domain', 'weak_area', 'pbq_practice']);
export const PROTECTED_LANGUAGE_PREFERENCES = Object.freeze(['csharp', 'python', 'mixed']);

const PROFILE_IDENTITIES = Object.freeze({
  sc200: Object.freeze([
    'sc200-full',
    'sc200-compact',
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
  inf303: Object.freeze(['inf303-standard', 'inf303-compact']),
});

const SAFE_PRESENTATION_TYPES = new Set([
  'single-choice', 'multi-select', 'reorder', 'drag-drop-match',
  'dropdown-code', 'dropdown-command', 'case-study-context', 'informational',
  'true-false-single-v1', 'true-false-composite-v1', 'matching-v1',
  'code-dropdown-completion-v1',
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
  'correctvalue', 'correctvaluesbystatement', 'correcttargetidsbysource',
  'correctoptionidsbyblank', 'pointsbyblank', 'maximumrawpoints', 'modelsolution',
]);

// Terminal replay state is intentionally ephemeral. Resume rebuilds an empty
// terminal around the canonical scorer selections returned by the server.
const PBQ_BROWSER_ONLY_KEYS = new Set([
  'commandHistory',
  'terminalTranscript',
  'perHostCommandHistory',
  'perHostTerminalTranscript',
]);
// Retain the Issue #166 contract name for source-level regression checks.
const MULTI_HOST_BROWSER_ONLY_KEYS = PBQ_BROWSER_ONLY_KEYS;

const DEFAULT_PBQ_SERIALIZATION_ERRORS = Object.freeze({
  response: 'invalid_pbq_response',
  allowlist: 'invalid_pbq_response_allowlist',
  target: 'invalid_pbq_response_target',
  value: 'invalid_pbq_response_value',
  order: 'invalid_pbq_response_order',
  answer: 'invalid_pbq_response_answer',
  command: 'invalid_pbq_command_state',
});

const MULTI_HOST_SERIALIZATION_ERRORS = Object.freeze({
  ...DEFAULT_PBQ_SERIALIZATION_ERRORS,
  response: 'invalid_multi_host_response',
  allowlist: 'invalid_multi_host_response_allowlist',
  target: 'invalid_multi_host_response_target',
  value: 'invalid_multi_host_response_value',
  command: 'invalid_multi_host_command_state',
});

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
    question: presentation.question ?? presentation.prompt ?? '',
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
  if (type === 'true-false-single-v1') return { answer: typeof answer === 'boolean' ? answer : null };
  if (['multi-select', 'reorder'].includes(type)) {
    return { answer: Array.isArray(answer) ? [...answer] : [] };
  }
  if (['true-false-composite-v1', 'matching-v1', 'code-dropdown-completion-v1'].includes(type)) {
    return { answer: normalizeKeyedStructuredAnswer(answer) };
  }
  if (['drag-drop-match', 'dropdown-code', 'dropdown-command'].includes(type)) {
    return {
      answer: answer && typeof answer === 'object' && !Array.isArray(answer)
        ? structuredClone(answer)
        : {},
    };
  }
  if (type === 'pbq-multi-host-terminal') {
    return serializeMultiHostTerminalResponse(question, answer);
  }
  if (type.startsWith('pbq-')) {
    return serializeAllowlistedPBQResponse(question, answer);
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
  if (['single-choice', 'true-false-single-v1', 'multi-select', 'reorder', 'drag-drop-match', 'dropdown-code', 'dropdown-command', 'true-false-composite-v1', 'matching-v1', 'code-dropdown-completion-v1'].includes(type)) {
    return structuredClone(response.answer);
  }
  if (type === 'pbq-ordering') {
    return Array.isArray(response.selectedOrder) ? [...response.selectedOrder] : [];
  }
  if (response.selectedAnswers && typeof response.selectedAnswers === 'object' && !Array.isArray(response.selectedAnswers)) {
    if (response.executedCommands !== undefined && !Array.isArray(response.executedCommands)) {
      throw new Error('invalid_protected_response');
    }
    return {
      ...structuredClone(response.selectedAnswers),
      ...(response.executedCommands === undefined
        ? {}
        : { executedCommands: [...response.executedCommands] }),
    };
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

function serializeMultiHostTerminalResponse(question, answer) {
  return serializeAllowlistedPBQResponse(question, answer, MULTI_HOST_SERIALIZATION_ERRORS);
}

function serializeAllowlistedPBQResponse(
  question,
  answer,
  errors = DEFAULT_PBQ_SERIALIZATION_ERRORS,
) {
  const allowlist = question?.responseAllowlist ?? question?.presentation?.responseAllowlist;
  const validatedAllowlist = validatePBQResponseAllowlist(allowlist, errors.allowlist);

  if (Array.isArray(answer)) {
    return { selectedOrder: validatePBQOrder(answer, validatedAllowlist.orderIds, errors.order) };
  }
  if (answer === null || answer === undefined || typeof answer !== 'object') {
    if (answer === '') return {};
    return {
      selectedAnswer: validatePBQSelectedAnswer(answer, validatedAllowlist.answerIds, errors.answer),
    };
  }

  assertPlainObject(answer, errors.response);
  const selectedAnswers = {};
  if (answer.selectedAnswers !== undefined) {
    assertPlainObject(answer.selectedAnswers, errors.response);
    for (const [targetId, selectedValue] of Object.entries(answer.selectedAnswers)) {
      addAllowedPBQSelection(
        selectedAnswers,
        validatedAllowlist,
        targetId,
        selectedValue,
        errors,
      );
    }
  }

  for (const [key, value] of Object.entries(answer)) {
    if (MULTI_HOST_BROWSER_ONLY_KEYS.has(key) || key === 'selectedAnswers' || key === 'executedCommands') continue;
    if (key === 'selectedAnswer' || key === 'selectedOrder') continue;
    addAllowedPBQSelection(selectedAnswers, validatedAllowlist, key, value, errors);
  }

  const response = {};
  if (answer.selectedAnswers !== undefined || validatedAllowlist.targetIds.size > 0) {
    response.selectedAnswers = selectedAnswers;
  }
  if (answer.selectedAnswer !== undefined && answer.selectedAnswer !== '') {
    response.selectedAnswer = validatePBQSelectedAnswer(
      answer.selectedAnswer,
      validatedAllowlist.answerIds,
      errors.answer,
    );
  }
  if (answer.selectedOrder !== undefined) {
    response.selectedOrder = validatePBQOrder(
      answer.selectedOrder,
      validatedAllowlist.orderIds,
      errors.order,
    );
  }
  if (answer.executedCommands !== undefined) {
    if (!Array.isArray(answer.executedCommands) || answer.executedCommands.length > 100) {
      throw new Error(errors.command);
    }
    if (answer.executedCommands.some((commandId) => (
      typeof commandId !== 'string' || commandId.length > 256 ||
      !validatedAllowlist.commandIds.has(commandId)
    ))) {
      throw new Error(errors.command);
    }
    response.executedCommands = [...answer.executedCommands];
  }
  return response;
}

function addAllowedPBQSelection(selectedAnswers, allowlist, targetId, selectedValue, errors) {
  if (!allowlist.targetIds.has(targetId)) throw new Error(errors.target);
  if (selectedValue === '') return;
  const allowedValues = allowlist.answerIdsByTarget.get(targetId);
  if (typeof selectedValue !== 'string' || !allowedValues?.has(selectedValue)) {
    throw new Error(errors.value);
  }
  if (Object.hasOwn(selectedAnswers, targetId) && selectedAnswers[targetId] !== selectedValue) {
    throw new Error(errors.value);
  }
  selectedAnswers[targetId] = selectedValue;
}

function validatePBQResponseAllowlist(allowlist, errorCode) {
  assertPlainObject(allowlist, errorCode);
  const targetIds = validateOptionalUniqueStringArray(allowlist.targetIds, errorCode);
  const answerIds = validateOptionalUniqueStringArray(allowlist.answerIds, errorCode);
  const orderIds = validateOptionalUniqueStringArray(allowlist.orderIds, errorCode);
  const commandIds = validateOptionalUniqueStringArray(allowlist.commandIds, errorCode);
  const answerIdsByTarget = validateAnswerIdsByTarget(
    allowlist.answerIdsByTarget,
    targetIds,
    errorCode,
  );

  return {
    targetIds: new Set(targetIds),
    answerIds: new Set(answerIds),
    orderIds: new Set(orderIds),
    commandIds: new Set(commandIds),
    answerIdsByTarget,
  };
}

function validateAnswerIdsByTarget(value, targetIds, errorCode) {
  if (targetIds.length === 0) {
    if (value === undefined) return new Map();
    const isEmptyArray = Array.isArray(value) && value.length === 0;
    const isEmptyObject = value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
    if (isEmptyArray || isEmptyObject) return new Map();
    throw new Error(errorCode);
  }

  const entries = Array.isArray(value)
    ? value.map((entry) => {
      assertPlainObject(entry, errorCode);
      return [entry.targetId, entry.answerIds];
    })
    : value && typeof value === 'object'
      ? Object.entries(value)
      : null;
  if (!entries || entries.length !== targetIds.length) throw new Error(errorCode);

  const targetIdSet = new Set(targetIds);
  const answerIdsByTarget = new Map();
  for (const [targetId, answerIds] of entries) {
    if (typeof targetId !== 'string' || !targetIdSet.has(targetId) || answerIdsByTarget.has(targetId)) {
      throw new Error(errorCode);
    }
    const validatedAnswers = validateUniqueStringArray(answerIds, errorCode);
    if (validatedAnswers.length === 0) throw new Error(errorCode);
    answerIdsByTarget.set(targetId, new Set(validatedAnswers));
  }
  if (answerIdsByTarget.size !== targetIds.length) throw new Error(errorCode);
  return answerIdsByTarget;
}

function validateUniqueStringArray(value, errorCode) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry)) {
    throw new Error(errorCode);
  }
  if (new Set(value).size !== value.length) throw new Error(errorCode);
  return [...value];
}

function validateOptionalUniqueStringArray(value, errorCode) {
  return value === undefined ? [] : validateUniqueStringArray(value, errorCode);
}

function assertPlainObject(value, code) {
  assertObject(value, code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(code);
}

function validatePBQSelectedAnswer(value, allowedAnswers, errorCode) {
  if (typeof value !== 'string' || !allowedAnswers.has(value)) throw new Error(errorCode);
  return value;
}

function validatePBQOrder(value, allowedOrderIds, errorCode) {
  if (!Array.isArray(value) || new Set(value).size !== value.length ||
      value.some((entry) => typeof entry !== 'string' || !allowedOrderIds.has(entry))) {
    throw new Error(errorCode);
  }
  return [...value];
}
