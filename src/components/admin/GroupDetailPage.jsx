import { useEffect, useMemo, useState } from 'react';

import useOrganisationDetail from '../../hooks/useOrganisationDetail.js';
import { RECORD_STATUSES } from '../../lib/organisationManagementService.js';
import { hasActiveMembershipRole } from '../../lib/roleUtils.js';
import OnboardingManagementPanel from '../onboarding/OnboardingManagementPanel.jsx';
import {
  AdminDetailShell,
  AssignmentCards,
  CardFact,
  DetailStatePanel,
  FactList,
  FormSelectField,
  FormTextField,
  MembershipCards,
  SavedResultCards,
  SummaryTile,
  formatDate,
  formatTokenLabel,
} from './AdminDetailShared.jsx';

const emptyForm = {
  academic_year: '',
  max_students: '50',
  name: '',
  status: 'active',
};

export default function GroupDetailPage({
  groupId,
  onBackHome,
  onBackToManagement,
  onBrowseExams,
  onOpenAssignment,
  onOpenSavedResult,
  onOpenStudentReport,
}) {
  const detail = useOrganisationDetail('group', groupId);
  const {
    detailLoading,
    error,
    isAuthenticated,
    isSupabaseConfigured,
    loading,
    refresh,
    snapshot,
    updateDetail,
  } = detail;
  const group = snapshot.group;
  const canView = canViewGroupDetail(detail, group);
  const canEdit = canEditGroupDetail(detail, group);
  const [form, setForm] = useState(emptyForm);
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  const activeStudents = useMemo(
    () => (snapshot.students ?? []).filter((student) => student.status === 'active'),
    [snapshot.students],
  );

  useEffect(() => {
    if (!group) {
      return;
    }

    setForm({
      academic_year: group.academic_year || '',
      max_students: String(group.max_students ?? 50),
      name: group.name || '',
      status: group.status || 'active',
    });
  }, [group]);

  return (
    <AdminDetailShell
      eyebrow="Scoped class"
      title="Group Detail"
      onBackHome={onBackHome}
      onBackToManagement={onBackToManagement}
      onBrowseExams={onBrowseExams}
    >
      {!isSupabaseConfigured ? (
        <DetailStatePanel
          title="Group detail is not configured here"
          note="This environment is running in frontend-only mode, so protected certification exams and scoped group detail are unavailable."
        />
      ) : null}

      {isSupabaseConfigured && !isAuthenticated ? (
        <DetailStatePanel
          title="Sign in to continue"
          note="Sign in with a trainer, scoped admin, Developer, or Platform Owner account to view group detail. Protected certification exams require sign-in and access."
        />
      ) : null}

      {isSupabaseConfigured && isAuthenticated && loading && !group ? (
        <DetailStatePanel
          title="Loading group..."
          note="CertSim is checking your assigned class and admin scope."
        />
      ) : null}

      {isSupabaseConfigured && isAuthenticated && !loading && !canView ? (
        <DetailStatePanel
          title="Group detail is not available for this account"
          note="This page is limited to scoped admins, Developers, and trainers assigned to the selected group/class."
        />
      ) : null}

      {canView ? (
        <>
          {error ? <p className="auth-panel-error">{error}</p> : null}
          {actionMessage ? <p className="auth-panel-success">{actionMessage}</p> : null}
          {actionError ? <p className="auth-panel-error">{actionError}</p> : null}

          <section className="account-card trainer-assignment-hero">
            <div>
              <p className="eyebrow">Group/class</p>
              <h2>{group?.name || 'Group/class'}</h2>
              <p>
                {group?.organisation?.name || 'Organisation not recorded'} -{' '}
                {group?.campus?.name || 'No campus recorded'}
              </p>
            </div>
            <button
              className="secondary-button compact-button no-print"
              disabled={detailLoading}
              type="button"
              onClick={refresh}
            >
              {detailLoading ? 'Refreshing...' : 'Refresh'}
            </button>
          </section>

          <section className="management-summary-grid" aria-label="Group summary">
            <SummaryTile label="Active students" value={activeStudents.length} />
            <SummaryTile label="Assignments" value={snapshot.assignments?.length ?? 0} />
            <SummaryTile label="Saved results" value={snapshot.savedResults?.length ?? 0} />
            <SummaryTile label="Max students" value={group?.max_students} />
          </section>

          <section className="management-section">
            <h3>Group Record</h3>
            <FactList
              facts={[
                { label: 'Organisation', value: group?.organisation?.name },
                { label: 'Campus', value: group?.campus?.name },
                { label: 'Academic year', value: group?.academic_year },
                { label: 'Status', value: formatTokenLabel(group?.status) },
                { label: 'Created', value: formatDate(group?.created_at) },
              ]}
            />
          </section>

          {canEdit ? (
            <section className="management-section no-print">
              <h3>Edit Group/Class</h3>
              <form className="assignment-detail-form" onSubmit={handleSave}>
                <FormTextField
                  label="Group/class name"
                  required
                  value={form.name}
                  onChange={(value) => updateForm('name', value)}
                />
                <FormTextField
                  label="Academic year optional"
                  type="number"
                  value={String(form.academic_year)}
                  onChange={(value) => updateForm('academic_year', value)}
                />
                <FormTextField
                  label="Max students"
                  type="number"
                  value={String(form.max_students)}
                  onChange={(value) => updateForm('max_students', value)}
                />
                <FormSelectField
                  label="Status"
                  value={form.status}
                  options={RECORD_STATUSES.map((status) => ({
                    value: status,
                    label: formatTokenLabel(status),
                  }))}
                  onChange={(value) => updateForm('status', value)}
                />
                <div className="button-row wrap assignment-detail-form-wide">
                  <button className="primary-button" disabled={saving} type="submit">
                    {saving ? 'Saving...' : 'Save group'}
                  </button>
                </div>
              </form>
            </section>
          ) : null}

          <section className="management-section">
            <h3>Students</h3>
            <MembershipCards memberships={snapshot.students ?? []} />
          </section>

          <OnboardingManagementPanel
            canManage={canEdit}
            enableBulk
            groupId={groupId}
            scopeLabel="group/class"
            scopeType="group"
          />

          <section className="management-section">
            <div className="saved-result-detail-header">
              <div>
                <h3>Assignments</h3>
                <p>
                  Assignment reminders stay display-only. This view does not
                  enforce exam access.
                </p>
              </div>
            </div>
            <AssignmentCards
              assignments={snapshot.assignments ?? []}
              onOpenAssignment={onOpenAssignment}
            />
          </section>

          <section className="management-section">
            <div className="saved-result-detail-header">
              <div>
                <h3>Saved Results</h3>
                <p>
                  Shows submitted saved results for visible students in this
                  group only.
                </p>
              </div>
            </div>
            <SavedResultCards
              results={snapshot.savedResults ?? []}
              onOpenSavedResult={onOpenSavedResult}
            />
          </section>

          {onOpenStudentReport && activeStudents.length > 0 ? (
            <section className="management-section no-print">
              <h3>Student Detail Shortcuts</h3>
              <div className="assignment-card-list">
                {activeStudents.map((student) => (
                  <article className="trainer-assignment-card" key={student.id}>
                    <div className="trainer-assignment-card-header">
                      <div>
                        <h4>{student.profile?.display_name || student.profile?.full_name || 'Student'}</h4>
                        <p>{student.profile?.email || 'Email not recorded'}</p>
                      </div>
                      <button
                        className="secondary-button compact-button"
                        type="button"
                        onClick={() => onOpenStudentReport(student.user_id)}
                      >
                        Open student report
                      </button>
                    </div>
                    <dl className="trainer-assignment-card-meta">
                      <CardFact label="Role" value={formatTokenLabel(student.role)} />
                      <CardFact label="Status" value={formatTokenLabel(student.status)} />
                    </dl>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </AdminDetailShell>
  );

  function updateForm(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSave(event) {
    event.preventDefault();
    setSaving(true);
    setActionMessage('');
    setActionError('');

    const result = await updateDetail(form);

    if (result.ok) {
      setActionMessage('Group updated.');
    } else {
      setActionError(result.message);
    }

    setSaving(false);
  }
}

function canViewGroupDetail(identity, group) {
  if (identity.isPlatformOwner) {
    return true;
  }

  if (hasActiveMembershipRole(identity?.memberships, ['developer'])) {
    return true;
  }

  if (!group) {
    return false;
  }

  return (identity.memberships ?? []).some((membership) => {
    if (membership.status !== 'active') {
      return false;
    }

    if (
      membership.role === 'college_admin' &&
      membership.organisation_id === group.organisation_id
    ) {
      return true;
    }

    if (
      membership.role === 'campus_admin' &&
      membership.campus_id &&
      membership.campus_id === group.campus_id
    ) {
      return true;
    }

    if (membership.role !== 'trainer') {
      return false;
    }

    return (
      membership.group_id === group.id ||
      (!membership.group_id &&
        membership.campus_id &&
        membership.campus_id === group.campus_id) ||
      (!membership.group_id &&
        !membership.campus_id &&
        membership.organisation_id === group.organisation_id)
    );
  });
}

function canEditGroupDetail(identity, group) {
  if (identity.isPlatformOwner) {
    return true;
  }

  if (!group) {
    return false;
  }

  return (identity.memberships ?? []).some(
    (membership) =>
      membership.status === 'active' &&
      (
        (membership.role === 'college_admin' &&
          membership.organisation_id === group.organisation_id) ||
        (membership.role === 'campus_admin' &&
          membership.campus_id &&
          membership.campus_id === group.campus_id)
      ),
  );
}
