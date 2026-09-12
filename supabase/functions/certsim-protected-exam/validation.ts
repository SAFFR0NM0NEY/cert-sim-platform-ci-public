import { SafeError } from "./errors.ts";

export const MAX_BODY_BYTES = 64 * 1024;
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
export async function readJsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  if (
    !(request.headers.get("content-type") ?? "").toLowerCase().startsWith(
      "application/json",
    )
  ) throw new SafeError("unsupported_media_type");
  const declared = request.headers.get("content-length");
  if (
    declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)
  ) throw new SafeError("payload_too_large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) {
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
