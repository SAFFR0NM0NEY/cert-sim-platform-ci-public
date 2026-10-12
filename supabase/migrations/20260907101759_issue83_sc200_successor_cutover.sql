-- Issue #83: atomic, audited SC-200 1.0.0 -> 1.1.0 successor release.
-- This boundary is intentionally pinned to one reviewed package transition.

create table exam_delivery.sc200_successor_cutover_requests (
  request_id uuid primary key,
  actor_id uuid not null references auth.users(id) on delete restrict,
  canonical_exam_key text not null,
  predecessor_package_version_id uuid not null references exam_delivery.package_versions(id) on delete restrict,
  successor_package_version_id uuid not null references exam_delivery.package_versions(id) on delete restrict,
  full_package_profile_id uuid not null references exam_delivery.package_profiles(id) on delete restrict,
  compact_package_profile_id uuid not null references exam_delivery.package_profiles(id) on delete restrict,
  status text not null,
  cutover_at timestamptz not null default statement_timestamp(),
  constraint sc200_successor_cutover_exam_check check(canonical_exam_key='sc200'),
  constraint sc200_successor_cutover_status_check check(status='succeeded'),
  constraint sc200_successor_cutover_distinct_packages_check
    check(predecessor_package_version_id<>successor_package_version_id),
  constraint sc200_successor_cutover_distinct_profiles_check
    check(full_package_profile_id<>compact_package_profile_id)
);

alter table exam_delivery.sc200_successor_cutover_requests enable row level security;
revoke all on table exam_delivery.sc200_successor_cutover_requests
  from public,anon,authenticated,service_role;

create function exam_delivery.cutover_sc200_successor_release(
  p_actor_id uuid,p_request jsonb
) returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='10s' as $$
declare
  v_request_id uuid;
  v_predecessor record;
  v_successor record;
  v_full record;
  v_compact record;
  v_existing exam_delivery.sc200_successor_cutover_requests%rowtype;
  v_now timestamptz:=statement_timestamp();
  v_purposes constant exam_delivery.attempt_purpose[]:=array[
    'assigned_assessment','self_directed_exam','study_sandbox',
    'targeted_domain','weak_area','pbq_practice'
  ]::exam_delivery.attempt_purpose[];
