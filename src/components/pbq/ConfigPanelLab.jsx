export default function ConfigPanelLab({ answer = {}, lab, onAnswerChange }) {
  const targets = lab.tasks?.configurationTargets ?? [];
  const options = lab.tasks?.permissionOptions ?? [];
  const selectedPermissions =
    answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};

  function handlePermissionChange(targetId, permissionId) {
    onAnswerChange?.({
      ...selectedPermissions,
      [targetId]: permissionId,
    });
  }

  return (
    <section className="pbq-simulator-panel" aria-label="Access configuration lab">
      <div className="pbq-simulator-header">
        <h3>{lab.tasks?.prompt ?? 'Configure least-privilege access'}</h3>
        <p>
          Select the safest configuration value for each described setting or
          access requirement.
        </p>
      </div>

      {lab.assets?.systemSummary && (
        <section className="pbq-evidence-panel" aria-label="System context">
          <h4>System context</h4>
          <p>{lab.assets.systemSummary}</p>
        </section>
      )}

      <section
        className="pbq-classification-panel"
        aria-label="Permission assignment choices"
      >
        <h4>{lab.tasks?.panelTitle ?? 'Configuration choices'}</h4>
        <div className="pbq-config-grid">
          {targets.map((target) => {
            const targetOptions = target.options ?? options;

            return (
              <label className="pbq-config-row" key={target.id}>
                <span>
                  <strong>{target.label}</strong>
                  <small>{target.requirement}</small>
                </span>
                <select
                  value={selectedPermissions[target.id] ?? ''}
                  onChange={(event) =>
                    handlePermissionChange(target.id, event.target.value)
                  }
                >
                  <option value="">Select value</option>
                  {targetOptions.map((option) => (
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
    </section>
  );
}
