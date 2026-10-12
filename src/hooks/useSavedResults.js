import { useCallback, useEffect, useState } from 'react';

import useAuthSession from './useAuthSession.js';
import {
  getMySavedResults,
  getSavedResultDetail,
} from '../lib/savedResultsService.js';
import { appendUniqueHistory, normalizeHistoryRange } from '../lib/historyPagination.js';

export default function useSavedResults() {
  const authSession = useAuthSession();
  const {
    loading: authLoading,
    isAuthenticated,
    isSupabaseConfigured,
    user,
  } = authSession;
  const [results, setResults] = useState([]);
  const [selectedResult, setSelectedResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [range, setRangeState] = useState('recent');

  const refreshResults = useCallback(async () => {
    if (!isSupabaseConfigured || !isAuthenticated) {
      setResults([]);
      setSelectedResult(null);
      setError('');
      setHasMore(false);
      setNextCursor(null);
      return {
        ok: false,
        reason: isSupabaseConfigured ? 'not_signed_in' : 'supabase_not_configured',
      };
    }

    setLoading(true);
    setError('');
    const result = await getMySavedResults();

    if (result.ok) {
      setResults(result.data ?? []);
      setHasMore(Boolean(result.pagination?.hasMore));
      setNextCursor(result.pagination?.nextCursor ?? null);
    } else {
      setResults([]);
      setHasMore(false);
      setNextCursor(null);
      setError(result.message);
    }

    setLoading(false);
    return result;
  }, [isAuthenticated, isSupabaseConfigured]);

  const loadMoreResults = useCallback(async () => {
    if (!nextCursor || loading) return { ok: false, reason: 'no_more_results' };
    setLoading(true);
    setError('');
    const result = await getMySavedResults({ cursor: nextCursor });
    if (result.ok) {
      setResults((current) => appendUniqueHistory(current, result.data ?? []));
      setHasMore(Boolean(result.pagination?.hasMore));
      setNextCursor(result.pagination?.nextCursor ?? null);
    } else {
      setError(result.message);
    }
    setLoading(false);
    return result;
  }, [loading, nextCursor]);

  const setRange = useCallback((value) => {
    const normalized = normalizeHistoryRange(value);
    setRangeState(normalized);
    if (normalized === 'all' && nextCursor && !loading) loadMoreResults();
  }, [loadMoreResults, loading, nextCursor]);

  const loadResultDetail = useCallback(
    async (attemptId) => {
      if (!isSupabaseConfigured || !isAuthenticated) {
        setSelectedResult(null);
        setError('');
        return {
          ok: false,
          reason: isSupabaseConfigured ? 'not_signed_in' : 'supabase_not_configured',
        };
      }

      setDetailLoading(true);
      setError('');
      const result = await getSavedResultDetail(attemptId);

      if (result.ok) {
        setSelectedResult(result.data);
      } else {
        setSelectedResult(null);
        setError(result.message);
      }

      setDetailLoading(false);
      return result;
    },
    [isAuthenticated, isSupabaseConfigured],
  );

  const clearSelectedResult = useCallback(() => {
    setSelectedResult(null);
  }, []);

  useEffect(() => {
    if (authLoading) {
      return;
    }

    if (!isSupabaseConfigured || !isAuthenticated) {
      setResults([]);
      setSelectedResult(null);
      setError('');
      setHasMore(false);
      setNextCursor(null);
      return;
    }

    refreshResults();
  }, [
    authLoading,
    isAuthenticated,
    isSupabaseConfigured,
    refreshResults,
    user?.id,
  ]);

  return {
    ...authSession,
    results,
    selectedResult,
    loading: authLoading || loading,
    resultsLoading: loading,
    detailLoading,
    error,
    hasMore,
    range,
    refreshResults,
    loadMoreResults,
    setRange,
    loadResultDetail,
    clearSelectedResult,
  };
}
