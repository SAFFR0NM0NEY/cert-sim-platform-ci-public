export default function EvidenceSelectionLab({ answer = {}, lab, onAnswerChange }) {
  const evidenceItems = lab.tasks?.evidenceItems ?? [];
  const selectedAnswers =
    answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};
  const selectedValue = lab.tasks?.selectionOptions?.[0]?.id ?? 'selected';

  function handleEvidenceToggle(evidenceId, checked) {
    onAnswerChange?.({
      ...selectedAnswers,
      [evidenceId]: checked ? selectedValue : '',
    });
  }

  return (
    <section className="pbq-simulator-panel" aria-label="Evidence selection lab">
      <div className="pbq-simulator-header">
        <h3>{lab.tasks?.prompt ?? 'Select evidence to escalate'}</h3>
        <p>
          Review the static evidence cards and select only the items that should
          be escalated as part of the highest-priority incident.
        </p>
      </div>

      {lab.assets?.environmentSummary && (
        <section className="pbq-evidence-panel" aria-label="Environment summary">
          <h4>Environment summary</h4>
          <p>{lab.assets.environmentSummary}</p>
        </section>
      )}

      <section className="pbq-classification-panel" aria-label="Evidence choices">
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
                  handleEvidenceToggle(item.id, event.target.checked)
                }
              />
            </label>
          ))}
        </div>
      </section>
    </section>
  );
}
