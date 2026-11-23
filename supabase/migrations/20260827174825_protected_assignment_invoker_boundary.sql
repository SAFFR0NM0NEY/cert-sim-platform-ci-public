-- Keep the Data API boundary invoker-only. The privileged operation remains in
-- the non-exposed exam_delivery schema and performs its own auth.uid() and
-- authoritative membership checks.

create or replace function public.certsim_protected_create_assignment(
  p_target_user_id uuid,
  p_organisation_id uuid,
  p_package_version text,
  p_profile_key text,
  p_available_from timestamptz,
  p_expires_at timestamptz,
  p_maximum_attempts integer,
  p_review_release_policy text,
  p_answer_release_policy text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select exam_delivery.create_protected_assignment(
    p_target_user_id,
    p_organisation_id,
    p_package_version,
    p_profile_key,
    p_available_from,
    p_expires_at,
    p_maximum_attempts,
    p_review_release_policy,
    p_answer_release_policy
  )
$$;

revoke execute on function public.certsim_protected_create_assignment(
  uuid,uuid,text,text,timestamptz,timestamptz,integer,text,text
) from public, anon, service_role;

grant execute on function public.certsim_protected_create_assignment(
  uuid,uuid,text,text,timestamptz,timestamptz,integer,text,text
) to authenticated;

grant usage on schema exam_delivery to authenticated;

revoke execute on function exam_delivery.create_protected_assignment(
  uuid,uuid,text,text,timestamptz,timestamptz,integer,text,text
) from public, anon, service_role;

grant execute on function exam_delivery.create_protected_assignment(
  uuid,uuid,text,text,timestamptz,timestamptz,integer,text,text
) to authenticated;

revoke all on exam_delivery.protected_assignments
  from public, anon, authenticated, service_role;
