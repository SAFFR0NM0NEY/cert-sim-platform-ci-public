export default function FirewallRuleSimulator({ answer = {}, lab, onAnswerChange }) {
  const rules = lab.assets?.firewallRules ?? [];
  const ruleFields = lab.tasks?.ruleFields ?? [];
  const selectedFields =
    answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};

  function handleFieldChange(fieldId, value) {
    onAnswerChange?.({
      ...selectedFields,
      [fieldId]: value,
    });
  }

  return (
    <section
      className="pbq-simulator-panel"
      aria-label="Simulated firewall rule builder"
    >
      <div className="pbq-simulator-header">
        <h3>Simulated firewall rule builder</h3>
        <p>
          Review the existing simulated rules, then build the rule that should
          be inserted into the ACL.
        </p>
      </div>

      <h4>Existing simulated rules</h4>
      <div className="pbq-table-wrapper">
        <table className="pbq-table">
          <thead>
            <tr>
              <th>Priority</th>
              <th>Action</th>
              <th>Direction</th>
              <th>Protocol</th>
              <th>Source</th>
              <th>Destination</th>
              <th>Service/Port</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {rules.map((rule) => (
              <tr key={rule.id}>
                <td>{rule.priority}</td>
                <td>{rule.action}</td>
                <td>{rule.direction ?? 'Any'}</td>
                <td>{rule.protocol ?? 'Any'}</td>
                <td>{rule.source}</td>
                <td>{rule.destination}</td>
                <td>{rule.servicePort ?? rule.port}</td>
                <td>{rule.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {ruleFields.length > 0 && (
        <section className="pbq-firewall-builder" aria-label="Build the rule">
          <h4>Build the rule</h4>
          <div className="pbq-config-grid">
            {ruleFields.map((field) => (
              <label className="pbq-config-row" key={field.id}>
                <span>
                  <strong>{field.label}</strong>
                  {field.helperText && <small>{field.helperText}</small>}
                </span>
                <select
                  value={selectedFields[field.id] ?? ''}
                  onChange={(event) =>
                    handleFieldChange(field.id, event.target.value)
                  }
                >
                  <option value="">Select {field.label.toLowerCase()}</option>
                  {field.options.map((option) => (
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
