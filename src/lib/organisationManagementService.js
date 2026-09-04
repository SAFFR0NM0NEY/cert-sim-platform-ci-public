import { isSupabaseConfigured, supabase } from './supabaseClient.js';
import { getCurrentIdentitySummary } from './profileService.js';
import { hasActiveMembershipRole } from './roleUtils.js';

export const ORGANISATION_TYPES = [
  'training_provider',
  'company',
  'internal',
  'individual_market',
];

export const MEMBERSHIP_ROLES = [
  'platform_owner',
  'developer',
  'college_admin',
  'campus_admin',
  'trainer',
  'reception',
  'student',
  'individual_user',
];

export const RECORD_STATUSES = [
  'active',
  'invited',
  'suspended',
  'archived',
];

export const MEMBERSHIP_STATUSES = [
  ...RECORD_STATUSES,
  'removed',
];

export const MEMBERSHIP_CREATE_STATUSES = RECORD_STATUSES;

const ORGANISATION_FIELDS =
  'id,name,organisation_type,status,billing_model,notes,created_at,updated_at';
const CAMPUS_FIELDS =
  'id,organisation_id,name,code,status,created_at,updated_at,organisation:organisations(id,name)';
const GROUP_FIELDS =
  'id,organisation_id,campus_id,name,academic_year,max_students,status,created_at,updated_at,organisation:organisations(id,name),campus:campuses(id,name,code)';
const PROFILE_FIELDS =
  'id,email,full_name,display_name,phone,user_type,default_role,status,created_at,updated_at';
