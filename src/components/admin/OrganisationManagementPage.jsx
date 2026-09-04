import { useMemo, useState } from 'react';

import useOrganisationManagement from '../../hooks/useOrganisationManagement.js';
import {
  MEMBERSHIP_CREATE_STATUSES,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  ORGANISATION_TYPES,
  RECORD_STATUSES,
} from '../../lib/organisationManagementService.js';
import { getRoleLabel } from '../../lib/roleUtils.js';
import SearchableProfilePicker from '../shared/SearchableProfilePicker.jsx';

const initialOrganisationForm = {
  name: '',
  organisation_type: 'training_provider',
  billing_model: '',
  notes: '',
};

const initialCampusForm = {
  organisation_id: '',
  name: '',
  code: '',
};

const initialGroupForm = {
  organisation_id: '',
  campus_id: '',
  name: '',
  academic_year: '',
  max_students: '50',
};

const initialMembershipForm = {
  user_id: '',
  organisation_id: '',
  campus_id: '',
  group_id: '',
  role: 'student',
  status: 'active',
};

const initialProfileDisplayForm = {
  profile_id: '',
  display_name: '',
  full_name: '',
};

const STATUS_FILTER_OPTIONS = [
  ...new Set([...RECORD_STATUSES, ...MEMBERSHIP_STATUSES, 'deactivated']),
];

