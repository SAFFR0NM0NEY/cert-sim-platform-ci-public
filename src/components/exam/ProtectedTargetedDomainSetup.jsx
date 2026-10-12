import { useState } from 'react';

export default function ProtectedTargetedDomainSetup({ exam, domains = [], objectiveGroups = [], onBack, onContinue }) {
  const [scope, setScope] = useState('');
  const choices = objectiveGroups.length
    ? objectiveGroups.flatMap((group) => [
      { value: `domain:${group.domain}`, label: `Complete domain: ${group.domain}`, domain: group.domain },
      ...group.objectives.map((objective) => ({ value: `objective:${group.domain}:${objective}`, label: objective, domain: group.domain, objective })),
    ])
    : domains.map((domain) => ({ value: `domain:${domain}`, label: domain, domain }));
  const selected = choices.find((choice) => choice.value === scope);

  return (
    <section className="details-screen" aria-labelledby="targeted-domain-heading">
      <button className="text-button" type="button" onClick={onBack}>Back to dashboard</button>
      <div className="form-panel targeted-setup-card">
        <p className="eyebrow">{exam.name}</p>
        <h2 id="targeted-domain-heading">Targeted Practice</h2>
        <p>Choose a complete domain or an individual objective group. No session is created until the server confirms the scope and available question count.</p>
        <div className="targeted-control-field">
          <label htmlFor="protected-target-domain">Practice scope</label>
          <select id="protected-target-domain" value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="">Choose a domain or objective group</option>
            {objectiveGroups.length ? objectiveGroups.map((group) => (
              <optgroup key={group.domain} label={group.domain}>
                <option value={`domain:${group.domain}`}>Complete domain</option>
                {group.objectives.map((objective) => <option key={objective} value={`objective:${group.domain}:${objective}`}>{objective}</option>)}
              </optgroup>
            )) : domains.map((entry) => <option key={entry} value={`domain:${entry}`}>{entry}</option>)}
          </select>
        </div>
        <button className="primary-button" type="button" disabled={!selected} onClick={() => onContinue(selected)}>
          Review practice availability
        </button>
      </div>
    </section>
  );
}
