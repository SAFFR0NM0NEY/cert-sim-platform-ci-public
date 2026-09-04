import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SafeError } from "./errors.ts";
const KEY_NAME = "certsim_protected_runtime";
export function resolvePrivilegedKey(
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): string {
  const dictionary = env("SUPABASE_SECRET_KEYS");
  if (dictionary) {
    try {
      const parsed = JSON.parse(dictionary);
      if (
        parsed && typeof parsed === "object" &&
        typeof parsed[KEY_NAME] === "string" && parsed[KEY_NAME]
      ) return parsed[KEY_NAME];
    } catch { /* fail closed */ }
  }
  // Explicitly limited to disposable local/CI execution; never configured in hosted production.
  const local = env("CERTSIM_PROTECTED_RUNTIME_SECRET_KEY");
  const mode = env("CERTSIM_RUNTIME_MODE");
  if (local && mode === "disposable-local") return local;
  throw new SafeError("internal_failure");
}
export function createPrivilegedClient(
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): SupabaseClient {
  const url = env("SUPABASE_URL");
  if (!url) throw new SafeError("internal_failure");
  return createClient(url, resolvePrivilegedKey(env), {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
