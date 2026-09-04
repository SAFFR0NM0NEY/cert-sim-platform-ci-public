import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createPBQCommandOutputMap,
  getPBQTerminalResponse,
  normalizePBQCommand,
} from '../../utils/pbqTerminal.js';

export default function SimulatedTerminal({
  commandHistory: persistedCommandHistory,
  lab,
  onCommandReset,
  onCommandRun,
  onTerminalStateChange,
  terminalTranscript,
  resetKey = 0,
}) {
  const terminalConfig = lab.assets?.terminal ?? {};
  const prompt = terminalConfig.prompt ?? 'analyst@certsim-lab:~$';
  const commandOutputs = useMemo(
    () => createPBQCommandOutputMap(terminalConfig.commandOutputs ?? {}),
    [terminalConfig.commandOutputs],
  );
  const supportedCommands = useMemo(
    () => lab.allowedCommands ?? Object.keys(terminalConfig.commandOutputs ?? {}),
    [lab.allowedCommands, terminalConfig.commandOutputs],
  );
  const initialTranscript = useMemo(
    () => createInitialTranscript(lab, supportedCommands),
    [lab.id, lab.title, supportedCommands],
  );
  const [inputValue, setInputValue] = useState('');
  const [historyIndex, setHistoryIndex] = useState(null);
  const [commandHistory, setCommandHistory] = useState(() =>
    normalizePersistedCommandHistory(persistedCommandHistory),
  );
  const [transcript, setTranscript] = useState(() =>
    normalizePersistedTranscript(terminalTranscript, initialTranscript),
  );
  const inputRef = useRef(null);

  useEffect(() => {
    setInputValue('');
    setHistoryIndex(null);
    setCommandHistory(normalizePersistedCommandHistory(persistedCommandHistory));
    setTranscript(normalizePersistedTranscript(terminalTranscript, initialTranscript));
  }, [lab.id, resetKey]);

  function handleSubmit(event) {
    event.preventDefault();
    const rawCommand = inputValue.trim();

    if (!rawCommand) {
      return;
    }

    const normalizedCommand = normalizePBQCommand(rawCommand);
    const response = getPBQTerminalResponse(
      normalizedCommand,
      commandOutputs,
      supportedCommands,
    );

    const nextCommandHistory = [...commandHistory, rawCommand];

    setCommandHistory(nextCommandHistory);
    setHistoryIndex(null);
    setInputValue('');

    let nextTranscript = transcript;

    if (response.action === 'clear') {
      nextTranscript = [];
      setTranscript(nextTranscript);
    } else if (response.action === 'reset') {
      nextTranscript = initialTranscript;
      setTranscript(nextTranscript);
      setCommandHistory([]);
      setHistoryIndex(null);
    } else {
      nextTranscript = [
        ...transcript,
        {
          id: crypto.randomUUID(),
          command: rawCommand,
          output: response.output,
        },
      ];
      setTranscript(nextTranscript);
    }

    const scoredCommand = ['help', 'clear', 'reset'].includes(normalizedCommand)
      ? null
      : rawCommand;
    const nextTerminalState = {
      commandHistory: response.action === 'reset' ? [] : nextCommandHistory,
      scoredCommand,
      terminalTranscript: nextTranscript,
    };

    if (onTerminalStateChange) {
      onTerminalStateChange({
        ...nextTerminalState,
        action: response.action,
        command: rawCommand,
        normalizedCommand,
      });
      return;
    }

    if (response.action === 'reset') {
      onCommandReset?.(nextTerminalState);
    } else if (scoredCommand) {
      onCommandRun?.(scoredCommand);
    }
  }

  function handleKeyDown(event) {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveThroughHistory(-1);
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveThroughHistory(1);
    }
  }

  function moveThroughHistory(direction) {
    if (commandHistory.length === 0) {
      return;
    }

    const nextIndex =
      historyIndex === null
        ? commandHistory.length - 1
        : Math.min(
            commandHistory.length - 1,
            Math.max(0, historyIndex + direction),
          );

    setHistoryIndex(nextIndex);
    setInputValue(commandHistory[nextIndex] ?? '');
  }

  return (
    <section className="pbq-terminal" aria-label="Simulated terminal">
      <div
        className="pbq-terminal-output"
        role="log"
        aria-live="polite"
        onClick={() => inputRef.current?.focus()}
      >
        {transcript.map((entry) => (
          <div className="pbq-terminal-entry" key={entry.id}>
            {entry.command && (
              <p>
                <span className="pbq-terminal-prompt">{prompt}</span>{' '}
                <span>{entry.command}</span>
              </p>
            )}
            {entry.output && <pre>{entry.output}</pre>}
          </div>
        ))}
      </div>

      <form className="pbq-terminal-input-row" onSubmit={handleSubmit}>
        <label className="pbq-terminal-prompt" htmlFor={`${lab.id}-terminal-input`}>
          {prompt}
        </label>
        <input
          id={`${lab.id}-terminal-input`}
          ref={inputRef}
          autoComplete="off"
          spellCheck="false"
          value={inputValue}
          onChange={(event) => setInputValue(event.target.value)}
          onKeyDown={handleKeyDown}
        />
      </form>
    </section>
  );
}

function createInitialTranscript(lab, supportedCommands) {
  return [
    {
      id: `${lab.id}-welcome`,
      command: '',
      output: `${lab.title}\nType help to view supported commands.\nThis is a static browser-only simulation.`,
    },
    {
      id: `${lab.id}-commands`,
      command: '',
      output: `Available command count: ${supportedCommands.length}`,
    },
  ];
}

function normalizePersistedCommandHistory(commandHistory) {
  return Array.isArray(commandHistory) ? commandHistory.filter(Boolean) : [];
}

function normalizePersistedTranscript(terminalTranscript, fallbackTranscript) {
  return Array.isArray(terminalTranscript)
    ? terminalTranscript.filter((entry) => entry && typeof entry === 'object')
    : fallbackTranscript;
}
