-- Issue #167 Phase B1: audited abandonment and narrowly authorized recovery
-- for historical Study Sandbox attempts. This migration intentionally performs
-- no historical-attempt DML or event backfill.

create table exam_delivery.attempt_abandonment_events (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null unique,
  actor_id uuid not null,
  request_id uuid not null,
  reason_code text not null,
  response_count_snapshot integer not null check (response_count_snapshot >= 0),
  abandoned_at timestamptz not null,
  purpose exam_delivery.attempt_purpose not null,
  package_version_id uuid not null,
  package_profile_id uuid not null,
  source_action text not null,
  previous_status exam_delivery.attempt_status not null,
  constraint attempt_abandonment_events_owner_fk
    foreign key (attempt_id, actor_id)
    references exam_delivery.attempts(id, owner_id)
    on delete restrict,
  constraint attempt_abandonment_events_package_profile_fk
    foreign key (package_version_id, package_profile_id)
    references exam_delivery.package_profiles(package_version_id, id)
    on delete restrict,
  constraint attempt_abandonment_events_actor_request_unique
    unique (actor_id, request_id),
  constraint attempt_abandonment_events_reason_check
    check (reason_code in (
      'learner_discarded_study_sandbox',
      'learner_abandoned_practice',
      'learner_abandoned_formal_attempt'
    )),
  constraint attempt_abandonment_events_source_action_check
    check (source_action in ('study_sandbox_discard', 'protected_abandon_attempt')),
  constraint attempt_abandonment_events_previous_status_check
    check (previous_status = 'in_progress')
);

create index attempt_abandonment_events_package_profile_idx
  on exam_delivery.attempt_abandonment_events(package_version_id, package_profile_id);

alter table exam_delivery.attempt_abandonment_events enable row level security;
revoke all on table exam_delivery.attempt_abandonment_events
  from public, anon, authenticated, service_role;

create trigger guard_attempt_abandonment_events_mutation
before update or delete on exam_delivery.attempt_abandonment_events
for each row execute function exam_delivery.reject_immutable_row_mutation();

create table exam_delivery.attempt_recovery_events (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null unique,
  actor_id uuid not null,
  request_id uuid not null,
  reason_code text not null,
  response_count_snapshot integer not null check (response_count_snapshot >= 0),
  recovered_at timestamptz not null,
  purpose exam_delivery.attempt_purpose not null,
  package_version_id uuid not null,
  package_profile_id uuid not null,
  source_action text not null,
  previous_status exam_delivery.attempt_status not null,
  next_status exam_delivery.attempt_status not null,
  constraint attempt_recovery_events_owner_fk
    foreign key (attempt_id, actor_id)
    references exam_delivery.attempts(id, owner_id)
    on delete restrict,
  constraint attempt_recovery_events_package_profile_fk
    foreign key (package_version_id, package_profile_id)
    references exam_delivery.package_profiles(package_version_id, id)
    on delete restrict,
  constraint attempt_recovery_events_actor_request_unique
    unique (actor_id, request_id),
  constraint attempt_recovery_events_reason_check
    check (reason_code = 'historical_study_sandbox_recovery'),
  constraint attempt_recovery_events_source_action_check
    check (source_action = 'protected_recover_study_sandbox'),
  constraint attempt_recovery_events_previous_status_check
    check (previous_status = 'abandoned'),
  constraint attempt_recovery_events_next_status_check
    check (next_status = 'in_progress'),
  constraint attempt_recovery_events_purpose_check
    check (purpose = 'study_sandbox')
);

create index attempt_recovery_events_package_profile_idx
  on exam_delivery.attempt_recovery_events(package_version_id, package_profile_id);

alter table exam_delivery.attempt_recovery_events enable row level security;
revoke all on table exam_delivery.attempt_recovery_events
  from public, anon, authenticated, service_role;

create trigger guard_attempt_recovery_events_mutation
before update or delete on exam_delivery.attempt_recovery_events
for each row execute function exam_delivery.reject_immutable_row_mutation();

create index attempts_owner_profile_abandoned_sandbox_recovery_idx
  on exam_delivery.attempts(owner_id, package_profile_id, started_at desc, id)
  where status = 'abandoned' and purpose = 'study_sandbox';

