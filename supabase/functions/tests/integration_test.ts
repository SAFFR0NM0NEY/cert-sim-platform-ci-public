import { assert, assertEquals } from "jsr:@std/assert@1.0.14";
const base = Deno.env.get("CERTSIM_EDGE_URL")!,
  token = Deno.env.get("CERTSIM_USER_JWT")!,
  anon = Deno.env.get("CERTSIM_ANON_KEY")!,
  db = Deno.env.get("CERTSIM_DB_URL")!,
  actorId = Deno.env.get("CERTSIM_ACTOR_ID")!;
const headers = {
  authorization: `Bearer ${token}`,
  apikey: anon,
  "content-type": "application/json",
  origin: "http://localhost:5173",
};
async function call(path: string, method = "GET", body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  return { response, data };
}
function noProtected(value: unknown) {
  const text = JSON.stringify(value).toLowerCase();
  for (
    const key of [
      "correctanswer",
      "explanation",
      "remediation",
      "scoring",
      "rubric",
      "protected",
      "packagehash",
      "validationhash",
    ]
  ) assert(!text.includes(key));
}
async function sql(statement: string) {
  const command = new Deno.Command("psql", {
    args: [db, "-v", "ON_ERROR_STOP=1", "-c", statement],
    stdout: "null",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) throw new Error("disposable SQL command failed");
}

Deno.test("disposable authenticated HTTP lifecycle", async () => {
  let unauth: Response | undefined;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    unauth = await fetch(base + "/eligibility?examKey=ai-901&packageVersion=1.0.0&profileId=ai901-controlled-beta-compact&purpose=assigned_assessment", {
      headers: { apikey: anon, origin: "http://localhost:5173" },
    });
    if (unauth.status !== 502) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(unauth);
  assertEquals(unauth.status, 401);
  const eligible = await call("/eligibility?examKey=ai-901&packageVersion=1.0.0&profileId=ai901-controlled-beta-compact&purpose=assigned_assessment");
  assertEquals(eligible.response.status, 200);
  assertEquals(eligible.data.eligible, true);
  noProtected(eligible.data);
  const requestId = crypto.randomUUID();
  const startBody = {
    examKey: "ai-901",
    profileId: "ai901-controlled-beta-compact",
    clientRequestId: requestId,
  };
  const started = await call("/attempts", "POST", startBody);
  assertEquals(started.response.status, 201);
  noProtected(started.data);
  const attemptId = started.data.attempt.attemptId,
    itemId = started.data.items[0].itemId,
    assignmentId = started.data.attempt.assignmentId;
  assert(typeof assignmentId === "string" && assignmentId.length > 0);
  const current = await call(`/attempts/current?examKey=ai-901&profileId=ai901-controlled-beta-compact&purpose=assigned_assessment&language=not_applicable&assignmentId=${encodeURIComponent(assignmentId)}`);
  assertEquals(current.response.status, 200, JSON.stringify({ code: current.data?.code ?? current.data?.error ?? "unknown" }));
  assertEquals(current.data.attempt.attemptId, attemptId);
  noProtected(current.data);
  const replay = await call("/attempts", "POST", startBody);
  assert([200, 201].includes(replay.response.status));
  assertEquals(replay.data.attempt.attemptId, attemptId);
  noProtected(replay.data);
  const resumed = await call(`/attempts/${attemptId}`);
  assertEquals(resumed.response.status, 200);
  noProtected(resumed.data);
  const saved = await call(
    `/attempts/${attemptId}/items/${itemId}/response`,
    "PUT",
    {
      response: { answer: "a" },
      expectedRevision: 0,
      requestId: crypto.randomUUID(),
    },
  );
  assertEquals(saved.response.status, 200);
  const stale = await call(
    `/attempts/${attemptId}/items/${itemId}/response`,
    "PUT",
    {
      response: { answer: "b" },
      expectedRevision: 0,
      requestId: crypto.randomUUID(),
    },
  );
  assertEquals(stale.response.status, 409);
  assertEquals(stale.data.error.code, "stale_response");
  const submissionId = crypto.randomUUID();
  const submitted = await call(`/attempts/${attemptId}/submit`, "POST", {
    submissionId,
  });
  assertEquals(submitted.response.status, 200);
  noProtected(submitted.data);
  const submitReplay = await call(`/attempts/${attemptId}/submit`, "POST", {
    submissionId,
  });
  assertEquals(submitReplay.response.status, 200);
  noProtected(submitReplay.data);
  const result = await call(`/attempts/${attemptId}/result`);
  assertEquals(result.response.status, 200);
  noProtected(result.data);
  const review = await call(`/attempts/${attemptId}/review`);
  assertEquals(review.response.status, 403);
  assertEquals(review.data.error.code, "review_unavailable");
  const second = await call("/attempts", "POST", {
    ...startBody,
    clientRequestId: crypto.randomUUID(),
  });
  assert(second.response.status >= 400);
  const direct = await fetch(
    base.replace("/functions/v1/certsim-protected-exam", "") +
      "/rest/v1/rpc/certsim_protected_get_result",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_actor_id: actorId,
        p_attempt_id: attemptId,
      }),
    },
  );
  assert(direct.status >= 400);
});
