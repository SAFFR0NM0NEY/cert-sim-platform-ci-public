export const EMPTY_TRAINER_FILTERS = Object.freeze({
  organisationId: '', campusId: '', groupId: '', assignmentId: '', examKey: '',
  progressStatus: '', readinessStatus: '', resultStatus: '', search: '',
});

export function updateDraftScopeFilter(current, field, value) {
  const childFields = {
    organisationId: ['campusId', 'groupId', 'assignmentId', 'examKey'],
    campusId: ['groupId', 'assignmentId'],
    groupId: ['assignmentId'],
    examKey: ['assignmentId'],
    assignmentId: [],
  };
  return { ...current, [field]: value, ...Object.fromEntries((childFields[field] ?? []).map((child) => [child, ''])) };
}

export function trainerFiltersEqual(left, right) {
  return Object.keys(EMPTY_TRAINER_FILTERS).every((key) => String(left?.[key] ?? '') === String(right?.[key] ?? ''));
}
