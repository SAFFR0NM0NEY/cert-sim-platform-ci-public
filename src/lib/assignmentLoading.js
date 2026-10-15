export const ASSIGNMENT_LOAD_TIMEOUT_MS = 15000;

export async function runBoundedAssignmentRequest(
  request,
  {
    timeoutMs = ASSIGNMENT_LOAD_TIMEOUT_MS,
    createTimeout = createAssignmentTimeout,
  } = {},
) {
  try {
    const result = await Promise.race([Promise.resolve().then(request), createTimeout(timeoutMs)]);
    if (!result || typeof result.ok !== 'boolean') {
      return createAssignmentLoadError('malformed_response', 'Assigned exams returned an unexpected response.');
    }
    return result;
  } catch (error) {
    return createAssignmentLoadError(
      'request_failed',
      error?.message || 'Could not load assigned exams.',
    );
  }
}

export function isCurrentAssignmentRequest(requestId, currentRequestId, isMounted = true) {
  return isMounted && requestId === currentRequestId;
}

function createAssignmentTimeout(timeoutMs) {
  return new Promise((resolve) => {
    setTimeout(() => resolve(createAssignmentLoadError(
      'timeout',
      'Assigned exams took too long to load. Check your connection and try again.',
    )), timeoutMs);
  });
}

function createAssignmentLoadError(reason, message) {
  return { ok: false, reason, message };
}
