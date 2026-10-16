import { isSupabaseConfigured, supabase } from './supabaseClient.js';
import {
  formatMembershipLabel,
  getPrimaryRole,
  isPlatformOwnerRole,
} from './roleUtils.js';

const profileUnavailableResult = {
  data: null,
  error: {
    message: 'Profile features are not configured for this environment yet.',
  },
};

const signedOutResult = {
  data: null,
  error: {
    message: 'Sign in to view account profile details.',
  },
};

function getProfileUnavailableResult() {
  return {
    data: profileUnavailableResult.data,
    error: { ...profileUnavailableResult.error },
  };
}

function getSignedOutResult() {
  return {
    data: signedOutResult.data,
    error: { ...signedOutResult.error },
  };
}

function getFriendlyProfileError(error, fallbackMessage) {
  if (!error) {
    return null;
  }

  return {
    ...error,
    message: error.message || fallbackMessage,
  };
}

async function getAuthenticatedUser() {
  if (!isSupabaseConfigured || !supabase) {
    return getProfileUnavailableResult();
  }

  const { data, error } = await supabase.auth.getUser();
  const user = data?.user ?? null;

  if (error) {
    return {
      data: null,
      error: getFriendlyProfileError(error, 'Could not read the current account.'),
    };
  }

  if (!user) {
    return getSignedOutResult();
  }

  return {
    data: user,
    error: null,
  };
}

export async function getCurrentProfile(authenticatedUser = null) {
  const { data: user, error: userError } = authenticatedUser
    ? { data: authenticatedUser, error: null }
    : await getAuthenticatedUser();

  if (userError) {
    return {
      data: null,
      error: userError,
    };
  }

  const { data, error } = await supabase
    .from('profiles')
    .select('id,email,full_name,display_name,phone,user_type,default_role,status,created_at,updated_at')
    .eq('id', user.id)
    .maybeSingle();

  return {
    data: data ?? null,
    error: getFriendlyProfileError(error, 'Could not read the current profile.'),
  };
}

export async function getCurrentMemberships(authenticatedUser = null) {
  const { data: user, error: userError } = authenticatedUser
    ? { data: authenticatedUser, error: null }
    : await getAuthenticatedUser();

  if (userError) {
    return {
      data: [],
      error: userError,
    };
  }

  const { data, error } = await supabase
    .from('memberships')
    .select(`
      id,
      user_id,
      organisation_id,
      campus_id,
      group_id,
      role,
      status,
      created_at,
      updated_at,
      organisation:organisations(id,name,organisation_type,status),
      campus:campuses(id,name,code,status),
      group:groups(id,name,academic_year,status)
    `)
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });

  return {
    data: Array.isArray(data) ? data : [],
    error: getFriendlyProfileError(error, 'Could not read current memberships.'),
  };
}

export async function getCurrentIdentitySummary() {
  if (!isSupabaseConfigured || !supabase) {
    return {
      data: createIdentitySummary(),
      error: profileUnavailableResult.error,
    };
  }

  const { data: user, error: userError } = await getAuthenticatedUser();

  if (userError) {
    return {
      data: createIdentitySummary(),
      error: userError,
    };
  }

  const [profileResult, membershipsResult] = await Promise.all([
    getCurrentProfile(user),
    getCurrentMemberships(user),
  ]);
  const profile = profileResult.data;
  const memberships = membershipsResult.data;
  const primaryRole = getPrimaryRole(memberships, profile?.default_role);
  const summary = createIdentitySummary({
    profile,
    memberships,
    primaryRole,
    userEmail: user.email,
  });
  const error = profileResult.error ?? membershipsResult.error ?? null;

  return {
    data: summary,
    error,
  };
}