const MEMBERSHIP_FIELDS = `
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
  examCatalog:exam_catalog(id,exam_key,slug,title,vendor,lifecycle,exam_type,current_version,status),
  organisation:organisations(id,name,organisation_type,status),
  campus:campuses(id,name,code,status),
  group:groups(id,name,academic_year,status),
  student:profiles!exam_assignments_student_user_id_fkey(id,email,full_name,display_name,status),
  assignedBy:profiles!exam_assignments_assigned_by_fkey(id,email,full_name,display_name,status)
`;
const ATTEMPT_FIELDS = [
  'id',
  'user_id',
  'exam_catalog_id',
  'exam_key',
  'profile_id',
  'mode_label',
  'status',
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

export async function getOrganisationManagementSnapshot() {
  const authResult = await requirePlatformOwner();

  if (!authResult.ok) {
    return authResult;
  }

  const [
    organisationsResult,
    campusesResult,
    groupsResult,
    profilesResult,
    membershipsResult,
  ] = await Promise.all([
    readOrganisations(),
    readCampuses(),
    readGroups(),
    readProfiles(),
    readMemberships(),
  ]);
  const failedResult = [
    organisationsResult,
    campusesResult,
    groupsResult,
    profilesResult,
    membershipsResult,
  ].find((result) => !result.ok);

  if (failedResult) {
    return failedResult;
  }

  return createOkResult({
    organisations: organisationsResult.data,
    campuses: campusesResult.data,
    groups: groupsResult.data,
    profiles: profilesResult.data,
    memberships: membershipsResult.data,
  });
}

export async function listOrganisations() {
  return readWithPlatformOwnerGuard(readOrganisations);
}

export async function createOrganisation(payload = {}) {
  const authResult = await requirePlatformOwner();

  if (!authResult.ok) {
    return authResult;
  }

  const name = cleanText(payload.name);
  const organisationType = cleanText(payload.organisation_type);

  if (!name) {
    return createErrorResult(
      'invalid_payload',
      'Organisation name is required.',
    );
  }

  if (!ORGANISATION_TYPES.includes(organisationType)) {
    return createErrorResult(
      'invalid_payload',
      'Choose a valid organisation type.',
    );
  }

  const { data, error } = await supabase
    .from('organisations')
    .insert({
      name,
      organisation_type: organisationType,
      billing_model: optionalText(payload.billing_model),
      notes: optionalText(payload.notes),
      status: 'active',
    })
    .select(ORGANISATION_FIELDS)
    .single();

  return createServiceResult(
    data,
    error,
    'Could not create the organisation.',
  );
}

export async function listCampuses() {
  return readWithPlatformOwnerGuard(readCampuses);
}

export async function createCampus(payload = {}) {
  const authResult = await requirePlatformOwner();

  if (!authResult.ok) {
    return authResult;
  }

  const organisationId = cleanText(payload.organisation_id);
  const name = cleanText(payload.name);

  if (!organisationId || !name) {
    return createErrorResult(
      'invalid_payload',
      'Organisation and campus name are required.',
    );
  }

  const { data, error } = await supabase
    .from('campuses')
    .insert({
      organisation_id: organisationId,
      name,
      code: optionalText(payload.code),
      status: 'active',
    })
    .select(CAMPUS_FIELDS)
    .single();

  return createServiceResult(data, error, 'Could not create the campus.');
}

export async function listGroups() {
  return readWithPlatformOwnerGuard(readGroups);
}

export async function createGroup(payload = {}) {
  const authResult = await requirePlatformOwner();

  if (!authResult.ok) {
    return authResult;
  }

  const organisationId = cleanText(payload.organisation_id);
  const name = cleanText(payload.name);
  const maxStudents = normalizePositiveInteger(payload.max_students, 50);

  if (!organisationId || !name) {
    return createErrorResult(
      'invalid_payload',
      'Organisation and group name are required.',
    );
  }

  const { data, error } = await supabase
    .from('groups')
    .insert({
      organisation_id: organisationId,
      campus_id: optionalText(payload.campus_id),
      name,
      academic_year: normalizeOptionalInteger(payload.academic_year),
      max_students: maxStudents,
      status: 'active',
    })
    .select(GROUP_FIELDS)
    .single();

  return createServiceResult(data, error, 'Could not create the group.');
}

export async function listProfiles() {
  return readWithPlatformOwnerGuard(readProfiles);
}

export async function listMemberships() {
  return readWithPlatformOwnerGuard(readMemberships);
}

export async function createMembership(payload = {}) {
  const authResult = await requirePlatformOwner();

  if (!authResult.ok) {
    return authResult;
  }

  const userId = cleanText(payload.user_id);
  const organisationId = cleanText(payload.organisation_id);
  const role = cleanText(payload.role);
  const status = cleanText(payload.status || 'active');

  if (!userId || !organisationId || !role) {
    return createErrorResult(
      'invalid_payload',
      'Profile, organisation, and role are required.',
    );
  }

  if (!MEMBERSHIP_ROLES.includes(role)) {
    return createErrorResult('invalid_payload', 'Choose a valid role.');
  }

  if (!RECORD_STATUSES.includes(status)) {
    return createErrorResult('invalid_payload', 'Choose a valid status.');
  }

  const { data, error } = await supabase
    .from('memberships')
    .insert({
      user_id: userId,
      organisation_id: organisationId,
      campus_id: optionalText(payload.campus_id),
      group_id: optionalText(payload.group_id),
      role,
      status,
    })
    .select(MEMBERSHIP_FIELDS)
    .single();

  return createServiceResult(data, error, 'Could not create the membership.');
}

export async function updateMembershipStatus(membershipId, status) {
  if (!isSupabaseConfigured || !supabase) {
    return createErrorResult(
      'supabase_not_configured',
      'Organisation management is not configured in this environment.',
    );
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
    return createErrorResult(
      'not_signed_in',
      'Sign in with a scoped admin or Platform Owner account to manage memberships.',
    );
  }

  const normalizedId = cleanText(membershipId);
  const normalizedStatus = cleanText(status);

  if (!normalizedId || !MEMBERSHIP_STATUSES.includes(normalizedStatus)) {
    return createErrorResult(
      'invalid_payload',
      'Choose a valid membership and status.',
    );
  }

  const { data, error } = await supabase.rpc(
    'update_membership_lifecycle_status',
    {
      target_membership_id: normalizedId,
      target_status: normalizedStatus,
    },
  );

  return createServiceResult(
    Array.isArray(data) ? data[0] ?? null : data ?? null,
    error,
    'Could not update the membership status.',
  );
}

export async function removeMembershipRole(membershipId) {
  return updateMembershipStatus(membershipId, 'removed');
}

export async function getOrganisationDetail(organisationId) {
  const authResult = await requireScopedDetailAccess();

  if (!authResult.ok) {
    return authResult;
  }

  const normalizedId = cleanText(organisationId);

  if (!normalizedId) {
    return createErrorResult('invalid_payload', 'Choose an organisation.');
  }

  const { data, error } = await supabase
    .from('organisations')
    .select(ORGANISATION_FIELDS)
    .eq('id', normalizedId)
    .maybeSingle();

  return createMaybeSingleResult(
    data,
    error,
    'organisation',
    'Could not load the organisation detail.',
  );
}

export async function getCampusDetail(campusId) {
  const authResult = await requireScopedDetailAccess();

  if (!authResult.ok) {
    return authResult;
  }

  const normalizedId = cleanText(campusId);

  if (!normalizedId) {
    return createErrorResult('invalid_payload', 'Choose a campus.');
  }

  const { data, error } = await supabase
    .from('campuses')
    .select(CAMPUS_FIELDS)
    .eq('id', normalizedId)
    .maybeSingle();

  return createMaybeSingleResult(
    data,
    error,
    'campus',
    'Could not load the campus detail.',
  );
}

export async function getGroupDetail(groupId) {
  const authResult = await requireScopedDetailAccess();

  if (!authResult.ok) {
    return authResult;
  }

  const normalizedId = cleanText(groupId);

  if (!normalizedId) {
    return createErrorResult('invalid_payload', 'Choose a group/class.');
  }

  const { data, error } = await supabase
    .from('groups')
    .select(GROUP_FIELDS)
    .eq('id', normalizedId)
    .maybeSingle();

  return createMaybeSingleResult(
    data,
    error,
    'group/class',
    'Could not load the group detail.',
  );
}

export async function updateOrganisation(organisationId, payload = {}) {
  const authResult = await requireScopedDetailAccess();

  if (!authResult.ok) {
    return authResult;
  }

  const normalizedId = cleanText(organisationId);
  const name = cleanText(payload.name);
  const organisationType = cleanText(payload.organisation_type);
  const status = cleanText(payload.status || 'active');

  if (!normalizedId || !name) {
    return createErrorResult(
      'invalid_payload',
      'Organisation and name are required.',
    );
  }

  if (!ORGANISATION_TYPES.includes(organisationType)) {
    return createErrorResult(
      'invalid_payload',
      'Choose a valid organisation type.',
    );
  }

  if (!RECORD_STATUSES.includes(status)) {
    return createErrorResult('invalid_payload', 'Choose a valid status.');
  }

  const { data, error } = await supabase
    .from('organisations')
    .update({
      billing_model: optionalText(payload.billing_model),
      name,
      notes: optionalText(payload.notes),
      organisation_type: organisationType,
      status,
    })
    .eq('id', normalizedId)
    .select(ORGANISATION_FIELDS)
    .maybeSingle();

  return createMaybeSingleResult(
    data,
    error,
    'organisation',
    'Could not update the organisation.',
  );
}

export async function updateCampus(campusId, payload = {}) {
  const authResult = await requireScopedDetailAccess();

  if (!authResult.ok) {
    return authResult;
  }

  const normalizedId = cleanText(campusId);
  const name = cleanText(payload.name);
  const status = cleanText(payload.status || 'active');

  if (!normalizedId || !name) {
    return createErrorResult('invalid_payload', 'Campus and name are required.');
  }

  if (!RECORD_STATUSES.includes(status)) {
    return createErrorResult('invalid_payload', 'Choose a valid status.');
  }

  const { data, error } = await supabase
    .from('campuses')
    .update({
      code: optionalText(payload.code),
      name,
      status,
    })
    .eq('id', normalizedId)
    .select(CAMPUS_FIELDS)
    .maybeSingle();

  return createMaybeSingleResult(
    data,
    error,
    'campus',
    'Could not update the campus.',
  );
}

export async function updateGroup(groupId, payload = {}) {
  const authResult = await requireScopedDetailAccess();

  if (!authResult.ok) {
    return authResult;
  }

  const normalizedId = cleanText(groupId);
  const name = cleanText(payload.name);
  const status = cleanText(payload.status || 'active');

  if (!normalizedId || !name) {
    return createErrorResult('invalid_payload', 'Group and name are required.');
  }

  if (!RECORD_STATUSES.includes(status)) {
    return createErrorResult('invalid_payload', 'Choose a valid status.');
  }

  const { data, error } = await supabase
    .from('groups')
    .update({
      academic_year: normalizeOptionalInteger(payload.academic_year),
      max_students: normalizePositiveInteger(payload.max_students, 50),
      name,
      status,
    })
    .eq('id', normalizedId)
    .select(GROUP_FIELDS)
    .maybeSingle();

  return createMaybeSingleResult(
    data,
    error,
    'group/class',
    'Could not update the group.',
  );
}

export async function listOrganisationCampuses(organisationId) {
  return readScopedRows(
    () =>
      supabase
        .from('campuses')
        .select(CAMPUS_FIELDS)
        .eq('organisation_id', cleanText(organisationId))
        .order('name', { ascending: true }),
    'Could not load organisation campuses.',
  );
}

export async function listOrganisationGroups(organisationId) {
  return readScopedRows(
    () =>
      supabase
        .from('groups')
        .select(GROUP_FIELDS)
        .eq('organisation_id', cleanText(organisationId))
        .order('name', { ascending: true }),
    'Could not load organisation groups.',
  );
}

export async function listOrganisationMemberships(organisationId) {
  return readScopedRows(
    () =>
      supabase
        .from('memberships')
        .select(MEMBERSHIP_FIELDS)
        .eq('organisation_id', cleanText(organisationId))
        .order('created_at', { ascending: false }),
    'Could not load organisation memberships.',
  );
}

export async function listCampusGroups(campusId) {
  return readScopedRows(
    () =>
      supabase
        .from('groups')
        .select(GROUP_FIELDS)
        .eq('campus_id', cleanText(campusId))
        .order('name', { ascending: true }),
    'Could not load campus groups.',
  );
}

export async function listCampusMemberships(campusId) {
  return readScopedRows(
    () =>
      supabase
        .from('memberships')
        .select(MEMBERSHIP_FIELDS)
        .eq('campus_id', cleanText(campusId))
        .order('created_at', { ascending: false }),
    'Could not load campus memberships.',
  );
}

export async function listGroupStudents(groupId) {
  return readScopedRows(
    () =>
      supabase
        .from('memberships')
        .select(MEMBERSHIP_FIELDS)
        .eq('group_id', cleanText(groupId))
        .eq('role', 'student')
        .order('created_at', { ascending: false }),
    'Could not load group students.',
  );
}

export async function listGroupAssignments(groupId) {
  const result = await readScopedRows(
    () =>
      supabase
        .from('exam_assignments')
        .select(ASSIGNMENT_FIELDS)
        .eq('group_id', cleanText(groupId))
        .order('due_at', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false }),
    'Could not load group assignments.',
  );

  return result.ok
    ? createOkResult(result.data.map(normalizeAssignmentRow))
    : result;
}

