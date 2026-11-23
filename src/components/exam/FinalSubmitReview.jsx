import {
  formatSeconds,
  getQuestionAnswerState,
} from '../../utils/examHelpers.js';
import { isPBQQuestion } from '../../utils/pbqScoring.js';
import { isScoredQuestion } from '../../utils/scoring.js';

export default function FinalSubmitReview({
  answers,
  caseStudyBlocks = [],
  exam,
  flaggedQuestionIds,
  normalQuestions = [],
  onNavigateToItem,
  onReturnToExam,
  onSubmitFinal,
  questions,
  remainingSeconds,
  section,
  student,
}) {
  const flaggedSet = new Set(flaggedQuestionIds);
  const firstCaseStudyIndex = normalQuestions.length;
  const isSectionedExam = Boolean(exam.hasSectionedFlow);
  const scoredItems = questions
    .map((question, questionIndex) => ({
      question,
      questionIndex,
      answerState: getQuestionAnswerState(question, {
        [question.id]: answers[question.id],
      }),
    }))
    .filter((item) => isScoredQuestion(item.question));
  const answeredCount = scoredItems.filter(
    (item) => item.answerState === 'answered',
  ).length;
  const unansweredCount = scoredItems.filter(
    (item) => item.answerState === 'unanswered',
  ).length;
  const incompleteItems = scoredItems.filter(
    (item) => item.answerState === 'incomplete',
  );
  const flaggedCount = scoredItems.filter((item) =>
    flaggedSet.has(item.question.id),
  ).length;
  const incompletePbqCount = scoredItems.filter(
    (item) => isPBQQuestion(item.question) && item.answerState !== 'answered',
  ).length;
  const hasCaseStudyLock =
    !isSectionedExam && section === 'case-study' && caseStudyBlocks.length > 0;

  function itemIsLocked(item) {
    return hasCaseStudyLock && item.questionIndex < firstCaseStudyIndex;
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="modal final-submit-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="final-submit-heading"
      >
        <div className="final-submit-header">
          <div>
            <p className="eyebrow">Final review</p>
            <h2 id="final-submit-heading">Review before submitting</h2>
            <p>
              Submitting will end this attempt. You will not be able to change
              answers afterward.
            </p>
          </div>
          <button className="text-button" type="button" onClick={onReturnToExam}>
            Return to Exam
          </button>
        </div>

        <dl className="final-submit-meta">
          <FinalReviewFact label="Exam" value={exam.name} />
          <FinalReviewFact label="Student" value={student?.name || 'Not provided'} />
          <FinalReviewFact label="Email" value={student?.email || 'Not provided'} />
          <FinalReviewFact label="Time remaining" value={formatSeconds(remainingSeconds)} />
        </dl>

        <dl className="final-submit-summary-grid">
          <FinalReviewFact label="Total scored items" value={scoredItems.length} />
          <FinalReviewFact label="Answered" value={answeredCount} />
          <FinalReviewFact label="Unanswered" value={unansweredCount} />
          <FinalReviewFact label="Flagged" value={flaggedCount} />
          <FinalReviewFact label="Incomplete" value={incompleteItems.length} />
          {scoredItems.some((item) => isPBQQuestion(item.question)) && (
            <FinalReviewFact label="Incomplete PBQs" value={incompletePbqCount} />
          )}
        </dl>

        {(unansweredCount > 0 || incompleteItems.length > 0 || flaggedCount > 0) && (
          <section className="final-submit-warning" aria-label="Open item warning">
            <h3>Items need attention</h3>
            <p>
              You can return to any available item below before final
              submission.
            </p>
            {incompletePbqCount > 0 && (
              <p>
                Some PBQ tasks are incomplete. You can return to complete them
                or submit anyway.
              </p>
            )}
            {hasCaseStudyLock && (
              <p>
                Normal questions are locked because you are already in the case
                study section.
              </p>
            )}
          </section>
        )}

        <section className="final-submit-items" aria-labelledby="final-submit-items-heading">
          <h3 id="final-submit-items-heading">Item summary</h3>
          <div className="final-submit-item-grid">
            {scoredItems.map((item, scoredIndex) => {
              const isFlagged = flaggedSet.has(item.question.id);
              const locked = itemIsLocked(item);
              const status = getDisplayStatus(item.answerState, isFlagged);

              return (
                <button
                  className={[
                    'final-submit-item',
                    item.answerState,
                    isFlagged ? 'flagged' : '',
                    locked ? 'locked' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  disabled={locked}
                  key={item.question.id}
                  type="button"
                  onClick={() => onNavigateToItem(item.questionIndex)}
                >
                  <span className="final-submit-item-number">
                    Item {scoredIndex + 1}
                  </span>
                  <strong>{status}</strong>
                  <span>{getItemKind(item.question)}</span>
                  {locked && <small>Locked</small>}
                </button>
              );
            })}
          </div>
        </section>

        <div className="modal-actions final-submit-actions">
          <button className="secondary-button" type="button" onClick={onReturnToExam}>
            Return to Exam
          </button>
          <button className="primary-button" type="button" onClick={onSubmitFinal}>
            Submit Final Attempt
          </button>
        </div>
      </section>
    </div>
  );
}

function FinalReviewFact({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function getDisplayStatus(answerState, isFlagged) {
  if (isFlagged) {
    return 'Flagged';
  }

  if (answerState === 'answered') {
    return 'Answered';
  }

  if (answerState === 'incomplete') {
    return 'Incomplete';
  }

  return 'Unanswered';
}

function getItemKind(question) {
  if (isPBQQuestion(question)) {
    return 'PBQ';
  }

  if (question.type === 'single-choice' || question.type === 'multi-select') {
    return 'MCQ';
  }

  return 'Interactive';
}
