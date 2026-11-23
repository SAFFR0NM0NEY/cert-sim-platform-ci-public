import { useEffect, useState } from 'react';

import useCurrentIdentity from '../../hooks/useCurrentIdentity.js';
import {
  acceptGroupAccessCode,
  acceptOnboardingInvite,
  getJoinCodeSummary,
  getJoinInviteSummary,
} from '../../lib/onboardingService.js';
import AuthPanel from '../auth/AuthPanel.jsx';
import { formatDate, formatTokenLabel } from '../admin/AdminDetailShared.jsx';

export default function JoinPage({
  inviteToken = '',
  onBackHome,
  onBrowseExams,
  onOpenAccount,
  onOpenAssignments,
}) {
  const identity = useCurrentIdentity();
  const {
    isAuthenticated,
    isSupabaseConfigured,
    loading,
    refreshIdentity,
    user,
  } = identity;
  const [code, setCode] = useState(() => getInitialCodeFromLocation());
  const [activeLookup, setActiveLookup] = useState(inviteToken ? 'invite' : code ? 'code' : '');
  const [summary, setSummary] = useState(null);
  const [isLoadingSummary, setIsLoadingSummary] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const [acceptResult, setAcceptResult] = useState(null);
  const [acceptError, setAcceptError] = useState('');
  const [isAccepting, setIsAccepting] = useState(false);

  useEffect(() => {
    if (!inviteToken) {
      return;
    }

    loadInviteSummary(inviteToken);
  }, [inviteToken]);

  useEffect(() => {
    if (inviteToken || !code || activeLookup !== 'code') {
      return;
    }

    loadCodeSummary(code);
  }, [activeLookup, code, inviteToken]);

  return (
    <section className="join-page" aria-labelledby="join-page-heading">
      <div className="account-page-header">
        <div>
          <p className="eyebrow">CertSim onboarding</p>
          <h2 id="join-page-heading">Join an organisation or class</h2>
          <p className="saved-results-page-intro">
            Use an invite link or group access code to connect your signed-in
            account to a CertSim organisation, campus, or class. Exams remain
            open and this does not add paid access enforcement.
          </p>
        </div>
        <div className="button-row wrap">
          <button className="primary-button" type="button" onClick={onOpenAccount}>
            Back to Account
          </button>
        </div>
      </div>

      {!isSupabaseConfigured ? (
        <section className="account-card unavailable">
          <p className="auth-panel-title">Onboarding is not configured here</p>
          <p className="auth-panel-note">
            This environment is running without Supabase account access. Exams
            remain open.
          </p>
        </section>
      ) : null}

      {isSupabaseConfigured ? (
        <section className="account-page-grid">
          <article className="account-card">
            <p className="auth-panel-title">Invite or access code</p>
            {inviteToken ? (
              <p className="auth-panel-note">
                This page was opened from an invite link. Review the target,
                then sign in or create an account before accepting.
              </p>
            ) : (
              <>
                <p className="auth-panel-note">
                  Enter the group/class access code supplied by reception,
                  your trainer, or a scoped admin.
                </p>
                <form className="auth-panel-form" onSubmit={handleCodeLookup}>
                  <label>
                    <span>Group access code</span>
                    <input
                      type="text"
                      value={code}
                      onChange={(event) => {
                        setCode(event.target.value.toUpperCase());
                        setAcceptResult(null);
                        setAcceptError('');
                      }}
                      placeholder="Example: CLASSCODE123"
                    />
                  </label>
                  <button
                    className="primary-button auth-panel-button"
                    type="submit"
                    disabled={isLoadingSummary || !code.trim()}
                  >
                    {isLoadingSummary ? 'Checking...' : 'Check code'}
                  </button>
                </form>
              </>
            )}

            {isLoadingSummary ? (
              <p className="auth-panel-muted">Loading onboarding details...</p>
            ) : null}
            {summaryError ? (
              <p className="auth-panel-error">{summaryError}</p>
            ) : null}
            {summary ? <JoinSummary summary={summary} /> : null}
          </article>

          <article className="account-card">
            <p className="auth-panel-title">Accept onboarding</p>
            {!summary ? (
              <p className="auth-panel-muted">
                Load a valid invite or access code before accepting.
              </p>
            ) : null}
            {summary && !summary.isUsable ? (
              <p className="auth-panel-error">{summary.message}</p>
            ) : null}
            {summary?.emailRequired ? (
              <p className="auth-panel-warning">
                This invite is email-specific. CertSim checks the signed-in
                account email before creating the membership.
              </p>
            ) : null}

            {summary?.isUsable && !isAuthenticated ? (
              <>
                <p className="auth-panel-note">
                  Sign in or create an account, then accept the invite/code on
                  this page.
                </p>
                <AuthPanel
                  title="Account access"
                  onAuthenticated={refreshIdentity}
                  showSignedInMessage={false}
                />
              </>
            ) : null}

            {summary?.isUsable && isAuthenticated ? (
              <div className="join-accept-box">
                <p className="auth-panel-note">
                  Signed in as <strong>{user?.email ?? 'your account'}</strong>.
                </p>
                <button
                  className="primary-button"
                  type="button"
                  disabled={isAccepting || loading}
                  onClick={handleAccept}
                >
                  {isAccepting ? 'Accepting...' : getAcceptLabel(summary)}
                </button>
              </div>
            ) : null}

            {acceptResult ? (
              <div className="auth-panel-success join-success-box">
                <p>{acceptResult.message}</p>
                <p>
                  {[
                    acceptResult.organisationName,
                    acceptResult.campusName,
                    acceptResult.groupName,
                  ]
                    .filter(Boolean)
                    .join(' / ')}
                </p>
                <div className="button-row wrap">
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    onClick={onOpenAccount}
                  >
                    Open Account
                  </button>
                  <button
                    className="primary-button compact-button"
                    type="button"
                    onClick={onOpenAssignments}
                  >
                    Open My Assignments
                  </button>
                </div>
              </div>
            ) : null}

            {acceptError ? (
              <p className="auth-panel-error">{acceptError}</p>
            ) : null}
          </article>
        </section>
      ) : null}
    </section>
  );

  async function handleCodeLookup(event) {
    event.preventDefault();
    await loadCodeSummary(code);
  }

  async function loadInviteSummary(token) {
    setIsLoadingSummary(true);
    setSummaryError('');
    setAcceptResult(null);
    setAcceptError('');
    setActiveLookup('invite');

    const result = await getJoinInviteSummary(token);

    if (result.ok) {
      setSummary(result.data);
    } else {
      setSummary(null);
      setSummaryError(result.message);
    }

    setIsLoadingSummary(false);
  }

  async function loadCodeSummary(nextCode) {
    const normalizedCode = String(nextCode ?? '').trim().toUpperCase();

    if (!normalizedCode) {
      return;
    }

    setIsLoadingSummary(true);
    setSummaryError('');
    setAcceptResult(null);
    setAcceptError('');
    setActiveLookup('code');

    const result = await getJoinCodeSummary(normalizedCode);

    if (result.ok) {
      setSummary(result.data);
    } else {
      setSummary(null);
      setSummaryError(result.message);
    }

    setIsLoadingSummary(false);
  }

  async function handleAccept() {
    setIsAccepting(true);
    setAcceptError('');
    setAcceptResult(null);

    const result =
      activeLookup === 'invite'
        ? await acceptOnboardingInvite(inviteToken)
        : await acceptGroupAccessCode(code);

    if (result.ok) {
      await refreshIdentity?.();
      setAcceptResult(result.data);
    } else {
      setAcceptError(result.message);
    }

    setIsAccepting(false);
  }
}

