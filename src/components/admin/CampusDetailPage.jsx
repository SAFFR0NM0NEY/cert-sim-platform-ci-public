import { useEffect, useMemo, useState } from 'react';

import useOrganisationDetail from '../../hooks/useOrganisationDetail.js';
import { RECORD_STATUSES } from '../../lib/organisationManagementService.js';
import { hasActiveMembershipRole } from '../../lib/roleUtils.js';
import OnboardingManagementPanel from '../onboarding/OnboardingManagementPanel.jsx';
import {
  AdminDetailShell,
  CardFact,
  DetailStatePanel,
  FactList,
  FormSelectField,
  FormTextField,
  MembershipCards,
  RecordCards,
  SummaryTile,
  formatDate,
  formatTokenLabel,
} from './AdminDetailShared.jsx';

const emptyForm = {
  code: '',
  name: '',
  status: 'active',
};

export default function CampusDetailPage({
  campusId,
  onBackHome,
  onBackToManagement,
  onBrowseExams,
  onOpenGroupDetail,
}) {
  const detail = useOrganisationDetail('campus', campusId);
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
  const campus = snapshot.campus;
  const canView = canViewCampusDetail(detail, campus);
  const canEdit = canEditCampusDetail(detail, campus);
  const [form, setForm] = useState(emptyForm);
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  const activeMemberships = useMemo(
    () => (snapshot.memberships ?? []).filter((membership) => membership.status === 'active'),
    [snapshot.memberships],
  );

  useEffect(() => {
    if (!campus) {
      return;
    }

    setForm({
      code: campus.code || '',
      name: campus.name || '',
      status: campus.status || 'active',
    });
  }, [campus]);

  return (
    <AdminDetailShell
      eyebrow="Scoped admin"
      title="Campus Detail"
      onBackHome={onBackHome}
      onBackToManagement={onBackToManagement}
      onBrowseExams={onBrowseExams}
    >
      {!isSupabaseConfigured ? (
        <DetailStatePanel
          title="Campus detail is not configured here"
          note="This environment is running in frontend-only mode, so protected certification exams and scoped administration are unavailable."
        />
      ) : null}

      {isSupabaseConfigured && !isAuthenticated ? (
        <DetailStatePanel
          title="Sign in to continue"
          note="Sign in with a scoped admin, Developer, or Platform Owner account to view campus detail. Protected certification exams require sign-in and access."
        />
      ) : null}

      {isSupabaseConfigured && isAuthenticated && loading && !campus ? (
        <DetailStatePanel
          title="Loading campus..."
          note="CertSim is checking your campus management scope."
        />
      ) : null}

      {isSupabaseConfigured && isAuthenticated && !loading && !canView ? (
        <DetailStatePanel
          title="Campus detail is not available for this account"
          note="This page is limited to Platform Owner, Developer, College Admin, or Campus Admin memberships for the selected campus."
        />
      ) : null}

      {canView ? (
        <>
          {error ? <p className="auth-panel-error">{error}</p> : null}
          {actionMessage ? <p className="auth-panel-success">{actionMessage}</p> : null}
          {actionError ? <p className="auth-panel-error">{actionError}</p> : null}

          <section className="account-card trainer-assignment-hero">
            <div>
              <p className="eyebrow">Campus</p>
              <h2>{campus?.name || 'Campus'}</h2>
              <p>
                {campus?.organisation?.name || 'Organisation not recorded'} -{' '}
                {formatTokenLabel(campus?.status)}
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

          <section className="management-summary-grid" aria-label="Campus summary">
            <SummaryTile label="Groups/classes" value={snapshot.groups?.length ?? 0} />
            <SummaryTile label="Active memberships" value={activeMemberships.length} />
            <SummaryTile label="Total memberships" value={snapshot.memberships?.length ?? 0} />
            <SummaryTile label="Campus code" value={campus?.code || 'Not recorded'} />
          </section>

          <section className="management-section">
            <h3>Campus Record</h3>
            <FactList
              facts={[
                { label: 'Organisation', value: campus?.organisation?.name },
                { label: 'Code', value: campus?.code },
                { label: 'Status', value: formatTokenLabel(campus?.status) },
                { label: 'Created', value: formatDate(campus?.created_at) },
              ]}
            />
          </section>

          {canEdit ? (
            <section className="management-section no-print">
              <h3>Edit Campus</h3>
              <form className="assignment-detail-form" onSubmit={handleSave}>
                <FormTextField
                  label="Campus name"
                  required
                  value={form.name}
                  onChange={(value) => updateForm('name', value)}
                />
                <FormTextField
                  label="Code optional"
                  value={form.code}
                  onChange={(value) => updateForm('code', value)}
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
                    {saving ? 'Saving...' : 'Save campus'}
                  </button>
                </div>
              </form>
            </section>
          ) : null}

          <section className="management-section">
            <h3>Groups/classes</h3>
            <RecordCards
              emptyTitle="No visible groups"
              emptyNote="No group records are visible for this campus."
              items={snapshot.groups ?? []}
              renderItem={(group) => (
                <article className="trainer-assignment-card" key={group.id}>
                  <div className="trainer-assignment-card-header">
                    <div>
                      <h4>{group.name}</h4>
                      <p>{group.organisation?.name || 'Organisation not recorded'}</p>
                    </div>
                    <span className={`assignment-progress-pill ${group.status}`}>
                      {formatTokenLabel(group.status)}
                    </span>
                  </div>
                  <dl className="trainer-assignment-card-meta">
                    <CardFact label="Academic year" value={group.academic_year} />
                    <CardFact label="Max students" value={group.max_students} />
                  </dl>
                  <div className="trainer-assignment-card-footer no-print">
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      onClick={() => onOpenGroupDetail?.(group.id)}
                    >
                      Open group
                    </button>
                  </div>
                </article>
              )}
            />
          </section>

          <section className="management-section">
            <h3>Campus Memberships</h3>
            <MembershipCards memberships={snapshot.memberships ?? []} />
          </section>

          <OnboardingManagementPanel
            canManage={canEdit}
            campusId={campusId}
            scopeLabel="campus"
            scopeType="campus"
          />
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
      setActionMessage('Campus updated.');
    } else {
      setActionError(result.message);
    }

    setSaving(false);
  }
}

function canViewCampusDetail(identity, campus) {
  if (identity.isPlatformOwner) {
    return true;
  }

  if (hasActiveMembershipRole(identity?.memberships, ['developer'])) {
    return true;
  }

  if (!campus) {
    return false;
  }

  return (identity.memberships ?? []).some(
    (membership) =>
      membership.status === 'active' &&
      (
        (membership.role === 'college_admin' &&
          membership.organisation_id === campus.organisation_id) ||
        (membership.role === 'campus_admin' && membership.campus_id === campus.id)
      ),
  );
}

function canEditCampusDetail(identity, campus) {
  if (identity.isPlatformOwner) {
    return true;
  }

  if (!campus) {
    return false;
  }

  return (identity.memberships ?? []).some(
    (membership) =>
      membership.status === 'active' &&
      (
        (membership.role === 'college_admin' &&
          membership.organisation_id === campus.organisation_id) ||
        (membership.role === 'campus_admin' && membership.campus_id === campus.id)
      ),
  );
}