export async function listGroupSavedResults(groupId) {
  const studentsResult = await listGroupStudents(groupId);

  if (!studentsResult.ok) {
    return studentsResult;
  }

  const students = studentsResult.data.map(normalizeStudentMembership);
  const studentIds = [
    ...new Set(students.map((student) => student.userId).filter(Boolean)),
  ];

  if (studentIds.length === 0) {
    return createOkResult([]);
  }

  const attemptsResult = await readScopedRows(
    () =>
      supabase
        .from('exam_attempts')
        .select(ATTEMPT_FIELDS)
        .eq('status', 'submitted')
        .in('user_id', studentIds)
        .order('submitted_at', { ascending: false, nullsFirst: false })
        .limit(50),
    'Could not load group saved results.',
  );

  if (!attemptsResult.ok || attemptsResult.data.length === 0) {
    return attemptsResult;
  }

  return hydrateSavedResultRows(attemptsResult.data, students);
}

export async function getOrganisationDetailSnapshot(organisationId) {
  const detailResult = await getOrganisationDetail(organisationId);

  if (!detailResult.ok) {
    return detailResult;
  }

  const [campusesResult, groupsResult, membershipsResult] = await Promise.all([
    listOrganisationCampuses(organisationId),
    listOrganisationGroups(organisationId),
    listOrganisationMemberships(organisationId),
  ]);
  const failedResult = [campusesResult, groupsResult, membershipsResult].find(
    (result) => !result.ok,
  );

  if (failedResult) {
    return failedResult;
  }

  return createOkResult({
    organisation: detailResult.data,
    campuses: campusesResult.data,
    groups: groupsResult.data,
    memberships: membershipsResult.data,
  });
}