begin
  if p_actor_id is null or jsonb_typeof(p_request)<>'object'
    or not exam_delivery.json_has_exact_keys(p_request,array[
      'examKey','predecessorPackageVersion','successorPackageVersion',
      'fullProfileKey','compactProfileKey','requestId'
    ])
  then raise exception 'sc200_successor_cutover_invalid_request' using errcode='22023'; end if;
  begin v_request_id:=(p_request->>'requestId')::uuid;
  exception when others then
    raise exception 'sc200_successor_cutover_invalid_request' using errcode='22023';
  end;
  if p_request->>'examKey'<>'sc200'
    or p_request->>'predecessorPackageVersion'<>'1.0.0'
    or p_request->>'successorPackageVersion'<>'1.1.0'
    or p_request->>'fullProfileKey'<>'sc200-full'
    or p_request->>'compactProfileKey'<>'sc200-compact'
  then raise exception 'sc200_successor_cutover_unsupported' using errcode='22023'; end if;

  select * into v_existing from exam_delivery.sc200_successor_cutover_requests
    where request_id=v_request_id for update;
  if found then
    select pv.id package_version_id into strict v_predecessor
      from exam_delivery.package_versions pv
      where exam_delivery.normalize_exam_key(pv.exam_key)='sc200' and pv.package_version='1.0.0';
    select pv.id package_version_id into strict v_successor
      from exam_delivery.package_versions pv
      where exam_delivery.normalize_exam_key(pv.exam_key)='sc200' and pv.package_version='1.1.0';
    select pp.id package_profile_id into strict v_full from exam_delivery.package_profiles pp
      where pp.package_version_id=v_successor.package_version_id and pp.profile_key='sc200-full';
    select pp.id package_profile_id into strict v_compact from exam_delivery.package_profiles pp
      where pp.package_version_id=v_successor.package_version_id and pp.profile_key='sc200-compact';
    if row(v_existing.actor_id,v_existing.canonical_exam_key,
      v_existing.predecessor_package_version_id,v_existing.successor_package_version_id,
      v_existing.full_package_profile_id,v_existing.compact_package_profile_id,v_existing.status)
      is distinct from row(p_actor_id,'sc200',v_predecessor.package_version_id,
        v_successor.package_version_id,v_full.package_profile_id,v_compact.package_profile_id,'succeeded')
    then raise exception 'sc200_successor_cutover_request_conflict' using errcode='23505'; end if;
    if (select count(*) from exam_delivery.exam_profile_activations a
        where a.package_version_id=v_successor.package_version_id and a.package_profile_id in
          (v_full.package_profile_id,v_compact.package_profile_id) and a.activation_kind='production' and a.enabled)<>2
      or exists(select 1 from exam_delivery.exam_profile_activations a
        where a.package_version_id=v_predecessor.package_version_id and a.activation_kind='production' and a.enabled)
      or (select count(*) from exam_delivery.practice_policies p
        where p.canonical_exam_key='sc200' and p.package_version='1.1.0'
          and p.profile_key in ('sc200-full','sc200-compact') and p.enabled and p.access_mode='production_authorized')<>10
      or exists(select 1 from exam_delivery.practice_policies p
        where p.canonical_exam_key='sc200' and p.package_version='1.0.0' and p.profile_key='sc200-full' and p.enabled)
      or (select count(*) from exam_delivery.package_profile_defaults d
        where d.canonical_exam_key='sc200' and d.enabled and d.package_version_id=v_successor.package_version_id
          and ((d.profile_key='sc200-full' and d.package_profile_id=v_full.package_profile_id)
            or (d.profile_key='sc200-compact' and d.package_profile_id=v_compact.package_profile_id)))<>12
      or exists(select 1 from exam_delivery.package_profile_defaults d
        where d.canonical_exam_key='sc200' and d.enabled and d.package_version_id<>v_successor.package_version_id)
      or not exists(select 1 from public.exam_catalog c
        where exam_delivery.normalize_exam_key(c.exam_key)='sc200' and c.current_version='1.1.0'
          and c.status='active' and c.lifecycle='production_ready')
    then raise exception 'sc200_successor_cutover_replay_conflict' using errcode='23505'; end if;
    return jsonb_build_object('ok',true,'cutover',false,'replayed',true,
      'examKey','sc200','predecessorPackageVersion','1.0.0','successorPackageVersion','1.1.0',
      'fullProfileKey','sc200-full','compactProfileKey','sc200-compact');
  end if;

  select pv.id package_version_id,pv.package_hash,pv.status into strict v_predecessor
    from exam_delivery.package_versions pv
    where exam_delivery.normalize_exam_key(pv.exam_key)='sc200' and pv.package_version='1.0.0'
      and pv.status='published'
      and pv.package_hash='305085dea2431a978941c3d13b3dfddc9cd3a1706d16ee2869157094fb20782d'
    for share;
  select pv.id package_version_id,pv.package_hash,pv.status,pv.package_schema_version,
      pv.generator_version,pv.scorer_version,pv.declared_review_release_policy,
      pv.declared_answer_release_policy into strict v_successor
    from exam_delivery.package_versions pv
    where exam_delivery.normalize_exam_key(pv.exam_key)='sc200' and pv.package_version='1.1.0'
      and pv.status='published'
      and pv.package_hash='2a2cd94e7d2dc491bea3e414263e61819f92ae5de77e634e3bbd9c2288d9abdb'
    for share;
  if v_successor.package_schema_version<>'certsim-protected-package-v2'
    or not exam_delivery.package_v2_runtime_supported(v_successor.generator_version,v_successor.scorer_version)
    or v_successor.declared_review_release_policy<>'after_submission'
    or v_successor.declared_answer_release_policy<>'after_submission'
  then raise exception 'sc200_successor_cutover_candidate_invalid' using errcode='22023'; end if;
  select pp.id package_profile_id,pp.question_count,pp.time_limit_minutes into strict v_full
    from exam_delivery.package_profiles pp where pp.package_version_id=v_successor.package_version_id
      and pp.profile_key='sc200-full' and pp.question_count=50 and pp.time_limit_minutes=100 for share;
  select pp.id package_profile_id,pp.question_count,pp.time_limit_minutes into strict v_compact
    from exam_delivery.package_profiles pp where pp.package_version_id=v_successor.package_version_id
      and pp.profile_key='sc200-compact' and pp.question_count=25 and pp.time_limit_minutes=50 for share;

  if (select count(*) from exam_delivery.package_questions q where q.package_version_id=v_successor.package_version_id)<>300
    or (select count(*) from exam_delivery.package_question_protected_content pc where pc.package_version_id=v_successor.package_version_id)<>300
    or exists(select 1 from exam_delivery.package_questions q left join exam_delivery.package_question_protected_content pc
      on pc.question_id=q.id and pc.package_version_id=q.package_version_id
      where q.package_version_id=v_successor.package_version_id and pc.question_id is null)
    or exists(select 1 from exam_delivery.package_question_protected_content pc left join exam_delivery.package_questions q
      on q.id=pc.question_id and q.package_version_id=pc.package_version_id
      where pc.package_version_id=v_successor.package_version_id and q.id is null)
    or (select count(*) from exam_delivery.package_forms f where f.package_version_id=v_successor.package_version_id
      and f.package_profile_id=v_full.package_profile_id and f.question_count=50)<>6
    or (select count(*) from exam_delivery.package_forms f where f.package_version_id=v_successor.package_version_id
      and f.package_profile_id=v_compact.package_profile_id and f.question_count=25)<>6
    or (select count(*) from exam_delivery.package_form_questions fq where fq.package_version_id=v_successor.package_version_id
      and fq.package_profile_id=v_full.package_profile_id)<>300
    or (select count(*) from exam_delivery.package_form_questions fq where fq.package_version_id=v_successor.package_version_id
      and fq.package_profile_id=v_compact.package_profile_id)<>150
    or exists(select 1 from exam_delivery.package_forms f where f.package_version_id=v_successor.package_version_id
      and f.package_profile_id in (v_full.package_profile_id,v_compact.package_profile_id)
      and (select count(*) from exam_delivery.package_form_questions fq where fq.form_id=f.id)<>f.question_count)
  then raise exception 'sc200_successor_cutover_structure_invalid' using errcode='22023'; end if;
  if not exists(select 1 from exam_delivery.exam_release_candidates c where c.canonical_exam_key='sc200'
      and c.package_version='1.1.0' and c.profile_key='sc200-full' and c.release_template='standard_active_exam_v1')
    or not exists(select 1 from exam_delivery.exam_release_candidates c where c.canonical_exam_key='sc200'
      and c.package_version='1.1.0' and c.profile_key='sc200-compact' and c.release_template='standard_active_exam_v1')
  then raise exception 'sc200_successor_cutover_candidate_invalid' using errcode='22023'; end if;

  perform 1 from exam_delivery.exam_profile_activations a
    where a.package_version_id in (v_predecessor.package_version_id,v_successor.package_version_id)
      and a.activation_kind='production' for update;
  perform 1 from exam_delivery.practice_policies p where p.canonical_exam_key='sc200'
    and p.package_version in ('1.0.0','1.1.0') for update;
  perform 1 from exam_delivery.package_profile_defaults d where d.canonical_exam_key='sc200' for update;
  perform 1 from public.exam_catalog c where exam_delivery.normalize_exam_key(c.exam_key)='sc200' for update;

  if exists(select 1 from exam_delivery.attempts a
      where a.package_version_id in (v_predecessor.package_version_id,v_successor.package_version_id)
        and (a.status='submitted' or (a.status='in_progress' and a.expires_at>v_now)))
  then raise exception 'sc200_successor_cutover_active_attempt' using errcode='55000'; end if;
  if (select count(*) from exam_delivery.exam_profile_activations a
      where a.package_version_id=v_predecessor.package_version_id and a.activation_kind='production'
        and a.enabled and a.package_profile_id=(select id from exam_delivery.package_profiles
          where package_version_id=v_predecessor.package_version_id and profile_key='sc200-full'))<>1
    or (select count(*) from exam_delivery.practice_policies p where p.canonical_exam_key='sc200'
      and p.package_version='1.0.0' and p.profile_key='sc200-full' and p.purpose=any(v_purposes[2:6])
      and p.enabled and p.access_mode='production_authorized' and p.maximum_completed_attempts is null
      and p.cooldown_seconds=0 and p.maximum_concurrent_sessions=1 and p.maximum_session_items=50
      and ((p.purpose='study_sandbox' and p.immediate_feedback
          and p.review_release_policy='immediate_study_feedback' and p.answer_release_policy='immediate_study_feedback')
        or (p.purpose<>'study_sandbox' and not p.immediate_feedback
          and p.review_release_policy='after_submission' and p.answer_release_policy='after_submission')))<>5
    or (select count(*) from exam_delivery.practice_policies p where p.canonical_exam_key='sc200'
      and p.package_version='1.0.0' and p.profile_key='sc200-full')<>5
    or (select count(*) from exam_delivery.package_profile_defaults d where d.canonical_exam_key='sc200'
      and d.profile_key='sc200-full' and d.purpose=any(v_purposes) and d.enabled
      and d.package_version_id=v_predecessor.package_version_id)<>6
    or exists(select 1 from exam_delivery.exam_profile_activations a where a.package_version_id=v_successor.package_version_id
      and a.activation_kind='production' and a.enabled)
    or exists(select 1 from exam_delivery.practice_policies p where p.canonical_exam_key='sc200'
      and p.package_version='1.1.0' and p.enabled)
    or not exists(select 1 from public.exam_catalog c where exam_delivery.normalize_exam_key(c.exam_key)='sc200'
      and c.current_version='1.0.0' and c.status='active' and c.lifecycle='production_ready')
  then raise exception 'sc200_successor_cutover_state_conflict' using errcode='55000'; end if;

  insert into exam_delivery.exam_profile_activations(
    package_version_id,package_profile_id,enabled,activation_kind,enabled_at,disabled_at,created_by
  ) values
    (v_successor.package_version_id,v_full.package_profile_id,true,'production',v_now,null,p_actor_id),
    (v_successor.package_version_id,v_compact.package_profile_id,true,'production',v_now,null,p_actor_id)
  on conflict(package_version_id,package_profile_id,activation_kind) do update set
    enabled=true,enabled_at=coalesce(exam_delivery.exam_profile_activations.enabled_at,v_now),
    disabled_at=null,updated_at=v_now;

  insert into exam_delivery.practice_policies(canonical_exam_key,package_version,profile_key,purpose,
    access_mode,enabled,maximum_completed_attempts,cooldown_seconds,maximum_concurrent_sessions,
    maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy)
  select 'sc200','1.1.0',profile.profile_key,purpose.value::exam_delivery.attempt_purpose,
    'production_authorized',true,null,0,1,
    case when profile.profile_key='sc200-full' then 50 else 25 end,
    purpose.value='study_sandbox',
    case when purpose.value='study_sandbox' then 'immediate_study_feedback' else 'after_submission' end,
    case when purpose.value='study_sandbox' then 'immediate_study_feedback' else 'after_submission' end
  from (values('sc200-full'),('sc200-compact')) profile(profile_key)
  cross join unnest(v_purposes[2:6]) purpose(value)
  on conflict(canonical_exam_key,package_version,profile_key,purpose) do update set
    access_mode=excluded.access_mode,enabled=true,maximum_completed_attempts=null,cooldown_seconds=0,
    maximum_concurrent_sessions=1,maximum_session_items=excluded.maximum_session_items,
    immediate_feedback=excluded.immediate_feedback,review_release_policy=excluded.review_release_policy,
    answer_release_policy=excluded.answer_release_policy,updated_at=v_now;

  insert into exam_delivery.package_profile_defaults(canonical_exam_key,profile_key,purpose,
    package_version_id,package_profile_id,enabled,configured_by)
  select 'sc200',profile.profile_key,purpose.value,v_successor.package_version_id,
    case when profile.profile_key='sc200-full' then v_full.package_profile_id else v_compact.package_profile_id end,
    true,p_actor_id
  from (values('sc200-full'),('sc200-compact')) profile(profile_key)
  cross join unnest(v_purposes) purpose(value)
  on conflict(canonical_exam_key,profile_key,purpose) do update set
    package_version_id=excluded.package_version_id,package_profile_id=excluded.package_profile_id,
    enabled=true,configured_at=v_now,configured_by=excluded.configured_by;

  update public.exam_catalog c set current_version='1.1.0',status='active',lifecycle='production_ready',updated_at=v_now
    where exam_delivery.normalize_exam_key(c.exam_key)='sc200';
  if not found then raise exception 'sc200_successor_cutover_state_conflict' using errcode='55000'; end if;
  update exam_delivery.exam_profile_activations a set enabled=false,disabled_at=v_now,updated_at=v_now
    where a.package_version_id=v_predecessor.package_version_id and a.activation_kind='production' and a.enabled;
  update exam_delivery.practice_policies p set enabled=false,access_mode='disabled',updated_at=v_now
    where p.canonical_exam_key='sc200' and p.package_version='1.0.0' and p.profile_key='sc200-full'
      and p.purpose=any(v_purposes[2:6]);

  if (select count(*) from exam_delivery.exam_profile_activations a where a.package_version_id=v_successor.package_version_id
      and a.package_profile_id in (v_full.package_profile_id,v_compact.package_profile_id)
      and a.activation_kind='production' and a.enabled)<>2
    or exists(select 1 from exam_delivery.exam_profile_activations a
      where a.package_version_id=v_predecessor.package_version_id and a.activation_kind='production' and a.enabled)
    or (select count(*) from exam_delivery.practice_policies p where p.canonical_exam_key='sc200'
      and p.package_version='1.1.0' and p.profile_key in ('sc200-full','sc200-compact')
      and p.enabled and p.access_mode='production_authorized')<>10
    or (select count(*) from exam_delivery.practice_policies p where p.canonical_exam_key='sc200'
      and p.package_version='1.0.0' and p.profile_key='sc200-full' and not p.enabled and p.access_mode='disabled')<>5
    or (select count(*) from exam_delivery.package_profile_defaults d where d.canonical_exam_key='sc200'
      and d.enabled and d.package_version_id=v_successor.package_version_id
      and ((d.profile_key='sc200-full' and d.package_profile_id=v_full.package_profile_id)
        or (d.profile_key='sc200-compact' and d.package_profile_id=v_compact.package_profile_id)))<>12
    or exists(select 1 from exam_delivery.package_profile_defaults d where d.canonical_exam_key='sc200'
      and d.enabled and d.package_version_id<>v_successor.package_version_id)
  then raise exception 'sc200_successor_cutover_postcondition_failed' using errcode='55000'; end if;

  insert into exam_delivery.sc200_successor_cutover_requests(request_id,actor_id,canonical_exam_key,
    predecessor_package_version_id,successor_package_version_id,full_package_profile_id,
    compact_package_profile_id,status,cutover_at)
  values(v_request_id,p_actor_id,'sc200',v_predecessor.package_version_id,v_successor.package_version_id,
    v_full.package_profile_id,v_compact.package_profile_id,'succeeded',v_now);
  return jsonb_build_object('ok',true,'cutover',true,'replayed',false,'examKey','sc200',
    'predecessorPackageVersion','1.0.0','successorPackageVersion','1.1.0',
    'fullProfileKey','sc200-full','compactProfileKey','sc200-compact');
