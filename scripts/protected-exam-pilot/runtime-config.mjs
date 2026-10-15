export function confirmProjectUrl(projectRef, supabaseUrl) {
  let parsed;
  try {
    parsed = new globalThis.URL(supabaseUrl);
  } catch {
    throw new Error('PROJECT_CONFIRMATION_FAILED');
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== `${projectRef}.supabase.co`) {
    throw new Error('PROJECT_CONFIRMATION_FAILED');
  }
  return supabaseUrl;
}

export function validatePublishableKey(value) {
  if (!value) throw new Error('EMPTY_PUBLISHABLE_KEY');
  if (/service[_-]?role|sb_secret_/i.test(value)) throw new Error('SECRET_KEY_FORBIDDEN');
  if (/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(value)) return value;
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    try {
      const payload = JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString('utf8'));
      if (payload?.role === 'anon') return value;
    } catch {
      // Fall through to the sanitized format failure.
    }
  }
  throw new Error('PUBLISHABLE_KEY_REJECTED');
}

export function classifyAuthFailure(error) {
  if (error?.status === 401) return 'publishable-key-rejection';
  if (error?.code === 'invalid_credentials' || error?.status === 400) return 'learner-credential-rejection';
  return 'authentication-service-failure';
}
