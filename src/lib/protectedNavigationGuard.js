export async function requestProtectedNavigation({
  isProtectedAttempt,
  navigate,
  saveCurrentResponse,
}) {
  if (typeof navigate !== 'function') return false;
  if (!isProtectedAttempt) {
    navigate();
    return true;
  }
  if (typeof saveCurrentResponse !== 'function') return false;
  const saved = await saveCurrentResponse();
  if (!saved) return false;
  navigate();
  return true;
}
