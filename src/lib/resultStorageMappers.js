import {
  getResultAttemptKind,
  getResultSourceFlow,
} from './resultSaveEligibility.js';

export function normalizeExamKey(value) {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  return (
    value.examKey ??
    value.exam_key ??
    value.registryId ??
    value.registry_id ??
    value.examId ??
    value.exam_id ??
    value.slug ??
    value.code ??
    value.id ??
    value.metadata?.id ??
    ''
  );
}

export function normalizeProfileId(value) {
  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  return (
    value.profileId ??
    value.profile_id ??
    value.id ??
    value.profile?.id ??
    value.selectedProfile?.id ??
    ''
  );
}

export function createSelectedQuestionIds(questions = []) {
  return asArray(questions)
    .map((question) => question?.id)
    .filter(Boolean);
}

export function createPresentedOrderSnapshot(questions = []) {
  return {
    questionIds: createSelectedQuestionIds(questions),
    itemTypes: asArray(questions).map((question) => ({
      id: question?.id ?? '',
      type: question?.type ?? '',
      domain: question?.domain ?? '',
      difficulty: question?.difficulty ?? '',
      isScored: question?.type !== 'case-study-info',
    })),
  };
}

export function createAttemptStoragePayload({
  attempt = {},
  exam = {},
  mode = {},
  profile = {},
  questions = [],
} = {}) {
  const attemptQuestions = questions.length > 0
    ? questions
    : attempt.questions ?? attempt.items ?? [];

  return {
    exam_key: normalizeExamKey(exam) || normalizeExamKey(attempt),
    exam_version: attempt.examVersion ?? exam.version ?? exam.currentVersion ?? '1.0.0',
    profile_id: normalizeProfileId(profile) || normalizeProfileId(attempt),
    mode_label: mode.label ?? mode.name ?? attempt.modeLabel ?? attempt.mode?.label ?? '',
    status: attempt.status ?? 'in_progress',
    started_at: attempt.startedAt ?? attempt.started_at ?? null,
    submitted_at: attempt.submittedAt ?? attempt.submitted_at ?? null,
    duration_seconds: attempt.durationSeconds ?? attempt.duration_seconds ?? null,
    time_limit_minutes: attempt.timeLimitMinutes ?? attempt.time_limit_minutes ?? null,
    selected_question_ids: createSelectedQuestionIds(attemptQuestions),
    presented_order_snapshot: createPresentedOrderSnapshot(attemptQuestions),
    attempt_snapshot: toJsonObject({
      attemptId: attempt.id ?? attempt.attemptId ?? '',
      mode,
      profile,
      metadata: attempt.metadata ?? {},
    }),
    client_app_version: attempt.clientAppVersion ?? '',
  };
}

export function createResponseSnapshots({
  questions = [],
  answers = {},
  completionStates = {},
  presentedSnapshots = {},
} = {}) {
  return asArray(questions)
    .filter((question) => question?.id)
    .map((question) => {
      const answer = answers[question.id];
      const completionState = completionStates[question.id] ?? '';

      return {
        question_id: question.id,
        question_type: question.type ?? '',
        response_snapshot: toJsonObject({
          answer,
          completionState,
          flagged: Boolean(answer?.flagged),
        }),
        presented_snapshot: toJsonObject(presentedSnapshots[question.id] ?? question),
        is_answered: isAnsweredCompletionState(completionState) ||
          (!completionState && hasAnswerValue(answer)),
        is_scored: question.type !== 'case-study-info',
      };
    });
}

export function createResultStoragePayload({
  attemptId = '',
  result = {},
  examKey = '',
  profileId = '',
  scoringEngineVersion = 'client-v1',
} = {}) {
  const domainBreakdown = extractDomainBreakdown(result);
  const weakAreas = extractWeakAreas(result, domainBreakdown);
  const resultSnapshot = toJsonObject({
    ...result,
    domainBreakdown,
    weakAreas,
  });

  return {
    attempt_id: attemptId,
    exam_key: examKey || normalizeExamKey(result),
    profile_id: profileId || normalizeProfileId(result),
    scoring_engine_version: result.scoringEngineVersion ?? scoringEngineVersion,
    raw_score:
      result.earnedScorePoints ??
      result.score ??
      result.rawScore ??
      result.correctCount ??
      result.totalCorrect ??
      null,
    raw_percentage: result.percentage ?? result.rawPercentage ?? null,
    scaled_score: result.scaledScore ?? result.microsoftStyleScore ?? null,
    passed: result.passed ?? result.passStatus ?? null,
    pass_mark: result.passMark ?? result.passThreshold ?? null,
    domain_breakdown: toJsonObject(domainBreakdown),
    pbq_breakdown: toJsonObject(extractPbqBreakdown(result)),
    case_study_breakdown: toJsonObject(extractCaseStudyBreakdown(result)),
    weak_areas: toJsonArray(weakAreas),
    result_snapshot: resultSnapshot,
  };
}

