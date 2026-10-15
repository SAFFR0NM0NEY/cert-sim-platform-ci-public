-- Issue #20 G3C3R3A: fixed-profile self-directed exams derive their scored
-- size and duration from the immutable published package profile. Flexible
-- practice retains its explicit bounded size choices.

create or replace function exam_delivery.practice_availability(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
declare v_exam text:=exam_delivery.normalize_exam_key(p_request->>'examKey'); v_profile text:=p_request->>'profileId';
  v_purpose text:=p_request->>'purpose'; v_version text; v_policy exam_delivery.practice_policies%rowtype;
  v_available integer:=0; v_pbq integer:=0; v_missed integer:=0; v_new integer:=0; v_domains jsonb:='{}'::jsonb;
  v_requested integer; v_profile_count integer; v_time_limit integer; v_package_id uuid; v_profile_id uuid; v_fixed boolean;
begin
  if p_actor_id is null or v_purpose not in ('self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice')
     or p_request->>'language' not in ('csharp','python','mixed','not_applicable') then
    return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  if not exists(select 1 from public.profiles where id=p_actor_id and status='active') then return jsonb_build_object('ok',false,'code','inactive_account'); end if;
  select pv.package_version,pv.id,pp.id,pp.question_count,pp.time_limit_minutes
    into v_version,v_package_id,v_profile_id,v_profile_count,v_time_limit
  from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=v_exam and pv.status='published' and pp.profile_key=v_profile
  order by pv.published_at desc limit 1;
  if not found then return jsonb_build_object('ok',false,'code','package_unavailable'); end if;
  select * into v_policy from exam_delivery.practice_policies where canonical_exam_key=v_exam and package_version=v_version
    and profile_key=v_profile and purpose=v_purpose::exam_delivery.attempt_purpose;
  if not found or not v_policy.enabled or v_policy.access_mode='disabled' then return jsonb_build_object('ok',false,'code','practice_unavailable'); end if;
  if not exam_delivery.can_use_profile(p_actor_id,v_package_id,v_profile_id,v_purpose::exam_delivery.attempt_purpose) then
    return jsonb_build_object('ok',false,'code','access_not_granted'); end if;
  if v_policy.maximum_completed_attempts is not null and (select count(*) from exam_delivery.attempts a
    where a.owner_id=p_actor_id and a.package_version_id=v_package_id and a.package_profile_id=v_profile_id
      and a.purpose=v_policy.purpose and a.status='completed')>=v_policy.maximum_completed_attempts
  then return jsonb_build_object('ok',false,'code','attempt_limit_reached'); end if;
  if v_policy.cooldown_seconds>0 and exists(select 1 from exam_delivery.attempts a
    where a.owner_id=p_actor_id and a.package_version_id=v_package_id and a.package_profile_id=v_profile_id
      and a.purpose=v_policy.purpose and a.completed_at>statement_timestamp()-make_interval(secs=>v_policy.cooldown_seconds))
  then return jsonb_build_object('ok',false,'code','cooldown_active'); end if;
  select count(*)::integer,count(*) filter(where q.question_type like 'pbq-%')::integer into v_available,v_pbq
  from exam_delivery.package_questions q where q.package_version_id=v_package_id;
  select coalesce(jsonb_object_agg(domain_key,total),'{}'::jsonb) into v_domains from (
    select q.domain_key,count(*)::integer total from exam_delivery.package_questions q
    where q.package_version_id=v_package_id group by q.domain_key
  ) d;
  if v_purpose='targeted_domain' and (nullif(p_request->>'domain','') is null or not (v_domains ? (p_request->>'domain'))) then
    return jsonb_build_object('ok',false,'code','unknown_domain'); end if;
  select count(distinct item->>'questionId')::integer into v_missed
  from exam_delivery.attempts a join exam_delivery.review_snapshots rs on rs.attempt_id=a.id
  cross join lateral jsonb_array_elements(coalesce(rs.review_payload->'items','[]'::jsonb)) item
  where a.owner_id=p_actor_id and a.package_version_id=v_package_id and a.status='completed' and a.analytics_eligible is true
    and item->>'status' in ('Incorrect','Incomplete','Partial');
  select count(*)::integer into v_new from exam_delivery.package_questions q where q.package_version_id=v_package_id and not exists(
    select 1 from exam_delivery.attempt_items i join exam_delivery.attempts a on a.id=i.attempt_id
    where a.owner_id=p_actor_id and i.package_question_id=q.id);
  v_fixed:=v_purpose='self_directed_exam';
  if v_fixed then
    if (p_request ? 'count' and p_request->>'count'<>v_profile_count::text)
      or v_profile_count>v_available or v_profile_count>v_policy.maximum_session_items then
      return jsonb_build_object('ok',false,'code','invalid_request'); end if;
    v_requested:=v_profile_count;
  else
    if not (p_request ? 'count') or p_request->>'count' not in ('10','20','30','40','all') then
      return jsonb_build_object('ok',false,'code','invalid_request'); end if;
    v_requested:=case when p_request->>'count'='all' then least(v_available,v_policy.maximum_session_items) else (p_request->>'count')::integer end;
  end if;
  return jsonb_build_object('ok',true,'examKey',v_exam,'packageVersion',v_version,'profileKey',v_profile,'purpose',v_purpose,
    'available',v_available,'selectedCount',case when v_fixed then v_requested else least(v_requested,v_available,v_policy.maximum_session_items) end,
    'adjustedCount',case when v_fixed then false else v_requested>least(v_available,v_policy.maximum_session_items) end,
    'profileQuestionCount',v_profile_count,'timeLimitMinutes',v_time_limit,'fixedProfileSize',v_fixed,'domainCounts',v_domains,
    'missedCount',v_missed,'newCount',v_new,'pbqCount',v_pbq,
    'languages',case when v_exam='az204' and v_version='1.1.0' then '["csharp","python","mixed"]'::jsonb else '["not_applicable"]'::jsonb end);
end $$;

alter function exam_delivery.practice_availability(uuid,jsonb) owner to postgres;
revoke execute on function exam_delivery.practice_availability(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function exam_delivery.practice_availability(uuid,jsonb) to service_role;
