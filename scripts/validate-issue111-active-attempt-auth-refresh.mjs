import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createProtectedAccessTokenProvider } from '../src/lib/protectedAccessToken.js';
import {
  createProtectedExamClient,
  submitProtectedAttemptWithRecovery,
} from '../src/lib/protectedExamClient.js';

const ATTEMPT = '10000000-0000-4000-8000-000000000001';
const ITEM = '20000000-0000-4000-8000-000000000001';
const REQUEST = '30000000-0000-4000-8000-000000000001';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bearer(request) {
  return request.headers.Authorization.replace('Bearer ', '');
}

function rotatingProvider(initialToken = 'token-a') {
  let token = initialToken;
  let refreshCount = 0;
  return {
    get token() { return token; },
    set token(value) { token = value; },
    get refreshCount() { return refreshCount; },
    provider: createProtectedAccessTokenProvider({
      getCurrentAccessToken: () => token,
      refreshSession: async () => {
        refreshCount += 1;
        token = 'token-b';
        return { data: { session: { access_token: token } }, error: null };
      },
    }),
  };
}

// A held read started with token A recovers with the already-rotated token B.
{
  const auth = rotatingProvider();
  const seen = [];
  const client = createProtectedExamClient({
    getAccessToken: auth.provider,
    fetchImpl: async (_url, request) => {
      seen.push(bearer(request));
      if (seen.length === 1) {
        auth.token = 'token-b';
        return jsonResponse(401, { error: { code: 'unauthenticated' } });
      }
      return jsonResponse(200, { items: [], page: { totalCount: 25, returnedThrough: 20, hasMore: true } });
    },
  });
  await client.getAttemptItemPage(ATTEMPT, 0, 20);
  assert.deepEqual(seen, ['token-a', 'token-b']);
  assert.equal(auth.refreshCount, 0, 'an auth event that already supplied token B must not force another refresh');
}

// If the auth listener has not delivered B yet, one explicit refresh recovers.
{
  const auth = rotatingProvider();
  const seen = [];
  const client = createProtectedExamClient({
    getAccessToken: auth.provider,
    fetchImpl: async (_url, request) => {
      seen.push(bearer(request));
      return seen.length === 1
        ? jsonResponse(401, { error: { code: 'unauthenticated' } })
        : jsonResponse(200, { attempt: { attemptId: ATTEMPT } });
    },
  });
  await client.resumeAttempt(ATTEMPT);
  assert.deepEqual(seen, ['token-a', 'token-b']);
  assert.equal(auth.refreshCount, 1);
}

// A save rejected at authentication is replayed once with the same idempotency
// key; only the request that reaches the authoritative mutation advances revision.
{
  const auth = rotatingProvider();
  let fetchCount = 0;
  let authoritativeMutations = 0;
  const bodies = [];
  const client = createProtectedExamClient({
    getAccessToken: auth.provider,
    fetchImpl: async (_url, request) => {
      fetchCount += 1;
      bodies.push(JSON.parse(request.body));
      if (fetchCount === 1) return jsonResponse(401, { error: { code: 'unauthenticated' } });
      authoritativeMutations += 1;
      return jsonResponse(200, { revision: 1 });
    },
  });
  const saved = await client.saveResponse(ATTEMPT, ITEM, { selected: ['choice-1'] }, 0, REQUEST);
  assert.equal(saved.revision, 1);
  assert.equal(authoritativeMutations, 1);
  assert.deepEqual(bodies[0], bodies[1], 'the retry must preserve response, expected revision, and request ID');
  assert.equal(bodies[0].requestId, REQUEST);
  assert.equal(bodies[0].expectedRevision, 0);
}

// Concurrent requests crossing the same boundary share one refresh operation.
{
  const auth = rotatingProvider();
  let calls = 0;
  const client = createProtectedExamClient({
    getAccessToken: auth.provider,
    fetchImpl: async () => {
      calls += 1;
      return calls <= 2
        ? jsonResponse(401, { error: { code: 'unauthenticated' } })
        : jsonResponse(200, { itemIds: [] });
    },
  });
  await Promise.all([client.listFlags(ATTEMPT), client.listFlags(ATTEMPT)]);
  assert.equal(auth.refreshCount, 1);
  assert.equal(calls, 4);
}

