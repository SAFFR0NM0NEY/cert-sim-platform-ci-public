import { useCallback, useEffect, useRef, useState } from 'react';
import { getTrainerScopeOptions } from '../lib/trainerScopeService.js';

const empty = { organisations: [], campuses: [], groups: [], assignments: [], exams: [], locks: {}, selection: {}, role: '' };

export default function useTrainerScopeOptions(organisationId, { enabled = true } = {}) {
  const [state, setState] = useState(empty);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
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
    const result = await getTrainerScopeOptions({ organisationId }, { signal: controller.signal });
    if (requestId !== requestRef.current || controller.signal.aborted) return { ok: false, reason: 'stale_request' };
    if (result.ok) setState(result.data ?? empty);
    else setError(result.message);
    setLoading(false);
    return result;
  }, [enabled, organisationId]);

  useEffect(() => {
    refresh();
    return () => { requestRef.current += 1; controllerRef.current?.abort(); };
  }, [refresh]);

  return { ...state, loading, error, refresh };
}
