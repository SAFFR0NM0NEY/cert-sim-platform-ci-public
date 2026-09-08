export default function AccessibleMatchingQuestion({ question, answer, onAnswerChange }) {
  const selected = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};
  return (
    <fieldset className="structured-response-fieldset">
      <legend className="interaction-hint">Match every source to a target. Use the labelled selectors with a keyboard or screen reader.</legend>
      <div className="accessible-matching-grid">
        {question.sources.map((source, index) => (
          <label key={source.id}>
            <span><strong>{index + 1}.</strong> {source.text}</span>
            <select aria-label={`Match for ${source.text}`} value={selected[source.id] ?? ''} onChange={(event) => onAnswerChange(question.id, { ...selected, [source.id]: event.target.value })}>
              <option value="">Select a match</option>
              {question.targets.map((target) => <option key={target.id} value={target.id}>{target.text}</option>)}
            </select>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
