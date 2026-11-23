export function selectCurrentWeakAreaProfile(profiles = [], historicalProfileKey = '') {
  const supported = profiles.find((profile) => profile?.id === historicalProfileKey);
  return supported?.id ?? profiles[0]?.id ?? '';
}