-- Terminal attempts remain immutable. The sole reversal requires an
-- unguessable recovery-event identifier placed in a transaction-local setting
-- by recover_study_sandbox and a matching immutable event visible to this
-- trigger. No generic lifecycle bypass is introduced.
create or replace function exam_delivery.guard_attempt_identity_and_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_recovery_event_id uuid;
  v_recovery_authorized boolean := false;
begin
  if tg_op = 'DELETE' then
    raise exception 'Protected attempts are retained and cannot be deleted.';
  end if;

  if new.id is distinct from old.id
    or new.owner_id is distinct from old.owner_id
    or new.package_version_id is distinct from old.package_version_id
    or new.package_profile_id is distinct from old.package_profile_id
    or new.client_request_id is distinct from old.client_request_id
    or new.generator_version is distinct from old.generator_version
    or new.scorer_version is distinct from old.scorer_version
    or new.created_at is distinct from old.created_at
    or new.started_at is distinct from old.started_at
    or new.expires_at is distinct from old.expires_at
  then
    raise exception 'Protected attempt identity and version traceability are immutable.';
  end if;

  if old.status = 'abandoned' and new.status = 'in_progress' then
    begin
      v_recovery_event_id := nullif(
        pg_catalog.current_setting('certsim.issue167_recovery_event_id', true),
        ''
      )::uuid;
    exception when invalid_text_representation then
      v_recovery_event_id := null;
    end;

    v_recovery_authorized := old.purpose = 'study_sandbox'
      and new.purpose = old.purpose
      and new.submitted_at is null
      and new.completed_at is null
      and new.practice_last_activity_at is not null
      and new.practice_idle_expires_at = new.practice_last_activity_at + interval '30 days'
      and exists (
        select 1
        from exam_delivery.attempt_recovery_events event
        where event.id = v_recovery_event_id
          and event.attempt_id = old.id
          and event.actor_id = old.owner_id
          and event.package_version_id = old.package_version_id
          and event.package_profile_id = old.package_profile_id
          and event.purpose = old.purpose
          and event.previous_status = old.status
          and event.next_status = new.status
          and event.recovered_at = new.practice_last_activity_at
      );
  end if;

  if not (
    new.status = old.status
    or (old.status = 'in_progress' and new.status in ('submitted', 'completed', 'expired', 'abandoned', 'voided'))
    or (old.status = 'submitted' and new.status in ('completed', 'voided'))
    or v_recovery_authorized
  ) then
    raise exception 'Invalid protected attempt lifecycle transition.';
  end if;

  if old.status in ('completed', 'expired', 'abandoned', 'voided')
    and not v_recovery_authorized then
    raise exception 'Terminal protected attempts are immutable.';
  end if;

  if old.submitted_at is not null and new.submitted_at is distinct from old.submitted_at then
    raise exception 'Protected attempt submission timestamps are immutable once set.';
  end if;

  return new;
end;
$$;

