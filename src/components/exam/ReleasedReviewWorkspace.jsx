import { useEffect, useRef, useState } from 'react';
import ReleasedExecutablePythonReview from './ReleasedExecutablePythonReview.jsx';
import ReleasedReviewAnswer from './ReleasedReviewAnswer.jsx';

const INFORMATIONAL_QUESTION_TYPES = new Set([
  'case-study-context',
  'case-study-info',
  'informational',
]);

const KNOWN_STATUS_CLASSES = new Set([
  'correct',
  'incorrect',
  'partial',
  'incomplete',
  'unanswered',
  'revealed',
  'revealed-before-answer',
  'answered-not-checked',
]);

export default function ReleasedReviewWorkspace({ review, onReturn }) {
  const items = Array.isArray(review?.items) ? review.items : [];
  const [currentIndex, setCurrentIndex] = useState(0);
  const paletteButtons = useRef([]);

  useEffect(() => setCurrentIndex(0), [review]);

  if (!items.length) {
    return (
      <section className="exam-workspace released-review-workspace" aria-labelledby="released-review-heading">
        <ReleasedReviewHeader current={0} onReturn={onReturn} total={0} />
        <div className="released-review-empty" role="status">No released review items are available.</div>
      </section>
    );
  }

  const boundedIndex = Math.min(currentIndex, items.length - 1);
  const item = items[boundedIndex];
  const position = boundedIndex + 1;

  function navigate(index) {
    setCurrentIndex(Math.max(0, Math.min(index, items.length - 1)));
  }

  function handlePaletteKeyDown(event, index) {
    let nextIndex = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = Math.min(index + 1, items.length - 1);
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = Math.max(index - 1, 0);
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = items.length - 1;
    if (nextIndex == null) return;
    event.preventDefault();
    navigate(nextIndex);
    paletteButtons.current[nextIndex]?.focus();
  }

  return (
    <section className="exam-workspace released-review-workspace" aria-labelledby="released-review-heading">
      <ReleasedReviewHeader current={position} onReturn={onReturn} total={items.length} />
      <div className="released-review-layout">
        <nav className="released-review-navigator" aria-label="Released review questions">
          <h3>Questions</h3>
          <p className="released-review-palette-help">Choose a question or use the arrow keys.</p>
          <div className="released-review-palette" data-testid="released-review-palette">
            {items.map((entry, index) => {
              const entryPosition = index + 1;
              const informational = isInformationalItem(entry);
              const statusLabel = informational ? 'Context' : formatReleasedStatus(entry.status);
              const statusClass = informational ? 'info' : getReleasedStatusClass(entry.status);
              return (
                <button
                  aria-current={index === boundedIndex ? 'step' : undefined}
                  aria-label={`Question ${entryPosition}, ${statusLabel}`}
                  className={`released-review-palette-button ${statusClass}${index === boundedIndex ? ' current' : ''}`}
                  key={entry.itemId ?? entry.questionId ?? entryPosition}
                  onClick={() => navigate(index)}
                  onKeyDown={(event) => handlePaletteKeyDown(event, index)}
                  ref={(element) => { paletteButtons.current[index] = element; }}
                  type="button"
                >
                  {entryPosition}
                </button>
              );
            })}
          </div>
        </nav>

        <div className="released-review-content" data-testid="released-review-item">
          {item.questionType === 'executable-python-lab-v1' ? (
            <ReleasedExecutablePythonReview item={item} />
          ) : isInformationalItem(item) ? (
            <ReleasedInformationalReview item={item} position={position} />
          ) : (
            <ReleasedQuestionReview item={item} position={position} />
          )}
          <div className="released-review-actions">
            <button className="secondary-button" disabled={boundedIndex === 0} onClick={() => navigate(boundedIndex - 1)} type="button">Previous</button>
            <span aria-live="polite">Question {position} of {items.length}</span>
            <button className="primary-button" disabled={boundedIndex === items.length - 1} onClick={() => navigate(boundedIndex + 1)} type="button">Next</button>
          </div>
        </div>
      </div>
    </section>
  );
}

