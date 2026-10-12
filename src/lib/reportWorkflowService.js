import { createQuestionReport } from './resultStorageService.js';
import { isSupabaseConfigured, supabase } from './supabaseClient.js';

export const REPORT_STATUS_OPTIONS = [
  { value: 'open', label: 'Open', userLabel: 'Received' },
  { value: 'in_review', label: 'In review', userLabel: 'In review' },
  { value: 'need_info', label: 'Need info', userLabel: 'Need more information' },
  { value: 'resolved', label: 'Resolved', userLabel: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed', userLabel: 'Closed / Not an issue' },
];

export const REPORT_PRIORITY_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

const unavailableResult = {
  ok: false,
  reason: 'supabase_not_configured',
  message: 'Saved report status is not configured for this environment yet.',
};

const signedOutResult = {
  ok: false,
  reason: 'not_signed_in',
  message: 'Sign in to view or submit saved reports.',
};

export async function getMyReports() {
  const authResult = await requireAuthenticatedUser();

  if (!authResult.ok) {
    return authResult;
  }

  const { data, error } = await supabase.rpc('get_my_report_statuses');

  if (error) {
    return createSupabaseError(
      error,
      'Could not load your reports. Ask Jean to apply migration 0010.',
    );
  }

  return {
    ok: true,
    data: Array.isArray(data) ? data.map(normalizeUserReport) : [],
  };
}

export async function createSavedQuestionReport(payload = {}) {
  const title = cleanText(payload.title);
  const message = cleanText(payload.message);

  if (!message) {
    return {
      ok: false,
      reason: 'invalid_payload',
      message: 'Add a short comment before submitting the question report.',
    };
  }

  const result = await createQuestionReport({
    attempt_id: optionalUuid(payload.attemptId),
    exam_key: cleanText(payload.examKey),
    exam_title: optionalText(payload.examTitle),
    question_id: optionalText(payload.questionId),
    question_type: optionalText(payload.questionType),
    report_type: normalizeReportType(payload.reportType),
    title: title || createQuestionReportTitle(payload),
    message,
    status: 'open',
    priority: normalizePriority(payload.priority),
    route_path: optionalText(payload.routePath),
    result_id: optionalUuid(payload.resultId),
    metadata: {
      ...(isPlainObject(payload.metadata) ? payload.metadata : {}),
      source: 'exam-review-question-report',
    },
  });

  if (!result.ok) {
    return {
      ...result,
      message:
        result.reason === 'not_signed_in'
          ? 'Sign in to submit a saved question report.'
          : result.message,
    };
  }

  return {
    ok: true,
    data: normalizeUserReport({
      ...result.data,
      source: 'question_reports',
    }),
  };
}

export function getReportStatusLabel(status) {
  const option = REPORT_STATUS_OPTIONS.find(
    (statusOption) => statusOption.value === normalizeStatus(status),
  );

  return option?.label ?? 'Open';
}

export function getReporterStatusLabel(status) {
  const option = REPORT_STATUS_OPTIONS.find(
    (statusOption) => statusOption.value === normalizeStatus(status),
  );

  return option?.userLabel ?? 'Received';
}

export function getReportPriorityLabel(priority) {
  const option = REPORT_PRIORITY_OPTIONS.find(
    (priorityOption) => priorityOption.value === normalizePriority(priority),
  );

  return option?.label ?? 'Normal';
}

export function normalizeUserReport(row = {}) {
  const status = normalizeStatus(row.status);
  const priority = normalizePriority(row.priority);
  const source = cleanText(row.source) || inferReportSource(row);

  return {
    id: row.id ?? '',
    source,
    sourceLabel: getReportSourceLabel(source),
    reportType: normalizeReportType(row.report_type ?? row.reportType),
    reportTypeLabel: formatToken(row.report_type ?? row.reportType),
    title: cleanText(row.title) || createQuestionReportTitle(row),
    message: row.message ?? '',
    status,
    statusLabel: getReportStatusLabel(status),
    reporterStatusLabel: getReporterStatusLabel(status),
    priority,
    priorityLabel: getReportPriorityLabel(priority),
    reporterFeedback: row.reporter_feedback ?? row.reporterFeedback ?? '',
    routePath: row.route_path ?? row.routePath ?? '',
    examKey: row.exam_key ?? row.examKey ?? '',
    examTitle: row.exam_title ?? row.examTitle ?? '',
    questionId: row.question_id ?? row.questionId ?? '',
    questionType: row.question_type ?? row.questionType ?? '',
    attemptId: row.attempt_id ?? row.attemptId ?? '',
    resultId: row.result_id ?? row.resultId ?? '',
    createdAt: row.created_at ?? row.createdAt ?? '',
    updatedAt: row.updated_at ?? row.updatedAt ?? '',
    resolvedAt: row.resolved_at ?? row.resolvedAt ?? '',
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

function createSupabaseError(error, fallbackMessage) {
  return {
    ok: false,
    reason: getReasonFromError(error),
    message: error?.message || fallbackMessage,
    errorCode: error?.code,
  };
}

function getReasonFromError(error) {
  if (error?.code === '42P01' || error?.code === '42883' || error?.code === '42703') {
    return 'schema_missing';
  }

  if (error?.code === '42501' || /permission|policy|rls|authorized/i.test(error?.message ?? '')) {
    return 'not_authorized';
  }

  return 'request_failed';
}

function normalizeStatus(status) {
  const normalized = cleanText(status);

  if (normalized === 'reviewing') {
    return 'in_review';
  }

  if (normalized === 'archived') {
    return 'dismissed';
  }

  return REPORT_STATUS_OPTIONS.some((option) => option.value === normalized)
    ? normalized
    : 'open';
}

function normalizePriority(priority) {
  const normalized = cleanText(priority);

  return REPORT_PRIORITY_OPTIONS.some((option) => option.value === normalized)
    ? normalized
    : 'normal';
}

function normalizeReportType(reportType) {
  const normalized = cleanText(reportType);

  if (normalized === 'bug') {
    return 'platform_bug';
  }

  if (normalized === 'scoring_issue') {
    return 'result_issue';
  }

  if (normalized === 'content_feedback') {
    return 'question_issue';
  }

  return [
    'question_issue',
    'platform_bug',
    'result_issue',
    'access_issue',
    'other',
  ].includes(normalized)
    ? normalized
    : 'other';
}

function inferReportSource(row) {
  return row.question_id || row.questionId ? 'question_reports' : 'platform_issue_reports';
}

function getReportSourceLabel(source) {
  return source === 'question_reports' ? 'Question report' : 'Platform issue';
}

function createQuestionReportTitle(payload = {}) {
  const questionId = payload.questionId ?? payload.question_id;

  return questionId ? `Question ${questionId}` : 'Question report';
}

function optionalText(value) {
  const text = cleanText(value);

  return text || null;
}

function optionalUuid(value) {
  const text = cleanText(value);

  return text || null;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function formatToken(value) {
  const token = cleanText(value);

  if (!token) {
    return 'Not set';
  }

  return token
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
