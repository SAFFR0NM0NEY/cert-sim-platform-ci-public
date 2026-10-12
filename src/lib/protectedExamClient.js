import { supabaseConfig } from './supabaseConfig.js';

const FUNCTION_NAME = 'certsim-protected-exam';
const TIMEOUT_MS = 15_000;
const PYTHON_RUN_TIMEOUT_MS = 60_000;
const SUBMISSION_TIMEOUT_MS = 120_000;
const RETRY_SAFE_GRADING_CODES = new Set([
  'grading_failed',
  'grading_incomplete',
  'grading_reconciliation_required',
  'submission_in_progress',
]);

const REASON_MESSAGES = Object.freeze({
  unauthenticated: 'Your session has expired. Sign in again before continuing.',
  inactive_account: 'Your CertSim account is not active for protected delivery.',
  not_allowlisted: 'This protected exam is not available to your account.',
  pilot_disabled: 'Protected delivery is not currently available for this exam.',
  not_assigned: 'No active protected-exam assignment was found.',
  access_not_granted: 'This protected exam requires an active assignment or entitlement.',
  no_published_package: 'The assigned exam package is not available.',
  attempt_not_found: 'No resumable protected attempt was found.',
  attempt_expired: 'This protected attempt has expired.',
  attempt_conflict: 'The attempt changed in another request. Refresh before continuing.',
  attempt_limit_reached: 'The assignment attempt limit has been reached.',
  sandbox_discarded: 'This Study Sandbox was permanently discarded and cannot be recovered.',
  sandbox_not_recoverable: 'This saved Study Sandbox is no longer recoverable.',
  active_sandbox_exists: 'An active Study Sandbox already exists for this exam profile.',
  practice_unavailable: 'Personal practice is not currently available for this exam profile.',
  no_weak_areas: 'Complete a marked exam with missed questions or a domain below 70% before starting Weak Area Practice.',
  weak_domain_unavailable: 'This weak domain has no eligible questions in the current protected package.',
  scope_required: 'Select an organisation before loading performance data.',
  not_visible: 'This learner is no longer visible in the selected staff scope.',
  assignment_conflict: 'The protected assignment is not available.',
  replacement_not_permitted: 'A new attempt is not permitted for this active attempt.',
  replacement_failed: 'The new attempt could not be created. Your existing attempt remains available.',
  abandon_failed: 'The attempt could not be ended safely. It remains resumable.',
  stale_response: 'A newer answer is already saved. Refresh before continuing.',
  revision_conflict: 'A newer Python workspace revision is already saved. Review it before continuing.',
  workspace_request_conflict: 'This workspace save request was already used for different content.',
  executor_disabled: 'Python execution is not available yet. Your saved workspace is retained.',
  run_not_found: 'This Python run is no longer available.',
  run_request_conflict: 'This Python run request was already used for a different revision.',
  run_in_progress: 'A Python run is already in progress for this task.',
  python_workspace_required: 'A saved Python workspace is required for this action.',
  submission_in_progress: 'Trusted grading is still in progress. Completion is not yet confirmed. Continue the same submission when ready.',
  grading_material_invalid: 'A saved Python task cannot be graded because its grading contract is invalid.',
  grading_incomplete: 'Trusted grading is incomplete for one or more saved Python tasks. Continue the same submission when ready.',
  grading_binding_mismatch: 'Trusted grading could not verify the saved Python workspace binding.',
  grading_reconciliation_required: 'Trusted grading requires safe reconciliation. Completion is not yet confirmed.',
  grading_failed: 'Trusted Python grading could not be completed. Your saved work is retained and completion is not yet confirmed.',
  already_submitted: 'This attempt has already been submitted.',
  review_unavailable: 'Question review is withheld for this attempt.',
  invalid_lifecycle_transition: 'This attempt can no longer accept that action. Refresh its current state.',
  invalid_request: 'The protected exam request was not valid. Refresh before trying again.',
  origin_not_allowed: 'This CertSim site address is not authorized for protected delivery.',
  rate_limited: 'Too many requests were made. Wait briefly and try again.',
  start_not_committed: 'The protected attempt was not created. Please return to the exam dashboard.',
  start_state_conflict: 'The protected attempt state could not be verified. Please return to the exam dashboard.',
  submission_state_conflict: 'The protected submission state could not be verified. Return to Saved Results before trying again.',
});

