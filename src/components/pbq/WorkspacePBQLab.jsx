import { useMemo, useState } from 'react';

export default function WorkspacePBQLab({ answer = {}, lab, onAnswerChange }) {
  const workspace = lab.tasks?.workspace ?? {};
  const tabs = workspace.tabs ?? [];
  const selectedAnswers =
    answer && typeof answer === 'object' && !Array.isArray(answer) ? answer : {};
  const [activeTabId, setActiveTabId] = useState(tabs[0]?.id ?? '');
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? tabs[0],
    [activeTabId, tabs],
  );

  function handleDecisionChange(decisionId, optionId) {
    onAnswerChange?.({
      ...selectedAnswers,
      [decisionId]: optionId,
    });
  }

  if (!activeTab) {
    return (
      <section className="pbq-workspace-lab" aria-label="Simulated workspace PBQ">
        <p>No workspace tabs are configured for this lab.</p>
      </section>
    );
  }

  return (
    <section className="pbq-workspace-lab" aria-label="Simulated Azure DevOps workspace">
      <div className="pbq-workspace-topbar">
        <div>
          <p className="eyebrow">Simulated Workspace</p>
          <h3>{workspace.workspaceTitle ?? lab.title}</h3>
        </div>
        <span>{workspace.browserOnlyNote ?? 'Practice simulation'}</span>
      </div>

      <div className="pbq-workspace-layout">
        <aside className="pbq-workspace-sidebar" aria-label="Scenario and requirements">
          <h4>Scenario</h4>
          <p>{lab.scenario}</p>

          <WorkspaceList title="Business requirements" items={workspace.businessRequirements} />
          <WorkspaceList title="Technical requirements" items={workspace.technicalRequirements} />
          <WorkspaceList title="Task checklist" items={workspace.taskChecklist} />
        </aside>

        <section className="pbq-workspace-main" aria-label="Workspace tabs">
          <div className="pbq-workspace-tabs" role="tablist" aria-label="Workspace panels">
            {tabs.map((tab) => (
              <button
                aria-selected={tab.id === activeTab.id}
                className={tab.id === activeTab.id ? 'active' : ''}
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                role="tab"
                title={tab.title}
                type="button"
              >
                {tab.title}
              </button>
            ))}
          </div>

          <article className="pbq-workspace-tab-panel" role="tabpanel">
            <div className="pbq-workspace-tab-heading">
              <h4>{activeTab.title}</h4>
              {activeTab.description && <p>{activeTab.description}</p>}
            </div>

            {(activeTab.panels ?? []).map((panel) => (
              <WorkspacePanel key={panel.id ?? panel.title} panel={panel} />
            ))}

            {(activeTab.decisions ?? []).length > 0 && (
              <div className="pbq-workspace-decision-list">
                {activeTab.decisions.map((decision) => (
                  <WorkspaceDecision
                    decision={decision}
                    key={decision.id}
                    selectedValue={selectedAnswers[decision.id] ?? ''}
                    onChange={handleDecisionChange}
                  />
                ))}
              </div>
            )}
          </article>
        </section>
      </div>
    </section>
  );
}

function WorkspaceList({ items = [], title }) {
  if (!items.length) {
    return null;
  }

  return (
    <section>
      <h4>{title}</h4>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function WorkspacePanel({ panel }) {
  return (
    <section className={`pbq-workspace-panel ${panel.kind ?? ''}`.trim()}>
      {panel.title && <h5>{panel.title}</h5>}
      {panel.body && <p>{panel.body}</p>}
      {panel.code && <pre>{panel.code}</pre>}
      {panel.items?.length > 0 && (
        <ul>
          {panel.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
      {panel.table?.length > 0 && (
        <div className="pbq-workspace-table" role="table">
          {panel.table.map((row) => (
            <div key={row.join('|')} role="row">
              {row.map((cell) => (
                <span key={cell} role="cell">
                  {cell}
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function WorkspaceDecision({ decision, selectedValue, onChange }) {
  return (
    <section className="pbq-workspace-decision">
      <div>
        <h5>{decision.prompt}</h5>
        {decision.context && <p>{decision.context}</p>}
      </div>
      <div className="pbq-workspace-option-grid">
        {(decision.options ?? []).map((option) => (
          <button
            className={selectedValue === option.id ? 'selected' : ''}
            key={option.id}
            onClick={() => onChange(decision.id, option.id)}
            type="button"
          >
            <strong>{option.label}</strong>
            {option.detail && <span>{option.detail}</span>}
          </button>
        ))}
      </div>
    </section>
  );
}
