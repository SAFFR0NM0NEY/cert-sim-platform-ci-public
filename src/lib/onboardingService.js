import { isSupabaseConfigured, supabase } from './supabaseClient.js';

const unavailableMessage =
  'Onboarding and protected certification exam access need Supabase configuration.';

const signedOutMessage =
  'Sign in or create an account to use onboarding features.';

const ONBOARDING_INVITE_FIELDS = `
  id,
  invite_token,
  invite_code,
  email,
  intended_role,
  organisation_id,
  campus_id,
  group_id,
  status,
  expires_at,
  invited_by,
  accepted_by_profile_id,
  accepted_at,
  created_at,
  updated_at,
  notes,
  organisation:organisations(id,name),
  campus:campuses(id,name,code),
  group:groups(id,name,academic_year),
  invitedBy:profiles!onboarding_invites_invited_by_fkey(id,email,full_name,display_name),
  acceptedBy:profiles!onboarding_invites_accepted_by_profile_id_fkey(id,email,full_name,display_name)
`;

const GROUP_ACCESS_CODE_FIELDS = `
  id,
  code,
  organisation_id,
  campus_id,
  group_id,
  intended_role,
  status,
  max_uses,
  uses_count,
  expires_at,
  created_by,
  created_at,
  updated_at,
  notes,
  organisation:organisations(id,name),
  campus:campuses(id,name,code),
  group:groups(id,name,academic_year),
  createdBy:profiles!group_access_codes_created_by_fkey(id,email,full_name,display_name)
`;

export const ONBOARDING_ROLE_OPTIONS = [
  { value: 'student', label: 'Student' },
  { value: 'trainer', label: 'Trainer' },
  { value: 'reception', label: 'Reception' },
  { value: 'campus_admin', label: 'Campus Admin' },
  { value: 'college_admin', label: 'College Admin' },
  { value: 'individual_user', label: 'Individual User' },
];

export async function listOnboardingRecords({
  scopeType,
  organisationId = '',
  campusId = '',
  groupId = '',
} = {}) {
  const authResult = await requireSignedInOnboarding();

  if (!authResult.ok) {
    return authResult;
  }

  const normalizedScope = normalizeScope({
    scopeType,
    organisationId,
    campusId,
    groupId,
  });

  if (!normalizedScope.ok) {
    return normalizedScope;
  }

  const scope = normalizedScope.data;
  const [invitesResult, accessCodesResult] = await Promise.all([
    queryScopedRows(
      supabase
        .from('onboarding_invites')
        .select(ONBOARDING_INVITE_FIELDS)
        .order('created_at', { ascending: false }),
      scope,
    ),
    queryScopedRows(
      supabase
        .from('group_access_codes')
        .select(GROUP_ACCESS_CODE_FIELDS)
        .order('created_at', { ascending: false }),
      scope,
    ),
  ]);

  if (!invitesResult.ok) {
    return invitesResult;
  }

  if (!accessCodesResult.ok) {
    return accessCodesResult;
  }

  return createOkResult({
    invites: invitesResult.data
      .map(normalizeInviteRow)
      .filter((invite) => isRecordInCurrentScope(invite, scope)),
    accessCodes: accessCodesResult.data
      .map(normalizeAccessCodeRow)
      .filter((accessCode) => isRecordInCurrentScope(accessCode, scope)),
  });
}

export async function createOnboardingInvite(payload = {}) {
  const authResult = await requireSignedInOnboarding();

  if (!authResult.ok) {
    return authResult;
  }

  const { data, error } = await supabase.rpc('create_onboarding_invite', {
    target_email: optionalText(payload.email),
    target_intended_role: cleanText(payload.intendedRole) || 'student',
    target_organisation_id: optionalText(payload.organisationId),
    target_campus_id: optionalText(payload.campusId),
    target_group_id: optionalText(payload.groupId),
    target_expires_at: normalizeDateTime(payload.expiresAt),
    target_notes: optionalText(payload.notes),
  });

  return createServiceResult(
    normalizeInviteRpcRow(data),
    error,
    'Could not create the onboarding invite.',
  );
}

