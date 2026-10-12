-- Authoritative protected-exam assignments. Legacy public.exam_assignments
-- remains display/tracking data and never grants protected delivery access.

create table exam_delivery.protected_assignments (
  id uuid primary key default gen_random_uuid(),
  learner_id uuid not null references auth.users(id) on delete restrict,
  organisation_id uuid not null references public.organisations(id) on delete restrict,
  package_version_id uuid not null references exam_delivery.package_versions(id) on delete restrict,
  package_profile_id uuid not null,
  status text not null default 'active',
  available_from timestamptz not null,
  expires_at timestamptz,
  maximum_attempts integer not null,
  review_release_policy text not null default 'never',
  answer_release_policy text not null default 'never',
  assigned_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  cancelled_at timestamptz,
  constraint protected_assignments_package_profile_fk
    foreign key (package_version_id, package_profile_id)
    references exam_delivery.package_profiles(package_version_id, id)
    on delete restrict,
  constraint protected_assignments_status_check
    check (status in ('active', 'disabled', 'cancelled')),
  constraint protected_assignments_window_check
    check (expires_at is null or expires_at > available_from),
  constraint protected_assignments_maximum_attempts_check
    check (maximum_attempts > 0),
  constraint protected_assignments_review_policy_check
    check (review_release_policy = 'never'),
  constraint protected_assignments_answer_policy_check
    check (answer_release_policy = 'never'),
  constraint protected_assignments_lifecycle_check check (
    (status = 'active' and disabled_at is null and cancelled_at is null)
    or (status = 'disabled' and disabled_at is not null and cancelled_at is null)
    or (status = 'cancelled' and cancelled_at is not null)
  )
);

create unique index protected_assignments_one_active_identity_idx
  on exam_delivery.protected_assignments
    (learner_id, package_version_id, package_profile_id)
  where status = 'active';

create index protected_assignments_learner_runtime_idx
  on exam_delivery.protected_assignments
    (learner_id, status, available_from, expires_at, package_profile_id);

create index protected_assignments_organisation_idx
  on exam_delivery.protected_assignments (organisation_id, status);

alter table exam_delivery.protected_assignments enable row level security;
revoke all on exam_delivery.protected_assignments from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from exam_delivery.attempts) then
    raise exception 'protected_assignment_migration_requires_empty_runtime';
  end if;
end
$$;

alter table exam_delivery.attempts
  add column protected_assignment_id uuid not null
  references exam_delivery.protected_assignments(id) on delete restrict;

create index attempts_protected_assignment_idx
  on exam_delivery.attempts (protected_assignment_id, created_at);

create function exam_delivery.create_protected_assignment(
  p_target_user_id uuid,
  p_organisation_id uuid,
  p_package_version text,
  p_profile_key text,
  p_available_from timestamptz,
  p_expires_at timestamptz,
  p_maximum_attempts integer,
  p_review_release_policy text,
  p_answer_release_policy text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_actor uuid := auth.uid();
  v_package record;
  v_created exam_delivery.protected_assignments%rowtype;
begin
  if v_actor is null then raise exception 'protected_assignment_auth_required' using errcode='42501'; end if;
  if p_target_user_id is null or p_organisation_id is null
     or nullif(btrim(p_package_version),'') is null
     or nullif(btrim(p_profile_key),'') is null
     or p_available_from is null or p_maximum_attempts is null then
    raise exception 'protected_assignment_invalid_request' using errcode='22023';
  end if;
  if p_maximum_attempts <= 0
     or p_review_release_policy <> 'never'
     or p_answer_release_policy <> 'never'
     or (p_expires_at is not null and p_expires_at <= p_available_from) then
    raise exception 'protected_assignment_invalid_policy' using errcode='22023';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.user_id=v_actor and m.role='platform_owner' and m.status='active'
  ) then raise exception 'protected_assignment_forbidden' using errcode='42501'; end if;
  if not exists (
    select 1 from public.profiles p
    join public.memberships m on m.user_id=p.id
    join public.organisations o on o.id=m.organisation_id
    where p.id=p_target_user_id and p.status='active'
      and m.organisation_id=p_organisation_id and m.role='student' and m.status='active'
      and o.status='active'
      and (m.campus_id is null or exists(select 1 from public.campuses c where c.id=m.campus_id and c.status='active'))
      and (m.group_id is null or exists(select 1 from public."groups" g where g.id=m.group_id and g.status='active'))
  ) then raise exception 'protected_assignment_target_invalid' using errcode='42501'; end if;

  select pv.id package_version_id, pp.id package_profile_id, pv.exam_key, pp.profile_key
    into strict v_package
    from exam_delivery.package_versions pv
    join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
   where pv.exam_key='ai901' and pv.package_version=p_package_version
     and pv.status='published' and pp.profile_key=p_profile_key
   for share of pv,pp;

  if exists (
    select 1 from exam_delivery.protected_assignments a
    where a.learner_id=p_target_user_id and a.status='active'
      and a.package_version_id=v_package.package_version_id
  ) then raise exception 'protected_assignment_conflict' using errcode='23505'; end if;

  insert into exam_delivery.protected_assignments(
    learner_id,organisation_id,package_version_id,package_profile_id,status,
    available_from,expires_at,maximum_attempts,review_release_policy,
    answer_release_policy,assigned_by
  ) values (
    p_target_user_id,p_organisation_id,v_package.package_version_id,
    v_package.package_profile_id,'active',p_available_from,p_expires_at,
    p_maximum_attempts,p_review_release_policy,p_answer_release_policy,v_actor
  ) returning * into v_created;

  return jsonb_build_object(
    'ok',true,'examKey',v_package.exam_key,'packageVersion',p_package_version,
    'profileKey',v_package.profile_key,'status',v_created.status,
    'availableFrom',v_created.available_from,'expiresAt',v_created.expires_at,
    'maximumAttempts',v_created.maximum_attempts,
    'reviewReleasePolicy',v_created.review_release_policy,
    'answerReleasePolicy',v_created.answer_release_policy
  );
