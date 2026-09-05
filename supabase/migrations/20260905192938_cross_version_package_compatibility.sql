create table exam_delivery.package_profile_defaults (
  canonical_exam_key text not null,
  profile_key text not null,
  purpose exam_delivery.attempt_purpose not null,
  package_version_id uuid not null,
  package_profile_id uuid not null,
  enabled boolean not null default true,
  configured_at timestamptz not null default statement_timestamp(),
  configured_by uuid,
  primary key (canonical_exam_key,profile_key,purpose),
  constraint package_profile_defaults_package_profile_fk foreign key(package_version_id,package_profile_id)
    references exam_delivery.package_profiles(package_version_id,id) on delete restrict,
  constraint package_profile_defaults_exam_key_check check(canonical_exam_key=exam_delivery.normalize_exam_key(canonical_exam_key))
);
create index package_profile_defaults_package_idx on exam_delivery.package_profile_defaults(package_version_id,package_profile_id);
alter table exam_delivery.package_profile_defaults enable row level security;

create table exam_delivery.package_domain_compatibility (
  source_package_version_id uuid not null references exam_delivery.package_versions(id) on delete restrict,
  target_package_version_id uuid not null references exam_delivery.package_versions(id) on delete restrict,
  source_domain_key text not null,
  target_domain_key text not null,
  enabled boolean not null default true,
  configured_at timestamptz not null default statement_timestamp(),
  configured_by uuid,
  primary key(source_package_version_id,target_package_version_id,source_domain_key),
  constraint package_domain_compatibility_keys_check check(
    btrim(source_domain_key)<>'' and source_domain_key=btrim(source_domain_key)
    and btrim(target_domain_key)<>'' and target_domain_key=btrim(target_domain_key))
);
create index package_domain_compatibility_target_idx on exam_delivery.package_domain_compatibility(target_package_version_id,target_domain_key) where enabled;
alter table exam_delivery.package_domain_compatibility enable row level security;

create function exam_delivery.guard_package_compatibility_binding()
returns trigger language plpgsql security definer set search_path='' set statement_timeout='3s' as $$
declare v_source_exam text; v_target_exam text; v_profile_key text;
begin
  if tg_table_name='package_profile_defaults' then
    select exam_delivery.normalize_exam_key(pv.exam_key),pp.profile_key into strict v_target_exam,v_profile_key
    from exam_delivery.package_versions pv join exam_delivery.package_profiles pp
      on pp.package_version_id=pv.id
    where pv.id=new.package_version_id and pp.id=new.package_profile_id;
    if v_target_exam<>new.canonical_exam_key or v_profile_key<>new.profile_key then
      raise exception 'package_default_binding_invalid' using errcode='23514'; end if;
  else
    select exam_delivery.normalize_exam_key(exam_key) into strict v_source_exam
      from exam_delivery.package_versions where id=new.source_package_version_id;
    select exam_delivery.normalize_exam_key(exam_key) into strict v_target_exam
      from exam_delivery.package_versions where id=new.target_package_version_id;
    if v_source_exam<>v_target_exam or new.source_package_version_id=new.target_package_version_id then
      raise exception 'package_domain_compatibility_invalid' using errcode='23514'; end if;
  end if;
  return new;
end $$;
create trigger guard_package_profile_default before insert or update on exam_delivery.package_profile_defaults
for each row execute function exam_delivery.guard_package_compatibility_binding();
create trigger guard_package_domain_compatibility before insert or update on exam_delivery.package_domain_compatibility
for each row execute function exam_delivery.guard_package_compatibility_binding();

revoke all on table exam_delivery.package_profile_defaults,exam_delivery.package_domain_compatibility
  from public,anon,authenticated,service_role;

-- Explicitly preserve the four currently deployed version choices. This is a
-- declared moving-baseline transition, never an ordering-based inference.
insert into exam_delivery.package_profile_defaults(
  canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,configured_by
)
select declared.exam_key,pp.profile_key,purpose.purpose,pv.id,pp.id,
  (select m.user_id from public.memberships m where m.status='active' and m.role='platform_owner' order by m.created_at limit 1)
