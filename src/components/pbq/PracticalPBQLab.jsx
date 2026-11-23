export default function PracticalPBQLab({ answer = {}, lab, onAnswerChange }) {
  const sections = lab.tasks?.sections ?? [];
  const selectedAnswers =
    answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};

  function handleSelectionChange(targetId, optionId) {
    onAnswerChange?.({
      ...selectedAnswers,
      [targetId]: optionId,
    });
  }

  return (
    <section className="pbq-simulator-panel" aria-label="Practical PBQ lab">
      <div className="pbq-simulator-header">
        <h3>{lab.tasks?.prompt ?? 'Complete the practical lab tasks'}</h3>
        {lab.tasks?.summary && <p>{lab.tasks.summary}</p>}
      </div>

      {lab.assets?.systemSummary && (
        <section className="pbq-evidence-panel" aria-label="Lab context">
          <h4>Lab context</h4>
          <p>{lab.assets.systemSummary}</p>
        </section>
      )}

      <div className="pbq-practical-section-list">
        {sections.map((section, index) => (
          <section className="pbq-practical-section" key={section.id}>
            <div className="pbq-practical-section-header">
              <span>{index + 1}</span>
              <div>
                <h4>{section.title}</h4>
                {section.description && <p>{section.description}</p>}
              </div>
            </div>

            {section.template && (
              <pre className="pbq-yaml-fragment">{section.template}</pre>
            )}

            <div className="pbq-config-grid">
              {(section.targets ?? []).map((target) => (
                <label className="pbq-config-row" key={target.id}>
                  <span>
                    <strong>{target.label}</strong>
                    <small>
                      {target.requirement ?? target.detail ?? target.helperText}
                    </small>
                  </span>
                  <select
                    value={selectedAnswers[target.id] ?? ''}
                    onChange={(event) =>
                      handleSelectionChange(target.id, event.target.value)
                    }
                  >
                    <option value="">{target.placeholder ?? 'Select value'}</option>
                    {(target.options ?? []).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