create or replace function exam_delivery.abandon_attempt(
  p_actor_id uuid, p_attempt_id uuid, p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_attempt exam_delivery.attempts%rowtype;
  v_existing_event exam_delivery.attempt_abandonment_events%rowtype;
  v_now timestamptz := statement_timestamp();
  v_response_count integer;
  v_reason_code text;
  v_source_action text;
begin
  if p_actor_id is null or p_attempt_id is null or p_request_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  -- Request scope precedes attempt scope so cross-attempt request reuse and
  -- same-attempt concurrent calls have one deterministic lock order.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'issue167-abandon:' || p_actor_id::text || ':' || p_request_id::text, 0
  ));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_attempt_id::text, 0));

  -- Idempotency is evaluated before terminal-state validation.
  select event.* into v_existing_event
  from exam_delivery.attempt_abandonment_events event
  where event.actor_id = p_actor_id and event.request_id = p_request_id;
  if found then
    if v_existing_event.attempt_id <> p_attempt_id then
      return jsonb_build_object('ok', false, 'code', 'attempt_conflict');
    end if;
    return jsonb_build_object(
      'ok', true,
      'attemptId', v_existing_event.attempt_id,
      'status', 'abandoned',
      'abandonedAt', v_existing_event.abandoned_at,
      'savedResponseCount', v_existing_event.response_count_snapshot
    );
  end if;

  select attempt.* into v_attempt
  from exam_delivery.attempts attempt
  where attempt.id = p_attempt_id and attempt.owner_id = p_actor_id
  for update;
  if not found or v_attempt.status <> 'in_progress' then
    return jsonb_build_object('ok', false, 'code', 'attempt_not_found');
  end if;

  select count(*)::integer into v_response_count
  from exam_delivery.attempt_responses response
  where response.attempt_id = v_attempt.id;

  v_reason_code := case
    when v_attempt.purpose = 'study_sandbox' then 'learner_discarded_study_sandbox'
    when v_attempt.purpose in ('assigned_assessment', 'self_directed_exam') then 'learner_abandoned_formal_attempt'
    else 'learner_abandoned_practice'
  end;
  v_source_action := case
    when v_attempt.purpose = 'study_sandbox' then 'study_sandbox_discard'
    else 'protected_abandon_attempt'
  end;

  insert into exam_delivery.attempt_abandonment_events(
    attempt_id, actor_id, request_id, reason_code, response_count_snapshot,
    abandoned_at, purpose, package_version_id, package_profile_id,
    source_action, previous_status
  ) values (
    v_attempt.id, p_actor_id, p_request_id, v_reason_code, v_response_count,
    v_now, v_attempt.purpose, v_attempt.package_version_id,
    v_attempt.package_profile_id, v_source_action, v_attempt.status
  );

  update exam_delivery.attempts
  set status = 'abandoned'
  where id = v_attempt.id and owner_id = p_actor_id and status = 'in_progress';
  if not found then
    raise exception 'issue167_abandonment_status_conflict';
  end if;

  return jsonb_build_object(
    'ok', true,
    'attemptId', v_attempt.id,
    'status', 'abandoned',
    'abandonedAt', v_now,
    'savedResponseCount', v_response_count
  );
end;
$$;

-- Add a canonical normalized-exam/profile lock ahead of the existing
-- package-specific lock. A recovered sandbox on an older still-authorized
-- package therefore cannot race a new default-package start.
create or replace function exam_delivery.start_practice(p_actor_id uuid, p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
declare
  v_availability jsonb;
  v_package_id uuid;
  v_profile_id uuid;
  v_existing exam_delivery.attempts%rowtype;
  v_assignment_id uuid;
begin
  begin
    v_assignment_id := nullif(p_request->>'assignmentId', '')::uuid;
  exception when invalid_text_representation then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end;

  v_availability := exam_delivery.practice_availability(p_actor_id, p_request);
  if not coalesce((v_availability->>'ok')::boolean, false) then
    return v_availability;
  end if;

  select pv.id, pp.id into strict v_package_id, v_profile_id
  from exam_delivery.package_versions pv
  join exam_delivery.package_profiles pp on pp.package_version_id = pv.id
  where exam_delivery.normalize_exam_key(pv.exam_key) = v_availability->>'examKey'
    and pv.package_version = v_availability->>'packageVersion'
    and pp.profile_key = v_availability->>'profileKey';

  if p_request->>'purpose' = 'study_sandbox' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
      'issue167-study-sandbox:' || p_actor_id::text || ':' ||
      (v_availability->>'examKey') || ':' || (v_availability->>'profileKey'), 0
    ));

    if exists (
      select 1
      from exam_delivery.attempts active
      join exam_delivery.package_versions active_package
        on active_package.id = active.package_version_id
      join exam_delivery.package_profiles active_profile
        on active_profile.id = active.package_profile_id
      where active.owner_id = p_actor_id
        and active.status = 'in_progress'
        and active.purpose = 'study_sandbox'
        and active.practice_idle_expires_at > statement_timestamp()
        and exam_delivery.normalize_exam_key(active_package.exam_key) = v_availability->>'examKey'
        and active_profile.profile_key = v_availability->>'profileKey'
        and not (
          active.package_version_id = v_package_id
          and active.package_profile_id = v_profile_id
          and active.language_preference = p_request->>'language'
        )
    ) then
      return jsonb_build_object('ok', false, 'code', 'attempt_conflict');
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_actor_id::text || ':' || v_package_id::text || ':' || v_profile_id::text || ':' ||
    (p_request->>'purpose') || ':' || (p_request->>'language'), 0
  ));

  select * into v_existing
  from exam_delivery.attempts attempt
  where attempt.owner_id = p_actor_id
    and attempt.package_version_id = v_package_id
    and attempt.package_profile_id = v_profile_id
    and attempt.purpose = (p_request->>'purpose')::exam_delivery.attempt_purpose
    and attempt.language_preference = p_request->>'language'
    and attempt.status = 'in_progress'
  for update;

  if found and not (
    (v_assignment_id is not null
      and v_existing.source_assignment_id=v_assignment_id
      and v_existing.attribution_source='assignment')
    or
    (v_assignment_id is null
      and v_existing.source_assignment_id is null
      and v_existing.attribution_source is distinct from 'assignment')
  ) then
    return jsonb_build_object('ok', false, 'code', 'attempt_conflict');
  end if;

  return exam_delivery.start_practice_issue59_attribution_base(p_actor_id, p_request);
