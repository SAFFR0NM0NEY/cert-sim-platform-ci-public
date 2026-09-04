-- Issue #20 G3C3R3B: continuation uses the same profile-access contract as
-- availability/start. This prevents a committed start from being reported as
-- a legacy controlled-beta denial while preserving identity-derived ownership.

create or replace function exam_delivery.authorize_attempt_continuation(
  p_attempt_id uuid,
  p_operation text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v record;
  v_assessment jsonb;
begin
  if p_attempt_id is null
     or p_operation not in ('resume','save_response','check_item','submit') then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end if;

  select a.owner_id,a.status,a.expires_at,a.purpose,a.practice_configuration,
         a.language_preference,a.package_version_id,a.package_profile_id,
         pv.exam_key,pv.package_version,pv.package_schema_version,pp.profile_key,
         p.access_mode,p.enabled
    into v
  from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
  left join exam_delivery.practice_policies p
    on p.canonical_exam_key=exam_delivery.normalize_exam_key(pv.exam_key)
   and p.package_version=pv.package_version
   and p.profile_key=pp.profile_key
   and p.purpose=a.purpose
  where a.id=p_attempt_id;
  if not found then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  if v.status<>'in_progress' or statement_timestamp()>=v.expires_at then
    return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition');
  end if;

  if v.purpose='assigned_assessment' then
    if v.package_schema_version='certsim-protected-package-v2' then
      v_assessment:=exam_delivery.check_assessment_eligibility_v2(v.owner_id,v.exam_key,v.profile_key);
    else
      v_assessment:=exam_delivery.check_eligibility(v.owner_id,v.exam_key,v.profile_key);
    end if;
    if not coalesce((v_assessment->>'eligible')::boolean,false) then
      return jsonb_build_object('ok',false,'code','exam_unavailable');
    end if;
  else
    if not coalesce(v.enabled,false) or v.access_mode='disabled' then
      return jsonb_build_object('ok',false,'code','practice_unavailable');
    end if;
    if not exam_delivery.can_use_profile(
      v.owner_id,
      v.package_version_id,
      v.package_profile_id,
      v.purpose
    ) then
      return jsonb_build_object('ok',false,'code','access_not_granted');
    end if;
  end if;

  return jsonb_build_object(
    'ok',true,
    'ownerId',v.owner_id,
    'examKey',exam_delivery.normalize_exam_key(v.exam_key),
    'profileKey',v.profile_key,
    'purpose',v.purpose,
    'operation',p_operation
  );
end
$$;

alter function exam_delivery.authorize_attempt_continuation(uuid,text) owner to postgres;
revoke execute on function exam_delivery.authorize_attempt_continuation(uuid,text)
  from public,anon,authenticated,service_role;