export function createProtectedExamClient({ accessToken, getAccessToken, fetchImpl = fetch } = {}) {
  const tokenProvider = typeof getAccessToken === 'function'
    ? getAccessToken
    : async () => accessToken;
  if (typeof getAccessToken !== 'function' && (!accessToken || typeof accessToken !== 'string')) {
    throw new Error('protected_session_required');
  }
  const baseUrl = `${supabaseConfig.supabaseUrl}/functions/v1/${FUNCTION_NAME}`;

  async function request(path, { method = 'GET', body, signal, timeoutMs = TIMEOUT_MS } = {}) {
    const maximumTransportAttempts = method === 'GET' ? 2 : 1;
    let transportAttempt = 0;
    let authenticationRecoveryUsed = false;
    let rejectedAccessToken = '';
    while (transportAttempt < maximumTransportAttempts) {
      const requestAccessToken = await resolveRequestAccessToken(tokenProvider, {
        forceRefresh: authenticationRecoveryUsed,
        rejectedAccessToken,
      });
      const timeout = AbortSignal.timeout(timeoutMs);
      const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let response;
      try {
        transportAttempt += 1;
        response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        signal: combinedSignal,
        headers: {
          Authorization: `Bearer ${requestAccessToken}`,
          apikey: supabaseConfig.supabaseAnonKey,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch (error) {
        if (transportAttempt < maximumTransportAttempts && !signal?.aborted) continue;
        const code = error?.name === 'TimeoutError' ? 'request_timeout' : 'network_failure';
        throw createClientError(code, 'The protected exam service could not be reached.', {
          ambiguousTransport: true,
        });
      }
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        if (
          response.status === 401 &&
          !authenticationRecoveryUsed &&
          !signal?.aborted &&
          isAuthenticationRetrySafe(method, body)
        ) {
          authenticationRecoveryUsed = true;
          rejectedAccessToken = requestAccessToken;
          transportAttempt -= 1;
          continue;
        }
        if (transportAttempt < maximumTransportAttempts && response.status >= 500) continue;
        const code = response.status === 401
          ? 'unauthenticated'
          : payload?.error?.code ?? 'internal_failure';
        throw createClientError(code, REASON_MESSAGES[code] ?? 'The protected exam request failed.', {
          httpStatus: response.status,
        });
      }
      return payload;
    }
    throw createClientError('internal_failure', 'The protected exam request failed.');
  }

  const query = (examKey, packageVersion, profileId, purpose) =>
    `?${new URLSearchParams({ examKey, packageVersion, profileId, purpose }).toString()}`;
  const currentQuery = (examKey, profileId, binding) => `?${new URLSearchParams(compactParams({
    examKey,
    profileId,
    purpose: binding.purpose,
    language: binding.language,
    ...(binding.assignmentId ? { assignmentId: binding.assignmentId } : {}),
  })).toString()}`;

  return Object.freeze({
    getEligibility: (examKey, packageVersion, profileId, purpose, options) =>
      request(`/eligibility${query(examKey, packageVersion, profileId, purpose)}`, options),
    getCurrentAttempt: (examKey, profileId, binding, options) =>
      request(`/attempts/current${currentQuery(examKey, profileId, binding)}`, options),
    listCurrentAttemptBindings: (examKey, purpose, options) =>
      request(`/attempts/current-bindings?${new URLSearchParams({ examKey, purpose }).toString()}`, options),
    startAttempt: (examKey, profileId, clientRequestId, options = {}) =>
      request('/attempts', { ...options, method: 'POST', body: { examKey, profileId, clientRequestId, ...(options.assignmentId ? { assignmentId: options.assignmentId } : {}) } }),
    resumeAttempt: (attemptId, options) => request(`/attempts/${attemptId}`, options),
    getAttemptItemPage: (attemptId, afterPosition, pageSize = 20, options) =>
      request(`/attempts/${attemptId}/items?${new URLSearchParams({ afterPosition, pageSize }).toString()}`, options),
    saveResponse: (attemptId, itemId, response, expectedRevision, requestId, options) =>
      request(`/attempts/${attemptId}/items/${itemId}/response`, {
        ...options, method: 'PUT', body: { response, expectedRevision, requestId },
      }),
    getPythonWorkspace: (attemptId, itemId, options) =>
      request(`/attempts/${attemptId}/items/${itemId}/python/workspace`, options),
    savePythonWorkspace: (attemptId, itemId, workspace, expectedRevision, requestId, options) =>
      request(`/attempts/${attemptId}/items/${itemId}/python/workspace`, {
        ...options, method: 'PUT', body: { workspace, expectedRevision, requestId },
      }),
    requestPythonRun: (attemptId, itemId, expectedRevision, requestId, options) =>
      request(`/attempts/${attemptId}/items/${itemId}/python/runs`, {
        ...options, method: 'POST', body: { expectedRevision, requestId },
        timeoutMs: PYTHON_RUN_TIMEOUT_MS,
      }),
    getLatestPythonRun: (attemptId, itemId, options) =>
      request(`/attempts/${attemptId}/items/${itemId}/python/runs/latest`, options),
    getPythonRun: (attemptId, itemId, runId, options) =>
      request(`/attempts/${attemptId}/items/${itemId}/python/runs/${runId}`, options),
    cancelPythonRun: (attemptId, itemId, runId, requestId, options) =>
      request(`/attempts/${attemptId}/items/${itemId}/python/runs/${runId}/cancel`, {
        ...options, method: 'POST', body: { requestId },
      }),
    listFlags: (attemptId, options) => request(`/attempts/${attemptId}/flags`, options),
    setFlag: (attemptId, itemId, flagged, requestId, options) => request(`/attempts/${attemptId}/items/${itemId}/flag`, { ...options, method: 'PUT', body: { flagged, requestId } }),
    reportQuestionIssue: (attemptId, itemId, message, requestId, options) => request(`/attempts/${attemptId}/items/${itemId}/issue`, { ...options, method: 'POST', body: { message, requestId } }),
    abandonAttempt: (attemptId, requestId, options) => request(`/attempts/${attemptId}/abandon`, { ...options, method: 'POST', body: { requestId } }),
    getAttemptLifecycleSummary: (attemptId, options) => request(`/attempts/${attemptId}/lifecycle-summary`, options),
    submitAttempt: (attemptId, submissionId, options) =>
      request(`/attempts/${attemptId}/submit`, {
        ...options,
        method: 'POST',
        body: { submissionId },
        timeoutMs: SUBMISSION_TIMEOUT_MS,
      }),
    getResult: (attemptId, options) => request(`/attempts/${attemptId}/result`, options),
    getReview: (attemptId, options) => request(`/attempts/${attemptId}/review`, options),
    getWeakAreaOptions: (examKey, profileId, options) => request(`/practice/weak-areas?${new URLSearchParams({ examKey, profileId }).toString()}`, options),
    getPracticeAvailability: (configuration, options) => request(`/practice/availability?${new URLSearchParams(compactParams(configuration)).toString()}`, options),
    startPractice: (configuration, options) => request('/practice/sessions', { ...options, method: 'POST', body: configuration }),
    replacePractice: (configuration, options) => request('/practice/sessions/replace', { ...options, method: 'POST', body: configuration }),
    checkPracticeItem: (attemptId, itemId, expectedRevision, requestId, options) => request(`/practice/sessions/${attemptId}/items/${itemId}/check`, { ...options, method: 'POST', body: { expectedRevision, requestId } }),
    listRecoverableStudySandboxes: (examKey, profileId, options) => request(`/practice/recoverable-sandboxes?${new URLSearchParams({ examKey, profileId }).toString()}`, options),
    recoverStudySandbox: (attemptId, requestId, options) => request(`/practice/sessions/${attemptId}/recover`, { ...options, method: 'POST', body: { requestId } }),
    listHistory: ({ cursor, pageSize = 20, examKey } = {}, options) => request(`/history?${new URLSearchParams(Object.fromEntries(Object.entries({ cursor, pageSize, examKey }).filter(([, value]) => value != null))).toString()}`, options),
    listStaffHistory: ({ cursor, pageSize = 25 } = {}, options) => request(`/staff/history?${new URLSearchParams(Object.fromEntries(Object.entries({ cursor, pageSize }).filter(([, value]) => value != null))).toString()}`, options),
    getStaffAnalytics: (options) => request('/staff/analytics', options),
    getStaffDashboardScope: (scope = {}, options) => request(`/staff/dashboard-scope?${new URLSearchParams(Object.fromEntries(Object.entries(scope).filter(([, value]) => value != null && value !== ''))).toString()}`, options),
    getStaffScopeOptions: (scope = {}, options) => request(`/staff/scope-options?${new URLSearchParams(compactParams(scope)).toString()}`, options),
    getStaffDashboardQuery: (scope = {}, options) => request(`/staff/dashboard-query?${new URLSearchParams(compactParams(scope)).toString()}`, options),
    getStaffLearnerDetail: (scope = {}, options) => request(`/staff/learner-detail?${new URLSearchParams(compactParams(scope)).toString()}`, options),
    getHistorySummary: (examKey, options) => request(`/history/summary?${new URLSearchParams({ examKey }).toString()}`, options),
    getPrintableSummary: (attemptId, options) => request(`/attempts/${attemptId}/print-summary`, options),
  });
}

function isAuthenticationRetrySafe(method, body) {
  if (method === 'GET') return true;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return ['requestId', 'clientRequestId', 'submissionId']
    .some((key) => typeof body[key] === 'string' && body[key].length > 0);
}

async function resolveRequestAccessToken(tokenProvider, context) {
  let token;
  try {
    token = await tokenProvider(context);
  } catch (error) {
    if (error?.code === 'unauthenticated') throw error;
    throw createClientError('unauthenticated', REASON_MESSAGES.unauthenticated);
  }
  if (!token || typeof token !== 'string' || (context.forceRefresh && token === context.rejectedAccessToken)) {
    throw createClientError('unauthenticated', REASON_MESSAGES.unauthenticated);
  }
  return token;
}

function compactParams(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry != null));
}

