export default function TrueFalseQuestion({ question, answer, onAnswerChange }) {
  const statements = question.type === 'true-false-composite-v1'
    ? question.statements
    : [{ id: question.statementId, text: question.prompt ?? question.question }];
  const selected = question.type === 'true-false-composite-v1'
    ? (answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {})
    : { [question.statementId]: answer };

  function update(statementId, value) {
    onAnswerChange(question.id, question.type === 'true-false-composite-v1'
      ? { ...selected, [statementId]: value }
      : value);
  }

  return (
    <fieldset className="structured-response-fieldset">
      <legend className="interaction-hint">
        {statements.length === 1 ? 'Choose True or False.' : 'Choose True or False for every statement. Each statement is scored independently.'}
      </legend>
      {statements.map((statement, index) => (
        <div className="true-false-statement" key={statement.id}>
          {statements.length > 1 && <p><strong>Statement {index + 1}.</strong> {statement.text}</p>}
          <div className="true-false-options" role="radiogroup" aria-label={`Statement ${index + 1}`}>
            {[true, false].map((value) => (
              <label key={String(value)}>
                <input type="radio" name={`${question.id}-${statement.id}`} checked={selected[statement.id] === value} onChange={() => update(statement.id, value)} />
                <span>{value ? 'True' : 'False'}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </fieldset>
  );
}