exception when no_data_found or too_many_rows then
  raise exception 'sc200_successor_cutover_candidate_invalid' using errcode='22023';
end $$;

create function public.certsim_cutover_sc200_successor_release(p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare v_actor uuid:=auth.uid();
begin
  if v_actor is null or not exists(select 1 from public.profiles p where p.id=v_actor and p.status='active')
    or not exists(select 1 from public.memberships m where m.user_id=v_actor
      and m.status='active' and m.role='platform_owner')
  then raise exception 'sc200_successor_cutover_forbidden' using errcode='42501'; end if;
  return exam_delivery.cutover_sc200_successor_release(v_actor,p_request);
end $$;

alter function exam_delivery.cutover_sc200_successor_release(uuid,jsonb) owner to postgres;
alter function public.certsim_cutover_sc200_successor_release(jsonb) owner to postgres;
revoke execute on function exam_delivery.cutover_sc200_successor_release(uuid,jsonb),
  public.certsim_cutover_sc200_successor_release(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.certsim_cutover_sc200_successor_release(jsonb) to authenticated;

comment on table exam_delivery.sc200_successor_cutover_requests is
  'Private idempotency and audit boundary for the pinned SC-200 1.0.0 to 1.1.0 production cutover.';
comment on function public.certsim_cutover_sc200_successor_release(jsonb) is
  'Checked Platform Owner boundary for the atomic, pinned SC-200 successor cutover.';
