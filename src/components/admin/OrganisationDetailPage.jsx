import { useEffect, useMemo, useState } from 'react';

import useOrganisationDetail from '../../hooks/useOrganisationDetail.js';
import {
  ORGANISATION_TYPES,
  RECORD_STATUSES,
} from '../../lib/organisationManagementService.js';
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
  billing_model: '',
  name: '',
  notes: '',
  organisation_type: 'training_provider',
  status: 'active',
};

export default function OrganisationDetailPage({
  organisationId,
  onBackHome,
  onBackToManagement,
  onBrowseExams,
  onOpenCampusDetail,
  onOpenGroupDetail,
}) {
  const detail = useOrganisationDetail('organisation', organisationId);
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
  const organisation = snapshot.organisation;
  const canView = canViewOrganisationDetail(detail, organisationId);
  const canEdit = canEditOrganisationDetail(detail, organisationId);
  const [form, setForm] = useState(emptyForm);
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [saving, setSaving] = useState(false);
  const activeMemberships = useMemo(
    () => (snapshot.memberships ?? []).filter((membership) => membership.status === 'active'),
    [snapshot.memberships],
  );

  useEffect(() => {
    if (!organisation) {
      return;
    }

    setForm({
      billing_model: organisation.billing_model || '',
      name: organisation.name || '',
      notes: organisation.notes || '',
      organisation_type: organisation.organisation_type || 'training_provider',
      status: organisation.status || 'active',
    });
  }, [organisation]);

  return (
    <AdminDetailShell
      eyebrow="Scoped admin"
      title="Organisation Detail"
      onBackHome={onBackHome}
      onBackToManagement={onBackToManagement}
      onBrowseExams={onBrowseExams}
    >
      {!isSupabaseConfigured ? (
        <DetailStatePanel
          title="Organisation detail is not configured here"
          note="This environment is running in frontend-only mode, so protected certification exams and scoped administration are unavailable."
        />
      ) : null}

      {isSupabaseConfigured && !isAuthenticated ? (
        <DetailStatePanel
          title="Sign in to continue"
          note="Sign in with a scoped admin, Developer, or Platform Owner account to view organisation detail. Protected certification exams require sign-in and access."
        />
      ) : null}

      {isSupabaseConfigured && isAuthenticated && loading && !organisation ? (
        <DetailStatePanel
          title="Loading organisation..."
          note="CertSim is checking your scoped management access."
        />
      ) : null}

      {isSupabaseConfigured && isAuthenticated && !loading && !canView ? (
        <DetailStatePanel
          title="Organisation detail is not available for this account"
          note="This page is limited to Platform Owner, Developer, and College Admin memberships for the selected organisation."
        />
      ) : null}

      {canView ? (
        <>
          {error ? <p className="auth-panel-error">{error}</p> : null}
          {actionMessage ? <p className="auth-panel-success">{actionMessage}</p> : null}
          {actionError ? <p className="auth-panel-error">{actionError}</p> : null}

          <section className="account-card trainer-assignment-hero">
            <div>
              <p className="eyebrow">Organisation</p>
              <h2>{organisation?.name || 'Organisation'}</h2>
              <p>
                {formatTokenLabel(organisation?.organisation_type)} -{' '}
                {formatTokenLabel(organisation?.status)}
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

          <section className="management-summary-grid" aria-label="Organisation summary">
            <SummaryTile label="Campuses" value={snapshot.campuses?.length ?? 0} />
            <SummaryTile label="Groups/classes" value={snapshot.groups?.length ?? 0} />
            <SummaryTile label="Active memberships" value={activeMemberships.length} />
            <SummaryTile label="Total memberships" value={snapshot.memberships?.length ?? 0} />
          </section>

          <section className="management-section">
            <h3>Organisation Record</h3>
            <FactList
              facts={[
                { label: 'Type', value: formatTokenLabel(organisation?.organisation_type) },
                { label: 'Status', value: formatTokenLabel(organisation?.status) },
                { label: 'Billing model', value: organisation?.billing_model },
                { label: 'Created', value: formatDate(organisation?.created_at) },
              ]}
            />
            <p>{organisation?.notes || 'No notes recorded.'}</p>
          </section>

          {canEdit ? (
            <section className="management-section no-print">
              <h3>Edit Organisation</h3>
              <form className="assignment-detail-form" onSubmit={handleSave}>
                <FormTextField
                  label="Name"
                  required
                  value={form.name}
                  onChange={(value) => updateForm('name', value)}
                />
                <FormSelectField
                  label="Organisation type"
                  value={form.organisation_type}
                  options={ORGANISATION_TYPES.map((type) => ({
                    value: type,
                    label: formatTokenLabel(type),
                  }))}
                  onChange={(value) => updateForm('organisation_type', value)}
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
                <FormTextField
                  label="Billing model optional"
                  value={form.billing_model}
                  onChange={(value) => updateForm('billing_model', value)}
                />
                <label className="assignment-detail-form-wide">
                  Notes
                  <textarea
                    rows="3"
                    value={form.notes}
                    onChange={(event) => updateForm('notes', event.target.value)}
                  />
                </label>
                <div className="button-row wrap assignment-detail-form-wide">
                  <button className="primary-button" disabled={saving} type="submit">
                    {saving ? 'Saving...' : 'Save organisation'}
                  </button>
                </div>
              </form>
            </section>
          ) : null}

          <section className="management-section">
            <h3>Campuses</h3>
            <RecordCards
              emptyTitle="No visible campuses"
              emptyNote="No campus records are visible for this organisation."
              items={snapshot.campuses ?? []}
              renderItem={(campus) => (
                <article className="trainer-assignment-card" key={campus.id}>
                  <div className="trainer-assignment-card-header">
                    <div>
                      <h4>{campus.name}</h4>
                      <p>{campus.code || 'No campus code'}</p>
                    </div>
                    <span className={`assignment-progress-pill ${campus.status}`}>
                      {formatTokenLabel(campus.status)}
                    </span>
                  </div>
                  <div className="trainer-assignment-card-footer no-print">
                    <button
                      className="secondary-button compact-button"
                      type="button"
                      onClick={() => onOpenCampusDetail?.(campus.id)}
                    >
                      Open campus
                    </button>
                  </div>
                </article>
              )}
            />
          </section>

          <section className="management-section">
            <h3>Groups/classes</h3>
            <RecordCards
              emptyTitle="No visible groups"
              emptyNote="No group records are visible for this organisation."
              items={snapshot.groups ?? []}
              renderItem={(group) => (
                <article className="trainer-assignment-card" key={group.id}>
                  <div className="trainer-assignment-card-header">
                    <div>
                      <h4>{group.name}</h4>
                      <p>{group.campus?.name || 'No campus recorded'}</p>
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
            <h3>Memberships</h3>
            <MembershipCards memberships={snapshot.memberships ?? []} />
          </section>

          <OnboardingManagementPanel
            canManage={canEdit}
            organisationId={organisationId}
            scopeLabel="organisation"
            scopeType="organisation"
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
      setActionMessage('Organisation updated.');
    } else {
      setActionError(result.message);
    }

    setSaving(false);
  }
}

function canViewOrganisationDetail(identity, organisationId) {
  if (identity.isPlatformOwner) {
    return true;
  }

  if (hasActiveMembershipRole(identityMemberships(identity), ['developer'])) {
    return true;
  }

  return (identityMemberships(identity) ?? []).some(
    (membership) =>
      membership.role === 'college_admin' &&
      membership.status === 'active' &&
      membership.organisation_id === organisationId,
  );
}

function canEditOrganisationDetail(identity, organisationId) {
  if (identity.isPlatformOwner) {
    return true;
  }

  return (identityMemberships(identity) ?? []).some(
    (membership) =>
      membership.role === 'college_admin' &&
      membership.status === 'active' &&
      membership.organisation_id === organisationId,
  );
}

function identityMemberships(identity) {
  return identity?.memberships ?? [];
}
