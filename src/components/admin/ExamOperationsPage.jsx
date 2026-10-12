import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  examOperationsService,
  getExamOperationsMessage,
} from '../../lib/examOperationsService.js';

export default function ExamOperationsPage({
  identity,
  onBackHome,
  onBrowseExams,
  onOpenAccount,
  service = examOperationsService,
}) {
  const [exams, setExams] = useState([]);
  const [selectedExamKey, setSelectedExamKey] = useState('');
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [errorReason, setErrorReason] = useState('');
  const [historyError, setHistoryError] = useState(false);
  const historyRequestControllerRef = useRef(null);
  const selectedExamKeyRef = useRef('');
  if (historyRequestControllerRef.current === null) {
    historyRequestControllerRef.current = createHistoryRequestController();
  }
  const {
    isAuthenticated,
    isPlatformOwner,
    isSupabaseConfigured,
    loading: identityLoading,
  } = identity ?? {};

  const selectExam = useCallback((examKey) => {
    if (examKey === selectedExamKeyRef.current) return;
    historyRequestControllerRef.current.invalidate();
    selectedExamKeyRef.current = examKey;
    setHistory([]);
    setHistoryError(false);
    setHistoryLoading(Boolean(examKey && isPlatformOwner));
    setSelectedExamKey(examKey);
  }, [isPlatformOwner]);

  const loadOverview = useCallback(async ({ refresh = false } = {}) => {
    if (!isPlatformOwner) return;
    refresh ? setRefreshing(true) : setLoading(true);
    setErrorReason('');
    const result = await service.loadOverview();

    if (result.ok) {
      setExams(result.data);
      const current = selectedExamKeyRef.current;
      selectExam(result.data.some((exam) => exam.examKey === current)
        ? current
        : result.data[0]?.examKey ?? '');
    } else {
      setExams([]);
      selectExam('');
      setErrorReason(result.reason);
    }
    setLoading(false);
    setRefreshing(false);
  }, [isPlatformOwner, selectExam, service]);

  const loadHistory = useCallback(async (examKey) => {
    if (!isPlatformOwner || !examKey) return;
    await historyRequestControllerRef.current.run(
      () => service.loadHistory(examKey),
      {
        onComplete: () => setHistoryLoading(false),
        onError: () => {
          setHistory([]);
          setHistoryError(true);
        },
        onStart: () => {
          setHistoryLoading(true);
          setHistoryError(false);
        },
        onSuccess: (operations) => {
          setHistory(operations);
          setHistoryError(false);
        },
      },
    );
  }, [isPlatformOwner, service]);

  useEffect(() => {
    if (isPlatformOwner) loadOverview();
  }, [isPlatformOwner, loadOverview]);

  useEffect(() => {
    if (selectedExamKey) loadHistory(selectedExamKey);
  }, [loadHistory, selectedExamKey]);

  useEffect(() => () => {
    historyRequestControllerRef.current.invalidate();
  }, []);

  useEffect(() => {
    if (isPlatformOwner) return;
    historyRequestControllerRef.current.invalidate();
    setHistory([]);
    setHistoryError(false);
    setHistoryLoading(false);
  }, [isPlatformOwner]);

  const selectedExam = useMemo(
    () => exams.find((exam) => exam.examKey === selectedExamKey) ?? null,
    [exams, selectedExamKey],
  );

  if (!isSupabaseConfigured) {
    return <ExamOperationsShell {...{ onBackHome, onBrowseExams, onOpenAccount }}>
      <StatePanel title="Exam Operations is not configured" note={getExamOperationsMessage('not_configured')} />
    </ExamOperationsShell>;
  }
  if (!isAuthenticated) {
    return <ExamOperationsShell {...{ onBackHome, onBrowseExams, onOpenAccount }}>
      <StatePanel title="Sign in to continue" note="Sign in with an active Platform Owner account to view Exam Operations." />
    </ExamOperationsShell>;
  }
  if (identityLoading && !isPlatformOwner) {
    return <ExamOperationsShell {...{ onBackHome, onBrowseExams, onOpenAccount }}>
      <StatePanel title="Checking Exam Operations access..." note="CertSim is verifying the current account role before loading operational data." />
    </ExamOperationsShell>;
  }
  if (!isPlatformOwner) {
    return <ExamOperationsShell {...{ onBackHome, onBrowseExams, onOpenAccount }}>
      <StatePanel title="Exam Operations access denied" note={getExamOperationsMessage('forbidden')} />
    </ExamOperationsShell>;
  }
  if (loading) {
    return <ExamOperationsShell {...{ onBackHome, onBrowseExams, onOpenAccount }}>
      <StatePanel title="Loading Exam Operations..." note="Reading sanitized release health and continuation aggregates." />
    </ExamOperationsShell>;
  }
  if (errorReason) {
    return <ExamOperationsShell {...{ onBackHome, onBrowseExams, onOpenAccount }}>
      <StatePanel title="Exam Operations could not be loaded" note={getExamOperationsMessage(errorReason)}>
        <button className="secondary-button" type="button" onClick={() => loadOverview()}>Try again</button>
      </StatePanel>
    </ExamOperationsShell>;
  }

  return (
    <ExamOperationsShell {...{ onBackHome, onBrowseExams, onOpenAccount }}>
      <div className="examops-toolbar no-print">
        <label>
          Protected exam
          <select value={selectedExamKey} onChange={(event) => selectExam(event.target.value)}>
            {exams.map((exam) => <option key={exam.examKey} value={exam.examKey}>{exam.code} — {exam.title}</option>)}
          </select>
        </label>
        <button className="secondary-button" disabled={refreshing} type="button" onClick={() => loadOverview({ refresh: true })}>
          {refreshing ? 'Refreshing...' : 'Refresh health'}
        </button>
      </div>

      {selectedExam ? <ExamHealth exam={selectedExam} /> : (
        <StatePanel title="Protected exam not found" note={getExamOperationsMessage('exam_not_found')} />
      )}

      <OperationHistory history={history} loading={historyLoading} error={historyError} />
    </ExamOperationsShell>
  );
}

