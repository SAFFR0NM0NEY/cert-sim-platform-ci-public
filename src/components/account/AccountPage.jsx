import { useEffect, useState } from 'react';

import AuthPanel from '../auth/AuthPanel.jsx';
import {
  createAccountDeletionRequest,
  listMyAccountDeletionRequests,
} from '../../lib/accountLifecycleService.js';
import { signOut } from '../../lib/authService.js';
import { createPlatformIssueReport } from '../../lib/developerDashboardService.js';
import { updateOwnProfileDisplayName } from '../../lib/profileService.js';
import {
  getRoleLabel,
  hasDeveloperDashboardAccess,
  hasReceptionPlacementDashboardAccess,
  hasScopedPerformanceDashboardAccess,
} from '../../lib/roleUtils.js';
import useCurrentIdentity from '../../hooks/useCurrentIdentity.js';

const profileFormInitialState = {
  displayName: '',
  fullName: '',
};

const issueFormInitialState = {
  reportType: 'platform_bug',
  title: '',
  message: '',
};

const deletionFormInitialState = {
  reason: '',
};

export default function AccountPage(props = {}) {
  return props.identity
    ? <AccountPageContent {...props} identity={props.identity} />
    : <AccountPageWithIdentity {...props} />;
}

function AccountPageWithIdentity(props) {
  const identity = useCurrentIdentity();
  return <AccountPageContent {...props} identity={identity} />;
}

