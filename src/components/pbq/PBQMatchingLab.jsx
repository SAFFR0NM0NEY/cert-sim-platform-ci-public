export default function PBQMatchingLab({ answer = {}, lab, onAnswerChange }) {
  const targets = lab.tasks?.matchTargets ?? [];
  const options = lab.tasks?.mitigationOptions ?? [];
  const selectedMatches =
    answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};

  function handleMatchChange(targetId, optionId) {
    onAnswerChange?.({
      ...selectedMatches,
      [targetId]: optionId,
    });
  }

  return (
    <section className="pbq-simulator-panel" aria-label="Attack mitigation matching lab">
      <div className="pbq-simulator-header">
        <h3>{lab.tasks?.prompt ?? 'Match each finding to the best mitigation'}</h3>
        <p>
          Choose the most appropriate mitigation for each security finding.
          Each mitigation should be selected based on the described evidence.
        </p>
      </div>

      {lab.assets?.environmentSummary && (
        <section className="pbq-evidence-panel" aria-label="Environment summary">
          <h4>Environment summary</h4>
          <p>{lab.assets.environmentSummary}</p>
        </section>
      )}

      <section className="pbq-classification-panel" aria-label="Mitigation matches">
        <div className="pbq-config-grid">
          {targets.map((target) => (
            <label className="pbq-config-row" key={target.id}>
              <span>
                <strong>{target.label}</strong>
                <small>{target.detail}</small>
              </span>
              <select
                value={selectedMatches[target.id] ?? ''}
                onChange={(event) =>
                  handleMatchChange(target.id, event.target.value)
                }
              >
                <option value="">Select mitigation</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </section>
    </section>
  );
}