from (values ('ai901','2.0.0'),('az204','1.1.0'),('az400','1.0.0'),('securityplussy0701','1.0.0')) declared(exam_key,package_version)
join exam_delivery.package_versions pv on exam_delivery.normalize_exam_key(pv.exam_key)=declared.exam_key
  and pv.package_version=declared.package_version and pv.status='published'
join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
join exam_delivery.exam_profile_activations activation on activation.package_version_id=pv.id
  and activation.package_profile_id=pp.id and activation.enabled and activation.activation_kind='production'
cross join lateral (
  select policy.purpose from exam_delivery.practice_policies policy
  where policy.canonical_exam_key=declared.exam_key and policy.package_version=declared.package_version
    and policy.profile_key=pp.profile_key and policy.enabled
  union select 'assigned_assessment'::exam_delivery.attempt_purpose
) purpose;

create function exam_delivery.resolve_package_profile_default(
  p_exam_key text,p_profile_key text,p_purpose exam_delivery.attempt_purpose
) returns table(package_version_id uuid,package_profile_id uuid,package_version text)
language sql stable security definer set search_path='' set statement_timeout='3s' as $$
  select d.package_version_id,d.package_profile_id,pv.package_version
  from exam_delivery.package_profile_defaults d
  join exam_delivery.package_versions pv on pv.id=d.package_version_id
  join exam_delivery.package_profiles pp on pp.id=d.package_profile_id and pp.package_version_id=d.package_version_id
  where d.canonical_exam_key=exam_delivery.normalize_exam_key(p_exam_key)
    and d.profile_key=p_profile_key and d.purpose=p_purpose and d.enabled
    and pv.status='published' and pp.profile_key=d.profile_key
    and exists(select 1 from exam_delivery.exam_profile_activations a
      where a.package_version_id=d.package_version_id and a.package_profile_id=d.package_profile_id
        and a.enabled and a.activation_kind='production')
$$;

create function exam_delivery.configure_package_successor(
  p_actor_id uuid,p_exam_key text,p_source_version text,p_target_version text,p_defaults jsonb,p_domain_mappings jsonb
) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare v_actor uuid:=p_actor_id; v_exam text:=exam_delivery.normalize_exam_key(p_exam_key);
  v_source uuid; v_target uuid; v_default jsonb; v_mapping jsonb; v_count integer:=0;