export async function getCampusDetailSnapshot(campusId) {
  const detailResult = await getCampusDetail(campusId);

  if (!detailResult.ok) {
    return detailResult;
  }

  const [groupsResult, membershipsResult] = await Promise.all([
    listCampusGroups(campusId),
    listCampusMemberships(campusId),
  ]);
  const failedResult = [groupsResult, membershipsResult].find(
    (result) => !result.ok,
  );

  if (failedResult) {
    return failedResult;
  }

  return createOkResult({
    campus: detailResult.data,
    groups: groupsResult.data,
    memberships: membershipsResult.data,
  });
}

export async function getGroupDetailSnapshot(groupId) {
  const detailResult = await getGroupDetail(groupId);

  if (!detailResult.ok) {
    return detailResult;
  }

  const [studentsResult, assignmentsResult, savedResultsResult] =
    await Promise.all([
      listGroupStudents(groupId),
      listGroupAssignments(groupId),
      listGroupSavedResults(groupId),
    ]);
  const failedResult = [
    studentsResult,
    assignmentsResult,
    savedResultsResult,
  ].find((result) => !result.ok);

  if (failedResult) {
    return failedResult;
  }

  return createOkResult({
    group: detailResult.data,
    students: studentsResult.data,
    assignments: assignmentsResult.data,
    savedResults: savedResultsResult.data,
  });
}

