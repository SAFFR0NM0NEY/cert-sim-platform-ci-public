import { useCallback, useEffect, useState } from 'react';

import { getMyReports } from '../lib/reportWorkflowService.js';
import useAuthSession from './useAuthSession.js';

export default function useMyReports() {
  const authSession = useAuthSession();
  const [reports, setReports] = useState([]);
  const [loadingReports, setLoadingReports] = useState(false);
  const [error, setError] = useState('');

  const refreshReports = useCallback(async () => {
    if (authSession.loading) {
      return { ok: false, reason: 'auth_loading' };
    }

    if (!authSession.isSupabaseConfigured || !authSession.isAuthenticated) {
      setReports([]);
      setError('');
      return { ok: false, reason: 'not_ready' };
    }

    setLoadingReports(true);
    setError('');
    const result = await getMyReports();

    if (result.ok) {
      setReports(result.data ?? []);
    } else {
      setReports([]);
      setError(result.message);
    }

    setLoadingReports(false);
    return result;
  }, [
    authSession.isAuthenticated,
    authSession.isSupabaseConfigured,
    authSession.loading,
  ]);

  useEffect(() => {
    refreshReports();
  }, [refreshReports]);

  return {
    ...authSession,
    error,
    loading: authSession.loading || loadingReports,
    loadingReports,
    refreshReports,
    reports,
  };
}
