import { getCurrentIdentitySummary } from './profileService.js';
import { hasScopedPerformanceDashboardAccess } from './roleUtils.js';
import { isSupabaseConfigured, supabase } from './supabaseClient.js';
import { getTrainerDashboardSnapshot } from './trainerDashboardService.js';
import { getTrainerScopePage } from './trainerScopeService.js';
import { getTrainerAnalyticsSnapshot } from './trainerAnalyticsService.js';
import { evaluateExamReadiness, normalizeExamScopeKey } from './examReadinessRules.js';
import { getExamDisplayMetadata } from '../exams/examDisplayMetadata.js';

const IS_PROTECTED_DELIVERY = typeof __CERTSIM_BUILD_DELIVERY_MODE__ !== 'undefined'
  && __CERTSIM_BUILD_DELIVERY_MODE__ === 'protected';

export const ASSIGNMENT_STATUSES = ['active', 'closed', 'archived'];
export const ASSIGNMENT_TYPES = ['practice', 'assessment', 'placement', 'revision'];

const EXAM_CATALOG_FIELDS = [
  'id',
  'exam_key',
  'slug',
  'title',
  'vendor',
  'lifecycle',
  'exam_type',
  'current_version',
  'status',
].join(',');

const ASSIGNMENT_FIELDS = `
  id,
  organisation_id,
  campus_id,
  group_id,
  student_user_id,
  exam_catalog_id,
  exam_key,
  profile_id,
  title,
  instructions,
  assigned_by,
  assignment_type,
  status,
  due_at,
  available_from,
  created_at,
  updated_at,
  contract_version,
  maximum_attempts,
  review_release_policy,
  answer_release_policy,
  examCatalog:exam_catalog(id,exam_key,slug,title,vendor,lifecycle,exam_type,current_version,status),
  organisation:organisations(id,name,organisation_type,status),
  campus:campuses(id,name,code,status),
  group:groups(id,name,academic_year,status),
  student:profiles!exam_assignments_student_user_id_fkey(id,email,full_name,display_name,status),
  assignedBy:profiles!exam_assignments_assigned_by_fkey(id,email,full_name,display_name,status)
`;

const GROUP_SCOPE_FIELDS =
  'id,organisation_id,campus_id,name,academic_year,status,organisation:organisations(id,name),campus:campuses(id,name,code)';

const STUDENT_MEMBERSHIP_SCOPE_FIELDS = `
  id,
  user_id,
  organisation_id,
  campus_id,
  group_id,
  role,
  status,
  profile:profiles(id,email,full_name,display_name,status),
  organisation:organisations(id,name),
  campus:campuses(id,name,code),
  group:groups(id,name,academic_year,status)
`;

const unavailableResult = {
  ok: false,
  reason: 'supabase_not_configured',
  message: 'Exam assignments are not configured for this environment yet.',
};

const signedOutResult = {
  ok: false,
  reason: 'not_signed_in',
  message: 'Sign in to view exam assignments.',
};

const unauthorizedResult = {
  ok: false,
  reason: 'not_authorized',
  message: 'This account is not allowed to manage exam assignments.',
};

export async function listAssignableExams() {
  const authResult = await requireAuthenticatedUser();

  if (!authResult.ok) {
    return authResult;
  }

  const { data, error } = await supabase
    .from('exam_catalog')
    .select(EXAM_CATALOG_FIELDS)
    .eq('status', 'active')
    .order('title', { ascending: true });

  return createServiceResult(
    Array.isArray(data) ? data.map(normalizeExamCatalogRow) : [],
    error,
    'Could not load assignable exams.',
  );
}

export async function listAssignmentsForTrainerScope() {
  const authResult = await requireAssignmentManager();

  if (!authResult.ok) {
    return authResult;
  }

  const { data, error } = await supabase
    .from('exam_assignments')
    .select(ASSIGNMENT_FIELDS)
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(100);

  return createServiceResult(
    Array.isArray(data) ? data.map(normalizeAssignmentRow) : [],
    error,
    'Could not load scoped exam assignments.',
  );
}

