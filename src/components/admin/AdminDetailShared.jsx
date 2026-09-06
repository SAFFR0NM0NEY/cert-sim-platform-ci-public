import { useMemo, useState } from 'react';

import { getRoleLabel } from '../../lib/roleUtils.js';

export function AdminDetailShell({
  children,
  eyebrow,
  onBackHome,
  onBackToManagement,
  onBrowseExams,
  title,
}) {
  return (
    <section className="management-page admin-detail-page" aria-labelledby="admin-detail-heading">
      <div className="view-toolbar no-print">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2 id="admin-detail-heading">{title}</h2>
        </div>
        <div className="button-row wrap">
          <button className="secondary-button" type="button" onClick={onBackToManagement}>
            Back to Organisation Management
          </button>
        </div>
      </div>
      {children}
    </section>
  );
}

export function DetailStatePanel({ note, title }) {
  return (
    <section className="management-state">
      <p className="auth-panel-title">{title}</p>
      <p className="auth-panel-muted">{note}</p>
    </section>
  );
}

export function SummaryTile({ label, value }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value || value === 0 ? value : 'Not recorded'}</strong>
    </div>
  );
}

export function FactList({ facts }) {
  return (
    <dl className="saved-result-facts">
      {facts.map((fact) => (
        <div key={fact.label}>
          <dt>{fact.label}</dt>
          <dd>{fact.value || fact.value === 0 ? fact.value : 'Not recorded'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RecordCards({ emptyNote, emptyTitle, items, renderItem }) {
  if (!Array.isArray(items) || items.length === 0) {
    return <DetailStatePanel title={emptyTitle} note={emptyNote} />;
  }

  return <div className="assignment-card-list">{items.map(renderItem)}</div>;
}

export function MembershipCards({ memberships = [] }) {
  const [showInactiveMemberships, setShowInactiveMemberships] = useState(false);
  const visibleMemberships = useMemo(
    () =>
      showInactiveMemberships
        ? memberships
        : memberships.filter((membership) => membership.status === 'active'),
    [memberships, showInactiveMemberships],
  );
  const hasInactiveMemberships = memberships.some(
    (membership) => membership.status !== 'active',
  );

  return (
    <>
      {hasInactiveMemberships ? (
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
      ) : null}
      <RecordCards
        emptyTitle="No active memberships"
        emptyNote="No active profile memberships are visible in this scoped view."
        items={visibleMemberships}
        renderItem={(membership) => (
        <article className="trainer-assignment-card" key={membership.id}>
          <div className="trainer-assignment-card-header">
            <div>
              <h4>{formatProfileLabel(membership.profile)}</h4>
              <p>{formatProfileSecondaryLabel(membership.profile)}</p>
            </div>
            <span className={`assignment-progress-pill ${membership.status}`}>
              {formatTokenLabel(membership.status)}
            </span>
          </div>
          <dl className="trainer-assignment-card-meta">
            <CardFact label="Role" value={getRoleLabel(membership.role)} />
            <CardFact label="Organisation" value={membership.organisation?.name} />
            <CardFact label="Campus" value={membership.campus?.name} />
            <CardFact label="Group" value={membership.group?.name} />
          </dl>
        </article>
        )}
      />
    </>
  );
}

export function AssignmentCards({ assignments = [], onOpenAssignment }) {
  return (
    <RecordCards
      emptyTitle="No group assignments"
      emptyNote="No exam assignments are visible for this group yet."
      items={assignments}
      renderItem={(assignment) => (
        <article className="trainer-assignment-card" key={assignment.id}>
          <div className="trainer-assignment-card-header">
            <div>
              <h4>{assignment.title || 'Untitled assignment'}</h4>
              <p>{assignment.examKey} - {assignment.examTitle}</p>
            </div>
            <span className={`assignment-progress-pill ${assignment.status}`}>
              {formatTokenLabel(assignment.status)}
            </span>
          </div>
          <dl className="trainer-assignment-card-meta">
            <CardFact label="Target" value={assignment.targetLabel} />
            <CardFact label="Due" value={formatDate(assignment.dueAt)} />
            <CardFact label="Assigned by" value={assignment.assignedByName} />
            <CardFact label="Created" value={formatDate(assignment.createdAt)} />
          </dl>
          {onOpenAssignment ? (
            <div className="trainer-assignment-card-footer no-print">
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => onOpenAssignment(assignment.id)}
              >
                Open assignment
              </button>
            </div>
          ) : null}
        </article>
      )}
    />
  );
}

export function SavedResultCards({ results = [], onOpenSavedResult }) {
  return (
    <RecordCards
      emptyTitle="No saved results"
      emptyNote="Students in this group do not have visible saved exam results yet."
      items={results}
      renderItem={(result) => (
        <article className="trainer-assignment-card" key={result.attemptId}>
          <div className="trainer-assignment-card-header">
            <div>
              <h4>{result.studentName || 'Student'}</h4>
              <p>{result.examTitle || result.examKey} - {result.modeLabel || result.profileLabel}</p>
            </div>
            <span className={`assignment-progress-pill ${result.passed ? 'ready' : 'needs-review'}`}>
              {formatResultStatus(result)}
            </span>
          </div>
          <dl className="trainer-assignment-card-meta">
            <CardFact label="Scaled score" value={formatScore(result.scaledScore)} />
            <CardFact label="Raw percentage" value={formatPercentage(result.rawPercentage)} />
            <CardFact label="Submitted" value={formatDate(result.submittedAt)} />
            <CardFact label="Responses" value={result.responseCount} />
          </dl>
          {onOpenSavedResult ? (
            <div className="trainer-assignment-card-footer no-print">
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => onOpenSavedResult(result.attemptId)}
              >
                Open saved result
              </button>
            </div>
          ) : null}
        </article>
      )}
    />
  );
}

export function CardFact({ label, value }) {
  return (
    <span>
      <small>{label}</small>
      <strong>{value || value === 0 ? value : 'Not recorded'}</strong>
    </span>
  );
}

export function FormTextField({
  label,
  onChange,
  required = false,
  type = 'text',
  value,
}) {
  return (
    <label>
      {label}
      <input
        required={required}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function FormSelectField({ label, onChange, options, value }) {
  return (
    <label>
      {label}
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function formatProfileLabel(profile = {}) {
  return (
    profile?.display_name ||
    profile?.full_name ||
    getNameFromEmail(profile?.email) ||
    'Not recorded'
  );
}

export function formatProfileSecondaryLabel(profile = {}) {
  return profile?.email || profile?.status || 'No email recorded';
}

export function formatTokenLabel(value) {
  return String(value || 'not_recorded')
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export function formatDate(value) {
  if (!value) {
    return 'Not recorded';
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function formatScore(value) {
  return value || value === 0 ? String(value) : 'Not recorded';
}

export function formatPercentage(value) {
  return value || value === 0 ? `${Math.round(Number(value))}%` : 'Not recorded';
}

function formatResultStatus(result = {}) {
  if (result.passed === true) {
    return 'Passed';
  }

  if (result.passed === false) {
    return 'Needs review';
  }

  return formatTokenLabel(result.status);
}

function getNameFromEmail(email) {
  const text = typeof email === 'string' ? email.trim() : '';

  return text.includes('@') ? text.split('@')[0] : '';
}
