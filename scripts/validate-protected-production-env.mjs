const EXPECTED_SUPABASE_ORIGIN = 'https://qngnoctsdhzcpagesvxz.supabase.co';
const EXPECTED_APP_URL = 'https://certsimplatform.com';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const fail = (message) => { throw new Error(message); };
const legacyAnon = (key) => {
  const parts = key.split('.');
  if (parts.length !== 3) return false;
  try { return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))?.role === 'anon'; }
  catch { return false; }
};

export function validateProtectedProductionEnv(env = process.env) {
  const url = env.VITE_SUPABASE_URL?.trim();
  const key = env.VITE_SUPABASE_ANON_KEY?.trim();
  if (!url) fail('VITE_SUPABASE_URL is missing.');
  if (!key) fail('VITE_SUPABASE_ANON_KEY is missing.');
  if (env.VITE_CERTSIM_ENV !== 'production') fail('VITE_CERTSIM_ENV must be exactly production.');
  if (env.VITE_CERTSIM_APP_URL !== EXPECTED_APP_URL) fail(`VITE_CERTSIM_APP_URL must be exactly ${EXPECTED_APP_URL}.`);
  let parsed;
  try { parsed = new URL(url); } catch { fail('VITE_SUPABASE_URL is invalid.'); }
  if (parsed.origin !== EXPECTED_SUPABASE_ORIGIN || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    fail('VITE_SUPABASE_URL must identify the authoritative CertSim Supabase project.');
  }
  const publishable = /^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(key);
  if (!publishable && !legacyAnon(key)) fail('Protected production Supabase key is not a publishable/anon browser key.');
  return { ok: true, projectRef: 'qngnoctsdhzcpagesvxz', keyType: publishable ? 'publishable' : 'legacy_anon' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(validateProtectedProductionEnv())); }
  catch (error) { console.error(error.message); process.exit(1); }
}
