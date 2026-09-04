export const PBQ_UNSUPPORTED_COMMAND_MESSAGE =
  'Command not available in this simulation. Type help to view supported commands.';

export function normalizePBQCommand(command) {
  return String(command ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

export function createPBQCommandOutputMap(commandOutputs = {}) {
  return Object.fromEntries(
    Object.entries(commandOutputs).map(([command, output]) => [
      normalizePBQCommand(command),
      output,
    ]),
  );
}

export function getPBQTerminalResponse(command, commandOutputs, supportedCommands) {
  const normalizedCommand = normalizePBQCommand(command);

  if (normalizedCommand === 'help') {
    return {
      action: 'output',
      output: `Supported commands:\n${supportedCommands.join('\n')}`,
    };
  }

  if (normalizedCommand === 'clear') {
    return {
      action: 'clear',
      output: '',
    };
  }

  if (normalizedCommand === 'reset') {
    return {
      action: 'reset',
      output: 'Terminal simulation reset.',
    };
  }

  return {
    action: 'output',
    output: commandOutputs[normalizedCommand] ?? PBQ_UNSUPPORTED_COMMAND_MESSAGE,
  };
}