exception
  when no_data_found or too_many_rows then
    raise exception 'protected_assignment_package_invalid' using errcode='22023';
end;
$$;

create or replace function exam_delivery.check_eligibility(
  p_actor_id uuid,p_exam_key text,p_profile_key text
)
returns jsonb language plpgsql stable security definer set search_path=''
as $$
declare
  v_now timestamptz:=statement_timestamp();
  v_runtime_exam_key text;
  v_assignment record;
  v_attempt_count integer;
begin
  v_runtime_exam_key:=case when p_exam_key in ('ai-901','ai901') then 'ai-901' end;
  if p_actor_id is null or v_runtime_exam_key is null or nullif(btrim(p_profile_key),'') is null then
    return jsonb_build_object('eligible',false,'reasonCode','invalid_request');
  end if;
  if not exists(select 1 from public.profiles p where p.id=p_actor_id and p.status='active') then
    return jsonb_build_object('eligible',false,'reasonCode','inactive_account');
  end if;
  if not exists(select 1 from exam_delivery.pilot_gates g where g.exam_key=v_runtime_exam_key and g.enabled) then
    return jsonb_build_object('eligible',false,'reasonCode','pilot_disabled');
  end if;
  if not exists(select 1 from exam_delivery.pilot_access a where a.user_id=p_actor_id and a.exam_key=v_runtime_exam_key and a.enabled and (a.access_starts_at is null or a.access_starts_at<=v_now) and (a.access_ends_at is null or a.access_ends_at>v_now)) then
    return jsonb_build_object('eligible',false,'reasonCode','not_allowlisted');
  end if;
  select a.id,a.maximum_attempts,pv.package_version,pp.profile_key,pp.display_name,pp.question_count,pp.time_limit_minutes
    into v_assignment
    from exam_delivery.protected_assignments a
    join exam_delivery.package_versions pv on pv.id=a.package_version_id
    join exam_delivery.package_profiles pp on pp.id=a.package_profile_id and pp.package_version_id=a.package_version_id
    join public.memberships m on m.user_id=a.learner_id and m.organisation_id=a.organisation_id and m.role='student' and m.status='active'
    join public.organisations o on o.id=a.organisation_id and o.status='active'
   where a.learner_id=p_actor_id and pv.exam_key='ai901' and pv.status='published'
     and pp.profile_key=p_profile_key and a.status='active'
     and a.available_from<=v_now and (a.expires_at is null or a.expires_at>v_now);
  if not found then return jsonb_build_object('eligible',false,'reasonCode','not_assigned'); end if;
  select count(*)::integer into v_attempt_count from exam_delivery.attempts x where x.protected_assignment_id=v_assignment.id;
  if v_attempt_count>=v_assignment.maximum_attempts and not exists(
    select 1 from exam_delivery.attempts x
    where x.protected_assignment_id=v_assignment.id and x.owner_id=p_actor_id and x.status='in_progress'
  ) then return jsonb_build_object('eligible',false,'reasonCode','attempt_limit_reached'); end if;
  return jsonb_build_object('eligible',true,'reasonCode','eligible','profileKey',v_assignment.profile_key,'profileName',v_assignment.display_name,'questionCount',v_assignment.question_count,'timeLimitMinutes',v_assignment.time_limit_minutes,'packageVersion',v_assignment.package_version,'remainingAttempts',greatest(0,v_assignment.maximum_attempts-v_attempt_count));
