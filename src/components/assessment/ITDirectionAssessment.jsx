import { useMemo, useState } from 'react';
import { calculateItDirectionResult } from '../../utils/itDirectionScoring.js';
import { downloadItDirectionResultPdf } from '../../utils/reportPdfExport.js';

export function ITDirectionAssessmentIntro({
  assessment,
  onBackHome,
  onStart,
}) {
  const [clientName, setClientName] = useState('');
  const [clientSurname, setClientSurname] = useState('');
  const [clientContact, setClientContact] = useState('');
  const [intakeError, setIntakeError] = useState('');

  function handleStart(event) {
    event.preventDefault();

    const name = clientName.trim();

    if (!name) {
      setIntakeError('Enter the client or student name before starting.');
      return;
    }

    setIntakeError('');
    onStart({
      name,
      surname: clientSurname.trim(),
      contact: clientContact.trim(),
    });
  }

  return (
    <section className="assessment-screen" aria-labelledby="it-direction-heading">
      <div className="assessment-hero">
        <p className="eyebrow">Guidance assessment</p>
        <h2 id="it-direction-heading">{assessment.title}</h2>
        <p>{assessment.subtitle}</p>
        <p className="assessment-guidance-note">{assessment.guidanceNote}</p>
        <form className="assessment-intake-card no-print" onSubmit={handleStart}>
          <div>
            <h3>Client/student details</h3>
            <p>
              Use the name on the guidance result and PDF so the conversation
              notes are easy to identify. Completed placement results may be
              saved for reception follow-up where Supabase is configured.
            </p>
          </div>
          <div className="assessment-intake-grid">
            <label>
              <span>Name</span>
              <input
                required
                type="text"
                value={clientName}
                onChange={(event) => setClientName(event.target.value)}
                placeholder="e.g. Lerato"
              />
            </label>
            <label>
              <span>Surname optional</span>
              <input
                type="text"
                value={clientSurname}
                onChange={(event) => setClientSurname(event.target.value)}
                placeholder="e.g. Mokoena"
              />
            </label>
            <label>
              <span>Phone/email optional</span>
              <input
                type="text"
                value={clientContact}
                onChange={(event) => setClientContact(event.target.value)}
                placeholder="For reception follow-up"
              />
            </label>
          </div>
          {intakeError && (
            <p className="assessment-inline-warning" role="alert">
              {intakeError}
            </p>
          )}
          <div className="button-row wrap">
            <button className="primary-button" type="submit">
              Start Assessment
            </button>
          </div>
        </form>
      </div>

      <section className="assessment-info-grid" aria-label="Assessment overview">
        <article className="assessment-info-card">
          <h3>For reception use</h3>
          <p>
            {assessment.receptionNote} The assessment has no pass/fail result
            and is separate from certification exam history.
          </p>
        </article>
        <article className="assessment-info-card">
          <h3>What it measures</h3>
          <p>
            Interest questions measure what the person is drawn to. Readiness
            questions sample basic IT understanding without certification-style
            pressure.
          </p>
        </article>
        <article className="assessment-info-card">
          <h3>Result output</h3>
          <p>
            The result shows a primary direction, secondary direction, confidence
            level, readiness guidance, suggested starting course areas, and
            discussion points for the next conversation.
          </p>
        </article>
      </section>

      <section className="assessment-pathway-panel" aria-labelledby="pathway-heading">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">Possible directions</p>
            <h3 id="pathway-heading">Study pathways included</h3>
          </div>
          <span>{assessment.pathways.length} pathways</span>
        </div>
        <div className="assessment-pathway-grid">
          {assessment.pathways.map((pathway) => (
            <article className="assessment-pathway-card" key={pathway.id}>
              <h4>{pathway.name}</h4>
              <p>{pathway.description}</p>
            </article>
          ))}
        </div>
      </section>
    </section>
  );
}

