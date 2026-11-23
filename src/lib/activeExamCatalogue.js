// Content-free display projection only; never selection, timing or scoring authority.
export const PYTHON_CATALOGUE_PROFILES = ['inf303-standard', 'inf303-compact'];
export function activePythonAvailabilityRequest(profileId) {
  if (!PYTHON_CATALOGUE_PROFILES.includes(profileId)) throw new Error('invalid_profile');
  return { examKey: 'inf303', profileId, purpose: 'self_directed_exam',
    includePbqs: false, language: 'not_applicable' };
}
export function projectActivePythonCatalogue(responses) {
  if (!Array.isArray(responses) || responses.length !== 2) return null;
  const profiles = responses.map((value, index) => {
    if (value == null || value.ok === false || value.available === false || value.eligible === false
      || value.code || value.reasonCode || value.examKey !== 'inf303'
      || value.profileKey !== PYTHON_CATALOGUE_PROFILES[index]
      || value.purpose !== 'self_directed_exam' || value.timed !== true
      || !/^\d+\.\d+\.\d+$/.test(value.packageVersion ?? '')
      || !Number.isInteger(value.timeLimitMinutes) || value.timeLimitMinutes < 1
      || value.timeLimitMinutes > 1440) return null;
    let counts;
    if (value.countPolicy != null) {
      if (value.fixedProfileSize !== false) return null;
      counts = value.countPolicy.allowedCounts;
      if (!Array.isArray(counts) || !counts.length || counts.length > 20
        || new Set(counts).size !== counts.length) return null;
    } else {
      if (value.fixedProfileSize !== true) return null;
      counts = [value.selectedCount];
    }
    if (!counts.every(count => Number.isInteger(count) && count > 0 && count <= 500)) return null;
    return { profileKey: value.profileKey, packageVersion: value.packageVersion,
      countLabel: [...counts].sort((a, b) => a - b).join(' or '), minutes: value.timeLimitMinutes };
  });
  return profiles.every(Boolean) && profiles[0].packageVersion === profiles[1].packageVersion
    ? { packageVersion: profiles[0].packageVersion, profiles } : null;
}
