export function shouldWaitForSignedInStudentIdentity(identity = {}) {
  return Boolean(identity.isSupabaseConfigured && identity.loading);
}

export function canUseSignedInStudentIdentity(identity = {}) {
  return Boolean(
    identity.isSupabaseConfigured &&
      identity.isAuthenticated,
  );
}

export function createStudentDetailsFromIdentity(identity = {}) {
  const email = getIdentityEmail(identity);
  const profileName = normalizeText(
    identity.profile?.display_name ?? identity.profile?.full_name,
  );
  const name = profileName || 'Signed-in CertSim user';

  return {
    name,
    email,
    campusCompany: '',
    source: 'supabase-account',
  };
}

export function getIdentityEmail(identity = {}) {
  return normalizeText(
    identity.profile?.email ??
      identity.userEmail ??
      identity.user?.email ??
      identity.session?.user?.email,
  );
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}
