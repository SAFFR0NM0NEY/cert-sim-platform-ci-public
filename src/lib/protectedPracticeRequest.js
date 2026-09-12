import { PROTECTED_LANGUAGE_PREFERENCES } from './protectedExamContract.js';

const protectedLanguagePreferences = new Set(PROTECTED_LANGUAGE_PREFERENCES);

export function buildWeakAreaPracticeRequest({
  count,
  domain,
  examKey,
  includePbqs,
  language,
  mixStrategy,
  profileId,
  questionCount,
} = {}) {
  const request = {
    examKey,
    profileId,
    purpose: 'weak_area',
    domain,
    count: count ?? questionCount,
    includePbqs,
    mixStrategy,
  };
  if (examKey !== 'az204') return request;
  if (!protectedLanguagePreferences.has(language)) {
    throw Object.assign(new Error('Select a valid AZ-204 coding language before starting practice.'), {
      code: 'invalid_language',
    });
  }
  return { ...request, language };
}

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