export async function getAssignmentDetail(assignmentId) {
  const authResult = await requireAssignmentManager();

  if (!authResult.ok) {
    return authResult;
  }

  const normalizedId = cleanText(assignmentId);

  if (!normalizedId) {
    return createErrorResult(
      'invalid_payload',
      'Choose an assignment to inspect.',
    );
  }

  const { data, error } = await supabase
    .from('exam_assignments')
    .select(ASSIGNMENT_FIELDS)
    .eq('id', normalizedId)
    .maybeSingle();

  if (error) {
    return createServiceResult(
      null,
      error,
      'Could not load the assignment detail.',
    );
  }

  if (!data) {
    return createErrorResult(
      'not_authorized',
      'This assignment is not visible to this account.',
    );
  }

  return createOkResult(normalizeAssignmentRow(data));
}

export async function updateAssignmentDetails(assignmentId, payload = {}) {
  const authResult = await requireAssignmentManager();

  if (!authResult.ok) {
    return authResult;
  }

  const normalizedId = cleanText(assignmentId);

  if (!normalizedId) {
    return createErrorResult(
      'invalid_payload',
      'Choose an assignment to update.',
    );
  }

  const nextStatus = cleanText(payload.status);
  const nextTitle = cleanText(payload.title);
  const updatePayload = {
    available_from: normalizeOptionalDate(payload.availableFrom),
    due_at: normalizeOptionalDate(payload.dueAt),
    instructions: optionalText(payload.instructions),
  };

  if (nextTitle) {
    updatePayload.title = nextTitle;
  }

  if (nextStatus) {
    if (!ASSIGNMENT_STATUSES.includes(nextStatus)) {
      return createErrorResult(
        'invalid_payload',
        'Choose a valid assignment status.',
      );
    }

    updatePayload.status = nextStatus;
  }

  if (!updatePayload.title && hasOwn(payload, 'title')) {
    return createErrorResult('invalid_payload', 'Assignment title is required.');
  }

  const { data, error } = await supabase
    .from('exam_assignments')
    .update(updatePayload)
    .eq('id', normalizedId)
    .select(ASSIGNMENT_FIELDS)
    .single();

  return createServiceResult(
    data ? normalizeAssignmentRow(data) : null,
    error,
    'Could not update the assignment details.',
  );
}

export async function getAssignmentStudentProgress(assignmentId) {
  const assignmentResult = await getAssignmentDetail(assignmentId);

  if (!assignmentResult.ok) {
    return assignmentResult;
  }

  const assignment = assignmentResult.data;
  const [dashboardResult, scopedResult] = await Promise.all([
    getTrainerDashboardSnapshot(),
    IS_PROTECTED_DELIVERY
      ? getTrainerScopePage({
          assignmentId: assignment.id,
          campusId: assignment.campusId || '',
          groupId: assignment.groupId || '',
          organisationId: assignment.organisationId || '',
        })
      : Promise.resolve({ ok: true, data: null }),
  ]);

  if (!dashboardResult.ok) {
    return dashboardResult;
  }

  if (!scopedResult.ok) {
    return scopedResult;
  }

  const { groups = [], results: dashboardResults = [], students = [] } = dashboardResult.data ?? {};
  const results = IS_PROTECTED_DELIVERY
    ? normalizeScopedAssignmentResults(scopedResult.data?.history?.items, students)
    : dashboardResults;
  const assignedStudents = getAssignmentTargetStudents(assignment, students);
  const targetUserIds = new Set(
    assignedStudents.map((student) => student.userId).filter(Boolean),
  );
  const matchingResults = results
    .filter((result) =>
      isResultMatchForAssignment({
        assignment,
        result,
        targetStudents: assignedStudents,
        targetUserIds,
      }),
    )
    .sort((left, right) => getResultTime(right) - getResultTime(left));
  const analytics = getTrainerAnalyticsSnapshot({
    assignments: [
      {
        ...assignment,
        targetStudents: assignedStudents,
      },
    ],
    groups,
    results: matchingResults,
    students: assignedStudents,
  });
  const readinessSummary = IS_PROTECTED_DELIVERY
    ? buildAuthoritativeAssignmentProgress(assignment, assignedStudents, scopedResult.data?.analytics)
    : analytics.assignmentReadiness[0] ?? createEmptyReadinessSummary(assignment, assignedStudents);
  const latestResultByStudent = groupLatestResultByUser(matchingResults);
  const studentRows = (readinessSummary.studentRows ?? assignedStudents).map((student) => ({
    ...student,
    latestResult: student.latestResult ?? latestResultByStudent.get(student.userId) ?? null,
  }));

  return createOkResult({
    analytics,
    assignedStudents,
    assignment,
    matchingResults,
    readinessSummary: {
      ...readinessSummary,
      studentRows,
    },
  });
}

