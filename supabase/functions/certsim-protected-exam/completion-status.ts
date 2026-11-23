import { SafeError } from "./errors.ts";
import { assertUuid } from "./validation.ts";

type Obj = Record<string, unknown>;
export function isCompletionStatusRoute(id: string): boolean {
  return id === "completionStatus" || id === "pendingCompletions";
}
export function completionStatusArgs(request: Request, actorId: string, attemptId?: string): Obj {
  const url = new URL(request.url);
  if (attemptId) {
    if ([...url.searchParams.keys()].length) throw new SafeError("invalid_request");
    return { p_actor_id: actorId, p_attempt_id: assertUuid(attemptId) };
  }
  const allowed = ["examKey", "profileId", "purpose", "assignmentId", "cursor", "pageSize", "watch"];
  if ([...url.searchParams.keys()].some((key) => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) throw new SafeError("invalid_request");
  const get = (key: string) => url.searchParams.get(key);
  const size = Number(get("pageSize") ?? "20");
  if (!Number.isSafeInteger(size) || size < 1 || size > 20 ||
    (get("examKey") !== null && !/^[a-z0-9][a-z0-9+._-]{1,63}$/i.test(get("examKey")!)) ||
    (get("profileId") !== null && !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(get("profileId")!)) ||
    (get("purpose") !== null && !["assigned_assessment", "self_directed_exam"].includes(get("purpose")!)) ||
    (get("cursor") !== null && (get("cursor")!.length > 160 || !get("cursor")!.includes("|")))) throw new SafeError("invalid_request");
  const watch = get("watch") === null ? [] : get("watch")!.split(",");
  if (watch.length > 20 || new Set(watch).size !== watch.length) throw new SafeError("invalid_request");
  watch.forEach(assertUuid);
  return { p_actor_id: actorId, p_exam_key: get("examKey"), p_profile_key: get("profileId"),
    p_purpose: get("purpose"), p_assignment_id: get("assignmentId") === null ? null : assertUuid(get("assignmentId")),
    p_cursor: get("cursor"), p_page_size: size, p_watch_attempt_ids: watch };
}
const keys = ["contractVersion", "attemptId", "examKey", "packageVersion", "profileKey", "profileName", "purpose", "assignmentId", "deadline", "observedAt", "expiryManaged", "closureReason", "answeringAllowed", "state", "resultAvailable", "completedAt"];
const pending = ["awaiting_processing", "processing", "needs_attention"];
const date = (v: unknown) => typeof v === "string" && v.length <= 64 && Number.isFinite(Date.parse(v));
const obj = (v: unknown): Obj => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new SafeError("internal_failure");
  return v as Obj;
};
export function mapCompletionStatusDto(raw: unknown): Obj {
  const v = obj(raw);
  if (Object.keys(v).length !== keys.length || Object.keys(v).some((k) => !keys.includes(k)) ||
    v.contractVersion !== 1 || typeof v.attemptId !== "string" ||
    ["examKey", "packageVersion", "profileKey", "profileName", "purpose"].some((k) => typeof v[k] !== "string" || !v[k] || String(v[k]).length > 256) ||
    (v.assignmentId !== null && typeof v.assignmentId !== "string") ||
    (v.deadline !== null && !date(v.deadline)) || !date(v.observedAt) ||
    typeof v.expiryManaged !== "boolean" || ![null, "manual_submission", "time_limit_expiry", "closed"].includes(v.closureReason as never) || typeof v.answeringAllowed !== "boolean" ||
    !["active", ...pending, "completed", "closed", "unmanaged"].includes(String(v.state)) ||
    typeof v.resultAvailable !== "boolean" || (v.completedAt !== null && !date(v.completedAt)) ||
    v.resultAvailable !== (v.state === "completed") || v.resultAvailable !== (v.completedAt !== null) ||
    v.answeringAllowed !== (v.state === "active") ||
    (v.expiryManaged && !date(v.deadline))) throw new SafeError("internal_failure");
  assertUuid(v.attemptId);
  if (v.assignmentId !== null) assertUuid(v.assignmentId);
  return Object.fromEntries(keys.map((key) => [key, v[key]]));
}
export function mapCompletionStatus(raw: unknown): Obj {
  const v = obj(raw);
  if (Object.keys(v).some((k) => !["ok", "status"].includes(k))) throw new SafeError("internal_failure");
  return { status: mapCompletionStatusDto(v.status) };
}
export function mapPendingCompletions(raw: unknown): Obj {
  const v = obj(raw), allowed = ["ok", "contractVersion", "observedAt", "items", "watched", "returnedCount", "nextCursor"];
  if (Object.keys(v).some((k) => !allowed.includes(k)) || v.contractVersion !== 1 || !date(v.observedAt) ||
    !Array.isArray(v.items) || v.items.length > 20 || !Array.isArray(v.watched) || v.watched.length > 20 ||
    v.returnedCount !== v.items.length ||
    (v.nextCursor !== null && (typeof v.nextCursor !== "string" || v.nextCursor.length > 160))) throw new SafeError("internal_failure");
  const items = v.items.map(mapCompletionStatusDto), watched = v.watched.map(mapCompletionStatusDto);
  if (items.some((s) => !pending.includes(String(s.state)) || s.observedAt !== v.observedAt) ||
    watched.some((s) => s.observedAt !== v.observedAt)) throw new SafeError("internal_failure");
  return { contractVersion: 1, observedAt: v.observedAt, items, watched, returnedCount: items.length, nextCursor: v.nextCursor };
}
