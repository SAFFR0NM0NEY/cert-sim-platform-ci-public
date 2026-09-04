import { isSupabaseConfigured, supabase } from './supabaseClient.js';
import { getCurrentIdentitySummary } from './profileService.js';
import { hasScopedPerformanceDashboardAccess } from './roleUtils.js';
import {
  normalizeDomainBreakdownSnapshot,
  normalizeWeakAreasSnapshot,
} from './resultStorageMappers.js';
import { classifyAttempt, getAttemptKindLabel, getAttemptPurpose } from './attemptPurpose.js';
import { createProtectedExamClient } from './protectedExamClient.js';
import { composeTrainerDashboardSnapshot } from './trainerDashboardSnapshot.js';

const IS_PROTECTED_DELIVERY = typeof __CERTSIM_BUILD_DELIVERY_MODE__ !== 'undefined'
  && __CERTSIM_BUILD_DELIVERY_MODE__ === 'protected';

const GROUP_FIELDS = `
  id,
  organisation_id,
  campus_id,
  name,
  academic_year,
  max_students,
  status,
  created_at,
  organisation:organisations(id,name,organisation_type,status),
  campus:campuses(id,name,code,status)
`;

const STUDENT_MEMBERSHIP_FIELDS = `
  id,
  user_id,
  organisation_id,
  campus_id,
  group_id,
  role,
  status,
  created_at,
  updated_at,
  profile:profiles(id,email,full_name,display_name,status),
  organisation:organisations(id,name,organisation_type,status),
  campus:campuses(id,name,code,status),
  group:groups(id,name,academic_year,status)
`;