export function ITDirectionAssessmentRunner({
  assessment,
  client,
  onBackHome,
  onComplete,
  onRestart,
}) {
  const [answers, setAnswers] = useState({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [submitMessage, setSubmitMessage] = useState('');
  const [submissionAcknowledged, setSubmissionAcknowledged] = useState(false);
  const item = assessment.items[currentIndex];
  const answeredCount = Object.keys(answers).length;
  const currentAnswer = answers[item.id] ?? '';
  const isLastItem = currentIndex === assessment.items.length - 1;
  const progressPercent = Math.round((answeredCount / assessment.items.length) * 100);

  function handleSelect(optionId) {
    setAnswers((currentAnswers) => ({
      ...currentAnswers,
      [item.id]: optionId,
    }));
    setSubmitMessage('');
  }

  function handleNext() {
    if (!currentAnswer) {
      setSubmitMessage('Choose the answer that feels closest before continuing.');
      return;
    }

    setCurrentIndex((index) => Math.min(index + 1, assessment.items.length - 1));
    setSubmitMessage('');
  }

  function handleSubmit() {
    if (answeredCount < assessment.items.length) {
      setSubmitMessage(
        `There are ${assessment.items.length - answeredCount} unanswered items. Answer every item before viewing guidance.`,
      );
      return;
    }

    if (!submissionAcknowledged) {
      setSubmitMessage('Acknowledge the placement data notice before viewing guidance.');
      return;
    }

    onComplete(calculateItDirectionResult(assessment, answers));
  }

  return (
    <section className="assessment-screen" aria-labelledby="assessment-runner-heading">
      <div className="assessment-runner-header">
        <div>
          <p className="eyebrow">IT Direction Assessment</p>
          <h2 id="assessment-runner-heading">
            Item {currentIndex + 1} of {assessment.items.length}
          </h2>
          {client?.displayName && (
            <p className="assessment-runner-client">
              Guidance for {client.displayName}
            </p>
          )}
        </div>
        <div className="button-row wrap no-print">
          <button className="secondary-button" type="button" onClick={onRestart}>
            Restart
          </button>
          <button className="secondary-button" type="button" onClick={onBackHome}>
            Exit to Home
          </button>
        </div>
      </div>

      <div className="assessment-progress-panel" aria-label="Assessment progress">
        <div>
          <span>{answeredCount} answered</span>
          <strong>{progressPercent}% complete</strong>
        </div>
        <div className="assessment-progress-track">
          <span style={{ width: `${progressPercent}%` }} />
        </div>
      </div>

      <div className="assessment-runner-layout">
        <nav className="assessment-item-map" aria-label="Assessment item navigation">
          {assessment.items.map((assessmentItem, index) => (
            <button
              className={[
                'assessment-map-button',
                index === currentIndex ? 'current' : '',
                answers[assessmentItem.id] ? 'answered' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              key={assessmentItem.id}
              type="button"
              onClick={() => setCurrentIndex(index)}
              aria-label={`Go to item ${index + 1}`}
            >
              {index + 1}
            </button>
          ))}
        </nav>

        <article className="assessment-question-card">
          <span className="assessment-dimension-badge">
            {item.dimension === 'knowledge'
              ? 'Knowledge / readiness'
              : 'Interest / preference'}
          </span>
          <h3>{item.prompt}</h3>
          <div className="assessment-option-list">
            {item.options.map((option) => (
              <label
                className={
                  currentAnswer === option.id
                    ? 'assessment-option selected'
                    : 'assessment-option'
                }
                key={option.id}
              >
                <input
                  checked={currentAnswer === option.id}
                  name={item.id}
                  type="radio"
                  value={option.id}
                  onChange={() => handleSelect(option.id)}
                />
                <span>{option.text}</span>
              </label>
            ))}
          </div>

          {submitMessage && <p className="assessment-inline-warning">{submitMessage}</p>}

          <div className="assessment-actions no-print">
            <button
              className="secondary-button"
              disabled={currentIndex === 0}
              type="button"
              onClick={() => setCurrentIndex((index) => Math.max(index - 1, 0))}
            >
              Previous
            </button>
            {isLastItem ? (
              <div className="assessment-submit-controls">
                <div className="assessment-data-notice">
                  <h4>Before submitting this placement assessment</h4>
                  <p>
                    This is the IT Direction placement assessment, not a
                    certification exam. Your intake details, answer summary,
                    pathway scores, recommendation, and guidance result may be
                    saved in the separate placement-results area for permitted
                    reception and scoped support roles when storage is configured.
                    It is not added to certification attempt history. Read the{' '}
                    <a href="/privacy" target="_blank" rel="noreferrer">
                      Privacy page
                    </a>{' '}
                    and{' '}
                    <a href="/terms" target="_blank" rel="noreferrer">
                      Terms page
                    </a>
                    .
                  </p>
                  <label className="assessment-acknowledgement">
                    <input
                      checked={submissionAcknowledged}
                      type="checkbox"
                      onChange={(event) => {
                        setSubmissionAcknowledged(event.target.checked);
                        setSubmitMessage('');
                      }}
                    />
                    <span>I have read and acknowledge this placement data notice.</span>
                  </label>
                </div>
                <button
                  className="primary-button"
                  disabled={!submissionAcknowledged}
                  type="button"
                  onClick={handleSubmit}
                >
                  View Guidance Result
                </button>
              </div>
            ) : (
              <button className="primary-button" type="button" onClick={handleNext}>
                Next
              </button>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}

export function ITDirectionAssessmentResults({
  onBackHome,
  onRetake,
  result,
  saveStatus = { status: 'idle', message: '' },
}) {
  const [exportMessage, setExportMessage] = useState('');
  const [exportError, setExportError] = useState('');
  const [isPdfDownloading, setIsPdfDownloading] = useState(false);
  const timestamp = useMemo(
    () =>
      new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(result.completedAt)),
    [result.completedAt],
  );
  const clientName = result.clientName ?? result.client?.displayName ?? 'Not recorded';
  const clientContact = result.clientContact ?? result.client?.contact ?? '';

  function handlePrint() {
    setExportError('');
    setExportMessage('Print dialog opened. Choose a printer to print the assessment result.');
    window.print();
  }

  async function handleDownloadPdf() {
    setExportError('');
    setExportMessage('');
    setIsPdfDownloading(true);

    try {
      const { filename } = await downloadItDirectionResultPdf(result);
      setExportMessage(`Downloaded ${filename}.`);
    } catch (error) {
      console.error('[CertSim] IT Direction PDF export failed.', error);
      setExportError(
        'PDF download failed. Use Print Results as a fallback.',
      );
    } finally {
      setIsPdfDownloading(false);
    }
  }

  return (
    <section className="assessment-screen assessment-result-screen">
      <div className="assessment-result-hero">
        <p className="eyebrow">Guidance result</p>
        <h2>{clientName}: {result.primary.name}</h2>
        <p>{result.explanation}</p>
        <p>{result.interestReadinessSummary}</p>
        <p className="assessment-guidance-note">{result.guidanceNote}</p>
        <p className="assessment-guidance-note no-print">
          Print Results opens the browser print dialog. Download PDF creates a
          result file directly.
        </p>
        {exportMessage && (
          <p className="assessment-guidance-note success no-print" role="status">
            {exportMessage}
          </p>
        )}
        {exportError && (
          <p className="assessment-guidance-note error no-print" role="alert">
            {exportError}
          </p>
        )}
        {saveStatus.message ? (
          <p
            className={[
              'assessment-guidance-note',
              'no-print',
              saveStatus.status === 'saved' ? 'success' : '',
              saveStatus.status === 'error' ? 'error' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role={saveStatus.status === 'error' ? 'alert' : 'status'}
          >
            {saveStatus.message}
          </p>
        ) : null}
        <div className="button-row wrap no-print">
          <button className="secondary-button" type="button" onClick={handlePrint}>
            Print Results
          </button>
          <button
            className="primary-button"
            disabled={isPdfDownloading}
            type="button"
            onClick={handleDownloadPdf}
          >
            {isPdfDownloading ? 'Preparing PDF...' : 'Download PDF'}
          </button>
          <button className="secondary-button" type="button" onClick={onRetake}>
            Retake Assessment
          </button>
        </div>
      </div>

      <section className="assessment-result-summary" aria-label="Result summary">
        <article>
          <span>Client/student</span>
          <strong>{clientName}</strong>
          {clientContact && <small>{clientContact}</small>}
        </article>
        <article>
          <span>Completed</span>
          <strong>{timestamp}</strong>
        </article>
        <article>
          <span>Confidence</span>
          <strong>{result.confidence.label}</strong>
        </article>
        <article>
          <span>Items answered</span>
          <strong>
            {result.answeredCount} / {result.totalItems}
          </strong>
        </article>
      </section>

      <section className="assessment-result-focus-panel" aria-label="Reception discussion guidance">
        <article className="assessment-info-card">
          <h3>Why this path fits</h3>
          <p>{result.explanation}</p>
          <p>{result.interestReadinessSummary}</p>
        </article>
        <article className="assessment-info-card">
          <h3>Suggested next discussion points</h3>
          <ul className="assessment-discussion-list">
            {(result.discussionNotes ?? []).map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </article>
      </section>

      <section className="assessment-recommendation-grid" aria-label="Recommended pathways">
        {result.recommendations.map((pathway, index) => (
          <article className="assessment-recommendation-card" key={pathway.id}>
            <span className="status-badge">
              {index === 0
                ? 'Primary recommendation'
                : index === 1
                  ? 'Secondary fit'
                  : 'Also worth discussing'}
            </span>
            <h3>{pathway.name}</h3>
            <p>{pathway.description}</p>
            <dl className="assessment-score-pair">
              <div>
                <dt>Interest score</dt>
                <dd>{pathway.interest}</dd>
              </div>
              <div>
                <dt>Knowledge score</dt>
                <dd>{pathway.knowledge}</dd>
              </div>
            </dl>
            <p className="assessment-course-direction">
              Suggested starting direction: {pathway.courseDirection}
            </p>
          </article>
        ))}
      </section>

      <section className="assessment-info-grid" aria-label="Guidance notes">
        <article className="assessment-info-card">
          <h3>Readiness note</h3>
          <p>{result.readinessMessage}</p>
        </article>
        <article className="assessment-info-card">
          <h3>Confidence note</h3>
          <p>{result.confidence.description}</p>
        </article>
        <article className="assessment-info-card">
          <h3>Reception note</h3>
          <p>{result.receptionNote}</p>
          <p>{result.resultDisclaimer}</p>
        </article>
      </section>

      <section className="assessment-score-table" aria-labelledby="score-breakdown-heading">
        <p className="eyebrow">Score breakdown</p>
        <h3 id="score-breakdown-heading">All pathway scores</h3>
        <div className="assessment-score-rows">
          {result.pathwayScores.map((pathway) => (
            <div className="assessment-score-row" key={pathway.id}>
              <strong>{pathway.name}</strong>
              <span>Interest: {pathway.interest}</span>
              <span>Knowledge: {pathway.knowledge}</span>
              <span>Total: {pathway.total}</span>
            </div>
          ))}
        </div>
      </section>
    </section>
  );
}
