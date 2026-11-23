// Existing synthetic lifecycle suites deliberately model a backend predating
// learner completion status. Make that version boundary explicit; unfamiliar
// transport/application failures must not become a compatibility fallback.
export async function replyLegacyCompletionContract(route) {
  const path = new URL(route.request().url()).pathname;
  if (!path.includes('/certsim-protected-exam/') ||
    !(path.endsWith('/completion-status') || path.endsWith('/completion-status/pending'))) return false;
  await route.fulfill({ status: 404, contentType: 'application/json', headers: { 'cache-control': 'no-store' },
    body: JSON.stringify({ error: { code: 'invalid_request' } }) });
  return true;
}
