import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getMyAssignmentProgress,
  getTrainerAssignmentProgress,
} from '../lib/assignmentProgressService.js';
import { hasScopedPerformanceDashboardAccess } from '../lib/roleUtils.js';
import useCurrentIdentity from './useCurrentIdentity.js';
import {
  isCurrentAssignmentRequest,
  runBoundedAssignmentRequest,
} from '../lib/assignmentLoading.js';

const emptyProgressState = {
  assignmentProgress: {
    archived: 0,
    closed: 0,
    completed: 0,
    'due-soon': 0,
    'in-progress': 0,
    'not-started': 0,
    overdue: 0,
    total: 0,
  },
  studentAssignments: [],
  trainerAssignments: [],
};

export default function useAssignmentProgress({
  enabled = true,
  includeStudentProgress = true,
  includeTrainerProgress = false,
} = {}) {
  const identity = useCurrentIdentity();
  const [state, setState] = useState(emptyProgressState);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;
  const canViewTrainerProgress = hasScopedPerformanceDashboardAccess(identity);

  const refreshProgress = useCallback(async () => {
    if (!enabled) return { ok: false, reason: 'disabled' };
    if (identity.loading) {
      return { ok: false, reason: 'identity_loading' };
    }

    if (identity.error) {
      setLoading(false);
      setRefreshing(false);
      setError(identity.error);
      return { ok: false, reason: 'identity_failed', message: identity.error };
    }

    if (!identity.isSupabaseConfigured || !identity.isAuthenticated) {
      setState(emptyProgressState);
      setError('');
      return { ok: false, reason: 'not_ready' };
    }

    const requestId = ++requestIdRef.current;
    const currentState = stateRef.current;
    const hasUsableAssignments = currentState.studentAssignments.length > 0 ||
      currentState.trainerAssignments.length > 0;
    setLoading(!hasUsableAssignments);
    setRefreshing(hasUsableAssignments);
    setError('');
    const result = await runBoundedAssignmentRequest(() => loadProgressState({
      canViewTrainerProgress,
      identity,
      includeStudentProgress,
      includeTrainerProgress,
    }));

    if (!isCurrentAssignmentRequest(requestId, requestIdRef.current, mountedRef.current)) {
      return { ok: false, reason: 'stale_request' };
    }

    if (result.ok) {
      setState(result.data);
      setError('');
    } else {
      setError(result.message || 'Could not load assigned exams.');
    }

    setLoading(false);
    setRefreshing(false);
    return result;
  }, [
    canViewTrainerProgress,
    enabled,
    identity.isAuthenticated,
    identity.isSupabaseConfigured,
    identity.loading,
    identity.error,
    identity.memberships,
    identity.profile?.id,
    identity.user?.id,
    includeStudentProgress,
    includeTrainerProgress,
  ]);

  useEffect(() => {
    if (enabled) refreshProgress();
  }, [enabled, refreshProgress, identity.primaryRole]);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  return {
    ...identity,
    assignmentProgress: state.assignmentProgress,
    studentAssignments: state.studentAssignments,
    trainerAssignments: state.trainerAssignments,
    loading: identity.loading || loading,
    progressLoading: identity.loading || loading,
    progressRefreshing: refreshing,
    error,
    refreshProgress,
  };
}

async function loadProgressState({
  canViewTrainerProgress,
  identity,
  includeStudentProgress,
  includeTrainerProgress,
}) {
  const tasks = [
    includeStudentProgress
      ? getMyAssignmentProgress({
          identity,
          userId: identity.user?.id ?? identity.profile?.id ?? '',
        })
      : Promise.resolve({ ok: true, data: { assignments: [], summary: {} } }),
    includeTrainerProgress && canViewTrainerProgress
      ? getTrainerAssignmentProgress()
      : Promise.resolve({ ok: true, data: { assignments: [], summary: {} } }),
  ];
  const [studentResult, trainerResult] = await Promise.all(tasks);
  const failedResult = [studentResult, trainerResult].find(
    (result) => !result.ok,
  );

  if (failedResult) {
    return failedResult;
  }

  return {
    ok: true,
    data: {
      assignmentProgress: mergeProgressSummaries(
        studentResult.data.summary,
        trainerResult.data.summary,
      ),
      studentAssignments: studentResult.data.assignments,
      trainerAssignments: trainerResult.data.assignments,
    },
  };
}

function mergeProgressSummaries(...summaries) {
  return summaries.reduce(
    (merged, summary = {}) => {
      Object.keys(merged).forEach((key) => {
        merged[key] += Number(summary[key] ?? 0);
      });

      return merged;
    },
    { ...emptyProgressState.assignmentProgress },
  );
}
