begin;

-- PostgREST chooses the transaction access mode from pg_proc.provolatile.
-- These resume entry points can reach list_attempt_item_page(), which refreshes
-- the bounded practice inactivity window, so every caller in that chain must be
-- declared VOLATILE. ALTER FUNCTION preserves bodies, owners, security mode,
-- configuration, return types, and existing EXECUTE grants.
alter function public.certsim_protected_resume_attempt(uuid, uuid) volatile;
alter function exam_delivery.resume_current_attempt(uuid, text, text) volatile;
alter function public.certsim_protected_resume_current_attempt(uuid, text, text) volatile;

-- Make the corrected volatility metadata visible to the Data API immediately
-- after commit instead of waiting for PostgREST's next schema-cache refresh.
notify pgrst, 'reload schema';

commit;
