import { getCurrentIdentitySummary } from './profileService.js';
import {
  REPORT_PRIORITY_OPTIONS,
  REPORT_STATUS_OPTIONS,
  getReportPriorityLabel,
  getReportStatusLabel,
} from './reportWorkflowService.js';
import { hasDeveloperDashboardAccess } from './roleUtils.js';
import { isSupabaseConfigured, supabase } from './supabaseClient.js';

const PLATFORM_ISSUE_INSERT_FIELDS = `
  id,
  user_id,
  report_type,
  title,
  message,
  status,
  priority,
  reporter_feedback,
  route_path,
  exam_key,
  question_id,
  attempt_id,
  result_id,
  created_at,
  updated_at,
  resolved_at
`;

const ACCOUNT_DELETION_REQUEST_FIELDS = `
  id,
  profile_id,
  user_id,
  email_snapshot,
  reason,
  status,
  requested_at,
  reviewed_by,
  reviewed_at,
  admin_notes,
  profile:profiles!account_deletion_requests_profile_id_fkey(id,email,full_name,display_name,status),
  reviewer:profiles!account_deletion_requests_reviewed_by_fkey(id,email,full_name,display_name,status)
`;

const allowedIssueTypes = [
  'question_issue',
  'platform_bug',
  'result_issue',
  'access_issue',
  'other',
];

const allowedStatuses = REPORT_STATUS_OPTIONS.map((option) => option.value);
const allowedPriorities = REPORT_PRIORITY_OPTIONS.map((option) => option.value);
const allowedDeletionRequestStatuses = [
  'open',
  'in_review',
  'completed',
  'cancelled',
];

const unavailableResult = {
  ok: false,
  reason: 'supabase_not_configured',
  message: 'Developer Dashboard is not configured for this environment yet.',
};

const signedOutResult = {
  ok: false,
  reason: 'not_signed_in',
  message: 'Sign in with a Developer or Platform Owner account to view the Developer Dashboard.',
};

const unauthorizedResult = {
  ok: false,
  reason: 'not_authorized',
  message: 'This account is not linked to an active Developer or Platform Owner membership.',
};

export async function getDeveloperDashboardSnapshot() {
  const authResult = await requireDeveloperDashboardAccess();

  if (!authResult.ok) {
    return authResult;
  }

  const [
    reportQueueResult,
    deletionRequestsResult,
  ] = await Promise.all([
    readDeveloperReportQueue(),
    readAccountDeletionRequests(),
  ]);
  const failedResult = [
    reportQueueResult,
    deletionRequestsResult,
  ].find((result) => !result.ok);

  if (failedResult) {
    return failedResult;
  }

  const reports = reportQueueResult.data
    .sort((a, b) => compareDatesDescending(a.createdAt, b.createdAt));

  return createOkResult({
    identity: authResult.data.identity,
    deletionRequests: deletionRequestsResult.data,
    deletionTotals: createDeletionRequestTotals(deletionRequestsResult.data),
    reports,
    totals: createReportTotals(reports),
  });
}

