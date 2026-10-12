-- Issue #133 Phase 4B: immutable continuation authority and atomic whole-exam
-- release operations. This migration creates production-capable contracts but
-- is intentionally not applied to the hosted project in this phase.

create table exam_delivery.exam_release_operations (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique,
  request_hash text not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  canonical_exam_key text not null,
  operation_type text not null,
  target_package_id uuid references exam_delivery.package_versions(id) on delete restrict,
  stage_operation_id uuid references exam_delivery.exam_release_operations(id) on delete restrict,
  rollback_of_operation_id uuid references exam_delivery.exam_release_operations(id) on delete restrict,
  release_set jsonb not null,
  release_set_hash text not null,
  manifest_hash text not null,
  package_hash text not null,
  validation_hash text not null,
  release_diff_hash text not null,
  expected_current_state_hash text not null,
  preflight_result jsonb,
  previous_state_snapshot jsonb,
  previous_state_hash text,
  postcondition_result jsonb,
  result_state text not null default 'requested',
  error_code text,
  created_at timestamptz not null default statement_timestamp(),
  started_at timestamptz,
  completed_at timestamptz,
  constraint exam_release_operations_exam_key_check check (
    canonical_exam_key=exam_delivery.normalize_exam_key(canonical_exam_key)
  ),
  constraint exam_release_operations_type_check check (
    operation_type in ('STAGE','ACTIVATE','ROLLBACK')
  ),
  constraint exam_release_operations_state_check check (
    result_state in ('requested','preflighted','executing','succeeded','failed')
  ),
  constraint exam_release_operations_hashes_check check (
    request_hash ~ '^[0-9a-f]{64}$'
    and release_set_hash ~ '^[0-9a-f]{64}$'
    and manifest_hash ~ '^[0-9a-f]{64}$'
    and package_hash ~ '^[0-9a-f]{64}$'
    and validation_hash ~ '^[0-9a-f]{64}$'
    and release_diff_hash ~ '^[0-9a-f]{64}$'
    and expected_current_state_hash ~ '^[0-9a-f]{64}$'
    and (previous_state_hash is null or previous_state_hash ~ '^[0-9a-f]{64}$')
  ),
  constraint exam_release_operations_json_check check (
    jsonb_typeof(release_set)='object'
    and (preflight_result is null or jsonb_typeof(preflight_result)='object')
    and (previous_state_snapshot is null or jsonb_typeof(previous_state_snapshot)='object')
    and (postcondition_result is null or jsonb_typeof(postcondition_result)='object')
  ),
  constraint exam_release_operations_reference_check check (
    (operation_type='STAGE' and stage_operation_id is null and rollback_of_operation_id is null)
    or (operation_type='ACTIVATE' and stage_operation_id is not null and rollback_of_operation_id is null)
    or (operation_type='ROLLBACK' and stage_operation_id is null and rollback_of_operation_id is not null)
  ),
  constraint exam_release_operations_previous_state_check check (
    (previous_state_snapshot is null)=(previous_state_hash is null)
  ),
  constraint exam_release_operations_timestamps_check check (
    (started_at is null or started_at>=created_at)
    and (completed_at is null or (started_at is not null and completed_at>=started_at))
    and ((result_state in ('succeeded','failed'))=(completed_at is not null))
    and (result_state='requested' or started_at is not null)
    and ((result_state='failed')=(error_code is not null))
  )
);

create index exam_release_operations_exam_created_idx
  on exam_delivery.exam_release_operations(canonical_exam_key,created_at desc,id desc);
create index exam_release_operations_state_created_idx
  on exam_delivery.exam_release_operations(result_state,created_at desc);
create index exam_release_operations_stage_idx
  on exam_delivery.exam_release_operations(stage_operation_id)
  where stage_operation_id is not null;
create index exam_release_operations_rollback_idx
  on exam_delivery.exam_release_operations(rollback_of_operation_id)
  where rollback_of_operation_id is not null;

create table exam_delivery.exam_release_operation_events (
  id bigint generated always as identity primary key,
  operation_id uuid not null references exam_delivery.exam_release_operations(id) on delete restrict,
  sequence integer not null,
  event_state text not null,
  safe_details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default statement_timestamp(),
  constraint exam_release_operation_events_sequence_check check (sequence>0),
  constraint exam_release_operation_events_state_check check (
    event_state in ('requested','preflighted','executing','succeeded','failed')
  ),
  constraint exam_release_operation_events_details_check check (jsonb_typeof(safe_details)='object'),
  constraint exam_release_operation_events_order_unique unique(operation_id,sequence)
);

create index exam_release_operation_events_operation_time_idx
  on exam_delivery.exam_release_operation_events(operation_id,occurred_at,id);

-- Freeze the attempt set before the first migration-89 DDL that references it.
-- Attempt writers take ROW EXCLUSIVE, which conflicts with SHARE ROW
-- EXCLUSIVE, while ordinary SELECT remains available. NOWAIT makes an occupied
-- rollout window fail before backfill or a wait on the continuation FK.
lock table exam_delivery.attempts
in share row exclusive mode
nowait;

create table exam_delivery.attempt_continuation_contracts (
  attempt_id uuid primary key references exam_delivery.attempts(id) on delete restrict,
  contract_version integer not null default 1,
  purpose exam_delivery.attempt_purpose not null,
  expiry_mode text not null,
  assignment_binding_kind text not null,
  immediate_feedback boolean not null,
  review_release_policy text not null,
  answer_release_policy text not null,
  frozen_submit_after_expiry boolean not null default false,
  created_at timestamptz not null default statement_timestamp(),
  constraint attempt_continuation_contracts_version_check check (contract_version=1),
  constraint attempt_continuation_contracts_expiry_check check (
    (purpose in ('assigned_assessment','self_directed_exam') and expiry_mode='timed')
    or (purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice') and expiry_mode='practice_idle')
  ),
  constraint attempt_continuation_contracts_assignment_check check (
    assignment_binding_kind in ('none','protected_assignment','legacy_assignment','live_v2')
  ),
  constraint attempt_continuation_contracts_review_check check (
    review_release_policy in ('never','after_submission','immediate_study_feedback')
  ),
  constraint attempt_continuation_contracts_answer_check check (
    answer_release_policy in ('never','after_submission','immediate_study_feedback')
  )
);

alter table exam_delivery.exam_release_operations enable row level security;
alter table exam_delivery.exam_release_operation_events enable row level security;
alter table exam_delivery.attempt_continuation_contracts enable row level security;

revoke all on table exam_delivery.exam_release_operations,
  exam_delivery.exam_release_operation_events,
  exam_delivery.attempt_continuation_contracts
from public,anon,authenticated,service_role;
revoke all on sequence exam_delivery.exam_release_operation_events_id_seq
from public,anon,authenticated,service_role;

create function exam_delivery.examops_guard_operation_update()
returns trigger
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $$
declare
  v_allowed boolean:=false;
begin
  if tg_op='DELETE' then
    raise exception 'release_operation_delete_denied' using errcode='42501';
  end if;
  if row(new.request_id,new.request_hash,new.actor_id,new.canonical_exam_key,new.operation_type,
      new.target_package_id,new.stage_operation_id,new.rollback_of_operation_id,new.release_set,
      new.release_set_hash,new.manifest_hash,new.package_hash,new.validation_hash,
      new.release_diff_hash,new.expected_current_state_hash,new.created_at)
    is distinct from
    row(old.request_id,old.request_hash,old.actor_id,old.canonical_exam_key,old.operation_type,
      old.target_package_id,old.stage_operation_id,old.rollback_of_operation_id,old.release_set,
      old.release_set_hash,old.manifest_hash,old.package_hash,old.validation_hash,
      old.release_diff_hash,old.expected_current_state_hash,old.created_at) then
    raise exception 'release_operation_immutable' using errcode='42501';
  end if;
  if old.preflight_result is not null and new.preflight_result is distinct from old.preflight_result then
    raise exception 'release_operation_evidence_immutable' using errcode='42501';
  end if;
  if old.previous_state_snapshot is not null and
    row(new.previous_state_snapshot,new.previous_state_hash) is distinct from
    row(old.previous_state_snapshot,old.previous_state_hash) then
    raise exception 'release_operation_evidence_immutable' using errcode='42501';
  end if;
  if old.postcondition_result is not null and new.postcondition_result is distinct from old.postcondition_result then
    raise exception 'release_operation_evidence_immutable' using errcode='42501';
  end if;
  if old.started_at is not null and new.started_at is distinct from old.started_at
    or old.completed_at is not null and new.completed_at is distinct from old.completed_at
    or old.error_code is not null and new.error_code is distinct from old.error_code then
    raise exception 'release_operation_evidence_immutable' using errcode='42501';
  end if;
  if new is not distinct from old then
    return new;
  end if;
  v_allowed:=(old.result_state='requested' and new.result_state in ('preflighted','failed'))
    or (old.result_state='preflighted' and new.result_state in ('executing','succeeded','failed'))
    or (old.result_state='executing' and new.result_state in ('succeeded','failed'));
  if not v_allowed then
    raise exception 'release_operation_state_transition_denied' using errcode='42501';
  end if;
  return new;
end $$;

create trigger guard_exam_release_operation_update
before update or delete on exam_delivery.exam_release_operations
for each row execute function exam_delivery.examops_guard_operation_update();

create function exam_delivery.examops_guard_append_only()
returns trigger
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $$
begin
  raise exception 'append_only_mutation_denied' using errcode='42501';
end $$;

create trigger guard_exam_release_operation_events_append_only
before update or delete on exam_delivery.exam_release_operation_events
for each row execute function exam_delivery.examops_guard_append_only();

create trigger guard_attempt_continuation_contracts_immutable
before update or delete on exam_delivery.attempt_continuation_contracts
for each row execute function exam_delivery.examops_guard_append_only();

create function exam_delivery.examops_json_hash(p_value jsonb)
returns text
language sql
immutable
strict
set search_path=''
as $$
  select pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(exam_delivery.canonical_json(p_value),'UTF8'),
      'sha256'
    ),
    'hex'
  )
$$;

create function exam_delivery.build_attempt_continuation_contract(p_attempt_id uuid)
returns exam_delivery.attempt_continuation_contracts
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $$
declare
  v_attempt record;
  v_policy exam_delivery.practice_policies%rowtype;
  v_assignment public.exam_assignments%rowtype;
  v_protected exam_delivery.protected_assignments%rowtype;
  v_kind text:='none';
  v_expiry text;
  v_immediate boolean:=false;
  v_review text:='never';
  v_answer text:='never';
  v_frozen boolean:=false;
  v_contract exam_delivery.attempt_continuation_contracts%rowtype;
