import { createProtectedExamClient } from './protectedExamClient.js';
import { isSupabaseConfigured, supabase } from './supabaseClient.js';

export const TRAINER_SCOPE_PAGE_SIZE = 50;
const scopeOptionsCache = new Map();

if (supabase?.auth?.onAuthStateChange) {
  supabase.auth.onAuthStateChange((event) => {
    if (['SIGNED_IN', 'SIGNED_OUT', 'USER_UPDATED', 'PASSWORD_RECOVERY'].includes(event)) scopeOptionsCache.clear();
  });
}

export async function getTrainerScopeOptions(scope = {}, { signal } = {}) {
  if (!isSupabaseConfigured || !supabase) return { ok: false, reason: 'supabase_not_configured', message: 'Performance scope is not configured.' };
  const { data, error } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const userId = data?.session?.user?.id;
  if (error || !token || !userId) return { ok: false, reason: 'not_signed_in', message: 'Sign in again to load performance scope.' };
  const cacheKey = `${userId}:${scope.organisationId || 'root'}`;
  if (scopeOptionsCache.has(cacheKey)) return { ok: true, data: scopeOptionsCache.get(cacheKey), cached: true };
  try {
    const payload = await createProtectedExamClient({ accessToken: token }).getStaffScopeOptions(scope, { signal });
    scopeOptionsCache.set(cacheKey, payload);
    return { ok: true, data: payload, cached: false };
  } catch (requestError) {
    return { ok: false, reason: requestError?.code || 'request_failed', message: requestError?.message || 'Could not load filter options.' };
  }
}

export async function getTrainerScopePage(scope = {}, { signal } = {}) {
  if (!isSupabaseConfigured || !supabase) {
    return { ok: false, reason: 'supabase_not_configured', message: 'Performance scope is not configured.' };
  }
  const { data, error } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  if (error || !token) return { ok: false, reason: 'not_signed_in', message: 'Sign in again to load performance scope.' };
  try {
    const protectedScope = buildTrainerScopeRequest(scope);
    const payload = await createProtectedExamClient({ accessToken: token }).getStaffDashboardQuery(
      { ...protectedScope, pageSize: TRAINER_SCOPE_PAGE_SIZE },
      { signal },
    );
    return { ok: true, data: payload };
  } catch (requestError) {
    return { ok: false, reason: requestError?.code || 'request_failed', message: requestError?.message || 'Could not load performance scope.' };
  }
}

export function mergeAssignmentPages(current = [], incoming = []) {
  const byId = new Map(current.map((item) => [item.id, item]));
  incoming.forEach((item) => byId.set(item.id, item));
  return [...byId.values()];
}

export function buildTrainerScopeRequest(scope = {}) {
  return Object.fromEntries([
    'organisationId', 'campusId', 'groupId', 'assignmentId', 'examKey',
    'resultStatus', 'search', 'workflow', 'cursor',
  ].map((key) => [key, scope[key]]).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

export function mergeHistoryPages(current = [], incoming = []) {
  const seen = new Set(current.map((item) => item.attemptId));
  if (incoming.some((item) => !item.attemptId || seen.has(item.attemptId)) ||
    new Set(incoming.map((item) => item.attemptId)).size !== incoming.length) {
    throw new Error('Result pagination returned duplicate or malformed records.');
  }
  return [...current, ...incoming];
}
