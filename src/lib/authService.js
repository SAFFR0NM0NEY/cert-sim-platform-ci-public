import { isSupabaseConfigured, supabase } from './supabaseClient.js';
import { supabaseConfig } from './supabaseConfig.js';

const authUnavailableResult = {
  data: null,
  error: {
    message: 'Account features are not configured for this environment yet.',
  },
};

function getAuthUnavailableResult() {
  return {
    data: authUnavailableResult.data,
    error: { ...authUnavailableResult.error },
  };
}

function getFriendlyAuthError(error, fallbackMessage) {
  if (!error) {
    return null;
  }

  return {
    ...error,
    message: error.message || fallbackMessage,
  };
}

export async function getCurrentSession() {
  if (!isSupabaseConfigured || !supabase) {
    return getAuthUnavailableResult();
  }

  const { data, error } = await supabase.auth.getSession();

  return {
    data,
    error: getFriendlyAuthError(error, 'Could not read the current account session.'),
  };
}

export async function getCurrentUser() {
  if (!isSupabaseConfigured || !supabase) {
    return getAuthUnavailableResult();
  }

  const { data, error } = await supabase.auth.getUser();

  return {
    data,
    error: getFriendlyAuthError(error, 'Could not read the current account.'),
  };
}

export async function signInWithEmailPassword(email, password) {
  if (!isSupabaseConfigured || !supabase) {
    return getAuthUnavailableResult();
  }

  const { data, error } = await supabase.auth.signInWithPassword({
    email,
    password,
  });

  return {
    data,
    error: getFriendlyAuthError(error, 'Could not sign in with that email and password.'),
  };
}

export async function signUpWithEmailPassword(email, password, displayName = '') {
  if (!isSupabaseConfigured || !supabase) {
    return getAuthUnavailableResult();
  }

  const normalizedDisplayName = cleanText(displayName);
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: normalizedDisplayName
      ? {
          data: {
            display_name: normalizedDisplayName,
            full_name: normalizedDisplayName,
          },
        }
      : undefined,
  });

  return {
    data,
    error: getFriendlyAuthError(error, 'Could not create that account.'),
  };
}

export async function requestPasswordReset(email) {
  if (!isSupabaseConfigured || !supabase) {
    return getAuthUnavailableResult();
  }

  const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: buildPasswordResetRedirectUrl(),
  });

  return {
    data,
    error: error
      ? {
          ...error,
          message: 'We could not send the reset email. Please wait a moment and try again.',
        }
      : null,
  };
}

export async function updatePassword(password) {
  if (!isSupabaseConfigured || !supabase) {
    return getAuthUnavailableResult();
  }

  const { data, error } = await supabase.auth.updateUser({ password });

  return {
    data,
    error: error
      ? {
          ...error,
          message: 'We could not update the password. The reset link may have expired; request a new email and try again.',
        }
      : null,
  };
}

export function buildPasswordResetRedirectUrl(
  appUrl = supabaseConfig.certsimAppUrl,
  runtimeOrigin = getBrowserOrigin(),
) {
  const configuredOrigin = normalizeHttpOrigin(appUrl);
  const browserOrigin = normalizeHttpOrigin(runtimeOrigin);

  if (
    supabaseConfig.certsimEnv === 'production' &&
    (!configuredOrigin || isLocalOrigin(configuredOrigin))
  ) {
    console.warn(
      '[CertSim] VITE_CERTSIM_APP_URL is missing or local in a production build. Password reset will use the current browser origin.',
    );
  }

  const redirectOrigin =
    browserOrigin ||
    configuredOrigin ||
    (supabaseConfig.certsimEnv === 'production'
      ? 'https://certsimplatform.com'
      : 'http://localhost:5173');

  return `${redirectOrigin}/account?password_reset=1`;
}

export async function signOut() {
  if (!isSupabaseConfigured || !supabase) {
    return getAuthUnavailableResult();
  }

  const { error } = await supabase.auth.signOut();

  return {
    data: null,
    error: getFriendlyAuthError(error, 'Could not sign out.'),
  };
}

export function onAuthStateChange(callback) {
  if (!isSupabaseConfigured || !supabase) {
    return {
      data: null,
      error: authUnavailableResult.error,
      unsubscribe: () => {},
    };
  }

  const { data } = supabase.auth.onAuthStateChange((event, session) => {
    callback({ event, session, user: session?.user ?? null });
  });

  return {
    data,
    error: null,
    unsubscribe: () => data?.subscription?.unsubscribe?.(),
  };
}

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getBrowserOrigin() {
  return typeof window !== 'undefined' ? window.location.origin : '';
}

function normalizeHttpOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());

    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.origin
      : '';
  } catch {
    return '';
  }
}

function isLocalOrigin(origin) {
  try {
    const hostname = new URL(origin).hostname;

    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}
