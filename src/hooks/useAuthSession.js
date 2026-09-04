import { useEffect, useState } from 'react';

import { getSupabaseStatus } from '../lib/supabaseClient.js';
import { getCurrentSession, onAuthStateChange } from '../lib/authService.js';

const supabaseStatus = getSupabaseStatus();

export default function useAuthSession() {
  const [session, setSession] = useState(null);
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(supabaseStatus.isSupabaseConfigured);
  const authUnavailableReason = supabaseStatus.isSupabaseConfigured
    ? ''
    : `Missing ${supabaseStatus.missingVariables.join(', ')}`;

  useEffect(() => {
    let isMounted = true;

    if (!supabaseStatus.isSupabaseConfigured) {
      setLoading(false);
      return undefined;
    }

    async function loadSession() {
      const { data } = await getCurrentSession();

      if (!isMounted) {
        return;
      }

      setSession(data?.session ?? null);
      setUser(data?.session?.user ?? null);
      setLoading(false);
    }

    const subscription = onAuthStateChange(({ session: nextSession }) => {
      if (!isMounted) {
        return;
      }

      setSession(nextSession ?? null);
      setUser(nextSession?.user ?? null);
      setLoading(false);
    });

    loadSession();

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, []);

  return {
    user,
    session,
    loading,
    isAuthenticated: Boolean(user),
    isSupabaseConfigured: supabaseStatus.isSupabaseConfigured,
    authUnavailableReason,
  };
}
