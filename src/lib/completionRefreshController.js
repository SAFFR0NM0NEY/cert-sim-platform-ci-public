import { COMPLETION_ACCESS_DENIALS, COMPLETION_POLL_DELAYS } from './protectedCompletionStatus.js';

// One bounded logical read pipeline. The pipeline may read status, then a matching
// result/history sequentially. Manual/focus clicks coalesce with an active read.
export function createCompletionRefreshController({
  read, onValue = () => {}, onError = () => {}, onBusy = () => {},
  shouldContinue = () => true, canRead = () => true,
  documentTarget = globalThis.document, windowTarget = globalThis.window,
  isOnline = () => globalThis.navigator?.onLine !== false,
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
  delays = COMPLETION_POLL_DELAYS,
}) {
  let disposed = false, denied = false, stopped = false, timer = null, pending = null, controller = null;
  let automaticReads = 0;
  const visible = () => documentTarget?.visibilityState !== 'hidden' && isOnline();
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  function arm() {
    clear();
    if (disposed || denied || stopped || pending || !visible() || automaticReads > delays.length) return;
    const delay = automaticReads === 0 ? delays[0] : delays[automaticReads - 1];
    if (delay === undefined) return;
    timer = setTimer(() => { timer = null; check(true); }, delay);
  }
  function check(automatic = false) {
    if (disposed || denied || stopped) return Promise.resolve(null);
    if (pending) return pending;
    clear();
    if (!visible() || !canRead()) { if (!automatic && !visible()) onError({ code: 'status_offline' }); arm(); return Promise.resolve(null); }
    if (automatic && automaticReads > delays.length) return Promise.resolve(null);
    if (automatic) automaticReads += 1;
    controller = new AbortController();
    const current = controller;
    onBusy(true);
    pending = Promise.resolve().then(() => disposed || current.signal.aborted ? null : read({ signal: current.signal })).then((value) => {
      if (disposed || current.signal.aborted) return null;
      onValue(value);
      if (!shouldContinue(value)) stopped = true;
      return value;
    }).catch((error) => {
      if (disposed || current.signal.aborted) return null;
      denied = COMPLETION_ACCESS_DENIALS.has(error?.code);
      onError(error);
      return null;
    }).finally(() => {
      if (disposed) return;
      pending = null;
      controller = null;
      onBusy(false);
      arm();
    });
    return pending;
  }
  const environmentChanged = () => { if (!visible()) clear(); else arm(); };
  documentTarget?.addEventListener('visibilitychange', environmentChanged);
  windowTarget?.addEventListener('online', environmentChanged);
  windowTarget?.addEventListener('offline', environmentChanged);
  return Object.freeze({
    start: () => check(true), check: () => check(false),
    getSnapshot: () => ({ pending: Boolean(pending), automaticReads, denied, stopped, disposed, timerActive: timer !== null }),
    dispose: () => {
      disposed = true; clear(); controller?.abort();
      documentTarget?.removeEventListener('visibilitychange', environmentChanged);
      windowTarget?.removeEventListener('online', environmentChanged);
      windowTarget?.removeEventListener('offline', environmentChanged);
    },
  });
}