async function readWithPlatformOwnerGuard(reader) {
  const authResult = await requirePlatformOwner();

  return authResult.ok ? reader() : authResult;
}

async function readOrganisations() {
  const { data, error } = await supabase
    .from('organisations')
    .select(ORGANISATION_FIELDS)
    .order('created_at', { ascending: false });

  return createServiceResult(
    data ?? [],
    error,
    'Could not load organisations.',
  );
}

async function readCampuses() {
  const { data, error } = await supabase
    .from('campuses')
    .select(CAMPUS_FIELDS)
    .order('created_at', { ascending: false });

  return createServiceResult(data ?? [], error, 'Could not load campuses.');
}

async function readGroups() {
  const { data, error } = await supabase
    .from('groups')
    .select(GROUP_FIELDS)
    .order('created_at', { ascending: false });

  return createServiceResult(data ?? [], error, 'Could not load groups.');
}

async function readProfiles() {
  const { data, error } = await supabase
    .from('profiles')
    .select(PROFILE_FIELDS)
    .order('created_at', { ascending: false });

  return createServiceResult(data ?? [], error, 'Could not load profiles.');
}

async function readMemberships() {
  const { data, error } = await supabase
    .from('memberships')
    .select(MEMBERSHIP_FIELDS)
    .order('created_at', { ascending: false });

  return createServiceResult(data ?? [], error, 'Could not load memberships.');
}

async function requirePlatformOwner() {
  if (!isSupabaseConfigured || !supabase) {
    return createErrorResult(
      'supabase_not_configured',
      'Organisation management is not configured in this environment.',
    );
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
    return createErrorResult(
      'not_signed_in',
      'Sign in with a Platform Owner account to manage organisation records.',
    );
  }

  const { data: identity, error: identityError } =
    await getCurrentIdentitySummary();

  if (!identity?.isPlatformOwner) {
    return createErrorResult(
      'not_authorized',
      identityError?.message ||
        'Your current account is not allowed to manage organisation records.',
      identityError?.code,
    );
  }

  return createOkResult({ user, identity });
}

async function requireScopedDetailAccess() {
  if (!isSupabaseConfigured || !supabase) {
    return createErrorResult(
      'supabase_not_configured',
      'Scoped organisation detail is not configured in this environment.',
    );
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
    return createErrorResult(
      'not_signed_in',
      'Sign in to view scoped organisation detail.',
    );
  }

  const { data: identity, error: identityError } =
    await getCurrentIdentitySummary();

  if (!hasScopedDetailRole(identity)) {
    return createErrorResult(
      'not_authorized',
      identityError?.message ||
        'This account is not allowed to view scoped organisation detail.',
      identityError?.code,
    );
  }

  return createOkResult({ user, identity });
}

async function readScopedRows(queryFactory, fallbackMessage) {
  const authResult = await requireScopedDetailAccess();

  if (!authResult.ok) {
    return authResult;
  }

  const { data, error } = await queryFactory();

  return createServiceResult(data ?? [], error, fallbackMessage);
}

function hasScopedDetailRole(identity) {
  if (identity?.isPlatformOwner) {
    return true;
  }

  return hasActiveMembershipRole(identity?.memberships, [
    'developer',
    'college_admin',
    'campus_admin',
    'trainer',
  ]);
}

function createMaybeSingleResult(data, error, label, fallbackMessage) {
  if (error) {
    return createServiceResult(null, error, fallbackMessage);
  }

  if (!data) {
    return createErrorResult(
      'not_found',
      `The selected ${label} was not found or is not visible to this account.`,
    );
  }

  return createOkResult(data);
}