export async function startProtectedAttemptWithRecovery(
  client,
  examKey,
  profileId,
  clientRequestId,
  currentBinding,
  options,
) {
  try {
    return {
      payload: await client.startAttempt(examKey, profileId, clientRequestId, options),
      recovered: false,
    };
  } catch (startError) {
    if (!isAmbiguousStartFailure(startError)) throw startError;
    try {
      return {
        payload: await client.getCurrentAttempt(examKey, profileId, currentBinding, options),
        recovered: true,
      };
    } catch (lookupError) {
      if (lookupError?.code === 'attempt_not_found') {
        throw createClientError('start_not_committed', REASON_MESSAGES.start_not_committed);
      }
      throw createClientError('start_state_conflict', REASON_MESSAGES.start_state_conflict);
    }
  }
}

export async function submitProtectedAttemptWithRecovery(
  client,
  attemptId,
  submissionId,
  options,
) {
  try {
    return {
      payload: await client.submitAttempt(attemptId, submissionId, options),
      recovered: false,
    };
  } catch (submitError) {
    if (isRetrySafeSubmissionError(submitError)) throw submitError;
    if (submitError?.code !== 'already_submitted' && !isAmbiguousStartFailure(submitError)) {
      throw submitError;
    }
    try {
      return {
        payload: await client.getResult(attemptId, options),
        recovered: true,
      };
    } catch (lookupError) {
      if (lookupError?.code === 'attempt_not_found') {
        throw createClientError(
          'submission_in_progress',
          REASON_MESSAGES.submission_in_progress,
        );
      }
      if (isRetrySafeResultLookupError(lookupError)) throw lookupError;
      throw createClientError(
        'submission_state_conflict',
        REASON_MESSAGES.submission_state_conflict,
      );
    }
  }
}

export function isRetrySafeSubmissionError(error) {
  return RETRY_SAFE_GRADING_CODES.has(error?.code);
}

export function isRetrySafeResultLookupError(error) {
  if (
    error?.ambiguousTransport === true &&
    ['network_failure', 'request_timeout'].includes(error?.code)
  ) return true;
  return error?.code === 'internal_failure' && Number(error?.httpStatus) >= 500;
}

export function isAmbiguousStartFailure(error) {
  return error?.ambiguousTransport === true || Number(error?.httpStatus) >= 500;
}

export function getProtectedReasonMessage(code) {
  return REASON_MESSAGES[code] ?? 'Protected delivery is unavailable right now.';
}

function createClientError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}
