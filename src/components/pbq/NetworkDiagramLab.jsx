export default function NetworkDiagramLab({ answer = {}, lab, onAnswerChange }) {
  const nodes = lab.assets?.networkNodes ?? [];
  const classificationTargets =
    lab.tasks?.classificationTargets ??
    lab.tasks?.controlPlacementTargets ??
    nodes;
  const classificationOptions =
    lab.tasks?.classificationOptions ??
    lab.tasks?.controlOptions ??
    [];
  const selectedClassifications =
    answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};

  function handleClassificationChange(targetId, value) {
    onAnswerChange?.({
      ...selectedClassifications,
      [targetId]: value,
    });
  }

  return (
    <section className="pbq-simulator-panel" aria-label="Network diagram lab">
      <div className="pbq-simulator-header">
        <h3>Network evidence</h3>
        <p>
          Review the static network and log evidence. Then complete the
          requested classifications or control placements using the controlled
          choices.
        </p>
      </div>

      <EvidencePanel title="Endpoint evidence" rows={lab.assets?.endpointEvents} />
      <EvidencePanel title="Firewall evidence" rows={lab.assets?.firewallEvents} />

      {nodes.length > 0 ? (
        <div className="pbq-node-grid">
          {nodes.map((node) => (
            <div className="pbq-node" key={node.id}>
              <strong>{node.label}</strong>
              <span>{node.ip}</span>
              <span>{node.description}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="pbq-placeholder-note">
          This lab type is scaffolded for future original Security+ content.
        </p>
      )}

      {classificationTargets.length > 0 && classificationOptions.length > 0 && (
        <section
          className="pbq-classification-panel"
          aria-label="Host classification choices"
        >
          <h4>{lab.tasks?.prompt ?? 'Classify each item'}</h4>
          <div className="pbq-classification-grid">
            {classificationTargets.map((target) => (
              <label className="pbq-classification-row" key={target.id}>
                <span>
                  <strong>{target.label}</strong>
                  <small>{target.ip ?? target.detail ?? target.requirement}</small>
                </span>
                <select
                  value={selectedClassifications[target.id] ?? ''}
                  onChange={(event) =>
                    handleClassificationChange(target.id, event.target.value)
                  }
                >
                  <option value="">Select classification</option>
                  {classificationOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}

function EvidencePanel({ rows, title }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  return (
    <section className="pbq-evidence-panel" aria-label={title}>
      <h4>{title}</h4>
      <div className="pbq-log-list">
        {rows.map((row) => (
          <pre key={row.id}>{row.message}</pre>
        ))}
      </div>
    </section>
  );
}
