import { SafeError } from "./errors.ts";

export const MAX_BODY_BYTES = 64 * 1024;
export const PYTHON_WORKSPACE_BODY_BYTES = 300 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTITY_FIELDS = new Set([
  "actorId",
  "actor_id",
  "userId",
  "user_id",
  "ownerId",
  "owner_id",
  "studentId",
  "student_id",
]);
export const assertUuid = (value: unknown): string => {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new SafeError("invalid_request");
  }
  return value;
};
export function validateObject(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SafeError("invalid_request");
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (
    keys.some((key) => IDENTITY_FIELDS.has(key) || !allowed.includes(key)) ||
    required.some((key) => !(key in object))
  ) throw new SafeError("invalid_request");
  return object;
}

const PYTHON_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.py$/;
const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;

export function validatePythonWorkspacePayload(value: unknown): Record<string, unknown> {
  const workspace = validateObject(value, ["entryPoint", "files"], ["entryPoint", "files"]);
  if (typeof workspace.entryPoint !== "string" ||
    utf8Length(workspace.entryPoint) < 1 || utf8Length(workspace.entryPoint) > 240 ||
    !PYTHON_PATH.test(workspace.entryPoint) || /(^|\/)\.{1,2}(\/|$)/.test(workspace.entryPoint) ||
    !Array.isArray(workspace.files) || workspace.files.length < 1 || workspace.files.length > 16) {
    throw new SafeError("invalid_request");
  }
  const portablePaths = new Set<string>();
  let totalBytes = 0;
  const files = workspace.files.map((entry) => {
    const file = validateObject(entry, ["path", "content"], ["path", "content"]);
    if (typeof file.path !== "string" || typeof file.content !== "string" ||
      utf8Length(file.path) < 1 || utf8Length(file.path) > 240 ||
      !PYTHON_PATH.test(file.path) || /(^|\/)\.{1,2}(\/|$)/.test(file.path) ||
      utf8Length(file.content) > 64 * 1024) throw new SafeError("invalid_request");
    const portablePath = file.path.toLowerCase();
    if (portablePaths.has(portablePath)) throw new SafeError("invalid_request");
    portablePaths.add(portablePath);
    totalBytes += utf8Length(file.content);
    if (totalBytes > 256 * 1024) throw new SafeError("invalid_request");
    return { path: file.path, content: file.content };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (!files.some((file) => file.path === workspace.entryPoint)) {
    throw new SafeError("invalid_request");
  }
  return { entryPoint: workspace.entryPoint, files };
}
export async function readJsonBody(
  request: Request,
  maximumBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  if (
    !(request.headers.get("content-type") ?? "").toLowerCase().startsWith(
      "application/json",
    )
  ) throw new SafeError("unsupported_media_type");
  const declared = request.headers.get("content-length");
  if (
    declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)
  ) throw new SafeError("payload_too_large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new SafeError("payload_too_large");
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SafeError("invalid_request");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SafeError) throw error;
    throw new SafeError("invalid_request");
  }
}
export function validateResponsePayload(value: unknown, depth = 0): void {
  if (depth > 8) throw new SafeError("invalid_request");
  if (Array.isArray(value)) {
    if (value.length > 200) throw new SafeError("invalid_request");
    value.forEach((v) => validateResponsePayload(v, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 100) throw new SafeError("invalid_request");
    entries.forEach(([key, v]) => {
      if (IDENTITY_FIELDS.has(key)) throw new SafeError("invalid_request");
      validateResponsePayload(v, depth + 1);
    });
  }
  if (typeof value === "string" && value.length > 8192) {
    throw new SafeError("invalid_request");
  }
}