begin
  select a.*,pv.exam_key,pv.package_version,pv.declared_review_release_policy,
    pv.declared_answer_release_policy,pp.profile_key
  into v_attempt
  from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp
    on pp.id=a.package_profile_id and pp.package_version_id=a.package_version_id
  where a.id=p_attempt_id;
  if not found then
    raise exception 'CONTINUATION_CONTRACT_ATTEMPT_NOT_FOUND' using errcode='P0001';
  end if;

  if v_attempt.purpose in ('assigned_assessment','self_directed_exam') then
    if v_attempt.status='in_progress'
      and (v_attempt.expires_at is null or v_attempt.expires_at<=v_attempt.started_at) then
      raise exception 'CONTINUATION_CONTRACT_EXPIRY_INVALID' using errcode='P0001';
    end if;
    v_expiry:='timed';
  else
    if v_attempt.status='in_progress'
      and (v_attempt.practice_idle_expires_at is null
        or v_attempt.practice_idle_expires_at<=v_attempt.started_at) then
      raise exception 'CONTINUATION_CONTRACT_IDLE_EXPIRY_INVALID' using errcode='P0001';
    end if;
    v_expiry:='practice_idle';
  end if;

  if v_attempt.purpose<>'assigned_assessment' then
    select * into v_policy from exam_delivery.practice_policies policy
    where policy.canonical_exam_key=exam_delivery.normalize_exam_key(v_attempt.exam_key)
      and policy.package_version=v_attempt.package_version
      and policy.profile_key=v_attempt.profile_key
      and policy.purpose=v_attempt.purpose;
    if not found then
      raise exception 'CONTINUATION_CONTRACT_POLICY_AMBIGUOUS' using errcode='P0001';
    end if;
    v_immediate:=v_policy.immediate_feedback;
    v_review:=v_policy.review_release_policy;
    v_answer:=v_policy.answer_release_policy;
  end if;

  if v_attempt.source_assignment_id is not null then
    select * into v_assignment from public.exam_assignments assignment
    where assignment.id=v_attempt.source_assignment_id
      and assignment.exam_key is not null
      and exam_delivery.normalize_exam_key(assignment.exam_key)=exam_delivery.normalize_exam_key(v_attempt.exam_key)
      and (assignment.package_version_id is null or assignment.package_version_id=v_attempt.package_version_id)
      and (assignment.package_profile_id is null or assignment.package_profile_id=v_attempt.package_profile_id);
    if not found then
      raise exception 'CONTINUATION_CONTRACT_ASSIGNMENT_AMBIGUOUS' using errcode='P0001';
    end if;
    v_kind:=case when v_assignment.contract_version='live-v2' then 'live_v2' else 'legacy_assignment' end;
    v_review:=coalesce(v_attempt.assignment_review_release_policy,
      v_assignment.review_release_policy,v_review);
    v_answer:=coalesce(v_attempt.assignment_answer_release_policy,
      v_assignment.answer_release_policy,v_answer);
  elsif v_attempt.protected_assignment_id is not null then
    select * into v_protected from exam_delivery.protected_assignments assignment
    where assignment.id=v_attempt.protected_assignment_id
      and assignment.learner_id=v_attempt.owner_id
      and assignment.package_version_id=v_attempt.package_version_id
      and assignment.package_profile_id=v_attempt.package_profile_id;
    if not found then
      raise exception 'CONTINUATION_CONTRACT_ASSIGNMENT_AMBIGUOUS' using errcode='P0001';
    end if;
    v_kind:='protected_assignment';
    v_review:=coalesce(v_attempt.assignment_review_release_policy,
      v_protected.review_release_policy,v_review);
    v_answer:=coalesce(v_attempt.assignment_answer_release_policy,
      v_protected.answer_release_policy,v_answer);
  elsif v_attempt.purpose='assigned_assessment' then
    v_review:=coalesce(v_attempt.declared_review_release_policy,'never');
    v_answer:=coalesce(v_attempt.declared_answer_release_policy,'never');
  end if;

  v_frozen:=v_expiry='timed' and exists(
    select 1 from exam_delivery.package_questions question
    where question.package_version_id=v_attempt.package_version_id
      and question.question_type='executable-python-lab-v1'
  );

  insert into exam_delivery.attempt_continuation_contracts(
    attempt_id,contract_version,purpose,expiry_mode,assignment_binding_kind,
    immediate_feedback,review_release_policy,answer_release_policy,
    frozen_submit_after_expiry,created_at
  ) values(
    v_attempt.id,1,v_attempt.purpose,v_expiry,v_kind,v_immediate,v_review,v_answer,
    v_frozen,statement_timestamp()
  )
  on conflict(attempt_id) do nothing
  returning * into v_contract;

  if not found then
    select * into strict v_contract
    from exam_delivery.attempt_continuation_contracts contract
    where contract.attempt_id=v_attempt.id;
    if row(v_contract.contract_version,v_contract.purpose,v_contract.expiry_mode,
        v_contract.assignment_binding_kind,v_contract.immediate_feedback,
        v_contract.review_release_policy,v_contract.answer_release_policy,
        v_contract.frozen_submit_after_expiry)
      is distinct from
      row(1,v_attempt.purpose,v_expiry,v_kind,v_immediate,v_review,v_answer,v_frozen) then
      raise exception 'CONTINUATION_CONTRACT_CONFLICT' using errcode='P0001';
    end if;
  end if;
  return v_contract;
end $$;

do $$
declare
  v_attempt record;
begin
  for v_attempt in
    select attempt.id
    from exam_delivery.attempts attempt
    where attempt.status='in_progress'
      and (
        (attempt.purpose in ('assigned_assessment','self_directed_exam')
          and attempt.expires_at is not null
          and attempt.expires_at>statement_timestamp())
        or (attempt.purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice')
          and attempt.practice_idle_expires_at is not null
          and attempt.practice_idle_expires_at>statement_timestamp())
        or (attempt.purpose in ('assigned_assessment','self_directed_exam')
          and exists(
            select 1 from exam_delivery.python_submission_grading_sessions session
            where session.attempt_id=attempt.id
              and session.created_at<attempt.expires_at
          ))
      )
    order by attempt.id
  loop
    begin
      perform exam_delivery.build_attempt_continuation_contract(v_attempt.id);
    exception when others then
      raise exception 'BLOCKED_CONTINUATION_RISK' using errcode='P0001';
    end;
  end loop;
  if exists(
    select 1 from exam_delivery.attempts attempt
    left join exam_delivery.attempt_continuation_contracts contract
      on contract.attempt_id=attempt.id
    where attempt.status='in_progress'
      and contract.attempt_id is null
      and (
        (attempt.purpose in ('assigned_assessment','self_directed_exam')
          and attempt.expires_at>statement_timestamp())
        or (attempt.purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice')
          and attempt.practice_idle_expires_at>statement_timestamp())
        or exists(
          select 1 from exam_delivery.python_submission_grading_sessions session
          where session.attempt_id=attempt.id and session.created_at<attempt.expires_at
        )
      )
  ) then
    raise exception 'BLOCKED_CONTINUATION_RISK' using errcode='P0001';
  end if;
end $$;

create function exam_delivery.create_attempt_continuation_contract()
returns trigger
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $$
begin
  perform exam_delivery.build_attempt_continuation_contract(new.id);
  return new;
end $$;

create trigger create_attempt_continuation_contract_after_insert
after insert on exam_delivery.attempts
for each row execute function exam_delivery.create_attempt_continuation_contract();

create or replace function exam_delivery.authorize_attempt_continuation(
  p_attempt_id uuid,
  p_operation text
) returns jsonb
language plpgsql
stable
security definer
set search_path=''
set statement_timeout='5s'
as $$
declare
  v record;
  v_frozen_submission boolean:=false;
begin
  if p_attempt_id is null
    or p_operation not in ('resume','save_response','check_item','submit') then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end if;

  select a.owner_id,a.status,a.expires_at,a.practice_idle_expires_at,a.purpose,
    pv.exam_key,pp.profile_key,contract.expiry_mode,
    contract.frozen_submit_after_expiry
  into v
  from exam_delivery.attempts a
  join exam_delivery.package_versions pv on pv.id=a.package_version_id
  join exam_delivery.package_profiles pp
    on pp.id=a.package_profile_id and pp.package_version_id=a.package_version_id
  join exam_delivery.attempt_continuation_contracts contract
    on contract.attempt_id=a.id and contract.purpose=a.purpose
  where a.id=p_attempt_id;

  if not found then
    if exists(select 1 from exam_delivery.attempts attempt where attempt.id=p_attempt_id) then
      return jsonb_build_object('ok',false,'code','continuation_contract_missing');
    end if;
    return jsonb_build_object('ok',false,'code','attempt_not_found');
  end if;

  if v.expiry_mode='timed' and p_operation='submit'
    and v.frozen_submit_after_expiry then
    select exists(
      select 1 from exam_delivery.python_submission_grading_sessions session
      where session.attempt_id=p_attempt_id
        and session.created_at<v.expires_at
    ) into v_frozen_submission;
  end if;

  if v.status<>'in_progress' then
    return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition');
  end if;
  if v.expiry_mode='timed' and (
    v.expires_at is null
    or (statement_timestamp()>=v.expires_at and not v_frozen_submission)
  ) then
    return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition');
  end if;
  if v.expiry_mode='practice_idle' and (
    v.practice_idle_expires_at is null
    or statement_timestamp()>=v.practice_idle_expires_at
  ) then
    return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition');
  end if;
  if not exists(
    select 1 from public.profiles profile
    where profile.id=v.owner_id and profile.status='active'
  ) then
    return jsonb_build_object('ok',false,'code','inactive_account');
  end if;

  return jsonb_build_object(
    'ok',true,
    'ownerId',v.owner_id,
    'examKey',exam_delivery.normalize_exam_key(v.exam_key),
    'profileKey',v.profile_key,
    'purpose',v.purpose,
    'operation',p_operation
  );
end $$;

create or replace function exam_delivery.discover_current_attempt(
  p_actor_id uuid,
  p_exam_key text,
  p_package_version text,
  p_profile_key text,
  p_purpose text,
  p_language text
) returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $$
declare
  v_exam_key text:=exam_delivery.normalize_exam_key(p_exam_key);
  v_attempt_ids uuid[];
  v_authorization jsonb;