export async function updateManagedProfileDisplayName({
  displayName,
  fullName = '',
  profileId,
} = {}) {
  if (!isSupabaseConfigured || !supabase) {
    return createProfileActionError(
      'supabase_not_configured',
      profileUnavailableResult.error.message,
    );
  }

  const normalizedProfileId = cleanText(profileId);
  const normalizedDisplayName = cleanText(displayName);

  if (!normalizedProfileId || !normalizedDisplayName) {
    return createProfileActionError(
      'invalid_payload',
      'Choose a visible profile and enter a display name.',
    );
  }

  const { data, error } = await supabase.rpc(
    'update_managed_profile_display_name',
    {
      target_display_name: normalizedDisplayName,
      target_full_name: optionalText(fullName),
      target_profile_id: normalizedProfileId,
    },
  );

  if (error) {
    return createProfileActionError(
      getReasonFromError(error),
      error.message || 'Could not update the profile display name.',
      error.code,
    );
  }

  return {
    ok: true,
    data: Array.isArray(data) ? data[0] ?? null : data ?? null,
  };
}

export async function updateManagedProfileStatus({
  profileId,
  status,
} = {}) {
  if (!isSupabaseConfigured || !supabase) {
    return createProfileActionError(
      'supabase_not_configured',
      profileUnavailableResult.error.message,
    );
  }

  const normalizedProfileId = cleanText(profileId);
  const normalizedStatus = cleanText(status);

  if (!normalizedProfileId || !['active', 'deactivated'].includes(normalizedStatus)) {
    return createProfileActionError(
      'invalid_payload',
      'Choose a visible profile and profile lifecycle status.',
    );
  }

  const { data, error } = await supabase.rpc('update_managed_profile_status', {
    target_profile_id: normalizedProfileId,
    target_status: normalizedStatus,
  });

  if (error) {
    return createProfileActionError(
      getReasonFromError(error),
      error.message || 'Could not update the profile status.',
      error.code,
    );
  }

  return {
    ok: true,
    data: Array.isArray(data) ? data[0] ?? null : data ?? null,
  };
}

export async function updateOwnProfileDisplayName({
  displayName,
  fullName = '',
} = {}) {
  if (!isSupabaseConfigured || !supabase) {
    return createProfileActionError(
      'supabase_not_configured',
      profileUnavailableResult.error.message,
    );
  }

  const { data: user, error: userError } = await getAuthenticatedUser();

  if (userError) {
    return createProfileActionError(
      getReasonFromError(userError),
      userError.message,
      userError.code,
    );
  }

  const normalizedDisplayName = cleanText(displayName);

  if (!normalizedDisplayName) {
    return createProfileActionError(
      'invalid_payload',
      'Enter a display name or username.',
    );
  }

  const { data, error } = await supabase
    .from('profiles')
    .update({
      display_name: normalizedDisplayName,
      full_name: optionalText(fullName),
      updated_at: new Date().toISOString(),
    })
    .eq('id', user.id)
    .select('id,email,full_name,display_name,status')
    .maybeSingle();

  if (error) {
    return createProfileActionError(
      getReasonFromError(error),
      error.message || 'Could not update your profile display name.',
      error.code,
    );
  }

  if (!data) {
    return createProfileActionError(
      'profile_not_ready',
      'Your profile is still being prepared. Try again in a moment.',
    );
  }

  return {
    ok: true,
    data,
  };
}

function createIdentitySummary({
  profile = null,
  memberships = [],
  primaryRole = '',
  userEmail = '',
} = {}) {
  return {
    profile,
    memberships,
    primaryRole,
    isPlatformOwner: isPlatformOwnerRole(primaryRole),
    hasMemberships: memberships.length > 0,
    userEmail,
    membershipLabels: memberships.map(formatMembershipLabel).filter(Boolean),
  };
}

function createProfileActionError(reason, message, errorCode = '') {
  return {
    ok: false,
    reason,
    message,
    errorCode,
  };
}

function getReasonFromError(error) {
  if (error?.code === '42883') {
    return 'profile_management_missing';
  }

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
