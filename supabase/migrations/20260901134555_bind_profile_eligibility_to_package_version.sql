-- Issue #20 G3C3R3D: bind read-only profile eligibility to the exact immutable
-- package version and purpose. The historical three-argument AI-901 v1
-- dispatcher remains unchanged for legacy assessment compatibility.

create function exam_delivery.check_profile_eligibility(
  p_actor_id uuid,
  p_exam_key text,
  p_package_version text,
  p_profile_key text,
  p_purpose exam_delivery.attempt_purpose
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_exam_key text:=exam_delivery.normalize_exam_key(p_exam_key);
  v_package_version_id uuid;
  v_package_profile_id uuid;
  v_package_schema_version text;
  v_profile_name text;
  v_question_count integer;
  v_time_limit_minutes integer;
  v_assessment jsonb;
begin
  if p_actor_id is null or v_exam_key is null
     or nullif(btrim(p_package_version),'') is null
     or nullif(btrim(p_profile_key),'') is null
     or p_purpose is null then
    return jsonb_build_object('eligible',false,'reasonCode','invalid_request');
  end if;
  if not exists(select 1 from public.profiles p where p.id=p_actor_id and p.status='active') then
    return jsonb_build_object('eligible',false,'reasonCode','inactive_account');
  end if;

  select pv.id,pp.id,pv.package_schema_version,pp.display_name,pp.question_count,pp.time_limit_minutes
    into v_package_version_id,v_package_profile_id,v_package_schema_version,v_profile_name,
      v_question_count,v_time_limit_minutes
  from exam_delivery.package_versions pv
  join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=v_exam_key
    and pv.package_version=p_package_version
    and pv.status='published'
    and pp.profile_key=p_profile_key
  limit 1;
  if not found then
    return jsonb_build_object('eligible',false,'reasonCode','package_unavailable',
      'examKey',v_exam_key,'packageVersion',p_package_version,
      'profileKey',p_profile_key,'purpose',p_purpose);
  end if;

  if p_purpose='assigned_assessment' then
    if v_exam_key='ai901' and v_package_schema_version='certsim-protected-package-v1' then
      v_assessment:=exam_delivery.check_eligibility_ai901_v1(p_actor_id,v_exam_key,p_profile_key);
    else
      v_assessment:=exam_delivery.check_assessment_eligibility_v2(p_actor_id,v_exam_key,p_profile_key);
    end if;
    if not coalesce((v_assessment->>'eligible')::boolean,false) then
      return v_assessment || jsonb_build_object('examKey',v_exam_key,
        'packageVersion',p_package_version,'profileKey',p_profile_key,'purpose',p_purpose);
    end if;
    if v_assessment->>'packageVersion' is distinct from p_package_version then
      return jsonb_build_object('eligible',false,'reasonCode','package_unavailable',
        'examKey',v_exam_key,'packageVersion',p_package_version,
        'profileKey',p_profile_key,'purpose',p_purpose);
    end if;
  elsif not exam_delivery.can_use_profile(
    p_actor_id,v_package_version_id,v_package_profile_id,p_purpose
  ) then
    return jsonb_build_object('eligible',false,'reasonCode','access_not_granted',
      'examKey',v_exam_key,'packageVersion',p_package_version,
      'profileKey',p_profile_key,'purpose',p_purpose);
  end if;

  return jsonb_build_object('eligible',true,'reasonCode','eligible',
    'examKey',v_exam_key,'packageVersion',p_package_version,
    'profileKey',p_profile_key,'profileName',v_profile_name,
    'questionCount',v_question_count,
    'timeLimitMinutes',v_time_limit_minutes,'purpose',p_purpose);
end
$$;

create function public.certsim_protected_check_profile_eligibility(
  p_actor_id uuid,
  p_exam_key text,
  p_package_version text,
  p_profile_key text,
  p_purpose exam_delivery.attempt_purpose
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select exam_delivery.check_profile_eligibility(
    p_actor_id,p_exam_key,p_package_version,p_profile_key,p_purpose
  )
$$;

alter function exam_delivery.check_profile_eligibility(uuid,text,text,text,exam_delivery.attempt_purpose) owner to postgres;
alter function public.certsim_protected_check_profile_eligibility(uuid,text,text,text,exam_delivery.attempt_purpose) owner to postgres;

revoke execute on function exam_delivery.check_profile_eligibility(uuid,text,text,text,exam_delivery.attempt_purpose)
  from public,anon,authenticated,service_role;
revoke execute on function public.certsim_protected_check_profile_eligibility(uuid,text,text,text,exam_delivery.attempt_purpose)
  from public,anon,authenticated,service_role;
grant execute on function exam_delivery.check_profile_eligibility(uuid,text,text,text,exam_delivery.attempt_purpose)
  to service_role;
grant execute on function public.certsim_protected_check_profile_eligibility(uuid,text,text,text,exam_delivery.attempt_purpose)
  to service_role;
