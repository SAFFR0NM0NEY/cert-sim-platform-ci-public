import { getSupabaseStatus, isSupabaseConfigured } from './supabaseClient.js';

export function getBackendStatus() {
  const supabaseStatus = getSupabaseStatus();

  return {
    mode: isSupabaseConfigured ? 'supabase-ready' : 'frontend-only',
    canUseAuth: isSupabaseConfigured,
    canCreateAttempts: isSupabaseConfigured,
    canStoreResponses: isSupabaseConfigured,
    canStoreResults: isSupabaseConfigured,
    canCreateQuestionReports: isSupabaseConfigured,
    storageRequiresSignIn: true,
    storageStatus: isSupabaseConfigured ? 'storage-service-ready' : 'frontend-only',
    missingVariables: supabaseStatus.missingVariables,
  };
}
