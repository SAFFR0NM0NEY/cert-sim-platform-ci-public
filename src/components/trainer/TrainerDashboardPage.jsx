import { useEffect, useMemo, useState } from 'react';

import useExamAssignments from '../../hooks/useExamAssignments.js';
import useAssignmentProgress from '../../hooks/useAssignmentProgress.js';
import useTrainerAnalytics from '../../hooks/useTrainerAnalytics.js';
import useTrainerDashboard from '../../hooks/useTrainerDashboard.js';
import useTrainerScope from '../../hooks/useTrainerScope.js';
import useTrainerScopeOptions from '../../hooks/useTrainerScopeOptions.js';
import { getRoleLabel } from '../../lib/roleUtils.js';
import {
  READINESS_DISCLAIMER,
  READINESS_STATUSES,
} from '../../lib/trainerAnalyticsService.js';
import { hasScopedPerformanceDashboardAccess } from '../../lib/roleUtils.js';
import SearchableProfilePicker from '../shared/SearchableProfilePicker.jsx';
import { dashboardSummaryValue } from '../../lib/trainerDashboardSnapshot.js';
import { EMPTY_TRAINER_FILTERS, trainerFiltersEqual, updateDraftScopeFilter } from '../../lib/trainerFilterDraft.js';
import { getExamDisplayLabel } from '../../exams/examDisplayMetadata.js';

const initialGroupAssignmentForm = {
  examCatalogId: '',
  groupId: '',
  title: '',
  instructions: '',
  dueAt: '',
};

const initialStudentAssignmentForm = {
  examCatalogId: '',
  studentMembershipId: '',
  title: '',
  instructions: '',
  dueAt: '',
};

const initialStudentDisplayForm = {
  profileId: '',
  displayName: '',
};