export function buildAuthoritativeAssignmentProgress(assignment = {}, students = [], authoritative = {}) {
  const assignmentAggregate = (authoritative?.assignments ?? [])
    .find((row) => row.assignmentId === assignment.id) ?? {};
  const outcomes = new Map((authoritative?.assignmentLearners ?? [])
    .filter((row) => row.assignmentId === assignment.id)
    .map((row) => [row.learnerId, row]));
  const learnerRows = new Map((authoritative?.learners ?? [])
    .filter((row) => normalizeExamScopeKey(row.examKey) === normalizeExamScopeKey(assignment.examKey))
    .map((row) => [row.learnerId, row]));
  const studentRows = students.map((student) => {
    const row = learnerRows.get(student.userId) ?? {};
    const outcome = outcomes.get(student.userId) ?? {};
    const assignmentAttemptCount = Number(outcome.assignmentAttemptCount ?? 0);
    const domains = [...(row.domains ?? [])].map((domain) => ({
      ...domain,
      domainId: domain.domainId ?? domain.domainKey,
      domainLabel: domain.domainLabel ?? domain.domainKey,
    })).sort((left, right) => Number(left.averagePercentage) - Number(right.averagePercentage));
    const readiness = evaluateExamReadiness({
      averageScore: row.averagePercentage == null ? null : Number(row.averagePercentage) * 10,
      bestScore: row.bestPercentage == null ? null : Number(row.bestPercentage) * 10,
      latestScore: row.latestPercentage == null ? null : Number(row.latestPercentage) * 10,
      needsReviewCount: Number(row.needsReviewCount ?? 0),
      passRate: row.passRate ?? null,
      totalAttempts: Number(row.assessmentCount ?? 0),
      weakDomainCount: domains.filter((domain) => Number(domain.averagePercentage) < 70).length,
    });
    const assignmentStatus = getAuthoritativeAssignmentStatus(assignment, assignmentAttemptCount, readiness.status);
    const latestAttemptId = outcome.latestAssignmentAttemptId ?? '';
    return {
      ...student,
      assignmentAttemptCount,
      assignmentStatus,
      averageScore: row.averagePercentage == null ? null : Number(row.averagePercentage) * 10,
      bestScore: row.bestPercentage == null ? null : Number(row.bestPercentage) * 10,
      latestScore: row.latestPercentage == null ? null : Number(row.latestPercentage) * 10,
      latestAttemptDate: outcome.latestAssignmentActivity ?? row.latestActivity ?? '',
      latestAttemptId,
      latestResult: latestAttemptId ? { attemptId: latestAttemptId } : null,
      domainAverages: domains,
      readinessLabel: readiness.label,
      readinessStatus: readiness.status,
      scopedAttemptCount: assignmentAttemptCount,
      weakestDomain: domains[0] ?? null,
      strongestDomain: domains.at(-1) ?? null,
      weakDomains: domains.filter((domain) => Number(domain.averagePercentage) < 70),
    };
  });
  const submitted = studentRows.filter((student) => student.assignmentAttemptCount > 0);
  const unsubmitted = studentRows.filter((student) => student.assignmentAttemptCount === 0);
  return {
    assignmentId: assignment.id,
    assessmentCount: Number(assignmentAggregate.assessmentCount ?? 0),
    averageScore: assignmentAggregate.averagePercentage == null ? null : Number(assignmentAggregate.averagePercentage) * 10,
    commonWeakDomains: summarizeAssignmentDomains(submitted),
    completedButNotReadyCount: submitted.filter((student) => student.readinessStatus !== 'ready').length,
    dueSoonCount: isAssignmentDueSoon(assignment.dueAt) ? unsubmitted.length : 0,
    examKey: assignment.examKey,
    examTitle: assignment.examTitle,
    needsReviewCount: submitted.filter((student) => ['needs-review', 'at-risk'].includes(student.readinessStatus)).length,
    notStartedCount: unsubmitted.length,
    overdueCount: isAssignmentPastDue(assignment.dueAt) ? unsubmitted.length : 0,
    readyCount: submitted.filter((student) => student.readinessStatus === 'ready').length,
    studentRows,
    submittedCount: submitted.length,
    totalStudents: students.length || Number(assignmentAggregate.totalStudents ?? assignment.totalStudents ?? 0),
  };
}

