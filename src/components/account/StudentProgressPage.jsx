import useStudentProgress from '../../hooks/useStudentProgress.js';
import {
  formatSavedRawPercentage,
  formatSavedResultDate,
  formatSavedResultMode,
  formatSavedResultScore,
  formatSavedResultStatus,
} from '../../lib/savedResultFormatters.js';

export default function StudentProgressPage({
  onBackHome,
  onBrowseExams,
  onOpenAccount,
  onOpenSavedResultDetail,
  onOpenSavedResults,
  onConfigureWeakAreaPractice,
} = {}) {
  const {
    assignmentsNeedingAttention,
    assessmentHistory,
    assignmentLoadWarning,
    authUnavailableReason,
    domainHistoryNote,
    error,
    examProgress,
    historyNote,
    isAuthenticated,
    isSupabaseConfigured,
    loading,
    progress,
    recentAttempts,
    refreshProgress,
    student,
  } = useStudentProgress();
  const friendlyAssignmentWarning =
    assignmentLoadWarning ||
    'Assignments could not be loaded, but saved progress is still shown.';

  if (!isSupabaseConfigured) {
    return (
      <StudentProgressShell
        onBackHome={onBackHome}
        onBrowseExams={onBrowseExams}
        onOpenAccount={onOpenAccount}
      >
        <StatePanel
          title="Progress history is not configured here"
          note="This environment is running in frontend-only mode, so protected certification exams and account progress are unavailable."
        />
        {authUnavailableReason ? (
          <p className="auth-panel-muted">{authUnavailableReason}</p>
        ) : null}
      </StudentProgressShell>
    );
  }

  if (!isAuthenticated) {
    return (
      <StudentProgressShell
        onBackHome={onBackHome}
        onBrowseExams={onBrowseExams}
        onOpenAccount={onOpenAccount}
      >
        <StatePanel
          title="Sign in to view My Progress"
          note="Sign in to access protected certification exams, Saved Results, readiness, Weak Area Practice, and assigned exam reminders."
        />
      </StudentProgressShell>
    );
  }

  return (
    <StudentProgressShell
      onBackHome={onBackHome}
      onBrowseExams={onBrowseExams}
      onOpenAccount={onOpenAccount}
    >
      {error ? <p className="auth-panel-error">{error}</p> : null}
      {assignmentLoadWarning ? (
        <p className="auth-panel-warning">{friendlyAssignmentWarning}</p>
      ) : null}

      <section className="student-progress-hero account-card">
        <div>
          <p className="auth-panel-title">
            {student?.displayName || 'Student progress'}
          </p>
          <p className="auth-panel-note">
            Readiness is calculated separately per exam. A strong result in one
            exam never makes another exam look ready.
          </p>
        </div>
        <button
          className="secondary-button compact-button"
          disabled={loading}
          type="button"
          onClick={refreshProgress}
        >
          {loading ? 'Refreshing...' : 'Refresh progress'}
        </button>
      </section>

      <p className="analytics-disclaimer">{progress.readinessDisclaimer}</p>
      <p className="saved-results-page-intro">{historyNote}</p>

      <section className="management-summary-grid student-progress-primary-summary" aria-label="Progress overview">
        <SummaryTile label="Exams attempted" value={progress.examsAttemptedCount} />
        <SummaryTile label="Latest assessment" value={formatScore(progress.latestScore)} />
        <SummaryTile label="Best assessment" value={formatScore(progress.bestScore)} />
        <SummaryTile label="Assessment pass rate" value={formatPercentage(progress.passRate)} />
      </section>

      <section className="management-section" aria-labelledby="student-exam-progress-heading">
        <div className="section-title-row">
          <div>
            <h3 id="student-exam-progress-heading">Exam Progress</h3>
            <p>
              Full readiness appears only after {progress.requiredAttempts} saved
              attempts for the same exam.
            </p>
          </div>
        </div>

        {loading && examProgress.length === 0 ? (
          <StatePanel title="Loading progress..." note="Reading your saved results and assigned exams." />
        ) : null}

        {!loading && examProgress.length === 0 ? (
          <StatePanel
            title="No saved exam progress yet"
            note="Complete an eligible full, compact, or sectioned scored exam while signed in to start building progress history."
          />
        ) : null}

        {examProgress.length > 0 ? (
          <div className="student-readiness-card-grid">
            {examProgress.map((row) => (
              <ExamProgressCard
                key={`${row.examScopeKey || row.examTitle}-${row.latestAttemptId || row.readinessStatus}`}
                row={row}
                onOpenLatestResult={onOpenSavedResultDetail}
                onConfigureWeakAreaPractice={onConfigureWeakAreaPractice}
              />
            ))}
          </div>
        ) : null}
      </section>

      <section className="analytics-grid">
        <article className="analytics-card">
          <h4>Domain Performance</h4>
          <p>{domainHistoryNote}</p>
          <DomainPerformanceList rows={examProgress} />
        </article>

        <article className="analytics-card">
          <h4>Assignments Needing Attention</h4>
          <p>
            Only saved attempts for the assigned exam count toward that
            assignment's readiness.
          </p>
          <AssignmentAttentionList assignments={assignmentsNeedingAttention} />
        </article>
      </section>

      <section className="management-section" aria-labelledby="student-recent-history-heading">
        <div className="section-title-row">
          <div>
            <h3 id="student-recent-history-heading">Recent activity</h3>
            <p>
              A compact account snapshot. Saved Results contains your complete
              protected and compatible pre-migration history.
            </p>
          </div>
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={onOpenSavedResults}
          >
            View all Saved Results
          </button>
        </div>
        <RecentAttemptsList
          attempts={recentAttempts}
          onOpenResult={onOpenSavedResultDetail}
        />
      </section>
    </StudentProgressShell>
  );
}

