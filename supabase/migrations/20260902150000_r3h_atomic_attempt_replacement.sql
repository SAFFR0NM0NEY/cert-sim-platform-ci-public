-- Issue #24 R3H: align resumable discovery with continuation authorization and
-- provide an atomic, idempotent learner-requested replacement boundary.

create table exam_delivery.attempt_replacements (
  replaced_attempt_id uuid primary key references exam_delivery.attempts(id) on delete restrict,
  replacement_attempt_id uuid not null unique references exam_delivery.attempts(id) on delete restrict,
  owner_id uuid not null references auth.users(id) on delete restrict,
  request_id uuid not null,
  reason_code text not null check (reason_code='learner_started_new_attempt'),
  replaced_at timestamptz not null default statement_timestamp(),
  unique(owner_id,request_id),
  check(replaced_attempt_id<>replacement_attempt_id)
);

alter table exam_delivery.attempt_replacements enable row level security;
revoke all on table exam_delivery.attempt_replacements from public,anon,authenticated,service_role;

create trigger guard_attempt_replacements_mutation
before update or delete on exam_delivery.attempt_replacements
for each row execute function exam_delivery.reject_immutable_row_mutation();

create or replace function exam_delivery.list_current_attempt_bindings(
  p_actor_id uuid,p_exam_key text,p_purpose text
) returns jsonb language sql stable security definer
set search_path='' set statement_timeout='5s' as $$
  select jsonb_build_object('ok',true,'candidates',coalesce(jsonb_agg(jsonb_build_object(
    'attemptId',a.id,
    'examKey',exam_delivery.normalize_exam_key(pv.exam_key),
    'packageVersion',pv.package_version,
    'profileKey',pp.profile_key,
    'profileName',pp.display_name,
    'purpose',a.purpose,
    'languagePreference',a.language_preference,
    'startedAt',a.started_at,
    'expiresAt',a.expires_at,
    'replacementPermitted',coalesce(policy.maximum_completed_attempts is null
      and policy.maximum_concurrent_sessions=1
      and policy.enabled
      and policy.access_mode<>'disabled'
      and a.purpose='self_directed_exam',false)
  ) order by a.started_at,a.id),'[]'::jsonb))
  from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
  left join exam_delivery.practice_policies policy
    on policy.canonical_exam_key=exam_delivery.normalize_exam_key(pv.exam_key)
    and policy.package_version=pv.package_version
    and policy.profile_key=pp.profile_key
    and policy.purpose=a.purpose
  cross join lateral (select exam_delivery.authorize_attempt_continuation(a.id,'resume') authorization) auth
  where a.owner_id=p_actor_id
    and a.status='in_progress'
    and a.expires_at>statement_timestamp()
    and coalesce((auth.authorization->>'ok')::boolean,false)
    and (auth.authorization->>'ownerId')::uuid=p_actor_id
    and exam_delivery.normalize_exam_key(pv.exam_key)=exam_delivery.normalize_exam_key(p_exam_key)
    and a.purpose::text=p_purpose
    and a.source_assignment_id is null
    and a.attribution_source is distinct from 'assignment'
$$;

create function exam_delivery.replace_current_practice_attempt(p_actor_id uuid,p_request jsonb)
returns jsonb language plpgsql security definer
set search_path='' set statement_timeout='20s' as $$
declare
  v_request_id uuid;
  v_availability jsonb;
  v_package record;
  v_policy exam_delivery.practice_policies%rowtype;
  v_existing exam_delivery.attempts%rowtype;
  v_existing_id uuid;
  v_existing_count integer;
  v_replacement exam_delivery.attempts%rowtype;
  v_started jsonb;
  v_failure text;
  v_configuration jsonb;
  v_now timestamptz:=statement_timestamp();