export default function OrganisationManagementPage({
  onBackHome,
  onBrowseExams,
  onOpenCampusDetail,
  onOpenGroupDetail,
  onOpenOrganisationDetail,
}) {
  const management = useOrganisationManagement();
  const {
    campuses,
    createCampus,
    createGroup,
    createMembership,
    createOrganisation,
    error,
    groups,
    isAuthenticated,
    isPlatformOwner,
    isSupabaseConfigured,
    loading,
    managementLoading,
    memberships,
    organisations,
    profiles,
    refresh,
    removeMembershipRole,
    updateProfileDisplayName,
    updateProfileStatus,
    updateMembershipStatus,
  } = management;
  const [organisationForm, setOrganisationForm] = useState(initialOrganisationForm);
  const [campusForm, setCampusForm] = useState(initialCampusForm);
  const [groupForm, setGroupForm] = useState(initialGroupForm);
  const [membershipForm, setMembershipForm] = useState(initialMembershipForm);
  const [profileDisplayForm, setProfileDisplayForm] = useState(
    initialProfileDisplayForm,
  );
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [showInactiveMemberships, setShowInactiveMemberships] = useState(false);
  const [managementFilters, setManagementFilters] = useState({
    campusId: '',
    groupId: '',
    organisationId: '',
    role: '',
    search: '',
    status: '',
  });
  const [activeManagementSection, setActiveManagementSection] =
    useState('overview');
  const campusOptions = useMemo(
    () =>
      campuses.filter(
        (campus) =>
          !groupForm.organisation_id ||
          campus.organisation_id === groupForm.organisation_id,
      ),
    [campuses, groupForm.organisation_id],
  );
  const membershipCampusOptions = useMemo(
    () =>
      campuses.filter(
        (campus) =>
          !membershipForm.organisation_id ||
          campus.organisation_id === membershipForm.organisation_id,
      ),
    [campuses, membershipForm.organisation_id],
  );
  const membershipGroupOptions = useMemo(
    () =>
      groups.filter(
        (group) =>
          (!membershipForm.organisation_id ||
            group.organisation_id === membershipForm.organisation_id) &&
          (!membershipForm.campus_id ||
            group.campus_id === membershipForm.campus_id),
      ),
    [groups, membershipForm.campus_id, membershipForm.organisation_id],
  );
  const filteredOrganisations = useMemo(
    () =>
      organisations.filter((organisation) =>
        matchesOrganisationFilters(organisation, managementFilters),
      ),
    [managementFilters, organisations],
  );
  const filteredCampuses = useMemo(
    () =>
      campuses.filter((campus) =>
        matchesCampusFilters(campus, managementFilters),
      ),
    [campuses, managementFilters],
  );
  const filteredGroups = useMemo(
    () =>
      groups.filter((group) =>
        matchesGroupFilters(group, managementFilters),
      ),
    [groups, managementFilters],
  );
  const filteredProfiles = useMemo(
    () =>
      profiles.filter((profile) =>
        matchesProfileFilters(profile, managementFilters),
      ),
    [managementFilters, profiles],
  );
  const filteredMemberships = useMemo(
    () =>
      memberships.filter((membership) =>
        (showInactiveMemberships || membership.status === 'active') &&
        matchesMembershipFilters(membership, managementFilters),
      ),
    [managementFilters, memberships, showInactiveMemberships],
  );

  if (!isSupabaseConfigured) {
    return (
      <ManagementShell onBackHome={onBackHome} onBrowseExams={onBrowseExams}>
        <StatePanel
          title="Organisation management is not configured here"
          note="This environment is running in frontend-only mode, so protected certification exams and Platform Owner management are unavailable."
        />
      </ManagementShell>
    );
  }

  if (!isAuthenticated) {
    return (
      <ManagementShell onBackHome={onBackHome} onBrowseExams={onBrowseExams}>
        <StatePanel
          title="Sign in to continue"
          note="Sign in with a Platform Owner account to manage organisations, campuses, groups, profiles, and memberships. Protected certification exams require sign-in and access."
        />
      </ManagementShell>
    );
  }

  if (loading && !isPlatformOwner) {
    return (
      <ManagementShell onBackHome={onBackHome} onBrowseExams={onBrowseExams}>
        <StatePanel
          title="Checking management access..."
          note="CertSim is reading your profile and membership role."
        />
      </ManagementShell>
    );
  }

  if (!isPlatformOwner) {
    return (
      <ManagementShell onBackHome={onBackHome} onBrowseExams={onBrowseExams}>
        <StatePanel
          title="Management access is not available for this account"
          note="This page is limited to active Platform Owner memberships. Normal exam access remains unchanged."
        />
      </ManagementShell>
    );
  }

  return (
    <ManagementShell onBackHome={onBackHome} onBrowseExams={onBrowseExams}>
      {error ? <p className="auth-panel-error">{error}</p> : null}
      {actionMessage ? <p className="auth-panel-success">{actionMessage}</p> : null}
      {actionError ? <p className="auth-panel-error">{actionError}</p> : null}

      <SectionTabs
        activeSection={activeManagementSection}
        sections={[
          { id: 'overview', label: 'Overview' },
          { id: 'organisations', label: 'Organisations' },
          { id: 'campuses', label: 'Campuses' },
          { id: 'groups', label: 'Groups/classes' },
          { id: 'profiles', label: 'Profiles' },
          { id: 'memberships', label: 'Memberships/roles' },
        ]}
        onSelect={setActiveManagementSection}
      />

      {activeManagementSection === 'overview' && (
        <>
          <section className="management-summary-grid" aria-label="Management summary">
            <SummaryTile label="Organisations" value={organisations.length} />
            <SummaryTile label="Campuses" value={campuses.length} />
            <SummaryTile label="Groups/classes" value={groups.length} />
            <SummaryTile label="Profiles" value={profiles.length} />
            <SummaryTile label="Memberships" value={memberships.length} />
          </section>

          <div className="management-actions no-print">
            <button
              className="secondary-button"
              disabled={managementLoading}
              type="button"
              onClick={refresh}
            >
              {managementLoading ? 'Refreshing...' : 'Refresh records'}
            </button>
          </div>
        </>
      )}

      {activeManagementSection !== 'overview' && (
        <ManagementFilterPanel
          title="Filters"
          intro="Filter loaded records locally. This does not create accounts or change backend permissions."
        >
          <FilterTextInput
            label="Search"
            value={managementFilters.search}
            onChange={(value) => updateManagementFilter('search', value)}
          />
          <FilterSelect
            label="Organisation"
            value={managementFilters.organisationId}
            options={organisations.map((organisation) => ({
              value: organisation.id,
              label: organisation.name,
            }))}
            placeholder="All organisations"
            onChange={(value) => updateManagementFilter('organisationId', value)}
          />
          <FilterSelect
            label="Campus"
            value={managementFilters.campusId}
            options={campuses.map((campus) => ({
              value: campus.id,
              label: [campus.name, campus.organisation?.name]
                .filter(Boolean)
                .join(' / '),
            }))}
            placeholder="All campuses"
            onChange={(value) => updateManagementFilter('campusId', value)}
          />
          <FilterSelect
            label="Group/class"
            value={managementFilters.groupId}
            options={groups.map((group) => ({
              value: group.id,
              label: [group.name, group.campus?.name]
                .filter(Boolean)
                .join(' / '),
            }))}
            placeholder="All groups"
            onChange={(value) => updateManagementFilter('groupId', value)}
          />
          <FilterSelect
            label="Role"
            value={managementFilters.role}
            options={MEMBERSHIP_ROLES.map((role) => ({
              value: role,
              label: getRoleLabel(role),
            }))}
            placeholder="All roles"
            onChange={(value) => updateManagementFilter('role', value)}
          />
          <FilterSelect
            label="Status"
            value={managementFilters.status}
            options={STATUS_FILTER_OPTIONS.map((status) => ({
              value: status,
              label: formatTokenLabel(status),
            }))}
            placeholder="All statuses"
            onChange={(value) => updateManagementFilter('status', value)}
          />
          <FilterSummary
            label="Filtered view"
            value={`${filteredMemberships.length} memberships, ${filteredProfiles.length} profiles`}
          />
          <button
            className="secondary-button compact-button"
            type="button"
            onClick={clearManagementFilters}
          >
            Clear filters
          </button>
        </ManagementFilterPanel>
      )}

      {activeManagementSection === 'organisations' && (
      <ManagementSection
        title="Organisations"
        intro="Create training providers, companies, or internal CertSim ownership records."
      >
        <details className="management-collapsible no-print">
          <summary>Create organisation</summary>
          <form
          className="management-form"
          onSubmit={(event) =>
            handleSubmit(event, 'organisation', async () => {
              const result = await createOrganisation(organisationForm);

              if (result.ok) {
                setOrganisationForm(initialOrganisationForm);
              }

              return result;
            })
          }
        >
          <TextInput
            label="Name"
            value={organisationForm.name}
            onChange={(value) => updateOrganisationForm('name', value)}
            required
          />
          <SelectInput
            label="Organisation type"
            value={organisationForm.organisation_type}
            onChange={(value) =>
              updateOrganisationForm('organisation_type', value)
            }
            options={ORGANISATION_TYPES.map((type) => ({
              value: type,
              label: formatTokenLabel(type),
            }))}
          />
          <TextInput
            label="Billing model optional"
            value={organisationForm.billing_model}
            onChange={(value) => updateOrganisationForm('billing_model', value)}
          />
          <TextInput
            label="Notes optional"
            value={organisationForm.notes}
            onChange={(value) => updateOrganisationForm('notes', value)}
          />
          <button
            className="primary-button"
            disabled={busyAction === 'organisation'}
            type="submit"
          >
            {busyAction === 'organisation' ? 'Creating...' : 'Create organisation'}
          </button>
          </form>
        </details>
        <RecordTable
          columns={['Name', 'Type', 'Status', 'Created', 'Actions']}
          emptyMessage="No organisations found."
          rows={filteredOrganisations.map((organisation) => [
            <strong className="record-primary">{organisation.name}</strong>,
            formatTokenLabel(organisation.organisation_type),
            <span className="status-text-cell">{formatTokenLabel(organisation.status)}</span>,
            <span className="date-cell">{formatDate(organisation.created_at)}</span>,
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={() => onOpenOrganisationDetail?.(organisation.id)}
            >
              Open
            </button>,
          ])}
        />
      </ManagementSection>
      )}

      {activeManagementSection === 'campuses' && (
      <ManagementSection
        title="Campuses"
        intro="Create campus or branch records under an organisation."
      >
        <details className="management-collapsible no-print">
          <summary>Create campus</summary>
          <form
          className="management-form"
          onSubmit={(event) =>
            handleSubmit(event, 'campus', async () => {
              const result = await createCampus(campusForm);

              if (result.ok) {
                setCampusForm({
                  ...initialCampusForm,
                  organisation_id: campusForm.organisation_id,
                });
              }

              return result;
            })
          }
        >
          <SelectInput
            label="Organisation"
            value={campusForm.organisation_id}
            onChange={(value) => updateCampusForm('organisation_id', value)}
            options={organisations.map((organisation) => ({
              value: organisation.id,
              label: organisation.name,
            }))}
            placeholder="Choose organisation"
            required
          />
          <TextInput
            label="Campus name"
            value={campusForm.name}
            onChange={(value) => updateCampusForm('name', value)}
            required
          />
          <TextInput
            label="Code optional"
            value={campusForm.code}
            onChange={(value) => updateCampusForm('code', value)}
          />
          <button
            className="primary-button"
            disabled={busyAction === 'campus'}
            type="submit"
          >
            {busyAction === 'campus' ? 'Creating...' : 'Create campus'}
          </button>
          </form>
        </details>
        <RecordTable
          columns={['Campus', 'Organisation', 'Code', 'Status', 'Actions']}
          emptyMessage="No campuses found."
          rows={filteredCampuses.map((campus) => [
            <strong className="record-primary">{campus.name}</strong>,
            campus.organisation?.name ?? 'Unknown organisation',
            campus.code || '-',
            <span className="status-text-cell">{formatTokenLabel(campus.status)}</span>,
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={() => onOpenCampusDetail?.(campus.id)}
            >
              Open
            </button>,
          ])}
        />
      </ManagementSection>
      )}

      {activeManagementSection === 'groups' && (
      <ManagementSection
        title="Groups/classes"
        intro="Create study groups or classes for later assignment and reporting workflows."
      >
        <details className="management-collapsible no-print">
          <summary>Create group</summary>
          <form
          className="management-form"
          onSubmit={(event) =>
            handleSubmit(event, 'group', async () => {
              const result = await createGroup(groupForm);

              if (result.ok) {
                setGroupForm({
                  ...initialGroupForm,
                  organisation_id: groupForm.organisation_id,
                  campus_id: groupForm.campus_id,
                });
              }

              return result;
            })
          }
        >
          <SelectInput
            label="Organisation"
            value={groupForm.organisation_id}
            onChange={(value) => {
              setGroupForm((current) => ({
                ...current,
                organisation_id: value,
                campus_id: '',
              }));
            }}
            options={organisations.map((organisation) => ({
              value: organisation.id,
              label: organisation.name,
            }))}
            placeholder="Choose organisation"
            required
          />
          <SelectInput
            label="Campus optional"
            value={groupForm.campus_id}
            onChange={(value) => updateGroupForm('campus_id', value)}
            options={campusOptions.map((campus) => ({
              value: campus.id,
              label: campus.name,
            }))}
            placeholder="No campus"
          />
          <TextInput
            label="Group/class name"
            value={groupForm.name}
            onChange={(value) => updateGroupForm('name', value)}
            required
          />
          <TextInput
            label="Academic year optional"
            type="number"
            value={groupForm.academic_year}
            onChange={(value) => updateGroupForm('academic_year', value)}
          />
          <TextInput
            label="Max students"
            type="number"
            value={groupForm.max_students}
            onChange={(value) => updateGroupForm('max_students', value)}
          />
          <button
            className="primary-button"
            disabled={busyAction === 'group'}
            type="submit"
          >
            {busyAction === 'group' ? 'Creating...' : 'Create group'}
          </button>
          </form>
        </details>
        <RecordTable
          columns={['Group', 'Organisation', 'Campus', 'Max', 'Actions']}
          emptyMessage="No groups/classes found."
          rows={filteredGroups.map((group) => [
            <strong className="record-primary">{group.name}</strong>,
            group.organisation?.name ?? 'Unknown organisation',
            group.campus?.name ?? '-',
            group.max_students ?? '-',
            <button
              className="secondary-button compact-button"
              type="button"
              onClick={() => onOpenGroupDetail?.(group.id)}
            >
              Open
            </button>,
          ])}
        />
      </ManagementSection>
      )}

      {activeManagementSection === 'profiles' && (
      <ManagementSection
        title="Profiles"
        intro="Profile/account records identify users. Deactivating a profile changes CertSim profile status only; historical results and reports remain."
      >
        <details className="management-collapsible no-print">
          <summary>Update display name</summary>
          <form
          className="management-form profile-display-form"
          onSubmit={(event) =>
            handleSubmit(event, 'profile-display', async () => {
              const result = await updateProfileDisplayName({
                displayName: profileDisplayForm.display_name,
                fullName: profileDisplayForm.full_name,
                profileId: profileDisplayForm.profile_id,
              });

              if (result.ok) {
                setProfileDisplayForm(initialProfileDisplayForm);
              }

              return result;
            })
          }
        >
          <SearchableProfilePicker
            label="Profile"
            value={profileDisplayForm.profile_id}
            items={profiles}
            required
            helpText="Search visible profiles by display name, username, or email before editing."
            getPrimaryText={formatProfilePrimaryLabel}
            getSecondaryText={formatProfileSecondaryLabel}
            getBadgeText={(profile) => formatTokenLabel(profile.status)}
            getSearchText={formatProfileSearchText}
            onChange={(value, profile) => {
              setProfileDisplayForm({
                profile_id: value,
                display_name: profile?.display_name || profile?.full_name || '',
                full_name: profile?.full_name || '',
              });
            }}
          />
          <TextInput
            label="Display name / nickname"
            value={profileDisplayForm.display_name}
            onChange={(value) =>
              updateProfileDisplayForm('display_name', value)
            }
            required
          />
          <TextInput
            label="Full name optional"
            value={profileDisplayForm.full_name}
            onChange={(value) => updateProfileDisplayForm('full_name', value)}
          />
          <button
            className="primary-button"
            disabled={busyAction === 'profile-display'}
            type="submit"
          >
            {busyAction === 'profile-display'
              ? 'Updating...'
              : 'Update display name'}
          </button>
          </form>
        </details>
        <RecordTable
          columns={['Profile', 'Email', 'Default role', 'Status', 'Lifecycle action']}
          emptyMessage="No profiles found."
          rows={filteredProfiles.map((profile) => [
            (
              <span className="profile-cell inline-table-cell">
                <strong>{formatProfilePrimaryLabel(profile)}</strong>
                <span className="table-subtext">
                  {formatProfileSecondaryLabel(profile)}
                </span>
              </span>
            ),
            <span className="email-cell">{profile.email || '-'}</span>,
            getRoleLabel(profile.default_role),
            <span className="status-text-cell">{formatTokenLabel(profile.status)}</span>,
            <span className="action-cell inline-action-cell">
              {profile.status === 'deactivated' ? (
                <button
                  className="secondary-button compact-button"
                  disabled={busyAction === 'profile-status'}
                  type="button"
                  onClick={() => handleProfileStatusChange(profile, 'active')}
                >
                  Reactivate profile
                </button>
              ) : (
                <button
                  className="secondary-button compact-button danger-lite"
                  disabled={busyAction === 'profile-status'}
                  type="button"
                  onClick={() => handleProfileStatusChange(profile, 'deactivated')}
                >
                  Deactivate profile
                </button>
              )}
            </span>,
          ])}
        />
      </ManagementSection>
      )}

      {activeManagementSection === 'memberships' && (
      <ManagementSection
        title="Memberships/roles"
        intro="Membership/role rows grant access roles to profiles. Removing a role is not account deletion; profile records and historical results remain."
      >
        <button
          className="secondary-button compact-button no-print"
          type="button"
          aria-pressed={showInactiveMemberships}
          onClick={() => setShowInactiveMemberships((current) => !current)}
        >
          {showInactiveMemberships
            ? 'Hide removed/inactive memberships'
            : 'Show removed/inactive memberships'}
        </button>
        <details className="management-collapsible no-print">
          <summary>Add membership</summary>
          <form
          className="management-form"
          onSubmit={(event) =>
            handleSubmit(event, 'membership', async () => {
              const result = await createMembership(membershipForm);

              if (result.ok) {
                setMembershipForm({
                  ...initialMembershipForm,
                  organisation_id: membershipForm.organisation_id,
                  campus_id: membershipForm.campus_id,
                  group_id: membershipForm.group_id,
                });
              }

              return result;
            })
          }
        >
          <SearchableProfilePicker
            label="Profile"
            value={membershipForm.user_id}
            items={profiles}
            helpText="Search first; CertSim does not show the full profile list by default."
            getPrimaryText={formatProfilePrimaryLabel}
            getSecondaryText={formatProfileSecondaryLabel}
            getBadgeText={(profile) => formatTokenLabel(profile.status)}
            getSearchText={formatProfileSearchText}
            onChange={(value) => updateMembershipForm('user_id', value)}
            required
          />
          <SelectInput
            label="Organisation"
            value={membershipForm.organisation_id}
            onChange={(value) =>
              setMembershipForm((current) => ({
                ...current,
                organisation_id: value,
                campus_id: '',
                group_id: '',
              }))
            }
            options={organisations.map((organisation) => ({
              value: organisation.id,
              label: organisation.name,
            }))}
            placeholder="Choose organisation"
            required
          />
          <SelectInput
            label="Campus optional"
            value={membershipForm.campus_id}
            onChange={(value) =>
              setMembershipForm((current) => ({
                ...current,
                campus_id: value,
                group_id: '',
              }))
            }
            options={membershipCampusOptions.map((campus) => ({
              value: campus.id,
              label: campus.name,
            }))}
            placeholder="No campus"
          />
          <SelectInput
            label="Group optional"
            value={membershipForm.group_id}
            onChange={(value) => updateMembershipForm('group_id', value)}
            options={membershipGroupOptions.map((group) => ({
              value: group.id,
              label: group.name,
            }))}
            placeholder="No group"
          />
          <SelectInput
            label="Role"
            value={membershipForm.role}
            onChange={(value) => updateMembershipForm('role', value)}
            options={MEMBERSHIP_ROLES.map((role) => ({
              value: role,
              label: getRoleLabel(role),
            }))}
          />
          <SelectInput
            label="Status"
            value={membershipForm.status}
            onChange={(value) => updateMembershipForm('status', value)}
            options={MEMBERSHIP_CREATE_STATUSES.map((status) => ({
              value: status,
              label: formatTokenLabel(status),
            }))}
          />
          <button
            className="primary-button"
            disabled={busyAction === 'membership'}
            type="submit"
          >
            {busyAction === 'membership' ? 'Adding...' : 'Add membership'}
          </button>
          </form>
        </details>
        <MembershipTable
          memberships={filteredMemberships}
          allMemberships={memberships}
          busyAction={busyAction}
          onRemoveRole={handleRemoveMembershipRole}
          onStatusChange={async (membershipId, status) =>
            runAction('membership-status', async () =>
              updateMembershipStatus(membershipId, status),
            )
          }
        />
      </ManagementSection>
      )}
    </ManagementShell>
  );

  function updateManagementFilter(field, value) {
    setManagementFilters((current) => ({
      ...current,
      [field]: value,
      ...(field === 'organisationId'
        ? {
            campusId: '',
            groupId: '',
          }
        : {}),
      ...(field === 'campusId'
        ? {
            groupId: '',
          }
        : {}),
    }));
  }

  function clearManagementFilters() {
    setManagementFilters({
      campusId: '',
      groupId: '',
      organisationId: '',
      role: '',
      search: '',
      status: '',
    });
  }

  function updateOrganisationForm(field, value) {
    setOrganisationForm((current) => ({ ...current, [field]: value }));
  }

  function updateCampusForm(field, value) {
    setCampusForm((current) => ({ ...current, [field]: value }));
  }

  function updateGroupForm(field, value) {
    setGroupForm((current) => ({ ...current, [field]: value }));
  }

  function updateMembershipForm(field, value) {
    setMembershipForm((current) => ({ ...current, [field]: value }));
  }

  function updateProfileDisplayForm(field, value) {
    setProfileDisplayForm((current) => ({ ...current, [field]: value }));
  }

  async function handleProfileStatusChange(profile, status) {
    const actionLabel = status === 'deactivated' ? 'Deactivate' : 'Reactivate';
    const confirmed = window.confirm(
      status === 'deactivated'
        ? 'Deactivate this CertSim profile? The user will lose CertSim app access where enforced, but historical results and reports will remain.'
        : 'Reactivate this CertSim profile? This changes the CertSim profile status only.',
    );

    if (!confirmed) {
      return;
    }

    const result = await runAction('profile-status', async () =>
      updateProfileStatus({
        profileId: profile.id,
        status,
      }),
    );

    if (result.ok) {
      setActionMessage(`${actionLabel} profile request completed.`);
    }
  }

  async function handleRemoveMembershipRole(membership) {
    const confirmed = window.confirm(
      'You are removing this role only. The user profile and historical results will remain.',
    );

    if (!confirmed) {
      return;
    }

    const result = await runAction('membership-remove', async () =>
      removeMembershipRole(membership.id),
    );

    if (result.ok) {
      setActionMessage('Membership role marked as removed.');
    }
  }

  async function handleSubmit(event, actionName, action) {
    event.preventDefault();
    await runAction(actionName, action);
  }

  async function runAction(actionName, action) {
    setBusyAction(actionName);
    setActionMessage('');
    setActionError('');

    const result = await action();

    if (result.ok) {
      setActionMessage('Management records updated.');
    } else {
      setActionError(result.message);
    }

    setBusyAction('');
    return result;
  }
}