function AccountPageContent({
  identity,
  lastSelectedExam,
  onBackHome,
  onBrowseExams,
  onConfigureWeakAreaPractice,
  onContinueLastSelectedExam,
  onOpenAssignments,
  onOpenCampusDetail,
  onOpenGroupDetail,
  onOpenOrganisationManagement,
  onOpenOrganisationDetail,
  onOpenProgress,
  onOpenMyReports,
  onOpenSavedResults,
  onOpenDeveloperDashboard,
  onOpenJoin,
  onOpenReceptionPlacement,
  onOpenTrainerDashboard,
} = {}) {
  const {
    user,
    loading,
    isAuthenticated,
    isSupabaseConfigured,
    authUnavailableReason,
    profile,
    primaryRole,
    isPlatformOwner,
    hasMemberships,
    membershipLabels,
    memberships,
    identityLoading,
    error: identityError,
    refreshIdentity,
  } = identity;
  const [profileForm, setProfileForm] = useState(profileFormInitialState);
  const [profileMessage, setProfileMessage] = useState('');
  const [profileError, setProfileError] = useState('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  const accountEmail = profile?.email || identity.userEmail || user?.email || '';
  const displayName =
    profile?.display_name ||
    profile?.full_name ||
    getEmailFallbackName(accountEmail) ||
    'Signed-in account';
  const canOpenTrainerDashboard =
    hasScopedPerformanceDashboardAccess({ isPlatformOwner, memberships });
  const canOpenDeveloperDashboard =
    hasDeveloperDashboardAccess({ isPlatformOwner, memberships });
  const canOpenReceptionPlacement =
    hasReceptionPlacementDashboardAccess({ isPlatformOwner, memberships });
  const scopedAdminLinks = getScopedAdminLinks(memberships);
  const hasStaffAdminTools =
    canOpenTrainerDashboard ||
    canOpenReceptionPlacement ||
    isPlatformOwner ||
    scopedAdminLinks.length > 0;
  const [issueForm, setIssueForm] = useState(issueFormInitialState);
  const [issueMessage, setIssueMessage] = useState('');
  const [issueError, setIssueError] = useState('');
  const [isSubmittingIssue, setIsSubmittingIssue] = useState(false);
  const [deletionForm, setDeletionForm] = useState(deletionFormInitialState);
  const [deletionRequests, setDeletionRequests] = useState([]);
  const [deletionMessage, setDeletionMessage] = useState('');
  const [deletionError, setDeletionError] = useState('');
  const [isLoadingDeletionRequests, setIsLoadingDeletionRequests] =
    useState(false);
  const [isSubmittingDeletionRequest, setIsSubmittingDeletionRequest] =
    useState(false);

  useEffect(() => {
    setProfileForm({
      displayName: profile?.display_name || '',
      fullName: profile?.full_name || '',
    });
  }, [profile?.display_name, profile?.full_name, profile?.id]);

  useEffect(() => {
    if (!isSupabaseConfigured || !isAuthenticated) {
      setDeletionRequests([]);
      return;
    }

    loadDeletionRequests();
  }, [isAuthenticated, isSupabaseConfigured, user?.id]);

  return (
    <section className="account-page" aria-labelledby="account-page-heading">
      <div className="account-page-header">
        <div>
          <p className="eyebrow">CertSim Account</p>
          <h2 id="account-page-heading">Account</h2>
          <p className="saved-results-page-intro">
            Manage your profile name, saved results, assigned exams, and
            role-specific CertSim areas. Sign-in is required for protected
            certification exams and account-backed practice.
          </p>
        </div>
      </div>

      {!isSupabaseConfigured ? (
        <section className="account-card unavailable">
          <p className="auth-panel-title">Frontend-only mode</p>
          <p className="auth-panel-note">
            Supabase account features are not configured in this environment,
            so protected certification exams are unavailable.
          </p>
          {authUnavailableReason ? (
            <p className="auth-panel-muted">{authUnavailableReason}</p>
          ) : null}
        </section>
      ) : null}

      {isSupabaseConfigured && !isAuthenticated ? (
        <section className="account-page-grid single">
          <article className="account-card">
            <p className="auth-panel-title">Sign in or create an account</p>
            <p className="auth-panel-note">
              Sign in for protected certification exams, Saved Results, My
              Progress, Weak Area Practice, and assigned exam reminders. The IT
              Direction Assessment remains a separate guidance activity.
            </p>
            <AuthPanel
              title="Account access"
              onAuthenticated={refreshIdentity}
              showSignedInMessage={false}
            />
          </article>
        </section>
      ) : null}

      {isSupabaseConfigured && isAuthenticated ? (
        <section className="account-dashboard-layout">
          <article className="account-card account-overview-card">
            <p className="auth-panel-title">Account overview</p>
            {loading || identityLoading ? (
              <p className="auth-panel-muted">Refreshing account details...</p>
            ) : null}
            <div className="account-profile-summary">
              <span className="account-avatar" aria-hidden="true">
                {getInitials(displayName)}
              </span>
              <span>
                <strong>{displayName}</strong>
                <small>{accountEmail || 'Email not available'}</small>
              </span>
            </div>
            <dl className="account-facts">
              <div>
                <dt>Sign-in status</dt>
                <dd>Signed in</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{accountEmail || 'Not available'}</dd>
              </div>
              <div>
                <dt>Primary role</dt>
                <dd>{getRoleLabel(primaryRole)}</dd>
              </div>
            </dl>
            <div className="auth-panel-identity">
              <div className="auth-panel-identity-header">
                <span>Role / membership summary</span>
                {isPlatformOwner ? (
                  <span className="auth-panel-badge">Platform Owner</span>
                ) : null}
              </div>
              {hasMemberships ? (
                <ul className="auth-panel-memberships">
                  {membershipLabels.map((label, index) => (
                    <li key={`${label}-${index}`}>{label}</li>
                  ))}
                </ul>
              ) : (
                <p className="auth-panel-muted">
                  No CertSim role has been assigned yet.
                </p>
              )}
              <p className="auth-panel-note">
                Available account areas reflect your active CertSim roles and
                memberships.
              </p>
            </div>
            {identityError ? (
              <p className="auth-panel-error">{identityError}</p>
            ) : null}
          </article>

          <section className="account-primary-journey" aria-labelledby="account-learning-heading">
            <div className="account-section-heading">
              <p className="eyebrow">Your learning journey</p>
              <h3 id="account-learning-heading">Learn, review, improve</h3>
              <p>Choose an exam, review your progress, then practise the areas that need attention.</p>
            </div>
            <div className="account-journey-grid">
              {lastSelectedExam ? (
                <article className="account-journey-main">
                  <span className="status-badge">Continue learning</span>
                  <strong>Continue {lastSelectedExam.shortName}</strong>
                  <p>Return to the last exam selected in this browser when you are ready.</p>
                  <button className="primary-button" type="button" onClick={onContinueLastSelectedExam}>
                    Continue {lastSelectedExam.shortName}
                  </button>
                </article>
              ) : (
                <article className="account-journey-main">
                  <span className="status-badge">Start here</span>
                  <strong>Browse Exams</strong>
                  <p>Choose an available certification practice module.</p>
                  <button className="primary-button" type="button" onClick={onBrowseExams}>
                    Browse Exams
                  </button>
                </article>
              )}
              <div className="account-journey-actions">
                {lastSelectedExam ? (
                  <JourneyAction title="Browse Exams" onClick={onBrowseExams}>
                    Choose a different certification exam.
                  </JourneyAction>
                ) : null}
                <JourneyAction title="My Progress" onClick={onOpenProgress}>
                  See readiness, latest scores, and weak domains.
                </JourneyAction>
                <JourneyAction
                  title="Saved Results"
                  accessibleLabel="Open Saved Results"
                  onClick={onOpenSavedResults}
                >
                  Open your full account-backed attempt history.
                </JourneyAction>
                <JourneyAction
                  title="Weak Area Practice"
                  onClick={() => onConfigureWeakAreaPractice?.(lastSelectedExam?.id ?? '')}
                >
                  Configure focused practice from your saved attempts.
                </JourneyAction>
                <JourneyAction title="My Assigned Exams" onClick={onOpenAssignments}>
                  Review assignments and their latest result status.
                </JourneyAction>
              </div>
            </div>
          </section>

          <section className="account-secondary-section" aria-labelledby="account-secondary-heading">
            <div className="account-section-heading">
              <p className="eyebrow">Account tools</p>
              <h3 id="account-secondary-heading">Profile, support and account settings</h3>
            </div>

          <details className="account-card account-details" open={Boolean(profileMessage || profileError) || undefined}>
            <summary>Profile management</summary>
            <div className="account-details-content">
            <p className="auth-panel-note">
              School account? Use a name your trainer can recognise.
            </p>
            <form className="auth-panel-form" onSubmit={handleSaveProfile}>
              <label>
                <span>Display name / username</span>
                <input
                  type="text"
                  value={profileForm.displayName}
                  onChange={(event) =>
                    updateProfileForm('displayName', event.target.value)
                  }
                  placeholder="Name your trainer can recognise"
                  autoComplete="name"
                  required
                />
              </label>
              <label>
                <span>Full name (optional)</span>
                <input
                  type="text"
                  value={profileForm.fullName}
                  onChange={(event) =>
                    updateProfileForm('fullName', event.target.value)
                  }
                  placeholder="Optional full name"
                  autoComplete="name"
                />
              </label>
              <label>
                <span>Email</span>
                <input type="email" value={accountEmail} readOnly />
              </label>
              {profileMessage ? (
                <p className="auth-panel-success">{profileMessage}</p>
              ) : null}
              {profileError ? (
                <p className="auth-panel-error">{profileError}</p>
              ) : null}
              <button
                className="primary-button auth-panel-button"
                type="submit"
                disabled={isSavingProfile}
              >
                {isSavingProfile ? 'Saving...' : 'Save display name'}
              </button>
            </form>
            </div>
          </details>

          <article className="account-card account-compact-tools">
            <div className="account-action-grid compact">
              <AccountActionCard
                title={hasMemberships ? 'Join with code' : 'Join a class/group'}
                description="Connect this account to a CertSim class with a code or invite."
                actionLabel="Open Join Page"
                onClick={onOpenJoin}
              />
              <AccountActionCard
                title="My Reports"
                description="Track issue and question reports submitted from your account."
                actionLabel="Open My Reports"
                onClick={onOpenMyReports}
              />
            </div>
            <button
              className="secondary-button account-signout-button"
              type="button"
              onClick={handleSignOut}
              disabled={isSigningOut}
            >
              {isSigningOut ? 'Signing out...' : 'Sign out'}
            </button>
          </article>

          <details className="account-card account-details" open={Boolean(issueMessage || issueError) || undefined}>
            <summary>Report an issue</summary>
            <div className="account-details-content">
            <p className="auth-panel-note">
              Send a saved platform, result, access, or question-support issue to
              the developer queue. Do not include passwords or secrets.
            </p>
            <form className="auth-panel-form" onSubmit={handleSubmitIssue}>
              <label>
                <span>Report type</span>
                <select
                  value={issueForm.reportType}
                  onChange={(event) =>
                    updateIssueForm('reportType', event.target.value)
                  }
                >
                  <option value="platform_bug">Platform bug</option>
                  <option value="question_issue">Question issue</option>
                  <option value="result_issue">Result/report issue</option>
                  <option value="access_issue">Access/account issue</option>
                  <option value="other">Other</option>
                </select>
              </label>
              <label>
                <span>Short title</span>
                <input
                  type="text"
                  value={issueForm.title}
                  onChange={(event) =>
                    updateIssueForm('title', event.target.value)
                  }
                  placeholder="Example: Saved result did not show a domain chart"
                  required
                />
              </label>
              <label>
                <span>Details</span>
                <textarea
                  rows="4"
                  value={issueForm.message}
                  onChange={(event) =>
                    updateIssueForm('message', event.target.value)
                  }
                  placeholder="Describe what happened and which page you were using."
                  required
                />
              </label>
              {issueMessage ? (
                <div className="auth-panel-success">
                  <p>{issueMessage}</p>
                  <button
                    className="text-button"
                    type="button"
                    onClick={onOpenMyReports}
                  >
                    Open My Reports
                  </button>
                </div>
              ) : null}
              {issueError ? (
                <p className="auth-panel-error">{issueError}</p>
              ) : null}
              <button
                className="primary-button auth-panel-button"
                type="submit"
                disabled={isSubmittingIssue}
              >
                {isSubmittingIssue ? 'Sending...' : 'Send issue report'}
              </button>
            </form>
            </div>
          </details>

          <details className="account-card account-details" open={Boolean(deletionMessage || deletionError) || undefined}>
            <summary>Account lifecycle request</summary>
            <div className="account-details-content">
            <p className="auth-panel-note">
              Request CertSim account deletion/deactivation review. This does
              not hard-delete your Supabase Auth user from the browser, and
              saved result/report history is preserved for retention decisions.
            </p>
            <form className="auth-panel-form" onSubmit={handleSubmitDeletionRequest}>
              <label>
                <span>Reason optional</span>
                <textarea
                  rows="3"
                  value={deletionForm.reason}
                  onChange={(event) =>
                    setDeletionForm({ reason: event.target.value })
                  }
                  placeholder="Optional context for the account cleanup request."
                />
              </label>
              {deletionMessage ? (
                <p className="auth-panel-success">{deletionMessage}</p>
              ) : null}
              {deletionError ? (
                <p className="auth-panel-error">{deletionError}</p>
              ) : null}
              <div className="button-row wrap">
                <button
                  className="secondary-button danger-lite"
                  type="submit"
                  disabled={isSubmittingDeletionRequest}
                >
                  {isSubmittingDeletionRequest
                    ? 'Submitting...'
                    : 'Request account deletion'}
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={isLoadingDeletionRequests}
                  onClick={loadDeletionRequests}
                >
                  {isLoadingDeletionRequests ? 'Refreshing...' : 'Refresh request status'}
                </button>
              </div>
            </form>
            <AccountDeletionRequestList requests={deletionRequests} />
            <p className="auth-panel-muted">
              Hard auth-user deletion requires a secure backend/admin process
              and is not available from the frontend.
            </p>
            </div>
          </details>
          </section>

          {hasStaffAdminTools ? (
            <section className="account-role-section" aria-labelledby="account-staff-heading">
              <div className="account-section-heading">
                <p className="eyebrow">Role-specific access</p>
                <h3 id="account-staff-heading">Staff tools</h3>
              </div>
              <div className="account-action-grid">
                {canOpenTrainerDashboard ? (
                  <AccountActionCard
                    title="Training Dashboard"
                    description="Review scoped groups, students, saved results, readiness, and assignments."
                    actionLabel="Open Training Dashboard"
                    onClick={onOpenTrainerDashboard}
                  />
                ) : null}
                {canOpenReceptionPlacement ? (
                  <AccountActionCard
                    title="Placement Results"
                    description="Review IT Direction Assessment placement results and follow-up notes."
                    actionLabel="Open Placement Dashboard"
                    onClick={onOpenReceptionPlacement}
                  />
                ) : null}
                {isPlatformOwner ? (
                  <AccountActionCard
                    title="Manage Organisations"
                    description="Manage organisations, campuses, groups, memberships, and visible profile names."
                    actionLabel="Manage Organisations"
                    onClick={onOpenOrganisationManagement}
                  />
                ) : null}
                {!isPlatformOwner
                  ? scopedAdminLinks.map((link) => (
                      <AccountActionCard
                        key={`${link.type}-${link.id}`}
                        title={link.title}
                        description={link.description}
                        actionLabel={link.actionLabel}
                        onClick={() => {
                          if (link.type === 'organisation') {
                            onOpenOrganisationDetail?.(link.id);
                          } else if (link.type === 'campus') {
                            onOpenCampusDetail?.(link.id);
                          } else if (link.type === 'group') {
                            onOpenGroupDetail?.(link.id);
                          }
                        }}
                      />
                    ))
                  : null}
              </div>
            </section>
          ) : null}

          {canOpenDeveloperDashboard ? (
            <details className="account-role-section account-developer-section">
              <summary>Developer/platform-owner tools</summary>
              <div className="account-details-content">
                <AccountActionCard
                  title="Developer Dashboard"
                  description="Review support and question-report queues."
                  actionLabel="Open Developer Dashboard"
                  onClick={onOpenDeveloperDashboard}
                />
              </div>
            </details>
          ) : null}
        </section>
      ) : null}
    </section>
  );

  function updateProfileForm(field, value) {
    setProfileForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  async function handleSaveProfile(event) {
    event.preventDefault();
    setIsSavingProfile(true);
    setProfileMessage('');
    setProfileError('');

    const result = await updateOwnProfileDisplayName({
      displayName: profileForm.displayName,
      fullName: profileForm.fullName,
    });

    if (!result.ok) {
      setProfileError(result.message);
      setIsSavingProfile(false);
      return;
    }

    await refreshIdentity();
    setProfileMessage('Profile display name updated.');
    setIsSavingProfile(false);
  }

  async function handleSignOut() {
    setIsSigningOut(true);
    const { error: signOutError } = await signOut();

    if (signOutError) {
      setProfileError(signOutError.message);
    }

    setIsSigningOut(false);
  }

  function updateIssueForm(field, value) {
    setIssueForm((current) => ({
      ...current,
      [field]: value,
    }));
  }

  async function handleSubmitIssue(event) {
    event.preventDefault();
    setIsSubmittingIssue(true);
    setIssueMessage('');
    setIssueError('');

    const result = await createPlatformIssueReport({
      reportType: issueForm.reportType,
      title: issueForm.title,
      message: issueForm.message,
      routePath:
        typeof window !== 'undefined'
          ? `${window.location.pathname}${window.location.search}`
          : '',
    });

    if (!result.ok) {
      setIssueError(result.message);
      setIsSubmittingIssue(false);
      return;
    }

    setIssueForm(issueFormInitialState);
    setIssueMessage('Report submitted. You can track the status under My Reports.');
    setIsSubmittingIssue(false);
  }

  async function loadDeletionRequests() {
    setIsLoadingDeletionRequests(true);
    setDeletionError('');

    const result = await listMyAccountDeletionRequests();

    if (result.ok) {
      setDeletionRequests(result.data ?? []);
    } else {
      setDeletionError(result.message);
    }

    setIsLoadingDeletionRequests(false);
    return result;
  }

  async function handleSubmitDeletionRequest(event) {
    event.preventDefault();

    const confirmed = window.confirm(
      'Submit an account deletion/deactivation request? This does not hard-delete your Supabase Auth user from the frontend.',
    );

    if (!confirmed) {
      return;
    }

    setIsSubmittingDeletionRequest(true);
    setDeletionMessage('');
    setDeletionError('');

    const result = await createAccountDeletionRequest({
      reason: deletionForm.reason,
    });

    if (!result.ok) {
      setDeletionError(result.message);
      setIsSubmittingDeletionRequest(false);
      return;
    }

    setDeletionForm(deletionFormInitialState);
    setDeletionMessage('Account deletion request saved for review.');
    await loadDeletionRequests();
    setIsSubmittingDeletionRequest(false);
  }
}

function AccountDeletionRequestList({ requests = [] }) {
  if (requests.length === 0) {
    return (
      <p className="auth-panel-muted">
        No account deletion requests are currently recorded for this account.
      </p>
    );
  }

  return (
    <ul className="compact-detail-list">
      {requests.map((request) => (
        <li key={request.id}>
          <strong>{formatAccountDeletionStatus(request.status)}</strong>
          <span>Requested: {formatDate(request.requestedAt)}</span>
          {request.reviewedAt ? (
            <span>Reviewed: {formatDate(request.reviewedAt)}</span>
          ) : null}
          {request.adminNotes ? <span>{request.adminNotes}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function AccountActionCard({ actionLabel, description, onClick, title }) {
  return (
    <article className="account-nav-card">
      <strong>{title}</strong>
      <p>{description}</p>
      <button
        className="secondary-button"
        type="button"
        onClick={() => onClick?.()}
      >
        {actionLabel}
      </button>
    </article>
  );
}

function JourneyAction({ accessibleLabel, children, onClick, title }) {
  return (
    <button
      aria-label={accessibleLabel}
      className="account-journey-action"
      type="button"
      onClick={() => onClick?.()}
    >
      <strong>{title}</strong>
      <span>{children}</span>
    </button>
  );
}

function getScopedAdminLinks(memberships = []) {
  const seen = new Set();

  return memberships
    .filter((membership) => membership?.status === 'active')
    .flatMap((membership) => {
      if (membership.role === 'college_admin' && membership.organisation_id) {
        return [
          createScopedLink({
            actionLabel: 'Open Organisation',
            description: 'View scoped campuses, groups, memberships, and records for this organisation.',
            id: membership.organisation_id,
            label: membership.organisation?.name,
            titlePrefix: 'My Organisation',
            type: 'organisation',
          }),
        ];
      }

      if (membership.role === 'campus_admin' && membership.campus_id) {
        return [
          createScopedLink({
            actionLabel: 'Open Campus',
            description: 'View scoped groups, memberships, and records for this campus.',
            id: membership.campus_id,
            label: membership.campus?.name,
            titlePrefix: 'My Campus',
            type: 'campus',
          }),
        ];
      }

      if (membership.role === 'trainer' && membership.group_id) {
        return [
          createScopedLink({
            actionLabel: 'Open Group',
            description: 'View assigned students, assignments, and saved result summaries for this group.',
            id: membership.group_id,
            label: membership.group?.name,
            titlePrefix: 'My Group',
            type: 'group',
          }),
        ];
      }

      return [];
    })
    .filter((link) => {
      const key = `${link.type}-${link.id}`;

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
}


function createScopedLink({
  actionLabel,
  description,
  id,
  label,
  titlePrefix,
  type,
}) {
  return {
    actionLabel,
    description,
    id,
    title: label ? `${titlePrefix}: ${label}` : titlePrefix,
    type,
  };
}

function getEmailFallbackName(email = '') {
  const prefix = email.split('@')[0]?.trim();

  return prefix || '';
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

function formatAccountDeletionStatus(status = '') {
  const normalizedStatus = status || 'open';

  return normalizedStatus
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

function formatDate(value) {
  if (!value) {
    return 'Not recorded';
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}
