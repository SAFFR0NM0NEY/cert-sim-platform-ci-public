const env = import.meta.env ?? {};

const REQUIRED_SUPABASE_VARIABLES = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
];

function readEnvValue(name, fallback = '') {
  const value = env[name];

  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

export function getSupabaseConfig() {
  const supabaseUrl = readEnvValue('VITE_SUPABASE_URL');
  const supabaseAnonKey = readEnvValue('VITE_SUPABASE_ANON_KEY');
  const certsimEnv = readEnvValue('VITE_CERTSIM_ENV', 'development');
  const certsimAppUrl = readEnvValue('VITE_CERTSIM_APP_URL');
  const values = {
    VITE_SUPABASE_URL: supabaseUrl,
    VITE_SUPABASE_ANON_KEY: supabaseAnonKey,
  };
  const missingVariables = REQUIRED_SUPABASE_VARIABLES.filter((name) => !values[name]);

  return {
    supabaseUrl,
    supabaseAnonKey,
    certsimEnv,
    certsimAppUrl,
    isSupabaseConfigured: missingVariables.length === 0,
    missingVariables,
  };
}

export const supabaseConfig = getSupabaseConfig();
