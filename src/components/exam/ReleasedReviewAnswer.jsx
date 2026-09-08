import {
  resolveReleasedChoiceTexts,
  resolveReleasedMatchingPairs,
  resolveReleasedStructuredPairs,
  resolveReleasedTrueFalse,
} from '../../lib/releasedAnswerDisplay.js';

export default function ReleasedReviewAnswer({ correct = false, presentation, value }) {
  const trueFalse = resolveReleasedTrueFalse(presentation, value, { correct });
  if (trueFalse.status === 'resolved') {
    return <ul className="released-answer-list">{trueFalse.entries.map((entry, index) => <li key={`${index}-${entry.label}-${entry.text}`}>{entry.label ? `${entry.label} — ` : ''}{entry.text}</li>)}</ul>;
  }
  if (trueFalse.status === 'invalid') return 'Answer details unavailable';
  if (trueFalse.status === 'empty') return 'No response recorded';

  const structured = resolveReleasedStructuredPairs(presentation, value, { correct });
  if (structured.status === 'resolved') {
    return <ul className="released-answer-list released-matching-pairs">{structured.pairs.map((pair, index) => <li key={`${index}-${pair.leftText}-${pair.rightText}`}>{pair.leftText} → {pair.rightText}</li>)}</ul>;
  }
  if (structured.status === 'invalid') return 'Answer details unavailable';
  if (structured.status === 'empty') return 'No response recorded';

  const matching = resolveReleasedMatchingPairs(presentation, value, { correct });
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

  const choice = resolveReleasedChoiceTexts(presentation, value, { correct });
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

function formatReviewValue(value) {
  if (value === null || value === undefined || value === '') return 'No response recorded';
  if (Array.isArray(value)) return value.map(formatReviewValue).join(', ');
  if (typeof value === 'object') return 'Answer details unavailable';
  return String(value);
}
