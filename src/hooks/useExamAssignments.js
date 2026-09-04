import { useCallback, useEffect, useState } from 'react';

import useCurrentIdentity from './useCurrentIdentity.js';
import { hasScopedPerformanceDashboardAccess } from '../lib/roleUtils.js';
import {
  createGroupAssignment as createGroupAssignmentRecord,
  createStudentAssignment as createStudentAssignmentRecord,
  getAssignmentDetail as getAssignmentDetailRecord,
  getAssignmentStudentProgress as getAssignmentStudentProgressRecord,
  listAssignableExams,
  listAssignmentsForTrainerScope,
  listMyAssignments,
  updateAssignmentDetails as updateAssignmentDetailsRecord,
  updateAssignmentStatus as updateAssignmentStatusRecord,
} from '../lib/examAssignmentService.js';

const emptyAssignmentState = {
  assignableExams: [],
  trainerAssignments: [],
  myAssignments: [],
};

export default function useExamAssignments({
  enabled = true,
  includeMyAssignments = true,
  includeTrainerScope = false,
} = {}) {
  const identity = useCurrentIdentity();
  const [state, setState] = useState(emptyAssignmentState);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const canManageAssignments = hasScopedPerformanceDashboardAccess(identity);

  const refreshAssignments = useCallback(async () => {
    if (!enabled) return { ok: false, reason: 'disabled' };
    if (identity.loading) {
      return { ok: false, reason: 'identity_loading' };
    }

    if (!identity.isSupabaseConfigured || !identity.isAuthenticated) {
      setState(emptyAssignmentState);
      setError('');
      return { ok: false, reason: 'not_ready' };
    }

    setLoading(true);
    const result = await loadAssignmentState({
      canManageAssignments,
      includeMyAssignments,
      includeTrainerScope,
    });

    if (result.ok) {
      setState(result.data);
      setError('');
    } else {
      setState(emptyAssignmentState);
      setError(result.message);
    }

    setLoading(false);
    return result;
  }, [
    canManageAssignments,
    enabled,
    identity.isAuthenticated,
    identity.isSupabaseConfigured,
    identity.loading,
    includeMyAssignments,
    includeTrainerScope,
  ]);

  useEffect(() => {
    if (enabled) refreshAssignments();
  }, [enabled, refreshAssignments, identity.primaryRole]);

  const runMutation = useCallback(
    async (action) => {
      const result = await action();

      if (result.ok) {
        await refreshAssignments();
      } else {
        setError(result.message);
      }

      return result;
    },
    [refreshAssignments],
  );

  const createGroupAssignment = useCallback(
    (payload) => runMutation(() => createGroupAssignmentRecord(payload)),
    [runMutation],
  );
  const createStudentAssignment = useCallback(
    (payload) => runMutation(() => createStudentAssignmentRecord(payload)),
    [runMutation],
  );
  const updateAssignmentStatus = useCallback(
    (assignmentId, status) =>
      runMutation(() => updateAssignmentStatusRecord(assignmentId, status)),
    [runMutation],
  );
  const updateAssignmentDetails = useCallback(
    (assignmentId, payload) =>
      runMutation(() => updateAssignmentDetailsRecord(assignmentId, payload)),
    [runMutation],
  );
  const getAssignmentDetail = useCallback(
    (assignmentId) => getAssignmentDetailRecord(assignmentId),
    [],
  );
  const getAssignmentStudentProgress = useCallback(
    (assignmentId) => getAssignmentStudentProgressRecord(assignmentId),
    [],
  );

  return {
    ...identity,
    assignableExams: state.assignableExams,
    trainerAssignments: state.trainerAssignments,
    myAssignments: state.myAssignments,
    loading: identity.loading || loading,
    assignmentLoading: loading,
    assignmentError: error,
    refreshAssignments,
    createGroupAssignment,
    createStudentAssignment,
    getAssignmentDetail,
    getAssignmentStudentProgress,
    updateAssignmentDetails,
    updateAssignmentStatus,
  };
}

async function loadAssignmentState({
  canManageAssignments,
  includeMyAssignments,
  includeTrainerScope,
}) {
  const tasks = [];

  tasks.push(
    includeMyAssignments
      ? listMyAssignments()
      : Promise.resolve({ ok: true, data: [] }),
  );

  tasks.push(
    includeTrainerScope && canManageAssignments
      ? listAssignableExams()
      : Promise.resolve({ ok: true, data: [] }),
  );

  tasks.push(
    includeTrainerScope && canManageAssignments
      ? listAssignmentsForTrainerScope()
      : Promise.resolve({ ok: true, data: [] }),
  );

  const [myAssignmentsResult, assignableExamsResult, trainerAssignmentsResult] =
    await Promise.all(tasks);
  const failedResult = [
    myAssignmentsResult,
    assignableExamsResult,
    trainerAssignmentsResult,
  ].find((result) => !result.ok);

  if (failedResult) {
    return failedResult;
  }

  return {
    ok: true,
    data: {
      assignableExams: assignableExamsResult.data,
      trainerAssignments: trainerAssignmentsResult.data,
      myAssignments: myAssignmentsResult.data,
    },
  };
}