begin
  if p_actor_id is null or v_exam_key is null or p_package_version is null
    or p_package_version !~ '^[0-9]+\.[0-9]+\.[0-9]+$' or p_profile_key is null
    or p_purpose not in ('assigned_assessment','self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice')
    or p_language not in ('csharp','python','mixed','not_applicable') then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end if;
  if v_exam_key='ai901' and p_package_version='1.0.0'
    and p_purpose='assigned_assessment' and p_language='not_applicable'
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
    from exam_delivery.package_versions package
    join exam_delivery.package_profiles profile
      on profile.package_version_id=package.id
    where exam_delivery.normalize_exam_key(package.exam_key)=v_exam_key
      and package.package_version=p_package_version
      and profile.profile_key=p_profile_key
  ) then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end if;
  select coalesce(array_agg(candidate.id order by candidate.created_at desc),'{}'::uuid[])
  into v_attempt_ids
  from (
    select attempt.id,attempt.created_at
    from exam_delivery.attempts attempt
    join exam_delivery.package_versions package on package.id=attempt.package_version_id
    join exam_delivery.package_profiles profile on profile.id=attempt.package_profile_id
    where attempt.owner_id=p_actor_id
      and exam_delivery.normalize_exam_key(package.exam_key)=v_exam_key
      and package.package_version=p_package_version
      and profile.profile_key=p_profile_key
      and attempt.purpose::text=p_purpose
      and attempt.language_preference=p_language
      and attempt.status='in_progress'
      and (
        (attempt.purpose in ('assigned_assessment','self_directed_exam')
          and statement_timestamp()<attempt.expires_at)
        or (attempt.purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice')
          and statement_timestamp()<attempt.practice_idle_expires_at)
      )
    order by attempt.created_at desc
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
end $$;

create or replace function exam_delivery.start_assignment_attempt(
  p_actor_id uuid,
  p_exam_key text,
  p_profile_key text,
  p_request_id uuid,
  p_assignment_id uuid
) returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='15s'
as $$
declare
  v_key text:=exam_delivery.normalize_exam_key(p_exam_key);
  v_now timestamptz:=statement_timestamp();
  v_existing exam_delivery.attempts%rowtype;
  v_assignment public.exam_assignments%rowtype;
  v_package record;
  v_attempt exam_delivery.attempts%rowtype;
  v_count integer;
  v_eligibility jsonb;
begin
  if p_actor_id is null or p_request_id is null or p_assignment_id is null then
    return jsonb_build_object('ok',false,'code','invalid_request');
  end if;
  select * into v_existing from exam_delivery.attempts
  where owner_id=p_actor_id and client_request_id=p_request_id;
  if found then
    if v_existing.source_assignment_id=p_assignment_id then
      return exam_delivery.resume_attempt(p_actor_id,v_existing.id);
    end if;
    return jsonb_build_object('ok',false,'code','attempt_conflict');
  end if;
  select * into v_assignment
  from public.exam_assignments assignment
  where assignment.id=p_assignment_id
    and assignment.status='active'
    and (assignment.available_from is null or assignment.available_from<=v_now)
    and (assignment.due_at is null or assignment.due_at>v_now)
  for update;
  if not found or exam_delivery.normalize_exam_key(v_assignment.exam_key)<>v_key
    or nullif(v_assignment.profile_id,'') is null
    or v_assignment.profile_id<>p_profile_key then
    return jsonb_build_object('ok',false,'code','assignment_conflict');
  end if;
  if not (
    v_assignment.student_user_id=p_actor_id
    or (v_assignment.student_user_id is null
      and v_assignment.group_id is not null
      and exists(
        select 1 from public.memberships membership
        where membership.user_id=p_actor_id
          and membership.status='active'
          and membership.role='student'
          and membership.organisation_id=v_assignment.organisation_id
          and membership.group_id=v_assignment.group_id
          and (v_assignment.campus_id is null
            or membership.campus_id=v_assignment.campus_id)
      ))
  ) then
    return jsonb_build_object('ok',false,'code','not_assigned');
  end if;

  if v_assignment.contract_version='live-v2' then
    select package.id package_version_id,package.generator_version,
      package.scorer_version,profile.id package_profile_id,
      profile.time_limit_minutes
    into strict v_package
    from exam_delivery.package_versions package
    join exam_delivery.package_profiles profile
      on profile.package_version_id=package.id
      and profile.id=v_assignment.package_profile_id
    where package.id=v_assignment.package_version_id
      and package.status='published'
      and package.package_schema_version='certsim-protected-package-v2'
      and exam_delivery.package_v2_runtime_supported(
        package.generator_version,package.scorer_version
      )
    for share of package,profile;
    select count(*) into v_count
    from exam_delivery.attempts attempt
    where attempt.source_assignment_id=v_assignment.id
      and attempt.status<>'voided';
    if v_assignment.maximum_attempts is null
      or v_count>=v_assignment.maximum_attempts then
      return jsonb_build_object('ok',false,'code','assignment_attempt_limit_reached');
    end if;
  else
    v_eligibility:=exam_delivery.check_eligibility_v2(
      p_actor_id,p_exam_key,p_profile_key
    );
    if not coalesce((v_eligibility->>'eligible')::boolean,false) then
      return jsonb_build_object('ok',false,'code',v_eligibility->>'reasonCode');
    end if;
    select package.id package_version_id,package.generator_version,
      package.scorer_version,profile.id package_profile_id,
      profile.time_limit_minutes
    into strict v_package
    from exam_delivery.resolve_package_profile_default(
      v_key,p_profile_key,'assigned_assessment'
    ) default_binding
    join exam_delivery.package_versions package
      on package.id=default_binding.package_version_id
    join exam_delivery.package_profiles profile
      on profile.id=default_binding.package_profile_id
    for share of package,profile;
  end if;

  insert into exam_delivery.attempts(
    owner_id,package_version_id,package_profile_id,protected_assignment_id,
    client_request_id,status,generator_version,scorer_version,created_at,
    started_at,expires_at,purpose,source_assignment_id,source_organisation_id,
    source_campus_id,source_group_id,attribution_source,
    assignment_review_release_policy,assignment_answer_release_policy
  ) values(
    p_actor_id,v_package.package_version_id,v_package.package_profile_id,null,
    p_request_id,'in_progress',v_package.generator_version,v_package.scorer_version,
    v_now,v_now,v_now+make_interval(mins=>v_package.time_limit_minutes),
    'assigned_assessment',v_assignment.id,v_assignment.organisation_id,
    v_assignment.campus_id,v_assignment.group_id,'assignment',
    case when v_assignment.contract_version='live-v2'
      then v_assignment.review_release_policy end,
    case when v_assignment.contract_version='live-v2'
      then v_assignment.answer_release_policy end
  ) returning * into v_attempt;
  perform exam_delivery.materialize_attempt_items(v_attempt.id,p_request_id,null);
  return exam_delivery.resume_attempt(p_actor_id,v_attempt.id);
exception
  when no_data_found or too_many_rows then
    return jsonb_build_object('ok',false,'code','package_unavailable');
  when unique_violation then
    select * into v_existing from exam_delivery.attempts
    where owner_id=p_actor_id and client_request_id=p_request_id;
    if found and v_existing.source_assignment_id=p_assignment_id then
      return exam_delivery.resume_attempt(p_actor_id,v_existing.id);
    end if;
    return jsonb_build_object('ok',false,'code','attempt_conflict');
end $$;

create or replace function exam_delivery.check_practice_item(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_item_id uuid,
  p_expected_revision integer,
  p_request_id uuid
) returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $$
declare
  v record;
  v_score jsonb;
  v_release exam_delivery.practice_feedback_releases%rowtype;
  v_authorization jsonb;
begin
  v_authorization:=exam_delivery.authorize_attempt_continuation(
    p_attempt_id,'check_item'
  );
  if not coalesce((v_authorization->>'ok')::boolean,false) then
    return v_authorization;
  end if;
  if (v_authorization->>'ownerId')::uuid<>p_actor_id then
    return jsonb_build_object('ok',false,'code','attempt_not_found');
  end if;
  select attempt.purpose,attempt.status,attempt.scorer_version,response.revision,
    response.response_payload,question.question_type,item.presentation_snapshot,
    protected.scoring_snapshot,protected.review_snapshot,contract.immediate_feedback
  into v
  from exam_delivery.attempts attempt
  join exam_delivery.attempt_continuation_contracts contract
    on contract.attempt_id=attempt.id
  join exam_delivery.attempt_items item on item.attempt_id=attempt.id
  join exam_delivery.attempt_responses response
    on response.attempt_id=attempt.id and response.attempt_item_id=item.id
  join exam_delivery.package_questions question on question.id=item.package_question_id
  join exam_delivery.attempt_item_protected_content protected
    on protected.attempt_item_id=item.id
  where attempt.id=p_attempt_id
    and attempt.source_assignment_id is null
    and item.id=p_item_id
  for update of attempt;
  if not found or v.status<>'in_progress' or not v.immediate_feedback then
    return jsonb_build_object('ok',false,'code','review_unavailable');
  end if;
  if v.revision<>p_expected_revision then
    return jsonb_build_object('ok',false,'code','stale_response');
  end if;
  insert into exam_delivery.practice_feedback_releases(
    attempt_id,attempt_item_id,response_revision,request_id
  ) values(p_attempt_id,p_item_id,p_expected_revision,p_request_id)
  on conflict(attempt_id,attempt_item_id,response_revision) do update
    set request_id=exam_delivery.practice_feedback_releases.request_id
  returning * into v_release;
  v_score:=exam_delivery.score_package_v2_response_for_scorer(
    v.scorer_version,v.question_type,v.presentation_snapshot,
    v.scoring_snapshot,v.response_payload,true
  );
  return jsonb_build_object(
    'ok',true,'itemId',p_item_id,'revision',p_expected_revision,
    'status',v_score->>'status','earnedPoints',(v_score->>'earned')::numeric,
    'maxPoints',(v_score->>'maximum')::numeric,'review',v.review_snapshot,
    'releasedAt',v_release.released_at
  );
end $$;

create or replace function exam_delivery.submit_attempt_v2(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_submission_id uuid
) returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='15s'
as $$
declare
  v_authorization jsonb;
  v_result jsonb;
  v_existing uuid;
  v_release boolean:=false;
  v_trusted boolean:=false;
begin
  select result.submission_id into v_existing
  from exam_delivery.attempt_results result
  join exam_delivery.attempts attempt on attempt.id=result.attempt_id
  where result.attempt_id=p_attempt_id and attempt.owner_id=p_actor_id;
  if found then
    if v_existing=p_submission_id then
      return exam_delivery.get_result(p_actor_id,p_attempt_id);
    end if;
    return jsonb_build_object('ok',false,'code','submission_conflict');
  end if;

  select exists(
    select 1
    from exam_delivery.python_submission_grading_sessions session
    join exam_delivery.attempts attempt on attempt.id=session.attempt_id
    where session.attempt_id=p_attempt_id
      and session.submission_id=p_submission_id
      and attempt.owner_id=p_actor_id
  ) into v_trusted;

  v_authorization:=exam_delivery.authorize_attempt_continuation(
    p_attempt_id,'submit'
  );
  if not coalesce((v_authorization->>'ok')::boolean,false) then
    return v_authorization;
  end if;
  if (v_authorization->>'ownerId')::uuid<>p_actor_id then
    return jsonb_build_object('ok',false,'code','attempt_not_found');
  end if;

  if v_trusted and exists(
    select 1
    from exam_delivery.attempt_items item
    join exam_delivery.package_questions question
      on question.id=item.package_question_id
    join exam_delivery.python_lab_workspaces workspace
      on workspace.attempt_id=item.attempt_id
      and workspace.attempt_item_id=item.id
    where item.attempt_id=p_attempt_id
      and question.question_type='executable-python-lab-v1'
      and not exists(
        select 1
        from exam_delivery.python_submission_grading_runs submission_run
        join exam_delivery.python_grading_evidence evidence
          on evidence.run_id=submission_run.run_id
        where submission_run.attempt_id=p_attempt_id
          and submission_run.submission_id=p_submission_id
          and submission_run.attempt_item_id=item.id
      )
  ) then
    return jsonb_build_object('ok',false,'code','grading_incomplete');
  end if;

  perform set_config('certsim.attempt_continuation_id',p_attempt_id::text,true);
  perform set_config('certsim.attempt_continuation_operation','submit',true);
  v_result:=case when v_trusted
    then exam_delivery.submit_attempt_v2_with_trusted_grading(
      p_actor_id,p_attempt_id,p_submission_id
    )
    else exam_delivery.submit_attempt_v2_with_assessment_gate(
      p_actor_id,p_attempt_id,p_submission_id
    )
  end;
  perform set_config('certsim.attempt_continuation_id','',true);
  perform set_config('certsim.attempt_continuation_operation','',true);

  if coalesce((v_result->>'ok')::boolean,false) then
    select contract.review_release_policy in ('after_submission','immediate_study_feedback')
    into v_release
    from exam_delivery.attempt_continuation_contracts contract
    where contract.attempt_id=p_attempt_id;
    if coalesce(v_release,false) then
      update exam_delivery.review_snapshots
      set release_status='released',released_at=statement_timestamp()
      where attempt_id=p_attempt_id and release_status='withheld';
      update public.exam_reports
      set report_snapshot=jsonb_set(
        report_snapshot,'{reviewStatus}','"released"'::jsonb,true
      )
      where attempt_id=p_attempt_id
        and report_type='study_report_snapshot';
    end if;
    return exam_delivery.get_result(p_actor_id,p_attempt_id);
  end if;
  return v_result;
end $$;

create or replace function exam_delivery.get_review(
  p_actor_id uuid,
  p_attempt_id uuid
) returns jsonb
language sql
stable
security definer
set search_path=''
set statement_timeout='5s'
as $$
  select case
    when not exists(
      select 1 from exam_delivery.attempts attempt
      where attempt.id=p_attempt_id
        and attempt.owner_id=p_actor_id
        and attempt.status='completed'
    ) then jsonb_build_object('ok',false,'code','attempt_not_found')
    when not exists(
      select 1
      from exam_delivery.review_snapshots review
      join exam_delivery.attempts attempt on attempt.id=review.attempt_id
      left join exam_delivery.attempt_continuation_contracts contract
        on contract.attempt_id=attempt.id
      where review.attempt_id=p_attempt_id
        and attempt.owner_id=p_actor_id
        and review.release_status='released'
        and (
          contract.review_release_policy in ('after_submission','immediate_study_feedback')
          or (contract.attempt_id is null and (
            (attempt.source_assignment_id is not null
              and attempt.assignment_review_release_policy='after_submission')
            or attempt.source_assignment_id is null
          ))
        )
    ) then jsonb_build_object('ok',false,'code','review_unavailable')
    else (
      select jsonb_build_object(
        'ok',true,
        'review',case
          when coalesce(
            contract.answer_release_policy,
            attempt.assignment_answer_release_policy,
            case when attempt.source_assignment_id is null
              then 'after_submission' else 'never' end
          )='never' then
            jsonb_set(
              review.review_payload,
              '{items}',
              coalesce((
                select jsonb_agg(item.value-'correctAnswer')
                from jsonb_array_elements(
                  coalesce(review.review_payload->'items','[]'::jsonb)
                ) item
              ),'[]'::jsonb),
              false
            )
          else review.review_payload
        end
      )
      from exam_delivery.review_snapshots review
      join exam_delivery.attempts attempt on attempt.id=review.attempt_id
      left join exam_delivery.attempt_continuation_contracts contract
        on contract.attempt_id=attempt.id
      where review.attempt_id=p_attempt_id
    )
  end
$$;

create function exam_delivery.examops_actor_is_platform_owner(p_actor_id uuid)
returns boolean
language sql
stable
security definer
set search_path=''
set statement_timeout='5s'
as $$
  select p_actor_id is not null and exists(
    select 1
    from public.profiles profile
    join public.memberships membership on membership.user_id=profile.id
    where profile.id=p_actor_id
      and profile.status='active'
      and membership.status='active'
      and membership.role='platform_owner'
  )
$$;

create function exam_delivery.release_configuration_snapshot(p_exam_key text)
returns jsonb
language sql
stable
security definer
set search_path=''
set statement_timeout='10s'
as $$
  with params as (
    select exam_delivery.normalize_exam_key(p_exam_key) exam_key
  ), defaults_json as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'profileKey',binding.profile_key,
      'purpose',binding.purpose,
      'packageVersionId',binding.package_version_id,
      'packageProfileId',binding.package_profile_id
    ) order by binding.profile_key,binding.purpose),'[]'::jsonb) value
    from exam_delivery.package_profile_defaults binding,params
    where binding.canonical_exam_key=params.exam_key and binding.enabled
  ), activations_json as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'packageVersionId',activation.package_version_id,
      'packageProfileId',activation.package_profile_id,
      'profileKey',profile.profile_key,
      'activationKind',activation.activation_kind
    ) order by package.package_version,profile.profile_key,activation.activation_kind),
      '[]'::jsonb) value
    from exam_delivery.exam_profile_activations activation
    join exam_delivery.package_versions package on package.id=activation.package_version_id
    join exam_delivery.package_profiles profile
      on profile.id=activation.package_profile_id
      and profile.package_version_id=package.id
    join params on exam_delivery.normalize_exam_key(package.exam_key)=params.exam_key
    where activation.enabled and activation.activation_kind='production'
  ), policies_json as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'packageVersion',policy.package_version,
      'profileKey',policy.profile_key,
      'purpose',policy.purpose,
      'accessMode',policy.access_mode,
      'maximumCompletedAttempts',policy.maximum_completed_attempts,
      'cooldownSeconds',policy.cooldown_seconds,
      'maximumConcurrentSessions',policy.maximum_concurrent_sessions,
      'maximumSessionItems',policy.maximum_session_items,
      'immediateFeedback',policy.immediate_feedback,
      'reviewReleasePolicy',policy.review_release_policy,
      'answerReleasePolicy',policy.answer_release_policy
    ) order by policy.package_version,policy.profile_key,policy.purpose),
      '[]'::jsonb) value
    from exam_delivery.practice_policies policy,params
    where policy.canonical_exam_key=params.exam_key
      and policy.enabled and policy.access_mode<>'disabled'
  ), catalogue_json as (
    select jsonb_build_object(
      'currentVersion',catalogue.current_version,
      'status',catalogue.status,
      'lifecycle',catalogue.lifecycle
    ) value
    from public.exam_catalog catalogue,params
    where exam_delivery.normalize_exam_key(catalogue.exam_key)=params.exam_key
  )
  select jsonb_build_object(
    'schemaVersion','certsim-release-configuration-snapshot-v1',
    'examKey',(select exam_key from params),
    'defaults',(select value from defaults_json),
    'activations',(select value from activations_json),
    'practicePolicies',(select value from policies_json),
    'catalogue',(select value from catalogue_json)
  )
