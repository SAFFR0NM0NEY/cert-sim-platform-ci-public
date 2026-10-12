import { normalizeKeyedStructuredAnswer, updateKeyedStructuredAnswer } from '../../lib/structuredResponse.js';

export default function AccessibleMatchingQuestion({ question, answer, onAnswerChange }) {
  const selected = normalizeKeyedStructuredAnswer(answer);
  return (
    <fieldset className="structured-response-fieldset">
      <legend className="interaction-hint">Match every source to a target. Use the labelled selectors with a keyboard or screen reader.</legend>
      <div className="accessible-matching-grid">
        {question.sources.map((source, index) => (
          <label key={source.id}>
            <span><strong>{index + 1}.</strong> {source.text}</span>
            <select aria-label={`Match for ${source.text}`} value={selected[source.id] ?? ''} onChange={(event) => onAnswerChange(question.id, updateKeyedStructuredAnswer(selected, source.id, event.target.value))}>
              <option value="">Select a match</option>
              {question.targets.map((target) => {
                const selectedByAnotherSource = question.allowTargetReuse === false
                  && selected[source.id] !== target.id
                  && Object.entries(selected).some(([sourceId, targetId]) => sourceId !== source.id && targetId === target.id);
                return <option disabled={selectedByAnotherSource} key={target.id} value={target.id}>{target.text}</option>;
              })}
            </select>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