function getAuthoritativeAssignmentStatus(assignment, count, readinessStatus) {
  if (count > 0) {
    if (readinessStatus === 'ready') return { status: 'ready', label: 'Ready' };
    if (readinessStatus === 'almost-ready') return { status: 'completed-not-ready', label: 'Completed but not ready' };
    return { status: 'needs-review', label: 'Needs review' };
  }
  if (isAssignmentPastDue(assignment.dueAt)) return { status: 'overdue', label: 'Overdue - no attempt submitted' };
  if (isAssignmentDueSoon(assignment.dueAt)) return { status: 'due-soon', label: 'Due soon' };
  return { status: 'not-started', label: 'Not started' };
}

function summarizeAssignmentDomains(students) {
  const domains = new Map();
  students.flatMap((student) => student.domainAverages ?? []).forEach((domain) => {
    if (Number(domain.averagePercentage) >= 80) return;
    const key = domain.domainId ?? domain.domainKey;
    const current = domains.get(key) ?? { domain: key, label: domain.domainLabel ?? key, occurrences: 0, studentCount: 0, total: 0 };
    current.occurrences += 1; current.studentCount += 1; current.total += Number(domain.averagePercentage ?? 0);
    domains.set(key, current);
  });
  return [...domains.values()].map(({ total, ...domain }) => ({ ...domain, averagePercentage: total / domain.studentCount }));
}

function isAssignmentPastDue(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) && time < Date.now();
}

function isAssignmentDueSoon(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) && time >= Date.now() && time - Date.now() <= 7 * 24 * 60 * 60 * 1000;
}

function normalizeScopedAssignmentResults(items = [], students = []) {
  const studentById = new Map(students.map((student) => [student.userId, student]));
  return (Array.isArray(items) ? items : []).map((item) => {
    const student = studentById.get(item.learnerId) ?? {};
    return {
      assignmentId: item.assignmentId,
      attemptId: item.attemptId,
      domainBreakdown: item.domainSummary ?? {},
      examKey: item.examKey,
      passed: item.passed,
      profileId: item.profileKey,
      purpose: item.purpose,
      rawPercentage: item.percentage,
      rawScore: item.score,
      savedAt: item.completedAt,
      serverAuthoritative: item.serverAuthoritative,
      source: item.source,
      studentEmail: student.email || '',
      studentName: student.displayName || 'Student',
      submittedAt: item.completedAt,
      userId: item.learnerId,
    };
  });
}

