import { useMemo, useState } from 'react';

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

const sourceOptions = [
  { value: '', label: 'All sources' },
  { value: 'question_reports', label: 'Question reports' },
  { value: 'platform_issue_reports', label: 'Platform issues' },
];

const deletionStatusOptions = [
  { value: 'open', label: 'Open' },
  { value: 'in_review', label: 'In review' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const reportTypeOptions = [
  { value: '', label: 'All report types' },
  { value: 'question_issue', label: 'Question issue' },
  { value: 'platform_bug', label: 'Platform bug' },
  { value: 'result_issue', label: 'Result/report issue' },
  { value: 'access_issue', label: 'Access/account issue' },
  { value: 'other', label: 'Other' },
];

export default function DeveloperDashboardPage({
  onBackHome,
  onBrowseExams,
  onOpenReportDetail,
}) {
  const dashboard = useDeveloperDashboard();
  const {
    dashboardLoading,
    deletionRequests,
    deletionTotals,
    error,
    isAuthenticated,
    isPlatformOwner,
    isSupabaseConfigured,
    loading,
    memberships,
    refresh,
    reports,
    totals,
    updateDeletionRequestStatus,
  } = dashboard;
  const hasAccess = hasDeveloperDashboardAccess({ isPlatformOwner, memberships });
  const [filters, setFilters] = useState({
    priority: '',
    source: '',
    search: '',
    status: '',
    reportType: '',
  });
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyAction, setBusyAction] = useState(false);
  const [selectedDeletionRequestId, setSelectedDeletionRequestId] = useState('');
  const [deletionStatusForm, setDeletionStatusForm] = useState({
    status: 'in_review',
    adminNotes: '',
  });
  const filteredReports = useMemo(
    () => reports.filter((report) => matchesReportFilters(report, filters)),
    [filters, reports],
  );
  const selectedDeletionRequest = useMemo(
    () =>
      deletionRequests.find((request) => request.id === selectedDeletionRequestId) ??
      null,
    [deletionRequests, selectedDeletionRequestId],
  );

  if (!isSupabaseConfigured) {
    return (
      <DeveloperDashboardShell onBackHome={onBackHome} onBrowseExams={onBrowseExams}>
        <StatePanel
          title="Developer Dashboard is not configured here"
          note="This environment is running in frontend-only mode, so protected certification exams and saved report queues are unavailable."
        />
      </DeveloperDashboardShell>
    );
  }

  if (!isAuthenticated) {
    return (
      <DeveloperDashboardShell onBackHome={onBackHome} onBrowseExams={onBrowseExams}>
        <StatePanel
          title="Sign in to continue"
          note="Sign in with a Developer or Platform Owner account to view support queues. Protected certification exams require sign-in and access."
        />
      </DeveloperDashboardShell>
    );
  }

  if (loading && !hasAccess) {
    return (
      <DeveloperDashboardShell onBackHome={onBackHome} onBrowseExams={onBrowseExams}>
        <StatePanel
          title="Checking Developer Dashboard access..."
          note="CertSim is reading your profile and active memberships."
        />
      </DeveloperDashboardShell>
    );
  }

  if (!hasAccess) {
    return (
      <DeveloperDashboardShell onBackHome={onBackHome} onBrowseExams={onBrowseExams}>
        <StatePanel
          title="Developer Dashboard is not available for this account"
          note="This page is limited to active Developer and Platform Owner memberships. Normal exam access remains unchanged."
        />
      </DeveloperDashboardShell>
    );
  }

  return (
    <DeveloperDashboardShell onBackHome={onBackHome} onBrowseExams={onBrowseExams}>
      {error ? <p className="auth-panel-error">{error}</p> : null}
      {actionMessage ? <p className="auth-panel-success">{actionMessage}</p> : null}
      {actionError ? <p className="auth-panel-error">{actionError}</p> : null}

      <section className="management-summary-grid" aria-label="Developer queue summary">
        <SummaryTile label="Open" value={totals.open} onClick={() => updateFilter('status', 'open')} />
        <SummaryTile label="In review" value={totals.inReview} onClick={() => updateFilter('status', 'in_review')} />
        <SummaryTile label="Need info" value={totals.needInfo} onClick={() => updateFilter('status', 'need_info')} />
        <SummaryTile label="Resolved" value={totals.resolved} onClick={() => updateFilter('status', 'resolved')} />
        <SummaryTile label="Question reports" value={totals.questionReports} onClick={() => updateFilter('source', 'question_reports')} />
        <SummaryTile label="Platform issues" value={totals.platformIssues} onClick={() => updateFilter('source', 'platform_issue_reports')} />
        <SummaryTile label="Deletion requests" value={deletionTotals.total} />
      </section>

      <section className="management-card" aria-labelledby="developer-filters-heading">
        <div className="management-section-heading">
          <div>
            <h3 id="developer-filters-heading">Queue filters</h3>
            <p>
              Search saved question reports and platform issue reports. Developer
              access is for support and troubleshooting, not platform ownership.
            </p>
          </div>
          <button
            className="secondary-button"
            disabled={dashboardLoading}
            type="button"
            onClick={refresh}
          >
            {dashboardLoading ? 'Refreshing...' : 'Refresh queue'}
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() =>
              setFilters({
                priority: '',
                source: '',
                search: '',
                status: '',
                reportType: '',
              })
            }
          >
            Clear filters
          </button>
        </div>
        <div className="management-filter-grid">
          <label>
            <span>Search</span>
            <input
              type="search"
              value={filters.search}
              onChange={(event) => updateFilter('search', event.target.value)}
              placeholder="Search title, message, exam, question ID, or reporter"
            />
          </label>
          <label>
            <span>Status</span>
            <select
              value={filters.status}
              onChange={(event) => updateFilter('status', event.target.value)}
            >
              <option value="">All statuses</option>
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
              value={filters.priority}
              onChange={(event) => updateFilter('priority', event.target.value)}
            >
              <option value="">All priorities</option>
              {priorityOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Source</span>
            <select
              value={filters.source}
              onChange={(event) => updateFilter('source', event.target.value)}
            >
              {sourceOptions.map((option) => (
                <option key={option.value || 'all'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Report type</span>
            <select
              value={filters.reportType}
              onChange={(event) => updateFilter('reportType', event.target.value)}
            >
              {reportTypeOptions.map((option) => (
                <option key={option.value || 'all'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>

      <section className="management-card" aria-labelledby="developer-queue-heading">
        <div className="management-section-heading">
          <div>
            <h3 id="developer-queue-heading">Bug/question report queue</h3>
            <p>
              {filteredReports.length} of {reports.length} saved reports shown.
            </p>
          </div>
        </div>

        {filteredReports.length === 0 ? (
          <p className="auth-panel-muted">No saved reports match these filters.</p>
        ) : (
          <div className="developer-report-list">
            {filteredReports.map((report) => (
              <article className="developer-report-card" key={`${report.source}-${report.id}`}>
                <div className="developer-report-card-main">
                  <div className="developer-report-card-heading">
                    <span className="report-source-pill">{report.sourceLabel}</span>
                    <span className={`assignment-progress-pill ${getStatusClass(report.status)}`}>
                      {report.statusLabel}
                    </span>
                    <span className={`report-priority-badge ${report.priority}`}>
                      {report.priorityLabel}
                    </span>
                  </div>
                  <h4>{report.title}</h4>
                  <p>{report.message || 'No details were provided.'}</p>
                  <dl className="report-context-grid">
                    <Fact label="Type" value={report.reportTypeLabel} />
                    <Fact label="Context" value={formatContextLine(report)} />
                    <Fact
                      label="Reporter"
                      value={formatReporter(report.reporter)}
                    />
                    <Fact label="Submitted" value={formatDate(report.createdAt)} />
                    <Fact label="Updated" value={formatDate(report.updatedAt)} />
                  </dl>
                </div>
                <div className="developer-report-card-actions">
                  <button
                    className="primary-button compact-button"
                    type="button"
                    onClick={() => onOpenReportDetail?.(report.id)}
                  >
                    Open detail
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="management-card" aria-labelledby="account-deletion-queue-heading">
        <div className="management-section-heading">
          <div>
            <h3 id="account-deletion-queue-heading">Account deletion requests</h3>
            <p>
              Review account lifecycle requests. Hard auth deletion requires a secure backend/admin process and is not available from the frontend.
            </p>
          </div>
        </div>

        <div className="management-summary-grid compact-summary">
          <SummaryTile label="Open" value={deletionTotals.open} />
          <SummaryTile label="In review" value={deletionTotals.inReview} />
          <SummaryTile label="Completed" value={deletionTotals.completed} />
          <SummaryTile label="Cancelled" value={deletionTotals.cancelled} />
        </div>

        {deletionRequests.length === 0 ? (
          <p className="auth-panel-muted">No account deletion requests are recorded.</p>
        ) : (
          <div className="record-table-wrap">
            <table className="record-table">
              <thead>
                <tr>
                  <th>Requester</th>
                  <th>Status</th>
                  <th>Requested</th>
                  <th>Reason</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {deletionRequests.map((request) => (
                  <tr key={request.id}>
                    <td>
                      <strong>{request.profile?.displayName ?? 'Unknown user'}</strong>
                      <span className="table-subtext">
                        {request.emailSnapshot || request.profile?.email || 'Email unavailable'}
                      </span>
                    </td>
                    <td>
                      <span className={`assignment-progress-pill ${getStatusClass(request.status)}`}>
                        {request.statusLabel}
                      </span>
                    </td>
                    <td>{formatDate(request.requestedAt)}</td>
                    <td>{request.reason || 'No reason provided.'}</td>
                    <td>
                      <button
                        className="secondary-button compact"
                        type="button"
                        onClick={() => handleSelectDeletionRequest(request)}
                      >
                        Open detail
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selectedDeletionRequest ? (
        <section className="management-card" aria-labelledby="account-deletion-detail-heading">
          <div className="management-section-heading">
            <div>
              <h3 id="account-deletion-detail-heading">Account lifecycle request detail</h3>
              <p>
                Removing/deactivating account access must preserve historical
                results until a retention decision is made.
              </p>
            </div>
            <button
              className="secondary-button"
              type="button"
              onClick={() => setSelectedDeletionRequestId('')}
            >
              Close detail
            </button>
          </div>
          <dl className="account-facts two-column">
            <Fact
              label="Requester"
              value={selectedDeletionRequest.profile?.displayName ?? 'Unknown user'}
            />
            <Fact
              label="Email snapshot"
              value={selectedDeletionRequest.emailSnapshot || 'Not captured'}
            />
            <Fact label="Status" value={selectedDeletionRequest.statusLabel} />
            <Fact label="Requested" value={formatDate(selectedDeletionRequest.requestedAt)} />
            <Fact label="Reviewed" value={formatDate(selectedDeletionRequest.reviewedAt)} />
            <Fact
              label="Reviewer"
              value={selectedDeletionRequest.reviewer?.displayName || 'Not assigned'}
            />
          </dl>
          <div className="saved-result-detail-panel">
            <h4>Reason</h4>
            <p>{selectedDeletionRequest.reason || 'No reason was provided.'}</p>
          </div>
          <form className="management-form" onSubmit={handleUpdateDeletionRequest}>
            <label>
              <span>Status</span>
              <select
                value={deletionStatusForm.status}
                onChange={(event) =>
                  setDeletionStatusForm((current) => ({
                    ...current,
                    status: event.target.value,
                  }))
                }
              >
                {getDeletionStatusOptions(isPlatformOwner).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Developer/admin notes</span>
              <textarea
                rows="3"
                value={deletionStatusForm.adminNotes}
                onChange={(event) =>
                  setDeletionStatusForm((current) => ({
                    ...current,
                    adminNotes: event.target.value,
                  }))
                }
                placeholder="Record review notes without passwords, tokens, or private secrets."
              />
            </label>
            <button className="primary-button" disabled={busyAction} type="submit">
              {busyAction ? 'Updating...' : 'Update request'}
            </button>
          </form>
        </section>
      ) : null}

    </DeveloperDashboardShell>
  );

  function updateFilter(field, value) {
    setFilters((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function handleSelectDeletionRequest(request) {
    setSelectedDeletionRequestId(request.id);
    setDeletionStatusForm({
      status: request.status === 'open' ? 'in_review' : request.status,
      adminNotes: request.adminNotes ?? '',
    });
    setActionMessage('');
    setActionError('');
  }

  async function handleUpdateDeletionRequest(event) {
    event.preventDefault();

    if (!selectedDeletionRequest) {
      return;
    }

    setBusyAction(true);
    setActionMessage('');
    setActionError('');

    const result = await updateDeletionRequestStatus({
      adminNotes: deletionStatusForm.adminNotes,
      requestId: selectedDeletionRequest.id,
      status: deletionStatusForm.status,
    });

    if (!result.ok) {
      setActionError(result.message);
      setBusyAction(false);
      return;
    }

    setSelectedDeletionRequestId('');
    setActionMessage('Account deletion request updated.');
    setBusyAction(false);
  }
}

function DeveloperDashboardShell({ children, onBackHome, onBrowseExams }) {
  return (
    <section className="management-page" aria-labelledby="developer-dashboard-heading">
      <div className="management-page-header">
        <div>
          <p className="eyebrow">Support / debugging</p>
          <h2 id="developer-dashboard-heading">Developer Support Workbench</h2>
          <p>
            Triage saved platform and question reports, update reporter-visible
            feedback, and keep internal notes separate. Developer access is separate from Platform Owner access and does not manage billing, ownership, or security settings.
          </p>
        </div>
      </div>
      {children}
    </section>
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

function SummaryTile({ label, onClick, value }) {
  if (onClick) {
    return (
      <button className="summary-tile interactive" type="button" onClick={onClick}>
        <span>{label}</span>
        <strong>{value}</strong>
      </button>
    );
  }

  return (
    <article className="summary-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function Fact({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || '-'}</dd>
    </div>
  );
}

function matchesReportFilters(report, filters) {
  if (filters.status && report.status !== filters.status) {
    return false;
  }

  if (filters.priority && report.priority !== filters.priority) {
    return false;
  }

  if (filters.source && report.source !== filters.source) {
    return false;
  }

  if (filters.reportType && report.reportType !== filters.reportType) {
    return false;
  }

  const search = filters.search.trim().toLowerCase();

  if (!search) {
    return true;
  }

  return [
    report.title,
    report.message,
    report.examKey,
    report.questionId,
    report.routePath,
    report.reporter?.displayName,
    report.reporter?.email,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(search));
}

function formatContextLine(report) {
  const parts = [
    report.examKey ? `Exam: ${report.examKey}` : '',
    report.questionId ? `Question: ${report.questionId}` : '',
    report.attempt?.modeLabel ? `Mode: ${report.attempt.modeLabel}` : '',
  ].filter(Boolean);

  return parts.length > 0 ? parts.join(' | ') : 'No exam context linked';
}

function formatReporter(reporter) {
  if (!reporter) {
    return 'Unknown user';
  }

  return reporter.email
    ? `${reporter.displayName} (${reporter.email})`
    : reporter.displayName;
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
  if (status === 'resolved' || status === 'completed') {
    return 'ready';
  }

  if (status === 'dismissed' || status === 'cancelled') {
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

function getDeletionStatusOptions(isPlatformOwner) {
  return isPlatformOwner
    ? deletionStatusOptions
    : deletionStatusOptions.filter((option) =>
        ['open', 'in_review'].includes(option.value),
      );
}