exception when sqlstate '42501' then
  if nullif(p_request->>'assignmentId', '') is not null then
    return jsonb_build_object('ok', false, 'code', 'assignment_conflict');
  end if;
  raise;
when no_data_found or too_many_rows then
  return jsonb_build_object('ok', false, 'code', 'package_unavailable');
end;
$$;

create function exam_delivery.recover_study_sandbox(
  p_actor_id uuid, p_attempt_id uuid, p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
  v_attempt record;
  v_existing_event exam_delivery.attempt_recovery_events%rowtype;
  v_event_id uuid := gen_random_uuid();
  v_now timestamptz := statement_timestamp();
  v_response_count integer;
begin
  if p_actor_id is null or p_attempt_id is null or p_request_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'issue167-recovery:' || p_actor_id::text || ':' || p_request_id::text, 0
  ));

  -- A successful replay must win before the now-in-progress status is checked.
  select event.* into v_existing_event
  from exam_delivery.attempt_recovery_events event
  where event.actor_id = p_actor_id and event.request_id = p_request_id;
  if found then
    if v_existing_event.attempt_id <> p_attempt_id then
      return jsonb_build_object('ok', false, 'code', 'attempt_conflict');
    end if;
    return jsonb_build_object(
      'ok', true,
      'attemptId', v_existing_event.attempt_id,
      'status', 'in_progress',
      'recoveredAt', v_existing_event.recovered_at,
      'savedResponseCount', v_existing_event.response_count_snapshot
    );
  end if;

  select attempt.id, attempt.owner_id, attempt.status, attempt.purpose,
    attempt.package_version_id, attempt.package_profile_id,
    package.exam_key, package.package_version, profile.profile_key
  into v_attempt
  from exam_delivery.attempts attempt
  join exam_delivery.package_versions package on package.id = attempt.package_version_id
  join exam_delivery.package_profiles profile on profile.id = attempt.package_profile_id
  where attempt.id = p_attempt_id and attempt.owner_id = p_actor_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'attempt_not_found');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'issue167-study-sandbox:' || p_actor_id::text || ':' ||
    exam_delivery.normalize_exam_key(v_attempt.exam_key) || ':' || v_attempt.profile_key, 0
  ));

  select attempt.id, attempt.owner_id, attempt.status, attempt.purpose,
    attempt.package_version_id, attempt.package_profile_id,
    package.exam_key, package.package_version, profile.profile_key
  into v_attempt
  from exam_delivery.attempts attempt
  join exam_delivery.package_versions package on package.id = attempt.package_version_id
  join exam_delivery.package_profiles profile on profile.id = attempt.package_profile_id
  where attempt.id = p_attempt_id and attempt.owner_id = p_actor_id
  for update of attempt;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'attempt_not_found');
  end if;

  if v_attempt.status <> 'abandoned' or v_attempt.purpose <> 'study_sandbox' then
    return jsonb_build_object('ok', false, 'code', 'invalid_lifecycle_transition');
  end if;

  if exists (
    select 1 from exam_delivery.attempt_abandonment_events abandonment
    where abandonment.attempt_id = p_attempt_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'sandbox_discarded');
  end if;

  select count(*)::integer into v_response_count
  from exam_delivery.attempt_responses response
  where response.attempt_id = p_attempt_id;
  if v_response_count < 1 then
    return jsonb_build_object('ok', false, 'code', 'sandbox_not_recoverable');
  end if;

  if exists (select 1 from exam_delivery.attempt_results result where result.attempt_id = p_attempt_id)
    or exists (select 1 from exam_delivery.review_snapshots review where review.attempt_id = p_attempt_id)
    or exists (
      select 1 from exam_delivery.attempt_replacements replacement
      where replacement.replaced_attempt_id = p_attempt_id
         or replacement.replacement_attempt_id = p_attempt_id
    )
    or exists (
      select 1 from exam_delivery.practice_attempt_expirations expiration
      where expiration.expired_attempt_id = p_attempt_id
         or expiration.replacement_attempt_id = p_attempt_id
    ) then
    return jsonb_build_object('ok', false, 'code', 'sandbox_not_recoverable');
  end if;

  if not exists (
    select 1
    from exam_delivery.package_versions package
    join exam_delivery.package_profiles profile
      on profile.package_version_id = package.id
    join exam_delivery.exam_profile_activations activation
      on activation.package_version_id = package.id
     and activation.package_profile_id = profile.id
     and activation.activation_kind = 'production'
     and activation.enabled
    join exam_delivery.practice_policies policy
      on policy.canonical_exam_key = exam_delivery.normalize_exam_key(package.exam_key)
     and policy.package_version = package.package_version
     and policy.profile_key = profile.profile_key
     and policy.purpose = 'study_sandbox'
     and policy.enabled
     and policy.access_mode <> 'disabled'
    join public.profiles actor_profile
      on actor_profile.id = p_actor_id and actor_profile.status = 'active'
    where package.id = v_attempt.package_version_id
      and profile.id = v_attempt.package_profile_id
      and package.status = 'published'
      and exam_delivery.can_use_profile(
        p_actor_id, package.id, profile.id, 'study_sandbox'
      )
  ) then
    return jsonb_build_object('ok', false, 'code', 'practice_unavailable');
  end if;

  if exists (
    select 1
    from exam_delivery.attempts active
    join exam_delivery.package_versions active_package
      on active_package.id = active.package_version_id
    join exam_delivery.package_profiles active_profile
      on active_profile.id = active.package_profile_id
    where active.owner_id = p_actor_id
      and active.id <> p_attempt_id
      and active.status = 'in_progress'
      and active.purpose = 'study_sandbox'
      and exam_delivery.normalize_exam_key(active_package.exam_key) =
        exam_delivery.normalize_exam_key(v_attempt.exam_key)
      and active_profile.profile_key = v_attempt.profile_key
      and (
        active.practice_idle_expires_at > v_now
        or (
          active.package_version_id = v_attempt.package_version_id
          and active.package_profile_id = v_attempt.package_profile_id
        )
      )
  ) then
    return jsonb_build_object('ok', false, 'code', 'active_sandbox_exists');
  end if;

  insert into exam_delivery.attempt_recovery_events(
    id, attempt_id, actor_id, request_id, reason_code,
    response_count_snapshot, recovered_at, purpose, package_version_id,
    package_profile_id, source_action, previous_status, next_status
  ) values (
    v_event_id, p_attempt_id, p_actor_id, p_request_id,
    'historical_study_sandbox_recovery', v_response_count, v_now,
    'study_sandbox', v_attempt.package_version_id, v_attempt.package_profile_id,
    'protected_recover_study_sandbox', 'abandoned', 'in_progress'
  );

  perform pg_catalog.set_config(
    'certsim.issue167_recovery_event_id', v_event_id::text, true
  );
  update exam_delivery.attempts
  set status = 'in_progress',
      practice_last_activity_at = v_now,
      practice_idle_expires_at = v_now + interval '30 days'
  where id = p_attempt_id and owner_id = p_actor_id and status = 'abandoned';
  if not found then
    raise exception 'issue167_recovery_status_conflict';
  end if;
  perform pg_catalog.set_config('certsim.issue167_recovery_event_id', '', true);

  return jsonb_build_object(
    'ok', true,
    'attemptId', p_attempt_id,
    'status', 'in_progress',
    'recoveredAt', v_now,
    'savedResponseCount', v_response_count
  );
