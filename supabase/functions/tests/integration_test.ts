import { assert, assertEquals } from "jsr:@std/assert@1.0.14";
const base = Deno.env.get("CERTSIM_EDGE_URL")!,
  token = Deno.env.get("CERTSIM_USER_JWT")!,
  anon = Deno.env.get("CERTSIM_ANON_KEY")!,
  db = Deno.env.get("CERTSIM_DB_URL")!,
  actorId = Deno.env.get("CERTSIM_ACTOR_ID")!;
const pythonAttemptId = "15000000-0000-4000-8000-000000000086";
const pythonItemId = "15000000-0000-4000-8000-000000000088";
const outsiderAttemptId = "15000000-0000-4000-8000-000000000091";
const outsiderItemId = "15000000-0000-4000-8000-000000000093";
const allowedOrigin = "http://localhost:5173";
const disallowedOrigin = "http://127.0.0.1:5174";
const allowedErrorCodes = new Set([
  "attempt_not_found",
  "executor_disabled",
  "invalid_request",
  "origin_not_allowed",
  "review_unavailable",
  "revision_conflict",
  "stale_response",
  "unauthenticated",
]);
const headers = {
  authorization: `Bearer ${token}`,
  apikey: anon,
  "content-type": "application/json",
  origin: allowedOrigin,
};
type HttpResult = {
  response: Response;
  data: Awaited<ReturnType<Response["json"]>>;
};
async function call(
  path: string,
  method = "GET",
  body?: unknown,
  origin = allowedOrigin,
): Promise<HttpResult> {
  const response = await fetch(base + path, {
    method,
    headers: { ...headers, origin },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await safeJson(response);
  return { response, data };
}
async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
function errorCode(data: unknown): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "UNKNOWN_ERROR_CODE";
  }
  const value = data as { code?: unknown; error?: { code?: unknown } };
  const code = typeof value.error?.code === "string"
    ? value.error.code
    : typeof value.code === "string"
    ? value.code
    : "";
  return allowedErrorCodes.has(code) ? code : "UNKNOWN_ERROR_CODE";
}
function assertStatus(label: string, result: HttpResult, expected: number) {
  if (result.response.status !== expected) {
    throw new Error(
      `HTTP_CASE_${label}_STATUS_${result.response.status}_CODE_${
        errorCode(result.data)
      }`,
    );
  }
}
function assertErrorCode(label: string, result: HttpResult, expected: string) {
  const actual = errorCode(result.data);
  if (actual !== expected) {
    throw new Error(
      `HTTP_CASE_${label}_STATUS_${result.response.status}_CODE_${actual}`,
    );
  }
}
function assertOutcome(label: string, value: boolean) {
  if (!value) throw new Error(`HTTP_CASE_${label}_OUTCOME_FALSE`);
}
function noProtected(value: unknown) {
  const text = JSON.stringify(value).toLowerCase();
  for (
    const key of [
      "correctanswer",
      "explanation",
      "remediation",
      "scoring",
      "grading",
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

async function scalar(statement: string) {
  const command = new Deno.Command("psql", {
    args: [db, "-v", "ON_ERROR_STOP=1", "-qAt", "-c", statement],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  if (!result.success) throw new Error("disposable SQL query failed");
  return new TextDecoder().decode(result.stdout).trim();
}

Deno.test("disposable origin and authentication boundary", async () => {
  const preflightResponse = await fetch(base + "/eligibility", {
    method: "OPTIONS",
    headers: {
      origin: allowedOrigin,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization, apikey, content-type",
    },
  });
  const preflight = {
    response: preflightResponse,
    data: await safeJson(preflightResponse),
  };
  assertStatus("ALLOWED_ORIGIN_PREFLIGHT", preflight, 200);
  assertOutcome(
    "ALLOWED_ORIGIN_PREFLIGHT_CORS",
    preflight.response.headers.get("access-control-allow-origin") === "*",
  );

  const unauthResponse = await fetch(
    base +
      "/eligibility?examKey=ai-901&packageVersion=1.0.0&profileId=ai901-controlled-beta-compact&purpose=assigned_assessment",
    { headers: { apikey: anon, origin: allowedOrigin } },
  );
  const unauth = {
    response: unauthResponse,
    data: await safeJson(unauthResponse),
  };
  assertStatus("ALLOWED_ORIGIN_UNAUTHENTICATED", unauth, 401);
  assertErrorCode("ALLOWED_ORIGIN_UNAUTHENTICATED", unauth, "unauthenticated");

  const eligible = await call(
    "/eligibility?examKey=ai-901&packageVersion=1.0.0&profileId=ai901-controlled-beta-compact&purpose=assigned_assessment",
  );
  assertStatus("ALLOWED_ORIGIN_AUTHENTICATED", eligible, 200);
  assertOutcome(
    "ALLOWED_ORIGIN_AUTHENTICATED_ELIGIBLE",
    Boolean((eligible.data as { eligible?: unknown } | null)?.eligible),
  );

  const deniedOrigin = await call(
    "/eligibility?examKey=ai-901&packageVersion=1.0.0&profileId=ai901-controlled-beta-compact&purpose=assigned_assessment",
    "GET",
    undefined,
    disallowedOrigin,
  );
  assertStatus("DISALLOWED_ORIGIN_AUTHENTICATED", deniedOrigin, 403);
  assertErrorCode(
    "DISALLOWED_ORIGIN_AUTHENTICATED",
    deniedOrigin,
    "origin_not_allowed",
  );
});

Deno.test("Issue 86 disposable authenticated workspace and disabled-run HTTP lifecycle", async () => {
  const empty = await call(
    `/attempts/${pythonAttemptId}/items/${pythonItemId}/python/workspace`,
  );
  assertStatus("WORKSPACE_EMPTY", empty, 200);
  assertEquals(empty.data, {
    itemId: pythonItemId,
    exists: false,
    revision: 0,
    workspaceHash: null,
    workspace: null,
    updatedAt: null,
  });
  noProtected(empty.data);

  const requestId = crypto.randomUUID();
  const saveBody = {
    workspace: {
      entryPoint: "main.py",
      files: [
        { path: "util.py", content: "VALUE = 42\n" },
        { path: "main.py", content: "print(42)\n" },
      ],
    },
    expectedRevision: 0,
    requestId,
  };
  const saved = await call(
    `/attempts/${pythonAttemptId}/items/${pythonItemId}/python/workspace`,
    "PUT",
    saveBody,
  );
  assertStatus("WORKSPACE_SAVE", saved, 200);
  assertEquals(saved.data.itemId, pythonItemId);
  assertEquals(saved.data.revision, 1);
  assert(/^[0-9a-f]{64}$/.test(saved.data.workspaceHash));
  noProtected(saved.data);

  const replay = await call(
    `/attempts/${pythonAttemptId}/items/${pythonItemId}/python/workspace`,
    "PUT",
    saveBody,
  );
  assertStatus("WORKSPACE_SAVE_REPLAY", replay, 200);
  assertEquals(replay.data, saved.data);

  const loaded = await call(
    `/attempts/${pythonAttemptId}/items/${pythonItemId}/python/workspace`,
  );
  assertStatus("WORKSPACE_LOAD", loaded, 200);
  assertEquals(loaded.data.revision, 1);
  assertEquals(
    loaded.data.workspace.files.map((file: { path: string }) => file.path),
    ["main.py", "util.py"],
  );
  noProtected(loaded.data);

  const stale = await call(
    `/attempts/${pythonAttemptId}/items/${pythonItemId}/python/workspace`,
    "PUT",
    { ...saveBody, requestId: crypto.randomUUID() },
  );
  assertStatus("WORKSPACE_STALE_SAVE", stale, 409);
  assertErrorCode("WORKSPACE_STALE_SAVE", stale, "revision_conflict");

  const invalid = await call(
    `/attempts/${pythonAttemptId}/items/${pythonItemId}/python/workspace`,
    "PUT",
    {
      workspace: {
        entryPoint: "../main.py",
        files: [{ path: "../main.py", content: "print(1)" }],
      },
      expectedRevision: 1,
      requestId: crypto.randomUUID(),
    },
  );
  assertStatus("WORKSPACE_INVALID_SAVE", invalid, 400);
  assertErrorCode("WORKSPACE_INVALID_SAVE", invalid, "invalid_request");

  const denied = await call(
    `/attempts/${outsiderAttemptId}/items/${outsiderItemId}/python/workspace`,
  );
  assertStatus("WORKSPACE_CROSS_USER", denied, 404);
  assertErrorCode("WORKSPACE_CROSS_USER", denied, "attempt_not_found");

  const run = await call(
    `/attempts/${pythonAttemptId}/items/${pythonItemId}/python/runs`,
    "POST",
    { expectedRevision: 1, requestId: crypto.randomUUID() },
  );
  assertStatus("PYTHON_RUN_DISABLED", run, 503);
  assertErrorCode("PYTHON_RUN_DISABLED", run, "executor_disabled");
  noProtected(run.data);
  assertEquals(
    await scalar(
      `select count(*) from exam_delivery.python_execution_runs where attempt_id='${pythonAttemptId}'`,
    ),
    "0",
  );
});

Deno.test("disposable authenticated HTTP lifecycle", async () => {
  let unauth: HttpResult | undefined;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await fetch(
      base +
        "/eligibility?examKey=ai-901&packageVersion=1.0.0&profileId=ai901-controlled-beta-compact&purpose=assigned_assessment",
      {
        headers: { apikey: anon, origin: "http://localhost:5173" },
      },
    );
    unauth = { response, data: await safeJson(response) };
    if (response.status !== 502) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(unauth);
  assertStatus("LIFECYCLE_UNAUTHENTICATED", unauth, 401);
  assertErrorCode("LIFECYCLE_UNAUTHENTICATED", unauth, "unauthenticated");
  const eligible = await call(
    "/eligibility?examKey=ai-901&packageVersion=1.0.0&profileId=ai901-controlled-beta-compact&purpose=assigned_assessment",
  );
  assertStatus("LIFECYCLE_ELIGIBILITY", eligible, 200);
  assertEquals(eligible.data.eligible, true);
  noProtected(eligible.data);
  const requestId = crypto.randomUUID();
  const startBody = {
    examKey: "ai-901",
    profileId: "ai901-controlled-beta-compact",
    clientRequestId: requestId,
  };
  const started = await call("/attempts", "POST", startBody);
  assertStatus("LIFECYCLE_START", started, 201);
  noProtected(started.data);
  const attemptId = started.data.attempt.attemptId,
    itemId = started.data.items[0].itemId;
  assertEquals(started.data.attempt.assignmentId ?? null, null);
  const current = await call(
    "/attempts/current?examKey=ai-901&profileId=ai901-controlled-beta-compact&purpose=assigned_assessment&language=not_applicable",
  );
  assertStatus("LIFECYCLE_CURRENT", current, 200);
  assertEquals(current.data.attempt.attemptId, attemptId);
  noProtected(current.data);
  const replay = await call("/attempts", "POST", startBody);
  assert([200, 201].includes(replay.response.status));
  assertEquals(replay.data.attempt.attemptId, attemptId);
  noProtected(replay.data);
  const resumed = await call(`/attempts/${attemptId}`);
  assertStatus("LIFECYCLE_RESUME", resumed, 200);
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
  assertStatus("LIFECYCLE_SAVE", saved, 200);
  const stale = await call(
    `/attempts/${attemptId}/items/${itemId}/response`,
    "PUT",
    {
      response: { answer: "b" },
      expectedRevision: 0,
      requestId: crypto.randomUUID(),
    },
  );
  assertStatus("LIFECYCLE_STALE_SAVE", stale, 409);
  assertErrorCode("LIFECYCLE_STALE_SAVE", stale, "stale_response");
  const submissionId = crypto.randomUUID();
  const submitted = await call(`/attempts/${attemptId}/submit`, "POST", {
    submissionId,
  });
  assertStatus("LIFECYCLE_SUBMIT", submitted, 200);
  noProtected(submitted.data);
  const submitReplay = await call(`/attempts/${attemptId}/submit`, "POST", {
    submissionId,
  });
  assertStatus("LIFECYCLE_SUBMIT_REPLAY", submitReplay, 200);
  noProtected(submitReplay.data);
  const result = await call(`/attempts/${attemptId}/result`);
  assertStatus("LIFECYCLE_RESULT", result, 200);
  noProtected(result.data);
  const review = await call(`/attempts/${attemptId}/review`);
  assertStatus("LIFECYCLE_REVIEW_WITHHELD", review, 403);
  assertErrorCode("LIFECYCLE_REVIEW_WITHHELD", review, "review_unavailable");
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
