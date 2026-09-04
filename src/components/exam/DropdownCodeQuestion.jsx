export default function DropdownCodeQuestion({ question, answer, onAnswerChange }) {
  const selectedAnswers =
    answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};
  const isComplete = question.blanks.every((blank) => Boolean(selectedAnswers[blank.id]));

  return (
    <div className="interactive-question">
      <p className="interaction-hint">Choose the correct value for each blank.</p>
      {!isComplete && (
        <p className="incomplete-warning" aria-live="polite">
          Complete all dropdown selections before moving on.
        </p>
      )}
      <pre className="code-block">
        <code>
          {renderTemplate(question.codeTemplate, question, answer, onAnswerChange)}
        </code>
      </pre>
    </div>
  );
}

function renderTemplate(template, question, answer, onAnswerChange) {
  const selectedAnswers =
    answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};
  const blanksById = Object.fromEntries(
    question.blanks.map((blank) => [blank.id, blank]),
  );

  return template.split(/({{[^}]+}})/g).map((part, index) => {
    const match = part.match(/^{{([^}]+)}}$/);

    if (!match) {
      return part;
    }

    const blank = blanksById[match[1]];

    if (!blank) {
      return part;
    }

    return (
      <select
        className="inline-dropdown"
        key={`${blank.id}-${index}`}
        value={selectedAnswers[blank.id] ?? ''}
        onChange={(event) =>
          onAnswerChange(question.id, {
            ...selectedAnswers,
            [blank.id]: event.target.value,
          })
        }
      >
        <option value="">Select</option>
        {blank.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  });
}
