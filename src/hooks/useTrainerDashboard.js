import { useCallback, useEffect, useState } from 'react';

import useCurrentIdentity from './useCurrentIdentity.js';
import {
  getTrainerDashboardSnapshot,
  getTrainerStudentResultDetail,
} from '../lib/trainerDashboardService.js';
import { updateManagedProfileDisplayName } from '../lib/profileService.js';
import { appendUniqueHistory, normalizeHistoryRange } from '../lib/historyPagination.js';

const emptySnapshot = {
  authoritativeAnalytics: null,
  identity: null,
  groups: [],
  students: [],
  results: [],
  resultsPagination: { hasMore: false, nextCursor: null, pageSize: 25 },
  sectionErrors: { groups: '', students: '', history: '', analytics: '' },
  totals: {
    groups: 0,
    students: 0,
    results: 0,
  },
};

export default function useTrainerDashboard({ enabled = true } = {}) {
  const identity = useCurrentIdentity();
  const [snapshot, setSnapshot] = useState(emptySnapshot);
  const [selectedResult, setSelectedResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [resultsRange, setResultsRangeState] = useState('recent');

  const refresh = useCallback(async () => {
    if (!enabled) return { ok: false, reason: 'disabled' };
    if (identity.loading) {
      return { ok: false, reason: 'identity_loading' };
    }

    if (!identity.isSupabaseConfigured || !identity.isAuthenticated) {
      setSnapshot(emptySnapshot);
      setSelectedResult(null);
      setError('');
      return { ok: false, reason: 'not_ready' };
    }

    setLoading(true);
    const result = await getTrainerDashboardSnapshot();

    if (result.ok) {
      setSnapshot(result.data ?? emptySnapshot);
      setError('');
    } else {
      setSnapshot(emptySnapshot);
      setSelectedResult(null);
      setError(result.message);
    }

    setLoading(false);
    return result;
  }, [
    identity.isAuthenticated,
    identity.isSupabaseConfigured,
    identity.loading,
    enabled,
  ]);

  const loadMoreResults = useCallback(async () => {
    const cursor = snapshot.resultsPagination?.nextCursor;
    if (!cursor || loading) return { ok: false, reason: 'no_more_results' };
    setLoading(true);
    const result = await getTrainerDashboardSnapshot({ cursor });
    if (result.ok) {
      setSnapshot((current) => ({
        ...result.data,
        results: appendUniqueHistory(current.results, result.data?.results ?? []),
        totals: {
          ...result.data.totals,
          results: appendUniqueHistory(current.results, result.data?.results ?? []).length,
        },
      }));
      setError('');
    } else {
      setError(result.message);
    }
    setLoading(false);
    return result;
  }, [loading, snapshot.resultsPagination?.nextCursor]);

  const setResultsRange = useCallback((value) => {
    const normalized = normalizeHistoryRange(value);
    setResultsRangeState(normalized);
    if (normalized === 'all' && snapshot.resultsPagination?.nextCursor && !loading) {
      loadMoreResults();
    }
  }, [loadMoreResults, loading, snapshot.resultsPagination?.nextCursor]);

  useEffect(() => {
    if (enabled) refresh();
  }, [enabled, refresh, identity.isPlatformOwner, identity.primaryRole]);

  const loadResultDetail = useCallback(async (attemptId) => {
    setDetailLoading(true);
    const result = await getTrainerStudentResultDetail(attemptId);

    if (result.ok) {
      setSelectedResult(result.data);
      setError('');
    } else {
      setSelectedResult(null);
      setError(result.message);
    }

    setDetailLoading(false);
    return result;
  }, []);

  const clearSelectedResult = useCallback(() => {
    setSelectedResult(null);
  }, []);

  const updateStudentDisplayName = useCallback(
    async (payload) => {
      const result = await updateManagedProfileDisplayName(payload);

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
    groups: snapshot.groups,
    students: snapshot.students,
    results: snapshot.results,
    authoritativeAnalytics: snapshot.authoritativeAnalytics,
    sectionErrors: snapshot.sectionErrors,
    resultsHasMore: Boolean(snapshot.resultsPagination?.hasMore),
    resultsRange,
    selectedResult,
    loading: identity.loading || loading,
    dashboardLoading: loading,
    detailLoading,
    error,
    refresh,
    loadMoreResults,
    setResultsRange,
    loadResultDetail,
    clearSelectedResult,
    updateStudentDisplayName,
  };
}