// Flagging and sandbox checks retain their request IDs across the same boundary.
for (const invoke of [
  (client) => client.setFlag(ATTEMPT, ITEM, true, REQUEST),
  (client) => client.checkPracticeItem(ATTEMPT, ITEM, 1, REQUEST),
]) {
  const auth = rotatingProvider();
  const bodies = [];
  const client = createProtectedExamClient({
    getAccessToken: auth.provider,
    fetchImpl: async (_url, request) => {
      bodies.push(JSON.parse(request.body));
      return bodies.length === 1
        ? jsonResponse(401, { error: { code: 'unauthenticated' } })
        : jsonResponse(200, { flagged: true, revision: 1 });
    },
  });
  await invoke(client);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].requestId, REQUEST);
  assert.deepEqual(bodies[0], bodies[1]);
}

// Submission keeps its existing recovery contract and sends one authoritative mutation.
{
  const auth = rotatingProvider();
  let calls = 0;
  let committed = 0;
  const client = createProtectedExamClient({
    getAccessToken: auth.provider,
    fetchImpl: async (_url, request) => {
      calls += 1;
      if (calls === 1) return jsonResponse(401, { error: { code: 'unauthenticated' } });
      committed += 1;
      return jsonResponse(200, { result: { attemptId: ATTEMPT, serverAuthoritative: true } });
    },
  });
  const submitted = await submitProtectedAttemptWithRecovery(client, ATTEMPT, REQUEST);
  assert.equal(submitted.recovered, false);
  assert.equal(committed, 1);
}

// A valid-token database authorization denial is never treated as refreshable auth.
for (const code of ['not_allowlisted']) {
  const auth = rotatingProvider();
  let calls = 0;
  const client = createProtectedExamClient({
    getAccessToken: auth.provider,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(403, { error: { code } });
    },
  });
  await assert.rejects(() => client.resumeAttempt(ATTEMPT), (error) => error.code === code);
  assert.equal(calls, 1);
  assert.equal(auth.refreshCount, 0);
}

// Logout fails closed before any protected request is sent.
{
  const auth = rotatingProvider();
  auth.token = null;
  let calls = 0;
  const client = createProtectedExamClient({
    getAccessToken: auth.provider,
    fetchImpl: async () => { calls += 1; return jsonResponse(200, {}); },
  });
  await assert.rejects(() => client.resumeAttempt(ATTEMPT), (error) => error.code === 'unauthenticated');
  assert.equal(calls, 0);
}

// Cross-user ownership remains a DB/Edge denial and cannot trigger auth recovery.
{
  const auth = rotatingProvider('valid-other-user-token');
  let calls = 0;
  const client = createProtectedExamClient({
    getAccessToken: auth.provider,
    fetchImpl: async () => { calls += 1; return jsonResponse(403, { error: { code: 'not_allowlisted' } }); },
  });
  await assert.rejects(() => client.getResult(ATTEMPT), (error) => error.code === 'not_allowlisted');
  assert.equal(calls, 1);
}

// Rotating an active session only resumes the existing attempt; it cannot create one.
{
  const auth = rotatingProvider();
  const paths = [];
  const client = createProtectedExamClient({
    getAccessToken: auth.provider,
    fetchImpl: async (url, request) => {
      paths.push({ path: String(url), method: request.method });
      if (paths.length === 1) return jsonResponse(401, { error: { code: 'unauthenticated' } });
      return jsonResponse(200, { attempt: { attemptId: ATTEMPT }, items: [] });
    },
  });
  await client.resumeAttempt(ATTEMPT);
  assert.equal(paths.some(({ path, method }) => path.endsWith('/attempts') && method === 'POST'), false);
}

const runner = await readFile(new URL('../src/components/exam/ProtectedExamRunner.jsx', import.meta.url), 'utf8');
const handler = await readFile(new URL('../supabase/functions/certsim-protected-exam/handler.ts', import.meta.url), 'utf8');
assert.match(runner, /createProtectedAccessTokenProvider/);
assert.match(runner, /getCurrentAccessToken:\s*\(\)\s*=>\s*sessionRef\.current\?\.access_token/);
assert.doesNotMatch(runner, /createProtectedExamClient\(\{\s*accessToken:\s*session\.access_token/);
assert.ok(handler.indexOf('userClient.auth.getUser()') < handler.indexOf('const admin ='),
  'Edge authentication must complete before an authoritative RPC can run');

console.log(JSON.stringify({
  ok: true,
  issue: 111,
  requestTimeTokenProvider: true,
  boundedAuthenticationRecovery: true,
  mutationIdempotencyPreserved: true,
  authorizationDenialNotRetried: true,
  logoutFailsClosed: true,
  replacementAttemptCreated: false,
}));