export async function revokeOnboardingInvite(inviteId) {
  const authResult = await requireSignedInOnboarding();

  if (!authResult.ok) {
    return authResult;
  }

  const { data, error } = await supabase.rpc('revoke_onboarding_invite', {
    target_invite_id: cleanText(inviteId),
  });

  return createServiceResult(
    normalizeInviteRpcRow(data),
    error,
    'Could not revoke the onboarding invite.',
  );
}

export async function createGroupAccessCode(payload = {}) {
  const authResult = await requireSignedInOnboarding();

  if (!authResult.ok) {
    return authResult;
  }

  const { data, error } = await supabase.rpc('create_group_access_code', {
    target_group_id: cleanText(payload.groupId),
    target_max_uses: normalizePositiveInteger(payload.maxUses),
    target_expires_at: normalizeDateTime(payload.expiresAt),
    target_notes: optionalText(payload.notes),
  });

  return createServiceResult(
    normalizeAccessCodeRpcRow(data),
    error,
    'Could not create the group access code.',
  );
}

export async function disableGroupAccessCode(codeId) {
  const authResult = await requireSignedInOnboarding();

  if (!authResult.ok) {
    return authResult;
  }

  const { data, error } = await supabase.rpc('disable_group_access_code', {
    target_code_id: cleanText(codeId),
  });

  return createServiceResult(
    normalizeAccessCodeRpcRow(data),
    error,
    'Could not disable the group access code.',
  );
}

export async function createBulkGroupInvites({
  groupId,
  invites,
  expiresAt = '',
  notes = '',
} = {}) {
  const authResult = await requireSignedInOnboarding();

  if (!authResult.ok) {
    return authResult;
  }

  const cleanInvites = Array.isArray(invites)
    ? invites.map(normalizeBulkInviteInput).filter((invite) => invite.email)
    : [];

  if (cleanInvites.length === 0) {
    return createErrorResult(
      'invalid_payload',
      'Paste at least one valid email address for bulk onboarding.',
    );
  }

  const { data, error } = await supabase.rpc('create_bulk_onboarding_invites', {
    target_group_id: cleanText(groupId),
    target_invites: cleanInvites,
    target_expires_at: normalizeDateTime(expiresAt),
    target_notes: optionalText(notes),
  });

  return createServiceResult(
    Array.isArray(data) ? data.map(normalizeInviteRow) : [],
    error,
    'Could not generate bulk onboarding invites.',
  );
}

export async function getJoinInviteSummary(inviteToken) {
  if (!isSupabaseConfigured || !supabase) {
    return createErrorResult('supabase_not_configured', unavailableMessage);
  }

  const { data, error } = await supabase.rpc('get_join_invite_summary', {
    target_invite_token: cleanText(inviteToken),
  });

  return createServiceResult(
    normalizeJoinSummary(data),
    error,
    'Could not load the invite summary.',
  );
}

export async function getJoinCodeSummary(code) {
  if (!isSupabaseConfigured || !supabase) {
    return createErrorResult('supabase_not_configured', unavailableMessage);
  }

  const { data, error } = await supabase.rpc('get_join_code_summary', {
    target_code: cleanText(code),
  });

  return createServiceResult(
    normalizeJoinSummary(data),
    error,
    'Could not load the access-code summary.',
  );
}

export async function acceptOnboardingInvite(inviteToken) {
  const authResult = await requireSignedInOnboarding();

  if (!authResult.ok) {
    return authResult;
  }

  const { data, error } = await supabase.rpc('accept_onboarding_invite', {
    target_invite_token: cleanText(inviteToken),
  });

  return createServiceResult(
    normalizeAcceptResult(data),
    error,
    'Could not accept the onboarding invite.',
  );
}

export async function acceptGroupAccessCode(code) {
  const authResult = await requireSignedInOnboarding();

  if (!authResult.ok) {
    return authResult;
  }

  const { data, error } = await supabase.rpc('accept_group_access_code', {
    target_code: cleanText(code),
  });

  return createServiceResult(
    normalizeAcceptResult(data),
    error,
    'Could not join with that access code.',
  );
}

