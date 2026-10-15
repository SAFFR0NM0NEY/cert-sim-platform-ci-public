export default function InteractiveInvestigationLab({
  answer = {},
  lab,
  onAnswerChange,
}) {
  const selectedAnswers =
    answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};
  const evidenceItems = lab.tasks?.evidenceItems ?? [];
  const decisionTargets =
    lab.tasks?.decisionTargets ?? lab.tasks?.configurationTargets ?? [];
  const selectedValue = lab.tasks?.selectionOptions?.[0]?.id ?? 'selected';

  function updateAnswer(targetId, value) {
    onAnswerChange?.({
      ...selectedAnswers,
      [targetId]: value,
    });
  }

  return (
    <section className="pbq-simulator-panel" aria-label="Interactive investigation lab">
      <div className="pbq-simulator-header">
        <h3>{lab.tasks?.prompt ?? lab.title}</h3>
        <p>
          Review the simulated evidence, select relevant indicators, and choose
          the best decisions using the controlled fields.
        </p>
      </div>

      {lab.assets?.environmentSummary && (
        <section className="pbq-evidence-panel" aria-label="Environment summary">
          <h4>Environment summary</h4>
          <p>{lab.assets.environmentSummary}</p>
        </section>
      )}

      {(lab.assets?.notes ?? []).map((note) => (
        <section className="pbq-evidence-panel" aria-label={note.title} key={note.id}>
          <h4>{note.title}</h4>
          <p>{note.body}</p>
        </section>
      ))}

      {(lab.assets?.tables ?? []).map((table) => (
        <section className="pbq-evidence-panel" aria-label={table.title} key={table.id}>
          <h4>{table.title}</h4>
          <div className="pbq-table-wrapper">
            <table className="pbq-table">
              <thead>
                <tr>
                  {table.columns.map((column) => (
                    <th key={column.key}>{column.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr key={row.id}>
                    {table.columns.map((column) => (
                      <td key={column.key}>{row[column.key]}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {evidenceItems.length > 0 && (
        <section className="pbq-classification-panel" aria-label="Evidence selections">
          <h4>Evidence selections</h4>
          <div className="pbq-config-grid">
            {evidenceItems.map((item) => (
              <label className="pbq-config-row" key={item.id}>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
                <input
                  type="checkbox"
                  checked={selectedAnswers[item.id] === selectedValue}
                  onChange={(event) =>
                    updateAnswer(item.id, event.target.checked ? selectedValue : '')
                  }
                />
              </label>
            ))}
          </div>
        </section>
      )}

      {decisionTargets.length > 0 && (
        <section className="pbq-classification-panel" aria-label="Decision selections">
          <h4>{lab.tasks?.decisionTitle ?? 'Decisions'}</h4>
          <div className="pbq-config-grid">
            {decisionTargets.map((target) => {
              const options = target.options ?? lab.tasks?.decisionOptions ?? [];

              return (
                <label className="pbq-config-row" key={target.id}>
                  <span>
                    <strong>{target.label}</strong>
                    <small>{target.requirement ?? target.detail}</small>
                  </span>
                  <select
                    value={selectedAnswers[target.id] ?? ''}
                    onChange={(event) => updateAnswer(target.id, event.target.value)}
                  >
                    <option value="">Select value</option>
                    {options.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
        </section>
      )}
    </section>
  );
}
