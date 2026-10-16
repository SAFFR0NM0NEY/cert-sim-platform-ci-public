// No learner route, scheduler, provider or background task.
export const MAX_CLAIMS = 5;
export const BUDGET_MS = 110_000;
const NEXT_RESERVE_MS = 31_000;
type Outcome = { outcome: string; attemptId?: string; leaseToken?: string };
type Rpc = (name: string, args: Record<string, string>, timeout: number) => Promise<Outcome>;

export async function runWorker(rpc: Rpc, now = () => performance.now()) {
  const started = now();
  const counts = { claimed: 0, completed: 0, deferred: 0, blocked: 0, stale: 0, uncertain: 0 };
  let state = 'bounded';
  while (counts.claimed < MAX_CLAIMS && now() - started < BUDGET_MS - NEXT_RESERVE_MS) {
    let claim: Outcome;
    try { claim = await rpc('certsim_service_claim_next_expiry', {}, 6000); }
    catch { state = 'unavailable'; break; }
    if (claim.outcome !== 'claimed') { state = claim.outcome === 'disabled' ? 'disabled' : 'idle'; break; }
    if (!claim.attemptId || !claim.leaseToken) { state = 'unavailable'; break; }
    counts.claimed++;
    const args = { p_attempt_id: claim.attemptId, p_token: claim.leaseToken };
    let result: Outcome;
    try { result = await rpc('certsim_service_finish_expiry', args, 18_000); }
    catch {
      try { result = await rpc('certsim_service_reconcile_expiry', args, 6000); }
      catch { counts.uncertain++; continue; }
    }
    if (result.outcome === 'completed') counts.completed++;
    else if (result.outcome === 'blocked' || result.outcome === 'exhausted') counts.blocked++;
    else if (result.outcome === 'deferred') counts.deferred++;
    else counts.stale++;
  }
  return { state, ...counts };
}

export async function equalCredential(received: string, expected: string) {
  const encoder = new TextEncoder();
  const [a,b] = await Promise.all([received, expected].map(v => crypto.subtle.digest('SHA-256', encoder.encode(v))));
  const left = new Uint8Array(a), right = new Uint8Array(b);
  let different = 0;
  for (let i=0;i<left.length;i++) different |= left[i] ^ right[i];
  return different === 0;
}

export async function emptyRequestBody(request: Request) {
  if (!request.body) return true;
  // Gateways may forward an empty POST as an empty stream. Read at most two
  // bytes with a one-second deadline, accepting only empty or literal {}.
  const reader = request.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        let text = '';
        const decoder = new TextDecoder();
        for (let reads=0;reads<3;reads++) {
          const chunk = await reader.read();
          if (chunk.done) return text === '' || text === '{}';
          if (chunk.value.length + text.length > 2) return false;
          text += decoder.decode(chunk.value);
        }
        return false;
      })(),
      new Promise<boolean>(resolve => { timer=setTimeout(() => resolve(false), 1000); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
}

export function createHandler(env: (key: string) => string | undefined, fetcher = fetch) {
  return async (request: Request): Promise<Response> => {
    const secret = env('SUPABASE_SERVICE_ROLE_KEY');
    // Exact trusted server credential, never decoded role claims. Accept apikey
    // for service-to-service transport; browser JWTs are not this credential.
    const supplied = request.headers.get('apikey') ?? '';
    if (!secret || secret.length < 32 || supplied.length > 4096 || !await equalCredential(supplied, secret)) {
      return Response.json({ code: 'unauthorized' }, { status: 401 });
    }
    if (request.method !== 'POST') return Response.json({ code: 'method_not_allowed' }, { status: 405 });
    // No body/query controls. Reject without buffering arbitrary input.
    if (new URL(request.url).search || !await emptyRequestBody(request)) return Response.json({ code: 'invalid_request' }, { status: 400 });
    if (env('CERTSIM_EXPIRY_WORKER_ENABLED') !== 'true') return Response.json({ state: 'disabled', claimed: 0 });
    const url = env('SUPABASE_URL');
    if (!url || !/^https?:\/\//.test(url)) return Response.json({ code: 'unavailable' }, { status: 503 });
    const rpc: Rpc = async (name,args,timeout) => {
      const response = await fetcher(`${url}/rest/v1/rpc/${name}`, {
        method: 'POST', headers: { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args), signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new Error('rpc_unavailable');
      return await response.json();
    };
    return Response.json(await runWorker(rpc));
  };
}