export default function TrainerDashboardPage({
  activeSection = 'overview',
  onBackHome,
  onBrowseExams,
  onNavigateSection,
  onOpenAssignment,
  onOpenStudentReport,
  resultAttemptId = '',
}) {
  const dashboard = useTrainerDashboard({ enabled: ['overview', 'analytics', 'students', 'results', 'detail'].includes(activeSection) });
  const assignmentState = useExamAssignments({
    enabled: ['overview', 'analytics', 'assignments'].includes(activeSection),
    includeMyAssignments: false,
    includeTrainerScope: true,
  });
  const progressState = useAssignmentProgress({
    enabled: ['overview', 'analytics', 'assignments'].includes(activeSection),
    includeStudentProgress: false,
    includeTrainerProgress: true,
  });
  const {
    dashboardLoading,
    detailLoading,
    error,
    groups,
    isAuthenticated,
    isPlatformOwner,
    isSupabaseConfigured,
    loadResultDetail,
    membershipLabels,
    memberships,
    primaryRole,
    refresh,
    resultsRange,
    sectionErrors,
    selectedResult,
    setResultsRange,
    students,
    clearSelectedResult,
    updateStudentDisplayName,
  } = dashboard;
  useEffect(() => {
    if (isAuthenticated && activeSection === 'detail' && resultAttemptId) loadResultDetail(resultAttemptId);
  }, [activeSection, isAuthenticated, loadResultDetail, resultAttemptId]);
  const {
    assignableExams,
    assignmentError,
    assignmentLoading,
    createGroupAssignment,
    createStudentAssignment,
    refreshAssignments,
  } = assignmentState;
  const {
    error: progressError,
    progressLoading,
    refreshProgress,
    trainerAssignments: trackedAssignments,
  } = progressState;
  const [groupAssignmentForm, setGroupAssignmentForm] = useState(
    initialGroupAssignmentForm,
  );
  const [studentAssignmentForm, setStudentAssignmentForm] = useState(
    initialStudentAssignmentForm,
  );
  const [studentDisplayForm, setStudentDisplayForm] = useState(
    initialStudentDisplayForm,
  );
  const [assignmentActionMessage, setAssignmentActionMessage] = useState('');
  const [assignmentActionError, setAssignmentActionError] = useState('');
  const [busyAssignmentAction, setBusyAssignmentAction] = useState('');
  const initialTrainerFilters = useMemo(() => readTrainerFiltersFromUrl(EMPTY_TRAINER_FILTERS), []);
  const [trainerFilters, setTrainerFilters] = useState(initialTrainerFilters);
  const [draftFilters, setDraftFilters] = useState(initialTrainerFilters);
  const activeTrainerSection = activeSection;
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams();
    const urlKeys = { organisationId: 'organisation', campusId: 'campus', groupId: 'group', assignmentId: 'assignment', examKey: 'exam', progressStatus: 'progress', readinessStatus: 'readiness', resultStatus: 'status', search: 'q' };
    Object.entries(urlKeys).forEach(([key, urlKey]) => { if (trainerFilters[key]) params.set(urlKey, trainerFilters[key]); });
    const query = params.toString();
    window.history.replaceState({ ...window.history.state, trainerFilters }, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }, [trainerFilters]);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const restoreAppliedFilters = () => {
      const restored = readTrainerFiltersFromUrl(initialTrainerFilters);
      setTrainerFilters(restored);
      setDraftFilters(restored);
    };
    window.addEventListener('popstate', restoreAppliedFilters);
    return () => window.removeEventListener('popstate', restoreAppliedFilters);
  }, [initialTrainerFilters]);
  const hasTrainerAccess = hasScopedPerformanceDashboardAccess({
    isPlatformOwner,
    memberships,
  });
  const scopeOptions = useTrainerScopeOptions(draftFilters.organisationId, {
    enabled: ['overview', 'analytics', 'assignments', 'students', 'results', 'detail'].includes(activeSection),
  });
  useEffect(() => {
    if (trainerFilters.organisationId || scopeOptions.loading) return;
    const organisationId = scopeOptions.selection?.organisationId || scopeOptions.organisations?.[0]?.id || '';
    if (!organisationId) return;
    setTrainerFilters((current) => ({ ...current, organisationId }));
    setDraftFilters((current) => ({ ...current, organisationId }));
  }, [scopeOptions.loading, scopeOptions.organisations, scopeOptions.selection?.organisationId, trainerFilters.organisationId]);
  const scopedPerformance = useTrainerScope({
    ...trainerFilters,
    workflow: activeSection === 'detail' ? 'results' : activeSection,
  }, {
    enabled: ['overview', 'analytics', 'assignments', 'students', 'results', 'detail'].includes(activeSection)
      && Boolean(trainerFilters.organisationId),
  });
  const effectiveOrganisationId = trainerFilters.organisationId || scopedPerformance.selection?.organisationId || '';
  const effectiveCampusId = trainerFilters.campusId || scopedPerformance.selection?.campusId || '';
  const requiresOrganisationSelection = ['platform_owner', 'developer'].includes(scopedPerformance.role) && !effectiveOrganisationId;
  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === trainerFilters.groupId) ?? null,
    [groups, trainerFilters.groupId],
  );
  const progressFilterOptions = useMemo(
    () =>
      createUniqueOptions(
        trackedAssignments.map((assignment) => assignment.progressStatus),
        formatStatus,
      ),
    [trackedAssignments],
  );
  const protectedAssignments = useMemo(
    () => mergeScopedAssignments(scopedPerformance.assignments, trackedAssignments),
    [scopedPerformance.assignments, trackedAssignments],
  );
  const selectedAssignment = useMemo(
    () => protectedAssignments.find((assignment) => assignment.assignmentId === trainerFilters.assignmentId) ?? null,
    [protectedAssignments, trainerFilters.assignmentId],
  );
  const debouncedSearch = useDebouncedValue(trainerFilters.search, 200);
  const effectiveTrainerFilters = useMemo(
    () => ({ ...trainerFilters, search: debouncedSearch }),
    [debouncedSearch, trainerFilters],
  );
  const filteredAssignments = useMemo(
    () =>
      protectedAssignments.filter((assignment) =>
        (!effectiveOrganisationId || scopedPerformance.assignments.some((scoped) => scoped.id === (assignment.assignmentId || assignment.id))) &&
        (!effectiveCampusId || assignment.campusId === effectiveCampusId) &&
        (!trainerFilters.assignmentId || assignment.assignmentId === trainerFilters.assignmentId) &&
        matchesTrainerAssignmentFilters(assignment, effectiveTrainerFilters, selectedGroup),
      ),
    [effectiveCampusId, effectiveOrganisationId, effectiveTrainerFilters, protectedAssignments, scopedPerformance.assignments, selectedGroup, trainerFilters.assignmentId],
  );
  const filteredGroups = useMemo(
    () =>
      groups.filter((group) =>
        !requiresOrganisationSelection &&
        (!effectiveOrganisationId || group.organisationId === effectiveOrganisationId) &&
        (!effectiveCampusId || group.campusId === effectiveCampusId) &&
        matchesTrainerGroupFilters(group, trainerFilters),
      ),
    [effectiveCampusId, effectiveOrganisationId, groups, requiresOrganisationSelection, trainerFilters],
  );
  const filteredStudents = useMemo(
    () =>
      students.filter((student) =>
        !requiresOrganisationSelection &&
        (!effectiveOrganisationId || student.organisationId === effectiveOrganisationId) &&
        (!effectiveCampusId || student.campusId === effectiveCampusId) &&
        (!effectiveOrganisationId || scopedPerformance.learnerIds.includes(student.userId)) &&
        matchesTrainerStudentFilters(student, effectiveTrainerFilters),
      ),
    [effectiveCampusId, effectiveOrganisationId, effectiveTrainerFilters, requiresOrganisationSelection, scopedPerformance.learnerIds, students],
  );
  const scopedResults = useMemo(
    () => requiresOrganisationSelection || !effectiveOrganisationId
      ? []
      : normalizeScopedHistory(scopedPerformance.history?.items ?? [], students),
    [effectiveOrganisationId, requiresOrganisationSelection, scopedPerformance.history, students],
  );
  const allFilteredResults = useMemo(
    () =>
      scopedResults.filter((result) =>
        matchesTrainerResultFilters(result, effectiveTrainerFilters, selectedGroup, selectedAssignment),
      ),
    [effectiveTrainerFilters, scopedResults, selectedAssignment, selectedGroup],
  );
  const filteredResults = useMemo(
    () => resultsRange === 'all' ? allFilteredResults : allFilteredResults.slice(0, 25),
    [allFilteredResults, resultsRange],
  );
  const assessmentResults = useMemo(
    () => allFilteredResults.filter((result) => result.analyticsEligible !== false),
    [allFilteredResults],
  );
  const {
    activityAnalytics,
    analytics,
    assignmentReadiness,
    examAnalytics,
    groupAnalytics,
    readinessSummary,
    refreshAnalytics,
    studentReadiness,
    weakAreaAnalytics,
  } = useTrainerAnalytics({
    assignments: filteredAssignments,
    completeScopeAnalytics: scopedPerformance.analytics,
    error: error || assignmentError || progressError,
    groups: filteredGroups,
    loading: dashboardLoading || assignmentLoading || progressLoading,
    results: assessmentResults,
    students: filteredStudents,
  });
  const completeExamAnalytics = examAnalytics;
  const assignmentReadinessById = useMemo(
    () =>
      new Map(
        assignmentReadiness.map((assignment) => [
          assignment.assignmentId,
          assignment,
        ]),
      ),
    [assignmentReadiness],
  );
  const filteredStudentReadiness = useMemo(
    () =>
      studentReadiness.filter((row) =>
        matchesExactFilter(row.readinessStatus, trainerFilters.readinessStatus),
      ),
    [studentReadiness, trainerFilters.readinessStatus],
  );
  const visibleReadinessSummary = useMemo(
    () =>
      getReadinessSummaryRows({
        fallbackSummary: readinessSummary,
        readinessStatus: trainerFilters.readinessStatus,
        rows: filteredStudentReadiness,
      }),
    [filteredStudentReadiness, readinessSummary, trainerFilters.readinessStatus],
  );

  if (!isSupabaseConfigured) {
    return (
      <TrainerDashboardShell onBackHome={onBackHome} onBrowseExams={onBrowseExams}>
        <StatePanel
          title="Performance Dashboard is not configured here"
          note="This environment is running in frontend-only mode, so protected certification exams and staff result visibility are unavailable."
        />
      </TrainerDashboardShell>
    );
  }

  if (!isAuthenticated) {
    return (
      <TrainerDashboardShell onBackHome={onBackHome} onBrowseExams={onBrowseExams}>
        <StatePanel
          title="Sign in to continue"
          note="Sign in with a trainer, scoped admin, or Platform Owner account to view authorized groups and learner results. Protected certification exams also require sign-in and access."
        />
      </TrainerDashboardShell>
    );
  }

  if (dashboard.loading && !hasTrainerAccess) {
    return (
      <TrainerDashboardShell onBackHome={onBackHome} onBrowseExams={onBrowseExams}>
        <StatePanel
          title="Checking Performance Dashboard access..."
          note="CertSim is reading your profile and active memberships."
        />
      </TrainerDashboardShell>
    );
  }

  if (!hasTrainerAccess) {
    return (
      <TrainerDashboardShell onBackHome={onBackHome} onBrowseExams={onBrowseExams}>
        <StatePanel
          title="Performance Dashboard is not available for this account"
          note="This page is limited to active Trainer, scoped admin, and Platform Owner memberships. Normal exam access remains unchanged."
        />
      </TrainerDashboardShell>
    );
  }

  return (
    <TrainerDashboardShell onBackHome={onBackHome} onBrowseExams={onBrowseExams}>
      {error ? <p className="auth-panel-error">{error}</p> : null}
      {assignmentError ? <p className="auth-panel-error">{assignmentError}</p> : null}
      {progressError ? <p className="auth-panel-error">{progressError}</p> : null}
      {scopedPerformance.error ? <p className="auth-panel-error">{scopedPerformance.error}</p> : null}
      {scopeOptions.error ? <p className="auth-panel-error">{scopeOptions.error}</p> : null}
      {Object.entries(sectionErrors ?? {}).map(([section, message]) => message ? (
        <p className="auth-panel-error" key={section}>{message}</p>
      ) : null)}
      {assignmentActionMessage ? (
        <p className="auth-panel-success">{assignmentActionMessage}</p>
      ) : null}
      {assignmentActionError ? (
        <p className="auth-panel-error">{assignmentActionError}</p>
      ) : null}

      <SectionTabs
        activeSection={activeTrainerSection}
        sections={[
          { id: 'overview', label: 'Overview' },
          { id: 'analytics', label: 'Analytics' },
          { id: 'assignments', label: 'Assignments' },
          { id: 'students', label: 'Learner Progress' },
          { id: 'results', label: 'Saved Results' },
        ]}
        onSelect={onNavigateSection}
      />

      {activeTrainerSection === 'overview' && (
        <>
          <section className="management-summary-grid" aria-label="Trainer dashboard summary">
            <SummaryTile label="Groups / Classes" value={dashboardSummaryValue({ loading: dashboardLoading, error: sectionErrors?.groups, value: groups.length })} />
            <SummaryTile label="Assigned students" value={dashboardSummaryValue({ loading: dashboardLoading, error: sectionErrors?.students, value: students.length })} />
            <SummaryTile label="Scoped assignment results" value={dashboardSummaryValue({ loading: scopedPerformance.loading, error: scopedPerformance.error, value: scopedPerformance.history?.totalCount ?? 0 })} />
            <SummaryTile label="Assignments" value={dashboardSummaryValue({ loading: assignmentLoading || progressLoading, error: assignmentError || progressError, value: trackedAssignments.length })} />
            <SummaryTile label="Access role" value={getRoleLabel(primaryRole)} />
          </section>

          <section className="management-section compact" aria-labelledby="trainer-context-heading">
            <h3 id="trainer-context-heading">Trainer Context</h3>
            <ul className="trainer-context-list">
              {membershipLabels.length > 0 ? (
                membershipLabels.map((label, index) => (
                  <li key={`${label}-${index}`}>{label}</li>
                ))
              ) : (
                <li>No membership labels are available for this account yet.</li>
              )}
            </ul>
          </section>

          <div className="management-actions no-print">
            <button
              className="secondary-button"
              disabled={dashboardLoading}
              type="button"
              onClick={refresh}
            >
              {dashboardLoading ? 'Refreshing...' : 'Refresh dashboard'}
            </button>
            <button
              className="secondary-button"
              disabled={assignmentLoading || progressLoading}
              type="button"
              onClick={handleAssignmentRefresh}
            >
              {assignmentLoading || progressLoading
                ? 'Refreshing assignments...'
                : 'Refresh assignments'}
            </button>
          </div>
        </>
      )}

      {activeTrainerSection !== 'overview' && (
        <ManagementFilterPanel
          title="Filters"
          intro="Choose the authorized organisation, campus, group/class, and assignment scope. Results and analytics are calculated by the protected backend for the selected assignment."
        >
          <FilterTextInput
            label="Search"
            value={draftFilters.search}
            onChange={(value) => updateTrainerFilter('search', value)}
          />
          <FilterSelect
            label="Organisation"
            value={draftFilters.organisationId || scopeOptions.selection?.organisationId || ''}
            options={(scopeOptions.organisations ?? []).map(({ id, name }) => ({ value: id, label: name }))}
            placeholder="Choose an organisation"
            disabled={scopeOptions.locks?.organisation}
            onChange={(value) => updateScopeFilter('organisationId', value)}
          />
          <FilterSelect
            label="Campus"
            value={draftFilters.campusId}
            options={(scopeOptions.campuses ?? []).filter(({ id }) => !draftFilters.organisationId || scopeOptions.organisations.some((org) => org.id === draftFilters.organisationId)).map(({ id, name }) => ({ value: id, label: name }))}
            placeholder="All campuses"
            disabled={scopeOptions.locks?.campus}
            onChange={(value) => updateScopeFilter('campusId', value)}
          />
          <FilterSelect
            label="Group/class"
            value={draftFilters.groupId}
            options={(scopeOptions.groups ?? []).filter(({ campusId }) => !draftFilters.campusId || campusId === draftFilters.campusId).map(({ id, name }) => ({ value: id, label: name }))}
            placeholder="Choose a group/class"
            onChange={(value) => updateScopeFilter('groupId', value)}
          />
          <FilterSelect
            label="Assignment"
            value={draftFilters.assignmentId}
            options={(scopeOptions.assignments ?? []).filter((item) => (!draftFilters.campusId || item.campusId === draftFilters.campusId) && (!draftFilters.groupId || item.groupId === draftFilters.groupId) && (!draftFilters.examKey || item.examKey === draftFilters.examKey)).map(({ id, name }) => ({ value: id, label: name }))}
            placeholder="Choose an assignment"
            onChange={(value) => updateScopeFilter('assignmentId', value)}
          />
          <FilterSelect
            label="Exam"
            value={draftFilters.examKey}
            options={(scopeOptions.exams ?? []).map(({ id, name }) => ({ value: id, label: formatExamCode({ examKey: name }) }))}
            placeholder="All exams"
            onChange={(value) => updateScopeFilter('examKey', value)}
          />
          <FilterSelect
            label="Assignment progress"
            value={draftFilters.progressStatus}
            options={progressFilterOptions}
            placeholder="All progress states"
            onChange={(value) => updateTrainerFilter('progressStatus', value)}
          />
          <FilterSelect
            label="Readiness"
            value={draftFilters.readinessStatus}
            options={READINESS_STATUSES.map((status) => ({
              value: status.id,
              label: status.label,
            }))}
            placeholder="All readiness states"
            onChange={(value) => updateTrainerFilter('readinessStatus', value)}
          />
          <FilterSelect
            label="Result status"
            value={draftFilters.resultStatus}
            options={[
              { value: 'passed', label: 'Passed' },
              { value: 'needs-review', label: 'Needs review' },
              { value: 'not-recorded', label: 'Not recorded' },
            ]}
            placeholder="All result states"
            onChange={(value) => updateTrainerFilter('resultStatus', value)}
          />
          <FilterSummary label={trainerFiltersEqual(draftFilters, trainerFilters) ? 'Applied scope' : 'Unapplied changes'} value={trainerFiltersEqual(draftFilters, trainerFilters) ? `${filteredAssignments.length} assignments, ${filteredStudentReadiness.length} readiness rows, ${filteredResults.length} results` : 'Choose Apply filters to refresh this workflow.'} />
          <button className="primary-button compact-button" type="button" disabled={trainerFiltersEqual(draftFilters, trainerFilters) || scopedPerformance.loading} onClick={applyTrainerFilters}>
            {scopedPerformance.loading ? 'Applying…' : 'Apply filters'}
          </button>
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={clearTrainerFilters}
          >
            Clear filters
          </button>
        </ManagementFilterPanel>
      )}

      {activeTrainerSection === 'analytics' && (
      <ManagementSection
        title="Analytics"
        intro="Read-only readiness indicators from saved CertSim results in your visible scope."
      >
        <p className="analytics-disclaimer">{READINESS_DISCLAIMER}</p>
        <div className="management-actions no-print">
          <button
            className="secondary-button compact-button"
            disabled={dashboardLoading || assignmentLoading || progressLoading}
            type="button"
            onClick={handleAnalyticsRefresh}
          >
            Refresh analytics
          </button>
        </div>

        <section className="management-summary-grid" aria-label="Readiness summary">
          {visibleReadinessSummary.map((summary) => (
            <SummaryTile
              key={summary.id}
              label={summary.label}
              value={summary.count}
            />
          ))}
        </section>

        <section className="analytics-grid">
          <AnalyticsCard
            title="Group Summary"
            note="Ready rate, activity, and score patterns for visible groups/classes."
          >
            <GroupAnalyticsCards groups={groupAnalytics} />
          </AnalyticsCard>

          <AnalyticsCard
            title="Exam Analytics"
            note="Assignment-attributed assessment figures for the selected authorized scope. Personal, purchase, staff, and unattributed history is excluded."
          >
            <ExamAnalyticsCards exams={completeExamAnalytics} />
          </AnalyticsCard>
        </section>

        <AnalyticsCard
          title="Student Readiness"
          note={`${analytics.totals.students} visible students, ${analytics.totals.results} assignment-attributed results, ${analytics.totals.assignments} tracked assignments after filters.`}
        >
          <StudentReadinessCards
            detailLoading={detailLoading}
            rows={filteredStudentReadiness}
            onOpenResult={handleOpenResultDetail}
            onOpenStudentReport={onOpenStudentReport}
          />
        </AnalyticsCard>

        <section className="analytics-grid">
          <AnalyticsCard
            title="Weak Areas"
            note="Domain and weak-area data appears when saved result snapshots include it."
          >
            <WeakAreaAnalytics data={weakAreaAnalytics} />
          </AnalyticsCard>

          <AnalyticsCard
            title="Activity"
            note="Quick view of most active, least active, and no-attempt students."
          >
            <ActivityAnalytics data={activityAnalytics} />
          </AnalyticsCard>
        </section>
      </ManagementSection>
      )}

      {activeTrainerSection === 'assignments' && (
      <ManagementSection
        title="Exam Assignments"
        intro="Create practice assignment reminders for scoped groups/classes or individual students."
      >
        <details className="management-collapsible no-print">
          <summary>Create assignments</summary>
          <div className="assignment-form-grid">
          <form
            className="management-form"
            onSubmit={(event) =>
              handleAssignmentSubmit(event, 'group', async () => {
                const result = await createGroupAssignment(groupAssignmentForm);

                if (result.ok) {
                  setGroupAssignmentForm(initialGroupAssignmentForm);
                }

                return result;
              })
            }
          >
            <SelectInput
              label="Exam"
              value={groupAssignmentForm.examCatalogId}
              onChange={(value) => updateGroupAssignmentForm('examCatalogId', value)}
              options={assignableExams.map((exam) => ({
                value: exam.id,
                label: exam.title,
              }))}
              required
            />
            <SelectInput
              label="Group/class"
              value={groupAssignmentForm.groupId}
              onChange={(value) => updateGroupAssignmentForm('groupId', value)}
              options={groups.map((group) => ({
                value: group.id,
                label: group.scopeLabel || [group.name, group.campusName]
                  .filter(Boolean)
                  .join(' / '),
              }))}
              required
            />
            <TextInput
              label="Assignment title"
              value={groupAssignmentForm.title}
              onChange={(value) => updateGroupAssignmentForm('title', value)}
              required
            />
            <TextInput
              label="Instructions optional"
              value={groupAssignmentForm.instructions}
              onChange={(value) =>
                updateGroupAssignmentForm('instructions', value)
              }
            />
            <TextInput
              label="Due date optional"
              type="datetime-local"
              value={groupAssignmentForm.dueAt}
              onChange={(value) => updateGroupAssignmentForm('dueAt', value)}
            />
            <button
              className="primary-button"
              disabled={
                busyAssignmentAction === 'group' ||
                assignableExams.length === 0 ||
                groups.length === 0
              }
              type="submit"
            >
              {busyAssignmentAction === 'group'
                ? 'Creating...'
                : 'Assign exam to group'}
            </button>
          </form>

          <form
            className="management-form"
            onSubmit={(event) =>
              handleAssignmentSubmit(event, 'student', async () => {
                const result = await createStudentAssignment(studentAssignmentForm);

                if (result.ok) {
                  setStudentAssignmentForm(initialStudentAssignmentForm);
                }

                return result;
              })
            }
          >
            <SelectInput
              label="Exam"
              value={studentAssignmentForm.examCatalogId}
              onChange={(value) =>
                updateStudentAssignmentForm('examCatalogId', value)
              }
              options={assignableExams.map((exam) => ({
                value: exam.id,
                label: exam.title,
              }))}
              required
            />
            <SearchableProfilePicker
              label="Student"
              value={studentAssignmentForm.studentMembershipId}
              items={students}
              helpText="Search visible students by display name, username, email, or group."
              getValue={(student) => student.membershipId}
              getPrimaryText={formatStudentPrimaryLabel}
              getSecondaryText={formatStudentSecondaryLabel}
              getBadgeText={(student) => student.groupName || student.status}
              getSearchText={formatStudentSearchText}
              onChange={(value) =>
                updateStudentAssignmentForm('studentMembershipId', value)
              }
              required
            />
            <TextInput
              label="Assignment title"
              value={studentAssignmentForm.title}
              onChange={(value) => updateStudentAssignmentForm('title', value)}
              required
            />
            <TextInput
              label="Instructions optional"
              value={studentAssignmentForm.instructions}
              onChange={(value) =>
                updateStudentAssignmentForm('instructions', value)
              }
            />
            <TextInput
              label="Due date optional"
              type="datetime-local"
              value={studentAssignmentForm.dueAt}
              onChange={(value) => updateStudentAssignmentForm('dueAt', value)}
            />
            <button
              className="primary-button"
              disabled={
                busyAssignmentAction === 'student' ||
                assignableExams.length === 0 ||
                students.length === 0
              }
              type="submit"
            >
              {busyAssignmentAction === 'student'
                ? 'Creating...'
                : 'Assign exam to student'}
            </button>
          </form>
          </div>
        </details>

        {assignableExams.length === 0 ? (
          <p className="auth-panel-muted">
            No active exam catalog rows are visible yet. Apply migration 0005
            and confirm `exam_catalog` contains assignable exams.
          </p>
        ) : null}

        <TableState
          loading={assignmentLoading || progressLoading}
          count={filteredAssignments.length}
          empty={
            trackedAssignments.length > 0
              ? 'No assignments match the current filters.'
              : 'No scoped assignments are visible yet.'
          }
        />
        {filteredAssignments.length > 0 ? (
          <div className="assignment-card-list">
            {filteredAssignments.map((assignment) => (
              <AssignmentListCard
                assignment={assignment}
                detailLoading={detailLoading}
                key={assignment.id}
                readiness={assignmentReadinessById.get(assignment.id)}
                onOpenAssignment={onOpenAssignment}
                onOpenResult={handleOpenResultDetail}
              />
            ))}
          </div>
        ) : null}
        {scopedPerformance.hasMoreAssignments ? (
          <button className="secondary-button" type="button" disabled={scopedPerformance.loadingMore} onClick={scopedPerformance.loadMoreAssignments}>
            {scopedPerformance.loadingMore ? 'Loading more assignments…' : 'Load more assignments'}
          </button>
        ) : null}
      </ManagementSection>
      )}

      {activeTrainerSection === 'students' && (
      <ManagementSection
        title="Learner Progress"
        intro="Learner rows are read from active memberships in the current authorized scope."
      >
        <details className="management-collapsible no-print">
          <summary>Update student display name</summary>
          <form
            className="management-form profile-display-form"
            onSubmit={handleStudentDisplaySubmit}
          >
            <SearchableProfilePicker
              label="Student display name"
              value={studentDisplayForm.profileId}
              items={students}
              required
              helpText="Search visible students by display name, username, email, or group."
              getValue={(student) => student.userId}
              getPrimaryText={formatStudentPrimaryLabel}
              getSecondaryText={formatStudentSecondaryLabel}
              getBadgeText={(student) => student.groupName || student.status}
              getSearchText={formatStudentSearchText}
              onChange={(value, student) => {
                setStudentDisplayForm({
                  profileId: value,
                  displayName: student?.displayName || '',
                });
              }}
            />
            <TextInput
              label="Display name / nickname"
              value={studentDisplayForm.displayName}
              required
              onChange={(value) =>
                setStudentDisplayForm((current) => ({
                  ...current,
                  displayName: value,
                }))
              }
            />
            <button
              className="primary-button"
              disabled={busyAssignmentAction === 'student-display'}
              type="submit"
            >
              {busyAssignmentAction === 'student-display'
                ? 'Updating...'
                : 'Update student name'}
            </button>
          </form>
        </details>
        <TableState
          loading={dashboardLoading}
          count={filteredStudents.length}
          empty={
            students.length > 0
              ? 'No students match the current filters.'
              : 'No assigned students are visible yet.'
          }
        />
        {filteredStudents.length > 0 ? (
          <div className="management-table-wrap">
            <table className="management-table">
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Email</th>
                  <th>Group</th>
                  <th>Campus</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredStudents.map((student) => (
                  <tr key={student.membershipId}>
                    <td className="profile-cell">
                      <strong>{student.displayName}</strong>
                      <span className="table-subtext">
                        {formatOptional(student.groupName || student.campusName)}
                      </span>
                    </td>
                    <td className="email-cell">{formatOptional(student.email)}</td>
                    <td>{formatOptional(student.groupName)}</td>
                    <td>{formatOptional(student.campusName)}</td>
                    <td className="status-text-cell">{formatStatus(student.status)}</td>
                    <td>
                      <button
                        className="secondary-button compact-button"
                        type="button"
                        onClick={() => onOpenStudentReport?.(student.userId)}
                      >
                        Open Learner Progress
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </ManagementSection>
      )}

      {activeTrainerSection === 'results' && (
      <ManagementSection
        title="Student Saved Results"
        intro={resultsRange === 'all'
          ? 'Loaded all-time assessment history in the selected authorized scope. Assignment attribution remains distinct from general exam activity.'
          : 'Recent eligible assessment results (latest 25 after filtering). Choose All Time to browse older results in bounded pages.'}
      >
        <div className="saved-attempt-toolbar no-print">
          <label>
            <span>Range</span>
            <select value={resultsRange} onChange={(event) => setResultsRange(event.target.value)}>
              <option value="recent">Recent results</option>
              <option value="all">All Time</option>
            </select>
          </label>
          <strong>Showing {filteredResults.length} of {scopedPerformance.history?.totalCount ?? allFilteredResults.length} results</strong>
        </div>
        <TableState
          loading={dashboardLoading}
          count={filteredResults.length}
          empty={
            scopedResults.length > 0
              ? 'No saved results match the current filters.'
              : 'No saved student results are visible yet.'
          }
        />
        {filteredResults.length > 0 ? (
          <div className="management-table-wrap">
            <table className="management-table">
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Exam</th>
                  <th>Mode</th>
                  <th className="score-col">Score</th>
                  <th className="date-col">Submitted</th>
                  <th>Status</th>
                  <th className="action-col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {filteredResults.map((result) => (
                  <tr key={result.attemptId}>
                    <td className="profile-cell">
                      <strong>{result.studentName}</strong>
                      <span className="table-subtext">
                        {formatOptional(result.groupName || result.campusName)}
                      </span>
                    </td>
                    <td>{result.examTitle}</td>
                    <td>
                      {result.modeLabel || result.profileLabel}
                      <span className="table-subtext">{result.attemptKindLabel}</span>
                    </td>
                    <td className="score-cell">{formatScore(result)}</td>
                    <td className="date-cell">{formatDate(result.submittedAt)}</td>
                    <td className="status-text-cell">{formatPassFail(result.passed)}</td>
                    <td className="action-cell">
                      <button
                        className="secondary-button compact-button"
                        disabled={detailLoading}
                        type="button"
                        onClick={() => handleOpenResultDetail(result.attemptId)}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {resultsRange === 'all' && scopedPerformance.hasMoreHistory ? (
          <button
            className="secondary-button no-print"
            type="button"
            disabled={scopedPerformance.loadingMore}
            onClick={scopedPerformance.loadMoreHistory}
          >
            {scopedPerformance.loadingMore ? 'Loading more results…' : 'Load more results'}
          </button>
        ) : null}
      </ManagementSection>
      )}

      {activeTrainerSection === 'detail' && (
      <ManagementSection
        title="Result Detail"
        intro="Compact detail for trainer discussion. Answer-level review and grading tools are not part of this MVP."
      >
        {detailLoading ? (
          <StatePanel title="Loading result detail..." note="Reading the selected saved result summary." />
        ) : selectedResult ? (
          <ResultDetail
            result={selectedResult}
            onClose={() => { clearSelectedResult(); onNavigateSection?.('results'); }}
          />
        ) : (
          <StatePanel
            title="No saved result selected"
            note="Open a student result above to see domain, weak-area, and report summary data."
          />
        )}
      </ManagementSection>
      )}
    </TrainerDashboardShell>
  );

  function updateTrainerFilter(field, value) {
    setDraftFilters((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function updateScopeFilter(field, value) {
    setDraftFilters((current) => updateDraftScopeFilter(current, field, value));
    clearSelectedResult();
  }

  function clearTrainerFilters() {
    const cleared = { ...EMPTY_TRAINER_FILTERS };
    setDraftFilters(cleared);
    setTrainerFilters(cleared);
  }

  function applyTrainerFilters() {
    setTrainerFilters(draftFilters);
    clearSelectedResult();
  }

  function updateGroupAssignmentForm(field, value) {
    setGroupAssignmentForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function updateStudentAssignmentForm(field, value) {
    setStudentAssignmentForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  async function handleAssignmentSubmit(event, actionName, action) {
    event.preventDefault();
    setBusyAssignmentAction(actionName);
    setAssignmentActionMessage('');
    setAssignmentActionError('');

    const result = await action();

    if (result.ok) {
      setAssignmentActionMessage('Assignment saved.');
      await refreshProgress();
    } else {
      setAssignmentActionError(result.message);
    }

    setBusyAssignmentAction('');
  }

  async function handleAssignmentRefresh() {
    await Promise.all([refreshAssignments(), refreshProgress()]);
  }

  async function handleAnalyticsRefresh() {
    refreshAnalytics();
    await Promise.all([refresh(), refreshAssignments(), refreshProgress()]);
  }

  async function handleOpenResultDetail(attemptId) {
    const result = await loadResultDetail(attemptId);

    if (result.ok) {
      onNavigateSection?.('detail', attemptId);
    }

    return result;
  }

  async function handleStudentDisplaySubmit(event) {
    event.preventDefault();
    setBusyAssignmentAction('student-display');
    setAssignmentActionMessage('');
    setAssignmentActionError('');

    const result = await updateStudentDisplayName({
      displayName: studentDisplayForm.displayName,
      profileId: studentDisplayForm.profileId,
    });

    if (result.ok) {
      setStudentDisplayForm(initialStudentDisplayForm);
      setAssignmentActionMessage('Student display name updated.');
    } else {
      setAssignmentActionError(result.message);
    }

    setBusyAssignmentAction('');
  }
}

function TrainerDashboardShell({ children, onBackHome, onBrowseExams }) {
  return (
    <section className="management-page" aria-labelledby="trainer-dashboard-heading">
      <p className="eyebrow">Staff tools</p>
      <h2 id="trainer-dashboard-heading">Performance Dashboard</h2>
      <p className="management-intro">
        Review authorized classes, learners, Saved Results, readiness, and
        assignments. Protected access is enforced for every staff scope.
      </p>
      {children}
    </section>
  );
}

function ManagementSection({ children, intro, title }) {
  return (
    <section className="management-section">
      <h3>{title}</h3>
      {intro ? <p>{intro}</p> : null}
      {children}
    </section>
  );
}

function StatePanel({ note, title }) {
  return (
    <section className="management-state">
      <h3>{title}</h3>
      <p>{note}</p>
    </section>
  );
}

function SummaryTile({ label, value }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SectionTabs({ activeSection, onSelect, sections }) {
  return (
    <nav className="management-tabs no-print" aria-label="Trainer dashboard sections">
      {sections.map((section) => (
        <a
          key={section.id}
          className={activeSection === section.id ? 'active' : ''}
          href={getTrainerSectionPath(section.id)}
          aria-current={activeSection === section.id ? 'page' : undefined}
          onClick={(event) => { event.preventDefault(); onSelect?.(section.id); }}
        >
          {section.label}
        </a>
      ))}
    </nav>
  );
}

function getTrainerSectionPath(section) {
  return section === 'overview' ? '/trainer/dashboard' : `/trainer/dashboard/${section}`;
}

function readTrainerFiltersFromUrl(defaults) {
  if (typeof window === 'undefined') return defaults;
  const params = new URLSearchParams(window.location.search);
  return {
    ...defaults,
    organisationId: params.get('organisation') ?? '',
    campusId: params.get('campus') ?? '',
    groupId: params.get('group') ?? '',
    assignmentId: params.get('assignment') ?? '',
    examKey: params.get('exam') ?? '',
    progressStatus: params.get('progress') ?? '',
    readinessStatus: params.get('readiness') ?? '',
    resultStatus: params.get('status') ?? '',
    search: params.get('q') ?? '',
  };
}

function ManagementFilterPanel({ children, intro, title }) {
  return (
    <section className="management-filter-panel no-print">
      <div>
        <h3>{title}</h3>
        <p>{intro}</p>
      </div>
      <div className="management-filter-grid">{children}</div>
    </section>
  );
}

function FilterTextInput({ label, onChange, value }) {
  return (
    <label className="management-filter-field">
      <span>{label}</span>
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function FilterSelect({ disabled = false, label, onChange, options, placeholder, value }) {
  return (
    <label className="management-filter-field">
      <span>{label}</span>
      <select disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function FilterSummary({ label, value }) {
  return (
    <div className="management-filter-summary">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AnalyticsCard({ children, note = '', title }) {
  return (
    <section className="analytics-card">
      <div>
        <h4>{title}</h4>
        {note ? <p>{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

function StudentReadinessCards({
  detailLoading,
  onOpenResult,
  onOpenStudentReport,
  rows,
}) {
  if (rows.length === 0) {
    return (
      <StatePanel
        title="No student readiness data yet"
        note="Saved results or visible student memberships are needed before readiness can be estimated."
      />
    );
  }

  return (
    <div className="student-readiness-card-grid">
      {rows.map((row) => (
        <article
          className="student-readiness-card"
          key={`${row.userId || row.displayName}-${row.examScopeKey || 'none'}`}
        >
          <div className="student-readiness-card-header">
            <div>
              <h5>{row.displayName}</h5>
              <p>{row.email || 'Email not recorded'}</p>
            </div>
            <ReadinessBadge status={row.readinessStatus}>
              {row.readinessLabel}
            </ReadinessBadge>
          </div>

          <div className="student-readiness-context">
            <span>
              <strong>Exam readiness</strong>
              {row.examTitle}
            </span>
            <span>
              <strong>Group/class</strong>
              {row.groupName}
            </span>
            <span>
              <strong>General activity</strong>
              {formatActivityAttemptNote(row)}
            </span>
          </div>

          <div className="student-readiness-metrics">
            <MetricPill label="Latest" value={formatAnalyticsScore(row.latestScore)} />
            <MetricPill label="Best" value={formatAnalyticsScore(row.bestScore)} />
            <MetricPill label="Average" value={formatAnalyticsScore(row.averageScore)} />
            <MetricPill label="Pass rate" value={formatAnalyticsRate(row.passRate)} />
            <MetricPill label="Exam-scoped attempts" value={row.scopedAttemptCount} />
            <MetricPill label="Last attempt" value={formatDate(row.latestAttemptDate)} />
          </div>

          <div className="student-readiness-domain-summary">
            <span>
              <strong>Worst domain</strong>
              {row.weakestDomain
                ? formatDomainAverage(row.weakestDomain)
                : getNoDomainDataMessage()}
            </span>
            <span>
              <strong>Readiness reason</strong>
              {row.readinessReason}
            </span>
          </div>

          <div className="student-readiness-actions">
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={() => onOpenStudentReport?.(row.userId)}
            >
              Open student report
            </button>
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
              <span className="table-subtext">No matching result for this exam.</span>
            )}
          </div>

          <details className="student-readiness-detail">
            <summary>View details</summary>
            <div className="student-readiness-detail-grid">
              <DetailBlock title="Attempts by exam">
                <CompactDetailList
                  empty="No saved activity yet."
                  items={(row.attemptsByExam ?? []).map((attempt) => ({
                    detail: `${attempt.count} attempts, latest ${formatDate(attempt.latestAttemptDate)}`,
                    key: attempt.examKey || attempt.examTitle,
                    label: attempt.examTitle,
                  }))}
                />
              </DetailBlock>

              <DetailBlock title="Assignment status">
                <CompactDetailList
                  empty="No assignment for this exam."
                  items={(row.assignmentSummaries ?? []).map((assignment) => ({
                    badgeStatus: assignment.status,
                    detail: `Due ${formatDate(assignment.dueAt)}`,
                    key: assignment.id || assignment.examTitle,
                    label: assignment.label,
                  }))}
                />
              </DetailBlock>

              <DetailBlock title="Domain averages">
                {(row.domainAverages ?? []).length > 0 ? (
                  <ul className="compact-detail-list">
                    {row.domainAverages.map((domain) => (
                      <li key={domain.domainId || domain.domainLabel}>
                        <strong>{formatDomainAverage(domain)}</strong>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{getNoDomainDataMessage()}</p>
                )}
              </DetailBlock>

              <DetailBlock title="Latest result detail">
                <dl className="student-latest-result-facts">
                  <div>
                    <dt>Latest score</dt>
                    <dd>{formatAnalyticsScore(row.latestScore)}</dd>
                  </div>
                  <div>
                    <dt>Best score</dt>
                    <dd>{formatAnalyticsScore(row.bestScore)}</dd>
                  </div>
                  <div>
                    <dt>Strongest domain</dt>
                    <dd>
                      {row.strongestDomain
                        ? formatDomainAverage(row.strongestDomain)
                        : 'No domain data'}
                    </dd>
                  </div>
                  <div>
                    <dt>Latest date</dt>
                    <dd>{formatDate(row.latestAttemptDate)}</dd>
                  </div>
                </dl>
              </DetailBlock>
            </div>
          </details>
        </article>
      ))}
    </div>
  );
}

function GroupAnalyticsCards({ groups }) {
  if (groups.length === 0) {
    return (
      <StatePanel
        title="No group analytics yet"
        note="Visible groups with students or saved results are needed for group analytics."
      />
    );
  }

  return (
    <div className="analytics-card-grid">
      {groups.map((group) => (
        <article className="analytics-summary-card" key={group.groupId || group.groupName}>
          <div className="analytics-summary-card-header">
            <h5>{group.groupName}</h5>
            <span>{group.studentCount} students</span>
          </div>
          <div className="analytics-card-metrics">
            <MetricPill label="Activity attempts" value={group.totalAttempts} />
            <MetricPill label="Avg score" value={formatAnalyticsScore(group.averageScore)} />
            <MetricPill label="Pass rate" value={formatAnalyticsRate(group.passRate)} />
            <MetricPill label="Ready rate" value={formatAnalyticsRate(group.completionRate)} />
          </div>
          <p>
            {group.readyStudents} ready students. {group.studentsWithAttempts} active
            with attempts; {group.studentsWithoutAttempts} without saved attempts.
          </p>
          <p>
            <strong>Common weak domains:</strong>{' '}
            {formatDomainSummaryList(group.commonWeakDomains)}
          </p>
        </article>
      ))}
    </div>
  );
}

function ExamAnalyticsCards({ exams }) {
  if (exams.length === 0) {
    return (
      <StatePanel
        title="No exam analytics yet"
        note="Saved student results are needed before exam-level analytics can be shown."
      />
    );
  }

  return (
    <div className="analytics-card-grid">
      {exams.map((exam) => (
        <article className="analytics-summary-card" key={exam.examKey || exam.examTitle}>
          <div className="analytics-summary-card-header">
            <h5>{exam.examTitle}</h5>
            <span>{exam.examKey || 'Exam key not recorded'}</span>
          </div>
          <div className="analytics-card-metrics">
            <MetricPill label="Attempts" value={exam.totalAttempts} />
            <MetricPill label="Students" value={exam.studentsAttempted} />
            <MetricPill label="Avg score" value={formatAnalyticsScore(exam.averageScore)} />
            <MetricPill label="Pass rate" value={formatAnalyticsRate(exam.passRate)} />
            <MetricPill label="Best" value={formatAnalyticsScore(exam.bestScore)} />
            <MetricPill label="Lowest" value={formatAnalyticsScore(exam.lowestScore)} />
            {Number.isInteger(exam.historicalCount) ? <MetricPill label="Historical" value={exam.historicalCount} /> : null}
          </div>
          <p>
            <strong>Needs review:</strong> {exam.needsReviewCount}
          </p>
        </article>
      ))}
    </div>
  );
}

function WeakAreaAnalytics({ data }) {
  const commonWeakAreas = data?.commonWeakAreas ?? [];
  const domainPerformance = data?.domainPerformance ?? [];

  if (commonWeakAreas.length === 0 && domainPerformance.length === 0) {
    return (
      <StatePanel
        title="No weak-area data yet"
        note="Weak domains appear here when saved result snapshots include weak-area or domain breakdown data."
      />
    );
  }

  return (
    <div className="analytics-list-grid">
      <AnalyticsList
        empty="No weak-area labels stored."
        items={commonWeakAreas.map((area) => ({
          detail: `${area.studentCount} students, ${area.occurrences} occurrences, ${formatAnalyticsRate(area.averagePercentage)} average`,
          key: area.label,
          label: area.label,
        }))}
        title="Common weak areas"
      />
      <AnalyticsList
        empty="No domain breakdown stored."
        items={domainPerformance.map((domain) => ({
          detail: `${formatAnalyticsRate(domain.averagePercentage)} average, ${domain.weakCount} below 70%`,
          key: `${domain.examTitle}-${domain.domain}`,
          label: `${domain.examTitle}: ${domain.domain}`,
        }))}
        title="Domain performance"
      />
    </div>
  );
}

function ActivityAnalytics({ data }) {
  return (
    <div className="analytics-list-grid">
      <AnalyticsList
        empty="No saved attempts yet."
        items={(data?.mostActiveStudents ?? []).map((student) => ({
          detail: `${student.totalAttempts} attempts, last ${formatDate(student.latestAttemptDate)}`,
          key: `most-${student.userId}`,
          label: student.displayName,
        }))}
        title="Most active"
      />
      <AnalyticsList
        empty="No low-activity attempt data yet."
        items={(data?.leastActiveStudents ?? []).map((student) => ({
          detail: `${student.totalAttempts} attempts, last ${formatDate(student.latestAttemptDate)}`,
          key: `least-${student.userId}`,
          label: student.displayName,
        }))}
        title="Least active"
      />
      <AnalyticsList
        empty="All visible students have saved attempts."
        items={(data?.studentsWithNoAttempts ?? []).map((student) => ({
          detail: student.groupName || 'No group recorded',
          key: `none-${student.userId}`,
          label: student.displayName,
        }))}
        title="No attempts"
      />
    </div>
  );
}

function MetricPill({ label, value }) {
  return (
    <span className="analytics-metric-pill">
      <strong>{value}</strong>
      {label}
    </span>
  );
}

function DetailBlock({ children, title }) {
  return (
    <section className="student-readiness-detail-block">
      <h6>{title}</h6>
      {children}
    </section>
  );
}

function CompactDetailList({ empty, items }) {
  if (!Array.isArray(items) || items.length === 0) {
    return <p>{empty}</p>;
  }

  return (
    <ul className="compact-detail-list">
      {items.map((item) => (
        <li key={item.key || item.label}>
          {item.badgeStatus ? (
            <span className={`assignment-progress-pill ${item.badgeStatus}`}>
              {item.label}
            </span>
          ) : (
            <strong>{item.label}</strong>
          )}
          <span>{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}

function AnalyticsList({ empty, items, title }) {
  return (
    <section className="analytics-mini-list">
      <h5>{title}</h5>
      {items.length > 0 ? (
        <ul>
          {items.map((item) => (
            <li key={item.key}>
              <strong>{item.label}</strong>
              <span>{item.detail}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}

function ReadinessBadge({ children, status }) {
  return (
    <span className={`readiness-badge ${status || 'no-data'}`}>
      {children}
    </span>
  );
}

function TextInput({
  label,
  onChange,
  required = false,
  type = 'text',
  value,
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type={type}
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function SelectInput({ label, onChange, options, required = false, value }) {
  return (
    <label>
      <span>{label}</span>
      <select
        value={value}
        required={required}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Select...</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function AssignmentListCard({
  assignment,
  detailLoading,
  onOpenAssignment,
  onOpenResult,
  readiness,
}) {
  const latestResult = assignment.latestResult;
  const summary = createAssignmentSummaryPreview(readiness);

  return (
    <article className="trainer-assignment-card">
      <div className="trainer-assignment-card-header">
        <div>
          <h4>{assignment.title}</h4>
          <p>{assignment.instructions || 'No extra instructions.'}</p>
        </div>
        <span className={`assignment-progress-pill ${assignment.status}`}>
          {formatStatus(assignment.status)}
        </span>
      </div>

      <div className="trainer-assignment-card-meta">
        <span>
          <strong>{formatExamCode(assignment)}</strong>
          <small>{assignment.examTitle}</small>
        </span>
        <span>
          <strong>{assignment.targetName || assignment.targetLabel}</strong>
          <small>
            {formatStatus(assignment.targetType)}
            {assignment.groupName && assignment.targetType === 'student'
              ? ` - ${assignment.groupName}`
              : ''}
          </small>
        </span>
        <span>
          <strong>{formatDate(assignment.dueAt)}</strong>
          <small>Due date</small>
        </span>
        <span>
          <strong>{assignment.assignedByName || 'Not recorded'}</strong>
          <small>Assigned by</small>
        </span>
      </div>

      <div className="assignment-readiness-grid compact">
        <span>
          <strong>{summary.readyCount}</strong>
          Ready
        </span>
        <span>
          <strong>{summary.almostReadyCount}</strong>
          Almost ready
        </span>
        <span>
          <strong>{summary.needsReviewCount}</strong>
          Needs review
        </span>
        <span>
          <strong>{summary.notStartedCount}</strong>
          Not started
        </span>
        <span>
          <strong>{summary.overdueCount}</strong>
          Overdue
        </span>
        <span>
          <strong>{summary.dueSoonCount}</strong>
          Due soon
        </span>
      </div>

      <div className="trainer-assignment-card-footer">
        <span className="table-subtext">
          Latest saved result:{' '}
          {latestResult
            ? `${formatScore(latestResult)} - ${latestResult.studentName || assignment.studentName || 'Student'} - ${formatDate(latestResult.submittedAt)}`
            : 'No matching saved result yet.'}
        </span>
        <div className="button-row wrap">
          {latestResult ? (
            <button
              className="secondary-button compact-button"
              disabled={detailLoading}
              type="button"
              onClick={() => onOpenResult(latestResult.attemptId)}
            >
              Open latest result
            </button>
          ) : null}
          <button
            className="primary-button compact-button"
            type="button"
            onClick={() => onOpenAssignment?.(assignment.id)}
          >
            Open assignment
          </button>
        </div>
      </div>
    </article>
  );
}

function DomainAverageToggle({ domains = [] }) {
  if (!Array.isArray(domains) || domains.length === 0) {
    return null;
  }

  return (
    <details className="analytics-domain-toggle">
      <summary>Domain averages</summary>
      <ul>
        {domains.map((domain) => (
          <li key={domain.domainId || domain.domainLabel}>
            {formatDomainAverage(domain)}
          </li>
        ))}
      </ul>
    </details>
  );
}

function TableState({ count, empty, loading }) {
  if (loading) {
    return <p className="auth-panel-muted">Loading records...</p>;
  }

  if (count === 0) {
    return <p className="auth-panel-muted">{empty}</p>;
  }

  return null;
}

function ResultDetail({ onClose, result }) {
  const domainRows = getTrainerDomainRows(result.domainBreakdown);
  const weakAreas = Array.isArray(result.weakAreas) ? result.weakAreas : [];
  const pbqRows = objectEntries(result.pbqBreakdown);
  const caseStudyRows = objectEntries(result.caseStudyBreakdown);

  return (
    <div className="saved-result-detail-card">
      <div className="saved-result-detail-header">
        <div>
          <h3>{result.reportTitle || `${result.examTitle} saved result`}</h3>
          <p>
            {result.studentName} - {result.attemptKindLabel} - {result.modeLabel || result.profileLabel} -{' '}
            {formatDate(result.submittedAt)}
          </p>
        </div>
        <button className="secondary-button compact-button" type="button" onClick={onClose}>
          Close detail
        </button>
      </div>

      <dl className="saved-result-facts">
        <div>
          <dt>Scaled score</dt>
          <dd>{formatOptional(result.scaledScore)}</dd>
        </div>
        <div>
          <dt>Raw percentage</dt>
          <dd>{formatPercentage(result.rawPercentage)}</dd>
        </div>
        <div>
          <dt>Result</dt>
          <dd>{formatPassFail(result.passed)}</dd>
        </div>
        <div>
          <dt>Responses</dt>
          <dd>{formatOptional(result.responseCount)}</dd>
        </div>
        {result.reviewStatus ? <div><dt>Review</dt><dd>{result.reviewStatus === 'released' ? 'Released' : 'Withheld'}</dd></div> : null}
      </dl>

      <section className="saved-result-detail-section">
        <h4>Domain Breakdown</h4>
        {domainRows.length > 0 ? (
          <ul>
            {domainRows.map((domain) => (
              <li key={domain.domainId}>
                <strong>{domain.domainLabel}:</strong>{' '}
                {formatDomainDetail(domain)}
              </li>
            ))}
          </ul>
        ) : (
          <p>{getTrainerDomainMissingMessage(result.domainBreakdown)}</p>
        )}
      </section>
      <DetailList title="PBQ Breakdown" rows={pbqRows} empty="No PBQ summary stored." />
      <DetailList
        title="Case-study Breakdown"
        rows={caseStudyRows}
        empty="No case-study summary stored."
      />

      <section className="saved-result-detail-section">
        <h4>Weak Areas</h4>
        {weakAreas.length > 0 ? (
          <ul>
            {weakAreas.map((area, index) => (
              <li key={`${formatWeakArea(area)}-${index}`}>{formatWeakArea(area)}</li>
            ))}
          </ul>
        ) : (
          <p>No weak-area summary was stored for this result.</p>
        )}
      </section>
    </div>
  );
}

function DetailList({ empty = 'No summary stored.', rows, title }) {
  return (
    <section className="saved-result-detail-section">
      <h4>{title}</h4>
      {rows.length > 0 ? (
        <ul>
          {rows.map(([key, value]) => (
            <li key={key}>
              <strong>{formatToken(key)}:</strong> {formatSummaryValue(value)}
            </li>
          ))}
        </ul>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}

function matchesTrainerAssignmentFilters(assignment, filters, selectedGroup) {
  const searchFields = [
    assignment.title,
    assignment.instructions,
    assignment.examTitle,
    assignment.targetLabel,
    assignment.groupName,
    assignment.studentName,
    assignment.assignedByName,
    assignment.progressLabel,
    assignment.status,
  ];

  return (
    matchesSearch(searchFields, filters.search) &&
    matchesGroupFilter(
      {
        groupId: assignment.groupId,
        groupName: assignment.groupName,
        targetStudents: assignment.targetStudents,
      },
      filters.groupId,
      selectedGroup,
    ) &&
    (!filters.examKey || normalizeTrainerExamKey(assignment.examKey) === normalizeTrainerExamKey(filters.examKey)) &&
    (!filters.progressStatus ||
      assignment.progressStatus === filters.progressStatus ||
      assignment.status === filters.progressStatus)
  );
}

function matchesTrainerGroupFilters(group, filters) {
  return (
    matchesSearch(
      [group.name, group.campusName, group.organisationName, group.status],
      filters.search,
    ) &&
    (!filters.groupId || group.id === filters.groupId)
  );
}

function matchesTrainerStudentFilters(student, filters) {
  return (
    matchesSearch(
      [
        student.displayName,
        student.email,
        student.groupName,
        student.campusName,
        student.organisationName,
        student.status,
      ],
      filters.search,
    ) &&
    (!filters.groupId || student.groupId === filters.groupId)
  );
}

function matchesTrainerResultFilters(result, filters, selectedGroup, selectedAssignment = null) {
  return (
    matchesSearch(
      [
        result.studentName,
        result.examTitle,
        result.modeLabel,
        result.profileLabel,
        result.groupName,
        result.campusName,
        formatPassFail(result.passed),
      ],
      filters.search,
    ) &&
    (!filters.organisationId || result.organisationId === filters.organisationId) &&
    (!filters.campusId || result.campusId === filters.campusId) &&
    matchesGroupFilter(result, filters.groupId, selectedGroup) &&
    (!selectedAssignment || normalizeTrainerExamKey(result.examKey) === normalizeTrainerExamKey(selectedAssignment.examKey)) &&
    (!filters.examKey || normalizeTrainerExamKey(result.examKey) === normalizeTrainerExamKey(filters.examKey)) &&
    matchesResultStatus(result, filters.resultStatus)
  );
}

function matchesResultStatus(result, statusFilter) {
  if (!statusFilter) {
    return true;
  }

  if (statusFilter === 'passed') {
    return result.passed === true;
  }

  if (statusFilter === 'needs-review') {
    return result.passed === false;
  }

  return result.passed !== true && result.passed !== false;
}

function matchesGroupFilter(record, groupId, selectedGroup) {
  if (!groupId) {
    return true;
  }

  if (record.groupId === groupId) {
    return true;
  }

  if (
    selectedGroup?.name &&
    normalizeFilterText(record.groupName) === normalizeFilterText(selectedGroup.name)
  ) {
    return true;
  }

  return (record.targetStudents ?? []).some(
    (student) => student.groupId === groupId,
  );
}

function matchesSearch(fields, search) {
  const query = normalizeFilterText(search);

  if (!query) {
    return true;
  }

  return fields.some((field) => normalizeFilterText(field).includes(query));
}

function matchesExactFilter(value, filterValue) {
  return !filterValue || String(value ?? '') === filterValue;
}

function normalizeFilterText(value) {
  return String(value ?? '').trim().toLowerCase();
}

function createUniqueOptions(values, labelFormatter = (value) => String(value)) {
  return [...new Set(values.filter(Boolean))].sort().map((value) => ({
    value,
    label: labelFormatter(value),
  }));
}

function createAssignmentSummaryPreview(summary = {}) {
  const studentRows = Array.isArray(summary?.studentRows)
    ? summary.studentRows
    : [];

  return {
    almostReadyCount: studentRows.filter(
      (student) => student.readinessStatus === 'almost-ready',
    ).length,
    dueSoonCount: summary?.dueSoonCount ?? 0,
    needsReviewCount: summary?.needsReviewCount ?? 0,
    notStartedCount: summary?.notStartedCount ?? 0,
    overdueCount: summary?.overdueCount ?? 0,
    readyCount: summary?.readyCount ?? 0,
  };
}

function formatOptional(value) {
  return value || value === 0 ? String(value) : 'Not recorded';
}

function formatExamCode(assignment = {}) {
  const examKey = normalizeFilterText(assignment.examKey || assignment.examSlug);
  const title = String(assignment.examTitle ?? '').trim();
  return getExamDisplayLabel(examKey || title, { fallback: title, field: 'code' });
}

function formatStatus(status) {
  return status ? formatToken(status) : 'Not recorded';
}

function formatToken(value) {
  return String(value ?? '')
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ') || 'Not recorded';
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

function formatScore(result) {
  if (result.scaledScore || result.scaledScore === 0) {
    return `${result.scaledScore}${result.passMark ? ` / ${result.passMark}+ pass mark` : ''}`;
  }

  return formatPercentage(result.rawPercentage);
}

function formatPercentage(value) {
  if (value || value === 0) {
    return `${Math.round(Number(value))}%`;
  }

  return 'Not recorded';
}

function formatPassFail(value) {
  if (value === true) {
    return 'Passed';
  }

  if (value === false) {
    return 'Needs review';
  }

  return 'Not recorded';
}

function formatAnalyticsScore(value) {
  if (value || value === 0) {
    return String(Math.round(Number(value)));
  }

  return 'Not recorded';
}

function formatAnalyticsRate(value) {
  if (value || value === 0) {
    return `${Math.round(Number(value))}%`;
  }

  return 'Not recorded';
}

function getReadinessSummaryRows({
  fallbackSummary = [],
  readinessStatus = '',
  rows = [],
}) {
  if (!readinessStatus) {
    return fallbackSummary;
  }

  return READINESS_STATUSES
    .filter((status) => status.id === readinessStatus)
    .map((status) => ({
      ...status,
      count: rows.filter((row) => row.readinessStatus === status.id).length,
    }));
}

function formatActivityAttemptNote(row = {}) {
  const total = row.activityAttemptCount ?? 0;
  const scoped = row.scopedAttemptCount ?? 0;

  if (total === scoped) {
    return `${total} total attempts for this exam`;
  }

  return `${total} total attempts across all exams`;
}

function getNoDomainDataMessage() {
  return 'No domain data is available for older saved results. New results will include domain breakdowns.';
}

function formatDomainAverage(domain = {}) {
  const label =
    domain.domainLabel ||
    domain.domain ||
    domain.label ||
    domain.domainId ||
    'Domain';
  const percentage = domain.averagePercentage ?? domain.percentage;
  const samples = domain.samples ? `, ${domain.samples} samples` : '';

  return `${label}: ${formatAnalyticsRate(percentage)}${samples}`;
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
          ? `${formatAnalyticsRate(domain.averagePercentage)} avg`
          : '';

      return [label, studentCount, average].filter(Boolean).join(' - ');
    })
    .join('; ');
}

function formatStudentPrimaryLabel(student = {}) {
  return (
    student.displayName ||
    getNameFromEmail(student.email) ||
    student.email ||
    'Student'
  );
}

function formatStudentSecondaryLabel(student = {}) {
  return [
    student.email,
    student.groupName,
    student.campusName,
  ]
    .filter(Boolean)
    .join(' / ');
}

function formatStudentSearchText(student = {}) {
  return [
    student.displayName,
    getNameFromEmail(student.email),
    student.email,
    student.groupName,
    student.campusName,
    student.organisationName,
    student.status,
  ]
    .filter(Boolean)
    .join(' ');
}

function getNameFromEmail(email) {
  const text = String(email ?? '').trim();

  return text.includes('@') ? text.split('@')[0] : '';
}

function objectEntries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value);
}

function getTrainerDomainRows(domainBreakdown = {}) {
  if (Array.isArray(domainBreakdown)) {
    return domainBreakdown
      .map((domain) => normalizeTrainerDomainRow(domain))
      .filter((domain) => domain.domainLabel);
  }

  if (!domainBreakdown || typeof domainBreakdown !== 'object') {
    return [];
  }

  if (Array.isArray(domainBreakdown.items)) {
    return domainBreakdown.items
      .map((domain) => normalizeTrainerDomainRow(domain))
      .filter((domain) => domain.domainLabel);
  }

  return Object.entries(domainBreakdown)
    .filter(([key]) => !['kind', 'source', 'summary', 'missingReason', 'byDomain'].includes(key))
    .map(([domain, value]) =>
      normalizeTrainerDomainRow(
        value && typeof value === 'object'
          ? {
              domain,
              ...value,
            }
          : {
              domain,
              percentage: value,
            },
      ),
    )
    .filter((domain) => domain.domainLabel);
}

function normalizeTrainerDomainRow(domain = {}) {
  const domainLabel = domain.domainLabel ?? domain.domain ?? domain.label ?? '';

  return {
    correct: domain.correct,
    domainId: domain.domainId ?? domain.id ?? domainLabel,
    domainLabel,
    earnedPoints: domain.earnedPoints,
    maxPoints: domain.maxPoints,
    percentage: domain.percentage,
    status: domain.status,
    total: domain.total,
  };
}

function normalizeScopedHistory(items = [], students = []) {
  const studentById = new Map(students.map((student) => [student.userId, student]));
  return items.map((item) => {
    const student = studentById.get(item.learnerId) ?? {};
    return {
      attemptId: item.attemptId,
      assignmentId: item.assignmentId,
      userId: item.learnerId,
      studentName: student.displayName || 'Student',
      studentEmail: student.email || '',
      groupName: student.groupName || '',
      groupId: student.groupId || '',
      campusName: student.campusName || '',
      campusId: student.campusId || '',
      organisationName: student.organisationName || '',
      organisationId: student.organisationId || '',
      submittedAt: item.completedAt,
      savedAt: item.completedAt,
      examKey: normalizeTrainerExamKey(item.examKey),
      examTitle: formatExamCode({ examKey: normalizeTrainerExamKey(item.examKey) }),
      profileId: item.profileKey,
      profileLabel: item.profileKey,
      modeLabel: item.purpose === 'assigned_assessment' ? 'Assigned assessment' : 'Self-directed exam',
      purpose: item.purpose,
      rawScore: item.score,
      rawPercentage: item.percentage,
      passed: item.passed,
      domainBreakdown: item.domainSummary ?? {},
      analyticsEligible: true,
      attemptKind: 'assessment',
      attemptKindLabel: 'Assessment',
      serverAuthoritative: item.serverAuthoritative === true,
      historySource: item.source,
    };
  });
}

function useDebouncedValue(value, delay) {
  const [debouncedValue, setDebouncedValue] = useState(value);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timeout);
  }, [delay, value]);

  return debouncedValue;
}

function mergeScopedAssignments(scopedAssignments = [], trackedAssignments = []) {
  const trackedById = new Map(
    trackedAssignments.map((assignment) => [assignment.assignmentId || assignment.id, assignment]),
  );
  return scopedAssignments.map((assignment) => {
    const tracked = trackedById.get(assignment.id) ?? {};
    return {
      ...tracked,
      assignmentId: assignment.id,
      id: assignment.id,
      title: assignment.name,
      examKey: normalizeTrainerExamKey(assignment.examKey),
      examTitle: formatExamCode({ examKey: normalizeTrainerExamKey(assignment.examKey) }),
      groupId: assignment.groupId || '',
      campusId: assignment.campusId || '',
      organisationId: assignment.organisationId || '',
      studentUserId: assignment.studentUserId || '',
      status: assignment.status || 'active',
      dueAt: assignment.dueAt || '',
      createdAt: assignment.createdAt || '',
      targetStudents: tracked.targetStudents ?? [],
      totalStudents: tracked.totalStudents ?? 0,
    };
  });
}

function normalizeTrainerExamKey(value) {
  const key = normalizeFilterText(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ['securityplussy0701', 'security-plus', 'security-plus-sy0-701'].includes(key)
    ? 'security-plus-sy0-701'
    : key;
}

function getTrainerDomainMissingMessage(domainBreakdown = {}) {
  return domainBreakdown?.missingReason ||
    'Legacy saved result: domain breakdown was not stored for this attempt. Newer eligible saved results include domain breakdowns when available.';
}

function formatDomainDetail(domain = {}) {
  const percentage =
    domain.percentage || domain.percentage === 0
      ? `${Math.round(Number(domain.percentage))}%`
      : 'Not recorded';
  const score =
    domain.earnedPoints !== null &&
    domain.earnedPoints !== undefined &&
    domain.maxPoints !== null &&
    domain.maxPoints !== undefined
      ? `${domain.earnedPoints}/${domain.maxPoints}`
      : domain.correct !== null &&
          domain.correct !== undefined &&
          domain.total !== null &&
          domain.total !== undefined
        ? `${domain.correct}/${domain.total}`
        : '';

  return [percentage, score, domain.status ? formatToken(domain.status) : '']
    .filter(Boolean)
    .join(' - ');
}

function formatSummaryValue(value) {
  if (value === null || value === undefined || value === '') {
    return 'Not recorded';
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }

  if (Array.isArray(value)) {
    return value.map(formatSummaryValue).join(', ');
  }

  if (typeof value === 'object') {
    const percentage = value.percentage ?? value.percent ?? value.rawPercentage;
    const score = value.score ?? value.correct ?? value.earned;
    const total = value.total ?? value.possible;

    if (percentage || percentage === 0) {
      return `${Math.round(Number(percentage))}%`;
    }

    if ((score || score === 0) && (total || total === 0)) {
      return `${score} / ${total}`;
    }

    return Object.entries(value)
      .slice(0, 3)
      .map(([key, nestedValue]) => `${formatToken(key)} ${formatSummaryValue(nestedValue)}`)
      .join('; ');
  }

  return String(value);
}

function formatWeakArea(area) {
  if (typeof area === 'string') {
    return area;
  }

  if (area && typeof area === 'object') {
    return [
      area.domain ?? area.name ?? area.label,
      area.percentage || area.percentage === 0
        ? `${Math.round(Number(area.percentage))}%`
        : '',
    ]
      .filter(Boolean)
      .join(' - ');
  }

  return 'Weak area';
}
