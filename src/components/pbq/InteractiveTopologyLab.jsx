import { useMemo, useState } from 'react';
import {
  createPBQCommandOutputMap,
  getPBQTerminalResponse,
  normalizePBQCommand,
} from '../../utils/pbqTerminal.js';

export default function InteractiveTopologyLab({
  answer = {},
  lab,
  onAnswerChange,
}) {
  const devices = useMemo(() => getTopologyDevices(lab), [lab]);
  const topology = lab.assets?.topology ?? {};
  const environmentSummary = lab.assets?.environmentSummary ?? lab.assets?.systemSummary;
  const answerState = normalizeAnswerState(answer);
  const [activeDeviceId, setActiveDeviceId] = useState(devices[0]?.id ?? '');
  const [isQuestionOpen, setIsQuestionOpen] = useState(false);
  const activeDevice =
    devices.find((device) => device.id === activeDeviceId) ?? devices[0] ?? null;
  const commandEvidenceTargets = lab.tasks?.commandEvidenceTargets ?? [];
  const evidenceItems = lab.tasks?.evidenceItems ?? [];
  const selectedEvidenceValue = lab.tasks?.selectionOptions?.[0]?.id ?? 'selected';
  const finalTargets =
    lab.tasks?.decisionTargets ??
    lab.tasks?.ruleFields ??
    lab.tasks?.configurationTargets ??
    [];
  const activeTranscript = useMemo(
    () =>
      getDeviceTranscript(
        lab,
        activeDevice,
        answerState.perHostTerminalTranscript?.[activeDevice?.id],
      ),
    [activeDevice, answerState.perHostTerminalTranscript, lab],
  );

  function updateAnswerState(nextState) {
    onAnswerChange?.(nextState);
  }

  function updateDecision(targetId, value) {
    updateAnswerState({
      ...answerState,
      [targetId]: value,
    });
  }

  function updateEvidenceSelection(targetId, isSelected) {
    updateAnswerState({
      ...answerState,
      [targetId]: isSelected ? selectedEvidenceValue : '',
    });
  }

  function resetAllAnswers() {
    updateAnswerState(lab.initialState?.selectedAnswer ?? {});
  }

  function runDeviceCommand(device, command) {
    if (!device || !command) {
      return;
    }

    const normalizedCommand = normalizePBQCommand(command);
    const commandOutputs = createPBQCommandOutputMap(device.commandOutputs ?? {});
    const supportedCommands = getSupportedCommands(device);
    const response = getPBQTerminalResponse(
      normalizedCommand,
      commandOutputs,
      supportedCommands,
    );
    const currentTranscript = getDeviceTranscript(
      lab,
      device,
      answerState.perHostTerminalTranscript?.[device.id],
    );
    const nextHistory = [
      ...(answerState.perHostCommandHistory?.[device.id] ?? []),
      command,
    ];
    const nextTranscripts = {
      ...answerState.perHostTerminalTranscript,
    };
    const nextHistoryByDevice = {
      ...answerState.perHostCommandHistory,
      [device.id]: nextHistory,
    };
    let nextState = {
      ...answerState,
      perHostCommandHistory: nextHistoryByDevice,
      perHostTerminalTranscript: nextTranscripts,
    };

    if (response.action === 'clear') {
      nextTranscripts[device.id] = [];
    } else if (response.action === 'reset') {
      nextTranscripts[device.id] = createInitialTranscript(lab, device);
      nextState = clearDeviceEvidence(nextState, lab, device.id);
      nextState.perHostCommandHistory = {
        ...nextState.perHostCommandHistory,
        [device.id]: [],
      };
    } else {
      nextTranscripts[device.id] = [
        ...currentTranscript,
        {
          id: `${device.id}-${Date.now()}-${currentTranscript.length}`,
          command,
          output: response.output,
        },
      ];
      nextState = applyCommandEvidence(
        nextState,
        commandEvidenceTargets,
        device.id,
        normalizedCommand,
      );
    }

    updateAnswerState(nextState);
  }

  function handleTerminalSubmit(event) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const command = String(formData.get('command') ?? '').trim();

    if (!command) {
      return;
    }

    event.currentTarget.reset();
    runDeviceCommand(activeDevice, command);
  }

  if (!activeDevice) {
    return (
      <section className="pbq-topology-shell" aria-label="Interactive topology lab">
        <div className="pbq-topology-toolbar">
          <h3>{lab.tasks?.prompt ?? lab.title}</h3>
          <button className="secondary-button" type="button" onClick={resetAllAnswers}>
            Reset All Answers
          </button>
        </div>
        <p>No devices are configured for this lab.</p>
      </section>
    );
  }

  return (
    <section className="pbq-topology-shell" aria-label="Interactive topology lab">
      <div className="pbq-topology-toolbar">
        <div>
          <p className="eyebrow">Interactive PBQ workspace</p>
          <h3>{lab.tasks?.prompt ?? lab.title}</h3>
        </div>
        <div className="pbq-topology-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={() => setIsQuestionOpen((current) => !current)}
          >
            {isQuestionOpen ? 'Hide Question' : 'Show Question'}
          </button>
          <button className="secondary-button" type="button" onClick={resetAllAnswers}>
            Reset All Answers
          </button>
        </div>
      </div>

      {isQuestionOpen && (
        <aside className="pbq-question-drawer" aria-label="Question and instructions">
          <h4>{lab.title}</h4>
          <p>{lab.scenario}</p>
          <ul>
            {(lab.instructions ?? []).map((instruction) => (
              <li key={instruction}>{instruction}</li>
            ))}
          </ul>
        </aside>
      )}

      {environmentSummary && (
        <section className="pbq-evidence-panel" aria-label="Environment summary">
          <h4>Environment summary</h4>
          <p>{environmentSummary}</p>
        </section>
      )}

      <div className="pbq-topology-workspace">
        <section className="pbq-network-canvas" aria-label="Network diagram">
          {(topology.nodes ?? devices).map((node) => {
            const device = devices.find((candidate) => candidate.id === node.id);
            const isDevice = Boolean(device);
            const isActive = activeDevice.id === node.id;

            return (
              <button
                className={[
                  'pbq-topology-node',
                  node.kind ?? 'device',
                  isActive ? 'active' : '',
                  isDevice ? '' : 'static',
                ]
                  .filter(Boolean)
                  .join(' ')}
                disabled={!isDevice}
                key={node.id}
                onClick={() => isDevice && setActiveDeviceId(node.id)}
                type="button"
              >
                <span>{node.label}</span>
                {node.meta && <small>{node.meta}</small>}
              </button>
            );
          })}

          {(topology.connections ?? []).length > 0 && (
            <div className="pbq-connection-list" aria-label="Topology connections">
              {(topology.connections ?? []).map((connection) => (
                <span key={`${connection.from}-${connection.to}`}>
                  {getNodeLabel(topology.nodes, connection.from)}
                  {' -> '}
                  {getNodeLabel(topology.nodes, connection.to)}
                </span>
              ))}
            </div>
          )}
        </section>

        <section className="pbq-device-panel" aria-label="Device tools">
          <div className="pbq-device-panel-header">
            <div>
              <h4>{activeDevice.label}</h4>
              <p>{activeDevice.description}</p>
            </div>
          </div>

          <div className="pbq-device-tool-grid" aria-label="Device tools">
            {getDeviceTools(activeDevice).map((tool) => (
              <button
                className="secondary-button"
                key={tool.id}
                onClick={() => runDeviceCommand(activeDevice, tool.command)}
                type="button"
              >
                {tool.label}
              </button>
            ))}
          </div>

          {(activeDevice.reports ?? []).map((report) => (
            <section className="pbq-evidence-panel" key={report.id}>
              <h4>{report.title}</h4>
              <p>{report.body}</p>
            </section>
          ))}

          <section className="pbq-terminal compact" aria-label={`${activeDevice.label} command viewer`}>
            <div className="pbq-terminal-output" role="log" aria-live="polite">
              {activeTranscript.map((entry) => (
                <div className="pbq-terminal-entry" key={entry.id}>
                  {entry.command && (
                    <p>
                      <span className="pbq-terminal-prompt">
                        {activeDevice.prompt ?? 'certsim@lab:~$'}
                      </span>{' '}
                      <span>{entry.command}</span>
                    </p>
                  )}
                  {entry.output && <pre>{entry.output}</pre>}
                </div>
              ))}
            </div>
            <form className="pbq-terminal-input-row" onSubmit={handleTerminalSubmit}>
              <label className="pbq-terminal-prompt" htmlFor={`${lab.id}-${activeDevice.id}-command`}>
                {activeDevice.prompt ?? 'certsim@lab:~$'}
              </label>
              <input
                autoComplete="off"
                id={`${lab.id}-${activeDevice.id}-command`}
                name="command"
                spellCheck="false"
              />
            </form>
          </section>
        </section>
      </div>

      {commandEvidenceTargets.length > 0 && (
        <section className="pbq-classification-panel" aria-label="Evidence gathered">
          <h4>Evidence gathered</h4>
          <div className="pbq-command-evidence-grid">
            {commandEvidenceTargets.map((target) => {
              const isInspected = answerState[target.id] === 'inspected';
              const device = devices.find((candidate) => candidate.id === target.hostId);

              return (
                <div
                  className={isInspected ? 'pbq-evidence-chip inspected' : 'pbq-evidence-chip'}
                  key={target.id}
                >
                  <strong>{target.label}</strong>
                  <span>{device?.label ?? target.hostId}</span>
                  <small>{isInspected ? 'Inspected' : 'Not inspected yet'}</small>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {evidenceItems.length > 0 && (
        <section className="pbq-classification-panel" aria-label="Evidence selections">
          <h4>Evidence selections</h4>
          <div className="pbq-config-grid">
            {evidenceItems.map((item) => (
              <label className="pbq-config-row" key={item.id}>
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </span>
                <input
                  checked={answerState[item.id] === selectedEvidenceValue}
                  onChange={(event) =>
                    updateEvidenceSelection(item.id, event.target.checked)
                  }
                  type="checkbox"
                />
              </label>
            ))}
          </div>
        </section>
      )}

      {finalTargets.length > 0 && (
        <section className="pbq-classification-panel" aria-label="Final answer panel">
          <h4>{lab.tasks?.decisionTitle ?? lab.tasks?.panelTitle ?? 'Final answer'}</h4>
          <div className="pbq-config-grid">
            {finalTargets.map((target) => (
              <label className="pbq-config-row" key={target.id}>
                <span>
                  <strong>{target.label}</strong>
                  <small>
                    {target.requirement ?? target.helperText ?? target.detail}
                  </small>
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

function getTopologyDevices(lab) {
  const configuredDevices = lab.assets?.devices ?? lab.assets?.hosts;

  if (Array.isArray(configuredDevices) && configuredDevices.length > 0) {
    return configuredDevices;
  }

  const deviceTools = lab.assets?.deviceTools ?? {};
  const nodes = lab.assets?.topology?.nodes ?? [];

  return Object.entries(deviceTools).map(([deviceId, tools]) => {
    const node = nodes.find((candidate) => candidate.id === deviceId) ?? {};
    const normalizedTools = (tools ?? []).map((tool) => {
      const command = tool.command ?? String(tool.id ?? '').replace(/-/g, ' ');

      return {
        id: tool.id ?? command,
        label: tool.label ?? command,
        command,
        output: tool.output,
      };
    });

    return {
      id: deviceId,
      label: node.label ?? deviceId,
      description: node.role ?? node.description ?? node.meta ?? '',
      prompt: `${deviceId}> `,
      allowedCommands: normalizedTools.map((tool) => tool.command),
      tools: normalizedTools.map((tool) => ({
        id: tool.id,
        label: tool.label,
        command: tool.command,
      })),
      commandOutputs: Object.fromEntries(
        normalizedTools.map((tool) => [
          tool.command,
          Array.isArray(tool.output) ? tool.output.join('\n') : tool.output ?? '',
        ]),
      ),
    };
  });
}

function getDeviceTools(device) {
  if (Array.isArray(device.tools) && device.tools.length > 0) {
    return device.tools;
  }

  return getSupportedCommands(device).map((command) => ({
    id: command,
    label: command,
    command,
  }));
}

function getSupportedCommands(device) {
  return device.allowedCommands ?? Object.keys(device.commandOutputs ?? {});
}

function getDeviceTranscript(lab, device, transcript) {
  return Array.isArray(transcript)
    ? transcript
    : createInitialTranscript(lab, device);
}

function createInitialTranscript(lab, device) {
  const supportedCommands = getSupportedCommands(device);

  return [
    {
      id: `${lab.id}-${device?.id}-welcome`,
      command: '',
      output: `${device?.label ?? lab.title}\nType help to view supported commands.\nThis is a static browser-only simulation.`,
    },
    {
      id: `${lab.id}-${device?.id}-commands`,
      command: '',
      output: `Available command count: ${supportedCommands.length}`,
    },
  ];
}

function applyCommandEvidence(answerState, evidenceTargets, deviceId, command) {
  const matchingTargets = evidenceTargets.filter(
    (target) =>
      target.hostId === deviceId &&
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

function clearDeviceEvidence(answerState, lab, deviceId) {
  const nextState = { ...answerState };

  (lab.tasks?.commandEvidenceTargets ?? [])
    .filter((target) => target.hostId === deviceId)
    .forEach((target) => {
      delete nextState[target.id];
    });

  return nextState;
}

function getNodeLabel(nodes = [], nodeId) {
  return nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
}
