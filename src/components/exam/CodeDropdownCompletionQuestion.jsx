export default function CodeDropdownCompletionQuestion({ question, answer, onAnswerChange }) {
  const selected = answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};
  const blanks = Object.fromEntries(question.blanks.map((blank) => [blank.id, blank]));
  const parts = question.codeTemplate.split(/(\[\[[^\]]+\]\])/g);
  return (
    <div className="interactive-question">
      <p className="interaction-hint">Complete each code blank. Each blank is scored independently.</p>
      <pre className="code-block code-dropdown-completion"><code>{parts.map((part, index) => {
        const match = /^\[\[([^\]]+)\]\]$/.exec(part); const blank = match ? blanks[match[1]] : null;
        if (!blank) return part;
        return <select className="inline-dropdown" key={`${blank.id}-${index}`} aria-label={blank.label || `Code blank ${blank.id}`} value={selected[blank.id] ?? ''} onChange={(event) => onAnswerChange(question.id, { ...selected, [blank.id]: event.target.value })}>
          <option value="">Select</option>{blank.options.map((option) => <option key={option.id} value={option.id}>{option.text}</option>)}
        </select>;
      })}</code></pre>
      {Object.keys(selected).length > 0 && <button className="secondary-button" type="button" onClick={() => { if (window.confirm('Clear the selections for this question?')) onAnswerChange(question.id, {}); }}>Reset this question</button>}
    </div>
  );
}