export async function listMyAssignments({ identity, userId = '' } = {}) {
  const authResult = userId
    ? createOkResult({ id: userId })
    : await requireAuthenticatedUser();

  if (!authResult.ok) {
    return authResult;
  }

  let currentIdentity = identity;
  if (!currentIdentity) {
    const identityResult = await getCurrentIdentitySummary();
    if (identityResult.error) {
      return createErrorResult(
        'identity_failed',
        identityResult.error.message || 'Could not load profile memberships.',
        identityResult.error.code,
      );
    }
    currentIdentity = identityResult.data;
  }
  const { data, error } = await supabase
    .from('exam_assignments')
    .select(ASSIGNMENT_FIELDS)
    .order('due_at', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    return createServiceResult([], error, 'Could not load assigned exams.');
  }

  return createOkResult(filterAssignmentsForStudent(
    (Array.isArray(data) ? data : []).map(normalizeAssignmentRow),
    currentIdentity,
    authResult.data?.id ?? authResult.user?.id,
  ));
}

export function filterAssignmentsForStudent(assignments = [], identity, userId = '') {
  return assignments.filter((assignment) =>
    assignment.status !== 'archived' &&
    isAssignmentTargetedToIdentity(assignment, identity, userId),
  );
}

export async function createGroupAssignment(payload = {}) {
  const authResult = await requireAssignmentManager();

  if (!authResult.ok) {
    return authResult;
  }

  const groupResult = await getVisibleGroup(cleanText(payload.groupId));

  if (!groupResult.ok) {
    return groupResult;
  }

  const examResult = await getAssignableExam(payload);

  if (!examResult.ok) {
    return examResult;
  }

  return insertAssignment({
    assigned_by: authResult.data.user.id,
    assignment_type: normalizeAssignmentType(payload.assignmentType),
    available_from: normalizeOptionalDate(payload.availableFrom),
    due_at: normalizeOptionalDate(payload.dueAt),
    exam_catalog_id: examResult.data.id,
    exam_key: examResult.data.examKey,
    group_id: groupResult.data.id,
    instructions: optionalText(payload.instructions),
    organisation_id: groupResult.data.organisationId,
    campus_id: groupResult.data.campusId,
    profile_id: optionalText(payload.profileId),
    student_user_id: null,
    title: cleanText(payload.title),
  });
}

export async function createStudentAssignment(payload = {}) {
  const authResult = await requireAssignmentManager();

  if (!authResult.ok) {
    return authResult;
  }

  const studentResult = await getVisibleStudentMembership(
    cleanText(payload.studentMembershipId),
  );

  if (!studentResult.ok) {
    return studentResult;
  }

  const examResult = await getAssignableExam(payload);

  if (!examResult.ok) {
    return examResult;
  }

  return insertAssignment({
    assigned_by: authResult.data.user.id,
    assignment_type: normalizeAssignmentType(payload.assignmentType),
    available_from: normalizeOptionalDate(payload.availableFrom),
    due_at: normalizeOptionalDate(payload.dueAt),
    exam_catalog_id: examResult.data.id,
    exam_key: examResult.data.examKey,
    group_id: null,
    instructions: optionalText(payload.instructions),
    organisation_id: studentResult.data.organisationId,
    campus_id: studentResult.data.campusId,
    profile_id: optionalText(payload.profileId),
    student_user_id: studentResult.data.userId,
    title: cleanText(payload.title),
  });
}

export async function updateAssignmentStatus(assignmentId, status) {
  const authResult = await requireAssignmentManager();

  if (!authResult.ok) {
    return authResult;
  }

  const normalizedId = cleanText(assignmentId);
  const normalizedStatus = cleanText(status);

  if (!normalizedId || !ASSIGNMENT_STATUSES.includes(normalizedStatus)) {
    return createErrorResult(
      'invalid_payload',
      'Choose a valid assignment and status.',
    );
  }

  const { data, error } = await supabase
    .from('exam_assignments')
    .update({ status: normalizedStatus })
    .eq('id', normalizedId)
    .select(ASSIGNMENT_FIELDS)
    .single();

  return createServiceResult(
    data ? normalizeAssignmentRow(data) : null,
    error,
    'Could not update the assignment status.',
  );
}