begin
  if not public.is_platform_owner(v_actor) or p_source_version=p_target_version
    or jsonb_typeof(p_defaults)<>'array' or jsonb_array_length(p_defaults)=0
    or jsonb_typeof(p_domain_mappings)<>'array' then
    raise exception 'successor_configuration_not_authorized' using errcode='42501'; end if;
  select id into strict v_source from exam_delivery.package_versions
    where exam_delivery.normalize_exam_key(exam_key)=v_exam and package_version=p_source_version and status='published' for share;
  select id into strict v_target from exam_delivery.package_versions
    where exam_delivery.normalize_exam_key(exam_key)=v_exam and package_version=p_target_version and status='published' for share;
  for v_default in select value from jsonb_array_elements(p_defaults) loop
    if not exam_delivery.json_has_exact_keys(v_default,array['profileKey','purpose'])
      or v_default->>'purpose' not in ('assigned_assessment','self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice') then
      raise exception 'successor_default_invalid' using errcode='22023'; end if;
    insert into exam_delivery.package_profile_defaults(canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,configured_by)
    select v_exam,v_default->>'profileKey',(v_default->>'purpose')::exam_delivery.attempt_purpose,v_target,pp.id,v_actor
    from exam_delivery.package_profiles pp where pp.package_version_id=v_target and pp.profile_key=v_default->>'profileKey'
    on conflict(canonical_exam_key,profile_key,purpose) do update set
      package_version_id=excluded.package_version_id,package_profile_id=excluded.package_profile_id,enabled=true,
      configured_at=statement_timestamp(),configured_by=v_actor;
    if not found then raise exception 'successor_profile_invalid' using errcode='22023'; end if;
    v_count:=v_count+1;
  end loop;
  for v_mapping in select value from jsonb_array_elements(p_domain_mappings) loop
    if not exam_delivery.json_has_exact_keys(v_mapping,array['sourceDomainKey','targetDomainKey']) then
      raise exception 'successor_domain_mapping_invalid' using errcode='22023'; end if;
    if not exists(select 1 from exam_delivery.package_questions where package_version_id=v_source and domain_key=v_mapping->>'sourceDomainKey')
      or not exists(select 1 from exam_delivery.package_questions where package_version_id=v_target and domain_key=v_mapping->>'targetDomainKey') then
      raise exception 'successor_domain_mapping_invalid' using errcode='22023'; end if;
    if exists(select 1 from exam_delivery.package_domain_compatibility c
      where c.source_package_version_id=v_source and c.target_package_version_id=v_target
        and c.source_domain_key=v_mapping->>'sourceDomainKey'
        and c.target_domain_key<>v_mapping->>'targetDomainKey') then
      raise exception 'successor_domain_mapping_conflict' using errcode='23505'; end if;
    insert into exam_delivery.package_domain_compatibility(source_package_version_id,target_package_version_id,source_domain_key,target_domain_key,configured_by)
    values(v_source,v_target,v_mapping->>'sourceDomainKey',v_mapping->>'targetDomainKey',v_actor)
    on conflict(source_package_version_id,target_package_version_id,source_domain_key) do update set
      target_domain_key=excluded.target_domain_key,enabled=true,configured_at=statement_timestamp(),configured_by=v_actor;
  end loop;
  return jsonb_build_object('ok',true,'examKey',v_exam,'sourceVersion',p_source_version,'targetVersion',p_target_version,'defaultCount',v_count,'mappingCount',jsonb_array_length(p_domain_mappings));
exception when no_data_found or too_many_rows then raise exception 'successor_package_invalid' using errcode='22023';
end $$;

create function exam_delivery.discover_current_formal_attempt(
  p_actor_id uuid,p_exam_key text,p_profile_key text,p_purpose exam_delivery.attempt_purpose,p_language text,p_assignment_id uuid default null
) returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='5s' as $$
declare v_id uuid; v_count integer;
begin
  if p_actor_id is null or p_purpose not in ('assigned_assessment','self_directed_exam') then
    return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  select count(*),min(a.id) into v_count,v_id from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
  where a.owner_id=p_actor_id and exam_delivery.normalize_exam_key(pv.exam_key)=exam_delivery.normalize_exam_key(p_exam_key)
    and pp.profile_key=p_profile_key and a.purpose=p_purpose and a.status='in_progress'
    and a.expires_at>statement_timestamp() and a.language_preference=p_language
    and ((p_assignment_id is null and p_purpose='self_directed_exam' and a.source_assignment_id is null and a.protected_assignment_id is null
          and a.attribution_source is distinct from 'assignment')
      or (p_assignment_id is not null and p_purpose='assigned_assessment' and a.source_assignment_id=p_assignment_id
          and a.attribution_source='assignment'));
  if v_count<>1 then return jsonb_build_object('ok',false,'code',case when v_count=0 then 'attempt_not_found' else 'attempt_conflict' end); end if;
  return exam_delivery.resume_attempt(p_actor_id,v_id);
end $$;

create function public.certsim_protected_discover_current_formal_attempt(
  p_actor_id uuid,p_exam_key text,p_profile_key text,p_purpose text,p_language text,p_assignment_id uuid default null
) returns jsonb language sql stable security invoker set search_path='' as $$
  select exam_delivery.discover_current_formal_attempt(p_actor_id,p_exam_key,p_profile_key,p_purpose::exam_delivery.attempt_purpose,p_language,p_assignment_id)
