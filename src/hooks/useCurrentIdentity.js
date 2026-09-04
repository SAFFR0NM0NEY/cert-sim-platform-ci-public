import { useCallback, useEffect, useState } from 'react';

import useAuthSession from './useAuthSession.js';
import { getCurrentIdentitySummary } from '../lib/profileService.js';
import { runBoundedAssignmentRequest } from '../lib/assignmentLoading.js';

const emptyIdentity = {
  profile: null,
  memberships: [],
  primaryRole: '',
  isPlatformOwner: false,
  hasMemberships: false,
  membershipLabels: [],
  userEmail: '',
};

export default function useCurrentIdentity() {
  const authSession = useAuthSession();
  const {
    user,
    loading: authLoading,
    isAuthenticated,
    isSupabaseConfigured,
  } = authSession;
  const [identity, setIdentity] = useState(emptyIdentity);
  const [loading, setLoading] = useState(isSupabaseConfigured && authLoading);
  const [error, setError] = useState('');

  const refreshIdentity = useCallback(async () => {
    if (!isSupabaseConfigured || !isAuthenticated) {
      setIdentity(emptyIdentity);
      setError('');
      setLoading(false);
      return;
    }

    setLoading(true);
    const result = await loadIdentitySummary();

    setIdentity(result.ok ? result.data : emptyIdentity);
    setError(result.ok ? '' : result.message);
    setLoading(false);
  }, [isAuthenticated, isSupabaseConfigured]);

  useEffect(() => {
    let isMounted = true;

    async function loadIdentity() {
      if (authLoading) {
        setLoading(true);
        return;
      }

      if (!isSupabaseConfigured || !isAuthenticated) {
        if (!isMounted) {
          return;
        }

        setIdentity(emptyIdentity);
        setError('');
        setLoading(false);
        return;
      }

      setLoading(true);
      const result = await loadIdentitySummary();

      if (!isMounted) {
        return;
      }

      setIdentity(result.ok ? result.data : emptyIdentity);
      setError(result.ok ? '' : result.message);
      setLoading(false);
    }

    loadIdentity();

    return () => {
      isMounted = false;
    };
  }, [authLoading, isAuthenticated, isSupabaseConfigured, user?.id]);

  return {
    ...authSession,
    profile: identity.profile,
    memberships: identity.memberships,
    primaryRole: identity.primaryRole,
    userEmail: identity.userEmail,
    isPlatformOwner: identity.isPlatformOwner,
    hasMemberships: identity.hasMemberships,
    membershipLabels: identity.membershipLabels,
    identityLoading: loading,
    loading: authLoading || loading,
    error,
    refreshIdentity,
  };
}

function loadIdentitySummary() {
  return runBoundedAssignmentRequest(async () => {
    const { data, error } = await getCurrentIdentitySummary();

    return error
      ? {
          ok: false,
          reason: 'identity_failed',
          message: error.message || 'Could not load profile memberships.',
        }
      : { ok: true, data: data ?? emptyIdentity };
  });
}
