import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getTrainerScopePage,
  mergeAssignmentPages,
  mergeHistoryPages,
} from '../lib/trainerScopeService.js';

const emptyScope = {
  organisations: [], campuses: [], groups: [], assignments: [], learnerIds: [], history: null,
  locks: { organisation: false, campus: false }, selection: {}, role: '',
};

export default function useTrainerScope(selection = {}, { enabled = true } = {}) {
  const [state, setState] = useState(emptyScope);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [assignmentNextCursor, setAssignmentNextCursor] = useState(null);
  const [historyNextCursor, setHistoryNextCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const requestRef = useRef(0);
  const controllerRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!enabled) return { ok: false, reason: 'disabled' };
    const requestId = ++requestRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError('');
    const result = await getTrainerScopePage(selection, { signal: controller.signal });
      if (requestId !== requestRef.current || controller.signal.aborted) return { ok: false, reason: 'stale_request' };
      if (!result.ok) {
        setError(result.message);
        setLoading(false);
        return result;
      }
      const pageItems = result.data.assignmentPage?.items ?? [];
      if (new Set(pageItems.map((item) => item.id)).size !== pageItems.length) {
        setError('Assignment pagination returned duplicate records.');
        setLoading(false);
        return { ok: false, reason: 'invalid_pagination' };
      }
    if (requestId === requestRef.current) {
      setState({
        ...result.data,
        assignments: pageItems,
        learnerIds: result.data?.learnerIds ?? [],
      });
      setAssignmentNextCursor(result.data.assignmentPage?.nextCursor ?? null);
      setHistoryNextCursor(result.data.history?.nextCursor ?? null);
      setLoading(false);
    }
    return { ok: true };
  }, [enabled, selection.assignmentId, selection.campusId, selection.examKey, selection.groupId, selection.organisationId, selection.resultStatus, selection.search, selection.workflow]);

  useEffect(() => {
    if (enabled) refresh();
    return () => {
      requestRef.current += 1;
      controllerRef.current?.abort();
    };
  }, [enabled, refresh]);

  const loadMoreAssignments = useCallback(async () => {
    if (!assignmentNextCursor || loadingMore) return { ok: false, reason: 'no_more_assignments' };
    const requestId = requestRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoadingMore(true);
    const result = await getTrainerScopePage({ ...selection, cursor: assignmentNextCursor }, { signal: controller.signal });
    if (requestId !== requestRef.current || controller.signal.aborted) return { ok: false, reason: 'stale_request' };
    if (!result.ok) { setError(result.message); setLoadingMore(false); return result; }
    const incoming = result.data.assignmentPage?.items ?? [];
    const existingIds = new Set(state.assignments.map((item) => item.id));
    if (incoming.some((item) => existingIds.has(item.id)) || new Set(incoming.map((item) => item.id)).size !== incoming.length) {
      setError('Assignment pagination returned duplicate records.');
      setLoadingMore(false);
      return { ok: false, reason: 'invalid_pagination' };
    }
    if (result.data.assignmentPage?.nextCursor === assignmentNextCursor) {
      setError('Assignment pagination returned a repeated cursor.');
      setLoadingMore(false);
      return { ok: false, reason: 'invalid_pagination' };
    }
    setState((current) => ({ ...current, assignments: mergeAssignmentPages(current.assignments, incoming) }));
    setAssignmentNextCursor(result.data.assignmentPage?.nextCursor ?? null);
    setLoadingMore(false);
    return { ok: true };
  }, [assignmentNextCursor, loadingMore, selection, state.assignments]);

  const loadMoreHistory = useCallback(async () => {
    if (!historyNextCursor || loadingMore) return { ok: false, reason: 'no_more_history' };
    const requestId = requestRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoadingMore(true);
    const result = await getTrainerScopePage(
      { ...selection, cursor: historyNextCursor, workflow: 'results' },
      { signal: controller.signal },
    );
    if (requestId !== requestRef.current || controller.signal.aborted) return { ok: false, reason: 'stale_request' };
    if (!result.ok) { setError(result.message); setLoadingMore(false); return result; }
    const incoming = result.data.history?.items ?? [];
    const currentItems = state.history?.items ?? [];
    const existingIds = new Set(currentItems.map((item) => item.attemptId));
    if (incoming.some((item) => existingIds.has(item.attemptId)) || new Set(incoming.map((item) => item.attemptId)).size !== incoming.length) {
      setError('Result pagination returned duplicate records.');
      setLoadingMore(false);
      return { ok: false, reason: 'invalid_pagination' };
    }
    if (result.data.history?.nextCursor === historyNextCursor) {
      setError('Result pagination returned a repeated cursor.');
      setLoadingMore(false);
      return { ok: false, reason: 'invalid_pagination' };
    }
    setState((current) => ({
      ...current,
      history: {
        ...current.history,
        items: mergeHistoryPages(current.history?.items ?? [], incoming),
      },
    }));
    setHistoryNextCursor(result.data.history?.nextCursor ?? null);
    setLoadingMore(false);
    return { ok: true };
  }, [historyNextCursor, loadingMore, selection, state.history]);

  return {
    ...state,
    loading,
    loadingMore,
    error,
    hasMoreAssignments: Boolean(assignmentNextCursor),
    hasMoreHistory: Boolean(historyNextCursor),
    loadMoreAssignments,
    loadMoreHistory,
    refresh,
  };
}
