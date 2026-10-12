import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getStudentProgressAssignmentSnapshot,
  getStudentSavedProgressSnapshot,
} from '../lib/studentProgressService.js';
import useCurrentIdentity from './useCurrentIdentity.js';

const emptyStudentProgress = {
  assignmentProgress: {},
  assessmentHistory: [],
  assignmentLoadWarning: '',
  assignments: [],
  assignmentsNeedingAttention: [],
  domainHistoryNote: '',
  examProgress: [],
  historyNote: '',
  progress: {
    assignedExamCount: 0,
    assignedNotStartedCount: 0,
    examsAttemptedCount: 0,
    latestActivity: '',
    overdueAssignmentCount: 0,
    readinessDisclaimer: '',
    requiredAttempts: 5,
    totalSavedAttempts: 0,
    averageScore: null,
    bestScore: null,
    domainSampleCount: 0,
    latestScore: null,
    passRate: null,
  },
  recentAttempts: [],
  results: [],
  student: null,
};

export default function useStudentProgress() {
  const authSession = useCurrentIdentity();
  const [snapshot, setSnapshot] = useState(emptyStudentProgress);
  const [loading, setLoading] = useState(false);
  const [assignmentLoading, setAssignmentLoading] = useState(false);
  const [error, setError] = useState('');
  const requestIdRef = useRef(0);

  const refreshProgress = useCallback(async () => {
    if (authSession.loading) {
      return { ok: false, reason: 'auth_loading' };
    }

    if (!authSession.isSupabaseConfigured || !authSession.isAuthenticated) {
      setSnapshot(emptyStudentProgress);
      setError('');
      return { ok: false, reason: 'not_ready' };
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setAssignmentLoading(false);
    setError('');

    let savedResult;

    try {
      savedResult = await getStudentSavedProgressSnapshot({
        authUser: authSession.user,
        session: authSession.session,
      });
    } catch (caughtError) {
      savedResult = {
        ok: false,
        reason: 'request_failed',
        message: 'Could not load saved attempts.',
        errorCode: caughtError?.code,
      };
    }

    if (requestId !== requestIdRef.current) {
      return savedResult;
    }

    if (!savedResult.ok) {
      setSnapshot(emptyStudentProgress);
      setError(savedResult.message || 'Could not load saved attempts.');
      setLoading(false);
      return savedResult;
    }

    setLoading(false);
    setSnapshot(savedResult.data ?? emptyStudentProgress);
    setAssignmentLoading(true);
    let assignmentResult;

    try {
      assignmentResult = await getStudentProgressAssignmentSnapshot({
        baseSnapshot: savedResult.data,
        identity: authSession,
        userId: authSession.user?.id ?? '',
      });
    } catch (caughtError) {
      assignmentResult = {
        ok: false,
        reason: 'request_failed',
        message: 'Assignments could not be loaded, but saved progress is still shown.',
        errorCode: caughtError?.code,
      };
    }

    if (requestId !== requestIdRef.current) {
      return assignmentResult;
    }

    setAssignmentLoading(false);

    if (assignmentResult.ok) {
      setSnapshot(assignmentResult.data ?? savedResult.data ?? emptyStudentProgress);
    } else {
      setSnapshot((current) => ({
        ...current,
        assignmentLoadWarning:
          assignmentResult.message ||
          'Assignments could not be loaded, but saved progress is still shown.',
      }));
    }

    return assignmentResult.ok ? assignmentResult : savedResult;
  }, [
    authSession.isAuthenticated,
    authSession.isSupabaseConfigured,
    authSession.loading,
    authSession.session,
    authSession.user,
  ]);

  useEffect(() => {
    refreshProgress();
  }, [refreshProgress]);

  return {
    ...authSession,
    ...snapshot,
    error,
    loading: authSession.loading || loading || assignmentLoading,
    savedProgressLoading: loading,
    assignmentLoading,
    progressLoading: loading,
    refreshProgress,
  };
}