const ATTEMPT_FIELDS = [
  'id',
  'user_id',
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

const RESULT_FIELDS = [
  'id',
  'attempt_id',
  'user_id',
  'exam_key',
  'profile_id',
  'scoring_engine_version',
  'raw_score',
  'raw_percentage',
  'scaled_score',
  'passed',
  'pass_mark',
  'domain_breakdown',
  'pbq_breakdown',
  'case_study_breakdown',
  'weak_areas',
  'result_snapshot',
  'created_at',
].join(',');

const REPORT_FIELDS = [
  'id',
  'attempt_id',
  'user_id',
  'report_type',
  'report_title',
  'report_snapshot',
  'pdf_generated',
  'created_at',
].join(',');

const CATALOG_FIELDS = [
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

const unavailableResult = {
  ok: false,
  reason: 'supabase_not_configured',
  message: 'Performance Dashboard is not configured for this environment yet.',
};

const signedOutResult = {
  ok: false,
  reason: 'not_signed_in',
  message: 'Sign in with a trainer, scoped admin, or Platform Owner account to view the Performance Dashboard.',
};

const unauthorizedResult = {
  ok: false,
  reason: 'not_authorized',
  message: 'This account is not linked to an active trainer, scoped admin, or Platform Owner membership.',
};

export const TRAINER_RESULTS_REQUEST_PAGE_SIZE = 25;

export async function getTrainerDashboardSnapshot({ cursor = null } = {}) {
  const authResult = await requireTrainerDashboardAccess();

  if (!authResult.ok) {
    return authResult;
  }

  const [groupsResult, studentsResult] = await Promise.all([
    readTrainerGroups(),
    readTrainerStudents(),
  ]);
  // Protected institutional analytics comes from the assignment-scoped DTO.
  // Do not make the older global staff readers a hidden prerequisite for the
  // dashboard or assignment lists; legacy/unattributed history stays separate.
  const [resultsResult, analyticsResult] = IS_PROTECTED_DELIVERY
    ? [createOkResult([]), createOkResult(null)]
    : await Promise.all([
        readTrainerStudentResults(studentsResult.ok ? studentsResult.data : [], { cursor }),
        Promise.resolve(createOkResult(null)),
      ]);

  return createOkResult(composeTrainerDashboardSnapshot({
    identity: authResult.data.identity,
    groupsResult,
    studentsResult,
    historyResult: resultsResult,
    analyticsResult,
  }));
}

export async function listTrainerGroups() {
  const authResult = await requireTrainerDashboardAccess();

  return authResult.ok ? readTrainerGroups() : authResult;
}

export async function listTrainerStudents() {
  const authResult = await requireTrainerDashboardAccess();

  return authResult.ok ? readTrainerStudents() : authResult;
}

export async function listTrainerStudentResults({ cursor = null } = {}) {
  const authResult = await requireTrainerDashboardAccess();

  if (!authResult.ok) {
    return authResult;
  }

  const studentsResult = await readTrainerStudents();

  return studentsResult.ok
    ? readTrainerStudentResults(studentsResult.data, { cursor })
    : studentsResult;
}

export async function getTrainerStudentResultDetail(attemptId) {
  const authResult = await requireTrainerDashboardAccess();

  if (!authResult.ok) {
    return authResult;
  }

  const normalizedAttemptId = cleanText(attemptId);

  if (!normalizedAttemptId) {
    return createErrorResult(
      'missing_attempt_id',
      'Choose a saved student result to inspect.',
    );
  }

  if (IS_PROTECTED_DELIVERY) {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    if (sessionError || !accessToken) return createErrorResult('not_signed_in', 'Sign in again to open this result.');
    try {
      const summary = await createProtectedExamClient({ accessToken }).getPrintableSummary(normalizedAttemptId);
      return createOkResult(normalizeProtectedPrintSummary(summary));
    } catch (error) {
      return createErrorResult('request_failed', error?.message || 'Could not load the scoped result summary.');
    }
  }

  const { data: attempt, error: attemptError } = await supabase
    .from('exam_attempts')
    .select(ATTEMPT_FIELDS)
    .eq('id', normalizedAttemptId)
    .eq('status', 'submitted')
    .maybeSingle();

  if (attemptError) {
    return createServiceResult(
      null,
      attemptError,
      'Could not load the student attempt.',
    );
  }

  if (!attempt) {
    return createErrorResult(
      'not_found',
      'No submitted saved result was found for the selected attempt.',
    );
  }

  const [studentsResult, resultsResult, reportsResult, catalogResult] =
    await Promise.all([
      readTrainerStudentsForUser(attempt.user_id),
      queryRowsByAttemptIds('exam_results', RESULT_FIELDS, [attempt.id]),
      queryRowsByAttemptIds('exam_reports', REPORT_FIELDS, [attempt.id]),
      queryCatalogRows([attempt.exam_catalog_id].filter(Boolean)),
    ]);
  const failedResult = [
    studentsResult,
    resultsResult,
    reportsResult,
    catalogResult,
  ].find((result) => !result.ok);

  if (failedResult) {
    return failedResult;
  }

  const catalogById = groupFirstBy(catalogResult.data, 'id');
  const resultByAttemptId = groupFirstBy(resultsResult.data, 'attempt_id');
  const reportByAttemptId = groupFirstBy(reportsResult.data, 'attempt_id');

  return createOkResult(
    normalizeTrainerResult(attempt, {
      catalog: catalogById.get(attempt.exam_catalog_id) ?? null,
      includeDetail: true,
      report: reportByAttemptId.get(attempt.id) ?? null,
      result: resultByAttemptId.get(attempt.id) ?? null,
      students: studentsResult.data,
    }),
  );
}

function normalizeProtectedPrintSummary(summary = {}) {
  const exam = toObject(summary.exam);
  const profile = toObject(summary.profile);
  const purposeRecord = { purpose: summary.purpose };
  return {
    attemptId: '',
    studentName: 'Scoped student',
    examKey: cleanText(exam.key),
    examTitle: cleanText(exam.key) || 'Protected exam',
    profileId: cleanText(profile.key),
    profileLabel: cleanText(profile.name) || cleanText(profile.key),
    modeLabel: '',
    purpose: getAttemptPurpose(purposeRecord),
    attemptKind: classifyAttempt(purposeRecord).kind,
    attemptKindLabel: getAttemptKindLabel(purposeRecord),
    submittedAt: summary.completedAt,
    rawScore: summary.score ?? null,
    rawPercentage: summary.percentage ?? null,
    scaledScore: null,
    passed: summary.passed ?? null,
    responseCount: null,
    domainBreakdown: normalizeDomainBreakdownSnapshot(summary.domainSummary),
    weakAreas: [],
    pbqBreakdown: {},
    caseStudyBreakdown: {},
    reportTitle: 'Content-free protected result summary',
    reviewStatus: summary.reviewStatus === 'released' ? 'released' : 'withheld',
    serverAuthoritative: summary.serverAuthoritative === true,
    historySource: summary.source,
  };
}

async function requireTrainerDashboardAccess() {
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

  if (!hasTrainerDashboardAccess(identity)) {
    return {
      ...unauthorizedResult,
      message:
        identityError?.message ||
        unauthorizedResult.message,
      errorCode: identityError?.code,
    };
  }

  return createOkResult({ user, identity });
}

async function readTrainerGroups() {
  const { data, error } = await supabase
    .from('groups')
    .select(GROUP_FIELDS)
    .eq('status', 'active')
    .order('name', { ascending: true });

  return createServiceResult(
    Array.isArray(data) ? data.map(normalizeGroup) : [],
    error,
    'Could not load assigned groups.',
  );
}

async function readTrainerStudents() {
  const { data, error } = await supabase
    .from('memberships')
    .select(STUDENT_MEMBERSHIP_FIELDS)
    .eq('role', 'student')
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  return createServiceResult(
    Array.isArray(data) ? data.map(normalizeStudentMembership) : [],
    error,
    'Could not load assigned students.',
  );
}

async function readTrainerStudentsForUser(userId) {
  const normalizedUserId = cleanText(userId);

  if (!normalizedUserId) {
    return createOkResult([]);
  }

  const { data, error } = await supabase
    .from('memberships')
    .select(STUDENT_MEMBERSHIP_FIELDS)
    .eq('user_id', normalizedUserId)
    .eq('role', 'student')
    .eq('status', 'active')
    .order('created_at', { ascending: false });

  return createServiceResult(
    Array.isArray(data) ? data.map(normalizeStudentMembership) : [],
    error,
    'Could not load student membership details.',
  );
}

async function readTrainerStudentResults(students = [], { cursor = null } = {}) {
  if (IS_PROTECTED_DELIVERY) {
    return readProtectedTrainerStudentResults(students, { cursor });
  }
  const studentIds = [
    ...new Set(students.map((student) => student.userId).filter(Boolean)),
  ];

  if (studentIds.length === 0) {
    return createOkResult([]);
  }

  let query = supabase
    .from('exam_attempts')
    .select(ATTEMPT_FIELDS)
    .eq('status', 'submitted')
    .in('user_id', studentIds)
    .order('submitted_at', { ascending: false, nullsFirst: false })
    .order('id', { ascending: false })
    .limit(TRAINER_RESULTS_REQUEST_PAGE_SIZE + 1);

  if (cursor?.submittedAt && cursor?.attemptId) {
    query = query.or(
      `submitted_at.lt.${cursor.submittedAt},and(submitted_at.eq.${cursor.submittedAt},id.lt.${cursor.attemptId})`,
    );
  }

  const { data: attemptRows, error } = await query;

  if (error) {
    return createServiceResult(
      [],
      error,
      'Could not load student saved results.',
    );
  }

  const hasMore = (attemptRows?.length ?? 0) > TRAINER_RESULTS_REQUEST_PAGE_SIZE;
  const attempts = (attemptRows ?? []).slice(0, TRAINER_RESULTS_REQUEST_PAGE_SIZE);
  const hydrated = await hydrateTrainerAttemptRows(attempts, students);
  return hydrated.ok
    ? {
        ...hydrated,
        pagination: {
          hasMore,
          nextCursor: hasMore
            ? {
                submittedAt: attempts.at(-1)?.submitted_at,
                attemptId: attempts.at(-1)?.id,
              }
            : null,
          pageSize: TRAINER_RESULTS_REQUEST_PAGE_SIZE,
        },
      }
    : hydrated;
}

async function readProtectedTrainerStudentResults(students = [], { cursor = null } = {}) {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const accessToken = sessionData?.session?.access_token;
  if (sessionError || !accessToken) {
    return createErrorResult('not_signed_in', 'Sign in again to load protected student history.');
  }
  try {
    const payload = await createProtectedExamClient({ accessToken }).listStaffHistory({
      cursor: typeof cursor === 'string' ? cursor : null,
      pageSize: TRAINER_RESULTS_REQUEST_PAGE_SIZE,
    });
    const items = Array.isArray(payload.items) ? payload.items : [];
    return {
      ok: true,
      data: items.map((item) => normalizeProtectedTrainerResult(item, students)),
      pagination: {
        hasMore: Boolean(payload.nextCursor),
        nextCursor: payload.nextCursor ?? null,
        pageSize: TRAINER_RESULTS_REQUEST_PAGE_SIZE,
        returnedCount: payload.returnedCount ?? items.length,
        totalCount: payload.totalCount ?? items.length,
        remainingCount: payload.remainingCount ?? 0,
      },
    };
  } catch (error) {
    return createErrorResult('request_failed', error?.message || 'Could not load protected student history.');
  }
}

function normalizeProtectedTrainerResult(item = {}, students = []) {
  const studentMatches = students.filter((student) => student.userId === item.learnerId);
  const primaryStudent = studentMatches[0] ?? {};
  const purpose = cleanText(item.purpose) || 'unclassified';
  return {
    attemptId: item.attemptId,
    userId: item.learnerId,
    studentName: primaryStudent.displayName || 'Student',
    studentEmail: primaryStudent.email ?? '',
    studentScopes: studentMatches.map((student) => student.scopeLabel).filter(Boolean),
    groupName: primaryStudent.groupName ?? '',
    campusName: primaryStudent.campusName ?? '',
    organisationName: primaryStudent.organisationName ?? '',
    examKey: item.examKey,
    examTitle: item.examKey,
    vendor: '',
    profileId: item.profileKey,
    profileLabel: item.profileKey,
    modeLabel: '',
    purpose,
    attemptKind: item.analyticsEligible === true ? 'assessment' : 'practice',
    attemptKindLabel: item.analyticsEligible === true ? 'Assessment' : purpose === 'unclassified' ? 'Historical (unclassified)' : 'Practice',
    status: 'submitted',
    submittedAt: item.completedAt,
    savedAt: item.completedAt,
    selectedQuestionCount: null,
    responseCount: null,
    rawScore: item.score,
    rawPercentage: item.percentage,
    scaledScore: null,
    passed: item.passed,
    passMark: null,
    domainBreakdown: toObject(item.domainSummary),
    weakAreas: [],
    pbqBreakdown: {},
    caseStudyBreakdown: {},
    reportTitle: '',
    pdfGenerated: false,
    resultSnapshot: {},
    reportSnapshot: {},
    serverAuthoritative: item.serverAuthoritative === true,
    historySource: item.source,
    analyticsEligible: item.analyticsEligible === true,
    actorClassification: item.actorClassification ?? null,
  };
}

async function hydrateTrainerAttemptRows(attempts, students) {
  if (attempts.length === 0) {
    return createOkResult([]);
  }

  const attemptIds = attempts.map((attempt) => attempt.id).filter(Boolean);
  const catalogIds = [
    ...new Set(attempts.map((attempt) => attempt.exam_catalog_id).filter(Boolean)),
  ];
  const [resultsResult, reportsResult, catalogResult] = await Promise.all([
    queryRowsByAttemptIds('exam_results', RESULT_FIELDS, attemptIds),
    queryRowsByAttemptIds('exam_reports', REPORT_FIELDS, attemptIds),
    queryCatalogRows(catalogIds),
  ]);
  const failedResult = [resultsResult, reportsResult, catalogResult].find(
    (result) => !result.ok,
  );

  if (failedResult) {
    return failedResult;
  }

  const catalogById = groupFirstBy(catalogResult.data, 'id');
  const resultByAttemptId = groupFirstBy(resultsResult.data, 'attempt_id');
  const reportByAttemptId = groupFirstBy(reportsResult.data, 'attempt_id');

  return createOkResult(
    attempts.map((attempt) =>
      normalizeTrainerResult(attempt, {
        catalog: catalogById.get(attempt.exam_catalog_id) ?? null,
        report: reportByAttemptId.get(attempt.id) ?? null,
        result: resultByAttemptId.get(attempt.id) ?? null,
        students,
      }),
    ),
  );
}

async function queryRowsByAttemptIds(table, fields, attemptIds) {
  if (attemptIds.length === 0) {
    return createOkResult([]);
  }

  const { data, error } = await supabase
    .from(table)
    .select(fields)
    .in('attempt_id', attemptIds);

  return createServiceResult(data ?? [], error, `Could not read ${table}.`);
}

async function queryCatalogRows(catalogIds) {
  if (catalogIds.length === 0) {
    return createOkResult([]);
  }

  const { data, error } = await supabase
    .from('exam_catalog')
    .select(CATALOG_FIELDS)
    .in('id', catalogIds);

  return createServiceResult(
    data ?? [],
    error,
    'Could not load exam labels for saved results.',
  );
}

function hasTrainerDashboardAccess(identity) {
  return hasScopedPerformanceDashboardAccess(identity);
}

function normalizeGroup(group = {}) {
  return {
    id: group.id,
    name: group.name,
    academicYear: group.academic_year,
    maxStudents: group.max_students,
    status: group.status,
    organisationId: group.organisation_id,
    organisationName: group.organisation?.name ?? '',
    campusId: group.campus_id,
    campusName: group.campus?.name ?? '',
    campusCode: group.campus?.code ?? '',
    createdAt: group.created_at,
  };
}

function normalizeStudentMembership(membership = {}) {
  const profile = toObject(membership.profile);
  const group = toObject(membership.group);
  const campus = toObject(membership.campus);
  const organisation = toObject(membership.organisation);
  const displayName = getProfileDisplayName(profile);

  return {
    membershipId: membership.id,
    userId: membership.user_id,
    displayName,
    email: profile.email ?? '',
    status: membership.status,
    profileStatus: profile.status ?? '',
    groupId: membership.group_id,
    groupName: group.name ?? '',
    campusId: membership.campus_id,
    campusName: campus.name ?? '',
    organisationId: membership.organisation_id,
    organisationName: organisation.name ?? '',
    scopeLabel: [organisation.name, campus.name, group.name]
      .filter(Boolean)
      .join(' / '),
    createdAt: membership.created_at,
  };
}

function normalizeTrainerResult(
  attempt = {},
  { catalog = null, includeDetail = false, report = null, result = null, students = [] } = {},
) {
  const resultSnapshot = toObject(result?.result_snapshot);
  const reportSnapshot = toObject(report?.report_snapshot);
  const reportResult = toObject(reportSnapshot.result);
  const examSnapshot = toObject(resultSnapshot.exam ?? reportResult.exam);
  const profileSnapshot = toObject(examSnapshot.profile ?? resultSnapshot.profile);
  const domainBreakdown = normalizeDomainBreakdownSnapshot(
    result?.domain_breakdown ??
      resultSnapshot.domainBreakdown ??
      reportResult.domainBreakdown,
  );
  const weakAreas = normalizeWeakAreasSnapshot(
    result?.weak_areas ??
      resultSnapshot.weakAreas ??
      reportResult.weakAreas,
    domainBreakdown,
  );
  const selectedQuestionIds = Array.isArray(attempt.selected_question_ids)
    ? attempt.selected_question_ids
    : [];
  const studentMatches = students.filter(
    (student) => student.userId === attempt.user_id,
  );
  const primaryStudent = studentMatches[0] ?? {};
  const purposeRecord = { ...attempt, resultSnapshot, modeLabel: attempt.mode_label };
  const classification = classifyAttempt(purposeRecord);

  return {
    attemptId: attempt.id,
    userId: attempt.user_id,
    studentName: primaryStudent.displayName || 'Student',
    studentEmail: primaryStudent.email ?? '',
    studentScopes: studentMatches.map((student) => student.scopeLabel).filter(Boolean),
    groupName: primaryStudent.groupName ?? '',
    campusName: primaryStudent.campusName ?? '',
    organisationName: primaryStudent.organisationName ?? '',
    examKey: attempt.exam_key,
    examTitle:
      catalog?.title ??
      examSnapshot.displayTitle ??
      examSnapshot.name ??
      attempt.exam_key,
    vendor: catalog?.vendor ?? examSnapshot.vendor ?? '',
    profileId: attempt.profile_id,
    profileLabel: profileSnapshot.name ?? attempt.profile_id,
    modeLabel: attempt.mode_label ?? examSnapshot.mode?.name ?? '',
    purpose: getAttemptPurpose(purposeRecord),
    attemptKind: classification.kind,
    attemptKindLabel: getAttemptKindLabel(purposeRecord),
    status: attempt.status,
    submittedAt: attempt.submitted_at ?? resultSnapshot.submittedAt ?? '',
    savedAt: result?.created_at ?? attempt.created_at ?? '',
    durationSeconds: attempt.duration_seconds,
    timeLimitMinutes: attempt.time_limit_minutes,
    selectedQuestionCount:
      selectedQuestionIds.length ||
      resultSnapshot.totalScoredQuestions ||
      examSnapshot.profile?.totalScoredQuestions ||
      null,
    responseCount: selectedQuestionIds.length || null,
    rawScore:
      result?.raw_score ??
      resultSnapshot.earnedScorePoints ??
      resultSnapshot.totalCorrect ??
      null,
    rawPercentage: result?.raw_percentage ?? resultSnapshot.percentage ?? null,
    scaledScore: result?.scaled_score ?? resultSnapshot.scaledScore ?? null,
    passed: result?.passed ?? resultSnapshot.passed ?? null,
    passMark: result?.pass_mark ?? resultSnapshot.passingScore ?? null,
    domainBreakdown,
    weakAreas,
    pbqBreakdown: toObject(
      result?.pbq_breakdown ?? resultSnapshot.pbqBreakdown ?? resultSnapshot.pbqSummary,
    ),
    caseStudyBreakdown: toObject(
      result?.case_study_breakdown ??
        resultSnapshot.caseStudyBreakdown ??
        resultSnapshot.caseStudySummary,
    ),
    reportTitle: report?.report_title ?? '',
    pdfGenerated: Boolean(report?.pdf_generated),
    resultSnapshot: includeDetail ? resultSnapshot : {},
    reportSnapshot: includeDetail ? reportSnapshot : {},
  };
}

function getProfileDisplayName(profile = {}) {
  return (
    profile.display_name ||
    profile.full_name ||
    getNameFromEmail(profile.email) ||
    'Student'
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
      error.message || fallbackMessage,
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

function getReasonFromError(error) {
  if (error?.code === '42501' || /permission|policy|rls|authorized/i.test(error?.message ?? '')) {
    return 'not_authorized';
  }

  return 'request_failed';
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
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

function toObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function toArray(value) {
  return Array.isArray(value) ? value : [];
}
