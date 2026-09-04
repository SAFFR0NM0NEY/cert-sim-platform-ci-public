import { useMemo } from 'react';

import useAssignmentProgress from '../../hooks/useAssignmentProgress.js';
import useTrainerDashboard from '../../hooks/useTrainerDashboard.js';
import { hasScopedPerformanceDashboardAccess } from '../../lib/roleUtils.js';
import {
  getTrainerAnalyticsSnapshot,
  READINESS_DISCLAIMER,
} from '../../lib/trainerAnalyticsService.js';
import {
  formatSavedRawPercentage,
  formatSavedResultDate,
  formatSavedResultMode,
  formatSavedResultScore,
  formatSavedResultStatus,
  getSavedResultBreakdownRows,
  getSavedResultDomainMissingMessage,
  getSavedResultDomainRows,
  getSavedResultWeakAreaRows,
} from '../../lib/savedResultFormatters.js';

export default function TrainerStudentDetailPage({
  onBackHome,
  onBackToDashboard,
  onBrowseExams,
  studentId = '',
} = {}) {
  const dashboard = useTrainerDashboard();
  const progressState = useAssignmentProgress({
    includeStudentProgress: false,
    includeTrainerProgress: true,
  });
  const {
    clearSelectedResult,
    dashboardLoading,
    detailLoading,
    error,
    groups,
    isAuthenticated,
    isPlatformOwner,
    isSupabaseConfigured,
    loadResultDetail,
    memberships,
    results,
    selectedResult,
    students,
  } = dashboard;
  const {
    error: progressError,
    progressLoading,
    refreshProgress,
    trainerAssignments,
  } = progressState;
  const hasTrainerAccess = hasScopedPerformanceDashboardAccess({
    isPlatformOwner,
    memberships,
  });
  const student = useMemo(
    () =>
      students.find(
        (candidate) =>
          candidate.userId === studentId || candidate.membershipId === studentId,
      ) ?? null,
    [studentId, students],
  );
  const studentResults = useMemo(
    () =>
      student
        ? results
            .filter((result) => result.userId === student.userId)
            .sort((left, right) => getTime(right.submittedAt) - getTime(left.submittedAt))
        : [],
    [results, student],
  );
  const studentAssignments = useMemo(
    () =>
      student
        ? trainerAssignments.filter((assignment) =>
            assignmentTargetsStudent(assignment, student),
          )
        : [],
    [student, trainerAssignments],
  );
  const studentAssessmentResults = useMemo(
    () => studentResults.filter((result) => result.analyticsEligible !== false),
    [studentResults],
  );
  const studentAnalytics = useMemo(
    () =>
      student
        ? getTrainerAnalyticsSnapshot({
            assignments: studentAssignments,
            groups,
            results: studentAssessmentResults,
            students: [student],
          })
        : null,
    [groups, student, studentAssignments, studentAssessmentResults],
  );
  const examProgress = studentAnalytics?.studentReadiness ?? [];
  const assignmentReadiness = studentAnalytics?.assignmentReadiness ?? [];

  if (!isSupabaseConfigured) {
    return (
      <TrainerStudentShell
        onBackHome={onBackHome}
        onBackToDashboard={onBackToDashboard}
        onBrowseExams={onBrowseExams}
      >
        <StatePanel
          title="Trainer student detail is not configured here"
          note="This environment is running in frontend-only mode. Trainer result visibility requires Supabase configuration."
        />
      </TrainerStudentShell>
    );
  }

  if (!isAuthenticated) {
    return (
      <TrainerStudentShell
        onBackHome={onBackHome}
        onBackToDashboard={onBackToDashboard}
        onBrowseExams={onBrowseExams}
      >
        <StatePanel
          title="Sign in to continue"
          note="Use a Trainer, scoped admin, or Platform Owner account to view scoped student progress."
        />
      </TrainerStudentShell>
    );
  }

  if ((dashboard.loading || dashboardLoading) && !hasTrainerAccess) {
    return (
      <TrainerStudentShell
        onBackHome={onBackHome}
        onBackToDashboard={onBackToDashboard}
        onBrowseExams={onBrowseExams}
      >
        <StatePanel
          title="Checking trainer access..."
          note="CertSim is reading your profile and memberships."
        />
      </TrainerStudentShell>
    );
  }

  if (!hasTrainerAccess) {
    return (
      <TrainerStudentShell
        onBackHome={onBackHome}
        onBackToDashboard={onBackToDashboard}
        onBrowseExams={onBrowseExams}
      >
        <StatePanel
          title="Student reports are not available for this account"
          note="This view is limited to active Trainer, scoped admin, and Platform Owner memberships. Normal exam access remains unchanged."
        />
      </TrainerStudentShell>
    );
  }

  return (
    <TrainerStudentShell
      onBackHome={onBackHome}
      onBackToDashboard={onBackToDashboard}
      onBrowseExams={onBrowseExams}
    >
      {error ? <p className="auth-panel-error">{error}</p> : null}
      {progressError ? <p className="auth-panel-error">{progressError}</p> : null}

      {!student && dashboardLoading ? (
        <StatePanel
          title="Loading student report..."
          note="CertSim is reading the trainer-scoped student list."
        />
      ) : null}

      {!student && !dashboardLoading ? (
        <StatePanel
          title="Student is not visible"
          note="This student was not found in your trainer scope, or the route no longer points to a visible membership."
        />
      ) : null}

      {student ? (
        <>
          <section className="account-card trainer-student-identity">
            <div className="account-profile-summary">
              <span className="account-avatar" aria-hidden="true">
                {getInitials(student.displayName)}
              </span>
              <span>
                <strong>{student.displayName || 'Student'}</strong>
                <small>{student.email || 'Email not recorded'}</small>
              </span>
            </div>
            <dl className="account-facts">
              <Fact label="Organisation" value={student.organisationName} />
              <Fact label="Campus" value={student.campusName} />
              <Fact label="Group/class" value={student.groupName} />
              <Fact label="Membership status" value={formatStatus(student.status)} />
            </dl>
            <div className="button-row wrap no-print">
              <button
                className="secondary-button compact-button"
                disabled={dashboardLoading || progressLoading}
                type="button"
                onClick={handleRefresh}
              >
                {dashboardLoading || progressLoading ? 'Refreshing...' : 'Refresh report'}
              </button>
            </div>
          </section>

          <p className="analytics-disclaimer">{READINESS_DISCLAIMER}</p>

          <section className="management-summary-grid" aria-label="Student report summary">
            <SummaryTile label="Saved attempts" value={studentResults.length} />
            <SummaryTile label="Assigned exams" value={studentAssignments.length} />
            <SummaryTile
              label="Exam rows"
              value={examProgress.filter((row) => row.examKey).length}
            />
            <SummaryTile
              label="Latest activity"
              value={formatDate(studentResults[0]?.submittedAt)}
            />
          </section>

          <section className="management-section" aria-labelledby="student-detail-assignments-heading">
            <h3 id="student-detail-assignments-heading">Assignment Summary</h3>
            <AssignmentSummaryList assignments={assignmentReadiness} />
          </section>

          <section className="management-section" aria-labelledby="student-detail-exams-heading">
            <h3 id="student-detail-exams-heading">Exam-by-Exam Progress</h3>
            <ExamProgressGrid
              detailLoading={detailLoading}
              rows={examProgress}
              onOpenResult={loadResultDetail}
            />
          </section>

          <section className="analytics-grid">
            <article className="analytics-card">
              <h4>Domain Performance</h4>
              <p>
                Older saved results may not include domain breakdowns. Newer
                saved results include domain and weak-area analytics when stored.
              </p>
              <DomainPerformanceList rows={examProgress} />
            </article>

            <article className="analytics-card">
              <h4>Recent Results</h4>
              <p>Open a result to inspect score, domains, weak areas, and saved summaries.</p>
              <TrainerResultList
                detailLoading={detailLoading}
                results={studentResults}
                onOpenResult={loadResultDetail}
              />
            </article>
          </section>

          {selectedResult ? (
            <TrainerResultDetail
              result={selectedResult}
              onClose={clearSelectedResult}
            />
          ) : null}
        </>
      ) : null}
    </TrainerStudentShell>
  );

  async function handleRefresh() {
    await Promise.all([dashboard.refresh(), refreshProgress()]);
  }
}

