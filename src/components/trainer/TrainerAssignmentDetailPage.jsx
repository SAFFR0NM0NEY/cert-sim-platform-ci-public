import { useCallback, useEffect, useMemo, useState } from 'react';

import useExamAssignments from '../../hooks/useExamAssignments.js';
import { getTrainerStudentResultDetail } from '../../lib/trainerDashboardService.js';
import { ASSIGNMENT_STATUSES } from '../../lib/examAssignmentService.js';
import { hasScopedPerformanceDashboardAccess } from '../../lib/roleUtils.js';
import { READINESS_DISCLAIMER } from '../../lib/trainerAnalyticsService.js';
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

const emptyDetail = {
  assignedStudents: [],
  assignment: null,
  matchingResults: [],
  readinessSummary: null,
};

export default function TrainerAssignmentDetailPage({
  assignmentId = '',
  onBackHome,
  onBackToDashboard,
  onBrowseExams,
  onOpenStudentReport,
} = {}) {
  const assignmentState = useExamAssignments({
    includeMyAssignments: false,
    includeTrainerScope: false,
  });
  const {
    assignmentError,
    assignmentLoading,
    getAssignmentStudentProgress,
    isAuthenticated,
    isPlatformOwner,
    isSupabaseConfigured,
    memberships,
    updateAssignmentDetails,
  } = assignmentState;
  const [detail, setDetail] = useState(emptyDetail);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  const [selectedResult, setSelectedResult] = useState(null);
  const [resultLoading, setResultLoading] = useState(false);
  const [editForm, setEditForm] = useState(createEmptyEditForm);
  const hasTrainerAccess = hasScopedPerformanceDashboardAccess({
    isPlatformOwner,
    memberships,
  });
  const assignment = detail.assignment;
  const summary = detail.readinessSummary;
  const studentRows = useMemo(
    () =>
      Array.isArray(summary?.studentRows)
        ? summary.studentRows
        : detail.assignedStudents,
    [detail.assignedStudents, summary],
  );
  const summaryCounts = useMemo(
    () => createSummaryCounts(summary, studentRows),
    [studentRows, summary],
  );

  const loadDetail = useCallback(async () => {
    if (!assignmentId || !isSupabaseConfigured || !isAuthenticated) {
      return;
    }

    setDetailLoading(true);
    setDetailError('');
    const result = await getAssignmentStudentProgress(assignmentId);

    if (result.ok) {
      setDetail(result.data ?? emptyDetail);
      setEditForm(createEditForm(result.data?.assignment));
    } else {
      setDetail(emptyDetail);
      setDetailError(result.message);
    }

    setDetailLoading(false);
  }, [
    assignmentId,
    getAssignmentStudentProgress,
    isAuthenticated,
    isSupabaseConfigured,
  ]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  if (!isSupabaseConfigured) {
    return (
      <TrainerAssignmentShell
        onBackHome={onBackHome}
        onBackToDashboard={onBackToDashboard}
        onBrowseExams={onBrowseExams}
      >
        <StatePanel
          title="Assignment detail is not configured here"
          note="This environment is running in frontend-only mode. Trainer assignment detail requires Supabase configuration."
        />
      </TrainerAssignmentShell>
    );
  }

  if (!isAuthenticated) {
    return (
      <TrainerAssignmentShell
        onBackHome={onBackHome}
        onBackToDashboard={onBackToDashboard}
        onBrowseExams={onBrowseExams}
      >
        <StatePanel
          title="Sign in to continue"
          note="Sign in with a Trainer, scoped admin, or Platform Owner account to view assignment detail. Protected certification exams require sign-in and access."
        />
      </TrainerAssignmentShell>
    );
  }

  if ((assignmentLoading || detailLoading) && !hasTrainerAccess) {
    return (
      <TrainerAssignmentShell
        onBackHome={onBackHome}
        onBackToDashboard={onBackToDashboard}
        onBrowseExams={onBrowseExams}
      >
        <StatePanel
          title="Checking trainer access..."
          note="CertSim is reading your profile and memberships."
        />
      </TrainerAssignmentShell>
    );
  }

  if (!hasTrainerAccess) {
    return (
      <TrainerAssignmentShell
        onBackHome={onBackHome}
        onBackToDashboard={onBackToDashboard}
        onBrowseExams={onBrowseExams}
      >
        <StatePanel
          title="Assignment detail is not available for this account"
          note="This view is limited to active Trainer, scoped admin, and Platform Owner memberships. Normal exam access remains unchanged."
        />
      </TrainerAssignmentShell>
    );
  }

  return (
    <TrainerAssignmentShell
      onBackHome={onBackHome}
      onBackToDashboard={onBackToDashboard}
      onBrowseExams={onBrowseExams}
    >
      {assignmentError ? <p className="auth-panel-error">{assignmentError}</p> : null}
      {detailError ? <p className="auth-panel-error">{detailError}</p> : null}
      {actionMessage ? <p className="auth-panel-success">{actionMessage}</p> : null}
      {actionError ? <p className="auth-panel-error">{actionError}</p> : null}

      {!assignment && detailLoading ? (
        <StatePanel
          title="Loading assignment detail..."
          note="CertSim is reading the assignment, scoped students, and saved result summaries."
        />
      ) : null}

      {!assignment && !detailLoading ? (
        <StatePanel
          title="Assignment is not visible"
          note="This assignment was not found in your trainer scope, or the route no longer points to a visible assignment."
        />
      ) : null}

      {assignment ? (
        <>
          <section className="account-card trainer-assignment-hero">
            <div>
              <p className="eyebrow">Assignment detail</p>
              <h2>{assignment.title || 'Untitled assignment'}</h2>
              <p>
                {formatExamCode(assignment)} - {assignment.examTitle}
              </p>
            </div>
            <span className={`assignment-progress-pill ${assignment.status}`}>
              {formatStatus(assignment.status)}
            </span>
          </section>

          <section className="account-card">
            <div className="saved-result-detail-header">
              <div>
                <h3>Assignment Summary</h3>
                <p>
                  Available from controls when new starts can begin. The due date,
                  closing, or archiving stops new assignment starts; an attempt
                  already started while valid may continue only on its original server timer.
                </p>
              </div>
              <button
                className="secondary-button compact-button no-print"
                disabled={detailLoading}
                type="button"
                onClick={loadDetail}
              >
                {detailLoading ? 'Refreshing...' : 'Refresh detail'}
              </button>
            </div>
            <dl className="saved-result-facts">
              <Fact label="Exam" value={`${formatExamCode(assignment)} - ${assignment.examTitle}`} />
              <Fact label="Target" value={assignment.targetLabel} />
              <Fact label="Target type" value={formatStatus(assignment.targetType)} />
              <Fact label="Assigned by" value={assignment.assignedByName} />
              <Fact label="Created" value={formatDate(assignment.createdAt)} />
              <Fact label="Available from" value={formatDate(assignment.availableFrom)} />
              <Fact label="Due date" value={formatDate(assignment.dueAt)} />
              <Fact label="Status" value={formatStatus(assignment.status)} />
            </dl>
            <div className="assignment-instructions">
              <strong>Instructions</strong>
              <p>{assignment.instructions || 'No extra instructions recorded.'}</p>
            </div>
          </section>

          <p className="analytics-disclaimer">{READINESS_DISCLAIMER}</p>

          <section className="management-summary-grid" aria-label="Assignment readiness summary">
            <SummaryTile label="Assigned students" value={summaryCounts.totalStudents} />
            <SummaryTile label="Ready" value={summaryCounts.readyCount} />
            <SummaryTile label="Almost ready" value={summaryCounts.almostReadyCount} />
            <SummaryTile label="Needs review" value={summaryCounts.needsReviewCount} />
            <SummaryTile label="Not started" value={summaryCounts.notStartedCount} />
            <SummaryTile label="Overdue" value={summaryCounts.overdueCount} />
            <SummaryTile label="Due soon" value={summaryCounts.dueSoonCount} />
            <SummaryTile label="Avg score" value={formatScore(summaryCounts.averageScore)} />
          </section>

          <section className="analytics-grid">
            <article className="analytics-card">
              <h3>Common Weak Domains</h3>
              <p>{formatDomainSummaryList(summary?.commonWeakDomains)}</p>
            </article>
            <article className="analytics-card">
              <h3>Saved Result Scope</h3>
              <p>
                This page uses saved results for {formatExamCode(assignment)} only.
                Results from other exams are activity context, not assignment readiness.
              </p>
            </article>
          </section>

          <section className="management-section" aria-labelledby="assignment-students-heading">
            <h3 id="assignment-students-heading">Student Progress</h3>
            <StudentProgressList
              resultLoading={resultLoading}
              rows={studentRows}
              onOpenResult={handleOpenResult}
              onOpenStudentReport={onOpenStudentReport}
            />
          </section>

          <section className="management-section no-print" aria-labelledby="assignment-edit-heading">
            <h3 id="assignment-edit-heading">Assignment Management</h3>
            <p className="auth-panel-muted">
              Available from and due date control the assignment's new-start window.
              Closing or archiving also stops new starts without pausing an active timer.
            </p>
            <form className="assignment-detail-form" onSubmit={handleSave}>
              <label>
                Title
                <input
                  required
                  value={editForm.title}
                  onChange={(event) =>
                    setEditForm((current) => ({
                      ...current,
                      title: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Status
                <select
                  value={editForm.status}
                  onChange={(event) =>
                    setEditForm((current) => ({
                      ...current,
                      status: event.target.value,
                    }))
                  }
                >
                  {ASSIGNMENT_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {formatStatus(status)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Available from
                <input
                  type="datetime-local"
                  value={editForm.availableFrom}
                  onChange={(event) =>
                    setEditForm((current) => ({
                      ...current,
                      availableFrom: event.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Due date
                <input
                  type="datetime-local"
                  value={editForm.dueAt}
                  onChange={(event) =>
                    setEditForm((current) => ({
                      ...current,
                      dueAt: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="assignment-detail-form-wide">
                Instructions
                <textarea
                  rows="4"
                  value={editForm.instructions}
                  onChange={(event) =>
                    setEditForm((current) => ({
                      ...current,
                      instructions: event.target.value,
                    }))
                  }
                />
              </label>
              <div className="button-row wrap assignment-detail-form-wide">
                <button className="primary-button" disabled={saving} type="submit">
                  {saving ? 'Saving...' : 'Save assignment'}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setEditForm(createEditForm(assignment))}
                >
                  Reset form
                </button>
              </div>
            </form>
          </section>

          {selectedResult ? (
            <TrainerAssignmentResultDetail
              result={selectedResult}
              onClose={() => setSelectedResult(null)}
            />
          ) : null}
        </>
      ) : null}
    </TrainerAssignmentShell>
  );

  async function handleSave(event) {
    event.preventDefault();
    setSaving(true);
    setActionMessage('');
    setActionError('');

    const result = await updateAssignmentDetails(assignmentId, editForm);

    if (result.ok) {
      setActionMessage('Assignment updated.');
      await loadDetail();
    } else {
      setActionError(result.message);
    }

    setSaving(false);
  }

  async function handleOpenResult(attemptId) {
    if (!attemptId) {
      return;
    }

    setResultLoading(true);
    const result = await getTrainerStudentResultDetail(attemptId);

    if (result.ok) {
      setSelectedResult(result.data);
      setActionError('');
    } else {
      setSelectedResult(null);
      setActionError(result.message);
    }

    setResultLoading(false);
  }
}

function TrainerAssignmentShell({
  children,
  onBackHome,
  onBackToDashboard,
  onBrowseExams,
}) {
  return (
    <section className="trainer-assignment-page" aria-labelledby="trainer-assignment-heading">
      <div className="view-toolbar no-print">
        <div>
          <p className="eyebrow">Trainer assignment</p>
          <h2 id="trainer-assignment-heading">Assignment Detail</h2>
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

function StudentProgressList({
  onOpenResult,
  onOpenStudentReport,
  resultLoading,
  rows,
}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return (
      <StatePanel
        title="No assigned students"
        note="This assignment does not currently resolve to visible students in your scope."
      />
    );
  }

  return (
    <div className="assignment-student-card-list">
      {rows.map((student) => {
        const latestAttemptId =
          student.latestAttemptId || student.latestResult?.attemptId || '';

        return (
          <article
            className="assignment-student-card"
            key={student.userId || student.displayName}
          >
            <div className="assignment-student-card-header">
              <div>
                <h4>{student.displayName || 'Student'}</h4>
                <p>{student.email || 'Email not recorded'}</p>
              </div>
              <span
                className={`assignment-progress-pill ${
                  student.assignmentStatus?.status || student.readinessStatus || 'not-started'
                }`}
              >
                {student.assignmentStatus?.label || student.readinessLabel || 'Not started'}
              </span>
            </div>
            <dl className="assignment-student-metrics">
              <Fact label="Attempts" value={student.scopedAttemptCount ?? 0} />
              <Fact label="Latest score" value={formatScore(student.latestScore)} />
              <Fact label="Best score" value={formatScore(student.bestScore)} />
              <Fact label="Average score" value={formatScore(student.averageScore)} />
              <Fact label="Last attempt" value={formatDate(student.latestAttemptDate)} />
              <Fact
                label="Weakest domain"
                value={
                  student.weakestDomain
                    ? formatDomainAverage(student.weakestDomain)
                    : 'No stored domain data'
                }
              />
            </dl>
            <div className="button-row wrap no-print">
              {latestAttemptId ? (
                <button
                  className="secondary-button compact-button"
                  disabled={resultLoading}
                  type="button"
                  onClick={() => onOpenResult(latestAttemptId)}
                >
                  Open latest result
                </button>
              ) : (
                <span className="table-subtext">No matching saved result yet.</span>
              )}
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => onOpenStudentReport?.(student.userId)}
              >
                Open student report
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function TrainerAssignmentResultDetail({ onClose, result }) {
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
      ) : null}
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

function Fact({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || value === 0 ? value : 'Not recorded'}</dd>
    </div>
  );
}

function StatePanel({ note, title }) {
  return (
    <section className="saved-results-state">
      <p className="auth-panel-title">{title}</p>
      <p className="auth-panel-muted">{note}</p>
    </section>
  );
}

function createEmptyEditForm() {
  return {
    availableFrom: '',
    dueAt: '',
    instructions: '',
    status: 'active',
    title: '',
  };
}

function createEditForm(assignment = {}) {
  return {
    availableFrom: toDateTimeInputValue(assignment.availableFrom),
    dueAt: toDateTimeInputValue(assignment.dueAt),
    instructions: assignment.instructions || '',
    status: assignment.status || 'active',
    title: assignment.title || '',
  };
}

function createSummaryCounts(summary = {}, studentRows = []) {
  return {
    almostReadyCount: studentRows.filter(
      (student) => student.readinessStatus === 'almost-ready',
    ).length,
    averageScore: summary?.averageScore ?? null,
    dueSoonCount: summary?.dueSoonCount ?? 0,
    needsReviewCount: summary?.needsReviewCount ?? 0,
    notStartedCount: summary?.notStartedCount ?? 0,
    overdueCount: summary?.overdueCount ?? 0,
    readyCount: summary?.readyCount ?? 0,
    totalStudents: summary?.totalStudents ?? studentRows.length,
  };
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
    return 'No weak-domain summary stored for this assignment yet.';
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

function formatExamCode(assignment = {}) {
  const examKey = String(assignment.examKey || assignment.examSlug || '')
    .trim()
    .toLowerCase();

  if (examKey === 'az204') {
    return 'AZ-204';
  }

  if (examKey === 'az400') {
    return 'AZ-400';
  }

  if (examKey === 'ai901') {
    return 'AI-901';
  }

  if (examKey === 'security-plus') {
    return 'Security+';
  }

  const title = String(assignment.examTitle ?? '').trim();
  const codeMatch = title.match(/\b(AZ-\d{3}|AI-\d{3}|Security\+|SY0-\d{3})\b/i);

  return codeMatch ? codeMatch[1].toUpperCase().replace('SECURITY+', 'Security+') : title || 'Exam';
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

function toDateTimeInputValue(value) {
  if (!value) {
    return '';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);

  return localDate.toISOString().slice(0, 16);
}
