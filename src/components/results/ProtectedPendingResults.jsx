import { useEffect, useRef, useState } from 'react';
import useCompletionRefresh from '../../hooks/useCompletionRefresh.js';
import { COMPLETION_ACCESS_DENIALS, completionStatusMessage, requireMatchingCompletionResult } from '../../lib/protectedCompletionStatus.js';
import { getSavedResultExamLabel } from '../../lib/savedResultExamIdentity.js';

const PAGE_SIZE = 20;
const unique = (items) => [...new Map(items.map((item) => [item.attemptId, item])).values()];
const completed = (items) => items.filter((item) => item.resultAvailable);

export default function ProtectedPendingResults({ client, accountId, examKey, onCompleted, onPendingIdsChange, runRead }) {
  // A discovery page and its cursor are one immutable traversal boundary.
  // Refresh updates its watched identities; only an explicit restart discovers
  // newer arrivals. Completed hand-offs survive page changes in a bounded tray.
  const known = useRef([]);
  const retained = useRef([]);
  const target = useRef('');
  const cursor = useRef(null);
  const lastCompletion = useRef('');
  const [page, setPage] = useState({ items: [], retained: [], nextCursor: null, loaded: false, resultUnavailable: false });
  const [pageNumber, setPageNumber] = useState(1);
  const scope = accountId + '|' + (examKey ?? '') + '|' + pageNumber;
  const refresh = useCompletionRefresh({
    scope,
    enabled: Boolean(client),
    read: ({ signal }) => runRead(async () => {
      const selected = target.current;
      target.current = '';
      const previous = known.current;
      let next = previous, nextRetained = retained.current, nextCursor = page.nextCursor;
      if (selected) {
        const status = await client.getCompletionStatus(selected, { signal });
        if (signal.aborted) return null;
        next = previous.map((v) => v.attemptId === selected ? status : v);
        nextRetained = nextRetained.map((v) => v.attemptId === selected ? status : v);
      } else {
        const response = await client.listPendingCompletions({
          examKey: examKey || undefined, pageSize: PAGE_SIZE, cursor: cursor.current,
          watchAttemptIds: previous.map((v) => v.attemptId),
        }, { signal });
        if (signal.aborted) return null;
        if (!page.loaded) {
          next = response.items;
          nextCursor = response.nextCursor;
        } else {
          const watched = new Map(response.watched.map((v) => [v.attemptId, v]));
          next = previous.map((v) => watched.get(v.attemptId) ?? v);
          // Do not adopt a fresh discovery cursor while retaining an old page.
        }
      }
      next = next.filter((v) => v.state !== 'closed');
      nextRetained = nextRetained.filter((v) => v.state !== 'closed' && !next.some((item) => item.attemptId === v.attemptId));
      let resultUnavailable = false;
      const ready = completed(unique([...nextRetained, ...next]));
      const selectedCompletion = selected && ready.find((v) => v.attemptId === selected);
      const previousIndex = ready.findIndex((v) => v.attemptId === lastCompletion.current);
      const completion = selectedCompletion || ready[(previousIndex + 1) % ready.length];
      // One result/history hand-off per pipeline, round-robin even after failure.
      if (completion) {
        lastCompletion.current = completion.attemptId;
        try {
          const payload = await client.getResult(completion.attemptId, { signal });
          if (signal.aborted) return null;
          const result = requireMatchingCompletionResult(payload.result, completion.attemptId);
          const handedOff = await onCompleted(result, { signal });
          if (signal.aborted) return null;
          if (handedOff) {
            next = next.filter((v) => v.attemptId !== completion.attemptId);
            nextRetained = nextRetained.filter((v) => v.attemptId !== completion.attemptId);
          } else resultUnavailable = true;
        } catch (error) {
          if (signal.aborted || COMPLETION_ACCESS_DENIALS.has(error?.code)) throw error;
          resultUnavailable = true;
        }
      }
      return { items: next, retained: nextRetained, nextCursor, loaded: true, resultUnavailable };
    }, { signal }),
    onValue: (value) => {
      if (!value) return;
      known.current = value.items;
      retained.current = value.retained;
      setPage(value);
      onPendingIdsChange?.(unique([...value.retained, ...value.items]).map((v) => v.attemptId));
    },
  });
  useEffect(() => () => onPendingIdsChange?.([]), [onPendingIdsChange]);
  const carried = unique([...page.retained, ...completed(page.items)]);
  const canNavigate = carried.length <= PAGE_SIZE;
  function navigate(nextCursor) {
    if (refresh.busy || refresh.denied || !canNavigate) return;
    cursor.current = nextCursor;
    retained.current = carried;
    known.current = [];
    target.current = '';
    onPendingIdsChange?.(carried.map((v) => v.attemptId));
    setPage({ items: [], retained: carried, nextCursor: null, loaded: false, resultUnavailable: page.resultUnavailable });
    setPageNumber((n) => n + 1);
  }
  function check(attemptId) {
    if (refresh.busy || refresh.denied) return;
    target.current = attemptId;
    refresh.check();
  }
  const rows = unique([...page.retained, ...page.items]);
  return <section className="selected-profile-panel no-print" aria-labelledby="pending-results-heading">
    <p className="eyebrow">Separate from completed results</p>
    <h3 id="pending-results-heading">Pending work</h3>
    <p>Pending attempts do not count as completed results, pass rates, readiness or daily credit. Dispatch may be paused; no marking completion time is promised.</p>
    <p>Refresh checks the attempts on this page. Use Check newest pending work to restart discovery and include newer arrivals.</p>
    {refresh.error ? <p className="error-note" role="alert">{refresh.denied ? 'Pending status access is unavailable. Sign in with the authorised account.' : 'Pending status is unavailable. This does not mean there are no pending attempts.'}</p> : null}
    {!page.loaded && !refresh.error ? <p role="status">Checking pending work...</p> : null}
    {page.loaded && !rows.length && !refresh.error ? <p role="status">{page.nextCursor ? 'No pending attempts in this page. Check the next page.' : 'No pending attempts in this page.'}</p> : null}
    {page.resultUnavailable ? <p className="error-note" role="alert">A completed result or its history entry could not be verified yet. Its pending entry is retained.</p> : null}
    {completed(rows).length ? <p>Completed work is checked in turn. Each check can continue through one more history page; use Refresh pending status or the row's Check status to continue.</p> : null}
    {!canNavigate ? <p role="status">Continue checking completed work before changing pages. Unverified hand-offs are retained.</p> : null}
    {rows.length ? <ul className="history-list">{rows.map((item) => <li key={item.attemptId}>
      <strong>{getSavedResultExamLabel(item.examKey)}</strong><span> · {item.profileName}</span>
      <p role="status">{completionStatusMessage(item)}</p>
      <p>Original deadline: <time dateTime={item.deadline}>{new Date(item.deadline).toLocaleString()}</time></p>
      {item.completedAt ? <p>Completed: <time dateTime={item.completedAt}>{new Date(item.completedAt).toLocaleString()}</time></p> : null}
      <button className="secondary-button compact-button" disabled={refresh.busy || refresh.denied} type="button" onClick={() => check(item.attemptId)}>Check status</button>
    </li>)}</ul> : null}
    <div className="button-row wrap">
      <button className="secondary-button" type="button" disabled={refresh.busy || refresh.denied} onClick={refresh.check}>{refresh.busy ? 'Checking status...' : 'Refresh pending status'}</button>
      {page.nextCursor ? <button className="secondary-button" type="button" disabled={refresh.busy || refresh.denied || !canNavigate} onClick={() => navigate(page.nextCursor)}>Next pending page</button> : null}
      <button className="secondary-button" type="button" disabled={refresh.busy || refresh.denied || !canNavigate} onClick={() => navigate(null)}>Check newest pending work</button>
    </div>
    <p>Automatic checks are limited. Existing attempt limits may prevent another start while pending work remains; checking status does not change those limits.</p>
  </section>;
}