function TrainerStudentShell({
  children,
  onBackHome,
  onBackToDashboard,
  onBrowseExams,
}) {
  return (
    <section className="trainer-student-page" aria-labelledby="trainer-student-heading">
      <div className="view-toolbar no-print">
        <div>
          <p className="eyebrow">Trainer student report</p>
          <h2 id="trainer-student-heading">Student Progress Detail</h2>
        </div>
        <div className="button-row wrap">
          <button className="secondary-button" type="button" onClick={onBackToDashboard}>
            Back to Performance Dashboard
          </button>
        </div>
      </div>
      {children}
    </section>
  );
}

function AssignmentSummaryList({ assignments }) {
  if (assignments.length === 0) {
    return (
      <StatePanel
        title="No assigned exam summary"
        note="This student has no visible assigned exams in the current trainer scope."
      />
    );
  }

  return (
    <div className="analytics-card-grid">
      {assignments.map((assignment) => (
        <article
          className="analytics-summary-card"
          key={assignment.assignmentId || assignment.examTitle}
        >
          <div className="analytics-summary-card-header">
            <h5>{assignment.examTitle}</h5>
            <span>{assignment.totalStudents} assigned</span>
          </div>
          <div className="analytics-card-metrics">
            <MetricPill label="Ready" value={assignment.readyCount} />
            <MetricPill label="Needs review" value={assignment.needsReviewCount} />
            <MetricPill label="Not started" value={assignment.notStartedCount} />
            <MetricPill label="Overdue" value={assignment.overdueCount} />
            <MetricPill label="Due soon" value={assignment.dueSoonCount} />
            <MetricPill label="Avg score" value={formatScore(assignment.averageScore)} />
          </div>
          <p>
            Common weak domains: {formatDomainSummaryList(assignment.commonWeakDomains)}
          </p>
        </article>
      ))}
    </div>
  );
}

