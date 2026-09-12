import { useCallback, useEffect, useState } from 'react';

import useCurrentIdentity from './useCurrentIdentity.js';
import {
  getDeveloperDashboardSnapshot,
  updateAccountDeletionRequestStatus,
  updateDeveloperReportStatus,
} from '../lib/developerDashboardService.js';

const emptySnapshot = {
  deletionRequests: [],
  deletionTotals: {
    total: 0,
    open: 0,
    inReview: 0,
    completed: 0,
    cancelled: 0,
  },
  identity: null,
  reports: [],
  totals: {
    total: 0,
    open: 0,
    inReview: 0,
    needInfo: 0,
    resolved: 0,
    dismissed: 0,
    recent: 0,
    questionReports: 0,
    platformIssues: 0,
    byType: {},
  },
};

export default function useDeveloperDashboard() {
  const identity = useCurrentIdentity();
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (identity.loading) {
      return { ok: false, reason: 'identity_loading' };
    }

    if (!identity.isSupabaseConfigured || !identity.isAuthenticated) {
      setSnapshot(emptySnapshot);
      setError('');
      return { ok: false, reason: 'not_ready' };
    }

    setLoading(true);
    const result = await getDeveloperDashboardSnapshot();

    if (result.ok) {
      setSnapshot(result.data ?? emptySnapshot);
      setError('');
    } else {
      setSnapshot(emptySnapshot);
      setError(result.message);
    }

    setLoading(false);
    return result;
  }, [
    identity.isAuthenticated,
    identity.isSupabaseConfigured,
    identity.loading,
  ]);

  useEffect(() => {
    refresh();
  }, [refresh, identity.isPlatformOwner, identity.primaryRole]);

  const updateReportStatus = useCallback(
    async (payload) => {
      const result = await updateDeveloperReportStatus(payload);

      if (result.ok) {
        await refresh();
      } else {
        setError(result.message);
      }

      return result;
    },
    [refresh],
  );
  const updateDeletionRequestStatus = useCallback(
    async (payload) => {
      const result = await updateAccountDeletionRequestStatus(payload);

      if (result.ok) {
        await refresh();
      } else {
        setError(result.message);
      }

      return result;
    },
    [refresh],
  );

  return {
    ...identity,
    snapshot,
    deletionRequests: snapshot.deletionRequests,
    deletionTotals: snapshot.deletionTotals,
    reports: snapshot.reports,
    totals: snapshot.totals,
    loading: identity.loading || loading,
    dashboardLoading: loading,
    error,
    refresh,
    updateDeletionRequestStatus,
    updateReportStatus,
  };
}