$$;

create function exam_delivery.release_configuration_hash(p_exam_key text)
returns text
language sql
stable
security definer
set search_path=''
set statement_timeout='10s'
as $$
  select exam_delivery.examops_json_hash(
    exam_delivery.release_configuration_snapshot(p_exam_key)
  )
$$;

create function exam_delivery.validate_current_exam_release_configuration(
  p_exam_key text
) returns jsonb
language plpgsql
stable
security definer
set search_path=''
set statement_timeout='10s'
as $$
declare
  v_exam text:=exam_delivery.normalize_exam_key(p_exam_key);
  v_default_count integer:=0;
  v_package_count integer:=0;
  v_package_id uuid;
  v_package exam_delivery.package_versions%rowtype;
  v_profile_count integer:=0;
  v_activation_count integer:=0;
  v_policy_count integer:=0;
  v_catalogue_count integer:=0;
  v_catalogue public.exam_catalog%rowtype;
  v_findings text[]:='{}'::text[];
begin
  select count(*)::integer,count(distinct binding.package_version_id)::integer,
    count(distinct binding.profile_key)::integer
  into v_default_count,v_package_count,v_profile_count
  from exam_delivery.package_profile_defaults binding
  where binding.canonical_exam_key=v_exam and binding.enabled;

  if v_default_count=0 then
    v_findings:=pg_catalog.array_append(v_findings,'CURRENT_PACKAGE_UNRESOLVED');
  elsif v_package_count<>1 then
    v_findings:=pg_catalog.array_append(v_findings,'CURRENT_PACKAGE_AMBIGUOUS');
  else
    select binding.package_version_id into v_package_id
    from exam_delivery.package_profile_defaults binding
    where binding.canonical_exam_key=v_exam and binding.enabled
    limit 1;

    select * into v_package
    from exam_delivery.package_versions package
    where package.id=v_package_id
      and exam_delivery.normalize_exam_key(package.exam_key)=v_exam;
    if not found then
      v_findings:=pg_catalog.array_append(v_findings,'CURRENT_PACKAGE_UNRESOLVED');
    else
      if v_package.status<>'published' then
        v_findings:=pg_catalog.array_append(v_findings,'CURRENT_PACKAGE_NOT_PUBLISHED');
      end if;
      if v_package.package_schema_version<>'certsim-protected-package-v2'
        or not exam_delivery.package_v2_runtime_supported(
          v_package.generator_version,v_package.scorer_version
        ) then
        v_findings:=pg_catalog.array_append(v_findings,'CURRENT_RUNTIME_UNSUPPORTED');
      end if;
    end if;
  end if;

  if exists(
    select 1
    from exam_delivery.package_profile_defaults binding
    left join exam_delivery.package_profiles profile
      on profile.id=binding.package_profile_id
      and profile.package_version_id=binding.package_version_id
    where binding.canonical_exam_key=v_exam and binding.enabled
      and (
        v_package_id is null
        or binding.package_version_id<>v_package_id
        or profile.id is null
        or profile.profile_key<>binding.profile_key
      )
  ) then
    v_findings:=pg_catalog.array_append(v_findings,'CURRENT_DEFAULT_BINDING_INVALID');
  end if;

  select count(distinct binding.profile_key)::integer into v_activation_count
  from exam_delivery.package_profile_defaults binding
  where binding.canonical_exam_key=v_exam and binding.enabled
    and binding.package_version_id=v_package_id
    and exists(
      select 1
      from exam_delivery.exam_profile_activations activation
      where activation.package_version_id=binding.package_version_id
        and activation.package_profile_id=binding.package_profile_id
        and activation.activation_kind='production'
        and activation.enabled
    );
  if v_default_count>0 and v_activation_count<>v_profile_count then
    v_findings:=pg_catalog.array_append(v_findings,'CURRENT_ACTIVATION_MISSING');
  end if;

  select count(*)::integer into v_policy_count
  from exam_delivery.package_profile_defaults binding
  where binding.canonical_exam_key=v_exam and binding.enabled
    and binding.package_version_id=v_package_id
    and binding.purpose<>'assigned_assessment'
    and exists(
      select 1
      from exam_delivery.practice_policies policy
      where policy.canonical_exam_key=v_exam
        and policy.package_version=v_package.package_version
        and policy.profile_key=binding.profile_key
        and policy.purpose=binding.purpose
        and policy.enabled
        and policy.access_mode<>'disabled'
    );
  if exists(
    select 1
    from exam_delivery.package_profile_defaults binding
    where binding.canonical_exam_key=v_exam and binding.enabled
      and binding.purpose<>'assigned_assessment'
      and not exists(
        select 1
        from exam_delivery.practice_policies policy
        where policy.canonical_exam_key=v_exam
          and policy.package_version=v_package.package_version
          and policy.profile_key=binding.profile_key
          and policy.purpose=binding.purpose
          and policy.enabled
          and policy.access_mode<>'disabled'
      )
  ) then
    v_findings:=pg_catalog.array_append(
      v_findings,'PRACTICE_POLICY_MISSING_OR_DISABLED'
    );
  end if;

  select count(*)::integer into v_catalogue_count
  from public.exam_catalog catalogue
  where exam_delivery.normalize_exam_key(catalogue.exam_key)=v_exam;
  if v_catalogue_count=0 then
    v_findings:=pg_catalog.array_append(v_findings,'CURRENT_CATALOGUE_MISSING');
  elsif v_catalogue_count<>1 then
    v_findings:=pg_catalog.array_append(v_findings,'CURRENT_CATALOGUE_AMBIGUOUS');
  else
    select * into v_catalogue
    from public.exam_catalog catalogue
    where exam_delivery.normalize_exam_key(catalogue.exam_key)=v_exam;
    if v_package_id is null
      or v_catalogue.current_version is distinct from v_package.package_version then
      v_findings:=pg_catalog.array_append(
        v_findings,'CURRENT_CATALOGUE_VERSION_MISMATCH'
      );
    end if;
    if v_catalogue.status<>'active'
      or v_catalogue.lifecycle<>'production_ready' then
      v_findings:=pg_catalog.array_append(v_findings,'CURRENT_CATALOGUE_STATE_INVALID');
    end if;
  end if;

  return jsonb_build_object(
    'ok',pg_catalog.cardinality(v_findings)=0,
    'outcome',case when pg_catalog.cardinality(v_findings)=0
      then 'CURRENT_STATE_VALID' else 'BLOCKED_CURRENT_STATE_INVALID' end,
    'code',case when pg_catalog.cardinality(v_findings)=0
      then null else v_findings[1] end,
    'currentPackageVersion',v_package.package_version,
    'defaultCount',v_default_count,
    'activationCount',v_activation_count,
    'policyCount',v_policy_count,
    'findingCodes',pg_catalog.to_jsonb(v_findings)
  );
end $$;

create function exam_delivery.examops_validate_release_set(p_request jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
set statement_timeout='10s'
as $$
declare
  v_exam text;
  v_target_id uuid;
  v_release_set jsonb;
  v_release_hash text;
  v_current_hash text;
  v_package exam_delivery.package_versions%rowtype;
  v_profile jsonb;
  v_profile_id uuid;
  v_profile_count integer;
  v_binding_count integer;
  v_policy_count integer;
begin
  if jsonb_typeof(p_request)<>'object' then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','RELEASE_REQUEST_INVALID');
  end if;
  begin
    v_exam:=exam_delivery.normalize_exam_key(p_request->>'examKey');
    v_target_id:=(p_request->>'targetPackageId')::uuid;
  exception when others then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','RELEASE_REQUEST_INVALID');
  end;
  v_release_set:=p_request->'releaseSet';
  if v_exam is null or v_target_id is null or jsonb_typeof(v_release_set)<>'object'
    or v_release_set->>'schemaVersion'<>'certsim-exam-release-set-v1'
    or exam_delivery.normalize_exam_key(v_release_set->>'examKey')<>v_exam
    or v_release_set->>'targetPackageId'<>v_target_id::text
    or not (v_release_set ?& array[
      'schemaVersion','examKey','targetPackageId','profiles','catalogue'
    ])
    or jsonb_typeof(v_release_set->'profiles')<>'array'
    or jsonb_array_length(v_release_set->'profiles')=0
    or jsonb_typeof(v_release_set->'catalogue')<>'object'
    or not ((v_release_set->'catalogue') ?& array['currentVersion','status']) then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','RELEASE_SET_INVALID');
  end if;

  v_release_hash:=exam_delivery.examops_json_hash(v_release_set);
  if p_request->>'releaseSetHash'<>v_release_hash
    or coalesce(p_request->>'manifestHash','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_request->>'packageHash','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_request->>'validationHash','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_request->>'releaseDiffHash','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_request->>'expectedCurrentStateHash','') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','CANDIDATE_EVIDENCE_MISMATCH');
  end if;

  select * into v_package
  from exam_delivery.package_versions package
  where package.id=v_target_id
    and exam_delivery.normalize_exam_key(package.exam_key)=v_exam
    and package.status='published'
    and package.package_schema_version='certsim-protected-package-v2'
    and exam_delivery.package_v2_runtime_supported(
      package.generator_version,package.scorer_version
    );
  if not found or v_package.package_hash<>p_request->>'packageHash'
    or v_package.validation_hash<>p_request->>'validationHash'
    or v_release_set#>>'{catalogue,currentVersion}'<>v_package.package_version
    or v_release_set#>>'{catalogue,status}'<>'active' then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','CANDIDATE_EVIDENCE_MISMATCH');
  end if;

  select count(*)::integer,count(distinct profile->>'profileKey')::integer
  into v_profile_count,v_binding_count
  from jsonb_array_elements(v_release_set->'profiles') profile;
  if v_profile_count<>v_binding_count then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','RELEASE_SET_INVALID');
  end if;

  for v_profile in
    select profile.value
    from jsonb_array_elements(v_release_set->'profiles') profile(value)
    order by profile.value->>'profileKey'
  loop
    begin
      v_profile_id:=(v_profile->>'targetProfileId')::uuid;
    exception when others then
      return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
        'code','RELEASE_SET_INVALID');
    end;
    if jsonb_typeof(v_profile)<>'object'
      or not (v_profile ?& array[
        'profileKey','targetProfileId','bindings','practicePolicies'
      ])
      or nullif(btrim(v_profile->>'profileKey'),'') is null
      or jsonb_typeof(v_profile->'bindings')<>'array'
      or jsonb_typeof(v_profile->'practicePolicies')<>'array'
      or not exists(
        select 1 from exam_delivery.package_profiles profile
        where profile.id=v_profile_id
          and profile.package_version_id=v_target_id
          and profile.profile_key=v_profile->>'profileKey'
      ) then
      return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
        'code','RELEASE_SET_INVALID');
    end if;

    select count(*)::integer,count(distinct binding->>'purpose')::integer
    into v_binding_count,v_policy_count
    from jsonb_array_elements(v_profile->'bindings') binding;
    if v_binding_count<>6 or v_policy_count<>6 or exists(
      select 1 from jsonb_array_elements(v_profile->'bindings') binding
      where jsonb_typeof(binding)<>'object'
        or not (binding ?& array['purpose','action'])
        or binding->>'purpose' not in (
        'assigned_assessment','self_directed_exam','study_sandbox',
        'targeted_domain','weak_area','pbq_practice'
      ) or binding->>'action'<>'MOVE'
    ) then
      return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
        'code','RELEASE_SET_INVALID');
    end if;

    select count(*)::integer,count(distinct policy->>'purpose')::integer
    into v_policy_count,v_binding_count
    from jsonb_array_elements(v_profile->'practicePolicies') policy;
    if v_policy_count<>5 or v_binding_count<>5 or exists(
      select 1 from jsonb_array_elements(v_profile->'practicePolicies') policy
      where jsonb_typeof(policy)<>'object'
        or not (policy ?& array[
          'purpose','accessMode','enabled','maximumCompletedAttempts',
          'cooldownSeconds','maximumConcurrentSessions','maximumSessionItems',
          'immediateFeedback','reviewReleasePolicy','answerReleasePolicy'
        ])
        or jsonb_typeof(policy->'enabled')<>'boolean'
        or jsonb_typeof(policy->'immediateFeedback')<>'boolean'
        or policy->>'purpose' not in (
        'self_directed_exam','study_sandbox','targeted_domain',
        'weak_area','pbq_practice'
      )
        or policy->>'accessMode' not in (
          'open_authenticated','organisation_scoped','assignment_required',
          'controlled_beta','production_authorized'
        )
        or coalesce((policy->>'enabled')::boolean,false) is not true
        or (policy->>'maximumConcurrentSessions')::integer<>1
        or (policy->>'maximumSessionItems')::integer not between 10 and 100
        or (policy->>'cooldownSeconds')::integer not between 0 and 2592000
        or policy->>'reviewReleasePolicy' not in (
          'never','after_submission','immediate_study_feedback'
        )
        or policy->>'answerReleasePolicy' not in (
          'never','after_submission','immediate_study_feedback'
        )
    ) then
      return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
        'code','RELEASE_SET_INVALID');
    end if;
  end loop;

  if not exists(
    select 1 from public.exam_catalog catalogue
    where exam_delivery.normalize_exam_key(catalogue.exam_key)=v_exam
  ) then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_CURRENT_STATE_INVALID',
      'code','CURRENT_CATALOGUE_MISSING');
  end if;

  if exists(
    select 1
    from exam_delivery.package_profile_defaults binding
    where binding.canonical_exam_key=v_exam and binding.enabled
      and not exists(
        select 1
        from jsonb_array_elements(v_release_set->'profiles') profile,
          jsonb_array_elements(profile->'bindings') requested_binding
        where profile->>'profileKey'=binding.profile_key
          and requested_binding->>'purpose'=binding.purpose::text
          and requested_binding->>'action'='MOVE'
      )
  ) then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_CURRENT_STATE_INVALID',
      'code','CURRENT_BINDING_COVERAGE_INCOMPLETE');
  end if;

  v_current_hash:=exam_delivery.release_configuration_hash(v_exam);
  if v_current_hash<>p_request->>'expectedCurrentStateHash' then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_CURRENT_STATE_INVALID',
      'code','RELEASE_STATE_CHANGED','currentStateHash',v_current_hash,
      'releaseSetHash',v_release_hash);
  end if;

  return jsonb_build_object(
    'ok',true,'examKey',v_exam,'targetPackageId',v_target_id,
    'targetPackageVersion',v_package.package_version,
    'releaseSetHash',v_release_hash,'currentStateHash',v_current_hash,
    'profileCount',v_profile_count
  );