function ReleasedReviewHeader({ current, onReturn, total }) {
  return (
    <header className="released-review-header">
      <div>
        <p className="eyebrow">Read-only review</p>
        <h2 id="released-review-heading">Released question review</h2>
        <p className="released-review-position" aria-live="polite">{total ? `Question ${current} of ${total}` : 'No review items released'}</p>
      </div>
      <button className="secondary-button" onClick={onReturn} type="button">Return to result summary</button>
    </header>
  );
}

function ReleasedQuestionReview({ item, position }) {
  const questionNumber = item.questionNumber ?? position;
  const status = formatReleasedStatus(item.status);
  const prompt = getReleasedPrompt(item.presentation);
  const pointsReleased = item.earnedPoints != null && item.maxPoints != null;
  const correctAnswerReleased = Object.prototype.hasOwnProperty.call(item, 'correctAnswer') && item.correctAnswer != null;
  return (
    <article className="released-review-card">
      <div className="released-review-title-row">
        <div>
          <p className="eyebrow">Question {questionNumber}</p>
          <h3>{prompt}</h3>
        </div>
        <span className={`review-status ${getReleasedStatusClass(item.status)}`}>{status}</span>
      </div>
      <dl className="released-review-facts">
        <div><dt>Result</dt><dd>{status}</dd></div>
        {pointsReleased ? <div><dt>Points</dt><dd>{item.earnedPoints} / {item.maxPoints}</dd></div> : null}
      </dl>
      <div className="released-review-answer-grid">
        <section>
          <h4>Your response</h4>
          <ReleasedReviewAnswer presentation={item.presentation} questionType={item.questionType} value={item.response} />
        </section>
        {correctAnswerReleased ? (
          <section>
            <h4>Correct / expected answer</h4>
            <ReleasedReviewAnswer correct presentation={item.presentation} questionType={item.questionType} value={item.correctAnswer} />
          </section>
        ) : null}
      </div>
      {item.explanation ? <section className="released-review-guidance"><h4>Explanation</h4><p>{item.explanation}</p></section> : null}
      {item.remediation ? <section className="released-review-guidance"><h4>Next step</h4><p>{item.remediation}</p></section> : null}
    </article>
  );
}

function ReleasedInformationalReview({ item, position }) {
  const prompt = getReleasedPrompt(item.presentation, 'Released context');
  const details = getReleasedContextDetails(item.presentation, prompt);
  return (
    <article className="released-review-card released-review-context-card">
      <p className="eyebrow">Context {position}</p>
      <h3>{prompt}</h3>
      {details.map((detail, index) => <p key={`${index}-${detail}`}>{detail}</p>)}
      <p className="released-review-context-note">This is contextual material and is not a scored response.</p>
    </article>
  );
}

function isInformationalItem(item) {
  return INFORMATIONAL_QUESTION_TYPES.has(String(item?.questionType ?? '').toLowerCase());
}

function getReleasedPrompt(presentation, fallback = 'Question review') {
  for (const key of ['stem', 'prompt', 'question', 'title', 'heading']) {
    const value = presentation?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return fallback;
}

function getReleasedContextDetails(presentation, prompt) {
  const details = [];
  for (const key of ['description', 'scenario', 'content', 'body', 'text']) {
    const value = presentation?.[key];
    if (typeof value === 'string' && value.trim() && value.trim() !== prompt && !details.includes(value.trim())) details.push(value.trim());
  }
  return details;
}

function formatReleasedStatus(status) {
  const value = String(status ?? '').trim();
  if (!value) return 'Recorded';
  return value.split(/[-_\s]+/).filter(Boolean).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`).join(' ');
}

function getReleasedStatusClass(status) {
  const value = String(status ?? '').trim().toLowerCase().replace(/[_\s]+/g, '-');
  return KNOWN_STATUS_CLASSES.has(value) ? value : 'recorded';
}
