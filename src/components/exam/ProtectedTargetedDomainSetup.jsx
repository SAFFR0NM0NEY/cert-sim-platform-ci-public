import { useState } from 'react';

export default function ProtectedTargetedDomainSetup({ exam, domains = [], onBack, onContinue }) {
  const [domain, setDomain] = useState('');

  return (
    <section className="details-screen" aria-labelledby="targeted-domain-heading">
      <button className="text-button" type="button" onClick={onBack}>Back to dashboard</button>
      <div className="form-panel targeted-setup-card">
        <p className="eyebrow">{exam.name}</p>
        <h2 id="targeted-domain-heading">Targeted Domain Practice</h2>
        <p>Choose the domain you want to practise. No session is created until you review the server-confirmed availability and select Start practice.</p>
        <div className="targeted-control-field">
          <label htmlFor="protected-target-domain">Domain</label>
          <select id="protected-target-domain" value={domain} onChange={(event) => setDomain(event.target.value)}>
            <option value="">Choose a domain</option>
            {domains.map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </select>
        </div>
        <button className="primary-button" type="button" disabled={!domain} onClick={() => onContinue(domain)}>
          Review practice availability
        </button>
      </div>
    </section>
  );
}