export function parseBulkInviteRows(text) {
  return cleanText(text)
    .split(/\r?\n/)
    .map((line, index) => parseBulkInviteLine(line, index))
    .filter((row) => row.raw || row.email);
}

export function buildInviteLink(inviteToken) {
  const token = cleanText(inviteToken);

  if (!token) {
    return '';
  }

  return `${getAppOrigin()}/join/${encodeURIComponent(token)}`;
}

export function buildCodeJoinLink(code) {
  const normalizedCode = cleanText(code).toUpperCase();

  if (!normalizedCode) {
    return `${getAppOrigin()}/join`;
  }

  return `${getAppOrigin()}/join?code=${encodeURIComponent(normalizedCode)}`;
}

async function requireSignedInOnboarding() {
  if (!isSupabaseConfigured || !supabase) {
    return createErrorResult('supabase_not_configured', unavailableMessage);
  }

  const { data, error } = await supabase.auth.getUser();
  const user = data?.user ?? null;

  if (error) {
    return createErrorResult(
      getReasonFromError(error),
      error.message || 'Could not read the current account.',
      error.code,
    );
  }

  if (!user) {
    return createErrorResult('not_signed_in', signedOutMessage);
  }

  return createOkResult({ user });
}

async function queryScopedRows(query, scope) {
  let nextQuery = query;

  if (scope.scopeType === 'organisation') {
    nextQuery = nextQuery.eq('organisation_id', scope.id);
  } else if (scope.scopeType === 'campus') {
    nextQuery = nextQuery.eq('campus_id', scope.id);
  } else if (scope.scopeType === 'group') {
    nextQuery = nextQuery.eq('group_id', scope.id);
  }

  const { data, error } = await nextQuery;

  return createServiceResult(
    Array.isArray(data) ? data : [],
    error,
    'Could not load onboarding records.',
  );
}

function isRecordInCurrentScope(record = {}, scope = {}) {
  if (scope.scopeType === 'group') {
    return record.groupId === scope.id;
  }

  if (scope.scopeType === 'campus') {
    return record.campusId === scope.id;
  }

  if (scope.scopeType === 'organisation') {
    return record.organisationId === scope.id;
  }

  return false;
}

function normalizeScope({
  scopeType,
  organisationId = '',
  campusId = '',
  groupId = '',
} = {}) {
  const normalizedType = cleanText(scopeType);
  const idByType = {
    organisation: cleanText(organisationId),
    campus: cleanText(campusId),
    group: cleanText(groupId),
  };
  const id = idByType[normalizedType] ?? '';

  if (!id) {
    return createErrorResult(
      'invalid_payload',
      'Choose a valid organisation, campus, or group onboarding scope.',
    );
  }

  return createOkResult({
    scopeType: normalizedType,
    id,
  });
}

function normalizeInviteRpcRow(value) {
  return normalizeInviteRow(Array.isArray(value) ? value[0] ?? {} : value ?? {});
}

function normalizeAccessCodeRpcRow(value) {
  return normalizeAccessCodeRow(
    Array.isArray(value) ? value[0] ?? {} : value ?? {},
  );
}

function normalizeInviteRow(row = {}) {
  const organisation = toObject(row.organisation);
  const campus = toObject(row.campus);
  const group = toObject(row.group);
  const invitedBy = toObject(row.invitedBy);
  const acceptedBy = toObject(row.acceptedBy);

  return {
    id: row.id ?? '',
    inviteToken: row.invite_token ?? '',
    inviteCode: row.invite_code ?? '',
    email: row.email ?? '',
    intendedRole: row.intended_role ?? '',
    organisationId: row.organisation_id ?? '',
    campusId: row.campus_id ?? '',
    groupId: row.group_id ?? '',
    status: row.status ?? '',
    expiresAt: row.expires_at ?? '',
    invitedById: row.invited_by ?? '',
    invitedByName: formatProfileLabel(invitedBy),
    acceptedByProfileId: row.accepted_by_profile_id ?? '',
    acceptedByName: formatProfileLabel(acceptedBy),
    acceptedAt: row.accepted_at ?? '',
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
    notes: row.notes ?? '',
    organisationName: organisation.name ?? '',
    campusName: campus.name ?? '',
    groupName: group.name ?? '',
    inviteLink: buildInviteLink(row.invite_token),
  };
}