export function createHistoryRequestController() {
  let generation = 0;

  return Object.freeze({
    invalidate() {
      generation += 1;
    },
    async run(load, handlers = {}) {
      const requestGeneration = ++generation;
      handlers.onStart?.();
      let result;
      try {
        result = await load();
      } catch {
        result = { ok: false };
      }
      if (requestGeneration !== generation) {
        return Object.freeze({ applied: false, stale: true });
      }
      if (result?.ok) handlers.onSuccess?.(result.data);
      else handlers.onError?.();
      handlers.onComplete?.();
      return Object.freeze({ applied: true, stale: false });
    },
  });
}

export function ExamHealth({ exam }) {
  const { health } = exam;
  const missingContracts = health.currentMissingContinuationContracts;

  return <div className="examops-content">
    <section className={`examops-status-panel ${health.healthStatus.toLowerCase()}`} aria-labelledby="examops-health-heading">
      <div>
        <p className="eyebrow">{exam.code}</p>
        <h2 id="examops-health-heading">{exam.title}</h2>
        <p>Server-authoritative protected release health observed {formatTimestamp(health.observedAt)}.</p>
      </div>
      <StatusBadge status={health.healthStatus} />
    </section>

    <section className="examops-section" aria-labelledby="examops-current-heading">
      <SectionHeading id="examops-current-heading" eyebrow="Current release" title="Current release configuration" />
      <div className="examops-fact-grid">
        <Fact label="Package version" value={health.currentPackageVersion || 'Unresolved'} />
        <Fact label="Current state" value={humanizeCode(health.currentStateStatus)} tone={health.currentStateStatus === 'CURRENT_STATE_VALID' ? 'pass' : 'critical'} />
        <Fact label="Package status" value={humanizeCode(health.packageStatus) || 'Not available'} />
        <Fact label="Package schema" value={health.packageSchemaVersion || 'Not available'} />
        <Fact label="Generator" value={health.generatorVersion || 'Not available'} />
        <Fact label="Scorer" value={health.scorerVersion || 'Not available'} />
        <Fact label="Enabled defaults" value={health.enabledDefaultCount} />
        <Fact label="Enabled profiles" value={health.enabledProfileCount} />
        <Fact label="Production activations" value={health.productionActivationCount} />
        <Fact label="Usable practice policies" value={health.usablePracticePolicyCount} />
      </div>
      {health.currentStateFindings.length > 0 ? <div className="examops-findings critical">
        <strong>Current-state findings</strong>
        <ul>{health.currentStateFindings.map((finding) => <li key={finding}>{humanizeCode(finding)}</li>)}</ul>
      </div> : <p className="examops-confirmation">Current release configuration is structurally valid.</p>}
      <details className="examops-technical-details">
        <summary>Technical evidence</summary>
        <dl>
          <FactRow label="Source commit" value={health.sourceCommitSha || 'Not available'} />
          <FactRow label="Validation hash" value={health.validationHash || 'Not available'} />
          <FactRow label="Package hash" value={health.packageHash || 'Not available'} />
          <FactRow label="Configuration hash" value={health.configurationHash || 'Not available'} />
          <FactRow label="Catalogue" value={`${health.catalogueVersion || 'Unresolved'} · ${humanizeCode(health.catalogueStatus) || 'Not available'} · ${humanizeCode(health.catalogueLifecycle) || 'Not available'}`} />
        </dl>
      </details>
    </section>

    <section className={`examops-section ${missingContracts > 0 ? 'critical' : ''}`} aria-labelledby="examops-continuation-heading">
      <SectionHeading id="examops-continuation-heading" eyebrow="Attempt custody" title="Continuation health" />
      {missingContracts > 0 ? <p className="examops-critical-warning" role="alert">Critical: {missingContracts} currently continuable attempt{missingContracts === 1 ? '' : 's'} {missingContracts === 1 ? 'lacks' : 'lack'} an immutable continuation contract.</p> : null}
      <div className="examops-fact-grid compact">
        <Fact label="Continuable" value={health.currentContinuableAttempts} />
        <Fact label="Contracts present" value={health.currentContinuationContracts} tone="pass" />
        <Fact label="Missing contracts" value={missingContracts} tone={missingContracts > 0 ? 'critical' : 'pass'} />
        <Fact label="Timed" value={health.currentTimedAttempts} />
        <Fact label="Practice" value={health.currentPracticeAttempts} />
        <Fact label="Older package" value={health.olderPackageContinuableAttempts} tone={health.olderPackageContinuableAttempts > 0 ? 'warning' : ''} />
        <Fact label="Frozen submit" value={health.frozenSubmitCount} />
      </div>
    </section>

    <section className="examops-section" aria-labelledby="examops-evidence-heading">
      <SectionHeading id="examops-evidence-heading" eyebrow="Release evidence" title="Current release evidence" />
      {health.releaseEvidenceSource ? <div className="examops-fact-grid compact">
        <Fact label="Source" value={humanizeCode(health.releaseEvidenceSource)} />
        <Fact label="Stage" value={humanizeCode(health.releaseEvidenceStage)} />
        <Fact label="Package" value={health.releaseEvidencePackageVersion || 'Not available'} />
        <Fact label="Profile" value={health.releaseEvidenceProfileKey || 'Whole exam'} />
        <Fact label="Recorded" value={formatTimestamp(health.releaseEvidenceTimestamp)} />
      </div> : <p className="examops-empty">No current release evidence is available for this exam.</p>}
      <p className="examops-footnote">Legacy release evidence is shown separately and is not Exam Operations history.</p>
    </section>

    <section className="examops-section" aria-labelledby="examops-telemetry-heading">
      <SectionHeading id="examops-telemetry-heading" eyebrow="Measurement coverage" title="Telemetry availability" />
      <ul className="examops-telemetry-list">
        {health.telemetry.map((item) => <li key={item.code}><span>{humanizeCode(item.code)}</span><strong>Not available</strong></li>)}
      </ul>
      <p className="examops-footnote">Not available means CertSim does not currently measure this signal. It is not a passing result.</p>
    </section>
  </div>;
}