exception when unique_violation then
  return jsonb_build_object('ok', false, 'code', 'attempt_conflict');
end;
$$;

create function exam_delivery.list_recoverable_study_sandboxes(
  p_actor_id uuid,
  p_exam_key text default null,
  p_profile_key text default null,
  p_limit integer default 8
)
returns jsonb
language sql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
  with eligible as (
    select attempt.id, package.exam_key, package.package_version,
      profile.profile_key, profile.display_name, attempt.purpose,
      attempt.language_preference, attempt.started_at,
      coalesce(
        greatest(attempt.practice_last_activity_at, response_stats.last_response_at),
        attempt.practice_last_activity_at,
        response_stats.last_response_at,
        attempt.started_at
      ) as last_activity_at,
      item_stats.item_count, response_stats.saved_response_count
    from exam_delivery.attempts attempt
    join exam_delivery.package_versions package
      on package.id = attempt.package_version_id and package.status = 'published'
    join exam_delivery.package_profiles profile
      on profile.id = attempt.package_profile_id
     and profile.package_version_id = attempt.package_version_id
    join exam_delivery.exam_profile_activations activation
      on activation.package_version_id = attempt.package_version_id
     and activation.package_profile_id = attempt.package_profile_id
     and activation.activation_kind = 'production'
     and activation.enabled
    join exam_delivery.practice_policies policy
      on policy.canonical_exam_key = exam_delivery.normalize_exam_key(package.exam_key)
     and policy.package_version = package.package_version
     and policy.profile_key = profile.profile_key
     and policy.purpose = 'study_sandbox'
     and policy.enabled
     and policy.access_mode <> 'disabled'
    join public.profiles actor_profile
      on actor_profile.id = p_actor_id and actor_profile.status = 'active'
    cross join lateral (
      select count(*)::integer as saved_response_count,
        max(response.updated_at) as last_response_at
      from exam_delivery.attempt_responses response
      where response.attempt_id = attempt.id
    ) response_stats
    cross join lateral (
      select count(*)::integer as item_count
      from exam_delivery.attempt_items item
      where item.attempt_id = attempt.id
    ) item_stats
    where attempt.owner_id = p_actor_id
      and attempt.status = 'abandoned'
      and attempt.purpose = 'study_sandbox'
      and response_stats.saved_response_count > 0
      and (p_exam_key is null or exam_delivery.normalize_exam_key(package.exam_key) =
        exam_delivery.normalize_exam_key(p_exam_key))
      and (p_profile_key is null or profile.profile_key = p_profile_key)
      and exam_delivery.can_use_profile(
        p_actor_id, attempt.package_version_id, attempt.package_profile_id,
        'study_sandbox'
      )
      and not exists (
        select 1 from exam_delivery.attempt_results result
        where result.attempt_id = attempt.id
      )
      and not exists (
        select 1 from exam_delivery.review_snapshots review
        where review.attempt_id = attempt.id
      )
      and not exists (
        select 1 from exam_delivery.attempt_abandonment_events abandonment
        where abandonment.attempt_id = attempt.id
      )
      and not exists (
        select 1 from exam_delivery.attempt_recovery_events recovery
        where recovery.attempt_id = attempt.id
      )
      and not exists (
        select 1 from exam_delivery.attempt_replacements replacement
        where replacement.replaced_attempt_id = attempt.id
           or replacement.replacement_attempt_id = attempt.id
      )
      and not exists (
        select 1 from exam_delivery.practice_attempt_expirations expiration
        where expiration.expired_attempt_id = attempt.id
           or expiration.replacement_attempt_id = attempt.id
      )
      and not exists (
        select 1
        from exam_delivery.attempts active
        join exam_delivery.package_versions active_package
          on active_package.id = active.package_version_id
        join exam_delivery.package_profiles active_profile
          on active_profile.id = active.package_profile_id
        where active.owner_id = attempt.owner_id
          and active.id <> attempt.id
          and active.status = 'in_progress'
          and active.purpose = 'study_sandbox'
          and exam_delivery.normalize_exam_key(active_package.exam_key) =
            exam_delivery.normalize_exam_key(package.exam_key)
          and active_profile.profile_key = profile.profile_key
          and (
            active.practice_idle_expires_at > statement_timestamp()
            or (
              active.package_version_id = attempt.package_version_id
              and active.package_profile_id = attempt.package_profile_id
            )
          )
      )
    order by attempt.started_at desc, attempt.id desc
    limit least(greatest(coalesce(p_limit, 8), 1), 20)
  )
  select jsonb_build_object(
    'ok', true,
    'candidates', coalesce(jsonb_agg(jsonb_build_object(
      'attemptId', eligible.id,
      'examKey', exam_delivery.normalize_exam_key(eligible.exam_key),
      'packageVersion', eligible.package_version,
      'profileKey', eligible.profile_key,
      'profileName', eligible.display_name,
      'purpose', eligible.purpose,
      'languagePreference', eligible.language_preference,
      'startedAt', eligible.started_at,
      'lastActivityAt', eligible.last_activity_at,
      'itemCount', eligible.item_count,
      'savedResponseCount', eligible.saved_response_count,
      'recoverable', true
    ) order by eligible.started_at desc, eligible.id desc), '[]'::jsonb)
  )
  from eligible
