import { useCallback, useEffect, useRef, useState } from 'react';

import useCurrentIdentity from './useCurrentIdentity.js';
import { getTrainerStudentResultDetail } from '../lib/trainerDashboardService.js';
import { getTrainerStudentDetail } from '../lib/trainerStudentDetailService.js';

const emptyDetail = {
  student: null,
  assignments: [],
  results: [],
  examProgress: [],
  assignmentReadiness: [],
  learnerPage: null,
  history: null,
};

export default function useTrainerStudentDetail({ membershipId = '', scope = {} } = {}) {
  const identity = useCurrentIdentity();
  const [detail, setDetail] = useState(emptyDetail);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [selectedResult, setSelectedResult] = useState(null);
  const [resultLoading, setResultLoading] = useState(false);
  const requestRef = useRef(0);
  const resultRequestRef = useRef(0);
  const controllerRef = useRef(null);
  const resultControllerRef = useRef(null);

  const refresh = useCallback(async () => {
    if (!membershipId || !identity.isSupabaseConfigured || !identity.isAuthenticated) {
      setDetail(emptyDetail);
      setLoading(false);
      return { ok: false, reason: 'disabled' };
    }
    const requestId = ++requestRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    resultRequestRef.current += 1;
    resultControllerRef.current?.abort();
    setLoading(true);
    setResultLoading(false);
    setError('');
    setReason('');
    setSelectedResult(null);
    const result = await getTrainerStudentDetail(membershipId, scope, { signal: controller.signal });
    if (requestId !== requestRef.current || controller.signal.aborted) {
      return { ok: false, reason: 'stale_request' };
    }
    if (result.ok) {
      setDetail(result.data);
    } else {
      setDetail(emptyDetail);
      setError(result.message);
      setReason(result.reason);
    }
    setLoading(false);
    return result;
  }, [identity.isAuthenticated, identity.isSupabaseConfigured, membershipId,
    scope.assignmentId, scope.campusId, scope.examKey, scope.groupId,
    scope.organisationId, scope.resultStatus]);

  useEffect(() => {
    setDetail(emptyDetail);
    setSelectedResult(null);
    if (!identity.loading) refresh();
    return () => {
      requestRef.current += 1;
      resultRequestRef.current += 1;
      controllerRef.current?.abort();
      resultControllerRef.current?.abort();
    };
  }, [identity.loading, refresh]);

  const loadResultDetail = useCallback(async (attemptId) => {
    const requestId = ++resultRequestRef.current;
    resultControllerRef.current?.abort();
    const controller = new AbortController();
    resultControllerRef.current = controller;
    setResultLoading(true);
    setError('');
    const result = await getTrainerStudentResultDetail(attemptId, { signal: controller.signal });
    if (requestId !== resultRequestRef.current || controller.signal.aborted) {
      return { ok: false, reason: 'stale_request' };
    }
    if (result.ok) setSelectedResult({ ...result.data, attemptId, studentName: detail.student?.displayName || 'Student' });
    else setError(result.message);
    setResultLoading(false);
    return result;
  }, [detail.student?.displayName]);

  const clearSelectedResult = useCallback(() => {
    resultRequestRef.current += 1;
    resultControllerRef.current?.abort();
    setSelectedResult(null);
    setResultLoading(false);
  }, []);

  return {
    ...identity,
    ...detail,
    loading: identity.loading || loading,
    detailLoading: resultLoading,
    error: error || identity.error,
    reason,
    selectedResult,
    clearSelectedResult,
    loadResultDetail,
    refresh,
  };
}
