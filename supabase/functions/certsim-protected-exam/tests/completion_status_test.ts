import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.14";
import { handleProtectedExam } from "../handler.ts";
import { completionStatusArgs, mapCompletionStatusDto } from "../completion-status.ts";
const actor = "20120000-0000-4000-8000-000000000001", attempt = "20120000-0000-4000-8000-000000000002";
const origin = "http://127.0.0.1:4179";
const dto = () => ({ contractVersion: 1, attemptId: attempt, examKey: "synthetic", packageVersion: "1.0.0",
  profileKey: "formal", profileName: "Synthetic formal", purpose: "self_directed_exam", assignmentId: null,
  deadline: "2026-10-16T07:00:00+00:00", observedAt: "2026-10-16T08:00:00+00:00",
  expiryManaged: true, closureReason: "time_limit_expiry", answeringAllowed: false, state: "awaiting_processing", resultAvailable: false, completedAt: null });
function request(path: string, method = "GET", auth = true) {
  return new Request(origin + "/functions/v1/certsim-protected-exam" + path, { method, headers: { origin, ...(auth ? { authorization: "Bearer synthetic-status-token" } : {}) } });
}
function fixture(response: unknown, error: unknown = null, authenticated = true) {
  const calls: { name: string; args: Record<string, unknown> }[] = [], logs: string[] = [];
  const deps = { origins: new Set([origin]), log: (line: string) => logs.push(line),
    userClient: { auth: { getUser: async () => ({ data: { user: authenticated ? { id: actor } : null }, error: null }) } },
    createAdmin: () => ({ rpc: (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return Promise.resolve({ data: response, error }); } }) as never };
  return { calls, logs, run: (r: Request) => handleProtectedExam(r, deps) };
}
Deno.test("status derives actor from verified Auth and invokes exactly one fixed read RPC", async () => {
  const f = fixture({ ok: true, status: dto() });
  const r = await f.run(request("/attempts/" + attempt + "/completion-status"));
  assertEquals(r.status, 200); assertEquals(r.headers.get("cache-control"), "no-store");
  assertEquals(f.calls, [{ name: "certsim_protected_get_completion_status", args: { p_actor_id: actor, p_attempt_id: attempt } }]);
  assertEquals(await r.json(), { status: dto() });
  assertEquals(f.logs.some((line) => line.includes(actor) || line.includes(attempt)), false);
});
Deno.test("pending page fixes owner, strict limit and bounded watch set without lifecycle RPCs", async () => {
  const raw = { ok: true, contractVersion: 1, observedAt: dto().observedAt, items: [dto()], watched: [dto()], returnedCount: 1, nextCursor: null };
  const f = fixture(raw);
  const r = await f.run(request("/completion-status/pending?pageSize=1&watch=" + attempt + "&examKey=synthetic&profileId=formal"));
  assertEquals(r.status, 200); const body = await r.json(); assertEquals(body.items.length, 1);
  assertEquals(f.calls[0].name, "certsim_protected_list_pending_completions");
  assertEquals(f.calls[0].args.p_actor_id, actor); assertEquals(f.calls[0].args.p_watch_attempt_ids, [attempt]);
  assertEquals(f.calls[0].args.p_page_size, 1);
});
for (const query of ["pageSize=21", "pageSize=0", "pageSize=1.5", "ownerId=" + actor, "watch=" + attempt + "," + attempt, "examKey=synthetic&examKey=other"]) {
  Deno.test("pending rejects invalid scope/bound: " + query.split("=")[0], async () => {
    const f = fixture({});
    assertEquals((await f.run(request("/completion-status/pending?" + query))).status, 400);
    assertEquals(f.calls.length, 0);
  });
}
Deno.test("single status rejects caller-supplied identity and all mutation methods", async () => {
  const f = fixture({});
  assertEquals((await f.run(request("/attempts/" + attempt + "/completion-status?actorId=" + actor))).status, 400);
  assertEquals((await f.run(request("/attempts/" + attempt + "/completion-status", "POST"))).status, 405);
  assertEquals(f.calls.length, 0);
});
Deno.test("anonymous/unverified auth cannot reach a private status operation", async () => {
  for (const authenticated of [false, true]) {
    const f = fixture({}, null, authenticated);
    const r = await f.run(request("/completion-status/pending", "GET", !authenticated));
    assertEquals(r.status, 401); assertEquals(f.calls.length, 0);
  }
});
Deno.test("only missing new RPC gives explicit unsupported contract; unfamiliar failures remain errors", async () => {
  for (const code of ["PGRST202", "42501", "57014"]) {
    const f = fixture(null, { code });
    const r = await f.run(request("/completion-status/pending"));
    assertEquals(r.status, code === "PGRST202" ? 501 : 500);
    assertEquals((await r.json()).error.code, code === "PGRST202" ? "status_contract_unsupported" : "internal_failure");
    assertEquals(f.calls.length, 1);
  }
});
Deno.test("invalid upstream DTO and private sentinels never enter response or logs", async () => {
  for (const extra of [{ leaseToken: "PRIVATE_STATUS_SENTINEL" }, { state: "invented" }, { resultAvailable: true }]) {
    const f = fixture({ ok: true, status: { ...dto(), ...extra } });
    const r = await f.run(request("/attempts/" + attempt + "/completion-status"));
    assertEquals(r.status, 500);
    assertEquals((await r.text()).includes("PRIVATE_STATUS_SENTINEL"), false);
    assertEquals(f.logs.join("").includes("PRIVATE_STATUS_SENTINEL"), false);
  }
  assertThrows(() => mapCompletionStatusDto({ ...dto(), workspace: {} }));
  assertThrows(() => completionStatusArgs(request("/completion-status/pending?watch=not-a-reference"), actor));
});
