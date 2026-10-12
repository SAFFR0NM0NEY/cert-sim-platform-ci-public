import { isSupabaseConfigured, supabase } from './supabaseClient.js';

export async function verifyMaintenancePlatformOwnerAccess(client = supabase) {
  if (!client || (client === supabase && !isSupabaseConfigured)) {
    return denied('authentication_unavailable');
  }

  try {
    const { data: userData, error: userError } = await client.auth.getUser();
    if (userError || !userData?.user) {
      return denied('identity_unverified');
    }

    const { data: isPlatformOwner, error: roleError } = await client.rpc(
      'is_platform_owner',
    );
    if (roleError || isPlatformOwner !== true) {
      return denied(roleError ? 'authority_unverified' : 'access_denied');
    }

    return { ok: true, reason: '', user: userData.user };
  } catch {
    return denied('authority_unverified');
  }
}

export async function signOutMaintenanceSession(client = supabase) {
  if (!client || (client === supabase && !isSupabaseConfigured)) {
    return { ok: false, reason: 'authentication_unavailable' };
  }
  try {
    const { error } = await client.auth.signOut({ scope: 'local' });
    return error
      ? { ok: false, reason: 'sign_out_failed' }
      : { ok: true, reason: '' };
  } catch {
    return { ok: false, reason: 'sign_out_failed' };
  }
}

function denied(reason) {
  return { ok: false, reason, user: null };
}