exception when too_many_rows then
  return jsonb_build_object('eligible',false,'reasonCode','assignment_conflict');
end;
$$;

create or replace function exam_delivery.start_attempt(
  p_actor_id uuid,p_exam_key text,p_profile_key text,p_request_id uuid
)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare
  v_existing exam_delivery.attempts%rowtype;
  v_assignment exam_delivery.protected_assignments%rowtype;
  v_package record;
  v_attempt exam_delivery.attempts%rowtype;
  v_now timestamptz:=statement_timestamp();
  v_inserted integer;
  v_attempt_count integer;
begin
  perform set_config('statement_timeout','10s',true);
  if p_request_id is null then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select a.* into v_existing from exam_delivery.attempts a where a.owner_id=p_actor_id and a.client_request_id=p_request_id;
  if found then
    if exists(select 1 from exam_delivery.package_profiles pp join exam_delivery.package_versions pv on pv.id=pp.package_version_id where pp.id=v_existing.package_profile_id and pp.profile_key=p_profile_key and pv.exam_key='ai901') then return exam_delivery.resume_attempt(p_actor_id,v_existing.id); end if;
    return jsonb_build_object('ok',false,'code','attempt_conflict');
  end if;
  if not coalesce((exam_delivery.check_eligibility(p_actor_id,p_exam_key,p_profile_key)->>'eligible')::boolean,false) then
    return jsonb_build_object('ok',false,'code',exam_delivery.check_eligibility(p_actor_id,p_exam_key,p_profile_key)->>'reasonCode');
  end if;
  select a.* into strict v_assignment
    from exam_delivery.protected_assignments a
    join exam_delivery.package_versions pv on pv.id=a.package_version_id
    join exam_delivery.package_profiles pp on pp.id=a.package_profile_id and pp.package_version_id=a.package_version_id
   where a.learner_id=p_actor_id and pv.exam_key='ai901' and pp.profile_key=p_profile_key
     and pv.status='published' and a.status='active' and a.available_from<=v_now
     and (a.expires_at is null or a.expires_at>v_now)
   for update of a;
  select count(*)::integer into v_attempt_count from exam_delivery.attempts x where x.protected_assignment_id=v_assignment.id;
  if v_attempt_count>=v_assignment.maximum_attempts then return jsonb_build_object('ok',false,'code','attempt_limit_reached'); end if;
  select pv.id package_version_id,pv.generator_version,pv.scorer_version,pp.id package_profile_id,pp.question_count,pp.time_limit_minutes,pp.selection_config
    into strict v_package from exam_delivery.package_versions pv join exam_delivery.package_profiles pp on pp.package_version_id=pv.id
   where pv.id=v_assignment.package_version_id and pp.id=v_assignment.package_profile_id for share of pv,pp;
  insert into exam_delivery.attempts(owner_id,package_version_id,package_profile_id,protected_assignment_id,client_request_id,status,generator_version,scorer_version,created_at,started_at,expires_at)
  values(p_actor_id,v_package.package_version_id,v_package.package_profile_id,v_assignment.id,p_request_id,'in_progress',v_package.generator_version,v_package.scorer_version,v_now,v_now,v_now+make_interval(mins=>v_package.time_limit_minutes)) returning * into v_attempt;
  with ranked as (
    select q.*,row_number() over(partition by q.domain_key order by md5(p_request_id::text||':'||q.question_id),q.source_ordinal) domain_rank,coalesce((v_package.selection_config->'domainDistribution'->>q.domain_key)::integer,0) domain_target
    from exam_delivery.package_questions q where q.package_version_id=v_package.package_version_id
  ),selected as (
    select * from ranked where domain_rank<=domain_target order by md5(p_request_id::text||':'||question_id),source_ordinal limit v_package.question_count
  ),inserted as (
    insert into exam_delivery.attempt_items(attempt_id,package_version_id,package_question_id,presented_question_number,section_ordinal,option_order,presentation_snapshot,presentation_hash)
    select v_attempt.id,v_package.package_version_id,s.id,row_number() over(order by md5(p_request_id::text||':'||s.question_id),s.source_ordinal),null,coalesce((select jsonb_agg(option->>'id') from jsonb_array_elements(coalesce(s.presentation_payload->'options','[]'::jsonb)) option),'[]'::jsonb),s.presentation_payload,encode(extensions.digest(convert_to(s.presentation_payload::text,'UTF8'),'sha256'),'hex') from selected s returning id,package_question_id
  )
  insert into exam_delivery.attempt_item_protected_content(attempt_item_id,attempt_id,scoring_snapshot,review_snapshot,protected_snapshot_hash)
  select i.id,v_attempt.id,pc.scoring_payload,pc.review_payload,encode(extensions.digest(convert_to((pc.scoring_payload||pc.review_payload)::text,'UTF8'),'sha256'),'hex') from inserted i join exam_delivery.package_question_protected_content pc on pc.question_id=i.package_question_id;
  get diagnostics v_inserted=row_count;
  if v_inserted<>v_package.question_count then raise exception using errcode='P0001',message='selection_incomplete'; end if;
  return exam_delivery.resume_attempt(p_actor_id,v_attempt.id);