async function insertAssignment(payload) {
  if (!payload.title) {
    return createErrorResult('invalid_payload', 'Assignment title is required.');
  }

  if (!payload.exam_key || !payload.exam_catalog_id) {
    return createErrorResult('invalid_payload', 'Choose an assignable exam.');
  }

  const { data, error } = await supabase
    .from('exam_assignments')
    .insert(payload)
    .select(ASSIGNMENT_FIELDS)
    .single();

  return createServiceResult(
    data ? normalizeAssignmentRow(data) : null,
    error,
    'Could not create the exam assignment.',
  );
}

async function getAssignableExam(payload = {}) {
  const examCatalogId = cleanText(payload.examCatalogId);
  const examKey = cleanText(payload.examKey);

  if (!examCatalogId && !examKey) {
    return createErrorResult('invalid_payload', 'Choose an assignable exam.');
  }

  let query = supabase
    .from('exam_catalog')
    .select(EXAM_CATALOG_FIELDS)
    .eq('status', 'active')
    .limit(1);

  query = examCatalogId
    ? query.eq('id', examCatalogId)
    : query.eq('exam_key', examKey);

  const { data, error } = await query.maybeSingle();

  if (error) {
    return createServiceResult(null, error, 'Could not verify the selected exam.');
  }

  if (!data) {
    return createErrorResult(
      'not_found',
      'The selected exam is not available in the exam catalog.',
    );
  }

  return createOkResult(normalizeExamCatalogRow(data));
}

async function getVisibleGroup(groupId) {
  if (!groupId) {
    return createErrorResult('invalid_payload', 'Choose a group/class.');
  }

  const { data, error } = await supabase
    .from('groups')
    .select(GROUP_SCOPE_FIELDS)
    .eq('id', groupId)
    .eq('status', 'active')
    .maybeSingle();

  if (error) {
    return createServiceResult(null, error, 'Could not verify the group.');
  }

  if (!data) {
    return createErrorResult(
      'not_authorized',
      'The selected group is not visible to this account.',
    );
  }

  return createOkResult(normalizeGroupScope(data));
}

async function getVisibleStudentMembership(studentMembershipId) {
  if (!studentMembershipId) {
    return createErrorResult('invalid_payload', 'Choose a student.');
  }

  const { data, error } = await supabase
    .from('memberships')
    .select(STUDENT_MEMBERSHIP_SCOPE_FIELDS)
    .eq('id', studentMembershipId)
    .eq('role', 'student')
    .eq('status', 'active')
    .maybeSingle();

  if (error) {
    return createServiceResult(null, error, 'Could not verify the student.');
  }

  if (!data) {
    return createErrorResult(
      'not_authorized',
      'The selected student is not visible to this account.',
    );
  }

  return createOkResult(normalizeStudentMembershipScope(data));
}

async function requireAuthenticatedUser() {
  if (!isSupabaseConfigured || !supabase) {
    return { ...unavailableResult };
  }

  const { data, error } = await supabase.auth.getUser();
  const user = data?.user ?? null;

  if (error) {
    return createErrorResult(
      'request_failed',
      error.message || 'Could not read the current account.',
      error.code,
    );
  }

  if (!user) {
    return { ...signedOutResult };
  }

  return createOkResult(user);
}

async function requireAssignmentManager() {
  const authResult = await requireAuthenticatedUser();

  if (!authResult.ok) {
    return authResult;
  }

  const { data: identity, error } = await getCurrentIdentitySummary();

  if (!hasAssignmentManagerAccess(identity)) {
    return {
      ...unauthorizedResult,
      message: error?.message || unauthorizedResult.message,
      errorCode: error?.code,
    };
  }

  return createOkResult({ user: authResult.data, identity });
}

function hasAssignmentManagerAccess(identity) {
  return hasScopedPerformanceDashboardAccess(identity);
}

function isAssignmentTargetedToIdentity(assignment, identity, userId) {
  if (assignment.studentUserId === userId) {
    return true;
  }

  const studentGroupIds = new Set(
    (identity?.memberships ?? [])
      .filter(
        (membership) =>
          membership?.role === 'student' &&
          membership?.status === 'active' &&
          membership?.group_id,
      )
      .map((membership) => membership.group_id),
  );

  return assignment.groupId ? studentGroupIds.has(assignment.groupId) : false;
}