exception when invalid_text_representation or invalid_parameter_value
  or numeric_value_out_of_range then
  return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
    'code','RELEASE_SET_INVALID');
end $$;

create function exam_delivery.preflight_exam_release(
  p_actor_id uuid,
  p_request jsonb
) returns jsonb
language plpgsql
stable
security definer
set search_path=''
set statement_timeout='15s'
as $$
declare
  v_validation jsonb;
  v_current_validation jsonb;
  v_exam text;
  v_target uuid;
  v_target_active integer:=0;
  v_displaced_timed integer:=0;
  v_displaced_practice integer:=0;
  v_frozen integer:=0;
  v_missing integer:=0;
  v_outcome text;
begin
  if not exam_delivery.examops_actor_is_platform_owner(p_actor_id) then
    raise exception 'examops_forbidden' using errcode='42501';
  end if;
  v_validation:=exam_delivery.examops_validate_release_set(p_request);
  if not coalesce((v_validation->>'ok')::boolean,false) then
    return v_validation;
  end if;
  v_exam:=v_validation->>'examKey';
  v_target:=(v_validation->>'targetPackageId')::uuid;
  v_current_validation:=
    exam_delivery.validate_current_exam_release_configuration(v_exam);
  if not coalesce((v_current_validation->>'ok')::boolean,false) then
    return v_validation || v_current_validation || jsonb_build_object(
      'ok',false,'outcome','BLOCKED_CURRENT_STATE_INVALID'
    );
  end if;

  with continuable as (
    select attempt.id,attempt.package_version_id,attempt.purpose,
      contract.attempt_id is not null has_contract,
      exists(
        select 1 from exam_delivery.python_submission_grading_sessions session
        where session.attempt_id=attempt.id
          and session.created_at<attempt.expires_at
      ) frozen
    from exam_delivery.attempts attempt
    join exam_delivery.package_versions package on package.id=attempt.package_version_id
    left join exam_delivery.attempt_continuation_contracts contract
      on contract.attempt_id=attempt.id
    where exam_delivery.normalize_exam_key(package.exam_key)=v_exam
      and attempt.status='in_progress'
      and (
        (attempt.purpose in ('assigned_assessment','self_directed_exam')
          and attempt.expires_at>statement_timestamp())
        or (attempt.purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice')
          and attempt.practice_idle_expires_at>statement_timestamp())
        or exists(
          select 1 from exam_delivery.python_submission_grading_sessions session
          where session.attempt_id=attempt.id
            and session.created_at<attempt.expires_at
        )
      )
  )
  select
    count(*) filter(where package_version_id=v_target),
    count(*) filter(where package_version_id<>v_target
      and purpose in ('assigned_assessment','self_directed_exam')),
    count(*) filter(where package_version_id<>v_target
      and purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice')),
    count(*) filter(where package_version_id<>v_target and frozen),
    count(*) filter(where package_version_id<>v_target and not has_contract)
  into v_target_active,v_displaced_timed,v_displaced_practice,v_frozen,v_missing
  from continuable;

  v_outcome:=case
    when v_missing>0 then 'BLOCKED_CONTINUATION_RISK'
    when v_displaced_timed+v_displaced_practice>0
      then 'SAFE_WITH_PREDECESSOR_PRESERVATION'
    else 'SAFE_TO_ACTIVATE'
  end;
  return v_validation || jsonb_build_object(
    'ok',v_missing=0,'outcome',v_outcome,
    'activeAttempts',jsonb_build_object(
      'target',v_target_active,
      'displacedTimed',v_displaced_timed,
      'displacedPractice',v_displaced_practice,
      'qualifyingFrozenSubmissions',v_frozen,
      'missingContinuationContracts',v_missing
    )
  );
end $$;

create function exam_delivery.examops_append_event(
  p_operation_id uuid,
  p_state text,
  p_details jsonb default '{}'::jsonb
) returns void
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $$
declare
  v_sequence integer;
begin
  perform 1 from exam_delivery.exam_release_operations operation
  where operation.id=p_operation_id for update;
  if not found then
    raise exception 'release_operation_not_found' using errcode='P0001';
  end if;
  select coalesce(max(event.sequence),0)+1 into v_sequence
  from exam_delivery.exam_release_operation_events event
  where event.operation_id=p_operation_id;
  insert into exam_delivery.exam_release_operation_events(
    operation_id,sequence,event_state,safe_details
  ) values(p_operation_id,v_sequence,p_state,coalesce(p_details,'{}'::jsonb));
end $$;

create function exam_delivery.examops_operation_result(
  p_operation_id uuid,
  p_replayed boolean default false
) returns jsonb
language sql
stable
security definer
set search_path=''
set statement_timeout='5s'
as $$
  select jsonb_build_object(
    'ok',operation.result_state='succeeded',
    'operationId',operation.id,
    'requestId',operation.request_id,
    'operationType',operation.operation_type,
    'examKey',operation.canonical_exam_key,
    'targetPackageId',operation.target_package_id,
    'resultState',operation.result_state,
    'errorCode',operation.error_code,
    'preflight',operation.preflight_result,
    'postconditions',operation.postcondition_result,
    'createdAt',operation.created_at,
    'completedAt',operation.completed_at,
    'replayed',p_replayed
  )
  from exam_delivery.exam_release_operations operation
  where operation.id=p_operation_id
$$;

create function exam_delivery.stage_exam_release(
  p_actor_id uuid,
  p_request jsonb
) returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='20s'
as $$
declare
  v_request_id uuid;
  v_target uuid;
  v_exam text;
  v_request_hash text;
  v_release_hash text;
  v_existing exam_delivery.exam_release_operations%rowtype;
  v_operation exam_delivery.exam_release_operations%rowtype;
  v_preflight jsonb;
  v_now timestamptz:=statement_timestamp();
begin
  if not exam_delivery.examops_actor_is_platform_owner(p_actor_id) then
    raise exception 'examops_forbidden' using errcode='42501';
  end if;
  begin
    v_request_id:=(p_request->>'requestId')::uuid;
    v_target:=(p_request->>'targetPackageId')::uuid;
    v_exam:=exam_delivery.normalize_exam_key(p_request->>'examKey');
    v_release_hash:=exam_delivery.examops_json_hash(p_request->'releaseSet');
  exception when others then
    return jsonb_build_object('ok',false,'code','RELEASE_REQUEST_INVALID');
  end;
  v_request_hash:=exam_delivery.examops_json_hash(
    jsonb_build_object('operationType','STAGE','request',p_request)
  );
  select * into v_existing
  from exam_delivery.exam_release_operations operation
  where operation.request_id=v_request_id;
  if found then
    if v_existing.request_hash<>v_request_hash then
      return jsonb_build_object('ok',false,'code','REQUEST_ID_PAYLOAD_CONFLICT');
    end if;
    return exam_delivery.examops_operation_result(v_existing.id,true);
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('certsim-exam-release:'||v_exam,0)
  ) then
    return jsonb_build_object('ok',false,'code','RELEASE_OPERATION_BUSY');
  end if;

  v_preflight:=exam_delivery.preflight_exam_release(p_actor_id,p_request);
  if v_preflight->>'outcome'='BLOCKED_TARGET_INVALID' then
    return v_preflight;
  end if;
  insert into exam_delivery.exam_release_operations(
    request_id,request_hash,actor_id,canonical_exam_key,operation_type,
    target_package_id,release_set,release_set_hash,manifest_hash,package_hash,
    validation_hash,release_diff_hash,expected_current_state_hash,result_state
  ) values(
    v_request_id,v_request_hash,p_actor_id,v_exam,'STAGE',v_target,
    p_request->'releaseSet',v_release_hash,p_request->>'manifestHash',
    p_request->>'packageHash',p_request->>'validationHash',
    p_request->>'releaseDiffHash',p_request->>'expectedCurrentStateHash','requested'
  ) returning * into v_operation;
  perform exam_delivery.examops_append_event(
    v_operation.id,'requested',jsonb_build_object('operationType','STAGE')
  );
  update exam_delivery.exam_release_operations
  set result_state='preflighted',preflight_result=v_preflight,started_at=v_now
  where id=v_operation.id;
  perform exam_delivery.examops_append_event(
    v_operation.id,'preflighted',jsonb_build_object(
      'outcome',v_preflight->>'outcome'
    )
  );
  if not coalesce((v_preflight->>'ok')::boolean,false) then
    update exam_delivery.exam_release_operations
    set result_state='failed',error_code=coalesce(
      v_preflight->>'code',v_preflight->>'outcome','BLOCKED_CURRENT_STATE_INVALID'
    ),completed_at=statement_timestamp()
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'failed',jsonb_build_object(
        'code',coalesce(v_preflight->>'code',v_preflight->>'outcome')
      )
    );
    return exam_delivery.examops_operation_result(v_operation.id,false);
  end if;
  update exam_delivery.exam_release_operations
  set result_state='succeeded',completed_at=statement_timestamp()
  where id=v_operation.id;
  perform exam_delivery.examops_append_event(
    v_operation.id,'succeeded',jsonb_build_object(
      'releaseSetHash',v_release_hash
    )
  );
  return exam_delivery.examops_operation_result(v_operation.id,false);
exception when unique_violation then
  select * into v_existing
  from exam_delivery.exam_release_operations operation
  where operation.request_id=v_request_id;
  if found and v_existing.request_hash=v_request_hash then
    return exam_delivery.examops_operation_result(v_existing.id,true);
  end if;
  return jsonb_build_object('ok',false,'code','REQUEST_ID_PAYLOAD_CONFLICT');
end $$;

create function exam_delivery.activate_exam_release(
  p_actor_id uuid,
  p_request jsonb
) returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='30s'
as $$
declare
  v_request_id uuid;
  v_stage_id uuid;
  v_target uuid;
  v_exam text;
  v_request_hash text;
  v_release_hash text;
  v_existing exam_delivery.exam_release_operations%rowtype;
  v_stage exam_delivery.exam_release_operations%rowtype;
  v_operation exam_delivery.exam_release_operations%rowtype;
  v_preflight jsonb;
  v_previous jsonb;
  v_previous_hash text;
  v_profile jsonb;
  v_policy jsonb;
  v_profile_id uuid;
  v_package_version text;
  v_expected_profiles integer;
  v_count integer;
  v_post_validation jsonb;
  v_post jsonb;
  v_failed boolean:=false;
  v_now timestamptz:=statement_timestamp();
