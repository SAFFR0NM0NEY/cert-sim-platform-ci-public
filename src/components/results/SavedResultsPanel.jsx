import useSavedResults from '../../hooks/useSavedResults.js';
import {
  formatSavedRawPercentage,
  formatSavedResponseCount,
  formatSavedResultDate,
  formatSavedResultMode,
  formatSavedResultScore,
  formatSavedResultStatus,
} from '../../lib/savedResultFormatters.js';
import SavedResultDetail from './SavedResultDetail.jsx';

export default function SavedResultsPanel() {
  const {
    authUnavailableReason,
    clearSelectedResult,
    detailLoading,
    error,
    isAuthenticated,
    isSupabaseConfigured,
    loadResultDetail,
    loading,
    refreshResults,
    results,
    selectedResult,
  } = useSavedResults();

  if (!isSupabaseConfigured) {
    return (
      <section className="saved-results-panel unavailable" aria-label="Saved results history">
        <SavedResultsHeader />
        <p className="auth-panel-muted">
          Saved results are not configured in this environment yet. Exams still
          work in frontend-only mode.
        </p>
        {authUnavailableReason ? (
          <p className="auth-panel-muted">{authUnavailableReason}</p>
        ) : null}
      </section>
    );
  }

  if (!isAuthenticated) {
    return (
      <section className="saved-results-panel signed-out" aria-label="Saved results history">
        <SavedResultsHeader />
        <p className="auth-panel-muted">
          Sign in to view saved account history and access protected certification exams.
        </p>
      </section>
    );
  }

  return (
    <section
      className="saved-results-panel"
      aria-label="Saved results history"
      aria-busy={loading || detailLoading}
    >
      <div className="saved-results-header">
        <SavedResultsHeader />
        <button
          className="auth-panel-toggle"
          type="button"
          onClick={refreshResults}
          disabled={loading}
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {error ? <p className="auth-panel-error">{error}</p> : null}

      {loading && results.length === 0 ? (
        <section className="saved-results-state loading" aria-label="Loading saved results">
          <p className="auth-panel-title">Loading saved results...</p>
          <p className="auth-panel-muted">
            CertSim is reading your own submitted attempts from account history.
          </p>
        </section>
      ) : null}

      {!loading && results.length === 0 ? (
        <section className="saved-results-state empty" aria-label="No saved results">
          <p className="auth-panel-title">No saved results yet</p>
          <p className="auth-panel-muted">
            Eligible completed exam results appear here after auto-save succeeds.
            Sandbox, targeted practice, PBQ preview, and case-study preview are
            intentionally excluded.
          </p>
        </section>
      ) : null}

      {results.length > 0 ? (
        <ul className="saved-results-list">
          {results.map((result) => (
            <li key={result.attemptId}>
              <button
                className={
                  selectedResult?.attemptId === result.attemptId
                    ? 'saved-result-item active'
                    : 'saved-result-item'
                }
                type="button"
                onClick={() => loadResultDetail(result.attemptId)}
              >
                <span className="saved-result-item-main">
                  <strong>{result.examTitle}</strong>
                  <small>{result.attemptKindLabel}</small>
                  <small>{formatSavedResultMode(result)}</small>
                  <small>{formatSavedResultDate(result.submittedAt)}</small>
                </span>
                <span className="saved-result-item-score">
                  <strong>{formatSavedResultScore(result)}</strong>
                  <small>{formatSavedRawPercentage(result)}</small>
                  <small>{formatSavedResultStatus(result)}</small>
                  <small>{formatSavedResponseCount(result.responseCount)}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {detailLoading ? (
        <p className="auth-panel-muted">Opening saved result...</p>
      ) : null}

      {selectedResult ? (
        <SavedResultDetail
          result={selectedResult}
          onClose={clearSelectedResult}
        />
      ) : null}
    </section>
  );
}

function SavedResultsHeader() {
  return (
    <div>
      <p className="auth-panel-title">Saved results history</p>
      <p className="auth-panel-note">
        Your own eligible completed exam attempts saved to this account.
      </p>
    </div>
  );
}
