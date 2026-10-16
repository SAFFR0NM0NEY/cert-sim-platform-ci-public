-- G3B2R4: audited, actor-owned replacement of an expired practice attempt.
-- This is deliberately separate from assignment technical recovery: practice
-- expiry is a normal learner lifecycle event and never authorizes an
-- assigned-assessment replacement.

create table exam_delivery.practice_attempt_expirations (
  id uuid primary key default gen_random_uuid(),
  expired_attempt_id uuid not null unique
    references exam_delivery.attempts(id) on delete restrict,
  replacement_attempt_id uuid not null unique
    references exam_delivery.attempts(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  reason_code text not null,
  response_count integer not null,
  expired_at timestamptz not null,
  replacement_started_at timestamptz not null,
  constraint practice_attempt_expirations_reason_check
    check (reason_code='practice_window_expired'),
  constraint practice_attempt_expirations_response_count_check
    check (response_count>=0),
  constraint practice_attempt_expirations_distinct_attempts_check
    check (expired_attempt_id<>replacement_attempt_id),
  constraint practice_attempt_expirations_time_order_check
    check (replacement_started_at>=expired_at)
);

alter table exam_delivery.practice_attempt_expirations enable row level security;
revoke all on table exam_delivery.practice_attempt_expirations
  from public,anon,authenticated,service_role;

create trigger guard_practice_attempt_expirations_mutation
before update or delete on exam_delivery.practice_attempt_expirations
for each row execute function exam_delivery.reject_immutable_row_mutation();

create or replace function exam_delivery.start_practice(p_actor_id uuid,p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='15s'
as $$
declare
  v_availability jsonb;
  v_attempt exam_delivery.attempts%rowtype;
  v_existing exam_delivery.attempts%rowtype;
  v_package record;
  v_policy exam_delivery.practice_policies%rowtype;
  v_request_id uuid;
  v_configuration jsonb;
  v_now timestamptz:=statement_timestamp();
  v_limit integer;
  v_response_count integer:=0;
  v_consumed_count integer:=0;
  v_has_expired boolean:=false;
begin
  begin
    v_request_id := (p_request->>'clientRequestId')::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end;
  if p_actor_id is null or v_request_id is null then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end if;
  v_configuration := p_request-'clientRequestId';

  v_availability := exam_delivery.practice_availability(p_actor_id,p_request);
  if not coalesce((v_availability->>'ok')::boolean,false) then return v_availability; end if;
  if not exists(
    select 1 from public.memberships m
    join public.organisations o on o.id=m.organisation_id and o.status='active'
    where m.user_id=p_actor_id and m.role='student' and m.status='active'
  ) then return jsonb_build_object('ok',false,'code','inactive_membership'); end if;
  if (v_availability->>'examKey'='az204' and v_availability->>'packageVersion'='1.1.0'
      and p_request->>'language' not in ('csharp','python','mixed'))
    or (not (v_availability->>'examKey'='az204' and v_availability->>'packageVersion'='1.1.0')
      and p_request->>'language'<>'not_applicable')
  then return jsonb_build_object('ok',false,'code','invalid_request'); end if;

  select pv.id package_version_id,pv.generator_version,pv.scorer_version,
         pp.id package_profile_id,pp.time_limit_minutes
    into strict v_package
  from exam_delivery.package_versions pv
  join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=v_availability->>'examKey'
    and pv.package_version=v_availability->>'packageVersion'
    and pp.profile_key=v_availability->>'profileKey'
    and pv.package_schema_version='certsim-protected-package-v2'
    and pv.status='published'
  for share of pv,pp;

  -- Serialize both the no-row and existing-row cases for this immutable binding.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_actor_id::text||':'||v_package.package_version_id::text||':'||
    v_package.package_profile_id::text||':'||(p_request->>'purpose')||':'||
    (p_request->>'language'),0));

  select * into v_existing
  from exam_delivery.attempts
  where owner_id=p_actor_id and client_request_id=v_request_id
  for update;
  if found then
    if v_existing.purpose=(p_request->>'purpose')::exam_delivery.attempt_purpose
      and v_existing.practice_configuration=v_configuration
      and v_existing.language_preference=p_request->>'language'
      and v_existing.package_version_id=v_package.package_version_id
      and v_existing.package_profile_id=v_package.package_profile_id
    then return exam_delivery.resume_attempt(p_actor_id,v_existing.id); end if;
    return jsonb_build_object('ok',false,'code','attempt_conflict');
  end if;

  select * into v_policy
  from exam_delivery.practice_policies p
  where p.canonical_exam_key=v_availability->>'examKey'
    and p.package_version=v_availability->>'packageVersion'
    and p.profile_key=v_availability->>'profileKey'
    and p.purpose=(p_request->>'purpose')::exam_delivery.attempt_purpose
  for update;
  if not found or not v_policy.enabled or v_policy.access_mode='disabled' then
    return jsonb_build_object('ok',false,'code','practice_unavailable');
  end if;

  select a.* into v_existing
  from exam_delivery.attempts a
  where a.owner_id=p_actor_id
    and a.package_version_id=v_package.package_version_id
    and a.package_profile_id=v_package.package_profile_id
    and a.purpose=(p_request->>'purpose')::exam_delivery.attempt_purpose
    and a.language_preference=p_request->>'language'
    and a.status='in_progress'
  for update of a;
  if found then
    if v_existing.expires_at>v_now then
      return exam_delivery.resume_attempt(p_actor_id,v_existing.id);
    end if;
    if v_existing.protected_assignment_id is not null
      or exists(select 1 from exam_delivery.attempt_results r where r.attempt_id=v_existing.id)
      or exists(select 1 from exam_delivery.review_snapshots r where r.attempt_id=v_existing.id)
    then return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition'); end if;
    select count(*)::integer into v_response_count
    from exam_delivery.attempt_responses r where r.attempt_id=v_existing.id;
    v_has_expired:=true;
  end if;

  -- Completed attempts always consume the configured limit. Expired attempts
  -- consume it only when at least one response was preserved. The candidate
  -- expiry is included before any mutation so a denied replacement is atomic.
  if v_policy.maximum_completed_attempts is not null then
    select count(*)::integer into v_consumed_count
    from exam_delivery.attempts a
    where a.owner_id=p_actor_id
      and a.package_version_id=v_package.package_version_id
      and a.package_profile_id=v_package.package_profile_id
      and a.purpose=v_policy.purpose
      and (a.status='completed' or (a.status='expired' and exists(
        select 1 from exam_delivery.attempt_responses r where r.attempt_id=a.id)));
    if v_has_expired and v_response_count>0 then v_consumed_count:=v_consumed_count+1; end if;
    if v_consumed_count>=v_policy.maximum_completed_attempts then
      return jsonb_build_object('ok',false,'code','attempt_limit_reached');
    end if;
  end if;

  v_availability := exam_delivery.practice_availability(p_actor_id,p_request);
  if not coalesce((v_availability->>'ok')::boolean,false) then return v_availability; end if;

  if v_has_expired then
    update exam_delivery.attempts set status='expired'
    where id=v_existing.id and status='in_progress' and expires_at<=v_now;
    if not found then return jsonb_build_object('ok',false,'code','attempt_conflict'); end if;
  end if;

  insert into exam_delivery.attempts(
    owner_id,package_version_id,package_profile_id,protected_assignment_id,
    client_request_id,status,generator_version,scorer_version,created_at,
    started_at,expires_at,purpose,practice_configuration,language_preference
  ) values (
    p_actor_id,v_package.package_version_id,v_package.package_profile_id,null,
    v_request_id,'in_progress',v_package.generator_version,v_package.scorer_version,
    v_now,v_now,v_now+make_interval(mins=>v_package.time_limit_minutes),
    (p_request->>'purpose')::exam_delivery.attempt_purpose,v_configuration,
    p_request->>'language'
  ) returning * into v_attempt;

  v_limit := (v_availability->>'selectedCount')::integer;
  perform exam_delivery.materialize_attempt_items(v_attempt.id,v_request_id,v_limit);

  if v_has_expired then
    insert into exam_delivery.practice_attempt_expirations(
      expired_attempt_id,replacement_attempt_id,owner_id,reason_code,
      response_count,expired_at,replacement_started_at
    ) values (
      v_existing.id,v_attempt.id,p_actor_id,'practice_window_expired',
      v_response_count,v_now,v_attempt.started_at
    );
  end if;
  return exam_delivery.resume_attempt(p_actor_id,v_attempt.id);
exception
  when no_data_found or too_many_rows then
    return jsonb_build_object('ok',false,'code','package_unavailable');
  when unique_violation then
    return jsonb_build_object('ok',false,'code','attempt_conflict');
end;
$$;

revoke execute on function exam_delivery.start_practice(uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function exam_delivery.start_practice(uuid,jsonb) to service_role;
