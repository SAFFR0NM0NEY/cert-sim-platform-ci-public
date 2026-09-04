export type StableCode =
  | "unauthenticated"
  | "inactive_account"
  | "not_allowlisted"
  | "pilot_disabled"
  | "not_assigned"
  | "no_published_package"
  | "attempt_not_found"
  | "attempt_expired"
  | "attempt_conflict"
  | "attempt_limit_reached"
  | "practice_unavailable"
  | "weak_domain_unavailable"
  | "scope_required"
  | "assignment_conflict"
  | "replacement_not_permitted"
  | "replacement_failed"
  | "invalid_lifecycle_transition"
  | "stale_response"
  | "already_submitted"
  | "review_unavailable"
  | "invalid_request"
  | "payload_too_large"
  | "unsupported_media_type"
  | "method_not_allowed"
  | "origin_not_allowed"
  | "rate_limited"
  | "internal_failure";

const ERROR_STATUS: Record<string, number> = {
  unauthenticated: 401,
  inactive_account: 403,
  inactive_membership: 403,
  not_allowlisted: 403,
  pilot_disabled: 403,
  pilot_unavailable: 403,
  not_assigned: 403,
  no_published_package: 409,
  ambiguous_publication: 409,
  active_attempt_exists: 409,
  attempt_not_found: 404,
  attempt_expired: 409,
  attempt_conflict: 409,
  attempt_limit_reached: 409,
  practice_unavailable: 403,
  weak_domain_unavailable: 409,
  scope_required: 400,
  assignment_conflict: 409,
  replacement_not_permitted: 403,
  replacement_failed: 409,
  response_conflict: 409,
  response_invalid: 400,
  submission_conflict: 409,
  invalid_lifecycle_transition: 409,
  stale_response: 409,
  already_submitted: 409,
  review_unavailable: 403,
  invalid_request: 400,
  payload_too_large: 413,
  unsupported_media_type: 415,
  method_not_allowed: 405,
  origin_not_allowed: 403,
  rate_limited: 429,
  internal_failure: 500,
};

const CODE_ALIASES: Record<string, StableCode> = {
  authentication_required: "unauthenticated",
  exam_disabled: "pilot_disabled",
  package_unavailable: "no_published_package",
  access_not_granted: "not_allowlisted",
  assignment_required: "not_assigned",
  invalid_response: "invalid_request",
  exam_unavailable: "pilot_disabled",
  inactive_membership: "inactive_account",
  pilot_unavailable: "pilot_disabled",
  ambiguous_publication: "no_published_package",
  active_attempt_exists: "attempt_conflict",
  response_conflict: "attempt_conflict",
  response_invalid: "invalid_request",
  submission_conflict: "attempt_conflict",
};

export class SafeError extends Error {
  constructor(
    public code: StableCode,
    public status = ERROR_STATUS[code] ?? 500,
  ) {
    super(code);
  }
}

export function translateRpcFailure(value: unknown): SafeError {
  const raw = typeof value === "object" && value !== null &&
      typeof (value as Record<string, unknown>).code === "string"
    ? (value as Record<string, string>).code
    : "internal_failure";
  const code = CODE_ALIASES[raw] ??
    (raw in ERROR_STATUS ? raw as StableCode : "internal_failure");
  return new SafeError(code, ERROR_STATUS[raw] ?? ERROR_STATUS[code]);
}
