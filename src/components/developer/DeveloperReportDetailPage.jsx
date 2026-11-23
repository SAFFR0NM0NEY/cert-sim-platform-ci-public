import { useEffect, useMemo, useState } from 'react';

import useDeveloperDashboard from '../../hooks/useDeveloperDashboard.js';
import { hasDeveloperDashboardAccess } from '../../lib/roleUtils.js';

const statusOptions = [
  { value: 'open', label: 'Open' },
  { value: 'in_review', label: 'In review' },
  { value: 'need_info', label: 'Need info' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'dismissed', label: 'Dismissed' },
];

const priorityOptions = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

const initialStatusForm = {
  priority: 'normal',
  status: 'open',
  internalNotes: '',
  reporterFeedback: '',
};

export default function DeveloperReportDetailPage({
  onBackHome,
  onBackToDashboard,
  onBrowseExams,
  onOpenSavedResult,
  reportId = '',
} = {}) {
  const dashboard = useDeveloperDashboard();
  const {
    dashboardLoading,
    error,
    isAuthenticated,
    isPlatformOwner,
    isSupabaseConfigured,
    loading,
    memberships,
    reports,
    updateReportStatus,
  } = dashboard;
  const hasAccess = hasDeveloperDashboardAccess({ isPlatformOwner, memberships });
  const report = useMemo(
    () => reports.find((candidate) => candidate.id === reportId) ?? null,
    [reportId, reports],
  );
  const metadataRows = useMemo(() => createMetadataRows(report?.metadata), [report]);
  const [statusForm, setStatusForm] = useState(initialStatusForm);
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyAction, setBusyAction] = useState(false);

  useEffect(() => {
    if (!report) {
      return;
    }

    setStatusForm({
      priority: report.priority ?? 'normal',
      status: report.status ?? 'open',
      internalNotes: report.internalNotes ?? '',
      reporterFeedback: report.reporterFeedback ?? '',
    });
  }, [
    report?.id,
    report?.internalNotes,
    report?.priority,
    report?.reporterFeedback,
    report?.status,
  ]);

  if (!isSupabaseConfigured) {
    return (
      <DeveloperReportDetailShell
        onBackHome={onBackHome}
        onBackToDashboard={onBackToDashboard}
        onBrowseExams={onBrowseExams}
      >
        <StatePanel
          title="Report detail is not configured here"
          note="This environment is running in frontend-only mode. Developer report detail requires Supabase configuration."
        />
      </DeveloperReportDetailShell>
    );
  }

  if (!isAuthenticated) {
    return (
      <DeveloperReportDetailShell
        onBackHome={onBackHome}
        onBackToDashboard={onBackToDashboard}
        onBrowseExams={onBrowseExams}
      >
        <StatePanel
          title="Sign in to continue"
          note="Sign in with a Developer or Platform Owner account to view support report detail. Protected certification exams require sign-in and access."
        />
      </DeveloperReportDetailShell>
    );
  }

  if (loading && !hasAccess) {
    return (
      <DeveloperReportDetailShell
        onBackHome={onBackHome}
        onBackToDashboard={onBackToDashboard}
        onBrowseExams={onBrowseExams}
      >
        <StatePanel
          title="Checking Developer report access..."
          note="CertSim is reading your profile and active memberships."
        />
      </DeveloperReportDetailShell>
    );
  }

  if (!hasAccess) {
    return (
      <DeveloperReportDetailShell
        onBackHome={onBackHome}
        onBackToDashboard={onBackToDashboard}
        onBrowseExams={onBrowseExams}
      >
        <StatePanel
          title="Report detail is not available for this account"
          note="This page is limited to active Developer and Platform Owner memberships. Normal exam access remains unchanged."
        />
      </DeveloperReportDetailShell>
    );
  }

  if (!reportId) {
    return (
      <DeveloperReportDetailShell
        onBackHome={onBackHome}
        onBackToDashboard={onBackToDashboard}
        onBrowseExams={onBrowseExams}
      >
        <StatePanel
          title="Choose a report first"
          note="Open a report from the Developer Dashboard queue."
        />
      </DeveloperReportDetailShell>
    );
  }

  if (!report && (loading || dashboardLoading)) {
    return (
      <DeveloperReportDetailShell
        onBackHome={onBackHome}
        onBackToDashboard={onBackToDashboard}
        onBrowseExams={onBrowseExams}
      >
        <StatePanel
          title="Loading report detail..."
          note="CertSim is reading the support queue and report context."
        />
      </DeveloperReportDetailShell>
    );
  }

  if (!report) {
    return (
      <DeveloperReportDetailShell
        onBackHome={onBackHome}
        onBackToDashboard={onBackToDashboard}
        onBrowseExams={onBrowseExams}
      >
        {error ? <p className="auth-panel-error">{error}</p> : null}
        <StatePanel
          title="Report was not found"
          note="This report is not in the current Developer queue, or it is no longer available through your support role."
        />
      </DeveloperReportDetailShell>
    );
  }

  return (
    <DeveloperReportDetailShell
      onBackHome={onBackHome}
      onBackToDashboard={onBackToDashboard}
      onBrowseExams={onBrowseExams}
      report={report}
    >
      {error ? <p className="auth-panel-error">{error}</p> : null}
      {actionMessage ? <p className="auth-panel-success">{actionMessage}</p> : null}
      {actionError ? <p className="auth-panel-error">{actionError}</p> : null}

      <section className="developer-report-detail-grid">
        <article className="developer-report-detail-card">
          <p className="auth-panel-title">Report summary</p>
          <dl className="developer-report-detail-facts">
            <DetailFact label="Title" value={report.title} wide />
            <DetailFact label="Source" value={report.sourceLabel} />
            <DetailFact label="Type" value={report.reportTypeLabel} />
            <DetailFact label="Status" value={report.statusLabel} />
            <DetailFact label="Priority" value={report.priorityLabel} />
            <DetailFact label="Created" value={formatDate(report.createdAt)} />
            <DetailFact label="Updated" value={formatDate(report.updatedAt)} />
            <DetailFact label="Resolved" value={formatDate(report.resolvedAt)} />
          </dl>
        </article>

        <article className="developer-report-detail-card">
          <p className="auth-panel-title">Reporter</p>
          <dl className="developer-report-detail-facts">
            <DetailFact
              label="Display name"
              value={report.reporter?.displayName || 'Unknown user'}
            />
            <DetailFact
              label="Email"
              value={report.reporter?.email || 'Email unavailable'}
            />
            <DetailFact
              label="Profile status"
              value={report.reporter?.status || 'Not captured'}
            />
          </dl>
        </article>

        <article className="developer-report-detail-card wide">
          <div className="management-section-heading compact-heading">
            <div>
              <p className="auth-panel-title">Context</p>
              <p className="auth-panel-note">
                Report context is for reproduction and support. It does not
                change exam scoring or access.
              </p>
            </div>
            {report.resultId ? (
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => onOpenSavedResult?.(report.resultId)}
              >
                Open saved result
              </button>
            ) : null}
          </div>
          <dl className="developer-report-detail-facts context">
            <DetailFact
              label="Exam"
              value={report.examTitle || report.examKey || 'Not linked'}
              wide
            />
            <DetailFact label="Question ID" value={report.questionId || 'Not linked'} />
            <DetailFact label="Question type" value={report.questionType || 'Not linked'} />
            <DetailFact label="Attempt ID" value={report.attemptId || 'Not linked'} />
            <DetailFact label="Saved result ID" value={report.resultId || 'Not linked'} />
            <DetailFact label="Route submitted from" value={report.routePath || 'Not captured'} wide />
          </dl>
        </article>

        <article className="developer-report-detail-card wide">
          <p className="auth-panel-title">Message/details</p>
          <p className="developer-report-detail-message">
            {report.message || 'No details were provided.'}
          </p>
          {metadataRows.length > 0 ? (
            <dl className="developer-report-detail-facts metadata">
              {metadataRows.map((row) => (
                <DetailFact key={row.label} label={row.label} value={row.value} />
              ))}
            </dl>
          ) : null}
        </article>

        <article className="developer-report-detail-card developer-report-workflow-card wide">
          <p className="auth-panel-title">Developer workflow</p>
          <form className="developer-report-detail-form" onSubmit={handleUpdateStatus}>
            <div className="developer-report-detail-control-row">
              <label>
                <span>Status</span>
                <select
                  value={statusForm.status}
                  onChange={(event) =>
                    setStatusForm((current) => ({
                      ...current,
                      status: event.target.value,
                    }))
                  }
                >
                  {statusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Priority</span>
                <select
                  value={statusForm.priority}
                  onChange={(event) =>
                    setStatusForm((current) => ({
                      ...current,
                      priority: event.target.value,
                    }))
                  }
                >
                  {priorityOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="developer-report-detail-field">
              <span>Internal notes - only visible to Developer/Platform Owner</span>
              <textarea
                rows="8"
                value={statusForm.internalNotes}
                onChange={(event) =>
                  setStatusForm((current) => ({
                    ...current,
                    internalNotes: event.target.value,
                  }))
                }
                placeholder="Record support/debug notes. These are not returned by My Reports."
              />
            </label>
            <label className="developer-report-detail-field">
              <span>Reporter feedback - visible to the reporter</span>
              <textarea
                rows="8"
                value={statusForm.reporterFeedback}
                onChange={(event) =>
                  setStatusForm((current) => ({
                    ...current,
                    reporterFeedback: event.target.value,
                  }))
                }
                placeholder="Write a short, professional update the reporter can safely read."
              />
            </label>
            <p className="auth-panel-muted">
              Reporter feedback is shown under My Reports. Internal notes stay
              inside the Developer/Platform Owner workflow.
            </p>
            <div className="button-row wrap">
              <button className="secondary-button" type="button" onClick={onBackToDashboard}>
                Back to Developer Dashboard
              </button>
              <button className="primary-button" disabled={busyAction} type="submit">
                {busyAction ? 'Updating...' : 'Save report update'}
              </button>
            </div>
          </form>
        </article>
      </section>
    </DeveloperReportDetailShell>
  );

  async function handleUpdateStatus(event) {
    event.preventDefault();

    setBusyAction(true);
    setActionMessage('');
    setActionError('');

    const result = await updateReportStatus({
      internalNotes: statusForm.internalNotes,
      priority: statusForm.priority,
      reportId: report.id,
      reporterFeedback: statusForm.reporterFeedback,
      source: report.source,
      status: statusForm.status,
    });

    if (!result.ok) {
      setActionError(result.message);
      setBusyAction(false);
      return;
    }

    setActionMessage('Report status updated.');
    setBusyAction(false);
  }
}