function getAssignmentTargetStudents(assignment = {}, students = []) {
  if (assignment.studentUserId) {
    const matchedStudent = students.find(
      (student) => student.userId === assignment.studentUserId,
    );

    return [
      matchedStudent ?? {
        displayName: assignment.studentName || 'Assigned student',
        email: assignment.studentEmail || '',
        groupId: assignment.groupId || '',
        groupName: assignment.groupName || '',
        userId: assignment.studentUserId,
      },
    ];
  }

  if (assignment.groupId) {
    return students.filter((student) => student.groupId === assignment.groupId);
  }

  return [];
}

function isResultMatchForAssignment({
  assignment,
  result,
  targetStudents,
  targetUserIds,
}) {
  if (result.assignmentId !== (assignment.assignmentId || assignment.id)) {
    return false;
  }

  if (!isSameExam(assignment, result) || !isResultAfterAssignment(assignment, result)) {
    return false;
  }

  const resultUserId = cleanText(result.userId);

  if (assignment.studentUserId) {
    return resultUserId
      ? resultUserId === assignment.studentUserId
      : targetStudents.length <= 1;
  }

  if (assignment.groupId) {
    return resultUserId
      ? targetUserIds.has(resultUserId)
      : targetStudents.some((student) => student.groupId === assignment.groupId);
  }

  return false;
}

function isSameExam(assignment = {}, result = {}) {
  const assignmentKeys = [
    assignment.examKey,
    assignment.examSlug,
    assignment.examCatalog?.examKey,
    assignment.examCatalog?.slug,
  ]
    .map(cleanText)
    .filter(Boolean);
  const resultKey = cleanText(result.examKey);

  return Boolean(resultKey && assignmentKeys.includes(resultKey));
}

function isResultAfterAssignment(assignment = {}, result = {}) {
  const assignmentTime = getTime(assignment.createdAt);
  const resultTime = getResultTime(result);

  return !assignmentTime || !resultTime || resultTime >= assignmentTime;
}

function groupLatestResultByUser(results = []) {
  const map = new Map();

  results.forEach((result) => {
    const userId = cleanText(result.userId);

    if (!userId || map.has(userId)) {
      return;
    }

    map.set(userId, result);
  });

  return map;
}

function createEmptyReadinessSummary(assignment = {}, students = []) {
  return {
    assignmentId: assignment.id,
    averageScore: null,
    commonWeakDomains: [],
    completedButNotReadyCount: 0,
    dueSoonCount: 0,
    examKey: assignment.examKey,
    examTitle: assignment.examTitle,
    needsReviewCount: 0,
    notStartedCount: students.length,
    overdueCount: 0,
    readyCount: 0,
    studentRows: students,
    submittedCount: 0,
    totalStudents: students.length || assignment.totalStudents || 0,
  };
}

function normalizeExamCatalogRow(row = {}) {
  const display = getExamDisplayMetadata(row.exam_key || row.slug || row.title);
  return {
    id: row.id,
    examKey: row.exam_key,
    slug: row.slug,
    title: display?.fullTitle ?? row.title ?? 'Exam',
    vendor: display?.vendor ?? row.vendor ?? '',
    lifecycle: row.lifecycle,
    examType: row.exam_type,
    currentVersion: row.current_version,
    status: row.status,
    route: row.slug ? `/exams/${row.slug}` : '',
  };
}