$$;

create function exam_delivery.get_attempt_lifecycle_summary(
  p_actor_id uuid, p_attempt_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
  select coalesce((
    select jsonb_build_object(
      'ok', true,
      'attemptId', attempt.id,
      'purpose', attempt.purpose,
      'status', attempt.status,
      'savedResponseCount', (
        select count(*)::integer
        from exam_delivery.attempt_responses response
        where response.attempt_id = attempt.id
      )
    )
    from exam_delivery.attempts attempt
    where attempt.id = p_attempt_id and attempt.owner_id = p_actor_id
  ), jsonb_build_object('ok', false, 'code', 'attempt_not_found'))
$$;

create function public.certsim_protected_recover_study_sandbox(
  p_actor_id uuid, p_attempt_id uuid, p_request_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
  select exam_delivery.recover_study_sandbox(p_actor_id, p_attempt_id, p_request_id)
$$;

create function public.certsim_protected_list_recoverable_study_sandboxes(
  p_actor_id uuid,
  p_exam_key text default null,
  p_profile_key text default null,
  p_limit integer default 8
)
returns jsonb
language sql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
  select exam_delivery.list_recoverable_study_sandboxes(
    p_actor_id, p_exam_key, p_profile_key, p_limit
  )
$$;

create function public.certsim_protected_get_attempt_lifecycle_summary(
  p_actor_id uuid, p_attempt_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
  select exam_delivery.get_attempt_lifecycle_summary(p_actor_id, p_attempt_id)
$$;

alter table exam_delivery.attempt_abandonment_events owner to postgres;
alter table exam_delivery.attempt_recovery_events owner to postgres;
alter function exam_delivery.guard_attempt_identity_and_lifecycle() owner to postgres;
alter function exam_delivery.abandon_attempt(uuid, uuid, uuid) owner to postgres;
alter function exam_delivery.start_practice(uuid, jsonb) owner to postgres;
alter function exam_delivery.recover_study_sandbox(uuid, uuid, uuid) owner to postgres;
alter function exam_delivery.list_recoverable_study_sandboxes(uuid, text, text, integer) owner to postgres;
alter function exam_delivery.get_attempt_lifecycle_summary(uuid, uuid) owner to postgres;
alter function public.certsim_protected_recover_study_sandbox(uuid, uuid, uuid) owner to postgres;
alter function public.certsim_protected_list_recoverable_study_sandboxes(uuid, text, text, integer) owner to postgres;
alter function public.certsim_protected_get_attempt_lifecycle_summary(uuid, uuid) owner to postgres;

revoke execute on function exam_delivery.guard_attempt_identity_and_lifecycle(),
  exam_delivery.abandon_attempt(uuid, uuid, uuid),
  exam_delivery.start_practice_issue59_attribution_base(uuid, jsonb),
  exam_delivery.start_practice(uuid, jsonb),
  exam_delivery.recover_study_sandbox(uuid, uuid, uuid),
  exam_delivery.list_recoverable_study_sandboxes(uuid, text, text, integer),
  exam_delivery.get_attempt_lifecycle_summary(uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function exam_delivery.abandon_attempt(uuid, uuid, uuid),
  exam_delivery.start_practice(uuid, jsonb)
to service_role;

revoke execute on function public.certsim_protected_abandon_attempt(uuid, uuid, uuid),
  public.certsim_protected_recover_study_sandbox(uuid, uuid, uuid),
  public.certsim_protected_list_recoverable_study_sandboxes(uuid, text, text, integer),
  public.certsim_protected_get_attempt_lifecycle_summary(uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function public.certsim_protected_abandon_attempt(uuid, uuid, uuid),
  public.certsim_protected_recover_study_sandbox(uuid, uuid, uuid),
  public.certsim_protected_list_recoverable_study_sandboxes(uuid, text, text, integer),
  public.certsim_protected_get_attempt_lifecycle_summary(uuid, uuid)
to service_role;