function DeveloperReportDetailShell({
  children,
  onBackHome,
  onBackToDashboard,
  onBrowseExams,
  report,
}) {
  return (
    <section
      className="management-page developer-report-detail-page"
      aria-labelledby="developer-report-detail-heading"
    >
      <div className="management-page-header developer-report-detail-header">
        <div>
          <p className="eyebrow">Support report detail</p>
          <h2 id="developer-report-detail-heading">
            {report?.title || 'Developer report detail'}
          </h2>
          <p>
            Work through the saved report with full context, internal notes, and
            reporter-facing feedback in one spacious page.
          </p>
          {report ? (
            <div className="developer-report-card-heading">
              <span className="report-source-pill">{report.sourceLabel}</span>
              <span className={`assignment-progress-pill ${getStatusClass(report.status)}`}>
                {report.statusLabel}
              </span>
              <span className={`report-priority-badge ${report.priority}`}>
                {report.priorityLabel}
              </span>
            </div>
          ) : null}
        </div>
        <div className="button-row wrap">
          <button className="primary-button" type="button" onClick={onBackToDashboard}>
            Back to Developer Dashboard
          </button>
        </div>
      </div>
      {children}
    </section>
  );
}

function DetailFact({ label, value, wide = false }) {
  return (
    <div className={wide ? 'wide' : ''}>
      <dt>{label}</dt>
      <dd>{value || '-'}</dd>
    </div>
  );
}

function StatePanel({ note, title }) {
  return (
    <section className="management-empty-state">
      <h3>{title}</h3>
      <p>{note}</p>
    </section>
  );
}

function createMetadataRows(metadata = {}) {
  if (!metadata || typeof metadata !== 'object') {
    return [];
  }

  return [
    ['Category', metadata.feedbackCategory],
    ['Severity', metadata.feedbackSeverity],
    ['Result status', metadata.resultStatus],
    ['Item kind', metadata.itemKind],
    ['Domain', metadata.domain],
    ['Difficulty', metadata.difficulty],
    ['Case study', metadata.caseStudyTitle],
    ['PBQ points', metadata.pbqPoints],
  ]
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim())
    .map(([label, value]) => ({
      label,
      value: String(value),
    }));
}

function formatDate(value) {
  if (!value) {
    return 'Not available';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function getStatusClass(status) {
  if (status === 'resolved') {
    return 'ready';
  }

  if (status === 'dismissed') {
    return 'not-started';
  }

  if (status === 'in_review') {
    return 'almost-ready';
  }

  if (status === 'need_info') {
    return 'due-soon';
  }

  return 'needs-review';
}