export async function createPlatformIssueReport(payload = {}) {
  if (!isSupabaseConfigured || !supabase) {
    return { ...unavailableResult };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData?.user ?? null;

  if (userError) {
    return createErrorResult(
      'request_failed',
      userError.message || 'Could not read the current account.',
      userError.code,
    );
  }

  if (!user) {
    return {
      ...signedOutResult,
      message: 'Sign in to submit a saved issue report.',
    };
  }

  const reportType = normalizeReportType(payload.reportType);
  const title = cleanText(payload.title);
  const message = cleanText(payload.message);

  if (!title || !message) {
    return createErrorResult(
      'invalid_payload',
      'Enter a short title and issue details.',
    );
  }

  const { data, error } = await supabase
    .from('platform_issue_reports')
    .insert({
      user_id: user.id,
      report_type: reportType,
      title,
      message,
      status: 'open',
      priority: 'normal',
      reporter_feedback: null,
      route_path: optionalText(payload.routePath),
      exam_key: optionalText(payload.examKey),
      question_id: optionalText(payload.questionId),
      attempt_id: optionalText(payload.attemptId),
      result_id: optionalText(payload.resultId),
      metadata: {
        source: 'account-report-issue',
      },
    })
    .select(PLATFORM_ISSUE_INSERT_FIELDS)
    .single();

  return createServiceResult(
    data
      ? normalizeDeveloperReport({
          ...data,
          source: 'platform_issue_reports',
        })
      : null,
    error,
    'Could not save the issue report. Ask Jean to confirm migration 0008 has been applied.',
  );
}

export async function updateDeveloperReportStatus({
  internalNotes = '',
  priority = 'normal',
  reporterFeedback = '',
  reportId,
  source,
  status,
} = {}) {
  const authResult = await requireDeveloperDashboardAccess();

  if (!authResult.ok) {
    return authResult;
  }

  const normalizedId = cleanText(reportId);
  const normalizedStatus = normalizeStatus(status);
  const normalizedPriority = normalizePriority(priority);
  const normalizedSource = cleanText(source);

  if (
    !normalizedId ||
    !allowedStatuses.includes(normalizedStatus) ||
    !allowedPriorities.includes(normalizedPriority)
  ) {
    return createErrorResult(
      'invalid_payload',
      'Choose a report, status, and priority.',
    );
  }

  const { data, error } = await supabase.rpc(
    'update_report_workflow',
    {
      target_internal_notes: internalNotes,
      target_priority: normalizedPriority,
      target_report_id: normalizedId,
      target_reporter_feedback: reporterFeedback,
      target_source: normalizedSource,
      target_status: normalizedStatus,
    },
  );

  return createServiceResult(
    data ?? null,
    error,
    'Could not update the report workflow. Ask Jean to apply migration 0010.',
  );
}

export async function updateAccountDeletionRequestStatus({
  adminNotes = '',
  requestId,
  status,
} = {}) {
  const authResult = await requireDeveloperDashboardAccess();

  if (!authResult.ok) {
    return authResult;
  }

  const normalizedId = cleanText(requestId);
  const normalizedStatus = cleanText(status);

  if (
    !normalizedId ||
    !allowedDeletionRequestStatuses.includes(normalizedStatus)
  ) {
    return createErrorResult(
      'invalid_payload',
      'Choose an account deletion request and a valid status.',
    );
  }

  const { data, error } = await supabase.rpc(
    'update_account_deletion_request_status',
    {
      target_admin_notes: optionalText(adminNotes),
      target_request_id: normalizedId,
      target_status: normalizedStatus,
    },
  );

  return createServiceResult(
    Array.isArray(data) ? normalizeAccountDeletionRequest(data[0]) : normalizeAccountDeletionRequest(data),
    error,
    'Could not update the account deletion request.',
  );
}

async function requireDeveloperDashboardAccess() {
  if (!isSupabaseConfigured || !supabase) {
    return { ...unavailableResult };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser();
  const user = userData?.user ?? null;

  if (userError) {
    return createErrorResult(
      'request_failed',
      userError.message || 'Could not read the current account.',
      userError.code,
    );
  }

  if (!user) {
    return { ...signedOutResult };
  }

  const { data: identity, error: identityError } =
    await getCurrentIdentitySummary();

  if (!hasDeveloperDashboardAccess(identity)) {
    return {
      ...unauthorizedResult,
      message: identityError?.message || unauthorizedResult.message,
      errorCode: identityError?.code,
    };
  }

  return createOkResult({ user, identity });
}

async function readDeveloperReportQueue() {
  const { data, error } = await supabase.rpc('get_developer_report_queue');

  return createServiceResult(
    Array.isArray(data) ? data.map(normalizeDeveloperReport) : [],
    error,
    'Could not load support reports. Ask Jean to apply migration 0010.',
  );
}

async function readAccountDeletionRequests() {
  const { data, error } = await supabase
    .from('account_deletion_requests')
    .select(ACCOUNT_DELETION_REQUEST_FIELDS)
    .order('requested_at', { ascending: false })
    .limit(100);

  return createServiceResult(
    Array.isArray(data) ? data.map(normalizeAccountDeletionRequest) : [],
    error,
    'Could not load account deletion requests. Ask Jean to apply migration 0009.',
  );
}

function normalizeDeveloperReport(row = {}) {
  const source = cleanText(row.source) || 'platform_issue_reports';
  const status = normalizeStatus(row.status);
  const priority = normalizePriority(row.priority);

  return {
    id: row.id,
    source,
    sourceLabel:
      source === 'question_reports' ? 'Question report' : 'Platform issue',
    reportType: normalizeReportType(row.report_type),
    reportTypeLabel: formatToken(row.report_type),
    status,
    statusLabel: getReportStatusLabel(status),
    priority,
    priorityLabel: getReportPriorityLabel(priority),
    title:
      row.title ||
      (row.question_id
        ? `Question ${row.question_id}`
        : `${formatToken(row.exam_key)} report`),
    message: row.message ?? '',
    examKey: row.exam_key ?? '',
    examTitle: row.exam_title ?? '',
    questionId: row.question_id ?? '',
    questionType: row.question_type ?? '',
    attemptId: row.attempt_id ?? '',
    resultId: row.result_id ?? '',
    routePath: row.route_path ?? '',
    internalNotes: row.internal_notes ?? '',
    reporterFeedback: row.reporter_feedback ?? '',
    metadata: row.metadata ?? {},
    reporter: normalizeProfile({
      email: row.reporter_email,
      full_name: row.reporter_full_name,
      display_name: row.reporter_display_name,
      status: row.reporter_status,
    }),
    assignedTo: null,
    attempt: normalizeAttempt({
      id: row.attempt_id,
      exam_key: row.attempt_exam_key,
      mode_label: row.attempt_mode_label,
      status: row.attempt_status,
      submitted_at: row.attempt_submitted_at,
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? '',
  };
}

function normalizeAccountDeletionRequest(row = {}) {
  const profile = normalizeProfile(row?.profile);
  const reviewer = normalizeProfile(row?.reviewer);

  return {
    id: row?.id ?? '',
    profileId: row?.profile_id ?? '',
    userId: row?.user_id ?? '',
    emailSnapshot: row?.email_snapshot ?? profile?.email ?? '',
    reason: row?.reason ?? '',
    status: normalizeDeletionRequestStatus(row?.status),
    statusLabel: formatDeletionRequestStatus(row?.status),
    requestedAt: row?.requested_at ?? '',
    reviewedBy: row?.reviewed_by ?? '',
    reviewedAt: row?.reviewed_at ?? '',
    adminNotes: row?.admin_notes ?? '',
    profile,
    reviewer,
  };
}

function normalizeProfile(profile = {}) {
  if (!profile || typeof profile !== 'object') {
    return null;
  }

  const displayName =
    profile.display_name ||
    profile.full_name ||
    getNameFromEmail(profile.email) ||
    'Unknown user';

  return {
    id: profile.id,
    displayName,
    email: profile.email ?? '',
    status: profile.status ?? '',
  };
}

function normalizeAttempt(attempt = {}) {
  if (!attempt || typeof attempt !== 'object') {
    return null;
  }

  return {
    id: attempt.id,
    examKey: attempt.exam_key ?? '',
    modeLabel: attempt.mode_label ?? '',
    status: attempt.status ?? '',
    submittedAt: attempt.submitted_at ?? '',
  };
}

function createReportTotals(reports = []) {
  const byStatus = Object.fromEntries(allowedStatuses.map((status) => [status, 0]));
  const byType = {};

  reports.forEach((report) => {
    byStatus[report.status] = (byStatus[report.status] ?? 0) + 1;
    byType[report.reportType] = (byType[report.reportType] ?? 0) + 1;
  });

  return {
    total: reports.length,
    open: byStatus.open ?? 0,
    inReview: byStatus.in_review ?? 0,
    needInfo: byStatus.need_info ?? 0,
    resolved: byStatus.resolved ?? 0,
    dismissed: byStatus.dismissed ?? 0,
    recent: reports.slice(0, 5).length,
    questionReports: reports.filter((report) => report.source === 'question_reports').length,
    platformIssues: reports.filter((report) => report.source === 'platform_issue_reports').length,
    byType,
  };
}

function createDeletionRequestTotals(requests = []) {
  const byStatus = Object.fromEntries(
    allowedDeletionRequestStatuses.map((status) => [status, 0]),
  );

  requests.forEach((request) => {
    byStatus[request.status] = (byStatus[request.status] ?? 0) + 1;
  });

  return {
    total: requests.length,
    open: byStatus.open ?? 0,
    inReview: byStatus.in_review ?? 0,
    completed: byStatus.completed ?? 0,
    cancelled: byStatus.cancelled ?? 0,
  };
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

  return allowedIssueTypes.includes(normalized) ? normalized : 'other';
}

function normalizeStatus(status) {
  const normalized = cleanText(status);

  if (normalized === 'reviewing') {
    return 'in_review';
  }

  if (normalized === 'archived') {
    return 'dismissed';
  }

  return allowedStatuses.includes(normalized) ? normalized : 'open';
}

function normalizePriority(priority) {
  const normalized = cleanText(priority);

  return allowedPriorities.includes(normalized) ? normalized : 'normal';
}

function normalizeDeletionRequestStatus(status) {
  const normalized = cleanText(status);

  return allowedDeletionRequestStatuses.includes(normalized)
    ? normalized
    : 'open';
}

function formatDeletionRequestStatus(status) {
  return formatToken(normalizeDeletionRequestStatus(status));
}

function createOkResult(data) {
  return { ok: true, data };
}

function createServiceResult(data, error, fallbackMessage) {
  if (error) {
    return createErrorResult(
      getReasonFromError(error),
      error.message || fallbackMessage,
      error.code,
    );
  }

  return createOkResult(data);
}

function createErrorResult(reason, message, errorCode = '') {
  return {
    ok: false,
    reason,
    message,
    errorCode,
  };
}

function getReasonFromError(error) {
  if (error?.code === '42P01' || error?.code === '42703' || error?.code === '42883') {
    return 'schema_missing';
  }

  if (error?.code === '42501' || /permission|policy|rls|authorized/i.test(error?.message ?? '')) {
    return 'not_authorized';
  }

  return 'request_failed';
}

function optionalText(value) {
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

function compareDatesDescending(left, right) {
  return new Date(right ?? 0).getTime() - new Date(left ?? 0).getTime();
}

function getNameFromEmail(email = '') {
  return cleanText(email).split('@')[0] || '';
}