function normalizeAccessCodeRow(row = {}) {
  const organisation = toObject(row.organisation);
  const campus = toObject(row.campus);
  const group = toObject(row.group);
  const createdBy = toObject(row.createdBy);

  return {
    id: row.id ?? '',
    code: row.code ?? '',
    intendedRole: row.intended_role ?? 'student',
    organisationId: row.organisation_id ?? '',
    campusId: row.campus_id ?? '',
    groupId: row.group_id ?? '',
    status: row.status ?? '',
    maxUses: row.max_uses ?? null,
    usesCount: row.uses_count ?? 0,
    expiresAt: row.expires_at ?? '',
    createdById: row.created_by ?? '',
    createdByName: formatProfileLabel(createdBy),
    createdAt: row.created_at ?? '',
    updatedAt: row.updated_at ?? '',
    notes: row.notes ?? '',
    organisationName: organisation.name ?? '',
    campusName: campus.name ?? '',
    groupName: group.name ?? '',
    joinLink: buildCodeJoinLink(row.code),
  };
}

function normalizeJoinSummary(value) {
  const row = Array.isArray(value) ? value[0] ?? {} : value ?? {};

  return {
    kind: row.kind ?? '',
    status: row.status ?? '',
    intendedRole: row.intended_role ?? '',
    organisationName: row.organisation_name ?? '',
    campusName: row.campus_name ?? '',
    groupName: row.group_name ?? '',
    expiresAt: row.expires_at ?? '',
    emailRequired: Boolean(row.email_required),
    emailHint: row.email_hint ?? '',
    isUsable: Boolean(row.is_usable),
    message: row.message ?? '',
  };
}

function normalizeAcceptResult(value) {
  const row = Array.isArray(value) ? value[0] ?? {} : value ?? {};

  return {
    membershipId: row.membership_id ?? '',
    organisationName: row.organisation_name ?? '',
    campusName: row.campus_name ?? '',
    groupName: row.group_name ?? '',
    role: row.role ?? '',
    message: row.message ?? 'Membership updated.',
  };
}

function normalizeBulkInviteInput(row = {}) {
  return {
    email: cleanText(row.email).toLowerCase(),
    display_name: optionalText(row.displayName),
    notes: optionalText(row.notes),
  };
}

function parseBulkInviteLine(line, index) {
  const raw = String(line ?? '').trim();

  if (!raw) {
    return {
      index,
      raw,
      email: '',
      displayName: '',
      notes: '',
      isValid: false,
      error: '',
    };
  }

  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const [email = '', displayName = '', ...noteParts] = parts;
  const normalizedEmail = email.toLowerCase();
  const isValid = isLikelyEmail(normalizedEmail);

  return {
    index,
    raw,
    email: normalizedEmail,
    displayName,
    notes: noteParts.join(', '),
    isValid,
    error: isValid ? '' : 'Enter a valid email address.',
  };
}

function normalizeDateTime(value) {
  const text = cleanText(value);

  if (!text) {
    return null;
  }

  const date = new Date(text);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizePositiveInteger(value) {
  const text = cleanText(String(value ?? ''));

  if (!text) {
    return null;
  }

  const parsed = Number.parseInt(text, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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
  if (error?.code === '42501' || /permission|policy|authorized/i.test(error?.message ?? '')) {
    return 'not_authorized';
  }

  return 'request_failed';
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

function isLikelyEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanText(value));
}

function toObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function getAppOrigin() {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }

  return '';
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(value) {
  const text = cleanText(value);

  return text || null;
}
