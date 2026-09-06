const INELIGIBLE_FLOW_PATTERNS = [
  'study-sandbox',
  'sandbox',
  'targeted-practice',
  'targeted',
  'pbq-preview',
  'case-study-preview',
  'case-studies',
  'it-direction',
  'assessment',
];

const ELIGIBLE_FLOW_PATTERNS = [
  'full',
  'full-mock',
  'full-practice',
  'compact',
  'realistic',
  'sectioned',
  'strict-beta',
  'certification',
  'exam',
];

export function getResultSaveEligibility(result = {}) {
  const safeResult = result ?? {};
  const exam = safeResult.exam ?? {};
  const mode = exam.mode ?? safeResult.mode ?? {};
  const profile = exam.profile ?? safeResult.profile ?? {};
  const sourceFlow = getResultSourceFlow(safeResult);
  const searchableText = [
    sourceFlow,
    safeResult.attemptKind,
    safeResult.resultType,
    exam.attemptKind,
    exam.resultType,
    exam.id,
    exam.registryId,
    exam.slug,
    exam.examType,
    exam.name,
    exam.shortName,
    mode.id,
    mode.name,
    mode.label,
    profile.id,
    profile.name,
    profile.label,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (Object.keys(exam).length === 0) {
    return createEligibility(false, 'missing_result', 'No completed exam result is available.');
  }

  if (!safeResult.submittedAt) {
    return createEligibility(false, 'not_completed', 'Only completed exam attempts can be saved.');
  }

  if (INELIGIBLE_FLOW_PATTERNS.some((pattern) => searchableText.includes(pattern))) {
    return createEligibility(
      false,
      'practice_tool',
      'Practice tools are intentionally not saved to cloud attempt history.',
    );
  }

  if (exam.examType && exam.examType !== 'certification') {
    return createEligibility(
      false,
      'not_certification_exam',
      'Only completed certification exam attempts are eligible for cloud saving.',
    );
  }

  if (!Number.isFinite(Number(safeResult.totalScoredQuestions)) || Number(safeResult.totalScoredQuestions) <= 0) {
    return createEligibility(false, 'not_scored', 'Only scored exam results are eligible for cloud saving.');
  }

  if (ELIGIBLE_FLOW_PATTERNS.some((pattern) => searchableText.includes(pattern))) {
    return createEligibility(true, 'eligible_completed_exam', 'This completed exam result can be saved.');
  }

  return createEligibility(
    true,
    'eligible_certification_result',
    'This completed certification exam result can be saved.',
  );
}

export function getResultSourceFlow(result = {}) {
  const safeResult = result ?? {};
  const exam = safeResult.exam ?? {};
  const mode = exam.mode ?? safeResult.mode ?? {};
  const profile = exam.profile ?? safeResult.profile ?? {};

  return (
    safeResult.sourceFlow ??
    safeResult.flow ??
    safeResult.screen ??
    safeResult.attemptKind ??
    exam.sourceFlow ??
    exam.flow ??
    profile.sourceFlow ??
    profile.attemptKind ??
    profile.id ??
    mode.id ??
    ''
  );
}

export function getResultAttemptKind(result = {}) {
  const safeResult = result ?? {};
  const exam = safeResult.exam ?? {};
  const mode = exam.mode ?? safeResult.mode ?? {};
  const profile = exam.profile ?? safeResult.profile ?? {};
  const sourceFlow = getResultSourceFlow(safeResult);

  if (sourceFlow) {
    return sourceFlow;
  }

  if (profile.id || mode.id) {
    return [mode.id, profile.id].filter(Boolean).join(':');
  }

  return 'completed_certification_exam';
}

export function createResultSaveFingerprint(result = {}, userId = '') {
  const safeResult = result ?? {};
  const exam = safeResult.exam ?? {};
  const mode = exam.mode ?? safeResult.mode ?? {};
  const profile = exam.profile ?? safeResult.profile ?? {};
  const questionIds = Array.isArray(exam.questions)
    ? exam.questions.map((question) => question?.id).filter(Boolean)
    : [];
  const parts = [
    userId,
    exam.examKey ?? exam.registryId ?? exam.slug ?? exam.id ?? '',
    mode.id ?? mode.name ?? '',
    profile.id ?? profile.name ?? '',
    getResultAttemptKind(safeResult),
    exam.generatedAt ?? '',
    safeResult.submittedAt ?? '',
    questionIds.join(','),
    safeResult.totalScoredQuestions ?? '',
    safeResult.earnedScorePoints ?? safeResult.totalCorrect ?? '',
    safeResult.totalScorePoints ?? '',
    safeResult.scaledScore ?? safeResult.microsoftScore ?? '',
  ].map(normalizeFingerprintPart);

  return `result-${hashFingerprint(parts.join('|'))}`;
}

function createEligibility(eligible, reason, message) {
  return {
    eligible,
    reason,
    message,
  };
}

function normalizeFingerprintPart(value) {
  return String(value ?? '').trim().toLowerCase();
}

function hashFingerprint(value) {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(31, hash) + value.charCodeAt(index);
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
}
