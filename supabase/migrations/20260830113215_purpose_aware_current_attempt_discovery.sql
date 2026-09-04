-- Issue #20 G3B2R3: discover an owned current attempt before authorizing
-- continuation from its immutable purpose. This migration creates no data.

create function exam_delivery.discover_current_attempt(
  p_actor_id uuid,
  p_exam_key text,
  p_package_version text,
  p_profile_key text,
  p_purpose text,
  p_language text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_exam_key text := exam_delivery.normalize_exam_key(p_exam_key);
  v_attempt_ids uuid[];
  v_authorization jsonb;
begin
  if p_actor_id is null
     or v_exam_key is null
     or p_package_version is null
     or p_package_version !~ '^[0-9]+\.[0-9]+\.[0-9]+$'
     or p_profile_key is null
     or p_purpose not in (
       'assigned_assessment','self_directed_exam','study_sandbox',
       'targeted_domain','weak_area','pbq_practice'
     )
     or p_language not in ('csharp','python','mixed','not_applicable') then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end if;

  if v_exam_key='ai901'
     and p_package_version='1.0.0'
     and p_purpose='assigned_assessment'
     and p_language='not_applicable'
     and not exists(
       select 1 from exam_delivery.exam_access_policies
       where canonical_exam_key='ai901'
     ) then
    return exam_delivery.resume_current_attempt_ai901_v1(
      p_actor_id,p_exam_key,p_profile_key
    );
  end if;

  if not exists(
    select 1
    from exam_delivery.package_versions pv
    join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
    where exam_delivery.normalize_exam_key(pv.exam_key)=v_exam_key
      and pv.package_version=p_package_version
      and pv.status='published'
      and pp.profile_key=p_profile_key
  ) then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end if;

  select coalesce(array_agg(candidate.id order by candidate.created_at desc),'{}'::uuid[])
    into v_attempt_ids
  from (
    select a.id,a.created_at
    from exam_delivery.attempts a
    join exam_delivery.package_versions pv on pv.id=a.package_version_id
    join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
    where a.owner_id=p_actor_id
      and exam_delivery.normalize_exam_key(pv.exam_key)=v_exam_key
      and pv.package_version=p_package_version
      and pp.profile_key=p_profile_key
      and a.purpose::text=p_purpose
      and a.language_preference=p_language
      and a.status='in_progress'
      and statement_timestamp()<a.expires_at
    order by a.created_at desc
    limit 2
  ) candidate;

  if cardinality(v_attempt_ids)=0 then
    return jsonb_build_object('ok',false,'code','attempt_not_found');
  end if;
  if cardinality(v_attempt_ids)<>1 then
    return jsonb_build_object('ok',false,'code','attempt_conflict');
  end if;

  v_authorization:=exam_delivery.authorize_attempt_continuation(v_attempt_ids[1],'resume');
  if not coalesce((v_authorization->>'ok')::boolean,false) then
    return v_authorization;
  end if;
  if (v_authorization->>'ownerId')::uuid<>p_actor_id
     or v_authorization->>'examKey'<>v_exam_key
     or v_authorization->>'profileKey'<>p_profile_key
     or v_authorization->>'purpose'<>p_purpose then
    return jsonb_build_object('ok',false,'code','attempt_not_found');
  end if;

  return exam_delivery.resume_attempt(p_actor_id,v_attempt_ids[1]);
end;
$$;

create function public.certsim_protected_discover_current_attempt(
  p_actor_id uuid,
  p_exam_key text,
  p_package_version text,
  p_profile_key text,
  p_purpose text,
  p_language text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
  select exam_delivery.discover_current_attempt(
    p_actor_id,p_exam_key,p_package_version,p_profile_key,p_purpose,p_language
  )
$$;

revoke execute on function exam_delivery.discover_current_attempt(uuid,text,text,text,text,text)
  from public,anon,authenticated,service_role;
revoke execute on function public.certsim_protected_discover_current_attempt(uuid,text,text,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.certsim_protected_discover_current_attempt(uuid,text,text,text,text,text)
  to service_role;
