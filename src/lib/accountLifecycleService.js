import { isSupabaseConfigured, supabase } from './supabaseClient.js';

const ACCOUNT_DELETION_REQUEST_FIELDS = `
  id,
  profile_id,
  user_id,
  email_snapshot,
  reason,
  status,
  requested_at,
  reviewed_by,
  reviewed_at,
  admin_notes
`;

const unavailableResult = {
  ok: false,
  reason: 'supabase_not_configured',
  message: 'Account lifecycle requests are not configured in this environment yet.',
};

const signedOutResult = {
  ok: false,
  reason: 'not_signed_in',
  message: 'Sign in to request account deletion or view request status.',
};

export async function listMyAccountDeletionRequests() {
  const authResult = await requireAuthenticatedUser();

  if (!authResult.ok) {
    return authResult;
  }

  const { data, error } = await supabase
    .from('account_deletion_requests')
    .select(ACCOUNT_DELETION_REQUEST_FIELDS)
    .eq('profile_id', authResult.user.id)
    .order('requested_at', { ascending: false })
    .limit(10);

  return createServiceResult(
    Array.isArray(data) ? data.map(normalizeAccountDeletionRequest) : [],
    error,
    'Could not load account deletion request status.',
  );
}

export async function createAccountDeletionRequest({ reason = '' } = {}) {
  const authResult = await requireAuthenticatedUser();

  if (!authResult.ok) {
    return authResult;
  }

  const { data, error } = await supabase
    .from('account_deletion_requests')
    .insert({
      profile_id: authResult.user.id,
      user_id: authResult.user.id,
      email_snapshot: authResult.user.email ?? null,
      reason: optionalText(reason),
      status: 'open',
    })
    .select(ACCOUNT_DELETION_REQUEST_FIELDS)
    .single();

  return createServiceResult(
    data ? normalizeAccountDeletionRequest(data) : null,
    error,
    'Could not create the account deletion request. Ask Jean to confirm migration 0009 has been applied.',
  );
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

  return {
    ok: true,
    user,
  };
}

function normalizeAccountDeletionRequest(row = {}) {
  return {
    id: row.id,
    profileId: row.profile_id,
    userId: row.user_id,
    emailSnapshot: row.email_snapshot ?? '',
    reason: row.reason ?? '',
    status: row.status ?? 'open',
    requestedAt: row.requested_at ?? '',
    reviewedBy: row.reviewed_by ?? '',
    reviewedAt: row.reviewed_at ?? '',
    adminNotes: row.admin_notes ?? '',
  };
}

function createServiceResult(data, error, fallbackMessage) {
  if (error) {
    return createErrorResult(
      getReasonFromError(error),
      error.message || fallbackMessage,
      error.code,
    );
  }

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
  if (error?.code === '42P01' || error?.code === '42703' || error?.code === '42883') {
    return 'schema_missing';
  }

  if (error?.code === '42501' || /permission|policy|rls|authorized/i.test(error?.message ?? '')) {
    return 'not_authorized';
  }

  return 'request_failed';
}

function optionalText(value) {
  const text = String(value ?? '').trim();

  return text || null;
}
