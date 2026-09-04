-- Identity-derived operator boundary for the single approved AI-901
-- interruption. The internal attempt identifier never crosses the API.

create function exam_delivery.authorize_unique_ai901_technical_recovery(
  p_reason_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_actor uuid := auth.uid();
  v_attempt_id uuid;
begin
  if v_actor is null then
    raise exception 'technical_recovery_auth_required' using errcode='42501';
  end if;
  if p_reason_code <> 'operator_harness_response_serialization_failure' then
    raise exception 'technical_recovery_invalid_request' using errcode='22023';
  end if;
  if not exists (
    select 1 from public.memberships m
     where m.user_id=v_actor and m.role='platform_owner' and m.status='active'
  ) then
    raise exception 'technical_recovery_forbidden' using errcode='42501';
  end if;

  select a.id into strict v_attempt_id
    from exam_delivery.attempts a
    join exam_delivery.protected_assignments pa on pa.id=a.protected_assignment_id
    join exam_delivery.package_versions pv on pv.id=a.package_version_id
    join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
   where pv.exam_key='ai901' and pv.package_version='1.0.0'
     and pp.profile_key='ai901-controlled-beta-compact'
     and a.status='in_progress'
     and (select count(*) from exam_delivery.attempt_items i where i.attempt_id=a.id)=25
     and (select count(*) from exam_delivery.attempt_item_protected_content i where i.attempt_id=a.id)=25
     and not exists(select 1 from exam_delivery.attempt_responses r where r.attempt_id=a.id)
     and not exists(select 1 from exam_delivery.attempt_results r where r.attempt_id=a.id)
     and not exists(select 1 from exam_delivery.review_snapshots r where r.attempt_id=a.id)
     and not exists(select 1 from exam_delivery.attempt_technical_recoveries r where r.protected_assignment_id=pa.id)
     and exists (
       select 1 from public.memberships owner_membership
        where owner_membership.user_id=v_actor
          and owner_membership.organisation_id=pa.organisation_id
          and owner_membership.role='platform_owner'
          and owner_membership.status='active'
     )
     and exists (
       select 1 from public.memberships m
        where m.user_id=a.owner_id and m.organisation_id=pa.organisation_id
          and m.role='student' and m.status='active'
     )
   for update of a,pa;

  return exam_delivery.authorize_technical_recovery(v_attempt_id,p_reason_code);
exception
  when no_data_found or too_many_rows then
    raise exception 'technical_recovery_state_invalid' using errcode='55000';
end;
$$;

create function public.certsim_protected_authorize_unique_ai901_recovery(
  p_reason_code text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select exam_delivery.authorize_unique_ai901_technical_recovery(p_reason_code)
$$;

revoke all on function exam_delivery.authorize_unique_ai901_technical_recovery(text)
  from public,anon,authenticated,service_role;
grant execute on function exam_delivery.authorize_unique_ai901_technical_recovery(text)
  to authenticated;
revoke all on function public.certsim_protected_authorize_unique_ai901_recovery(text)
  from public,anon,authenticated,service_role;
grant execute on function public.certsim_protected_authorize_unique_ai901_recovery(text)
  to authenticated;
