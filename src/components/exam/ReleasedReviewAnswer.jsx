import {
  resolveReleasedChoiceTexts,
  resolveReleasedDropdownPairs,
  resolveReleasedMatchingPairs,
  resolveReleasedPbqAnswer,
  resolveReleasedReorderTexts,
  resolveReleasedStructuredPairs,
  resolveReleasedTrueFalse,
} from '../../lib/releasedAnswerDisplay.js';

const INFORMATIONAL_QUESTION_TYPES = new Set([
  'case-study-context',
  'case-study-info',
  'informational',
]);

const SUPPORTED_RESPONSE_QUESTION_TYPES = new Set([
  'single-choice',
  'multi-select',
  'reorder',
  'drag-drop-match',
  'dropdown-code',
  'dropdown-command',
  'true-false-single-v1',
  'true-false-composite-v1',
  'matching-v1',
  'code-dropdown-completion-v1',
  'pbq-terminal',
  'pbq-multi-host-terminal',
  'pbq-firewall',
  'pbq-siem',
  'pbq-network-diagram',
  'pbq-config-panel',
  'pbq-hotspot',
  'pbq-drag-drop-match',
  'pbq-ordering',
  'pbq-workspace',
]);

export default function ReleasedReviewAnswer({ correct = false, presentation, questionType, value }) {
  const type = String(questionType ?? presentation?.type ?? presentation?.interactionVersion ?? '').toLowerCase();
  if (INFORMATIONAL_QUESTION_TYPES.has(type)) return 'No response recorded';
  if (!SUPPORTED_RESPONSE_QUESTION_TYPES.has(type)) return 'Answer details unavailable';
  const options = { correct, questionType };
  const pbq = resolveReleasedPbqAnswer(presentation, value, options);
  if (pbq.status === 'resolved') return <ReleasedPbqAnswer model={pbq} />;
  if (pbq.status === 'invalid' || pbq.status === 'unavailable') return 'Answer details unavailable';
  if (pbq.status === 'empty') return 'No response recorded';
  if (pbq.status === 'not-applicable' && type.startsWith('pbq-')) return 'No response required';

  const trueFalse = resolveReleasedTrueFalse(presentation, value, options);
  if (trueFalse.status === 'resolved') {
    return <ul className="released-answer-list">{trueFalse.entries.map((entry, index) => <li key={`${index}-${entry.label}-${entry.text}`}>{entry.label ? `${entry.label} — ` : ''}{entry.text}</li>)}</ul>;
  }
  if (trueFalse.status === 'invalid') return 'Answer details unavailable';
  if (trueFalse.status === 'empty') return 'No response recorded';

  const structured = resolveReleasedStructuredPairs(presentation, value, options);
  if (structured.status === 'resolved') {
    return <ul className="released-answer-list released-matching-pairs">{structured.pairs.map((pair, index) => <li key={`${index}-${pair.leftText}-${pair.rightText}`}>{pair.leftText} → {pair.rightText}</li>)}</ul>;
  }
  if (structured.status === 'invalid') return 'Answer details unavailable';
  if (structured.status === 'empty') return 'No response recorded';

  const matching = resolveReleasedMatchingPairs(presentation, value, options);
  if (matching.status === 'resolved') {
    return (
      <ul className="released-answer-list released-matching-pairs">
        {matching.pairs.map((pair, index) => (
          <li key={`${index}-${pair.leftText}-${pair.rightText}`}>
            <span>{pair.leftText}</span><span aria-hidden="true"> → </span><span>{pair.rightText}</span>
          </li>
        ))}
      </ul>
    );
  }
  if (matching.status === 'invalid') return 'Answer details unavailable';
  if (matching.status === 'empty') return 'No response recorded';

  const reorder = resolveReleasedReorderTexts(presentation, value, options);
  if (reorder.status === 'resolved') {
    return <ol className="released-answer-list">{reorder.texts.map((text, index) => <li key={`${index}-${text}`}>{text}</li>)}</ol>;
  }
  if (reorder.status === 'invalid') return 'Answer details unavailable';
  if (reorder.status === 'empty') return 'No response recorded';

  const dropdown = resolveReleasedDropdownPairs(presentation, value, options);
  if (dropdown.status === 'resolved') {
    return <ul className="released-answer-list released-matching-pairs">{dropdown.pairs.map((pair, index) => <li key={`${index}-${pair.leftText}-${pair.rightText}`}>{pair.leftText} → {pair.rightText}</li>)}</ul>;
  }
  if (dropdown.status === 'invalid') return 'Answer details unavailable';
  if (dropdown.status === 'empty') return 'No response recorded';

  const choice = resolveReleasedChoiceTexts(presentation, value, options);
  if (choice.status === 'resolved') {
    return (
      <ul className="released-answer-list">
        {choice.texts.map((text, index) => <li key={`${index}-${text}`}>{text}</li>)}
      </ul>
    );
  }
  if (choice.status === 'invalid') return 'Answer details unavailable';
  if (choice.status === 'empty') return 'No response recorded';
  return formatReviewValue(value);
}

function ReleasedPbqAnswer({ model }) {
  return (
    <div className="released-pbq-answer">
      {model.groups.map((group, groupIndex) => (
        <section className="released-pbq-answer-group" key={`${groupIndex}-${group.kind}-${group.label}`}>
          <span className="released-pbq-answer-label">{group.label}</span>
          {group.kind === 'pairs' ? (
            <ul className="released-answer-list released-matching-pairs">
              {group.entries.map((entry, index) => (
                <li key={`${index}-${entry.label}-${entry.text}`}>
                  <span>{entry.label}</span><span aria-hidden="true"> → </span><span>{entry.text}</span>
                </li>
              ))}
            </ul>
          ) : group.kind === 'ordered' ? (
            <ol className="released-answer-list">
              {group.texts.map((text, index) => <li key={`${index}-${text}`}>{text}</li>)}
            </ol>
          ) : (
            <ul className="released-answer-list">
              {group.texts.map((text, index) => <li key={`${index}-${text}`}>{text}</li>)}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function formatReviewValue(value) {
  if (value === null || value === undefined || value === '') return 'No response recorded';
  if (Array.isArray(value)) return value.map(formatReviewValue).join(', ');
  if (typeof value === 'object') return 'Answer details unavailable';
  return String(value);
}
