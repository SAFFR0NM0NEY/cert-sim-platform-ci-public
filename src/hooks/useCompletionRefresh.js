import { useCallback, useEffect, useRef, useState } from 'react';
import { createCompletionRefreshController } from '../lib/completionRefreshController.js';

export default function useCompletionRefresh({ scope, enabled = true, read, onValue, shouldContinue, canRead, onBusy }) {
  const latest = useRef({ scope, read, onValue, shouldContinue, canRead, onBusy });
  latest.current = { scope, read, onValue, shouldContinue, canRead, onBusy };
  const controller = useRef(null);
  const [state, setState] = useState({ busy: false, error: '', denied: false });
  useEffect(() => {
    setState({ busy: false, error: '', denied: false });
    if (!enabled) return undefined;
    const current = () => latest.current.scope === scope;
    const instance = createCompletionRefreshController({
      read: (options) => current() ? latest.current.read(options) : null,
      canRead: () => current() && (latest.current.canRead?.() ?? true),
      onValue: (value) => { if (current()) { setState((s) => ({ ...s, error: '' })); latest.current.onValue?.(value); } },
      onError: (error) => { if (current()) setState((s) => ({ ...s, error: error?.code ?? 'status_unavailable', denied: ['unauthenticated', 'inactive_account', 'not_allowlisted', 'access_not_granted', 'origin_not_allowed', 'attempt_not_found'].includes(error?.code) })); },
      onBusy: (busy) => { if (current()) { latest.current.onBusy?.(busy); setState((s) => ({ ...s, busy })); } },
      shouldContinue: (value) => latest.current.shouldContinue?.(value) ?? true,
    });
    controller.current = instance;
    instance.start();
    return () => { instance.dispose(); if (controller.current === instance) controller.current = null; };
  }, [scope, enabled]);
  return { ...state, check: useCallback(() => controller.current?.check(), []) };
}