exception when no_data_found or too_many_rows then return jsonb_build_object('ok',false,'code','assignment_conflict');
when unique_violation then return jsonb_build_object('ok',false,'code','attempt_conflict');
when others then return jsonb_build_object('ok',false,'code','internal_failure');
end;
$$;

create or replace function exam_delivery.get_review(p_actor_id uuid,p_attempt_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select case
    when not exists(select 1 from exam_delivery.attempts a where a.id=p_attempt_id and a.owner_id=p_actor_id and a.status='completed') then jsonb_build_object('ok',false,'code','attempt_not_found')
    when not exists(
      select 1 from exam_delivery.review_snapshots r
      join exam_delivery.attempts a on a.id=r.attempt_id
      join exam_delivery.protected_assignments pa on pa.id=a.protected_assignment_id
      where r.attempt_id=p_attempt_id and a.owner_id=p_actor_id
        and r.release_status='released'
        and pa.review_release_policy<>'never' and pa.answer_release_policy<>'never'
    ) then jsonb_build_object('ok',false,'code','review_unavailable')
    else (select jsonb_build_object('ok',true,'review',r.review_payload) from exam_delivery.review_snapshots r where r.attempt_id=p_attempt_id)
  end;
$$;

create function public.certsim_protected_create_assignment(
  p_target_user_id uuid,p_organisation_id uuid,p_package_version text,
  p_profile_key text,p_available_from timestamptz,p_expires_at timestamptz,
  p_maximum_attempts integer,p_review_release_policy text,p_answer_release_policy text
)
returns jsonb language sql security definer set search_path=''
as $$ select exam_delivery.create_protected_assignment(p_target_user_id,p_organisation_id,p_package_version,p_profile_key,p_available_from,p_expires_at,p_maximum_attempts,p_review_release_policy,p_answer_release_policy) $$;

revoke execute on function exam_delivery.create_protected_assignment(uuid,uuid,text,text,timestamptz,timestamptz,integer,text,text) from public,anon,service_role;
revoke execute on function exam_delivery.create_protected_assignment(uuid,uuid,text,text,timestamptz,timestamptz,integer,text,text) from authenticated;
revoke execute on function public.certsim_protected_create_assignment(uuid,uuid,text,text,timestamptz,timestamptz,integer,text,text) from public,anon,service_role;
grant execute on function public.certsim_protected_create_assignment(uuid,uuid,text,text,timestamptz,timestamptz,integer,text,text) to authenticated;

-- The initial operational decision is deliberately explicit and not package
-- metadata: ai901/1.0.0, ai901-controlled-beta-compact, 25 questions,
-- 25 minutes, one attempt, no expiry, review/answer release never.
