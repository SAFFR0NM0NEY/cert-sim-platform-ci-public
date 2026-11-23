import { normalizeKeyedStructuredAnswer, updateKeyedStructuredAnswer } from '../../lib/structuredResponse.js';
import SuppliedText from './SuppliedText.jsx';

export default function AccessibleMatchingQuestion({ question, answer, onAnswerChange }) {
  const selected = normalizeKeyedStructuredAnswer(answer);
  const multiline = question.targets.some(target => /[\r\n\t]/.test(target.text));
  const unavailable = (source, target) => question.allowTargetReuse === false
    && selected[source.id] !== target.id
    && Object.entries(selected).some(([sourceId, targetId]) => sourceId !== source.id && targetId === target.id);
  if (multiline) {
    return (
      <fieldset className="structured-response-fieldset">
        <legend className="interaction-hint">Match every source to a target. Use the labelled choices with a keyboard or screen reader.</legend>
        <div className="matching-multiline-grid">
          {question.sources.map(source => (
            <fieldset className="matching-multiline-choices" role="radiogroup" key={source.id}>
              <legend>Match for {source.text}</legend>
              {question.targets.map(target => (
                <label className="option-row" key={target.id}>
                  <input type="radio" name={`${question.id}-${source.id}`} value={target.id}
                    checked={selected[source.id] === target.id} disabled={unavailable(source, target)}
                    onChange={() => onAnswerChange(question.id, updateKeyedStructuredAnswer(selected, source.id, target.id))} />
                  <span><SuppliedText>{target.text}</SuppliedText></span>
                </label>
              ))}
              <button type="button" className="secondary-button" disabled={!selected[source.id]}
                aria-label={`Clear match for ${source.text}`}
                onClick={() => onAnswerChange(question.id, updateKeyedStructuredAnswer(selected, source.id, ''))}>
                Clear match
              </button>
            </fieldset>
          ))}
        </div>
      </fieldset>
    );
  }
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
