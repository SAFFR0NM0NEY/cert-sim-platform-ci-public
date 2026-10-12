import { useMemo, useState } from 'react';
import {
  createPBQCommandOutputMap,
  getPBQTerminalResponse,
  normalizePBQCommand,
} from '../../utils/pbqTerminal.js';

export default function MultiHostTerminalLab({
  answer = {},
  lab,
  onAnswerChange,
}) {
  const hosts = lab.assets?.hosts ?? [];
  const answerState = normalizeAnswerState(answer);
  const [activeHostId, setActiveHostId] = useState(hosts[0]?.id ?? '');
  const activeHost =
    hosts.find((host) => host.id === activeHostId) ?? hosts[0] ?? null;
  const commandEvidenceTargets = lab.tasks?.commandEvidenceTargets ?? [];
  const decisionTargets = lab.tasks?.decisionTargets ?? [];

  const activeHostTranscript = useMemo(
    () =>
      getHostTranscript(
        lab,
        activeHost,
        answerState.perHostTerminalTranscript?.[activeHost?.id],
      ),
    [activeHost, answerState.perHostTerminalTranscript, lab],
  );

  if (!activeHost) {
    return (
      <section className="pbq-simulator-panel" aria-label="Multi-host terminal lab">
        <div className="pbq-simulator-header">
          <h3>{lab.tasks?.prompt ?? lab.title}</h3>
          <p>No simulated hosts are configured for this lab.</p>
        </div>
      </section>
    );
  }

  function updateAnswerState(nextState) {
    onAnswerChange?.(nextState);
  }

  function updateDecision(targetId, value) {
    updateAnswerState({
      ...answerState,
      [targetId]: value,
    });
  }

  function runCommand(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const rawCommand = String(formData.get('command') ?? '').trim();

    if (!rawCommand) {
      return;
    }

    event.currentTarget.reset();

    const normalizedCommand = normalizePBQCommand(rawCommand);
    const commandOutputs = createPBQCommandOutputMap(
      activeHost.commandOutputs ?? {},
    );
    const supportedCommands = getSupportedCommands(activeHost);
    const response = getPBQTerminalResponse(
      normalizedCommand,
      commandOutputs,
      supportedCommands,
    );
    const nextHistory = [
      ...(answerState.perHostCommandHistory?.[activeHost.id] ?? []),
      rawCommand,
    ];
    const nextTranscripts = {
      ...answerState.perHostTerminalTranscript,
    };
    const nextHistoryByHost = {
      ...answerState.perHostCommandHistory,
      [activeHost.id]: nextHistory,
    };
    let nextState = {
      ...answerState,
      perHostCommandHistory: nextHistoryByHost,
      perHostTerminalTranscript: nextTranscripts,
    };

    if (response.action === 'clear') {
      nextTranscripts[activeHost.id] = [];
    } else if (response.action === 'reset') {
      nextTranscripts[activeHost.id] = createInitialTranscript(
        lab,
        activeHost,
      );
      nextState = clearHostEvidence(nextState, lab, activeHost.id);
      nextState.perHostCommandHistory = {
        ...nextState.perHostCommandHistory,
        [activeHost.id]: [],
      };
    } else {
      nextTranscripts[activeHost.id] = [
        ...activeHostTranscript,
        {
          id: `${activeHost.id}-${Date.now()}-${activeHostTranscript.length}`,
          command: rawCommand,
          output: response.output,
        },
      ];
      nextState = applyCommandEvidence(
        nextState,
        commandEvidenceTargets,
        activeHost.id,
        normalizedCommand,
      );
    }

    updateAnswerState(nextState);
  }

  return (
    <section className="pbq-simulator-panel" aria-label="Multi-host command-line lab">
      <div className="pbq-simulator-header">
        <h3>{lab.tasks?.prompt ?? lab.title}</h3>
        <p>
          Use the simulated host tabs to inspect static command output, gather
          supporting evidence, and complete the final decisions.
        </p>
      </div>

      {lab.assets?.environmentSummary && (
        <section className="pbq-evidence-panel" aria-label="Environment summary">
          <h4>Environment summary</h4>
          <p>{lab.assets.environmentSummary}</p>
        </section>
      )}

      <div className="pbq-host-tabs" role="tablist" aria-label="Simulated hosts">
        {hosts.map((host) => (
          <button
            aria-selected={activeHost.id === host.id}
            className={activeHost.id === host.id ? 'active' : ''}
            key={host.id}
            onClick={() => setActiveHostId(host.id)}
            role="tab"
            type="button"
          >
            {host.label}
          </button>
        ))}
      </div>

      <section className="pbq-host-context" aria-label="Active host context">
        <h4>{activeHost.label}</h4>
        <p>{activeHost.description}</p>
      </section>

      <section className="pbq-terminal" aria-label={`${activeHost.label} simulated terminal`}>
        <div className="pbq-terminal-output" role="log" aria-live="polite">
          {activeHostTranscript.map((entry) => (
            <div className="pbq-terminal-entry" key={entry.id}>
              {entry.command && (
                <p>
                  <span className="pbq-terminal-prompt">
                    {activeHost.prompt ?? 'certsim@lab:~$'}
                  </span>{' '}
                  <span>{entry.command}</span>
                </p>
              )}
              {entry.output && <pre>{entry.output}</pre>}
            </div>
          ))}
        </div>

        <form className="pbq-terminal-input-row" onSubmit={runCommand}>
          <label className="pbq-terminal-prompt" htmlFor={`${lab.id}-${activeHost.id}-command`}>
            {activeHost.prompt ?? 'certsim@lab:~$'}
          </label>
          <input
            autoComplete="off"
            id={`${lab.id}-${activeHost.id}-command`}
            name="command"
            spellCheck="false"
          />
        </form>
      </section>

      {commandEvidenceTargets.length > 0 && (
        <section className="pbq-classification-panel" aria-label="Evidence gathered">
          <h4>Evidence gathered</h4>
          <div className="pbq-command-evidence-grid">
            {commandEvidenceTargets.map((target) => {
              const isInspected = answerState[target.id] === 'inspected';
              const host = hosts.find((candidate) => candidate.id === target.hostId);

              return (
                <div
                  className={isInspected ? 'pbq-evidence-chip inspected' : 'pbq-evidence-chip'}
                  key={target.id}
                >
                  <strong>{target.label}</strong>
                  <span>{host?.label ?? target.hostId}</span>
                  <small>{isInspected ? 'Inspected' : 'Not inspected yet'}</small>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {decisionTargets.length > 0 && (
        <section className="pbq-classification-panel" aria-label="Final decisions">
          <h4>{lab.tasks?.decisionTitle ?? 'Final decisions'}</h4>
          <div className="pbq-config-grid">
            {decisionTargets.map((target) => (
              <label className="pbq-config-row" key={target.id}>
                <span>
                  <strong>{target.label}</strong>
                  <small>{target.requirement}</small>
                </span>
                <select
                  value={answerState[target.id] ?? ''}
                  onChange={(event) => updateDecision(target.id, event.target.value)}
                >
                  <option value="">Select value</option>
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
      )}
    </section>
  );
}

function normalizeAnswerState(answer) {
  if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
    return {
      ...answer,
      perHostCommandHistory:
        answer.perHostCommandHistory &&
        typeof answer.perHostCommandHistory === 'object'
          ? answer.perHostCommandHistory
          : {},
      perHostTerminalTranscript:
        answer.perHostTerminalTranscript &&
        typeof answer.perHostTerminalTranscript === 'object'
          ? answer.perHostTerminalTranscript
          : {},
    };
  }

  return {
    perHostCommandHistory: {},
    perHostTerminalTranscript: {},
  };
}

function getSupportedCommands(host) {
  return host.allowedCommands ?? Object.keys(host.commandOutputs ?? {});
}

function getHostTranscript(lab, host, transcript) {
  return Array.isArray(transcript)
    ? transcript
    : createInitialTranscript(lab, host);
}

function createInitialTranscript(lab, host) {
  const supportedCommands = getSupportedCommands(host);

  return [
    {
      id: `${lab.id}-${host?.id}-welcome`,
      command: '',
      output: `${host?.label ?? lab.title}\nType help to view supported commands.\nThis is a static browser-only simulation.`,
    },
    {
      id: `${lab.id}-${host?.id}-commands`,
      command: '',
      output: `Available command count: ${supportedCommands.length}`,
    },
  ];
}

function applyCommandEvidence(answerState, evidenceTargets, hostId, command) {
  const matchingTargets = evidenceTargets.filter(
    (target) =>
      target.hostId === hostId &&
      (target.commands ?? []).some(
        (candidate) => normalizePBQCommand(candidate) === command,
      ),
  );

  if (matchingTargets.length === 0) {
    return answerState;
  }

  return matchingTargets.reduce(
    (nextState, target) => ({
      ...nextState,
      [target.id]: 'inspected',
    }),
    answerState,
  );
}

function clearHostEvidence(answerState, lab, hostId) {
  const nextState = { ...answerState };

  (lab.tasks?.commandEvidenceTargets ?? [])
    .filter((target) => target.hostId === hostId)
    .forEach((target) => {
      delete nextState[target.id];
    });

  return nextState;
}