function ManagementShell({ children, onBackHome, onBrowseExams }) {
  return (
    <section className="management-page" aria-labelledby="organisation-management-heading">
      <div className="view-toolbar no-print">
        <div>
          <p className="eyebrow">Platform Owner</p>
          <h2 id="organisation-management-heading">Organisation Management</h2>
        </div>
      </div>
      <p className="management-intro">
        Manage organisation, campus, group, profile, and membership records for
        CertSim. This does not create Supabase Auth users or enforce paid
        access.
      </p>
      {children}
    </section>
  );
}

function StatePanel({ title, note }) {
  return (
    <section className="management-state">
      <p className="auth-panel-title">{title}</p>
      <p className="auth-panel-muted">{note}</p>
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
    <nav className="management-tabs no-print" aria-label="Organisation management sections">
      {sections.map((section) => (
        <button
          key={section.id}
          className={activeSection === section.id ? 'active' : ''}
          type="button"
          onClick={() => onSelect(section.id)}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
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

function FilterSelect({ label, onChange, options, placeholder, value }) {
  return (
    <label className="management-filter-field">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
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

function ManagementSection({ children, intro, title }) {
  return (
    <section className="management-section">
      <div>
        <h3>{title}</h3>
        <p>{intro}</p>
      </div>
      {children}
    </section>
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
        required={required}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

function SelectInput({
  label,
  onChange,
  options,
  placeholder = '',
  required = false,
  value,
}) {
  return (
    <label>
      <span>{label}</span>
      <select
        required={required}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function RecordTable({ columns, emptyMessage, rows }) {
  if (rows.length === 0) {
    return <StatePanel title={emptyMessage} note="Create a record above or refresh after backend setup." />;
  }

  return (
    <div className="management-table-wrap">
      <table className="management-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`management-row-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${rowIndex}-${columns[cellIndex]}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MembershipTable({
  allMemberships = [],
  busyAction,
  memberships,
  onRemoveRole,
  onStatusChange,
}) {
  if (memberships.length === 0) {
    return (
      <StatePanel
        title="No memberships found."
        note="Add a role for an existing profile when the profile list is available."
      />
    );
  }

  return (
    <div className="management-table-wrap">
      <table className="management-table">
        <thead>
          <tr>
            <th className="profile-col">Profile</th>
            <th>Role</th>
            <th>Scope</th>
            <th>Role review</th>
            <th className="status-col">Status</th>
            <th className="action-col">Action</th>
          </tr>
        </thead>
        <tbody>
          {memberships.map((membership) => {
            const roleWarning = getMultipleAccessRoleWarning(
              membership,
              allMemberships,
            );

            return (
              <tr key={membership.id}>
                <td className="profile-cell">
                  <strong>{formatProfileLabel(membership.profile)}</strong>
                  <span className="table-subtext">
                    {formatProfileSecondaryLabel(membership.profile)}
                  </span>
                </td>
                <td className="status-text-cell">{getRoleLabel(membership.role)}</td>
                <td className="scope-cell">{formatMembershipScope(membership)}</td>
                <td>
                  {roleWarning ? (
                    <span className="lifecycle-warning-badge">
                      {roleWarning}
                    </span>
                  ) : (
                    <span className="table-subtext">No duplicate high-access role flag.</span>
                  )}
                </td>
                <td className="status-cell">
                  <select
                    aria-label={`Status for ${formatProfileLabel(membership.profile)}`}
                    disabled={busyAction === 'membership-status'}
                    value={membership.status}
                    onChange={(event) =>
                      onStatusChange(membership.id, event.target.value)
                    }
                  >
                    {MEMBERSHIP_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {formatTokenLabel(status)}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="action-cell">
                  <button
                    className="secondary-button compact-button danger-lite"
                    disabled={
                      busyAction === 'membership-remove' ||
                      membership.status === 'removed'
                    }
                    type="button"
                    onClick={() => onRemoveRole?.(membership)}
                  >
                    Remove role
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function matchesOrganisationFilters(organisation, filters) {
  return (
    matchesSearch(
      [
        organisation.name,
        organisation.organisation_type,
        organisation.billing_model,
        organisation.notes,
        organisation.status,
      ],
      filters.search,
    ) &&
    (!filters.organisationId || organisation.id === filters.organisationId) &&
    matchesStatusFilter(organisation.status, filters.status)
  );
}

function matchesCampusFilters(campus, filters) {
  return (
    matchesSearch(
      [
        campus.name,
        campus.code,
        campus.organisation?.name,
        campus.status,
      ],
      filters.search,
    ) &&
    (!filters.organisationId ||
      campus.organisation_id === filters.organisationId) &&
    (!filters.campusId || campus.id === filters.campusId) &&
    matchesStatusFilter(campus.status, filters.status)
  );
}

function matchesGroupFilters(group, filters) {
  return (
    matchesSearch(
      [
        group.name,
        group.organisation?.name,
        group.campus?.name,
        group.academic_year,
        group.status,
      ],
      filters.search,
    ) &&
    (!filters.organisationId ||
      group.organisation_id === filters.organisationId) &&
    (!filters.campusId || group.campus_id === filters.campusId) &&
    (!filters.groupId || group.id === filters.groupId) &&
    matchesStatusFilter(group.status, filters.status)
  );
}

function matchesProfileFilters(profile, filters) {
  return (
    matchesSearch(
      [
        profile.display_name,
        profile.full_name,
        profile.email,
        profile.default_role,
        profile.status,
      ],
      filters.search,
    ) &&
    (!filters.role || profile.default_role === filters.role) &&
    matchesStatusFilter(profile.status, filters.status)
  );
}

function matchesMembershipFilters(membership, filters) {
  return (
    matchesSearch(
      [
        formatProfileLabel(membership.profile),
        membership.profile?.email,
        membership.organisation?.name,
        membership.campus?.name,
        membership.group?.name,
        membership.role,
        membership.status,
      ],
      filters.search,
    ) &&
    (!filters.organisationId ||
      membership.organisation_id === filters.organisationId) &&
    (!filters.campusId || membership.campus_id === filters.campusId) &&
    (!filters.groupId || membership.group_id === filters.groupId) &&
    (!filters.role || membership.role === filters.role) &&
    matchesStatusFilter(membership.status, filters.status)
  );
}

function getMultipleAccessRoleWarning(membership, allMemberships) {
  if (membership.status !== 'active' || !membership.user_id) {
    return '';
  }

  const activeRoles = new Set(
    allMemberships
      .filter(
        (item) =>
          item.user_id === membership.user_id &&
          item.status === 'active',
      )
      .map((item) => item.role),
  );
  const warningPairs = [
    ['developer', 'platform_owner'],
    ['campus_admin', 'trainer'],
    ['college_admin', 'trainer'],
  ];
  const hasWarningPair = warningPairs.some((pair) =>
    pair.every((role) => activeRoles.has(role)),
  );

  return hasWarningPair
    ? 'Multiple active access roles. Remove old temporary roles if they are no longer needed.'
    : '';
}

function matchesStatusFilter(value, statusFilter) {
  return !statusFilter || value === statusFilter;
}

function matchesSearch(fields, search) {
  const query = normalizeFilterText(search);

  if (!query) {
    return true;
  }

  return fields.some((field) => normalizeFilterText(field).includes(query));
}

function normalizeFilterText(value) {
  return String(value ?? '').trim().toLowerCase();
}

function formatMembershipScope(membership) {
  return [
    membership.organisation?.name,
    membership.campus?.name,
    membership.group?.name,
  ]
    .filter(Boolean)
    .join(' / ') || '-';
}

function formatProfileLabel(profile) {
  if (!profile) {
    return 'Unknown profile';
  }

  return formatProfilePrimaryLabel(profile);
}

function formatProfilePrimaryLabel(profile) {
  if (!profile) {
    return 'Unknown profile';
  }

  return (
    profile.display_name ||
    profile.username ||
    profile.full_name ||
    getNameFromEmail(profile.email) ||
    profile.email ||
    profile.id
  );
}

function formatProfileSecondaryLabel(profile = {}) {
  return [profile.username, profile.email || 'Email not recorded']
    .filter(Boolean)
    .join(' - ');
}

function formatProfileSearchText(profile = {}) {
  return [
    profile.display_name,
    profile.username,
    profile.full_name,
    getNameFromEmail(profile.email),
    profile.email,
    profile.default_role,
    profile.status,
  ]
    .filter(Boolean)
    .join(' ');
}

function getNameFromEmail(email) {
  const text = String(email ?? '').trim();

  return text.includes('@') ? text.split('@')[0] : '';
}

function formatTokenLabel(value) {
  return String(value || '-')
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function formatDate(value) {
  if (!value) {
    return '-';
  }

  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return '-';
  }
}
