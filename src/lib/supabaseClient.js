import { createClient } from '@supabase/supabase-js';

import { supabaseConfig } from './supabaseConfig.js';

export const isSupabaseConfigured = supabaseConfig.isSupabaseConfigured;

export const supabase = isSupabaseConfigured
  ? createClient(supabaseConfig.supabaseUrl, supabaseConfig.supabaseAnonKey, {
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        persistSession: true,
      },
    })
  : null;

export function getSupabaseStatus() {
  return {
    isSupabaseConfigured,
    certsimEnv: supabaseConfig.certsimEnv,
    certsimAppUrl: supabaseConfig.certsimAppUrl,
    missingVariables: [...supabaseConfig.missingVariables],
  };
}