function StudentProgressShell({
  children,
  onBackHome,
  onBrowseExams,
  onOpenAccount,
}) {
  return (
    <section className="student-progress-page" aria-labelledby="student-progress-heading">
      <div className="view-toolbar no-print">
        <div>
          <p className="eyebrow">Account progress</p>
          <h2 id="student-progress-heading">My Progress</h2>
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

function ExamProgressCard({ onConfigureWeakAreaPractice, onOpenLatestResult, row }) {
  return (
    <article className="student-readiness-card">
      <div className="student-readiness-card-header">
        <div>
          <h5>{row.examTitle}</h5>
          <p>{row.scopedAttemptCount} saved attempt{row.scopedAttemptCount === 1 ? '' : 's'} for this exam</p>
        </div>
        <ReadinessBadge status={row.readinessStatus}>
          {row.readinessLabel}
        </ReadinessBadge>
      </div>

      <div className="student-readiness-metrics">
        <MetricPill label="Latest" value={formatScore(row.latestScore)} />
        <MetricPill label="Best" value={formatScore(row.bestScore)} />
        <MetricPill label="Average" value={formatScore(row.averageScore)} />
        <MetricPill label="Pass rate" value={formatPercentage(row.passRate)} />
        <MetricPill label="Last attempt" value={formatDate(row.latestAttemptDate)} />
        <MetricPill label="Weak domains" value={row.weakDomainCount} />
        <MetricPill label="Domain samples" value={`${row.domainSampleCount} of ${row.scopedAttemptCount}`} />
      </div>

      <div className="student-readiness-domain-summary">
        <span>
          <strong>Readiness availability</strong>
          {row.fullReadinessMessage}
        </span>
        <span>
          <strong>Readiness reason</strong>
          {row.readinessReason}
        </span>
      </div>

      <div className="student-readiness-domain-summary">
        <span>
          <strong>Weakest domain</strong>
          {row.weakestDomain ? formatDomainAverage(row.weakestDomain) : getNoDomainDataMessage()}
        </span>
        <span>
          <strong>Strongest domain</strong>
          {row.strongestDomain ? formatDomainAverage(row.strongestDomain) : getNoDomainDataMessage()}
        </span>
      </div>

      <div className="student-readiness-actions">
        {row.latestAttemptId ? (
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={() => onOpenLatestResult?.(row.latestAttemptId)}
          >
            Open latest result
          </button>
        ) : (
          <span className="table-subtext">No saved result for this exam yet.</span>
        )}
        {row.weakDomainCount > 0 ? (
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={() => onConfigureWeakAreaPractice?.(row.examKey)}
          >
            Start Weak Area Practice
          </button>
        ) : null}
      </div>
    </article>
  );
}

function AssessmentHistoryList({ attempts = [], onOpenResult }) {
  if (attempts.length === 0) {
    return <StatePanel title="No eligible assessments yet" note="Practice and unclassified activity do not affect assessment analytics." />;
  }

  return (
    <ol className="compact-detail-list student-assessment-history">
      {attempts.map((attempt) => (
        <li key={attempt.attemptId}>
          <button className="saved-result-item" type="button" onClick={() => onOpenResult?.(attempt.attemptId)}>
            <span className="saved-result-item-main">
              <strong>{attempt.examTitle}</strong>
              <small>{formatSavedResultMode(attempt)} · {formatSavedResultDate(attempt.submittedAt)}</small>
            </span>
            <span className="saved-result-item-score">
              <strong>{formatSavedResultScore(attempt)}</strong>
              <small>{attempt.source === 'legacy_authoritative' ? 'Pre-migration assessment' : 'Protected assessment'}</small>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function DomainPerformanceList({ rows }) {
  const rowsWithDomains = rows.filter((row) => (row.domainAverages ?? []).length > 0);

  if (rowsWithDomains.length === 0) {
    return <StatePanel title="No domain data yet" note={getNoDomainDataMessage()} />;
  }

  return (
    <div className="analytics-list-grid">
      {rowsWithDomains.map((row) => (
        <section className="analytics-mini-list" key={`${row.examScopeKey}-domains`}>
          <h5>{row.examTitle}</h5>
          <ul>
            {row.domainAverages.map((domain) => (
              <li key={domain.domainId || domain.domainLabel}>
                <strong>{formatDomainAverage(domain)}</strong>
                <span>{domain.samples} saved sample{domain.samples === 1 ? '' : 's'}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function AssignmentAttentionList({ assignments }) {
  if (assignments.length === 0) {
    return (
      <StatePanel
        title="No assignment attention items"
        note="Assigned exams appear here when they are overdue, due soon, not started, or submitted but not fully ready."
      />
    );
  }

  return (
    <ul className="compact-detail-list">
      {assignments.map((assignment) => (
        <li key={assignment.id || `${assignment.examTitle}-${assignment.dueAt}`}>
          <strong>{assignment.title || assignment.examTitle}</strong>
          <span className={`assignment-progress-pill ${assignment.status}`}>
            {assignment.statusLabel}
          </span>
          <span>
            {assignment.examTitle} | Attempts: {assignment.scopedAttemptCount} |
            Due: {formatDate(assignment.dueAt)}
          </span>
          <span>
            Latest: {formatScore(assignment.latestScore)} | Best: {formatScore(assignment.bestScore)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RecentAttemptsList({ attempts, onOpenResult }) {
  if (attempts.length === 0) {
    return (
      <StatePanel
        title="No saved activity yet"
        note="Cloud history begins after a signed-in eligible exam result is saved."
      />
    );
  }

  return (
    <ul className="saved-results-list full-page student-progress-history">
      {attempts.map((attempt) => (
        <li key={attempt.attemptId}>
          <button
            className="saved-result-item"
            type="button"
            onClick={() => onOpenResult?.(attempt.attemptId)}
          >
            <span className="saved-result-item-main">
              <strong>{attempt.examTitle}</strong>
              <small>{formatSavedResultMode(attempt)}</small>
              <small>{formatSavedResultDate(attempt.submittedAt)}</small>
            </span>
            <span className="saved-result-item-score">
              <strong>{formatSavedResultScore(attempt)}</strong>
              <small>{formatSavedRawPercentage(attempt)}</small>
              <small>{formatSavedResultStatus(attempt)}</small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function SummaryTile({ label, value }) {
  return (
    <article className="summary-tile">
      <span>{label}</span>
      <strong>{value || value === 0 ? value : 'Not recorded'}</strong>
    </article>
  );
}

function MetricPill({ label, value }) {
  return (
    <span className="analytics-metric-pill">
      {label}
      <strong>{value || value === 0 ? value : 'Not recorded'}</strong>
    </span>
  );
}

function ReadinessBadge({ children, status }) {
  return <span className={`readiness-badge ${status}`}>{children}</span>;
}

function StatePanel({ note, title }) {
  return (
    <section className="saved-results-state">
      <p className="auth-panel-title">{title}</p>
      <p className="auth-panel-muted">{note}</p>
    </section>
  );
}

function formatScore(value) {
  return value || value === 0 ? String(Math.round(Number(value))) : 'Not recorded';
}

function formatPercentage(value) {
  return value || value === 0 ? `${Math.round(Number(value))}%` : 'Not recorded';
}

function formatDate(value) {
  if (!value) {
    return 'Not recorded';
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function formatDomainAverage(domain = {}) {
  const label =
    domain.domainLabel ||
    domain.domain ||
    domain.label ||
    domain.domainId ||
    'Domain';
  const percentage = domain.averagePercentage ?? domain.percentage;

  return `${label}: ${formatPercentage(percentage)}`;
}

function getNoDomainDataMessage() {
  return 'No domain data is available for older saved results. Newer eligible results include domain breakdowns when the exam result provides them.';
}
