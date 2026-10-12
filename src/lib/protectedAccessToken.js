export function createProtectedAccessTokenProvider({ getCurrentAccessToken, refreshSession }) {
  if (typeof getCurrentAccessToken !== 'function' || typeof refreshSession !== 'function') {
    throw new Error('protected_token_provider_invalid');
  }

  let refreshInFlight = null;

  return async function getAccessToken({ forceRefresh = false, rejectedAccessToken = '' } = {}) {
    const currentAccessToken = getCurrentAccessToken();
    if (!forceRefresh || (currentAccessToken && currentAccessToken !== rejectedAccessToken)) {
      return requireAccessToken(currentAccessToken);
    }

    refreshInFlight ??= Promise.resolve()
      .then(() => refreshSession())
      .finally(() => { refreshInFlight = null; });
    const { data, error } = await refreshInFlight;
    if (error) throw createUnauthenticatedError();
    return requireAccessToken(data?.session?.access_token);
  };
}

function requireAccessToken(value) {
  if (!value || typeof value !== 'string') throw createUnauthenticatedError();
  return value;
}

function createUnauthenticatedError() {
  return Object.assign(new Error('Your session has expired. Sign in again before continuing.'), {
    code: 'unauthenticated',
  });
}