begin
  begin v_request_id:=(p_request->>'clientRequestId')::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end;
  if p_actor_id is null or v_request_id is null
    or p_request->>'purpose'<>'self_directed_exam'
    or p_request->>'language' not in ('csharp','python','mixed','not_applicable') then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end if;
  v_configuration:=p_request-'clientRequestId';

  select a.* into v_replacement from exam_delivery.attempts a
  join exam_delivery.attempt_replacements r on r.replacement_attempt_id=a.id
  where a.owner_id=p_actor_id and a.client_request_id=v_request_id
    and r.owner_id=p_actor_id and r.request_id=v_request_id;
  if found then
    if v_replacement.purpose='self_directed_exam'
      and v_replacement.practice_configuration=v_configuration
      and v_replacement.language_preference=p_request->>'language' then
      return exam_delivery.resume_attempt(p_actor_id,v_replacement.id);
    end if;
    return jsonb_build_object('ok',false,'code','attempt_conflict');
  end if;

  v_availability:=exam_delivery.practice_availability(p_actor_id,p_request);
  if not coalesce((v_availability->>'ok')::boolean,false) then return v_availability; end if;

  select pv.id package_version_id,pp.id package_profile_id
    into strict v_package
  from exam_delivery.package_versions pv
  join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key)=v_availability->>'examKey'
    and pv.package_version=v_availability->>'packageVersion'
    and pp.profile_key=v_availability->>'profileKey'
    and pv.package_schema_version='certsim-protected-package-v2'
    and pv.status='published'
  for share of pv,pp;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_actor_id::text||':'||v_package.package_version_id::text||':'||
    v_package.package_profile_id::text||':self_directed_exam',0));

  select count(*)::integer,min(a.id::text)::uuid into v_existing_count,v_existing_id
  from exam_delivery.attempts a
  where a.owner_id=p_actor_id
    and a.package_version_id=v_package.package_version_id
    and a.package_profile_id=v_package.package_profile_id
    and a.purpose='self_directed_exam'
    and a.status='in_progress'
    and a.expires_at>v_now;
  if v_existing_count=0 then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  if v_existing_count<>1 then return jsonb_build_object('ok',false,'code','attempt_conflict'); end if;
  select * into strict v_existing from exam_delivery.attempts where id=v_existing_id for update;

  if v_existing.protected_assignment_id is not null or v_existing.source_assignment_id is not null
    or v_existing.attribution_source='assignment'
    or exists(select 1 from exam_delivery.attempt_results r where r.attempt_id=v_existing.id)
    or exists(select 1 from exam_delivery.review_snapshots r where r.attempt_id=v_existing.id) then
    return jsonb_build_object('ok',false,'code','replacement_not_permitted');
  end if;

  select * into v_policy from exam_delivery.practice_policies p
  where p.canonical_exam_key=v_availability->>'examKey'
    and p.package_version=v_availability->>'packageVersion'
    and p.profile_key=v_availability->>'profileKey'
    and p.purpose='self_directed_exam' for update;
  if not found or not v_policy.enabled or v_policy.access_mode='disabled'
    or v_policy.maximum_completed_attempts is not null
    or v_policy.maximum_concurrent_sessions<>1 then
    return jsonb_build_object('ok',false,'code','replacement_not_permitted');
  end if;

  v_availability:=exam_delivery.practice_availability(p_actor_id,p_request);
  if not coalesce((v_availability->>'ok')::boolean,false) then return v_availability; end if;

  begin
    update exam_delivery.attempts set status='voided'
    where id=v_existing.id and owner_id=p_actor_id and status='in_progress' and expires_at>v_now;
    if not found then
      v_failure:='attempt_conflict';
      raise exception 'replacement_aborted' using errcode='P0001';
    end if;

    v_started:=exam_delivery.start_practice(p_actor_id,p_request);
    if not coalesce((v_started->>'ok')::boolean,false) then
      v_failure:=coalesce(v_started->>'code','replacement_failed');
      raise exception 'replacement_aborted' using errcode='P0001';
    end if;
    v_replacement.id:=(v_started#>>'{attempt,attemptId}')::uuid;
    insert into exam_delivery.attempt_replacements(
      replaced_attempt_id,replacement_attempt_id,owner_id,request_id,reason_code,replaced_at
    ) values (v_existing.id,v_replacement.id,p_actor_id,v_request_id,'learner_started_new_attempt',v_now);
  exception when others then
    return jsonb_build_object('ok',false,'code',coalesce(v_failure,'replacement_failed'));
  end;
  return v_started;
exception
  when no_data_found or too_many_rows then return jsonb_build_object('ok',false,'code','package_unavailable');
  when unique_violation then return jsonb_build_object('ok',false,'code','attempt_conflict');
end;
$$;

create function public.certsim_protected_replace_current_practice_attempt(p_actor_id uuid,p_request jsonb)
returns jsonb language sql security invoker set search_path='' as $$
  select exam_delivery.replace_current_practice_attempt(p_actor_id,p_request)
$$;

alter function exam_delivery.replace_current_practice_attempt(uuid,jsonb) owner to postgres;
alter function public.certsim_protected_replace_current_practice_attempt(uuid,jsonb) owner to postgres;
alter function exam_delivery.list_current_attempt_bindings(uuid,text,text) owner to postgres;

revoke execute on function exam_delivery.replace_current_practice_attempt(uuid,jsonb)
  from public,anon,authenticated,service_role;
revoke execute on function public.certsim_protected_replace_current_practice_attempt(uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function exam_delivery.replace_current_practice_attempt(uuid,jsonb) to service_role;
grant execute on function public.certsim_protected_replace_current_practice_attempt(uuid,jsonb) to service_role;
