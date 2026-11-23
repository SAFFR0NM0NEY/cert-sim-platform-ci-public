import { useMemo, useState } from 'react';

import AnswerComparison from '../exam/AnswerComparison.jsx';
import { createSavedAttemptReview } from '../../lib/savedAttemptReviewMapper.js';
import { downloadSavedResultSummaryPdf } from '../../lib/savedResultReportExport.js';
import {
  createSavedResultSummaryText,
  formatSavedDuration,
  formatSavedRawPercentage,
  formatSavedResponseCount,
  formatSavedResultDate,
  formatSavedResultMode,
  formatSavedResultScore,
  formatSavedResultStatus,
  getSavedResultBreakdownRows,
  getSavedResultDomainMissingMessage,
  getSavedResultDomainRows,
  getSavedResultWeakAreaRows,
} from '../../lib/savedResultFormatters.js';
import {
  filterSavedReviewItems,
  getReviewFilterCounts,
  paginateItems,
  SAVED_REVIEW_PAGE_SIZE,
} from '../../lib/savedResultsView.js';

export default function SavedResultDetail({
  onBack,
  onClose,
  result,
  showReview = false,
}) {
  const [actionMessage, setActionMessage] = useState('');
  const [actionError, setActionError] = useState('');
  const [isPdfDownloading, setIsPdfDownloading] = useState(false);
  const domainRows = getSavedResultDomainRows(result);
  const weakAreaRows = getSavedResultWeakAreaRows(result);
  const pbqRows = getSavedResultBreakdownRows(result.pbqBreakdown, 'PBQ');
  const caseStudyRows = getSavedResultBreakdownRows(
    result.caseStudyBreakdown,
    'Case study',
  );
  const savedReview = useMemo(() => createSavedAttemptReview(result), [result]);

  return (
    <section className="saved-result-detail" aria-label="Saved result detail">
      <div className="saved-result-detail-header">
        <div>
          <p className="auth-panel-title">{result.examTitle}</p>
          <p className="auth-panel-note">{formatSavedResultMode(result)}</p>
          <p className="auth-panel-muted">
            {result.examKey || 'Exam key not recorded'}
            {result.reportTitle ? ` · ${result.reportTitle}` : ''}
          </p>
        </div>
        <div className="saved-result-actions no-print">
          {onBack ? (
            <button className="auth-panel-toggle" type="button" onClick={onBack}>
              Back to Saved Results
            </button>
          ) : null}
          <button className="auth-panel-toggle" type="button" onClick={handleCopySummary}>
            Copy summary
          </button>
          <button className="auth-panel-toggle" type="button" onClick={handlePrint}>
            Print
          </button>
          <button
            className="auth-panel-toggle"
            disabled={isPdfDownloading}
            type="button"
            onClick={handleDownloadPdf}
          >
            {isPdfDownloading ? 'Preparing PDF...' : 'Download PDF'}
          </button>
          {onClose ? (
            <button className="auth-panel-toggle" type="button" onClick={onClose}>
              Close
            </button>
          ) : null}
        </div>
      </div>

      {actionMessage ? (
        <p className="auth-panel-success" aria-live="polite">{actionMessage}</p>
      ) : null}
      {actionError ? (
        <p className="auth-panel-error" role="alert">{actionError}</p>
      ) : null}

      <dl className="saved-result-facts">
        <SavedResultFact label="Score" value={formatSavedResultScore(result)} />
        <SavedResultFact label="Raw percentage" value={formatSavedRawPercentage(result)} />
        <SavedResultFact label="Status" value={formatSavedResultStatus(result)} />
        <SavedResultFact
          label="Submitted"
          value={formatSavedResultDate(result.submittedAt)}
        />
        <SavedResultFact
          label="Responses"
          value={formatSavedResponseCount(result.responseCount)}
        />
        <SavedResultFact
          label="Duration"
          value={formatSavedDuration(result.durationSeconds)}
        />
      </dl>

      {domainRows.length > 0 ? (
        <SavedResultRows
          rows={domainRows.map((domain) => ({
            label: domain.domain,
            status: domain.percentage,
            score: domain.score,
          }))}
          title="Domain breakdown"
        />
      ) : (
        <SavedResultEmpty
          title="Domain breakdown"
          message={getSavedResultDomainMissingMessage(result)}
        />
      )}

      {weakAreaRows.length > 0 ? (
        <SavedResultRows
          rows={weakAreaRows.map((area) => ({
            label: area.label,
            status: area.detail || 'Review recommended',
            score: '',
          }))}
          title="Weak areas"
        />
      ) : (
        <SavedResultEmpty title="Weak areas" message="No stored weak areas below the configured threshold." />
      )}

      {pbqRows.length > 0 ? (
        <SavedResultRows rows={pbqRows} title="PBQ breakdown" />
      ) : null}

      {caseStudyRows.length > 0 ? (
        <SavedResultRows rows={caseStudyRows} title="Case-study breakdown" />
      ) : null}

      {showReview ? <SavedAttemptReview review={savedReview} /> : null}

      <p className="auth-panel-muted">
        Saved history is student self-history only. Full historical answer review is
        available only when the saved snapshots contain enough review-safe data.
      </p>
    </section>
  );

  async function handleCopySummary() {
    setActionError('');
    const summary = createSavedResultSummaryText(result);

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(summary);
        setActionMessage('Saved result summary copied.');
        return;
      }

      copyWithTextareaFallback(summary);
      setActionMessage('Saved result summary copied.');
    } catch {
      setActionError('Copy failed. Select the visible summary details instead.');
    }
  }

  function handlePrint() {
    setActionError('');
    setActionMessage('Print dialog opened. Choose a printer or Save as PDF.');
    window.print();
  }

  async function handleDownloadPdf() {
    setActionError('');
    setActionMessage('');
    setIsPdfDownloading(true);

    try {
      const { filename } = await downloadSavedResultSummaryPdf(result);
      setActionMessage(`Downloaded ${filename}.`);
    } catch {
      setActionError('PDF download failed. Use Print as a fallback.');
    } finally {
      setIsPdfDownloading(false);
    }
  }
}

