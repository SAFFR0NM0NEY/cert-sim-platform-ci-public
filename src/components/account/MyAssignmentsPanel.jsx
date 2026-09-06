import useAssignmentProgress from '../../hooks/useAssignmentProgress.js';

export default function MyAssignmentsPanel() {
  const {
    error,
    progressLoading,
    progressRefreshing,
    authUnavailableReason,
    isAuthenticated,
    isSupabaseConfigured,
    refreshProgress,
    studentAssignments,
  } = useAssignmentProgress({
    includeStudentProgress: true,
    includeTrainerProgress: false,
  });

  if (!isSupabaseConfigured) {
    return (
      <section className="saved-results-panel unavailable" aria-label="My assigned exams">
        <MyAssignmentsHeader />
        <p className="auth-panel-muted">
          Protected exam assignments are not configured in this environment yet.
        </p>
        {authUnavailableReason ? (
          <p className="auth-panel-muted">{authUnavailableReason}</p>
        ) : null}
      </section>
    );
  }

  if (!isAuthenticated) {
    return (
      <section className="saved-results-panel signed-out" aria-label="My assigned exams">
        <MyAssignmentsHeader />
        <p className="auth-panel-muted">
          Sign in to view assignments and access protected certification exams.
        </p>
      </section>
    );
  }

  return (
    <section
      className="saved-results-panel"
      aria-label="My assigned exams"
      aria-busy={progressLoading || progressRefreshing}
    >
      <div className="saved-results-header">
        <MyAssignmentsHeader />
        <button
          className="auth-panel-toggle"
          disabled={progressLoading || progressRefreshing}
          type="button"
          onClick={refreshProgress}
        >
          {progressLoading || progressRefreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {error ? (
        <div className="saved-results-state error" role="alert">
          <p className="auth-panel-error">{error}</p>
          <button className="auth-panel-toggle" type="button" onClick={refreshProgress}>
            Retry
          </button>
        </div>
      ) : null}

      {progressLoading && studentAssignments.length === 0 ? (
        <section className="saved-results-state loading" aria-label="Loading assignments">
          <p className="auth-panel-title">Loading assigned exams...</p>
          <p className="auth-panel-muted">
            CertSim is reading assignments and matching saved results.
          </p>
        </section>
      ) : null}

      {!progressLoading && !error && studentAssignments.length === 0 ? (
        <section className="saved-results-state empty" aria-label="No assigned exams">
          <p className="auth-panel-title">No assigned exams yet</p>
          <p className="auth-panel-muted">
            Assigned exams will appear here after a trainer or Platform Owner
            creates them. You can still browse and start available exams.
          </p>
        </section>
      ) : null}

      {studentAssignments.length > 0 ? (
        <ul className="saved-results-list">
          {studentAssignments.map((assignment) => (
            <li key={assignment.id}>
              <article className="saved-result-item static">
                <span className="saved-result-item-main">
                  <strong>{assignment.title}</strong>
                  <small>{assignment.examTitle}</small>
                  <small>{assignment.instructions || 'No extra instructions.'}</small>
                  {assignment.latestResult ? (
                    <small>
                      Latest result: {formatScore(assignment.latestResult)} -{' '}
                      {formatDate(assignment.latestResult.submittedAt)}
                    </small>
                  ) : null}
                </span>
                <span className="saved-result-item-score">
                  <strong
                    className={`assignment-progress-pill ${assignment.progressStatus}`}
                  >
                    {assignment.progressLabel}
                  </strong>
                  <small>{formatDueDate(assignment.dueAt)}</small>
                  {assignment.attemptsRemaining != null ? (
                    <small>
                      Attempts used: {assignment.attemptsUsed} · Remaining: {assignment.attemptsRemaining}
                    </small>
                  ) : null}
                  <small>{assignment.targetLabel || assignment.scopeLabel}</small>
                  {assignment.savedResultRoute ? (
                    <a className="auth-panel-link" href={assignment.savedResultRoute}>
                      Open saved result
                    </a>
                  ) : null}
                  {assignment.examRoute ? (
                    <a className="auth-panel-link" href={assignment.examRoute}>
                      Start exam
                    </a>
                  ) : null}
                </span>
              </article>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function MyAssignmentsHeader() {
  return (
    <div>
      <p className="auth-panel-title">My assigned exams</p>
      <p className="auth-panel-note">
        Assignments can grant exam access. Other exams require a valid entitlement,
        such as a purchase, and assignment dates govern new assigned starts.
      </p>
    </div>
  );
}

function formatDueDate(value) {
  if (!value) {
    return 'No due date';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return `Due ${date.toLocaleString()}`;
}

function formatDate(value) {
  if (!value) {
    return 'Not recorded';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return date.toLocaleString();
}

function formatScore(result = {}) {
  if (result.scaledScore || result.scaledScore === 0) {
    return `${result.scaledScore}${result.passed === false ? ' needs review' : ''}`;
  }

  if (result.rawPercentage || result.rawPercentage === 0) {
    return `${Math.round(Number(result.rawPercentage))}%`;
  }

  return result.passed === true ? 'Passed' : 'Saved';
}
