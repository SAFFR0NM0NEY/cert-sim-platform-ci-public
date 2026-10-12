import useMyReports from '../../hooks/useMyReports.js';

export default function MyReportsPage({
  onBackHome,
  onBrowseExams,
  onOpenAccount,
} = {}) {
  const {
    authUnavailableReason,
    error,
    isAuthenticated,
    isSupabaseConfigured,
    loading,
    refreshReports,
    reports,
  } = useMyReports();

  if (!isSupabaseConfigured) {
    return (
      <MyReportsShell
        onBackHome={onBackHome}
        onBrowseExams={onBrowseExams}
        onOpenAccount={onOpenAccount}
      >
        <StatePanel
          title="Saved reports are not configured here"
          note="This environment is running in frontend-only mode. You can still take exams, but saved report status needs Supabase configuration."
        />
        {authUnavailableReason ? (
          <p className="auth-panel-muted">{authUnavailableReason}</p>
        ) : null}
      </MyReportsShell>
    );
  }

  if (!isAuthenticated) {
    return (
      <MyReportsShell
        onBackHome={onBackHome}
        onBrowseExams={onBrowseExams}
        onOpenAccount={onOpenAccount}
      >
        <StatePanel
          title="Sign in to view My Reports"
          note="Sign in to access protected certification exams and report status linked to your account."
        />
      </MyReportsShell>
    );
  }

  return (
    <MyReportsShell
      onBackHome={onBackHome}
      onBrowseExams={onBrowseExams}
      onOpenAccount={onOpenAccount}
    >
      <section className="student-progress-hero account-card">
        <div>
          <p className="auth-panel-title">Report status</p>
          <p className="auth-panel-note">
            These are reports submitted from your account. Internal developer
            notes are not shown here; reporter feedback is written separately.
          </p>
        </div>
        <button
          className="secondary-button compact-button"
          disabled={loading}
          type="button"
          onClick={refreshReports}
        >
          {loading ? 'Refreshing...' : 'Refresh reports'}
        </button>
      </section>

      {error ? <p className="auth-panel-error">{error}</p> : null}

      {loading && reports.length === 0 ? (
        <StatePanel
          title="Loading reports..."
          note="Reading your saved report status."
        />
      ) : null}

      {!loading && reports.length === 0 ? (
        <StatePanel
          title="No reports submitted yet"
          note="When you submit an account issue or signed-in question report, its status will appear here."
        />
      ) : null}

      {reports.length > 0 ? (
        <section className="developer-report-list" aria-label="My report list">
          {reports.map((report) => (
            <article className="developer-report-card my-report-card" key={`${report.source}-${report.id}`}>
              <div className="developer-report-card-main">
                <div className="developer-report-card-heading">
                  <span className="report-source-pill">{report.sourceLabel}</span>
                  <span className={`assignment-progress-pill ${getStatusClass(report.status)}`}>
                    {report.reporterStatusLabel}
                  </span>
                  <span className={`report-priority-badge ${report.priority}`}>
                    {report.priorityLabel}
                  </span>
                </div>
                <h3>{report.title}</h3>
                <p>{report.message || 'No original message was recorded.'}</p>
                <dl className="report-context-grid">
                  <ReportFact label="Submitted" value={formatDate(report.createdAt)} />
                  <ReportFact label="Last updated" value={formatDate(report.updatedAt)} />
                  <ReportFact label="Exam" value={report.examTitle || report.examKey || 'Not linked'} />
                  <ReportFact label="Question" value={report.questionId || 'Not linked'} />
                </dl>
                <section className="reporter-feedback-panel">
                  <h4>Feedback from CertSim support</h4>
                  <p>
                    {report.reporterFeedback ||
                      'No feedback has been posted yet. Please check back later.'}
                  </p>
                </section>
              </div>
            </article>
          ))}
        </section>
      ) : null}
    </MyReportsShell>
  );
}

function MyReportsShell({
  children,
  onBackHome,
  onBrowseExams,
  onOpenAccount,
}) {
  return (
    <section className="management-page" aria-labelledby="my-reports-heading">
      <div className="management-page-header">
        <div>
          <p className="eyebrow">Account support</p>
          <h2 id="my-reports-heading">My Reports</h2>
          <p>
            Track the status of issue and question reports submitted from your
            account.
          </p>
        </div>
        <div className="button-row wrap">
          <button className="secondary-button" type="button" onClick={onOpenAccount}>
            Back to Account
          </button>
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

function ReportFact({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || '-'}</dd>
    </div>
  );
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