export function createReportStoragePayload({
  attemptId = '',
  report = {},
  title = 'CertSim Study Report',
  reportType = 'practice_result',
} = {}) {
  return {
    attempt_id: attemptId,
    report_type: report.reportType ?? reportType,
    report_title: report.title ?? title,
    report_snapshot: toJsonObject(report),
    pdf_generated: Boolean(report.pdfGenerated),
  };
}

export function createQuestionReportStoragePayload(report = {}) {
  return {
    attempt_id: report.attemptId ?? report.attempt_id ?? null,
    exam_key: normalizeExamKey(report),
    question_id: report.questionId ?? report.question_id ?? null,
    report_type: report.reportType ?? report.report_type ?? 'question_issue',
    message: report.message ?? report.comment ?? '',
    metadata: toJsonObject(report.metadata ?? report),
  };
}

export function extractDomainBreakdown(result = {}) {
  return normalizeDomainBreakdownSnapshot(
    result.domainBreakdown ??
    result.domain_breakdown ??
    result.domains ??
    {},
  );
}

export function extractWeakAreas(result = {}, domainBreakdown = null) {
  return normalizeWeakAreasSnapshot(
    result.weakAreas ?? result.weak_areas ?? result.weak_domains ?? [],
    domainBreakdown ?? extractDomainBreakdown(result),
  );
}

export function extractPbqBreakdown(result = {}) {
  if (result.pbqBreakdown ?? result.pbq_breakdown ?? result.pbqSummary) {
    return result.pbqBreakdown ?? result.pbq_breakdown ?? result.pbqSummary;
  }

  const pbqResults = asArray(result.questionResults).filter(
    (questionResult) => questionResult?.pbqScore,
  );

  if (pbqResults.length === 0) {
    return {};
  }

  return {
    items: pbqResults.map((questionResult) => ({
      questionId: questionResult.questionId,
      status: questionResult.pbqScore.status,
      earnedPoints: questionResult.pbqScore.earnedPoints,
      maxPoints: questionResult.pbqScore.maxPoints,
      criteria: questionResult.pbqScore.criteriaResults ?? [],
    })),
  };
}

