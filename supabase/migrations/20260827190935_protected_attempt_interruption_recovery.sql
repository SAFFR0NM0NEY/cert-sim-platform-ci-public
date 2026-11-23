-- Audited, one-time technical interruption recovery for the protected AI-901
-- pilot. Existing attempts and their immutable delivered snapshots remain
-- preserved; only an explicitly authorized zero-response attempt may be voided.

create table exam_delivery.attempt_technical_recoveries (
  id uuid primary key default gen_random_uuid(),
  protected_assignment_id uuid not null
    references exam_delivery.protected_assignments(id) on delete restrict,
  interrupted_attempt_id uuid not null unique
    references exam_delivery.attempts(id) on delete restrict,
  replacement_attempt_id uuid unique
    references exam_delivery.attempts(id) on delete restrict,
  authorized_by uuid not null references auth.users(id) on delete restrict,
  reason_code text not null,
  authorized_at timestamptz not null default now(),
  replacement_started_at timestamptz,
  constraint attempt_technical_recoveries_assignment_unique
    unique (protected_assignment_id),
  constraint attempt_technical_recoveries_reason_check
    check (reason_code = 'operator_harness_response_serialization_failure'),
  constraint attempt_technical_recoveries_distinct_attempts_check
    check (replacement_attempt_id is null or replacement_attempt_id <> interrupted_attempt_id),
  constraint attempt_technical_recoveries_replacement_timestamp_check
    check (
      (replacement_attempt_id is null and replacement_started_at is null)
      or (replacement_attempt_id is not null and replacement_started_at is not null
          and replacement_started_at >= authorized_at)
    )
);

alter table exam_delivery.attempt_technical_recoveries enable row level security;
revoke all on exam_delivery.attempt_technical_recoveries
  from public, anon, authenticated, service_role;