begin
  if not exam_delivery.examops_actor_is_platform_owner(p_actor_id) then
    raise exception 'examops_forbidden' using errcode='42501';
  end if;
  begin
    v_request_id:=(p_request->>'requestId')::uuid;
    v_stage_id:=(p_request->>'stageOperationId')::uuid;
    v_target:=(p_request->>'targetPackageId')::uuid;
    v_exam:=exam_delivery.normalize_exam_key(p_request->>'examKey');
    v_release_hash:=exam_delivery.examops_json_hash(p_request->'releaseSet');
  exception when others then
    return jsonb_build_object('ok',false,'code','RELEASE_REQUEST_INVALID');
  end;
  v_request_hash:=exam_delivery.examops_json_hash(
    jsonb_build_object('operationType','ACTIVATE','request',p_request)
  );
  select * into v_existing
  from exam_delivery.exam_release_operations operation
  where operation.request_id=v_request_id;
  if found then
    if v_existing.request_hash<>v_request_hash then
      return jsonb_build_object('ok',false,'code','REQUEST_ID_PAYLOAD_CONFLICT');
    end if;
    return exam_delivery.examops_operation_result(v_existing.id,true);
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('certsim-exam-release:'||v_exam,0)
  ) then
    return jsonb_build_object('ok',false,'code','RELEASE_OPERATION_BUSY');
  end if;

  select * into v_stage
  from exam_delivery.exam_release_operations operation
  where operation.id=v_stage_id
    and operation.operation_type='STAGE'
    and operation.result_state='succeeded'
  for share;
  if not found
    or v_stage.canonical_exam_key<>v_exam
    or v_stage.target_package_id<>v_target
    or v_stage.release_set is distinct from p_request->'releaseSet'
    or v_stage.release_set_hash<>v_release_hash
    or v_stage.manifest_hash<>p_request->>'manifestHash'
    or v_stage.package_hash<>p_request->>'packageHash'
    or v_stage.validation_hash<>p_request->>'validationHash'
    or v_stage.release_diff_hash<>p_request->>'releaseDiffHash'
    or v_stage.expected_current_state_hash<>p_request->>'expectedCurrentStateHash' then
    return jsonb_build_object('ok',false,'code','STAGE_OPERATION_INVALID');
  end if;

  v_preflight:=exam_delivery.preflight_exam_release(p_actor_id,p_request);
  insert into exam_delivery.exam_release_operations(
    request_id,request_hash,actor_id,canonical_exam_key,operation_type,
    target_package_id,stage_operation_id,release_set,release_set_hash,
    manifest_hash,package_hash,validation_hash,release_diff_hash,
    expected_current_state_hash,result_state
  ) values(
    v_request_id,v_request_hash,p_actor_id,v_exam,'ACTIVATE',v_target,v_stage_id,
    p_request->'releaseSet',v_release_hash,p_request->>'manifestHash',
    p_request->>'packageHash',p_request->>'validationHash',
    p_request->>'releaseDiffHash',p_request->>'expectedCurrentStateHash','requested'
  ) returning * into v_operation;
  perform exam_delivery.examops_append_event(
    v_operation.id,'requested',jsonb_build_object(
      'operationType','ACTIVATE','stageOperationId',v_stage_id
    )
  );
  if not coalesce((v_preflight->>'ok')::boolean,false) then
    update exam_delivery.exam_release_operations
    set result_state='preflighted',preflight_result=v_preflight,started_at=v_now
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'preflighted',jsonb_build_object(
        'outcome',v_preflight->>'outcome'
      )
    );
    update exam_delivery.exam_release_operations
    set result_state='failed',
      error_code=coalesce(v_preflight->>'code',v_preflight->>'outcome'),
      completed_at=statement_timestamp()
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'failed',jsonb_build_object(
        'code',coalesce(v_preflight->>'code',v_preflight->>'outcome')
      )
    );
    return exam_delivery.examops_operation_result(v_operation.id,false);
  end if;

  v_previous:=exam_delivery.release_configuration_snapshot(v_exam);
  v_previous_hash:=exam_delivery.examops_json_hash(v_previous);
  update exam_delivery.exam_release_operations
  set result_state='preflighted',preflight_result=v_preflight,started_at=v_now,
    previous_state_snapshot=v_previous,previous_state_hash=v_previous_hash
  where id=v_operation.id;
  perform exam_delivery.examops_append_event(
    v_operation.id,'preflighted',jsonb_build_object(
      'outcome',v_preflight->>'outcome','previousStateHash',v_previous_hash
    )
  );
  update exam_delivery.exam_release_operations
  set result_state='executing' where id=v_operation.id;
  perform exam_delivery.examops_append_event(
    v_operation.id,'executing',jsonb_build_object('configurationMutation',true)
  );

  begin
    select package.package_version into strict v_package_version
    from exam_delivery.package_versions package
    where package.id=v_target and package.status='published'
    for share;

    update exam_delivery.exam_profile_activations activation
    set enabled=false,disabled_at=statement_timestamp(),updated_at=statement_timestamp()
    from exam_delivery.package_versions package
    where package.id=activation.package_version_id
      and exam_delivery.normalize_exam_key(package.exam_key)=v_exam
      and activation.activation_kind='production'
      and activation.enabled;

    update exam_delivery.practice_policies policy
    set enabled=false,access_mode='disabled',updated_at=statement_timestamp()
    where policy.canonical_exam_key=v_exam and policy.enabled;

    for v_profile in
      select profile.value
      from jsonb_array_elements(p_request#>'{releaseSet,profiles}') profile(value)
      order by profile.value->>'profileKey'
    loop
      v_profile_id:=(v_profile->>'targetProfileId')::uuid;
      insert into exam_delivery.exam_profile_activations(
        package_version_id,package_profile_id,enabled,activation_kind,
        enabled_at,disabled_at,created_by
      ) values(
        v_target,v_profile_id,true,'production',statement_timestamp(),null,p_actor_id
      )
      on conflict(package_version_id,package_profile_id,activation_kind) do update
      set enabled=true,enabled_at=statement_timestamp(),disabled_at=null,
        updated_at=statement_timestamp(),created_by=excluded.created_by;

      insert into exam_delivery.package_profile_defaults(
        canonical_exam_key,profile_key,purpose,package_version_id,
        package_profile_id,enabled,configured_at,configured_by
      )
      select v_exam,v_profile->>'profileKey',
        (binding.value->>'purpose')::exam_delivery.attempt_purpose,
        v_target,v_profile_id,true,statement_timestamp(),p_actor_id
      from jsonb_array_elements(v_profile->'bindings') binding(value)
      on conflict(canonical_exam_key,profile_key,purpose) do update
      set package_version_id=excluded.package_version_id,
        package_profile_id=excluded.package_profile_id,enabled=true,
        configured_at=excluded.configured_at,configured_by=excluded.configured_by;

      for v_policy in
        select policy.value
        from jsonb_array_elements(v_profile->'practicePolicies') policy(value)
        order by policy.value->>'purpose'
      loop
        insert into exam_delivery.practice_policies(
          canonical_exam_key,package_version,profile_key,purpose,access_mode,
          enabled,maximum_completed_attempts,cooldown_seconds,
          maximum_concurrent_sessions,maximum_session_items,immediate_feedback,
          review_release_policy,answer_release_policy,updated_at
        ) values(
          v_exam,v_package_version,v_profile->>'profileKey',
          (v_policy->>'purpose')::exam_delivery.attempt_purpose,
          v_policy->>'accessMode',true,
          case when v_policy->'maximumCompletedAttempts'='null'::jsonb
            then null else (v_policy->>'maximumCompletedAttempts')::integer end,
          (v_policy->>'cooldownSeconds')::integer,
          (v_policy->>'maximumConcurrentSessions')::integer,
          (v_policy->>'maximumSessionItems')::integer,
          (v_policy->>'immediateFeedback')::boolean,
          v_policy->>'reviewReleasePolicy',v_policy->>'answerReleasePolicy',
          statement_timestamp()
        )
        on conflict(canonical_exam_key,package_version,profile_key,purpose) do update
        set access_mode=excluded.access_mode,enabled=true,
          maximum_completed_attempts=excluded.maximum_completed_attempts,
          cooldown_seconds=excluded.cooldown_seconds,
          maximum_concurrent_sessions=excluded.maximum_concurrent_sessions,
          maximum_session_items=excluded.maximum_session_items,
          immediate_feedback=excluded.immediate_feedback,
          review_release_policy=excluded.review_release_policy,
          answer_release_policy=excluded.answer_release_policy,
          updated_at=statement_timestamp();
      end loop;
    end loop;

    update public.exam_catalog catalogue
    set current_version=v_package_version,status='active',
      lifecycle='production_ready',updated_at=statement_timestamp()
    where exam_delivery.normalize_exam_key(catalogue.exam_key)=v_exam;
    if not found then
      raise exception 'POSTCONDITION_FAILED' using errcode='P0001';
    end if;

    v_expected_profiles:=jsonb_array_length(p_request#>'{releaseSet,profiles}');
    select count(*) into v_count
    from exam_delivery.package_profile_defaults binding
    where binding.canonical_exam_key=v_exam and binding.enabled
      and binding.package_version_id=v_target;
    if v_count<>v_expected_profiles*6 or exists(
      select 1 from exam_delivery.package_profile_defaults binding
      where binding.canonical_exam_key=v_exam and binding.enabled
        and binding.package_version_id<>v_target
    ) then
      raise exception 'POSTCONDITION_FAILED' using errcode='P0001';
    end if;
    select count(*) into v_count
    from exam_delivery.exam_profile_activations activation
    join exam_delivery.package_versions package on package.id=activation.package_version_id
    where exam_delivery.normalize_exam_key(package.exam_key)=v_exam
      and activation.activation_kind='production' and activation.enabled
      and activation.package_version_id=v_target;
    if v_count<>v_expected_profiles or exists(
      select 1 from exam_delivery.exam_profile_activations activation
      join exam_delivery.package_versions package on package.id=activation.package_version_id
      where exam_delivery.normalize_exam_key(package.exam_key)=v_exam
        and activation.activation_kind='production' and activation.enabled
        and activation.package_version_id<>v_target
    ) then
      raise exception 'POSTCONDITION_FAILED' using errcode='P0001';
    end if;
    select count(*) into v_count
    from exam_delivery.practice_policies policy
    where policy.canonical_exam_key=v_exam and policy.enabled
      and policy.package_version=v_package_version;
    if v_count<>v_expected_profiles*5 or exists(
      select 1 from exam_delivery.practice_policies policy
      where policy.canonical_exam_key=v_exam and policy.enabled
        and policy.package_version<>v_package_version
    ) then
      raise exception 'POSTCONDITION_FAILED' using errcode='P0001';
    end if;
    if not exists(
      select 1 from public.exam_catalog catalogue
      where exam_delivery.normalize_exam_key(catalogue.exam_key)=v_exam
        and catalogue.current_version=v_package_version
        and catalogue.status='active'
        and catalogue.lifecycle='production_ready'
    ) then
      raise exception 'POSTCONDITION_FAILED' using errcode='P0001';
    end if;
    v_post_validation:=
      exam_delivery.validate_current_exam_release_configuration(v_exam);
    if not coalesce((v_post_validation->>'ok')::boolean,false)
      or v_post_validation->>'currentPackageVersion'<>v_package_version then
      raise exception 'POSTCONDITION_FAILED' using errcode='P0001';
    end if;
    v_post:=jsonb_build_object(
      'ok',true,'targetPackageId',v_target,
      'profileCount',v_expected_profiles,
      'configurationHash',exam_delivery.release_configuration_hash(v_exam)
    );
  exception when others then
    v_failed:=true;
  end;

  if v_failed then
    update exam_delivery.exam_release_operations
    set result_state='failed',error_code='POSTCONDITION_FAILED',
      completed_at=statement_timestamp()
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'failed',jsonb_build_object('code','POSTCONDITION_FAILED')
    );
  else
    update exam_delivery.exam_release_operations
    set result_state='succeeded',postcondition_result=v_post,
      completed_at=statement_timestamp()
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'succeeded',v_post
    );
  end if;
  return exam_delivery.examops_operation_result(v_operation.id,false);
exception when unique_violation then
  select * into v_existing
  from exam_delivery.exam_release_operations operation
  where operation.request_id=v_request_id;
  if found and v_existing.request_hash=v_request_hash then
    return exam_delivery.examops_operation_result(v_existing.id,true);
  end if;
  return jsonb_build_object('ok',false,'code','REQUEST_ID_PAYLOAD_CONFLICT');
end $$;

create function exam_delivery.rollback_exam_release(
  p_actor_id uuid,
  p_request jsonb
) returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='30s'
as $$
declare
  v_request_id uuid;
  v_activation_id uuid;
  v_exam text;
  v_request_hash text;
  v_current_hash text;
  v_existing exam_delivery.exam_release_operations%rowtype;
  v_activation exam_delivery.exam_release_operations%rowtype;
  v_operation exam_delivery.exam_release_operations%rowtype;
  v_restored_package_id uuid;
  v_restored_package exam_delivery.package_versions%rowtype;
  v_snapshot jsonb;
  v_item jsonb;
  v_snapshot_default_count integer:=0;
  v_snapshot_package_count integer:=0;
  v_missing integer:=0;
  v_current_validation jsonb;
  v_restored_validation jsonb;
  v_preflight jsonb;
  v_post jsonb;
  v_failed boolean:=false;
  v_now timestamptz:=statement_timestamp();
