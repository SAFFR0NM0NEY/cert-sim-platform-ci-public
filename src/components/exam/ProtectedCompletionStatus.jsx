import { useState } from 'react';
import useCompletionRefresh from '../../hooks/useCompletionRefresh.js';
import { COMPLETION_ACCESS_DENIALS, completionStatusMessage, requireMatchingCompletionResult } from '../../lib/protectedCompletionStatus.js';

export default function ProtectedCompletionStatus({
  client, attemptId, accountId, initialStatus, onResult, onExit,
  onBusyChange, canRead, manualRecovery = null,
}) {
  const [status, setStatus] = useState(initialStatus?.state === 'active' ? null : initialStatus ?? null);
  const [resultUnavailable, setResultUnavailable] = useState(false);
  const refresh = useCompletionRefresh({
    scope: accountId + '|' + attemptId,
    read: async ({ signal }) => {
      const next = await client.getCompletionStatus(attemptId, { signal });
      if (!next.resultAvailable) return { status: next, result: null, resultUnavailable: false };
      try {
        const payload = await client.getResult(attemptId, { signal });
        return { status: next, result: requireMatchingCompletionResult(payload.result, attemptId), resultUnavailable: false };
      } catch (error) {
        if (signal.aborted || COMPLETION_ACCESS_DENIALS.has(error?.code)) throw error;
        return { status: next, result: null, resultUnavailable: true };
      }
    },
    canRead,
    onBusy: onBusyChange,
    onValue: (value) => {
      if (!value) return;
      setStatus(value.status);
      setResultUnavailable(value.resultUnavailable);
      if (value.result) onResult(value.result);
    },
    shouldContinue: (value) => !value?.result && value?.status?.state !== 'closed',
  });
  const readAllowed = canRead?.() !== false;
  return <section className="exam-workspace protected-status" aria-labelledby="expiry-completion-heading">
    <p className="eyebrow">Attempt completion</p>
    <h2 id="expiry-completion-heading">{status?.state === 'closed' ? 'Attempt closed' : status?.state === 'completed' ? 'Checking completed result' : status?.closureReason === 'manual_submission' ? 'Submission pending' : 'Time expired'}</h2>
    <p role="status" aria-live="polite">{completionStatusMessage(status)}</p>
    <p>Answering, Save and learner Run are locked. Only work acknowledged by the server is saved; unsent browser edits are not part of marking.</p>
    {status?.deadline ? <p>Original deadline: <time dateTime={status.deadline}>{new Date(status.deadline).toLocaleString()}</time></p> : null}
    {status?.completedAt ? <p>Completed: <time dateTime={status.completedAt}>{new Date(status.completedAt).toLocaleString()}</time></p> : null}
    {refresh.error ? <p className="error-note" role="alert">{refresh.denied ? 'Status access is no longer available. Sign in with the authorised account before checking again.' : 'Status is unavailable. No new processing failure or completed result has been inferred.'}</p> : null}
    {resultUnavailable ? <p className="error-note" role="alert">The completed result could not be verified yet. Check again; this attempt remains visible here.</p> : null}
    <p>You can leave and check Pending work in Saved Results after signing in. Automatic checks are limited; no finishing time is promised.</p>
    <div className="exam-actions">
      <button className="secondary-button" type="button" disabled={refresh.busy || refresh.denied || !readAllowed} onClick={refresh.check}>{refresh.busy ? 'Checking status...' : 'Check status'}</button>
      <button className="primary-button" type="button" onClick={onExit}>Return home</button>
    </div>
    {manualRecovery}
  </section>;
}