export function OperationHistory({ error, history, loading }) {
  return <section className="examops-section" aria-labelledby="examops-history-heading">
    <SectionHeading id="examops-history-heading" eyebrow="Generic ledger" title="Exam Operations history" />
    {loading ? <p className="examops-empty">Loading operation history...</p> : null}
    {!loading && error ? <p className="examops-error" role="alert">Operation history is temporarily unavailable. Health data remains read only.</p> : null}
    {!loading && !error && history.length === 0 ? <p className="examops-empty">No Exam Operations releases have been recorded yet.</p> : null}
    {!loading && !error && history.length > 0 ? <div className="examops-table-wrap"><table className="examops-history-table">
      <thead><tr><th>Timestamp</th><th>Operation</th><th>Status</th><th>Target version</th><th>Actor category</th><th>Outcome</th></tr></thead>
      <tbody>{history.map((operation, index) => <tr key={`${operation.createdAt}-${operation.operationType}-${index}`}>
        <td>{formatTimestamp(operation.completedAt || operation.createdAt)}</td>
        <td>{humanizeCode(operation.operationType)}</td>
        <td>{humanizeCode(operation.resultState)}</td>
        <td>{operation.targetVersion || 'Not available'}</td>
        <td>Platform Owner</td>
        <td>{humanizeCode(operation.outcome) || 'Not available'}</td>
      </tr>)}</tbody>
    </table></div> : null}
  </section>;
}

function ExamOperationsShell({ children, onBackHome, onBrowseExams, onOpenAccount }) {
  return <section className="management-page examops-page" aria-labelledby="examops-page-heading">
    <header className="management-hero">
      <div>
        <p className="eyebrow">Platform Owner</p>
        <h1 id="examops-page-heading">Exam Operations</h1>
        <p>Review protected release health, continuation custody, operational history, and measurement availability. This workspace is read only.</p>
      </div>
      <div className="button-row wrap no-print">
        <button className="secondary-button" type="button" onClick={onOpenAccount}>Back to Account</button>
        <button className="secondary-button" type="button" onClick={onBrowseExams}>Browse Exams</button>
        <button className="secondary-button" type="button" onClick={onBackHome}>Home</button>
      </div>
    </header>
    {children}
  </section>;
}

function StatePanel({ children, note, title }) {
  return <section className="management-panel examops-state-panel"><h2>{title}</h2><p>{note}</p>{children}</section>;
}

function SectionHeading({ eyebrow, id, title }) {
  return <div className="examops-section-heading"><p className="eyebrow">{eyebrow}</p><h2 id={id}>{title}</h2></div>;
}

function Fact({ label, tone = '', value }) {
  return <div className={`examops-fact ${tone}`}><span>{label}</span><strong>{value}</strong></div>;
}

function FactRow({ label, value }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function StatusBadge({ status }) {
  return <span className={`examops-status-badge ${status.toLowerCase()}`}>{status}</span>;
}

function humanizeCode(value) {
  return String(value ?? '').replace(/[_-]+/g, ' ').toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

function formatTimestamp(value) {
  if (!value) return 'Not available';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString();
}
