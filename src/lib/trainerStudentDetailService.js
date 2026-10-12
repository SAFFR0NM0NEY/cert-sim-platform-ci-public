import { getExamDisplayLabel } from '../exams/examDisplayMetadata.js';
import { applyAuthoritativeAnalytics } from '../hooks/useTrainerAnalytics.js';
import { getTrainerAnalyticsSnapshot } from './trainerAnalyticsService.js';
import { normalizeProtectedTrainerResult } from './trainerDashboardService.js';
import { createProtectedExamClient } from './protectedExamClient.js';
import { isSupabaseConfigured, supabase } from './supabaseClient.js';

export const TRAINER_STUDENT_HISTORY_PAGE_SIZE = 25;

export async function getTrainerStudentDetail(membershipId, scope = {}, { signal } = {}) {
  if (!isSupabaseConfigured || !supabase) {
    return { ok: false, reason: 'supabase_not_configured', message: 'Trainer student detail is not configured.' };
  }
  const normalizedMembershipId = cleanText(membershipId);
  if (!normalizedMembershipId) {
    return { ok: false, reason: 'not_visible', message: 'This learner is no longer visible in the selected staff scope.' };
  }
  const { data, error } = await supabase.auth.getSession();
  const accessToken = data?.session?.access_token;
  if (error || !accessToken) {
    return { ok: false, reason: 'not_signed_in', message: 'Sign in again to load this learner.' };
  }
  try {
    const payload = await createProtectedExamClient({ accessToken }).getStaffLearnerDetail({
      membershipId: normalizedMembershipId,
      ...buildLearnerDetailRequest(scope),
      pageSize: TRAINER_STUDENT_HISTORY_PAGE_SIZE,
    }, { signal });
    return { ok: true, data: normalizeLearnerDetail(payload) };
  } catch (requestError) {
    return {
      ok: false,
      reason: requestError?.code || 'request_failed',
      message: requestError?.message || 'Could not load this learner.',
    };
  }
}

export function buildLearnerDetailRequest(scope = {}) {
  return Object.fromEntries([
    'organisationId', 'campusId', 'groupId', 'assignmentId', 'examKey', 'resultStatus', 'cursor',
  ].map((key) => [key, scope[key]]).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

export function normalizeLearnerDetail(payload = {}) {
  const learner = payload.learner ?? {};
  const student = {
    membershipId: learner.membershipId,
    userId: learner.learnerId,
    displayName: learner.displayName || 'Learner',
    email: learner.email || '',
    status: learner.status || '',
    organisationId: learner.organisationId || '',
    organisationName: learner.organisationName || '',
    campusId: learner.campusId || '',
    campusName: learner.campusName || '',
    groupId: learner.groupId || '',
    groupName: learner.groupName || '',
    scopeLabel: [learner.organisationName, learner.campusName, learner.groupName].filter(Boolean).join(' / '),
  };
  const assignments = (payload.assignmentPage?.items ?? []).map((assignment) => ({
    ...assignment,
    title: assignment.name,
    examTitle: getExamDisplayLabel(assignment.examKey, { fallback: 'Protected exam' }),
    totalStudents: 1,
    targetStudents: [student],
  }));
  const results = (payload.history?.items ?? []).map((item) =>
    normalizeProtectedTrainerResult(item, [student]));
  const groups = student.groupId ? [{
    id: student.groupId,
    name: student.groupName,
    organisationId: student.organisationId,
    campusId: student.campusId,
  }] : [];
  const pageDerived = getTrainerAnalyticsSnapshot({ assignments, groups, results, students: [student] });
  const analytics = applyAuthoritativeAnalytics(pageDerived, {
    scopeComplete: true,
    assignments: payload.assignmentAnalytics ?? [],
    exams: [],
    groups: [],
    domains: [],
    readinessSummary: {},
    activitySummary: {},
    totals: {
      visibleLearners: 1,
      historicalActivity: payload.history?.totalCount ?? results.length,
    },
  }, [student], groups, assignments, payload.learnerPage);
  return {
    role: payload.role || '',
    locks: payload.locks ?? {},
    selection: payload.selection ?? {},
    student,
    assignments,
    results,
    learnerPage: payload.learnerPage,
    history: payload.history,
    examProgress: analytics.studentReadiness,
    assignmentReadiness: analytics.assignmentReadiness,
  };
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}
