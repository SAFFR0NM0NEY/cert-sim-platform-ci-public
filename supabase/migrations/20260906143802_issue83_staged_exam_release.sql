-- Issue #83: repair the live-v2 assignment privilege boundary and provide a
-- reviewed, server-owned staged release contract for new protected exams.

create table exam_delivery.exam_release_candidates (
  canonical_exam_key text primary key,
  package_version text not null,
  profile_key text not null,
  release_template text not null,
  catalogue_slug text not null unique,
  catalogue_title text not null,
  catalogue_vendor text,
  catalogue_exam_type text not null,
  catalogue_source_type text not null,
  constraint exam_release_candidates_key_check check (
    canonical_exam_key=exam_delivery.normalize_exam_key(canonical_exam_key)
  ),
  constraint exam_release_candidates_template_check check (
    release_template='standard_active_exam_v1'
  ),
  constraint exam_release_candidates_exam_type_check check (
    catalogue_exam_type in ('certification','placement','custom')
  ),
  constraint exam_release_candidates_source_type_check check (
    catalogue_source_type in ('official_source','custom_database','imported')
  )
);

create table exam_delivery.exam_release_configuration_requests (
  request_id uuid primary key,
  actor_id uuid not null references auth.users(id) on delete restrict,
  canonical_exam_key text not null,
  package_version_id uuid not null,
  package_profile_id uuid not null,
  release_stage text not null,
  configured_at timestamptz not null default statement_timestamp(),
  constraint exam_release_configuration_package_profile_fk
    foreign key(package_version_id,package_profile_id)
    references exam_delivery.package_profiles(package_version_id,id) on delete restrict,
  constraint exam_release_configuration_stage_check check (
    release_stage in ('acceptance','standard_active_exam_v1')
  )
);

alter table exam_delivery.exam_release_candidates enable row level security;
alter table exam_delivery.exam_release_configuration_requests enable row level security;
revoke all on table exam_delivery.exam_release_candidates,
  exam_delivery.exam_release_configuration_requests
  from public,anon,authenticated,service_role;

insert into exam_delivery.exam_release_candidates(
  canonical_exam_key,package_version,profile_key,release_template,
  catalogue_slug,catalogue_title,catalogue_vendor,catalogue_exam_type,catalogue_source_type
) values(
  'sc200','1.0.0','sc200-full','standard_active_exam_v1',
  'sc200','SC-200: Microsoft Security Operations Analyst','Microsoft','certification','official_source'
);

