const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = new Set(['active', 'awaiting_processing', 'processing', 'needs_attention', 'completed', 'unmanaged', 'closed']);
const KEYS = ['contractVersion', 'attemptId', 'examKey', 'packageVersion', 'profileKey', 'profileName', 'purpose', 'assignmentId', 'deadline', 'observedAt', 'expiryManaged', 'closureReason', 'answeringAllowed', 'state', 'resultAvailable', 'completedAt'];
export const PENDING_COMPLETION_STATES = new Set(['awaiting_processing', 'processing', 'needs_attention']);
export const COMPLETION_POLL_DELAYS = Object.freeze([2000, 4000, 8000, 16000, 30000]);
export const COMPLETION_ACCESS_DENIALS = new Set(['unauthenticated', 'inactive_account', 'not_allowlisted', 'access_not_granted', 'origin_not_allowed', 'attempt_not_found']);
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const date = (v) => typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v));
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
export function completionContractError() {
  return Object.assign(new Error('Completion status could not be verified.'), { code: 'invalid_completion_status' });
}
export function normalizeCompletionStatus(value, expectedAttemptId) {
  if (!object(value) || Object.keys(value).length !== KEYS.length || Object.keys(value).some((k) => !KEYS.includes(k)) ||
    value.contractVersion !== 1 || !UUID.test(value.attemptId) || (expectedAttemptId && value.attemptId !== expectedAttemptId) ||
    !text(value.examKey, 64) || !text(value.packageVersion, 64) || !text(value.profileKey, 128) || !text(value.profileName, 256) ||
    !['assigned_assessment', 'self_directed_exam', 'study_sandbox', 'targeted_domain', 'weak_area', 'pbq_practice'].includes(value.purpose) ||
    (value.assignmentId !== null && !UUID.test(value.assignmentId)) ||
    (value.deadline !== null && !date(value.deadline)) || !date(value.observedAt) ||
    typeof value.expiryManaged !== 'boolean' || ![null, 'manual_submission', 'time_limit_expiry', 'closed'].includes(value.closureReason) || typeof value.answeringAllowed !== 'boolean' ||
    !STATES.has(value.state) || typeof value.resultAvailable !== 'boolean' ||
    (value.completedAt !== null && !date(value.completedAt))) throw completionContractError();
  if (value.expiryManaged && (!date(value.deadline) || !['assigned_assessment', 'self_directed_exam'].includes(value.purpose))) throw completionContractError();
  if (value.resultAvailable !== (value.state === 'completed') || value.resultAvailable !== (value.completedAt !== null) ||
    value.answeringAllowed !== (value.state === 'active') ||
    (value.answeringAllowed && (!value.expiryManaged || value.closureReason !== null || Date.parse(value.deadline) <= Date.parse(value.observedAt))) ||
    (PENDING_COMPLETION_STATES.has(value.state) && (!value.expiryManaged || value.closureReason === null || (value.closureReason === 'time_limit_expiry' && Date.parse(value.deadline) > Date.parse(value.observedAt)))) ||
    (value.state === 'unmanaged' && value.expiryManaged)) throw completionContractError();
  return Object.freeze({ ...value });
}
export function normalizeCompletionStatusResponse(value, expectedAttemptId) {
  if (!object(value) || Object.keys(value).length !== 1 || !('status' in value)) throw completionContractError();
  return normalizeCompletionStatus(value.status, expectedAttemptId);
}
export function normalizePendingCompletionPage(value, watchAttemptIds = []) {
  const keys = ['contractVersion', 'observedAt', 'items', 'watched', 'returnedCount', 'nextCursor'];
  if (!object(value) || Object.keys(value).length !== keys.length || Object.keys(value).some((k) => !keys.includes(k)) ||
    value.contractVersion !== 1 || !date(value.observedAt) || !Array.isArray(value.items) || value.items.length > 20 ||
    value.returnedCount !== value.items.length || !Array.isArray(value.watched) || value.watched.length > 20 ||
    (value.nextCursor !== null && (!text(value.nextCursor, 160) || value.nextCursor.split('|').length !== 2))) throw completionContractError();
  const items = value.items.map((v) => normalizeCompletionStatus(v));
  const watched = value.watched.map((v) => normalizeCompletionStatus(v));
  if (items.some((v) => !PENDING_COMPLETION_STATES.has(v.state) || v.observedAt !== value.observedAt) ||
    watched.some((v) => !watchAttemptIds.includes(v.attemptId) || v.observedAt !== value.observedAt) ||
    new Set(items.map((v) => v.attemptId)).size !== items.length ||
    new Set(watched.map((v) => v.attemptId)).size !== watched.length ||
    watched.length !== new Set(watchAttemptIds).size) throw completionContractError();
  if (value.nextCursor) {
    const [deadline, id] = value.nextCursor.split('|');
    if (!date(deadline) || !UUID.test(id)) throw completionContractError();
  }
  return Object.freeze({ ...value, items, watched });
}
export function isExplicitCompletionContractUnsupported(error) {
  return error?.code === 'status_contract_unsupported' ||
    (error?.httpStatus === 404 && error?.code === 'invalid_request');
}
export function completionStatusMessage(status) {
  if (!status) return 'Time expired. Checking the status of your saved work.';
  return {
    active: 'Answering remains locked while the server deadline is checked.',
    awaiting_processing: 'Your saved work is awaiting marking.',
    processing: 'Your saved work is being processed.',
    needs_attention: 'Marking needs attention. A final result is not available yet.',
    completed: 'A completed result is available. Checking the authoritative result.',
    closed: 'This attempt is closed. No final result is available.',
    unmanaged: 'This attempt uses the existing completion process.',
  }[status.state];
}
export function requireMatchingCompletionResult(candidate, attemptId) {
  if (!object(candidate) || candidate.serverAuthoritative !== true || candidate.attemptId !== attemptId ||
    !date(candidate.completedAt)) throw completionContractError();
  if (!Number.isFinite(candidate.rawScore) || !Number.isFinite(candidate.maxScore) ||
    candidate.rawScore < 0 || candidate.maxScore <= 0 || candidate.rawScore > candidate.maxScore ||
    !Number.isFinite(candidate.rawPercentage) || candidate.rawPercentage < 0 || candidate.rawPercentage > 100 ||
    ![true, false, null].includes(candidate.passed)) throw completionContractError();
  return candidate;
}

// Server observation is anchored to the start of its request. Subtracting the
// whole request duration is conservative; a local wall-clock rollback grants no time.
export function completionDeadlineAnchor(status, requestStartedAt, now = performance.now()) {
  normalizeCompletionStatus(status, status.attemptId);
  return Object.freeze({
    attemptId: status.attemptId,
    deadlineAt: requestStartedAt + Math.max(0, Date.parse(status.deadline) - Date.parse(status.observedAt)),
    receivedAt: now,
  });
}
