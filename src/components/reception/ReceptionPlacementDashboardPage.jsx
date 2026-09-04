import { useMemo, useState } from 'react';

import useReceptionPlacementResults from '../../hooks/useReceptionPlacementResults.js';
import {
  PLACEMENT_STATUSES,
} from '../../lib/placementResultService.js';
import {
  getRoleLabel,
  hasReceptionPlacementDashboardAccess,
} from '../../lib/roleUtils.js';
import {
  CardFact,
  DetailStatePanel,
  formatDate,
  formatTokenLabel,
} from '../admin/AdminDetailShared.jsx';

const initialFilters = {
  search: '',
  status: '',
  pathway: '',
  campus: '',
  fromDate: '',
  toDate: '',
};

export default function ReceptionPlacementDashboardPage({
  onBackHome,
  onBrowseExams,
  onOpenAccount,
}) {
  const dashboard = useReceptionPlacementResults();
  const {
    dashboardLoading,
    error,
    isAuthenticated,
    isPlatformOwner,
    isSupabaseConfigured,
    loading,
    memberships,
    primaryRole,
    refresh,
    results,
    totals,
    updateResult,
  } = dashboard;
  const [filters, setFilters] = useState(initialFilters);
  const [selectedResultId, setSelectedResultId] = useState('');
  const [detailForm, setDetailForm] = useState({
    status: 'new',
    receptionNotes: '',
  });
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const canOpenDashboard = hasReceptionPlacementDashboardAccess({
    isPlatformOwner,
    memberships,
  });
  const selectedResult = useMemo(
    () => results.find((result) => result.id === selectedResultId) ?? null,
    [results, selectedResultId],
  );
  const pathwayOptions = useMemo(
    () => createUniqueOptions(results.map((result) => result.recommendedPathway)),
    [results],
  );
  const campusOptions = useMemo(
    () => createUniqueOptions(results.map((result) => result.campusName)),
    [results],
  );
  const filteredResults = useMemo(
    () => results.filter((result) => matchesFilters(result, filters)),
    [filters, results],
  );

  return (
    <section className="management-page reception-placement-page" aria-labelledby="reception-placement-heading">
      <div className="view-toolbar no-print">
        <div>
          <p className="eyebrow">Reception placement</p>
          <h2 id="reception-placement-heading">Placement Results Dashboard</h2>
          <p>
            Review IT Direction Assessment results for follow-up. This dashboard
            does not show certification exam attempts, saved exam history, or
            trainer analytics.
          </p>
        </div>
        <div className="button-row wrap">
          <button className="secondary-button" type="button" onClick={onOpenAccount}>
            Back to Account
          </button>
        </div>
      </div>

      {!isSupabaseConfigured ? (
        <DetailStatePanel
          title="Placement dashboard is not configured here"
          note="This environment is running without Supabase placement storage or protected certification exam access."
        />
      ) : null}

      {isSupabaseConfigured && !isAuthenticated ? (
        <DetailStatePanel
          title="Sign in to view placement results"
          note="Sign in with a Reception, scoped admin, Developer, or Platform Owner account. Protected certification exams require sign-in and access."
        />
      ) : null}

      {isSupabaseConfigured && isAuthenticated && loading && !results.length ? (
        <DetailStatePanel
          title="Loading placement results..."
          note="CertSim is checking your reception/admin scope."
        />
      ) : null}

      {isSupabaseConfigured && isAuthenticated && !loading && !canOpenDashboard ? (
        <DetailStatePanel
          title="Placement dashboard is not available for this account"
          note={`Your current role is ${getRoleLabel(primaryRole)}. This page is limited to Reception, scoped admins, Developers, and Platform Owner.`}
        />
      ) : null}

      {canOpenDashboard ? (
        <>
          {error ? <p className="auth-panel-error">{error}</p> : null}
          {actionMessage ? (
            <p className="auth-panel-success">{actionMessage}</p>
          ) : null}
          {actionError ? <p className="auth-panel-error">{actionError}</p> : null}

          <section className="management-summary-grid reception-placement-summary" aria-label="Placement summary">
            <SummaryTile label="New" value={totals.new} />
            <SummaryTile label="Contacted" value={totals.contacted} />
            <SummaryTile label="Scheduled" value={totals.scheduled} />
            <SummaryTile label="Enrolled" value={totals.enrolled} />
            <SummaryTile label="Not interested" value={totals.notInterested} />
            <SummaryTile label="Archived" value={totals.archived} />
            <SummaryTile label="Total results" value={totals.total} />
          </section>

          <section className="management-filter-panel no-print">
            <div>
              <h3>Find placement results</h3>
              <p>
                Filter by client name, contact, status, pathway, campus, or
                submitted date. This list is placement-only.
              </p>
            </div>
            <div className="management-filter-grid">
              <FilterField label="Search">
                <input
                  type="search"
                  value={filters.search}
                  onChange={(event) => updateFilter('search', event.target.value)}
                  placeholder="Name, contact, email, pathway"
                />
              </FilterField>
              <FilterField label="Status">
                <select
                  value={filters.status}
                  onChange={(event) => updateFilter('status', event.target.value)}
                >
                  <option value="">All statuses</option>
                  {PLACEMENT_STATUSES.map((status) => (
                    <option key={status.value} value={status.value}>
                      {status.label}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Recommended pathway">
                <select
                  value={filters.pathway}
                  onChange={(event) => updateFilter('pathway', event.target.value)}
                >
                  <option value="">All pathways</option>
                  {pathwayOptions.map((pathway) => (
                    <option key={pathway} value={pathway}>
                      {pathway}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="Campus">
                <select
                  value={filters.campus}
                  onChange={(event) => updateFilter('campus', event.target.value)}
                >
                  <option value="">All visible campuses</option>
                  {campusOptions.map((campus) => (
                    <option key={campus} value={campus}>
                      {campus}
                    </option>
                  ))}
                </select>
              </FilterField>
              <FilterField label="From date">
                <input
                  type="date"
                  value={filters.fromDate}
                  onChange={(event) => updateFilter('fromDate', event.target.value)}
                />
              </FilterField>
              <FilterField label="To date">
                <input
                  type="date"
                  value={filters.toDate}
                  onChange={(event) => updateFilter('toDate', event.target.value)}
                />
              </FilterField>
            </div>
            <div className="button-row wrap">
              <button
                className="secondary-button compact-button"
                type="button"
                onClick={() => setFilters(initialFilters)}
              >
                Clear filters
              </button>
              <button
                className="primary-button compact-button"
                type="button"
                disabled={dashboardLoading}
                onClick={refresh}
              >
                {dashboardLoading ? 'Refreshing...' : 'Refresh results'}
              </button>
            </div>
          </section>

          <section className="reception-placement-layout">
            <div className="placement-result-list" aria-label="Placement result list">
              <div className="saved-result-detail-header">
                <div>
                  <h3>Placement results</h3>
                  <p>
                    Showing {filteredResults.length} of {results.length} visible
                    placement results.
                  </p>
                </div>
              </div>

              {filteredResults.length === 0 ? (
                <DetailStatePanel
                  title="No placement results match"
                  note="Try clearing filters or taking the IT Direction Assessment first."
                />
              ) : (
                <div className="assignment-card-list">
                  {filteredResults.map((result) => (
                    <PlacementResultCard
                      key={result.id}
                      result={result}
                      selected={result.id === selectedResultId}
                      onOpen={() => openDetail(result)}
                    />
                  ))}
                </div>
              )}
            </div>

            <aside className="placement-result-detail-panel" aria-label="Placement result detail">
              {selectedResult ? (
                <form className="placement-detail-form" onSubmit={handleSaveDetail}>
                  <div className="saved-result-detail-header">
                    <div>
                      <p className="eyebrow">Placement detail</p>
                      <h3>{getClientName(selectedResult)}</h3>
                      <p>{selectedResult.recommendedPathway || 'No pathway recorded'}</p>
                    </div>
                    <span className={`assignment-progress-pill ${selectedResult.status}`}>
                      {formatTokenLabel(selectedResult.status)}
                    </span>
                  </div>

                  <dl className="trainer-assignment-card-meta">
                    <CardFact label="Contact" value={selectedResult.contact} />
                    <CardFact label="Email" value={selectedResult.email} />
                    <CardFact label="Campus" value={selectedResult.campusName} />
                    <CardFact label="Submitted" value={formatDate(selectedResult.createdAt)} />
                  </dl>

                  <section className="placement-detail-section">
                    <h4>Result summary</h4>
                    <p>{selectedResult.resultSummary || 'No summary recorded.'}</p>
                    <p>{selectedResult.responseSummary?.interestReadinessSummary}</p>
                    <p>{selectedResult.responseSummary?.readinessMessage}</p>
                  </section>

                  <section className="placement-detail-section">
                    <h4>Pathway scores</h4>
                    <div className="placement-score-list">
                      {selectedResult.pathwayScores.map((pathway) => (
                        <span key={pathway.id || pathway.name}>
                          <strong>{pathway.name}</strong>
                          <small>
                            Total {pathway.total ?? 0} / Interest{' '}
                            {pathway.interest ?? 0} / Knowledge{' '}
                            {pathway.knowledge ?? 0}
                          </small>
                        </span>
                      ))}
                    </div>
                  </section>

                  <section className="placement-detail-section">
                    <h4>Discussion notes</h4>
                    <ul className="assessment-discussion-list">
                      {(selectedResult.responseSummary?.discussionNotes ?? []).map(
                        (note) => (
                          <li key={note}>{note}</li>
                        ),
                      )}
                    </ul>
                  </section>

                  <label>
                    Follow-up status
                    <select
                      value={detailForm.status}
                      onChange={(event) =>
                        setDetailForm((current) => ({
                          ...current,
                          status: event.target.value,
                        }))
                      }
                    >
                      {PLACEMENT_STATUSES.map((status) => (
                        <option key={status.value} value={status.value}>
                          {status.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label>
                    Reception notes
                    <textarea
                      rows="5"
                      value={detailForm.receptionNotes}
                      onChange={(event) =>
                        setDetailForm((current) => ({
                          ...current,
                          receptionNotes: event.target.value,
                        }))
                      }
                      placeholder="Follow-up notes, appointment details, or outcome."
                    />
                  </label>

                  <div className="button-row wrap">
                    <button
                      className="primary-button"
                      type="submit"
                      disabled={isSaving}
                    >
                      {isSaving ? 'Saving...' : 'Save follow-up'}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => setSelectedResultId('')}
                    >
                      Close detail
                    </button>
                  </div>
                </form>
              ) : (
                <DetailStatePanel
                  title="Open a placement result"
                  note="Select a result to review intake details, pathway scores, status, and reception notes."
                />
              )}
            </aside>
          </section>
        </>
      ) : null}
    </section>
  );

  function updateFilter(field, value) {
    setFilters((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function openDetail(result) {
    setSelectedResultId(result.id);
    setDetailForm({
      status: result.status || 'new',
      receptionNotes: result.receptionNotes || '',
    });
    setActionMessage('');
    setActionError('');
  }

  async function handleSaveDetail(event) {
    event.preventDefault();

    if (!selectedResult) {
      return;
    }

    setIsSaving(true);
    setActionMessage('');
    setActionError('');

    const result = await updateResult({
      resultId: selectedResult.id,
      status: detailForm.status,
      receptionNotes: detailForm.receptionNotes,
    });

    if (result.ok) {
      setActionMessage('Placement follow-up updated.');
      setSelectedResultId(selectedResult.id);
    } else {
      setActionError(result.message);
    }

    setIsSaving(false);
  }
}

function PlacementResultCard({ onOpen, result, selected }) {
  const secondary = result.secondaryPathways?.[0]?.name;

  return (
    <article className={`trainer-assignment-card ${selected ? 'selected' : ''}`}>
      <div className="trainer-assignment-card-header">
        <div>
          <h4>{getClientName(result)}</h4>
          <p>{result.contact || result.email || 'No contact recorded'}</p>
        </div>
        <span className={`assignment-progress-pill ${result.status}`}>
          {formatTokenLabel(result.status)}
        </span>
      </div>
      <dl className="trainer-assignment-card-meta">
        <CardFact label="Recommended" value={result.recommendedPathway} />
        <CardFact label="Secondary" value={secondary} />
        <CardFact label="Campus" value={result.campusName} />
        <CardFact label="Submitted" value={formatDate(result.createdAt)} />
      </dl>
      <div className="trainer-assignment-card-footer no-print">
        <button
          className="secondary-button compact-button"
          type="button"
          onClick={onOpen}
        >
          Open detail
        </button>
      </div>
    </article>
  );
}

function FilterField({ children, label }) {
  return (
    <label className="management-filter-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function SummaryTile({ label, value }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value || value === 0 ? value : '0'}</strong>
    </div>
  );
}

function matchesFilters(result, filters) {
  const haystack = [
    getClientName(result),
    result.contact,
    result.email,
    result.recommendedPathway,
    result.campusName,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const search = filters.search.trim().toLowerCase();

  if (search && !haystack.includes(search)) {
    return false;
  }

  if (filters.status && result.status !== filters.status) {
    return false;
  }

  if (filters.pathway && result.recommendedPathway !== filters.pathway) {
    return false;
  }

  if (filters.campus && result.campusName !== filters.campus) {
    return false;
  }

  if (filters.fromDate && new Date(result.createdAt) < new Date(filters.fromDate)) {
    return false;
  }

  if (filters.toDate) {
    const toDate = new Date(filters.toDate);
    toDate.setHours(23, 59, 59, 999);

    if (new Date(result.createdAt) > toDate) {
      return false;
    }
  }

  return true;
}

function createUniqueOptions(values = []) {
  return [...new Set(values.filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function getClientName(result) {
  return [result.firstName, result.lastName].filter(Boolean).join(' ') || 'Not recorded';
}
