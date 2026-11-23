// Additive statistics must not inherit required-count zero defaults. Preserve
// provenance through normalization without echoing malformed caller values.
const UNAVAILABLE_STATES = new Set(['absent', 'unknown', 'invalid', 'not_applicable', 'unavailable']);
export function optionalNonnegativeCount(object, key, stateKey = `${key}State`) {
  if (!object || !Object.hasOwn(object, key)) return { value: null, state: 'absent' };
  const value = object[key];
  if (Number.isSafeInteger(value) && value >= 0) return { value, state: 'known' };
  if (value === null || value === undefined) return {
    value: null,
    state: UNAVAILABLE_STATES.has(object[stateKey]) ? object[stateKey] : 'unknown',
  };
  return { value: null, state: 'invalid' };
}

export function compareOptionalCount(current, candidate, key) {
  const before = optionalNonnegativeCount(current, key);
  const after = optionalNonnegativeCount(candidate, key);
  const available = before.state === 'known' && after.state === 'known';
  return {
    current: before.value, candidate: after.value,
    currentState: before.state, candidateState: after.state,
    availability: available ? 'available' : 'unavailable',
    delta: available ? after.value - before.value : null,
  };
}