begin
  if not exam_delivery.examops_actor_is_platform_owner(p_actor_id) then
    raise exception 'examops_forbidden' using errcode='42501';
  end if;
  begin
    v_request_id:=(p_request->>'requestId')::uuid;
    v_activation_id:=(p_request->>'rollbackOfOperationId')::uuid;
    v_exam:=exam_delivery.normalize_exam_key(p_request->>'examKey');
  exception when others then
    return jsonb_build_object('ok',false,'code','RELEASE_REQUEST_INVALID');
  end;
  if coalesce(p_request->>'expectedCurrentStateHash','') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok',false,'code','RELEASE_REQUEST_INVALID');
  end if;
  v_request_hash:=exam_delivery.examops_json_hash(
    jsonb_build_object('operationType','ROLLBACK','request',p_request)
  );
  select * into v_existing
  from exam_delivery.exam_release_operations operation
  where operation.request_id=v_request_id;
  if found then
    if v_existing.request_hash<>v_request_hash then
      return jsonb_build_object('ok',false,'code','REQUEST_ID_PAYLOAD_CONFLICT');
    end if;
    return exam_delivery.examops_operation_result(v_existing.id,true);
  end if;
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('certsim-exam-release:'||v_exam,0)
  ) then
    return jsonb_build_object('ok',false,'code','RELEASE_OPERATION_BUSY');
  end if;

  select * into v_activation
  from exam_delivery.exam_release_operations operation
  where operation.id=v_activation_id
    and operation.operation_type='ACTIVATE'
    and operation.result_state='succeeded'
    and operation.canonical_exam_key=v_exam
  for share;
  if not found or v_activation.previous_state_snapshot is null
    or v_activation.previous_state_hash is null
    or exam_delivery.examops_json_hash(v_activation.previous_state_snapshot)
      <>v_activation.previous_state_hash then
    return jsonb_build_object('ok',false,'code','STAGE_OPERATION_INVALID');
  end if;
  v_snapshot:=v_activation.previous_state_snapshot;
  if v_snapshot->>'schemaVersion'<>'certsim-release-configuration-snapshot-v1'
    or v_snapshot->>'examKey'<>v_exam
    or jsonb_typeof(v_snapshot->'defaults')<>'array'
    or jsonb_typeof(v_snapshot->'activations')<>'array'
    or jsonb_typeof(v_snapshot->'practicePolicies')<>'array'
    or jsonb_typeof(v_snapshot->'catalogue')<>'object' then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','BLOCKED_TARGET_INVALID');
  end if;

  begin
    select count(*)::integer,
      count(distinct nullif(binding->>'packageVersionId',''))::integer
    into v_snapshot_default_count,v_snapshot_package_count
    from jsonb_array_elements(v_snapshot->'defaults') binding;
    if v_snapshot_default_count=0 or v_snapshot_package_count<>1 or exists(
      select 1 from jsonb_array_elements(v_snapshot->'defaults') binding
      where nullif(binding->>'packageVersionId','') is null
        or nullif(binding->>'packageProfileId','') is null
        or nullif(binding->>'profileKey','') is null
        or nullif(binding->>'purpose','') is null
    ) then
      return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
        'code','BLOCKED_TARGET_INVALID');
    end if;
    select (binding->>'packageVersionId')::uuid into v_restored_package_id
    from jsonb_array_elements(v_snapshot->'defaults') binding
    limit 1;
    perform (binding->>'packageVersionId')::uuid,
      (binding->>'packageProfileId')::uuid,
      (binding->>'purpose')::exam_delivery.attempt_purpose
    from jsonb_array_elements(v_snapshot->'defaults') binding;
    perform (activation->>'packageVersionId')::uuid,
      (activation->>'packageProfileId')::uuid
    from jsonb_array_elements(v_snapshot->'activations') activation;
    perform (policy->>'purpose')::exam_delivery.attempt_purpose
    from jsonb_array_elements(v_snapshot->'practicePolicies') policy;
  exception when others then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','BLOCKED_TARGET_INVALID');
  end;

  select * into v_restored_package
  from exam_delivery.package_versions package
  where package.id=v_restored_package_id
    and exam_delivery.normalize_exam_key(package.exam_key)=v_exam
    and package.status='published'
    and package.package_schema_version='certsim-protected-package-v2'
    and exam_delivery.package_v2_runtime_supported(
      package.generator_version,package.scorer_version
    );
  if not found or exists(
    select 1 from jsonb_array_elements(v_snapshot->'defaults') binding
    left join exam_delivery.package_profiles profile
      on profile.id=(binding->>'packageProfileId')::uuid
      and profile.package_version_id=v_restored_package_id
    where (binding->>'packageVersionId')::uuid<>v_restored_package_id
      or profile.id is null
      or profile.profile_key<>binding->>'profileKey'
  ) or exists(
    select 1 from jsonb_array_elements(v_snapshot->'defaults') binding
    where not exists(
      select 1 from jsonb_array_elements(v_snapshot->'activations') activation
      where (activation->>'packageVersionId')::uuid=v_restored_package_id
        and (activation->>'packageProfileId')::uuid=
          (binding->>'packageProfileId')::uuid
        and activation->>'profileKey'=binding->>'profileKey'
        and activation->>'activationKind'='production'
    )
  ) or exists(
    select 1 from jsonb_array_elements(v_snapshot->'defaults') binding
    where binding->>'purpose'<>'assigned_assessment'
      and not exists(
        select 1
        from jsonb_array_elements(v_snapshot->'practicePolicies') policy
        where policy->>'packageVersion'=v_restored_package.package_version
          and policy->>'profileKey'=binding->>'profileKey'
          and policy->>'purpose'=binding->>'purpose'
          and policy->>'accessMode'<>'disabled'
      )
  ) or v_snapshot#>>'{catalogue,currentVersion}'<>
      v_restored_package.package_version
    or v_snapshot#>>'{catalogue,status}'<>'active'
    or v_snapshot#>>'{catalogue,lifecycle}'<>'production_ready' then
    return jsonb_build_object('ok',false,'outcome','BLOCKED_TARGET_INVALID',
      'code','BLOCKED_TARGET_INVALID');
  end if;

  v_current_hash:=exam_delivery.release_configuration_hash(v_exam);
  v_current_validation:=
    exam_delivery.validate_current_exam_release_configuration(v_exam);
  select count(*)::integer into v_missing
  from exam_delivery.attempts attempt
  join exam_delivery.package_versions package on package.id=attempt.package_version_id
  left join exam_delivery.attempt_continuation_contracts contract
    on contract.attempt_id=attempt.id
  where exam_delivery.normalize_exam_key(package.exam_key)=v_exam
    and attempt.status='in_progress'
    and contract.attempt_id is null
    and (
      (attempt.purpose in ('assigned_assessment','self_directed_exam')
        and attempt.expires_at>statement_timestamp())
      or (attempt.purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice')
        and attempt.practice_idle_expires_at>statement_timestamp())
      or exists(
        select 1 from exam_delivery.python_submission_grading_sessions session
        where session.attempt_id=attempt.id
          and session.created_at<attempt.expires_at
      )
    );
  v_preflight:=jsonb_build_object(
    'ok',v_current_hash=p_request->>'expectedCurrentStateHash'
      and coalesce((v_current_validation->>'ok')::boolean,false)
      and v_missing=0,
    'outcome',case
      when v_current_hash<>p_request->>'expectedCurrentStateHash'
        then 'BLOCKED_CURRENT_STATE_INVALID'
      when not coalesce((v_current_validation->>'ok')::boolean,false)
        then 'BLOCKED_CURRENT_STATE_INVALID'
      when v_missing=0 then 'SAFE_WITH_PREDECESSOR_PRESERVATION'
      else 'BLOCKED_CONTINUATION_RISK' end,
    'code',case
      when v_current_hash<>p_request->>'expectedCurrentStateHash'
        then 'RELEASE_STATE_CHANGED'
      when not coalesce((v_current_validation->>'ok')::boolean,false)
        then v_current_validation->>'code'
      else null end,
    'currentStateHash',v_current_hash,
    'currentStateValidation',v_current_validation,
    'missingContinuationContracts',v_missing,
    'rollbackSnapshotHash',v_activation.previous_state_hash
  );

  insert into exam_delivery.exam_release_operations(
    request_id,request_hash,actor_id,canonical_exam_key,operation_type,
    target_package_id,rollback_of_operation_id,release_set,release_set_hash,
    manifest_hash,package_hash,validation_hash,release_diff_hash,
    expected_current_state_hash,result_state
  ) values(
    v_request_id,v_request_hash,p_actor_id,v_exam,'ROLLBACK',
    v_restored_package_id,v_activation_id,v_activation.release_set,
    v_activation.release_set_hash,v_activation.manifest_hash,
    v_activation.package_hash,v_activation.validation_hash,
    v_activation.release_diff_hash,p_request->>'expectedCurrentStateHash','requested'
  ) returning * into v_operation;
  perform exam_delivery.examops_append_event(
    v_operation.id,'requested',jsonb_build_object(
      'operationType','ROLLBACK','rollbackOfOperationId',v_activation_id
    )
  );
  if v_current_hash<>p_request->>'expectedCurrentStateHash' then
    update exam_delivery.exam_release_operations
    set result_state='preflighted',preflight_result=v_preflight,started_at=v_now
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'preflighted',jsonb_build_object(
        'outcome',v_preflight->>'outcome',
        'currentStateHash',v_current_hash
      )
    );
    update exam_delivery.exam_release_operations
    set result_state='failed',error_code='RELEASE_STATE_CHANGED',
      completed_at=statement_timestamp()
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'failed',jsonb_build_object('code','RELEASE_STATE_CHANGED')
    );
    return exam_delivery.examops_operation_result(v_operation.id,false);
  end if;
  if not coalesce((v_current_validation->>'ok')::boolean,false) then
    update exam_delivery.exam_release_operations
    set result_state='preflighted',preflight_result=v_preflight,started_at=v_now
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'preflighted',jsonb_build_object(
        'outcome','BLOCKED_CURRENT_STATE_INVALID',
        'code',v_current_validation->>'code'
      )
    );
    update exam_delivery.exam_release_operations
    set result_state='failed',
      error_code=coalesce(v_current_validation->>'code','BLOCKED_CURRENT_STATE_INVALID'),
      completed_at=statement_timestamp()
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'failed',jsonb_build_object(
        'code',coalesce(
          v_current_validation->>'code','BLOCKED_CURRENT_STATE_INVALID'
        )
      )
    );
    return exam_delivery.examops_operation_result(v_operation.id,false);
  end if;
  if v_missing>0 then
    update exam_delivery.exam_release_operations
    set result_state='preflighted',preflight_result=v_preflight,started_at=v_now
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'preflighted',jsonb_build_object(
        'outcome',v_preflight->>'outcome',
        'rollbackSnapshotHash',v_activation.previous_state_hash
      )
    );
    update exam_delivery.exam_release_operations
    set result_state='failed',error_code='BLOCKED_CONTINUATION_RISK',
      completed_at=statement_timestamp()
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'failed',jsonb_build_object('code','BLOCKED_CONTINUATION_RISK')
    );
    return exam_delivery.examops_operation_result(v_operation.id,false);
  end if;
  update exam_delivery.exam_release_operations
  set result_state='preflighted',preflight_result=v_preflight,started_at=v_now,
    previous_state_snapshot=exam_delivery.release_configuration_snapshot(v_exam),
    previous_state_hash=v_current_hash
  where id=v_operation.id;
  perform exam_delivery.examops_append_event(
    v_operation.id,'preflighted',jsonb_build_object(
      'outcome',v_preflight->>'outcome',
      'rollbackSnapshotHash',v_activation.previous_state_hash
    )
  );
  update exam_delivery.exam_release_operations
  set result_state='executing' where id=v_operation.id;
  perform exam_delivery.examops_append_event(
    v_operation.id,'executing',jsonb_build_object('configurationMutation',true)
  );

  begin
    update exam_delivery.package_profile_defaults binding
    set enabled=false,configured_at=statement_timestamp(),configured_by=p_actor_id
    where binding.canonical_exam_key=v_exam and binding.enabled;
    for v_item in
      select item.value from jsonb_array_elements(v_snapshot->'defaults') item(value)
      order by item.value->>'profileKey',item.value->>'purpose'
    loop
      insert into exam_delivery.package_profile_defaults(
        canonical_exam_key,profile_key,purpose,package_version_id,
        package_profile_id,enabled,configured_at,configured_by
      ) values(
        v_exam,v_item->>'profileKey',
        (v_item->>'purpose')::exam_delivery.attempt_purpose,
        (v_item->>'packageVersionId')::uuid,
        (v_item->>'packageProfileId')::uuid,true,statement_timestamp(),p_actor_id
      )
      on conflict(canonical_exam_key,profile_key,purpose) do update
      set package_version_id=excluded.package_version_id,
        package_profile_id=excluded.package_profile_id,enabled=true,
        configured_at=excluded.configured_at,configured_by=excluded.configured_by;
    end loop;

    update exam_delivery.exam_profile_activations activation
    set enabled=false,disabled_at=statement_timestamp(),updated_at=statement_timestamp()
    from exam_delivery.package_versions package
    where package.id=activation.package_version_id
      and exam_delivery.normalize_exam_key(package.exam_key)=v_exam
      and activation.activation_kind='production' and activation.enabled;
    for v_item in
      select item.value from jsonb_array_elements(v_snapshot->'activations') item(value)
      order by item.value->>'profileKey'
    loop
      insert into exam_delivery.exam_profile_activations(
        package_version_id,package_profile_id,enabled,activation_kind,
        enabled_at,disabled_at,created_by
      ) values(
        (v_item->>'packageVersionId')::uuid,
        (v_item->>'packageProfileId')::uuid,true,
        v_item->>'activationKind',statement_timestamp(),null,p_actor_id
      )
      on conflict(package_version_id,package_profile_id,activation_kind) do update
      set enabled=true,enabled_at=statement_timestamp(),disabled_at=null,
        updated_at=statement_timestamp(),created_by=excluded.created_by;
    end loop;

    update exam_delivery.practice_policies policy
    set enabled=false,access_mode='disabled',updated_at=statement_timestamp()
    where policy.canonical_exam_key=v_exam and policy.enabled;
    for v_item in
      select item.value from jsonb_array_elements(v_snapshot->'practicePolicies') item(value)
      order by item.value->>'packageVersion',item.value->>'profileKey',item.value->>'purpose'
    loop
      insert into exam_delivery.practice_policies(
        canonical_exam_key,package_version,profile_key,purpose,access_mode,
        enabled,maximum_completed_attempts,cooldown_seconds,
        maximum_concurrent_sessions,maximum_session_items,immediate_feedback,
        review_release_policy,answer_release_policy,updated_at
      ) values(
        v_exam,v_item->>'packageVersion',v_item->>'profileKey',
        (v_item->>'purpose')::exam_delivery.attempt_purpose,
        v_item->>'accessMode',true,
        case when v_item->'maximumCompletedAttempts'='null'::jsonb
          then null else (v_item->>'maximumCompletedAttempts')::integer end,
        (v_item->>'cooldownSeconds')::integer,
        (v_item->>'maximumConcurrentSessions')::integer,
        (v_item->>'maximumSessionItems')::integer,
        (v_item->>'immediateFeedback')::boolean,
        v_item->>'reviewReleasePolicy',v_item->>'answerReleasePolicy',
        statement_timestamp()
      )
      on conflict(canonical_exam_key,package_version,profile_key,purpose) do update
      set access_mode=excluded.access_mode,enabled=true,
        maximum_completed_attempts=excluded.maximum_completed_attempts,
        cooldown_seconds=excluded.cooldown_seconds,
        maximum_concurrent_sessions=excluded.maximum_concurrent_sessions,
        maximum_session_items=excluded.maximum_session_items,
        immediate_feedback=excluded.immediate_feedback,
        review_release_policy=excluded.review_release_policy,
        answer_release_policy=excluded.answer_release_policy,
        updated_at=statement_timestamp();
    end loop;

    update public.exam_catalog catalogue
    set current_version=v_snapshot#>>'{catalogue,currentVersion}',
      status=v_snapshot#>>'{catalogue,status}',
      lifecycle=v_snapshot#>>'{catalogue,lifecycle}',
      updated_at=statement_timestamp()
    where exam_delivery.normalize_exam_key(catalogue.exam_key)=v_exam;
    if not found then
      raise exception 'POSTCONDITION_FAILED' using errcode='P0001';
    end if;
    v_restored_validation:=
      exam_delivery.validate_current_exam_release_configuration(v_exam);
    if exam_delivery.release_configuration_snapshot(v_exam) is distinct from v_snapshot
      or not coalesce((v_restored_validation->>'ok')::boolean,false)
      or v_restored_validation->>'currentPackageVersion'<>
        v_restored_package.package_version then
      raise exception 'POSTCONDITION_FAILED' using errcode='P0001';
    end if;
    v_post:=jsonb_build_object(
      'ok',true,'restoredStateHash',v_activation.previous_state_hash,
      'restoredPackageVersion',v_restored_package.package_version,
      'configurationHash',exam_delivery.release_configuration_hash(v_exam)
    );
  exception when others then
    v_failed:=true;
  end;

  if v_failed then
    update exam_delivery.exam_release_operations
    set result_state='failed',error_code='POSTCONDITION_FAILED',
      completed_at=statement_timestamp()
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(
      v_operation.id,'failed',jsonb_build_object('code','POSTCONDITION_FAILED')
    );
  else
    update exam_delivery.exam_release_operations
    set result_state='succeeded',postcondition_result=v_post,
      completed_at=statement_timestamp()
    where id=v_operation.id;
    perform exam_delivery.examops_append_event(v_operation.id,'succeeded',v_post);
  end if;
  return exam_delivery.examops_operation_result(v_operation.id,false);