create function exam_delivery.resume_current_attempt(
  p_actor_id uuid,
  p_exam_key text,
  p_profile_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_eligibility jsonb;
  v_attempt exam_delivery.attempts%rowtype;
begin
  if p_actor_id is null or p_exam_key not in ('ai-901','ai901')
     or p_profile_key <> 'ai901-controlled-beta-compact' then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end if;

  v_eligibility := exam_delivery.check_eligibility(
    p_actor_id,'ai-901',p_profile_key
  );
  if not coalesce((v_eligibility->>'eligible')::boolean,false) then
    return jsonb_build_object('ok',false,'code',v_eligibility->>'reasonCode');
  end if;

  select a.* into v_attempt
    from exam_delivery.attempts a
    join exam_delivery.package_versions pv on pv.id=a.package_version_id
    join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
   where a.owner_id=p_actor_id and pv.exam_key='ai901'
     and pp.profile_key=p_profile_key and a.status='in_progress'
   order by a.created_at desc
   limit 1;

  if not found then
    return jsonb_build_object('ok',false,'code','attempt_not_found');
  end if;
  if v_attempt.expires_at <= statement_timestamp() then
    return jsonb_build_object('ok',false,'code','attempt_expired');
  end if;
  return exam_delivery.resume_attempt(p_actor_id,v_attempt.id);
end;
$$;

create function exam_delivery.authorize_technical_recovery(
  p_attempt_id uuid,
  p_reason_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_actor uuid := auth.uid();
  v_attempt record;
  v_recovery exam_delivery.attempt_technical_recoveries%rowtype;
begin
  if v_actor is null then
    raise exception 'technical_recovery_auth_required' using errcode='42501';
  end if;
  if p_attempt_id is null
     or p_reason_code <> 'operator_harness_response_serialization_failure' then
    raise exception 'technical_recovery_invalid_request' using errcode='22023';
  end if;
  if not exists (
    select 1 from public.memberships m
     where m.user_id=v_actor and m.role='platform_owner' and m.status='active'
  ) then
    raise exception 'technical_recovery_forbidden' using errcode='42501';
  end if;

  select a.*,pa.organisation_id,pv.exam_key,pv.package_version,pp.profile_key
    into strict v_attempt
    from exam_delivery.attempts a
    join exam_delivery.protected_assignments pa on pa.id=a.protected_assignment_id
    join exam_delivery.package_versions pv on pv.id=a.package_version_id
    join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
   where a.id=p_attempt_id
   for update of a,pa;

  if v_attempt.exam_key<>'ai901' or v_attempt.package_version<>'1.0.0'
     or v_attempt.profile_key<>'ai901-controlled-beta-compact'
     or v_attempt.status<>'in_progress'
     or exists(select 1 from exam_delivery.attempt_responses r where r.attempt_id=p_attempt_id)
     or exists(select 1 from exam_delivery.attempt_results r where r.attempt_id=p_attempt_id)
     or exists(select 1 from exam_delivery.review_snapshots r where r.attempt_id=p_attempt_id)
     or (select count(*) from exam_delivery.attempt_items i where i.attempt_id=p_attempt_id)<>25
     or (select count(*) from exam_delivery.attempt_item_protected_content i where i.attempt_id=p_attempt_id)<>25
     or not exists (
       select 1 from public.memberships m
        where m.user_id=v_attempt.owner_id
          and m.organisation_id=v_attempt.organisation_id
          and m.role='student' and m.status='active'
     ) then
    raise exception 'technical_recovery_state_invalid' using errcode='55000';
  end if;

  insert into exam_delivery.attempt_technical_recoveries(
    protected_assignment_id,interrupted_attempt_id,authorized_by,reason_code
  ) values (
    v_attempt.protected_assignment_id,p_attempt_id,v_actor,p_reason_code
  ) returning * into v_recovery;

  update exam_delivery.attempts
     set status='voided'
   where id=p_attempt_id and status='in_progress';

  return jsonb_build_object(
    'ok',true,
    'reasonCode',v_recovery.reason_code,
    'interruptedStatus','voided',
    'replacementAuthorized',true,
    'maximumRecoveries',1
  );
exception
  when no_data_found or too_many_rows then
    raise exception 'technical_recovery_state_invalid' using errcode='55000';
  when unique_violation then
    raise exception 'technical_recovery_already_used' using errcode='23505';
end;
$$;

-- Count only valid attempts. The single audit-linked interrupted attempt is
-- preserved but does not consume the assignment's one valid attempt.
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
  select count(*)::integer into v_attempt_count
    from exam_delivery.attempts x
   where x.protected_assignment_id=v_assignment.id
     and not exists(
       select 1 from exam_delivery.attempt_technical_recoveries tr
        where tr.interrupted_attempt_id=x.id
     );
  if v_attempt_count>=v_assignment.maximum_attempts and not exists(
    select 1 from exam_delivery.attempts x
    where x.protected_assignment_id=v_assignment.id and x.owner_id=p_actor_id and x.status='in_progress'
      and not exists(select 1 from exam_delivery.attempt_technical_recoveries tr where tr.interrupted_attempt_id=x.id)
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
  v_recovery_id uuid;
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
  select count(*)::integer into v_attempt_count
    from exam_delivery.attempts x
   where x.protected_assignment_id=v_assignment.id
     and not exists(select 1 from exam_delivery.attempt_technical_recoveries tr where tr.interrupted_attempt_id=x.id);
  if v_attempt_count>=v_assignment.maximum_attempts then return jsonb_build_object('ok',false,'code','attempt_limit_reached'); end if;
  select tr.id into v_recovery_id
    from exam_delivery.attempt_technical_recoveries tr
   where tr.protected_assignment_id=v_assignment.id and tr.replacement_attempt_id is null
   for update;
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
  if v_recovery_id is not null then
    update exam_delivery.attempt_technical_recoveries
       set replacement_attempt_id=v_attempt.id,replacement_started_at=v_now
     where id=v_recovery_id and replacement_attempt_id is null;
    if not found then raise exception using errcode='P0001',message='recovery_concurrency_conflict'; end if;
  end if;
  return exam_delivery.resume_attempt(p_actor_id,v_attempt.id);
exception when no_data_found or too_many_rows then return jsonb_build_object('ok',false,'code','assignment_conflict');
when unique_violation then return jsonb_build_object('ok',false,'code','attempt_conflict');
when others then return jsonb_build_object('ok',false,'code','internal_failure');
end;
$$;

-- Preserve identical submit replay after the assignment quota has been
-- consumed. New submissions still execute the existing authoritative scorer;
-- only an already-owned stored submission can return before eligibility.
create function exam_delivery.submit_attempt_idempotent(
  p_actor_id uuid,p_attempt_id uuid,p_submission_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
declare
  v_existing exam_delivery.attempt_results%rowtype;
begin
  if p_actor_id is null or p_attempt_id is null or p_submission_id is null then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end if;
  select ar.* into v_existing
    from exam_delivery.attempt_results ar
    join exam_delivery.attempts a on a.id=ar.attempt_id
   where ar.attempt_id=p_attempt_id and a.owner_id=p_actor_id;
  if found then
    if v_existing.submission_id=p_submission_id then
      return exam_delivery.get_result(p_actor_id,p_attempt_id);
    end if;
    return jsonb_build_object('ok',false,'code','submission_conflict');
  end if;
  return exam_delivery.submit_attempt(p_actor_id,p_attempt_id,p_submission_id);
end;
$$;

create or replace function public.certsim_protected_submit_attempt(
  p_actor_id uuid,p_attempt_id uuid,p_submission_id uuid
)
returns jsonb language sql security invoker set search_path=''
as $$ select exam_delivery.submit_attempt_idempotent(p_actor_id,p_attempt_id,p_submission_id) $$;

revoke execute on function exam_delivery.submit_attempt_idempotent(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function exam_delivery.submit_attempt_idempotent(uuid,uuid,uuid)
  to service_role;
revoke execute on function public.certsim_protected_submit_attempt(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.certsim_protected_submit_attempt(uuid,uuid,uuid)
  to service_role;

create function public.certsim_protected_resume_current_attempt(
  p_actor_id uuid,p_exam_key text,p_profile_key text
)
returns jsonb language sql stable security invoker set search_path=''
as $$ select exam_delivery.resume_current_attempt(p_actor_id,p_exam_key,p_profile_key) $$;

create function public.certsim_protected_authorize_technical_recovery(
  p_attempt_id uuid,p_reason_code text
)
returns jsonb language sql security invoker set search_path=''
as $$ select exam_delivery.authorize_technical_recovery(p_attempt_id,p_reason_code) $$;

revoke execute on function exam_delivery.resume_current_attempt(uuid,text,text)
  from public,anon,authenticated,service_role;
grant execute on function exam_delivery.resume_current_attempt(uuid,text,text)
  to service_role;
revoke execute on function public.certsim_protected_resume_current_attempt(uuid,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.certsim_protected_resume_current_attempt(uuid,text,text)
  to service_role;

revoke execute on function exam_delivery.authorize_technical_recovery(uuid,text)
  from public,anon,service_role;
grant execute on function exam_delivery.authorize_technical_recovery(uuid,text)
  to authenticated;
revoke execute on function public.certsim_protected_authorize_technical_recovery(uuid,text)
  from public,anon,service_role;
grant execute on function public.certsim_protected_authorize_technical_recovery(uuid,text)
  to authenticated;