$$;

create function exam_delivery.create_protected_assignment_current(
  p_target_user_id uuid,p_organisation_id uuid,p_exam_key text,p_profile_key text,
  p_available_from timestamptz,p_expires_at timestamptz,p_maximum_attempts integer,
  p_review_release_policy text,p_answer_release_policy text
) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' as $$
declare v_default record;
begin
  select * into strict v_default from exam_delivery.resolve_package_profile_default(
    p_exam_key,p_profile_key,'assigned_assessment'::exam_delivery.attempt_purpose
  );
  return exam_delivery.create_protected_assignment_v2(
    p_target_user_id,p_organisation_id,p_exam_key,v_default.package_version,p_profile_key,
    p_available_from,p_expires_at,p_maximum_attempts,p_review_release_policy,p_answer_release_policy
  );
exception when no_data_found or too_many_rows then
  raise exception 'assignment_default_not_found' using errcode='22023';
end $$;
create function public.certsim_protected_create_assignment_current(
  p_target_user_id uuid,p_organisation_id uuid,p_exam_key text,p_profile_key text,
  p_available_from timestamptz,p_expires_at timestamptz,p_maximum_attempts integer,
  p_review_release_policy text,p_answer_release_policy text
) returns jsonb language sql security invoker set search_path='' as $$
  select exam_delivery.create_protected_assignment_current(
    p_target_user_id,p_organisation_id,p_exam_key,p_profile_key,p_available_from,p_expires_at,
    p_maximum_attempts,p_review_release_policy,p_answer_release_policy)
$$;

alter function exam_delivery.resolve_package_profile_default(text,text,exam_delivery.attempt_purpose) owner to postgres;
alter function exam_delivery.guard_package_compatibility_binding() owner to postgres;
alter function exam_delivery.configure_package_successor(uuid,text,text,text,jsonb,jsonb) owner to postgres;
alter function exam_delivery.discover_current_formal_attempt(uuid,text,text,exam_delivery.attempt_purpose,text,uuid) owner to postgres;
alter function public.certsim_protected_discover_current_formal_attempt(uuid,text,text,text,text,uuid) owner to postgres;
alter function exam_delivery.create_protected_assignment_current(uuid,uuid,text,text,timestamptz,timestamptz,integer,text,text) owner to postgres;
alter function public.certsim_protected_create_assignment_current(uuid,uuid,text,text,timestamptz,timestamptz,integer,text,text) owner to postgres;
revoke execute on function exam_delivery.resolve_package_profile_default(text,text,exam_delivery.attempt_purpose),
  exam_delivery.guard_package_compatibility_binding(),
  exam_delivery.configure_package_successor(uuid,text,text,text,jsonb,jsonb),
  exam_delivery.discover_current_formal_attempt(uuid,text,text,exam_delivery.attempt_purpose,text,uuid),
  public.certsim_protected_discover_current_formal_attempt(uuid,text,text,text,text,uuid)
  ,exam_delivery.create_protected_assignment_current(uuid,uuid,text,text,timestamptz,timestamptz,integer,text,text)
  ,public.certsim_protected_create_assignment_current(uuid,uuid,text,text,timestamptz,timestamptz,integer,text,text)
  from public,anon,authenticated,service_role;
grant execute on function exam_delivery.resolve_package_profile_default(text,text,exam_delivery.attempt_purpose),
  exam_delivery.discover_current_formal_attempt(uuid,text,text,exam_delivery.attempt_purpose,text,uuid),
  public.certsim_protected_discover_current_formal_attempt(uuid,text,text,text,text,uuid)
  to service_role;
grant execute on function exam_delivery.configure_package_successor(uuid,text,text,text,jsonb,jsonb) to service_role;
grant execute on function exam_delivery.create_protected_assignment_current(uuid,uuid,text,text,timestamptz,timestamptz,integer,text,text),
  public.certsim_protected_create_assignment_current(uuid,uuid,text,text,timestamptz,timestamptz,integer,text,text) to authenticated;