function ExamProgressGrid({ detailLoading, onOpenResult, rows }) {
  if (rows.length === 0) {
    return (
      <StatePanel
        title="No exam progress yet"
        note="Saved results or assigned exams are needed before exam-scoped readiness can be shown."
      />
    );
  }

  return (
    <div className="student-readiness-card-grid">
      {rows.map((row) => (
        <article
          className="student-readiness-card"
          key={`${row.userId}-${row.examScopeKey || row.examTitle}`}
        >
          <div className="student-readiness-card-header">
            <div>
              <h5>{row.examTitle}</h5>
              <p>{row.scopedAttemptCount} matching attempt{row.scopedAttemptCount === 1 ? '' : 's'}</p>
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
          </div>
          <div className="student-readiness-domain-summary">
            <span>
              <strong>Readiness reason</strong>
              {row.readinessReason}
            </span>
            <span>
              <strong>Readiness availability</strong>
              {row.scopedAttemptCount >= 5
                ? 'Full readiness available.'
                : `Need ${5 - row.scopedAttemptCount} more attempts for full readiness.`}
            </span>
          </div>
          <div className="student-readiness-actions">
            {row.latestAttemptId ? (
              <button
                className="secondary-button compact-button"
                disabled={detailLoading}
                type="button"
                onClick={() => onOpenResult(row.latestAttemptId)}
              >
                Open latest result
              </button>
            ) : (
              <span className="table-subtext">No matching saved result for this exam.</span>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}

function DomainPerformanceList({ rows }) {
  const rowsWithDomains = rows.filter((row) => (row.domainAverages ?? []).length > 0);

  if (rowsWithDomains.length === 0) {
    return (
      <StatePanel
        title="No stored domain data"
        note="Legacy saved results may not include domain breakdowns. Newer eligible saved results include domain analytics when available."
      />
    );
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

function TrainerResultList({ detailLoading, onOpenResult, results }) {
  if (results.length === 0) {
    return (
      <StatePanel
        title="No saved results"
        note="This student has no visible saved results in your trainer scope yet."
      />
    );
  }

  return (
    <ul className="saved-results-list full-page">
      {results.map((result) => (
        <li key={result.attemptId}>
          <button
            className="saved-result-item"
            disabled={detailLoading}
            type="button"
            onClick={() => onOpenResult(result.attemptId)}
          >
            <span className="saved-result-item-main">
              <strong>{result.examTitle}</strong>
              <small>{formatSavedResultMode(result)}</small>
              <small>{formatSavedResultDate(result.submittedAt)}</small>
            </span>
            <span className="saved-result-item-score">
              <strong>{formatSavedResultScore(result)}</strong>
              <small>{formatSavedRawPercentage(result)}</small>
              <small>{formatSavedResultStatus(result)}</small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function TrainerResultDetail({ onClose, result }) {
  const domainRows = getSavedResultDomainRows(result);
  const weakAreaRows = getSavedResultWeakAreaRows(result);
  const pbqRows = getSavedResultBreakdownRows(result.pbqBreakdown, 'PBQ');
  const caseStudyRows = getSavedResultBreakdownRows(
    result.caseStudyBreakdown,
    'Case study',
  );

  return (
    <section className="saved-result-detail-card trainer-student-result-detail">
      <div className="saved-result-detail-header">
        <div>
          <h3>{result.reportTitle || `${result.examTitle} saved result`}</h3>
          <p>
            {result.studentName || 'Student'} - {formatSavedResultMode(result)} -{' '}
            {formatSavedResultDate(result.submittedAt)}
          </p>
        </div>
        <button className="secondary-button compact-button" type="button" onClick={onClose}>
          Close result
        </button>
      </div>

      <dl className="saved-result-facts">
        <Fact label="Scaled score" value={formatSavedResultScore(result)} />
        <Fact label="Raw percentage" value={formatSavedRawPercentage(result)} />
        <Fact label="Result" value={formatSavedResultStatus(result)} />
        <Fact label="Responses" value={result.responseCount} />
      </dl>

      {domainRows.length > 0 ? (
        <SummaryRows
          rows={domainRows.map((domain) => ({
            label: domain.domain,
            score: domain.score,
            status: domain.percentage,
          }))}
          title="Domain breakdown"
        />
      ) : (
        <StatePanel
          title="Domain breakdown"
          note={getSavedResultDomainMissingMessage(result)}
        />
      )}

      {weakAreaRows.length > 0 ? (
        <SummaryRows
          rows={weakAreaRows.map((area) => ({
            label: area.label,
            status: area.detail || 'Review recommended',
          }))}
          title="Weak areas"
        />
      ) : (
        <StatePanel title="Weak areas" note="No stored weak areas below the configured threshold." />
      )}

      {pbqRows.length > 0 ? <SummaryRows rows={pbqRows} title="PBQ breakdown" /> : null}
      {caseStudyRows.length > 0 ? (
        <SummaryRows rows={caseStudyRows} title="Case-study breakdown" />
      ) : null}
    </section>
  );
}

function SummaryRows({ rows, title }) {
  return (
    <section className="saved-result-domains">
      <p className="auth-panel-title">{title}</p>
      <ul>
        {rows.map((row) => (
          <li key={`${title}-${row.label}-${row.status}-${row.score}`}>
            <span>{row.label}</span>
            {row.status ? <strong>{row.status}</strong> : null}
            {row.score ? <small>{row.score}</small> : null}
          </li>
        ))}
      </ul>
    </section>
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

function Fact({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || value === 0 ? value : 'Not recorded'}</dd>
    </div>
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

function assignmentTargetsStudent(assignment = {}, student = {}) {
  if (!student.userId) {
    return false;
  }

  if (assignment.studentUserId) {
    return assignment.studentUserId === student.userId;
  }

  if (assignment.groupId && assignment.groupId === student.groupId) {
    return true;
  }

  return (assignment.targetStudents ?? []).some(
    (targetStudent) => targetStudent.userId === student.userId,
  );
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

function formatDomainSummaryList(domains = []) {
  if (!Array.isArray(domains) || domains.length === 0) {
    return 'No weak-domain summary stored';
  }

  return domains
    .slice(0, 3)
    .map((domain) => {
      const label =
        domain.domainLabel ||
        domain.domain ||
        domain.label ||
        domain.domainId ||
        'Domain';
      const studentCount =
        domain.studentCount || domain.studentCount === 0
          ? `${domain.studentCount} students`
          : '';
      const average =
        domain.averagePercentage || domain.averagePercentage === 0
          ? `${formatPercentage(domain.averagePercentage)} avg`
          : '';

      return [label, studentCount, average].filter(Boolean).join(' - ');
    })
    .join('; ');
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

function formatStatus(value) {
  return String(value ?? '')
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ') || 'Not recorded';
}

function getInitials(name = '') {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');

  return initials || 'CS';
}

function getTime(value) {
  if (!value) {
    return 0;
  }

  const time = new Date(value).getTime();

  return Number.isNaN(time) ? 0 : time;
}