async function hydrateSavedResultRows(attempts, students) {
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
      normalizeSavedResultRow(attempt, {
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

  return createServiceResult(data ?? [], error, 'Could not load exam labels.');
}

function normalizeAssignmentRow(row = {}) {
  const examCatalog = toObject(row.examCatalog);
  const organisation = toObject(row.organisation);
  const campus = toObject(row.campus);
  const group = toObject(row.group);
  const student = toObject(row.student);
  const assignedBy = toObject(row.assignedBy);
  const targetType = row.student_user_id ? 'student' : 'group';
  const studentName = formatProfileLabel(student);
  const groupName = group.name ?? '';
  const targetName = targetType === 'student'
    ? studentName
    : groupName || 'Group assignment';

  return {
    id: row.id,
    assignmentType: row.assignment_type,
    availableFrom: row.available_from,
    campusId: row.campus_id,
    campusName: campus.name ?? '',
    createdAt: row.created_at,
    dueAt: row.due_at,
    examKey: row.exam_key,
    examTitle: examCatalog.title ?? row.exam_key,
    groupId: row.group_id,
    groupName,
    instructions: row.instructions ?? '',
    organisationId: row.organisation_id,
    organisationName: organisation.name ?? '',
    status: row.status,
    studentEmail: student.email ?? '',
    studentName,
    studentUserId: row.student_user_id,
    targetLabel: [targetName, targetType === 'student' ? groupName : '']
      .filter(Boolean)
      .join(' / '),
    targetType,
    title: row.title,
    updatedAt: row.updated_at,
    assignedByName: formatProfileLabel(assignedBy),
  };
}

function normalizeStudentMembership(membership = {}) {
  const profile = toObject(membership.profile);
  const group = toObject(membership.group);
  const campus = toObject(membership.campus);
  const organisation = toObject(membership.organisation);

  return {
    campusId: membership.campus_id,
    campusName: campus.name ?? '',
    displayName: formatProfileLabel(profile),
    email: profile.email ?? '',
    groupId: membership.group_id,
    groupName: group.name ?? '',
    membershipId: membership.id,
    organisationId: membership.organisation_id,
    organisationName: organisation.name ?? '',
    userId: membership.user_id,
  };
}

function normalizeSavedResultRow(
  attempt = {},
  { catalog = null, report = null, result = null, students = [] } = {},
) {
  const selectedQuestionIds = Array.isArray(attempt.selected_question_ids)
    ? attempt.selected_question_ids
    : [];
  const student = students.find((item) => item.userId === attempt.user_id) ?? {};
  const resultSnapshot = toObject(result?.result_snapshot);
  const reportSnapshot = toObject(report?.report_snapshot);
  const examSnapshot = toObject(resultSnapshot.exam ?? reportSnapshot.result?.exam);

  return {
    attemptId: attempt.id,
    durationSeconds: attempt.duration_seconds,
    examKey: attempt.exam_key,
    examTitle: catalog?.title ?? examSnapshot.displayTitle ?? attempt.exam_key,
    modeLabel: attempt.mode_label ?? examSnapshot.mode?.name ?? '',
    passed: result?.passed ?? resultSnapshot.passed ?? null,
    profileId: attempt.profile_id,
    profileLabel: resultSnapshot.profile?.name ?? attempt.profile_id,
    rawPercentage: result?.raw_percentage ?? resultSnapshot.percentage ?? null,
    reportTitle: report?.report_title ?? '',
    responseCount: selectedQuestionIds.length || null,
    savedAt: result?.created_at ?? attempt.created_at ?? '',
    scaledScore: result?.scaled_score ?? resultSnapshot.scaledScore ?? null,
    status: attempt.status,
    studentEmail: student.email ?? '',
    studentName: student.displayName ?? 'Student',
    submittedAt: attempt.submitted_at ?? resultSnapshot.submittedAt ?? '',
    userId: attempt.user_id,
    weakAreas: Array.isArray(result?.weak_areas) ? result.weak_areas : [],
  };
}

function groupFirstBy(rows = [], key) {
  const map = new Map();

  rows.forEach((row) => {
    const value = row?.[key];

    if (value && !map.has(value)) {
      map.set(value, row);
    }
  });

  return map;
}

function toObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function formatProfileLabel(profile = {}) {
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

function optionalText(value) {
  const text = cleanText(value);

  return text || null;
}

function normalizeOptionalInteger(value) {
  const text = cleanText(String(value ?? ''));

  if (!text) {
    return null;
  }

  const parsed = Number.parseInt(text, 10);

  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = normalizeOptionalInteger(value);

  return parsed && parsed > 0 ? parsed : fallback;
}
