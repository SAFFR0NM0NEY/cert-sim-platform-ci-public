import { isSupabaseConfigured, supabase } from './supabaseClient.js';
import {
  normalizeDomainBreakdownSnapshot,
  normalizeWeakAreasSnapshot,
} from './resultStorageMappers.js';
import { classifyAttempt, getAttemptKindLabel, getAttemptPurpose } from './attemptPurpose.js';
import { getExamDisplayLabel, getExamDisplayMetadata } from '../exams/examDisplayMetadata.js';

const SAVED_RESULTS_TABLES = {
  examAttempts: 'exam_attempts',
  examResults: 'exam_results',
  examReports: 'exam_reports',
  examResponses: 'exam_responses',
  examCatalog: 'exam_catalog',
};

const unavailableResult = {
  ok: false,
  reason: 'supabase_not_configured',
  message: 'Saved results are not configured for this environment yet.',
};

const signedOutResult = {
  ok: false,
  reason: 'not_signed_in',
  message: 'Sign in to view saved result history.',
};

export const SAVED_RESULTS_REQUEST_PAGE_SIZE = 10;

export async function getMySavedResults({
  cursor = null,
  examKey = '',
  pageSize = SAVED_RESULTS_REQUEST_PAGE_SIZE,
} = {}) {
  const authResult = await requireAuthenticatedUser();

  if (!authResult.ok) {
    return authResult;
  }

  const safePageSize = normalizePageSize(pageSize);
  let query = supabase
    .from(SAVED_RESULTS_TABLES.examAttempts)
    .select(getAttemptSelectColumns())
    .eq('user_id', authResult.user.id)
    .eq('status', 'submitted')
    .order('submitted_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .limit(safePageSize + 1);

  if (examKey) {
    query = query.eq('exam_key', examKey);
  }

  if (cursor?.submittedAt && cursor?.attemptId) {
    query = query.or(
      `submitted_at.lt.${cursor.submittedAt},and(submitted_at.eq.${cursor.submittedAt},id.lt.${cursor.attemptId})`,
    );
  }

  const { data: attemptRows, error } = await query;

  if (error) {
    return createSupabaseError(error, 'Could not load saved results.');
  }

  const hasMore = (attemptRows?.length ?? 0) > safePageSize;
  const attempts = (attemptRows ?? []).slice(0, safePageSize);
  const hydratedResults = await hydrateAttemptRows(attempts, authResult.user.id, {
    includeResponses: true,
  });

  if (!hydratedResults.ok) {
    return hydratedResults;
  }

  return {
    ok: true,
    data: hydratedResults.data.map((attempt) => normalizeSavedResult(attempt)),
    pagination: {
      hasMore,
      nextCursor: hasMore ? createAttemptCursor(attempts.at(-1)) : null,
      pageSize: safePageSize,
    },
  };
}

export async function getSavedResultDetail(attemptId) {
  const authResult = await requireAuthenticatedUser();

  if (!authResult.ok) {
    return authResult;
  }

  const normalizedAttemptId = typeof attemptId === 'string' ? attemptId.trim() : '';

  if (!normalizedAttemptId) {
    return {
      ok: false,
      reason: 'missing_attempt_id',
      message: 'Saved attempt ID is required.',
    };
  }

  const { data: attempt, error } = await supabase
    .from(SAVED_RESULTS_TABLES.examAttempts)
    .select(getAttemptSelectColumns())
    .eq('id', normalizedAttemptId)
    .eq('user_id', authResult.user.id)
    .maybeSingle();

  if (error) {
    return createSupabaseError(error, 'Could not load saved result details.');
  }

  if (!attempt) {
    return {
      ok: false,
      reason: 'not_found',
      message: 'Saved result was not found for the current account.',
    };
  }

  const hydratedResults = await hydrateAttemptRows([attempt], authResult.user.id, {
    includeResponses: true,
  });

  if (!hydratedResults.ok) {
    return hydratedResults;
  }

  return {
    ok: true,
    data: normalizeSavedResult(hydratedResults.data[0], { includeDetail: true }),
  };
}

async function requireAuthenticatedUser() {
  if (!isSupabaseConfigured || !supabase) {
    return { ...unavailableResult };
  }

  const { data, error } = await supabase.auth.getUser();
  const user = data?.user ?? null;

  if (error) {
    return createSupabaseError(error, 'Could not read the current account.');
  }

  if (!user) {
    return { ...signedOutResult };
  }

  return {
    ok: true,
    user,
  };
}

async function hydrateAttemptRows(attempts, userId, { includeResponses = false } = {}) {
  if (attempts.length === 0) {
    return {
      ok: true,
      data: [],
    };
  }

  const attemptIds = attempts.map((attempt) => attempt.id).filter(Boolean);
  const catalogIds = [
    ...new Set(attempts.map((attempt) => attempt.exam_catalog_id).filter(Boolean)),
  ];
  const [resultsResult, reportsResult, catalogResult, responsesResult] =
    await Promise.all([
      queryByAttemptIds(SAVED_RESULTS_TABLES.examResults, attemptIds, userId),
      queryByAttemptIds(SAVED_RESULTS_TABLES.examReports, attemptIds, userId),
      queryCatalogRows(catalogIds),
      includeResponses
        ? queryResponsesByAttemptIds(attemptIds)
        : Promise.resolve({ ok: true, data: [] }),
    ]);

  const failedResult = [
    resultsResult,
    reportsResult,
    catalogResult,
    responsesResult,
  ].find((result) => !result.ok);

  if (failedResult) {
    return failedResult;
  }

  const resultsByAttemptId = groupFirstBy(resultsResult.data, 'attempt_id');
  const reportsByAttemptId = groupFirstBy(reportsResult.data, 'attempt_id');
  const responsesByAttemptId = groupManyBy(responsesResult.data, 'attempt_id');
  const catalogById = groupFirstBy(catalogResult.data, 'id');

  return {
    ok: true,
    data: attempts.map((attempt) => ({
      ...attempt,
      resultRow: resultsByAttemptId.get(attempt.id) ?? null,
      reportRow: reportsByAttemptId.get(attempt.id) ?? null,
      responseRows: responsesByAttemptId.get(attempt.id) ?? [],
      catalogRow: catalogById.get(attempt.exam_catalog_id) ?? null,
    })),
  };
}

async function queryByAttemptIds(table, attemptIds, userId) {
  if (attemptIds.length === 0) {
    return {
      ok: true,
      data: [],
    };
  }

  const { data, error } = await supabase
    .from(table)
    .select('*')
    .in('attempt_id', attemptIds)
    .eq('user_id', userId);

  if (error) {
    return createSupabaseError(error, `Could not read ${table}.`);
  }

  return {
    ok: true,
    data: data ?? [],
  };
}

async function queryResponsesByAttemptIds(attemptIds) {
  if (attemptIds.length === 0) {
    return {
      ok: true,
      data: [],
    };
  }

  const { data, error } = await supabase
    .from(SAVED_RESULTS_TABLES.examResponses)
    .select('id,attempt_id,question_id,question_type,response_snapshot,presented_snapshot,is_answered,is_scored,created_at')
    .in('attempt_id', attemptIds);

  if (error) {
    return createSupabaseError(error, 'Could not read saved response snapshots.');
  }

  return {
    ok: true,
    data: data ?? [],
  };
}

async function queryCatalogRows(catalogIds) {
  if (catalogIds.length === 0) {
    return {
      ok: true,
      data: [],
    };
  }

  const { data, error } = await supabase
    .from(SAVED_RESULTS_TABLES.examCatalog)
    .select('id,exam_key,slug,title,vendor,lifecycle,exam_type,current_version,status')
    .in('id', catalogIds);

  if (error) {
    return createSupabaseError(error, 'Could not read saved result exam labels.');
  }

  return {
    ok: true,
    data: data ?? [],
  };
}

function normalizeSavedResult(attempt, { includeDetail = false } = {}) {
  const resultSnapshot = toObject(attempt.resultRow?.result_snapshot);
  const reportSnapshot = toObject(attempt.reportRow?.report_snapshot);
  const reportResult = toObject(reportSnapshot.result);
  const examSnapshot = toObject(resultSnapshot.exam ?? reportResult.exam);
  const profileSnapshot = toObject(examSnapshot.profile ?? resultSnapshot.profile);
  const domainBreakdown = normalizeDomainBreakdownSnapshot(
    attempt.resultRow?.domain_breakdown ??
      resultSnapshot.domainBreakdown ??
      reportResult.domainBreakdown,
  );
  const weakAreas = normalizeWeakAreasSnapshot(
    attempt.resultRow?.weak_areas ??
      resultSnapshot.weakAreas ??
      reportResult.weakAreas,
    domainBreakdown,
  );
  const selectedQuestionIds = Array.isArray(attempt.selected_question_ids)
    ? attempt.selected_question_ids
    : [];
  const responseRows = Array.isArray(attempt.responseRows)
    ? attempt.responseRows
    : [];
  const purposeRecord = { ...attempt, resultSnapshot, modeLabel: attempt.mode_label };
  const classification = classifyAttempt(purposeRecord);
  const display = getExamDisplayMetadata(attempt.exam_key);

  return {
    attemptId: attempt.id,
    examKey: attempt.exam_key,
    examTitle: display?.fullTitle ??
      attempt.catalogRow?.title ??
      examSnapshot.displayTitle ??
      examSnapshot.name ??
      getExamDisplayLabel('', { fallback: 'Exam' }),
    vendor: display?.vendor ?? attempt.catalogRow?.vendor ?? examSnapshot.vendor ?? '',
    profileId: attempt.profile_id,
    profileLabel: profileSnapshot.name ?? attempt.profile_id,
    modeLabel: attempt.mode_label ?? examSnapshot.mode?.name ?? '',
    purpose: getAttemptPurpose(purposeRecord),
    attemptKind: classification.kind,
    attemptKindLabel: getAttemptKindLabel(purposeRecord),
    status: attempt.status,
    submittedAt: attempt.submitted_at ?? resultSnapshot.submittedAt ?? '',
    savedAt: attempt.resultRow?.created_at ?? attempt.created_at ?? '',
    durationSeconds: attempt.duration_seconds,
    timeLimitMinutes: attempt.time_limit_minutes,
    selectedQuestionCount:
      selectedQuestionIds.length ||
      resultSnapshot.totalScoredQuestions ||
      examSnapshot.profile?.totalScoredQuestions ||
      null,
    selectedQuestionIds: includeDetail ? selectedQuestionIds : [],
    responseCount: responseRows.length || selectedQuestionIds.length,
    rawScore:
      attempt.resultRow?.raw_score ??
      resultSnapshot.earnedScorePoints ??
      resultSnapshot.totalCorrect ??
      null,
    rawPercentage: attempt.resultRow?.raw_percentage ?? resultSnapshot.percentage ?? null,
    scaledScore: attempt.resultRow?.scaled_score ?? resultSnapshot.scaledScore ?? null,
    passed: attempt.resultRow?.passed ?? resultSnapshot.passed ?? null,
    passMark: attempt.resultRow?.pass_mark ?? resultSnapshot.passingScore ?? null,
    domainBreakdown,
    weakAreas,
    pbqBreakdown: toObject(
      attempt.resultRow?.pbq_breakdown ??
        resultSnapshot.pbqBreakdown ??
        resultSnapshot.pbqSummary,
    ),
    caseStudyBreakdown: toObject(
      attempt.resultRow?.case_study_breakdown ??
        resultSnapshot.caseStudyBreakdown ??
        resultSnapshot.caseStudySummary,
    ),
    reportTitle: attempt.reportRow?.report_title ?? '',
    pdfGenerated: Boolean(attempt.reportRow?.pdf_generated),
    resultSnapshot,
    reportSnapshot,
    responses: includeDetail ? responseRows.map(normalizeSavedResponse) : [],
  };
}

function normalizeSavedResponse(response = {}) {
  return {
    id: response.id,
    attemptId: response.attempt_id,
    questionId: response.question_id,
    questionType: response.question_type,
    responseSnapshot: toObject(response.response_snapshot),
    presentedSnapshot: toObject(response.presented_snapshot),
    isAnswered: response.is_answered,
    isScored: response.is_scored,
    createdAt: response.created_at,
  };
}

function getAttemptSelectColumns() {
  return [
    'id',
    'exam_catalog_id',
    'exam_key',
    'exam_version',
    'profile_id',
    'mode_label',
    'status',
    'started_at',
    'submitted_at',
    'duration_seconds',
    'time_limit_minutes',
    'selected_question_ids',
    'created_at',
  ].join(',');
}

function createAttemptCursor(attempt) {
  return attempt?.submitted_at && attempt?.id
    ? { submittedAt: attempt.submitted_at, attemptId: attempt.id }
    : null;
}

function normalizePageSize(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.min(Math.max(parsed, 1), 50) : SAVED_RESULTS_REQUEST_PAGE_SIZE;
}

function groupFirstBy(rows = [], key) {
  const map = new Map();

  rows.forEach((row) => {
    if (row?.[key] && !map.has(row[key])) {
      map.set(row[key], row);
    }
  });

  return map;
}

function groupManyBy(rows = [], key) {
  const map = new Map();

  rows.forEach((row) => {
    if (!row?.[key]) {
      return;
    }

    const group = map.get(row[key]) ?? [];
    group.push(row);
    map.set(row[key], group);
  });

  return map;
}

function toObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function createSupabaseError(error, fallbackMessage) {
  return {
    ok: false,
    reason: 'supabase_error',
    message: error?.message || fallbackMessage,
    errorCode: error?.code,
  };
}
