export default function ReleasedExecutablePythonReview({ item }) {
  const status = item.status ?? 'Recorded';
  const points = item.earnedPoints != null && item.maxPoints != null
    ? `${item.earnedPoints} / ${item.maxPoints}`
    : 'Not recorded';

  return (
    <article className="selected-profile-panel executable-python-review">
      <p className="eyebrow">Question {item.questionNumber}</p>
      <h4>Python coding task</h4>
      <dl className="exam-stats compact">
        <div><dt>Result</dt><dd>{status}</dd></div>
        <div><dt>Points</dt><dd>{points}</dd></div>
      </dl>
      <p className="answer-helper">
        {status === 'Unanswered'
          ? 'No workspace was saved for this task.'
          : 'Your saved workspace was graded server-side.'}
      </p>
    </article>
  );
}