-- Stored protected assignments remain pinned to their immutable package/profile.
create or replace function exam_delivery.start_attempt_v2(
  p_actor_id uuid,p_exam_key text,p_profile_key text,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare v_key text:=exam_delivery.normalize_exam_key(p_exam_key); v_now timestamptz:=statement_timestamp();
  v_existing exam_delivery.attempts%rowtype; v_binding record; v_attempt exam_delivery.attempts%rowtype; v_count integer;
begin
  if p_actor_id is null or p_request_id is null then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select * into v_existing from exam_delivery.attempts where owner_id=p_actor_id and client_request_id=p_request_id;
  if found then
    if v_existing.purpose='assigned_assessment' and exists(select 1 from exam_delivery.package_versions pv
      join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
      where pv.id=v_existing.package_version_id and pp.id=v_existing.package_profile_id
        and exam_delivery.normalize_exam_key(pv.exam_key)=v_key and pp.profile_key=p_profile_key)
    then return exam_delivery.resume_attempt(p_actor_id,v_existing.id); end if;
    return jsonb_build_object('ok',false,'code','attempt_conflict');
  end if;
  select count(*) into v_count from exam_delivery.protected_assignments a
    join exam_delivery.package_versions pv on pv.id=a.package_version_id
    join exam_delivery.package_profiles pp on pp.id=a.package_profile_id and pp.package_version_id=pv.id
    where a.learner_id=p_actor_id and a.status='active' and a.available_from<=v_now
      and (a.expires_at is null or a.expires_at>v_now)
      and exam_delivery.normalize_exam_key(pv.exam_key)=v_key and pp.profile_key=p_profile_key and pv.status='published';
  if v_count<>1 then return jsonb_build_object('ok',false,'code',case when v_count=0 then 'assignment_required' else 'assignment_conflict' end); end if;
  select a.id assignment_id,pv.id package_version_id,pv.generator_version,pv.scorer_version,
    pp.id package_profile_id,pp.time_limit_minutes into strict v_binding
  from exam_delivery.protected_assignments a join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id and pp.package_version_id=pv.id
  where a.learner_id=p_actor_id and a.status='active' and a.available_from<=v_now
    and (a.expires_at is null or a.expires_at>v_now)
    and exam_delivery.normalize_exam_key(pv.exam_key)=v_key and pp.profile_key=p_profile_key and pv.status='published'
  for update of a;
  insert into exam_delivery.attempts(owner_id,package_version_id,package_profile_id,protected_assignment_id,
    client_request_id,status,generator_version,scorer_version,created_at,started_at,expires_at,purpose)
  values(p_actor_id,v_binding.package_version_id,v_binding.package_profile_id,v_binding.assignment_id,p_request_id,
    'in_progress',v_binding.generator_version,v_binding.scorer_version,v_now,v_now,
    v_now+make_interval(mins=>v_binding.time_limit_minutes),'assigned_assessment') returning * into v_attempt;
  perform exam_delivery.materialize_attempt_items(v_attempt.id,p_request_id,null);
  return exam_delivery.resume_attempt(p_actor_id,v_attempt.id);
exception when no_data_found or too_many_rows then return jsonb_build_object('ok',false,'code','assignment_conflict');
when unique_violation then return jsonb_build_object('ok',false,'code','attempt_conflict');
end $$;

-- Preserve the established availability implementation while replacing its
-- implicit newest-publication choice with the explicit default binding.
do $$ declare v_definition text; v_updated text;
begin
  v_definition:=pg_get_functiondef('exam_delivery.practice_availability(uuid,jsonb)'::regprocedure);
  v_updated:=replace(v_definition,
    'from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=v_exam and pv.status=''published'' and pp.profile_key=v_profile
  order by pv.published_at desc limit 1;',
    'from exam_delivery.resolve_package_profile_default(v_exam,v_profile,v_purpose::exam_delivery.attempt_purpose) default_binding
  join exam_delivery.package_versions pv on pv.id=default_binding.package_version_id
  join exam_delivery.package_profiles pp on pp.id=default_binding.package_profile_id and pp.package_version_id=pv.id;');
  if v_updated=v_definition then raise exception 'practice_default_resolution_contract_drift'; end if;
  execute v_updated;
end $$;

alter function exam_delivery.learner_weak_domain_evidence(uuid,uuid)
  rename to learner_weak_domain_evidence_same_package_base;
create function exam_delivery.learner_weak_domain_evidence(p_actor_id uuid,p_package_version_id uuid)
returns table(domain_key text,evidence_count bigint,lowest_percentage numeric)
language sql stable security definer set search_path='' set statement_timeout='8s' as $$
  with evidence as (
    select same.domain_key,same.evidence_count,same.lowest_percentage
    from exam_delivery.learner_weak_domain_evidence_same_package_base(p_actor_id,p_package_version_id) same
    union all
    select mapping.target_domain_key,count(*)::bigint,
      min(coalesce((domain.value->>'percentage')::numeric,100))
    from exam_delivery.package_domain_compatibility mapping
    join exam_delivery.attempts attempt on attempt.package_version_id=mapping.source_package_version_id
    join exam_delivery.attempt_results result on result.attempt_id=attempt.id
    cross join lateral jsonb_each(coalesce(result.domain_summary,'{}'::jsonb)) domain
    where mapping.target_package_version_id=p_package_version_id and mapping.enabled
      and mapping.source_domain_key=domain.key and attempt.owner_id=p_actor_id
      and attempt.status='completed' and attempt.analytics_eligible is true
      and attempt.purpose in ('assigned_assessment','self_directed_exam')
      and coalesce((domain.value->>'percentage')::numeric,100)<70
    group by mapping.target_domain_key
  )
  select evidence.domain_key,sum(evidence.evidence_count)::bigint,min(evidence.lowest_percentage)
  from evidence group by evidence.domain_key
$$;
alter function exam_delivery.learner_weak_domain_evidence_same_package_base(uuid,uuid) owner to postgres;
alter function exam_delivery.learner_weak_domain_evidence(uuid,uuid) owner to postgres;
revoke execute on function exam_delivery.learner_weak_domain_evidence_same_package_base(uuid,uuid),
  exam_delivery.learner_weak_domain_evidence(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function exam_delivery.replace_current_practice_attempt(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='20s' as $$
declare v_request_id uuid; v_assignment_id uuid; v_exam text:=exam_delivery.normalize_exam_key(p_request->>'examKey');
  v_availability jsonb; v_existing exam_delivery.attempts%rowtype; v_existing_id uuid; v_count integer;
  v_replacement exam_delivery.attempts%rowtype; v_started jsonb; v_failure text; v_now timestamptz:=statement_timestamp();
begin
  begin
    v_request_id:=(p_request->>'clientRequestId')::uuid;
    v_assignment_id:=nullif(p_request->>'assignmentId','')::uuid;
  exception when invalid_text_representation then return jsonb_build_object('ok',false,'code','invalid_request'); end;
  if p_actor_id is null or v_request_id is null or p_request->>'purpose'<>'self_directed_exam'
    or p_request ?| array['packageVersion','package_version','packageProfileId','package_profile_id','canonicalFormId','canonical_form_id','canonicalFormKey','canonical_form_key','questionIds','reserveQuestionIds'] then
    return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select a.* into v_replacement from exam_delivery.attempts a
  join exam_delivery.attempt_replacements r on r.replacement_attempt_id=a.id
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
  where a.owner_id=p_actor_id and a.client_request_id=v_request_id and r.owner_id=p_actor_id and r.request_id=v_request_id
    and exam_delivery.normalize_exam_key(pv.exam_key)=v_exam and pp.profile_key=p_request->>'profileId';
  if found then return exam_delivery.resume_attempt(p_actor_id,v_replacement.id); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_actor_id::text||':'||v_exam||':formal',0));
  v_availability:=exam_delivery.practice_availability(p_actor_id,p_request);
  if not coalesce((v_availability->>'ok')::boolean,false) then return v_availability; end if;
  select count(*),min(a.id::text)::uuid into v_count,v_existing_id from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
  where a.owner_id=p_actor_id and exam_delivery.normalize_exam_key(pv.exam_key)=v_exam
    and pp.profile_key=p_request->>'profileId' and a.purpose='self_directed_exam' and a.status='in_progress'
    and a.expires_at>v_now and a.protected_assignment_id is null
    and ((v_assignment_id is null and a.source_assignment_id is null
          and a.attribution_source is distinct from 'assignment')
      or (v_assignment_id is not null and a.source_assignment_id=v_assignment_id
          and a.attribution_source='assignment'));
  if v_count<>1 then return jsonb_build_object('ok',false,'code',case when v_count=0 then 'attempt_not_found' else 'attempt_conflict' end); end if;
  select * into strict v_existing from exam_delivery.attempts where id=v_existing_id for update;
  if exists(select 1 from exam_delivery.attempt_results where attempt_id=v_existing.id)
    or exists(select 1 from exam_delivery.review_snapshots where attempt_id=v_existing.id) then
    return jsonb_build_object('ok',false,'code','replacement_not_permitted'); end if;
  begin
    update exam_delivery.attempts set status='voided' where id=v_existing.id and status='in_progress';
    if not found then v_failure:='attempt_conflict'; raise exception 'replacement_aborted' using errcode='P0001'; end if;
    v_started:=exam_delivery.start_practice(p_actor_id,p_request);
    if not coalesce((v_started->>'ok')::boolean,false) then
      v_failure:=coalesce(v_started->>'code','replacement_failed'); raise exception 'replacement_aborted' using errcode='P0001'; end if;
    v_replacement.id:=(v_started#>>'{attempt,attemptId}')::uuid;
    insert into exam_delivery.attempt_replacements(replaced_attempt_id,replacement_attempt_id,owner_id,request_id,reason_code,replaced_at)
    values(v_existing.id,v_replacement.id,p_actor_id,v_request_id,'learner_started_new_attempt',v_now);
  exception when others then return jsonb_build_object('ok',false,'code',coalesce(v_failure,'replacement_failed')); end;
  return v_started;
exception when unique_violation then return jsonb_build_object('ok',false,'code','attempt_conflict');
end $$;

-- Public organisation assignments resolve a new binding through the explicit
-- assignment default; pre-existing protected assignments remain pinned above.
do $$ declare v_definition text; v_updated text;
begin
  v_definition:=pg_get_functiondef('exam_delivery.start_assignment_attempt(uuid,text,text,uuid,uuid)'::regprocedure);
  v_updated:=replace(v_definition,
    'from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
    where exam_delivery.normalize_exam_key(pv.exam_key)=v_key and pp.profile_key=p_profile_key
      and pv.package_schema_version=''certsim-protected-package-v2'' and pv.status=''published''
    order by pv.published_at desc limit 1 for share of pv,pp;',
    'from exam_delivery.resolve_package_profile_default(v_key,p_profile_key,''assigned_assessment''::exam_delivery.attempt_purpose) default_binding
    join exam_delivery.package_versions pv on pv.id=default_binding.package_version_id
    join exam_delivery.package_profiles pp on pp.id=default_binding.package_profile_id and pp.package_version_id=pv.id
    for share of pv,pp;');
  if v_updated=v_definition then raise exception 'assignment_default_resolution_contract_drift'; end if;
  execute v_updated;
end $$;

alter function exam_delivery.replace_current_practice_attempt(uuid,jsonb) owner to postgres;
revoke execute on function exam_delivery.replace_current_practice_attempt(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function exam_delivery.replace_current_practice_attempt(uuid,jsonb) to service_role;
