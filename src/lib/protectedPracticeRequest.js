export function resolvePracticeRequest({ assignmentId = '', practiceRequest }) {
  const request = { ...(practiceRequest ?? {}) };
  const explicitAssignmentId = String(assignmentId ?? '').trim();
  const requestAssignmentId = String(request.assignmentId ?? '').trim();
  if (request.purpose !== 'self_directed_exam') {
    delete request.assignmentId;
    return { request, error: null };
  }
  if (explicitAssignmentId && requestAssignmentId && explicitAssignmentId !== requestAssignmentId) {
    return {
      request,
      error: Object.assign(new Error('Protected assignment context could not be verified.'), {
        code: 'binding_mismatch',
      }),
    };
  }
  const normalizedAssignmentId = explicitAssignmentId || requestAssignmentId;
  if (normalizedAssignmentId) request.assignmentId = normalizedAssignmentId;
  else delete request.assignmentId;
  return { request, error: null };
}
