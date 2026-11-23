import { useMemo, useState } from 'react';

import useOnboarding from '../../hooks/useOnboarding.js';
import {
  ONBOARDING_ROLE_OPTIONS,
  buildCodeJoinLink,
  buildInviteLink,
  parseBulkInviteRows,
} from '../../lib/onboardingService.js';
import {
  CardFact,
  DetailStatePanel,
  formatDate,
  formatTokenLabel,
} from '../admin/AdminDetailShared.jsx';

const inviteFormInitialState = {
  email: '',
  intendedRole: 'student',
  expiresAt: '',
  notes: '',
};

const codeFormInitialState = {
  maxUses: '',
  expiresAt: '',
  notes: '',
};

export default function OnboardingManagementPanel({
  canManage = false,
  campusId = '',
  enableBulk = false,
  groupId = '',
  organisationId = '',
  scopeLabel = 'scope',
  scopeType,
}) {
  const onboarding = useOnboarding({
    scopeType,
    organisationId,
    campusId,
    groupId,
  });
  const {
    accessCodes,
    createAccessCode,
    createBulkInvites,
    createInvite,
    disableAccessCode,
    error,
    invites,
    isAuthenticated,
    isSupabaseConfigured,
    loading,
    refresh,
    revokeInvite,
  } = onboarding;
  const [inviteForm, setInviteForm] = useState(inviteFormInitialState);
  const [codeForm, setCodeForm] = useState(codeFormInitialState);
  const [bulkText, setBulkText] = useState('');
  const [bulkNotes, setBulkNotes] = useState('');
  const [bulkExpiresAt, setBulkExpiresAt] = useState('');
  const [showHistoricalRecords, setShowHistoricalRecords] = useState(false);
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [bulkCreatedInvites, setBulkCreatedInvites] = useState([]);
  const bulkRows = useMemo(() => parseBulkInviteRows(bulkText), [bulkText]);
  const validBulkRows = bulkRows.filter((row) => row.isValid);
  const invalidBulkRows = bulkRows.filter((row) => row.raw && !row.isValid);
  const roleOptions = getRoleOptionsForScope(scopeType);
  const canUseAccessCodes = scopeType === 'group' && groupId;
  const visibleInvites = useMemo(
    () =>
      invites.filter((invite) =>
        showHistoricalRecords ? true : isPendingInvite(invite),
      ),
    [invites, showHistoricalRecords],
  );
  const visibleAccessCodes = useMemo(
    () =>
      accessCodes.filter((accessCode) =>
        showHistoricalRecords ? true : isActiveAccessCode(accessCode),
      ),
    [accessCodes, showHistoricalRecords],
  );
  const hiddenInviteCount = invites.length - visibleInvites.length;
  const hiddenAccessCodeCount = accessCodes.length - visibleAccessCodes.length;

  if (!isSupabaseConfigured) {
    return (
      <section className="management-section no-print">
        <h3>Onboarding</h3>
        <DetailStatePanel
          title="Onboarding is not configured here"
          note="Invite links, access codes, and protected certification exams need Supabase account services."
        />
      </section>
    );
  }

  if (!isAuthenticated) {
    return (
      <section className="management-section no-print">
        <h3>Onboarding</h3>
        <DetailStatePanel
          title="Sign in to view onboarding records"
          note="Scoped admins can manage invite links and access codes after signing in."
        />
      </section>
    );
  }

  return (
    <section className="management-section no-print onboarding-panel">
      <div className="saved-result-detail-header">
        <div>
          <h3>Onboarding</h3>
          <p>
            Invite creates a pending onboarding record. It does not create a
            Supabase Auth user by itself. The invited person still needs to
            sign in or create an account.
          </p>
          <p className="auth-panel-muted">
            {getScopeVisibilityNote(scopeType, scopeLabel)}
          </p>
        </div>
        <button
          className="secondary-button compact-button"
          type="button"
          disabled={loading}
          onClick={refresh}
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {error ? <p className="auth-panel-error">{error}</p> : null}
      {actionMessage ? <p className="auth-panel-success">{actionMessage}</p> : null}
      {actionError ? <p className="auth-panel-error">{actionError}</p> : null}

      <div className="onboarding-visibility-filter">
        <div>
          <strong>
            {showHistoricalRecords
              ? 'Showing all visible onboarding records'
              : 'Showing pending invites and active access codes'}
          </strong>
          <p>
            {showHistoricalRecords
              ? 'Completed, revoked, expired, and disabled records are shown for audit/history.'
              : `${hiddenInviteCount + hiddenAccessCodeCount} completed, expired, revoked, or disabled records are hidden by default.`}
          </p>
        </div>
        <button
          className="secondary-button compact-button"
          type="button"
          onClick={() => setShowHistoricalRecords((current) => !current)}
        >
          {showHistoricalRecords
            ? 'Show pending/active only'
            : 'Show completed/expired invites'}
        </button>
      </div>

      {canManage ? (
        <details className="management-collapsible" open>
          <summary>Create invite for this {scopeLabel}</summary>
          <form className="assignment-detail-form" onSubmit={handleCreateInvite}>
            <label>
              Email optional
              <input
                type="email"
                value={inviteForm.email}
                onChange={(event) => updateInviteForm('email', event.target.value)}
                placeholder="student@example.com"
              />
            </label>
            <label>
              Intended role
              <select
                value={inviteForm.intendedRole}
                onChange={(event) =>
                  updateInviteForm('intendedRole', event.target.value)
                }
              >
                {roleOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Expiry optional
              <input
                type="datetime-local"
                value={inviteForm.expiresAt}
                onChange={(event) =>
                  updateInviteForm('expiresAt', event.target.value)
                }
              />
            </label>
            <label className="assignment-detail-form-wide">
              Notes optional
              <textarea
                rows="2"
                value={inviteForm.notes}
                onChange={(event) => updateInviteForm('notes', event.target.value)}
                placeholder="Internal onboarding note, not sent automatically."
              />
            </label>
            <div className="button-row wrap assignment-detail-form-wide">
              <button
                className="primary-button"
                type="submit"
                disabled={busyAction === 'invite'}
              >
                {busyAction === 'invite' ? 'Creating...' : 'Create invite'}
              </button>
            </div>
          </form>
        </details>
      ) : (
        <p className="auth-panel-muted">
          You can view onboarding records in this scope. Management actions are
          reserved for scoped admins or Platform Owner.
        </p>
      )}

      {canUseAccessCodes ? (
        <details className="management-collapsible" open>
          <summary>Group access code</summary>
          {canManage ? (
            <form className="assignment-detail-form" onSubmit={handleCreateAccessCode}>
              <label>
                Max uses optional
                <input
                  type="number"
                  min="1"
                  value={codeForm.maxUses}
                  onChange={(event) =>
                    updateCodeForm('maxUses', event.target.value)
                  }
                  placeholder="Example: 30"
                />
              </label>
              <label>
                Expiry optional
                <input
                  type="datetime-local"
                  value={codeForm.expiresAt}
                  onChange={(event) =>
                    updateCodeForm('expiresAt', event.target.value)
                  }
                />
              </label>
              <label className="assignment-detail-form-wide">
                Notes optional
                <textarea
                  rows="2"
                  value={codeForm.notes}
                  onChange={(event) => updateCodeForm('notes', event.target.value)}
                  placeholder="Example: Reception code for morning group."
                />
              </label>
              <div className="button-row wrap assignment-detail-form-wide">
                <button
                  className="primary-button"
                  type="submit"
                  disabled={busyAction === 'code'}
                >
                  {busyAction === 'code'
                    ? 'Creating...'
                    : 'Create student access code'}
                </button>
              </div>
            </form>
          ) : null}
          <AccessCodeList
            accessCodes={visibleAccessCodes}
            canManage={canManage}
            busyAction={busyAction}
            scopeLabel={scopeLabel}
            showHistoricalRecords={showHistoricalRecords}
            onCopy={copyText}
            onDisable={handleDisableAccessCode}
          />
        </details>
      ) : null}

      {enableBulk && canManage ? (
        <details className="management-collapsible">
          <summary>Bulk student invite links</summary>
          <form className="assignment-detail-form" onSubmit={handleCreateBulkInvites}>
            <label className="assignment-detail-form-wide">
              Paste rows: email, display_name optional, notes optional
              <textarea
                rows="6"
                value={bulkText}
                onChange={(event) => setBulkText(event.target.value)}
                placeholder="learner1@example.com, Learner One, Optional note"
              />
            </label>
            <label>
              Expiry optional
              <input
                type="datetime-local"
                value={bulkExpiresAt}
                onChange={(event) => setBulkExpiresAt(event.target.value)}
              />
            </label>
            <label>
              Batch notes optional
              <input
                type="text"
                value={bulkNotes}
                onChange={(event) => setBulkNotes(event.target.value)}
                placeholder="Manual invite batch"
              />
            </label>
            <div className="bulk-onboarding-preview assignment-detail-form-wide">
              <strong>Preview</strong>
              <span>{validBulkRows.length} valid rows</span>
              <span>{invalidBulkRows.length} rows need attention</span>
            </div>
            {invalidBulkRows.length > 0 ? (
              <ul className="compact-detail-list assignment-detail-form-wide">
                {invalidBulkRows.slice(0, 5).map((row) => (
                  <li key={`${row.index}-${row.raw}`}>
                    <strong>Row {row.index + 1}</strong>
                    <span>{row.error}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="button-row wrap assignment-detail-form-wide">
              <button
                className="primary-button"
                type="submit"
                disabled={busyAction === 'bulk' || validBulkRows.length === 0}
              >
                {busyAction === 'bulk'
                  ? 'Generating...'
                  : 'Generate invite links'}
              </button>
            </div>
          </form>
          {bulkCreatedInvites.length > 0 ? (
            <BulkInviteLinks invites={bulkCreatedInvites} onCopy={copyText} />
          ) : null}
        </details>
      ) : null}

      <InviteList
        invites={visibleInvites}
        canManage={canManage}
        busyAction={busyAction}
        scopeLabel={scopeLabel}
        scopeType={scopeType}
        showHistoricalRecords={showHistoricalRecords}
        onCopy={copyText}
        onRevoke={handleRevokeInvite}
      />
    </section>
  );

  function updateInviteForm(field, value) {
    setInviteForm((current) => ({ ...current, [field]: value }));
  }

  function updateCodeForm(field, value) {
    setCodeForm((current) => ({ ...current, [field]: value }));
  }

  async function handleCreateInvite(event) {
    event.preventDefault();
    setBusyAction('invite');
    clearActionMessages();

    const result = await createInvite({
      ...inviteForm,
      organisationId,
      campusId,
      groupId,
    });

    if (result.ok) {
      setInviteForm({
        ...inviteFormInitialState,
        intendedRole: roleOptions[0]?.value ?? 'student',
      });
      setActionMessage('Invite created. Copy the link and send it manually.');
    } else {
      setActionError(result.message);
    }

    setBusyAction('');
  }

  async function handleRevokeInvite(inviteId) {
    setBusyAction(`revoke-${inviteId}`);
    clearActionMessages();

    const result = await revokeInvite(inviteId);

    if (result.ok) {
      setActionMessage('Invite revoked.');
    } else {
      setActionError(result.message);
    }

    setBusyAction('');
  }

  async function handleCreateAccessCode(event) {
    event.preventDefault();
    setBusyAction('code');
    clearActionMessages();

    const result = await createAccessCode({
      ...codeForm,
      groupId,
    });

    if (result.ok) {
      setCodeForm(codeFormInitialState);
      setActionMessage('Group access code created. Copy the code or join link.');
    } else {
      setActionError(result.message);
    }

    setBusyAction('');
  }

  async function handleDisableAccessCode(codeId) {
    setBusyAction(`disable-${codeId}`);
    clearActionMessages();

    const result = await disableAccessCode(codeId);

    if (result.ok) {
      setActionMessage('Group access code disabled.');
    } else {
      setActionError(result.message);
    }

    setBusyAction('');
  }

  async function handleCreateBulkInvites(event) {
    event.preventDefault();
    setBusyAction('bulk');
    clearActionMessages();

    const result = await createBulkInvites({
      groupId,
      invites: validBulkRows,
      expiresAt: bulkExpiresAt,
      notes: bulkNotes,
    });

    if (result.ok) {
      setBulkCreatedInvites(result.data ?? []);
      setBulkText('');
      setBulkNotes('');
      setBulkExpiresAt('');
      setActionMessage(
        `${result.data?.length ?? 0} invite links generated. Send them manually.`,
      );
    } else {
      setActionError(result.message);
    }

    setBusyAction('');
  }

  async function copyText(text, successMessage = 'Copied.') {
    clearActionMessages();

    try {
      await navigator.clipboard.writeText(text);
      setActionMessage(successMessage);
    } catch {
      setActionError(`Copy manually: ${text}`);
    }
  }

  function clearActionMessages() {
    setActionMessage('');
    setActionError('');
  }
}

function InviteList({
  busyAction,
  canManage,
  invites = [],
  onCopy,
  onRevoke,
  scopeLabel,
  scopeType,
  showHistoricalRecords,
}) {
  if (invites.length === 0) {
    return (
      <DetailStatePanel
        title={
          showHistoricalRecords
            ? `No invites for this ${scopeLabel}`
            : getNoPendingInviteTitle(scopeType, scopeLabel)
        }
        note={
          showHistoricalRecords
            ? 'No onboarding invite records are visible in this scope.'
            : 'Accepted, revoked, and expired invite records are retained for audit/history but hidden by default.'
        }
      />
    );
  }

  return (
    <div className="assignment-card-list">
      {invites.map((invite) => {
        const displayStatus = getInviteDisplayStatus(invite);
        const canUseInviteLink = displayStatus === 'pending';

        return (
          <article className="trainer-assignment-card" key={invite.id}>
            <div className="trainer-assignment-card-header">
              <div>
                <h4>{invite.email || 'Open invite link'}</h4>
                <p>{getScopeText(invite)}</p>
              </div>
              <span className={`assignment-progress-pill ${displayStatus}`}>
                {formatTokenLabel(displayStatus)}
              </span>
            </div>
            <dl className="trainer-assignment-card-meta">
              <CardFact label="Role" value={formatTokenLabel(invite.intendedRole)} />
              <CardFact label="Expires" value={formatDate(invite.expiresAt)} />
              <CardFact label="Invited by" value={invite.invitedByName} />
              <CardFact label="Accepted" value={formatDate(invite.acceptedAt)} />
            </dl>
            {invite.notes ? (
              <p className="auth-panel-muted">{invite.notes}</p>
            ) : null}
            {canUseInviteLink ? (
              <div className="trainer-assignment-card-footer no-print">
                <button
                  className="secondary-button compact-button"
                  type="button"
                  onClick={() => onCopy(invite.inviteLink, 'Invite link copied.')}
                >
                  Copy invite link
                </button>
                {canManage ? (
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    disabled={busyAction === `revoke-${invite.id}`}
                    onClick={() => onRevoke(invite.id)}
                  >
                    {busyAction === `revoke-${invite.id}` ? 'Revoking...' : 'Revoke'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function AccessCodeList({
  accessCodes = [],
  busyAction,
  canManage,
  onCopy,
  onDisable,
  scopeLabel,
  showHistoricalRecords,
}) {
  if (accessCodes.length === 0) {
    return (
      <DetailStatePanel
        title={
          showHistoricalRecords
            ? `No access codes for this ${scopeLabel}`
            : `No active access codes for this ${scopeLabel}`
        }
        note="Create a student access code for this group when you are ready to onboard learners."
      />
    );
  }

  return (
    <div className="assignment-card-list">
      {accessCodes.map((accessCode) => {
        const displayStatus = getAccessCodeDisplayStatus(accessCode);
        const canUseAccessCode = displayStatus === 'active';

        return (
          <article className="trainer-assignment-card" key={accessCode.id}>
            <div className="trainer-assignment-card-header">
              <div>
                <h4>{accessCode.code}</h4>
                <p>{getScopeText(accessCode)}</p>
              </div>
              <span className={`assignment-progress-pill ${displayStatus}`}>
                {formatTokenLabel(displayStatus)}
              </span>
            </div>
            <dl className="trainer-assignment-card-meta">
              <CardFact label="Role" value="Student" />
              <CardFact
                label="Uses"
                value={`${accessCode.usesCount}${accessCode.maxUses ? ` / ${accessCode.maxUses}` : ''}`}
              />
              <CardFact label="Expires" value={formatDate(accessCode.expiresAt)} />
              <CardFact label="Created by" value={accessCode.createdByName} />
            </dl>
            {canUseAccessCode ? (
              <div className="trainer-assignment-card-footer no-print">
                <button
                  className="secondary-button compact-button"
                  type="button"
                  onClick={() => onCopy(accessCode.code, 'Access code copied.')}
                >
                  Copy code
                </button>
                <button
                  className="secondary-button compact-button"
                  type="button"
                  onClick={() =>
                    onCopy(buildCodeJoinLink(accessCode.code), 'Join link copied.')
                  }
                >
                  Copy join link
                </button>
                {canManage ? (
                  <button
                    className="secondary-button compact-button"
                    type="button"
                    disabled={busyAction === `disable-${accessCode.id}`}
                    onClick={() => onDisable(accessCode.id)}
                  >
                    {busyAction === `disable-${accessCode.id}`
                      ? 'Disabling...'
                      : 'Disable'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function BulkInviteLinks({ invites, onCopy }) {
  const linkText = invites
    .map((invite) => `${invite.email}, ${buildInviteLink(invite.inviteToken)}`)
    .join('\n');

  return (
    <section className="bulk-onboarding-links">
      <div className="saved-result-detail-header">
        <div>
          <h4>Generated invite links</h4>
          <p>Copy these links and send them manually. No email is sent yet.</p>
        </div>
        <button
          className="secondary-button compact-button"
          type="button"
          onClick={() => onCopy(linkText, 'Bulk invite links copied.')}
        >
          Copy all links
        </button>
      </div>
      <textarea rows="5" readOnly value={linkText} />
    </section>
  );
}

function getRoleOptionsForScope(scopeType) {
  if (scopeType === 'group') {
    return ONBOARDING_ROLE_OPTIONS.filter((option) => option.value === 'student');
  }

  if (scopeType === 'campus') {
    return ONBOARDING_ROLE_OPTIONS.filter((option) =>
      ['student', 'trainer', 'reception', 'campus_admin', 'individual_user'].includes(
        option.value,
      ),
    );
  }

  return ONBOARDING_ROLE_OPTIONS.filter((option) =>
    ['student', 'trainer', 'reception', 'college_admin', 'individual_user'].includes(
      option.value,
    ),
  );
}

function getScopeVisibilityNote(scopeType, scopeLabel) {
  if (scopeType === 'group') {
    return 'Showing invites for this group only. Organisation-level, campus-level, and other group records are hidden here.';
  }

  if (scopeType === 'campus') {
    return 'Showing onboarding records for this campus only, including group records under this campus where visible.';
  }

  if (scopeType === 'organisation') {
    return 'Showing onboarding records for this organisation only, including visible campus and group records under the organisation.';
  }

  return `Showing onboarding records for this ${scopeLabel} only.`;
}

function getNoPendingInviteTitle(scopeType, scopeLabel) {
  if (scopeType === 'group') {
    return 'No pending invites for this group.';
  }

  return `No pending invites for this ${scopeLabel}.`;
}

function getScopeText(record) {
  return [
    record.organisationName,
    record.campusName,
    record.groupName,
  ]
    .filter(Boolean)
    .join(' / ') || 'Scope not recorded';
}

function isPendingInvite(invite) {
  return getInviteDisplayStatus(invite) === 'pending';
}

function isActiveAccessCode(accessCode) {
  return getAccessCodeDisplayStatus(accessCode) === 'active';
}

function getInviteDisplayStatus(invite = {}) {
  if (invite.status === 'pending' && isPastDate(invite.expiresAt)) {
    return 'expired';
  }

  return invite.status || 'pending';
}

function getAccessCodeDisplayStatus(accessCode = {}) {
  if (accessCode.status === 'active') {
    if (isPastDate(accessCode.expiresAt)) {
      return 'expired';
    }

    if (
      accessCode.maxUses &&
      Number(accessCode.usesCount ?? 0) >= Number(accessCode.maxUses)
    ) {
      return 'expired';
    }
  }

  return accessCode.status || 'active';
}

function isPastDate(value) {
  if (!value) {
    return false;
  }

  const date = new Date(value);

  return !Number.isNaN(date.getTime()) && date < new Date();
}