export function SavedResultFact({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || 'Not recorded'}</dd>
    </div>
  );
}

export function SavedResultRows({ rows, title }) {
  return (
    <div className="saved-result-domains">
      <p className="auth-panel-title">{title}</p>
      <ul>
        {rows.map((row) => (
          <li key={`${title}-${row.label}-${row.status}-${row.score}`}>
            <span>{row.label}</span>
            {row.status ? <strong>{row.status}</strong> : null}
            {row.score ? <small>{row.score}</small> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SavedResultEmpty({ message, title }) {
  return (
    <div className="saved-results-state compact">
      <p className="auth-panel-title">{title}</p>
      <p className="auth-panel-muted">{message}</p>
    </div>
  );
}

function SavedAttemptReview({ review }) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [expandedItemId, setExpandedItemId] = useState('');

  if (!review.available) {
    return (
      <section className="saved-attempt-review">
        <p className="auth-panel-title">Saved answer review</p>
        <p className="auth-panel-muted">{review.message}</p>
      </section>
    );
  }

  const counts = getReviewFilterCounts(review.items);
  const filteredItems = filterSavedReviewItems(review.items, { search, filter });
  const pagination = paginateItems(filteredItems, page, SAVED_REVIEW_PAGE_SIZE);
  const filters = [
    ['all', 'All'], ['incorrect', 'Incorrect'], ['incomplete', 'Incomplete'],
    ['partial', 'Partial'], ['unanswered', 'Unanswered'], ['correct', 'Correct'],
    ['pbq', 'PBQ'], ['flagged', 'Flagged'],
  ];

  function updateFilter(nextFilter) {
    setFilter(nextFilter);
    setPage(1);
    setExpandedItemId('');
  }

  function updateSearch(value) {
    setSearch(value);
    setPage(1);
    setExpandedItemId('');
  }

  return (
    <section className="saved-attempt-review" aria-label="Saved answer review">
      <div className="saved-results-header">
        <div>
          <p className="auth-panel-title">Saved answer review</p>
          <p className="auth-panel-muted">{review.message}</p>
        </div>
        <button className="secondary-button compact-button" type="button" aria-expanded={isOpen} onClick={() => setIsOpen((current) => !current)}>
          {isOpen ? 'Close saved answer review' : `Review saved answers (${review.items.length})`}
        </button>
      </div>
      {isOpen ? (
        <>
          <div className="saved-review-controls">
            <label>
              <span>Search question ID</span>
              <input type="search" value={search} onChange={(event) => updateSearch(event.target.value)} />
            </label>
            <div className="saved-review-filters" aria-label="Answer review filters">
              {filters.map(([id, label]) => (
                <button className={filter === id ? 'active' : ''} type="button" key={id} onClick={() => updateFilter(id)}>
                  {label} ({counts[id]})
                </button>
              ))}
            </div>
          </div>
          <p className="auth-panel-note">{filteredItems.length} matching saved answer{filteredItems.length === 1 ? '' : 's'}</p>
          {filteredItems.length === 0 ? (
            <p className="auth-panel-muted">
              {search ? 'No question ID matches this search and filter.' : 'No saved answers match this filter.'}
            </p>
          ) : (
            <>
              <div className="saved-attempt-review-list">
                {pagination.items.map((item) => {
                  const expanded = expandedItemId === item.id;
                  return (
                    <article className="saved-attempt-review-item" key={item.id}>
                      <div className="saved-attempt-review-header">
                        <div>
                          <h3>Question {item.number} — {item.id}</h3>
                          <p>{item.type} | {item.domain}</p>
                          <div className="review-marker-row">
                            {item.isPBQ ? <span>PBQ</span> : null}
                            {item.isFlagged ? <span>Marked for Review</span> : null}
                          </div>
                        </div>
                        <span className={getReviewStatusClass(item.status)}>{item.status}</span>
                      </div>
                      <button className="secondary-button compact-button" type="button" aria-expanded={expanded} onClick={() => setExpandedItemId(expanded ? '' : item.id)}>
                        {expanded ? 'Hide answer details' : 'Open answer details'}
                      </button>
                      {expanded ? <SavedReviewItemDetails item={item} /> : null}
                    </article>
                  );
                })}
              </div>
              <nav className="saved-pagination" aria-label="Saved answer review pages">
                <button type="button" disabled={pagination.currentPage === 1} onClick={() => { setPage(pagination.currentPage - 1); setExpandedItemId(''); }}>Previous</button>
                <span>Page {pagination.currentPage} of {pagination.totalPages}</span>
                <button type="button" disabled={pagination.currentPage === pagination.totalPages} onClick={() => { setPage(pagination.currentPage + 1); setExpandedItemId(''); }}>Next</button>
              </nav>
            </>
          )}
        </>
      ) : null}
    </section>
  );
}

function SavedReviewItemDetails({ item }) {
  return (
    <div className="saved-review-item-details">
      <p>{item.prompt}</p>
      {item.answerComparison ? (
        <AnswerComparison comparison={item.answerComparison} title="Answer comparison" />
      ) : (
        <div className="saved-attempt-review-answer-grid">
          <SavedAnswerBox label="Student answer" text={item.studentAnswer} />
          <SavedAnswerBox label="Correct answer" text={item.correctAnswer} />
        </div>
      )}
      {item.explanation ? <p className="auth-panel-muted"><strong>Explanation:</strong> {item.explanation}</p> : null}
      {item.remediation ? <p className="auth-panel-muted"><strong>Remediation:</strong> {item.remediation}</p> : null}
    </div>
  );
}

function SavedAnswerBox({ label, text }) {
  return (
    <section>
      <h4>{label}</h4>
      <pre>{text || 'Not recorded'}</pre>
    </section>
  );
}

function getReviewStatusClass(status) {
  return `saved-attempt-review-status ${String(status ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')}`;
}

function copyWithTextareaFallback(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}