exception
  when invalid_text_representation then
    return jsonb_build_object('ok',false,'code','STAGE_OPERATION_INVALID');
  when unique_violation then
    select * into v_existing
    from exam_delivery.exam_release_operations operation
    where operation.request_id=v_request_id;
    if found and v_existing.request_hash=v_request_hash then
      return exam_delivery.examops_operation_result(v_existing.id,true);
    end if;
    return jsonb_build_object('ok',false,'code','REQUEST_ID_PAYLOAD_CONFLICT');
end $$;

create function exam_delivery.list_exam_release_operations(
  p_actor_id uuid,
  p_exam_key text,
  p_cursor text default null,
  p_limit integer default 50
) returns jsonb
language plpgsql
stable
security definer
set search_path=''
set statement_timeout='10s'
as $$
declare
  v_exam text:=exam_delivery.normalize_exam_key(p_exam_key);
  v_cursor timestamptz;
  v_limit integer:=least(greatest(coalesce(p_limit,50),1),100);
begin
  if not exam_delivery.examops_actor_is_platform_owner(p_actor_id) then
    raise exception 'examops_forbidden' using errcode='42501';
  end if;
  begin
    v_cursor:=nullif(p_cursor,'')::timestamptz;
  exception when others then
    return jsonb_build_object('ok',false,'code','RELEASE_REQUEST_INVALID');
  end;
  return jsonb_build_object(
    'ok',true,'examKey',v_exam,'operations',coalesce((
      select jsonb_agg(jsonb_build_object(
        'operationId',operation.id,
        'requestId',operation.request_id,
        'operationType',operation.operation_type,
        'targetPackageId',operation.target_package_id,
        'stageOperationId',operation.stage_operation_id,
        'rollbackOfOperationId',operation.rollback_of_operation_id,
        'releaseSetHash',operation.release_set_hash,
        'expectedCurrentStateHash',operation.expected_current_state_hash,
        'resultState',operation.result_state,
        'errorCode',operation.error_code,
        'preflight',operation.preflight_result,
        'postconditions',operation.postcondition_result,
        'createdAt',operation.created_at,
        'completedAt',operation.completed_at
      ) order by operation.created_at desc,operation.id desc)
      from (
        select * from exam_delivery.exam_release_operations candidate
        where candidate.canonical_exam_key=v_exam
          and (v_cursor is null or candidate.created_at<v_cursor)
        order by candidate.created_at desc,candidate.id desc
        limit v_limit
      ) operation
    ),'[]'::jsonb)
  );
end $$;

create function public.certsim_examops_preflight_exam_release(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='15s'
as $$
declare v_actor uuid:=auth.uid();
begin
  if not exam_delivery.examops_actor_is_platform_owner(v_actor) then
    raise exception 'examops_forbidden' using errcode='42501';
  end if;
  return exam_delivery.preflight_exam_release(v_actor,p_request);
end $$;

create function public.certsim_examops_stage_exam_release(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='20s'
as $$
declare v_actor uuid:=auth.uid();
begin
  if not exam_delivery.examops_actor_is_platform_owner(v_actor) then
    raise exception 'examops_forbidden' using errcode='42501';
  end if;
  return exam_delivery.stage_exam_release(v_actor,p_request);
end $$;

create function public.certsim_examops_activate_exam_release(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='30s'
as $$
declare v_actor uuid:=auth.uid();
begin
  if not exam_delivery.examops_actor_is_platform_owner(v_actor) then
    raise exception 'examops_forbidden' using errcode='42501';
  end if;
  return exam_delivery.activate_exam_release(v_actor,p_request);
end $$;

create function public.certsim_examops_rollback_exam_release(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='30s'
as $$
declare v_actor uuid:=auth.uid();
begin
  if not exam_delivery.examops_actor_is_platform_owner(v_actor) then
    raise exception 'examops_forbidden' using errcode='42501';
  end if;
  return exam_delivery.rollback_exam_release(v_actor,p_request);
end $$;

create function public.certsim_examops_list_release_operations(
  p_exam_key text,
  p_cursor text default null,
  p_limit integer default 50
) returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $$
declare v_actor uuid:=auth.uid();
begin
  if not exam_delivery.examops_actor_is_platform_owner(v_actor) then
    raise exception 'examops_forbidden' using errcode='42501';
  end if;
  return exam_delivery.list_exam_release_operations(
    v_actor,p_exam_key,p_cursor,p_limit
  );
end $$;

alter function exam_delivery.examops_guard_operation_update() owner to postgres;
alter function exam_delivery.examops_guard_append_only() owner to postgres;
alter function exam_delivery.examops_json_hash(jsonb) owner to postgres;
alter function exam_delivery.build_attempt_continuation_contract(uuid) owner to postgres;
alter function exam_delivery.create_attempt_continuation_contract() owner to postgres;
alter function exam_delivery.authorize_attempt_continuation(uuid,text) owner to postgres;
alter function exam_delivery.discover_current_attempt(uuid,text,text,text,text,text) owner to postgres;
alter function exam_delivery.start_assignment_attempt(uuid,text,text,uuid,uuid) owner to postgres;
alter function exam_delivery.check_practice_item(uuid,uuid,uuid,integer,uuid) owner to postgres;
alter function exam_delivery.submit_attempt_v2(uuid,uuid,uuid) owner to postgres;
alter function exam_delivery.get_review(uuid,uuid) owner to postgres;
alter function exam_delivery.examops_actor_is_platform_owner(uuid) owner to postgres;
alter function exam_delivery.release_configuration_snapshot(text) owner to postgres;
alter function exam_delivery.release_configuration_hash(text) owner to postgres;
alter function exam_delivery.validate_current_exam_release_configuration(text) owner to postgres;
alter function exam_delivery.examops_validate_release_set(jsonb) owner to postgres;
alter function exam_delivery.preflight_exam_release(uuid,jsonb) owner to postgres;
alter function exam_delivery.examops_append_event(uuid,text,jsonb) owner to postgres;
alter function exam_delivery.examops_operation_result(uuid,boolean) owner to postgres;
alter function exam_delivery.stage_exam_release(uuid,jsonb) owner to postgres;
alter function exam_delivery.activate_exam_release(uuid,jsonb) owner to postgres;
alter function exam_delivery.rollback_exam_release(uuid,jsonb) owner to postgres;
alter function exam_delivery.list_exam_release_operations(uuid,text,text,integer) owner to postgres;
alter function public.certsim_examops_preflight_exam_release(jsonb) owner to postgres;
alter function public.certsim_examops_stage_exam_release(jsonb) owner to postgres;
alter function public.certsim_examops_activate_exam_release(jsonb) owner to postgres;
alter function public.certsim_examops_rollback_exam_release(jsonb) owner to postgres;
alter function public.certsim_examops_list_release_operations(text,text,integer) owner to postgres;

revoke execute on function
  exam_delivery.examops_guard_operation_update(),
  exam_delivery.examops_guard_append_only(),
  exam_delivery.examops_json_hash(jsonb),
  exam_delivery.build_attempt_continuation_contract(uuid),
  exam_delivery.create_attempt_continuation_contract(),
  exam_delivery.examops_actor_is_platform_owner(uuid),
  exam_delivery.release_configuration_snapshot(text),
  exam_delivery.release_configuration_hash(text),
  exam_delivery.validate_current_exam_release_configuration(text),
  exam_delivery.examops_validate_release_set(jsonb),
  exam_delivery.preflight_exam_release(uuid,jsonb),
  exam_delivery.examops_append_event(uuid,text,jsonb),
  exam_delivery.examops_operation_result(uuid,boolean),
  exam_delivery.stage_exam_release(uuid,jsonb),
  exam_delivery.activate_exam_release(uuid,jsonb),
  exam_delivery.rollback_exam_release(uuid,jsonb),
  exam_delivery.list_exam_release_operations(uuid,text,text,integer)
from public,anon,authenticated,service_role;

revoke execute on function
  public.certsim_examops_preflight_exam_release(jsonb),
  public.certsim_examops_stage_exam_release(jsonb),
  public.certsim_examops_activate_exam_release(jsonb),
  public.certsim_examops_rollback_exam_release(jsonb),
  public.certsim_examops_list_release_operations(text,text,integer)
from public,anon,authenticated,service_role;
grant execute on function
  public.certsim_examops_preflight_exam_release(jsonb),
  public.certsim_examops_stage_exam_release(jsonb),
  public.certsim_examops_activate_exam_release(jsonb),
  public.certsim_examops_rollback_exam_release(jsonb),
  public.certsim_examops_list_release_operations(text,text,integer)
to authenticated;

comment on table exam_delivery.attempt_continuation_contracts is
  'Immutable Issue #133 continuation authority; new-start policy is deliberately excluded after attempt creation.';
comment on table exam_delivery.exam_release_operations is
  'Sanitized whole-exam STAGE, ACTIVATE, and ROLLBACK operation ledger.';
comment on table exam_delivery.exam_release_operation_events is
  'Append-only sanitized state transitions for Exam Operations.';
comment on function exam_delivery.release_configuration_snapshot(text) is
  'Returns deterministic new-start configuration only; excludes learners, attempts, protected content, and operation history.';
comment on function exam_delivery.validate_current_exam_release_configuration(text) is
  'Returns bounded read-only health findings for authoritative enabled-default new-start configuration.';