function normalizeAssignmentRow(row = {}) {
  const examCatalog = toObject(row.examCatalog);
  const organisation = toObject(row.organisation);
  const campus = toObject(row.campus);
  const group = toObject(row.group);
  const student = toObject(row.student);
  const assignedBy = toObject(row.assignedBy);
  const exam = normalizeExamCatalogRow({
    id: row.exam_catalog_id,
    exam_key: row.exam_key,
    ...examCatalog,
  });
  const studentName = getProfileDisplayName(student);
  const targetType = row.student_user_id ? 'student' : 'group';
  const targetName =
    targetType === 'student'
      ? studentName
      : group.name || 'Group assignment';

  return {
    id: row.id,
    organisationId: row.organisation_id,
    organisationName: organisation.name ?? '',
    campusId: row.campus_id,
    campusName: campus.name ?? '',
    groupId: row.group_id,
    groupName: group.name ?? '',
    studentUserId: row.student_user_id,
    studentName,
    studentEmail: student.email ?? '',
    examCatalogId: row.exam_catalog_id,
    examKey: row.exam_key,
    examTitle: exam.title,
    examSlug: exam.slug,
    examRoute: exam.route && row.id
      ? `${exam.route}?assignment=${encodeURIComponent(row.id)}`
      : exam.route,
    profileId: row.profile_id ?? '',
    title: row.title,
    instructions: row.instructions ?? '',
    assignedByUserId: row.assigned_by,
    assignedByName: getProfileDisplayName(assignedBy),
    assignedByEmail: assignedBy.email ?? '',
    assignmentType: row.assignment_type,
    status: row.status,
    dueAt: row.due_at,
    availableFrom: row.available_from,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    contractVersion: row.contract_version ?? 'legacy-v1',
    maximumAttempts: row.maximum_attempts ?? null,
    reviewReleasePolicy: row.review_release_policy ?? null,
    answerReleasePolicy: row.answer_release_policy ?? null,
    targetType,
    targetName,
    targetLabel: [targetName, group.name && targetType === 'student' ? group.name : '']
      .filter(Boolean)
      .join(' / '),
    scopeLabel: [organisation.name, campus.name, group.name]
      .filter(Boolean)
      .join(' / '),
  };
}

function normalizeGroupScope(group = {}) {
  return {
    id: group.id,
    organisationId: group.organisation_id,
    campusId: group.campus_id,
    name: group.name,
  };
}

function normalizeStudentMembershipScope(membership = {}) {
  return {
    membershipId: membership.id,
    userId: membership.user_id,
    organisationId: membership.organisation_id,
    campusId: membership.campus_id,
    groupId: membership.group_id,
  };
}

function normalizeAssignmentType(value) {
  const type = cleanText(value) || 'practice';

  return ASSIGNMENT_TYPES.includes(type) ? type : 'practice';
}

function normalizeOptionalDate(value) {
  const text = cleanText(value);

  if (!text) {
    return null;
  }

  const date = new Date(text);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function getProfileDisplayName(profile = {}) {
  return (
    profile.display_name ||
    profile.full_name ||
    getNameFromEmail(profile.email) ||
    'Not recorded'
  );
}

function getNameFromEmail(email) {
  const text = cleanText(email);

  return text.includes('@') ? text.split('@')[0] : '';
}

function createServiceResult(data, error, fallbackMessage) {
  if (error) {
    return createErrorResult(
      getReasonFromError(error),
      getFriendlyErrorMessage(error, fallbackMessage),
      error.code,
    );
  }

  return createOkResult(data);
}

function createOkResult(data) {
  return {
    ok: true,
    data,
  };
}

function createErrorResult(reason, message, errorCode = '') {
  return {
    ok: false,
    reason,
    message,
    errorCode,
  };
}

function getResultTime(result = {}) {
  return (
    getTime(result.submittedAt) ||
    getTime(result.savedAt) ||
    getTime(result.createdAt)
  );
}

function getReasonFromError(error) {
  if (error?.code === '42P01') {
    return 'assignment_storage_missing';
  }

  if (error?.code === '42501' || /permission|policy|rls|authorized/i.test(error?.message ?? '')) {
    return 'not_authorized';
  }

  return 'request_failed';
}

function getFriendlyErrorMessage(error, fallbackMessage) {
  if (error?.code === '42P01') {
    return 'Exam assignments are not available until migration 0005 is applied.';
  }

  return error?.message || fallbackMessage;
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(value) {
  const text = cleanText(value);

  return text || null;
}

function toObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function getTime(value) {
  if (!value) {
    return 0;
  }

  const time = new Date(value).getTime();

  return Number.isNaN(time) ? 0 : time;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}
