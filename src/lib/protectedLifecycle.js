const FORMAL_PURPOSES = new Set(['assigned_assessment', 'self_directed_exam']);

export function getProtectedExitContract(purpose) {
  if (purpose === 'study_sandbox') {
    return Object.freeze({
      label: 'Save & exit',
      description: 'Your current response will be saved. You can resume this Study Sandbox within the 30-day inactivity window.',
      terminal: false,
    });
  }
  if (FORMAL_PURPOSES.has(purpose)) {
    return Object.freeze({ label: 'End attempt', description: '', terminal: true });
  }
  return Object.freeze({ label: 'End practice', description: '', terminal: true });
}