export function extractCaseStudyBreakdown(result = {}) {
  return (
    result.caseStudyBreakdown ??
    result.case_study_breakdown ??
    result.caseStudySummary ??
    {}
  );
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function createSubmittedResultStoragePayload(
  result = {},
  { examCatalogEntry = null, clientAppVersion = '' } = {},
) {
  const exam = result.exam ?? {};
  const questions = asArray(exam.questions);
  const submittedAt = result.submittedAt ?? new Date().toISOString();
  const startedAt = exam.generatedAt ?? submittedAt;
  const examKey = normalizeExamKey(exam) || normalizeExamKey(result);
  const profile = exam.profile ?? result.profile ?? {};
  const profileId =
    normalizeProfileId(profile) ||
    normalizeProfileId(exam) ||
    exam.mode?.id ||
    'default';
  const sourceFlow = getResultSourceFlow(result);
  const attemptKind = getResultAttemptKind(result);
  const completionStates = createCompletionStatesFromResult(result, questions);

  return {
    attempt: {
      ...createAttemptStoragePayload({
        attempt: {
          status: 'submitted',
          startedAt,
          submittedAt,
          durationSeconds: calculateDurationSeconds(result, exam),
          timeLimitMinutes: exam.durationMinutes ?? profile.timeLimitMinutes ?? null,
          examVersion: exam.currentVersion ?? exam.version ?? '1.0.0',
          clientAppVersion,
          metadata: {
            attemptKind,
            generatedAt: exam.generatedAt ?? null,
            submitReason: result.submitReason ?? '',
            historySaveStatus: result.historySaveStatus ?? null,
            resultType: result.resultType ?? 'certification_exam_result',
            sourceFlow,
            student: result.student ?? null,
          },
        },
        exam: {
          ...exam,
          examKey,
        },
        mode: exam.mode ?? result.mode ?? {},
        profile,
        questions,
      }),
      exam_catalog_id: examCatalogEntry?.id ?? null,
      exam_key: examKey,
      profile_id: profileId,
    },
    responses: createResponseSnapshots({
      questions,
      answers: result.answers ?? {},
      completionStates,
    }),
    result: createResultStoragePayload({
      result,
      examKey,
      profileId,
    }),
    report: createReportStoragePayload({
      report: {
        result,
        generatedAt: submittedAt,
        reportType: 'study_report_snapshot',
      },
      title: `${exam.shortName ?? exam.code ?? exam.name ?? 'CertSim'} Study Report`,
      reportType: 'study_report_snapshot',
    }),
  };
}

function calculateDurationSeconds(result, exam) {
  const durationMinutes = Number(exam.durationMinutes);
  const remainingSeconds = Number(result.remainingSeconds);

  if (!Number.isFinite(durationMinutes) || !Number.isFinite(remainingSeconds)) {
    return null;
  }

  return Math.max(0, Math.round(durationMinutes * 60 - remainingSeconds));
}

function createCompletionStatesFromResult(result, questions) {
  const unansweredIds = new Set(
    asArray(result.unansweredQuestions).map((question) =>
      typeof question === 'string' ? question : question?.id,
    ),
  );
  const incompleteIds = new Set(
    asArray(result.incompleteQuestions).map((question) =>
      typeof question === 'string' ? question : question?.id,
    ),
  );
  const questionResultsById = new Map(
    asArray(result.questionResults).map((questionResult) => [
      questionResult.questionId,
      questionResult,
    ]),
  );
  const answers = result.answers ?? {};

  return asArray(questions).reduce((states, question) => {
    if (!question?.id) {
      return states;
    }

    if (question.type === 'case-study-info') {
      states[question.id] = 'info';
      return states;
    }

    if (unansweredIds.has(question.id)) {
      states[question.id] = 'unanswered';
      return states;
    }

    if (incompleteIds.has(question.id)) {
      states[question.id] = 'incomplete';
      return states;
    }

    const pbqStatus = questionResultsById.get(question.id)?.pbqScore?.status;

    if (pbqStatus === 'partial') {
      states[question.id] = 'partial';
      return states;
    }

    if (pbqStatus === 'incomplete' || pbqStatus === 'unanswered') {
      states[question.id] = pbqStatus;
      return states;
    }

    states[question.id] = hasAnswerValue(answers[question.id])
      ? 'answered'
      : 'unanswered';
    return states;
  }, {});
}

function isAnsweredCompletionState(completionState) {
  return completionState === 'answered' || completionState === 'partial';
}

function hasAnswerValue(answer) {
  if (answer === null || answer === undefined || answer === '') {
    return false;
  }

  if (Array.isArray(answer)) {
    return answer.length > 0;
  }

  if (typeof answer === 'object') {
    return Object.values(answer).some((value) => hasAnswerValue(value));
  }

  return true;
}

export function normalizeDomainBreakdownSnapshot(value, options = {}) {
  const source = options.source ?? 'saved_result';
  const missingReason =
    options.missingReason ??
    'Legacy saved result: domain breakdown was not stored for this attempt. Newer eligible saved results include domain breakdowns when available.';
  const rows = getDomainRows(value);
  const items = rows.map(([domainKey, row]) =>
    normalizeDomainRow(row, domainKey),
  ).filter((row) => row.domainLabel);
  const byDomain = items.reduce((map, item) => {
    map[item.domainId] = item;
    return map;
  }, {});

  return {
    kind: 'domain_breakdown_v1',
    source,
    items,
    byDomain,
    missingReason: items.length > 0 ? '' : missingReason,
    summary: {
      domainCount: items.length,
      weakCount: items.filter((item) => item.status === 'weak').length,
      reviewCount: items.filter((item) => item.status === 'review').length,
      strongCount: items.filter((item) => item.status === 'strong').length,
    },
  };
}

export function normalizeWeakAreasSnapshot(value, domainBreakdown = null) {
  const existingWeakAreas = toJsonArray(value)
    .map(normalizeWeakArea)
    .filter((area) => area.domainLabel);

  if (existingWeakAreas.length > 0) {
    return existingWeakAreas;
  }

  return createWeakAreasFromDomainBreakdown(domainBreakdown);
}

export function createWeakAreasFromDomainBreakdown(domainBreakdown = {}) {
  return getNormalizedDomainItems(domainBreakdown)
    .filter((domain) => domain.percentage !== null && domain.percentage < 80)
    .map((domain) => ({
      domainId: domain.domainId,
      domainLabel: domain.domainLabel,
      domain: domain.domainLabel,
      percentage: domain.percentage,
      correct: domain.correct,
      total: domain.total,
      earnedPoints: domain.earnedPoints,
      maxPoints: domain.maxPoints,
      status: domain.percentage < 70 ? 'weak' : 'review',
      reason:
        domain.percentage < 70
          ? 'Domain score is below 70% in CertSim practice.'
          : 'Domain score is between 70% and 79%; review recommended.',
    }));
}

export function getNormalizedDomainItems(domainBreakdown = {}) {
  if (Array.isArray(domainBreakdown)) {
    return domainBreakdown
      .map((row) => normalizeDomainRow(row))
      .filter((row) => row.domainLabel);
  }

  if (!domainBreakdown || typeof domainBreakdown !== 'object') {
    return [];
  }

  if (Array.isArray(domainBreakdown.items)) {
    return domainBreakdown.items
      .map((row) => normalizeDomainRow(row))
      .filter((row) => row.domainLabel);
  }

  return Object.entries(domainBreakdown)
    .filter(([key]) => !['kind', 'source', 'summary', 'missingReason'].includes(key))
    .map(([domainKey, row]) => normalizeDomainRow(row, domainKey))
    .filter((row) => row.domainLabel);
}

function getDomainRows(value) {
  if (Array.isArray(value)) {
    return value.map((row, index) => [row?.domain ?? row?.label ?? `domain-${index + 1}`, row]);
  }

  if (!value || typeof value !== 'object') {
    return [];
  }

  if (Array.isArray(value.items)) {
    return value.items.map((row, index) => [row?.domainId ?? row?.domain ?? `domain-${index + 1}`, row]);
  }

  return Object.entries(value)
    .filter(([key]) => !['kind', 'source', 'summary', 'missingReason', 'byDomain'].includes(key));
}

function normalizeDomainRow(row = {}, fallbackDomain = '') {
  const domainLabel = cleanText(
    row.domainLabel ??
    row.label ??
    row.name ??
    row.domain ??
    fallbackDomain,
  );
  const correct = toNumberOrNull(row.correct ?? row.correctCount);
  const total = toNumberOrNull(row.total ?? row.totalScoredCount);
  const earnedPoints = toNumberOrNull(row.earnedPoints ?? row.score ?? row.earned);
  const maxPoints = toNumberOrNull(row.maxPoints ?? row.possible);
  const percentage = getDomainPercentage({
    ...row,
    correct,
    earnedPoints,
    maxPoints,
    total,
  });

  return {
    domainId: cleanSlug(row.domainId ?? row.id ?? row.slug ?? domainLabel),
    domainLabel,
    domain: domainLabel,
    correct,
    total,
    earnedPoints,
    maxPoints,
    percentage,
    status: row.status ?? classifyDomainStatus(percentage),
  };
}

function normalizeWeakArea(area = {}) {
  if (typeof area === 'string') {
    return {
      domainId: cleanSlug(area),
      domainLabel: area,
      domain: area,
      percentage: null,
      reason: 'Stored weak-area label.',
      status: 'weak',
    };
  }

  const domainLabel = cleanText(
    area.domainLabel ??
    area.domain ??
    area.label ??
    area.name ??
    area.section,
  );
  const percentage = toNumberOrNull(area.percentage ?? area.percent ?? area.rawPercentage);

  return {
    domainId: cleanSlug(area.domainId ?? area.id ?? domainLabel),
    domainLabel,
    domain: domainLabel,
    percentage,
    correct: toNumberOrNull(area.correct),
    total: toNumberOrNull(area.total),
    earnedPoints: toNumberOrNull(area.earnedPoints),
    maxPoints: toNumberOrNull(area.maxPoints),
    reason: cleanText(area.reason ?? area.detail) || 'Stored weak-area label.',
    status: area.status ?? classifyWeakAreaStatus(percentage),
  };
}

function classifyDomainStatus(percentage) {
  if (percentage === null) {
    return 'not-recorded';
  }

  if (percentage < 70) {
    return 'weak';
  }

  if (percentage < 80) {
    return 'review';
  }

  return 'strong';
}

function classifyWeakAreaStatus(percentage) {
  if (percentage === null) {
    return 'weak';
  }

  return percentage < 70 ? 'weak' : 'review';
}

function getDomainPercentage(row = {}) {
  const direct = toNumberOrNull(
    row.percentage ?? row.percent ?? row.rawPercentage ?? row.raw_percentage,
  );

  if (direct !== null) {
    return Math.round(direct);
  }

  if ((row.earnedPoints || row.earnedPoints === 0) && row.maxPoints) {
    return Math.round((Number(row.earnedPoints) / Number(row.maxPoints)) * 100);
  }

  if ((row.correct || row.correct === 0) && row.total) {
    return Math.round((Number(row.correct) / Number(row.total)) * 100);
  }

  return null;
}

function toNumberOrNull(value) {
  if (value || value === 0) {
    const numberValue = Number(value);

    return Number.isFinite(numberValue) ? numberValue : null;
  }

  return null;
}

function cleanSlug(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'domain';
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function toJsonObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value;
}

function toJsonArray(value) {
  return Array.isArray(value) ? value : [];
}