function JoinSummary({ summary }) {
  return (
    <div className="join-summary-card">
      <div className="trainer-assignment-card-header">
        <div>
          <h3>{summary.kind === 'code' ? 'Group access code' : 'Invite link'}</h3>
          <p>{summary.message}</p>
        </div>
        <span className={`assignment-progress-pill ${summary.status}`}>
          {formatTokenLabel(summary.status)}
        </span>
      </div>
      <dl className="trainer-assignment-card-meta">
        <span>
          <small>Organisation</small>
          <strong>{summary.organisationName || 'Not available'}</strong>
        </span>
        <span>
          <small>Campus</small>
          <strong>{summary.campusName || 'Not recorded'}</strong>
        </span>
        <span>
          <small>Group/class</small>
          <strong>{summary.groupName || 'Not recorded'}</strong>
        </span>
        <span>
          <small>Role</small>
          <strong>{formatTokenLabel(summary.intendedRole)}</strong>
        </span>
        <span>
          <small>Expires</small>
          <strong>{formatDate(summary.expiresAt)}</strong>
        </span>
        <span>
          <small>Email scope</small>
          <strong>
            {summary.emailRequired
              ? summary.emailHint || 'Email-specific'
              : 'Open invite/code'}
          </strong>
        </span>
      </dl>
    </div>
  );
}

function getAcceptLabel(summary) {
  return summary.kind === 'code' ? 'Join group' : 'Accept invite';
}

function getInitialCodeFromLocation() {
  if (typeof window === 'undefined') {
    return '';
  }

  return new URLSearchParams(window.location.search).get('code') ?? '';
}