-- The applied v2 migration exposed an invoker wrapper while revoking the
-- authenticated role from its private callee. The wrapper therefore failed at
-- function privilege resolution before its first assignment INSERT. Keep the
-- callee private and elevate only this checked public boundary.
create or replace function public.certsim_create_live_assignment_v2(p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare
  v_actor uuid:=auth.uid();
  v_org uuid;
begin
  begin
    v_org:=(p_request->>'organisationId')::uuid;
  exception when others then
    raise exception 'live_assignment_invalid_request' using errcode='22023';
  end;
  if v_actor is null or not exists(
    select 1 from public.memberships m
    where m.user_id=v_actor and m.organisation_id=v_org
      and m.role='platform_owner' and m.status='active'
  ) then
    raise exception 'live_assignment_forbidden' using errcode='42501';
  end if;
  return exam_delivery.create_live_assignment_v2(p_request);
end $$;

-- A bound live-v2 assignment uses the package/profile default and the modern
-- activation + entitlement authorization path. Legacy assessment policies and
-- protected_assignments remain the fallback for historical assignments.
create or replace function exam_delivery.check_assessment_eligibility_v2(
  p_actor_id uuid,p_exam_key text,p_profile_key text
) returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='10s' as $$
declare
  v_key text:=exam_delivery.normalize_exam_key(p_exam_key);
  v_now timestamptz:=statement_timestamp();
  v_policy exam_delivery.exam_access_policies%rowtype;
  v_package record;
  v_assignment record;
  v_allowed boolean:=false;
  v_count integer:=0;
begin
  if p_actor_id is null or v_key is null or nullif(btrim(p_profile_key),'') is null then
    return jsonb_build_object('eligible',false,'reasonCode','invalid_request');
  end if;
  if not exists(select 1 from public.profiles where id=p_actor_id and status='active') then
    return jsonb_build_object('eligible',false,'reasonCode','inactive_account');
  end if;

  select pv.id package_version_id,pv.package_version,pp.id package_profile_id,
         pp.profile_key,pp.display_name,pp.question_count,pp.time_limit_minutes
    into v_package
  from exam_delivery.resolve_package_profile_default(v_key,p_profile_key,'assigned_assessment') d
  join exam_delivery.package_versions pv on pv.id=d.package_version_id
  join exam_delivery.package_profiles pp on pp.id=d.package_profile_id
  limit 1;
  if found then
    if exam_delivery.can_use_profile(p_actor_id,v_package.package_version_id,
      v_package.package_profile_id,'assigned_assessment') then
      return jsonb_build_object('eligible',true,'reasonCode','eligible','examKey',v_key,
        'packageVersion',v_package.package_version,'profileKey',v_package.profile_key,
        'profileName',v_package.display_name,'questionCount',v_package.question_count,
        'timeLimitMinutes',v_package.time_limit_minutes);
    end if;
    return jsonb_build_object('eligible',false,'reasonCode','access_not_granted');
  end if;

  select * into v_policy from exam_delivery.exam_access_policies where canonical_exam_key=v_key;
  if not found or not v_policy.enabled or v_policy.access_mode='disabled' then
    return jsonb_build_object('eligible',false,'reasonCode','exam_disabled');
  end if;
  select pv.id package_version_id,pv.package_version,pp.id package_profile_id,
         pp.profile_key,pp.display_name,pp.question_count,pp.time_limit_minutes
    into v_package
  from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=v_key and pp.profile_key=p_profile_key
    and pv.package_schema_version='certsim-protected-package-v2'
    and (not v_policy.require_published_package or pv.status='published')
  order by pv.published_at desc nulls last,pv.created_at desc limit 1;
  if not found then return jsonb_build_object('eligible',false,'reasonCode','package_unavailable'); end if;

  if v_policy.access_mode='open_authenticated' then v_allowed:=true;
  elsif v_policy.access_mode='organisation_scoped' then
    v_allowed:=exists(select 1 from public.memberships m
      join public.organisations o on o.id=m.organisation_id and o.status='active'
      join exam_delivery.exam_access_organisations s on s.organisation_id=m.organisation_id
        and s.canonical_exam_key=v_key and s.enabled
      where m.user_id=p_actor_id and m.status='active'
        and (s.access_starts_at is null or s.access_starts_at<=v_now)
        and (s.access_ends_at is null or s.access_ends_at>v_now));
  elsif v_policy.access_mode='controlled_beta' then
    v_allowed:=exists(select 1 from exam_delivery.exam_access_learners l
      where l.canonical_exam_key=v_key and l.learner_id=p_actor_id and l.enabled
        and (l.access_starts_at is null or l.access_starts_at<=v_now)
        and (l.access_ends_at is null or l.access_ends_at>v_now));
  elsif v_policy.access_mode='assignment_required' then v_allowed:=true;
  end if;
  if not v_allowed then return jsonb_build_object('eligible',false,'reasonCode','access_not_granted'); end if;

  if v_policy.require_assignment or v_policy.access_mode='assignment_required' then
    select a.id,a.maximum_attempts into v_assignment
    from exam_delivery.protected_assignments a
    join public.memberships m on m.user_id=a.learner_id and m.organisation_id=a.organisation_id
      and m.role='student' and m.status='active'
    join public.organisations o on o.id=a.organisation_id and o.status='active'
    where a.learner_id=p_actor_id and a.package_version_id=v_package.package_version_id
      and a.package_profile_id=v_package.package_profile_id and a.status='active'
      and a.available_from<=v_now and (a.expires_at is null or a.expires_at>v_now)
    limit 1;
    if not found then return jsonb_build_object('eligible',false,'reasonCode','assignment_required'); end if;
    select count(*)::integer into v_count from exam_delivery.attempts a
    where a.protected_assignment_id=v_assignment.id and a.status<>'voided';
    if v_count>=v_assignment.maximum_attempts and not exists(
      select 1 from exam_delivery.attempts a where a.protected_assignment_id=v_assignment.id
        and a.owner_id=p_actor_id and a.status='in_progress'
    ) then return jsonb_build_object('eligible',false,'reasonCode','attempt_limit_reached'); end if;
  end if;
  return jsonb_build_object('eligible',true,'reasonCode','eligible','examKey',v_key,
    'packageVersion',v_package.package_version,'profileKey',v_package.profile_key,
    'profileName',v_package.display_name,'questionCount',v_package.question_count,
    'timeLimitMinutes',v_package.time_limit_minutes);
end $$;

create function exam_delivery.configure_exam_release_stage(
  p_actor_id uuid,p_request jsonb
) returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='10s' as $$
declare
  v_exam text;
  v_version text;
  v_profile_key text;
  v_stage text;
  v_request_id uuid;
  v_candidate exam_delivery.exam_release_candidates%rowtype;
  v_package record;
  v_existing exam_delivery.exam_release_configuration_requests%rowtype;
begin
  if p_actor_id is null or jsonb_typeof(p_request)<>'object'
    or not exam_delivery.json_has_exact_keys(p_request,
      array['examKey','packageVersion','profileKey','releaseStage','requestId']) then
    raise exception 'exam_release_invalid_request' using errcode='22023';
  end if;
  begin
    v_request_id:=(p_request->>'requestId')::uuid;
  exception when others then
    raise exception 'exam_release_invalid_request' using errcode='22023';
  end;
  v_exam:=exam_delivery.normalize_exam_key(p_request->>'examKey');
  v_version:=p_request->>'packageVersion';
  v_profile_key:=p_request->>'profileKey';
  v_stage:=p_request->>'releaseStage';
  if v_stage not in ('acceptance','standard_active_exam_v1') then
    raise exception 'exam_release_stage_invalid' using errcode='22023';
  end if;

  select * into strict v_candidate from exam_delivery.exam_release_candidates c
  where c.canonical_exam_key=v_exam and c.package_version=v_version
    and c.profile_key=v_profile_key and c.release_template='standard_active_exam_v1';
  select pv.id package_version_id,pp.id package_profile_id,pp.question_count,
    pv.declared_review_release_policy,pv.declared_answer_release_policy
    into strict v_package
  from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=v_exam and pv.package_version=v_version
    and pp.profile_key=v_profile_key and pv.status='published'
    and pv.package_schema_version='certsim-protected-package-v2'
    and exam_delivery.package_v2_runtime_supported(pv.generator_version,pv.scorer_version)
  for share of pv,pp;
  if v_stage='standard_active_exam_v1' and
    (v_package.declared_review_release_policy<>'after_submission'
      or v_package.declared_answer_release_policy<>'after_submission') then
    raise exception 'exam_release_policy_incompatible' using errcode='22023';
  end if;

  select * into v_existing from exam_delivery.exam_release_configuration_requests
  where request_id=v_request_id;
  if found then
    if row(v_existing.actor_id,v_existing.canonical_exam_key,v_existing.package_version_id,
      v_existing.package_profile_id,v_existing.release_stage)
      is distinct from row(p_actor_id,v_exam,v_package.package_version_id,
        v_package.package_profile_id,v_stage) then
      raise exception 'exam_release_request_conflict' using errcode='23505';
    end if;
    return jsonb_build_object('ok',true,'configured',false,'replayed',true,
      'examKey',v_exam,'packageVersion',v_version,'profileKey',v_profile_key,'releaseStage',v_stage);
  end if;

  insert into exam_delivery.exam_profile_activations(
    package_version_id,package_profile_id,enabled,activation_kind,enabled_at,disabled_at,created_by
  ) values(v_package.package_version_id,v_package.package_profile_id,true,'production',
      statement_timestamp(),null,p_actor_id)
  on conflict(package_version_id,package_profile_id,activation_kind) do update set
    enabled=true,enabled_at=coalesce(exam_delivery.exam_profile_activations.enabled_at,statement_timestamp()),
    disabled_at=null,updated_at=statement_timestamp();

  insert into exam_delivery.package_profile_defaults(
    canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,enabled,configured_by
  ) values(v_exam,v_profile_key,'assigned_assessment',v_package.package_version_id,
      v_package.package_profile_id,true,p_actor_id)
  on conflict(canonical_exam_key,profile_key,purpose) do update set
    package_version_id=excluded.package_version_id,package_profile_id=excluded.package_profile_id,
    enabled=true,configured_at=statement_timestamp(),configured_by=excluded.configured_by;

  if v_stage='standard_active_exam_v1' then
    insert into exam_delivery.practice_policies(
      canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
      maximum_completed_attempts,cooldown_seconds,maximum_concurrent_sessions,
      maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy
    )
    select v_exam,v_version,v_profile_key,purpose.value::exam_delivery.attempt_purpose,
      'production_authorized',true,null,0,1,greatest(10,least(100,v_package.question_count)),
      purpose.value='study_sandbox',
      case when purpose.value='study_sandbox' then 'immediate_study_feedback' else 'after_submission' end,
      case when purpose.value='study_sandbox' then 'immediate_study_feedback' else 'after_submission' end
    from unnest(array['self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice']) purpose(value)
    on conflict(canonical_exam_key,package_version,profile_key,purpose) do update set
      access_mode='production_authorized',enabled=true,maximum_completed_attempts=null,
      cooldown_seconds=0,maximum_concurrent_sessions=1,
      maximum_session_items=excluded.maximum_session_items,
      immediate_feedback=excluded.immediate_feedback,
      review_release_policy=excluded.review_release_policy,
      answer_release_policy=excluded.answer_release_policy,updated_at=statement_timestamp();

    insert into exam_delivery.package_profile_defaults(
      canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,enabled,configured_by
    )
    select v_exam,v_profile_key,purpose.value::exam_delivery.attempt_purpose,
      v_package.package_version_id,v_package.package_profile_id,true,p_actor_id
    from unnest(array['self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice']) purpose(value)
    on conflict(canonical_exam_key,profile_key,purpose) do update set
      package_version_id=excluded.package_version_id,package_profile_id=excluded.package_profile_id,
      enabled=true,configured_at=statement_timestamp(),configured_by=excluded.configured_by;

    insert into public.exam_catalog(
      exam_key,slug,title,vendor,lifecycle,exam_type,source_type,current_version,status,metadata
    ) values(v_exam,v_candidate.catalogue_slug,v_candidate.catalogue_title,v_candidate.catalogue_vendor,
      'production_ready',v_candidate.catalogue_exam_type,v_candidate.catalogue_source_type,
      v_version,'active','{}'::jsonb)
    on conflict(exam_key) do update set
      slug=excluded.slug,title=excluded.title,vendor=excluded.vendor,lifecycle='production_ready',
      exam_type=excluded.exam_type,source_type=excluded.source_type,
      current_version=excluded.current_version,status='active',updated_at=statement_timestamp();
  end if;

  insert into exam_delivery.exam_release_configuration_requests(
    request_id,actor_id,canonical_exam_key,package_version_id,package_profile_id,release_stage
  ) values(v_request_id,p_actor_id,v_exam,v_package.package_version_id,v_package.package_profile_id,v_stage);
  return jsonb_build_object('ok',true,'configured',true,'replayed',false,
    'examKey',v_exam,'packageVersion',v_version,'profileKey',v_profile_key,'releaseStage',v_stage);
exception when no_data_found or too_many_rows then
  raise exception 'exam_release_candidate_invalid' using errcode='22023';
end $$;

create function public.certsim_configure_exam_release_stage(p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare
  v_actor uuid:=auth.uid();
begin
  if v_actor is null or not exists(
    select 1 from public.profiles p join public.memberships m on m.user_id=p.id
    where p.id=v_actor and p.status='active' and m.status='active' and m.role='platform_owner'
  ) then
    raise exception 'exam_release_forbidden' using errcode='42501';
  end if;
  return exam_delivery.configure_exam_release_stage(v_actor,p_request);
end $$;

alter function public.certsim_create_live_assignment_v2(jsonb) owner to postgres;
alter function exam_delivery.check_assessment_eligibility_v2(uuid,text,text) owner to postgres;
alter function exam_delivery.configure_exam_release_stage(uuid,jsonb) owner to postgres;
alter function public.certsim_configure_exam_release_stage(jsonb) owner to postgres;

revoke execute on function public.certsim_create_live_assignment_v2(jsonb),
  exam_delivery.check_assessment_eligibility_v2(uuid,text,text),
  exam_delivery.configure_exam_release_stage(uuid,jsonb),
  public.certsim_configure_exam_release_stage(jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.certsim_create_live_assignment_v2(jsonb),
  public.certsim_configure_exam_release_stage(jsonb) to authenticated;
grant execute on function exam_delivery.check_assessment_eligibility_v2(uuid,text,text) to service_role;
