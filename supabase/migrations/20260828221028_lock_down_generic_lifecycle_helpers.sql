-- Phase F1 forward-only remediation. Private package-v2 helpers are callable
-- only through their already-bounded owner/internal call chains.

revoke execute on function exam_delivery.check_eligibility_v2(uuid, text, text)
  from public, anon, authenticated, service_role;
revoke execute on function exam_delivery.start_attempt_v2(uuid, text, text, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function exam_delivery.submit_attempt_v2(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function exam_delivery.package_v2_response_valid(text, jsonb, jsonb)
  from public, anon, authenticated, service_role;

-- PostgreSQL grants EXECUTE on newly created functions to PUBLIC by default.
-- Restrict only future functions created by the confirmed owning migration role
-- in the private exam_delivery schema; every callable boundary must be granted
-- explicitly by its own migration.
alter default privileges for role postgres in schema exam_delivery
  revoke execute on functions from public;
