-- Issue #65 live-acceptance correction: reconcile expired formal attempts
-- before any purpose starts on the same profile, and remove the obsolete
-- profile-wide collision between formal assessments and practice sessions.

do $$
begin
  if exists (
    select 1
    from exam_delivery.attempts a
    where a.status = 'in_progress'
      and a.purpose in ('assigned_assessment','self_directed_exam')
      and a.expires_at <= statement_timestamp()
      and (
        a.submitted_at is not null
        or a.completed_at is not null
        or exists (select 1 from exam_delivery.attempt_results r where r.attempt_id = a.id)
        or exists (select 1 from exam_delivery.review_snapshots r where r.attempt_id = a.id)
      )
  ) then
    raise exception 'issue65_stale_formal_attempt_has_terminal_state';
  end if;

  update exam_delivery.attempts a
  set status = 'expired'
  where a.status = 'in_progress'
    and a.purpose in ('assigned_assessment','self_directed_exam')
    and a.expires_at <= statement_timestamp();
end
$$;

drop index if exists exam_delivery.attempts_one_active_profile_idx;
create unique index attempts_one_active_profile_idx
  on exam_delivery.attempts (owner_id, package_profile_id)
  where status = 'in_progress'
    and purpose in ('assigned_assessment','self_directed_exam');

create or replace function exam_delivery.reconcile_expired_formal_attempts(
  p_actor_id uuid,
  p_package_profile_id uuid
) returns integer
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_updated integer;
begin
  if p_actor_id is null or p_package_profile_id is null then
    raise exception 'issue65_invalid_reconciliation_scope';
  end if;

  if exists (
    select 1
    from exam_delivery.attempts a
    where a.owner_id = p_actor_id
      and a.package_profile_id = p_package_profile_id
      and a.status = 'in_progress'
      and a.purpose in ('assigned_assessment','self_directed_exam')
      and a.expires_at <= statement_timestamp()
      and (
        a.submitted_at is not null
        or a.completed_at is not null
        or exists (select 1 from exam_delivery.attempt_results r where r.attempt_id = a.id)
        or exists (select 1 from exam_delivery.review_snapshots r where r.attempt_id = a.id)
      )
  ) then
    raise exception 'issue65_stale_formal_attempt_has_terminal_state';
  end if;

  update exam_delivery.attempts a
  set status = 'expired'
  where a.owner_id = p_actor_id
    and a.package_profile_id = p_package_profile_id
    and a.status = 'in_progress'
    and a.purpose in ('assigned_assessment','self_directed_exam')
    and a.expires_at <= statement_timestamp();
  get diagnostics v_updated = row_count;
  return v_updated;
end
$$;

alter function exam_delivery.reconcile_expired_formal_attempts(uuid,uuid) owner to postgres;
revoke execute on function exam_delivery.reconcile_expired_formal_attempts(uuid,uuid)
  from public, anon, authenticated, service_role;

-- Patch the current shared formal/practice start implementation at its stable
-- advisory-lock boundary. This preserves the reviewed authorization,
-- attribution, replacement, materialization, and idempotency implementation.
do $$
declare
  v_definition text := pg_get_functiondef(
    'exam_delivery.start_practice_issue59_attribution_base(uuid,jsonb)'::regprocedure
  );
  v_marker text := 'select * into v_existing from exam_delivery.attempts where owner_id=p_actor_id and client_request_id=v_request_id for update;';
  v_replacement text := 'perform exam_delivery.reconcile_expired_formal_attempts(p_actor_id,v_package.package_profile_id);' || chr(10) ||
    '  select * into v_existing from exam_delivery.attempts where owner_id=p_actor_id and client_request_id=v_request_id for update;';
begin
  if position(v_marker in v_definition) = 0 then
    raise exception 'issue65_start_contract_drift';
  end if;
  execute replace(v_definition, v_marker, v_replacement);
end
$$;

alter function exam_delivery.start_practice_issue59_attribution_base(uuid,jsonb) owner to postgres;
revoke execute on function exam_delivery.start_practice_issue59_attribution_base(uuid,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function exam_delivery.start_practice_issue59_attribution_base(uuid,jsonb)
  to service_role;
