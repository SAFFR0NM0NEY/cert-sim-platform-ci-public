begin;

alter table exam_delivery.python_execution_runs
  add column client_request_id uuid,
  add column wall_time_ms integer,
  add column memory_bytes bigint,
  add column output_bytes integer,
  add column learner_stdout text not null default '',
  add column learner_stderr text not null default '',
  add column learner_exit_code integer;

create unique index python_execution_runs_client_request_unique
  on exam_delivery.python_execution_runs(client_request_id)
  where client_request_id is not null;

alter table exam_delivery.python_execution_runs
  add constraint python_execution_runs_resource_facts_check check (
    (client_request_id is null and wall_time_ms is null
      and memory_bytes is null and output_bytes is null)
    or
    (client_request_id is not null
      and wall_time_ms between 100 and 20000
      and memory_bytes between 16777216 and 134217728
      and output_bytes between 1 and 1048576)
  ),
  add constraint python_execution_runs_learner_output_check check (
    octet_length(learner_stdout) + octet_length(learner_stderr)
      <= coalesce(output_bytes, 1048576)
  ),
  add constraint python_execution_runs_learner_exit_check check (
    (state not in ('completed', 'failed', 'cancelled')
      and learner_stdout = '' and learner_stderr = '' and learner_exit_code is null)
    or
    (state = 'completed' and terminal_outcome = 'completed'
      and learner_exit_code = 0)
    or
    (state = 'failed' and terminal_outcome = 'failed'
      and (learner_exit_code is null or learner_exit_code between 1 and 255))
    or
    (state = 'failed' and terminal_outcome in ('timeout', 'resource_limit')
      and learner_exit_code is null)
    or
    (state = 'cancelled' and terminal_outcome = 'cancelled'
      and learner_exit_code is null)
  );

create or replace function exam_delivery.guard_python_execution_run()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'python_run_immutable' using errcode = '55000';
  end if;
  if old.id is distinct from new.id
    or old.attempt_id is distinct from new.attempt_id
    or old.attempt_item_id is distinct from new.attempt_item_id
    or old.workspace_revision is distinct from new.workspace_revision
    or old.workspace_hash is distinct from new.workspace_hash
    or old.client_request_id is distinct from new.client_request_id
    or old.execution_request_id is distinct from new.execution_request_id
    or old.orchestration_request_digest is distinct from new.orchestration_request_digest
    or old.wall_time_ms is distinct from new.wall_time_ms
    or old.memory_bytes is distinct from new.memory_bytes
    or old.output_bytes is distinct from new.output_bytes
    or old.created_at is distinct from new.created_at then
    raise exception 'python_run_binding_immutable' using errcode = '55000';
  end if;
  if old.execution_request_digest is not null
    and old.execution_request_digest is distinct from new.execution_request_digest then
    raise exception 'python_run_execution_request_digest_immutable' using errcode = '55000';
  end if;
  if old.state in ('completed', 'failed', 'cancelled') then
    if old.state is distinct from new.state
      or old.provider_execution_id is distinct from new.provider_execution_id
      or old.execution_result_digest is distinct from new.execution_result_digest
      or old.terminal_outcome is distinct from new.terminal_outcome
      or old.learner_stdout is distinct from new.learner_stdout
      or old.learner_stderr is distinct from new.learner_stderr
      or old.learner_exit_code is distinct from new.learner_exit_code
      or old.cancellation_request_id is distinct from new.cancellation_request_id
      or old.cancellation_requested_at is distinct from new.cancellation_requested_at
      or old.completed_at is distinct from new.completed_at
      or old.disposed_at is not null and old.disposed_at is distinct from new.disposed_at
      or new.updated_at < old.updated_at
      or not (
        (old.disposal_state = 'not_requested' and new.disposal_state in ('not_requested', 'pending', 'confirmed', 'failed'))
        or (old.disposal_state = 'pending' and new.disposal_state in ('pending', 'confirmed', 'failed'))
        or (old.disposal_state = 'failed' and new.disposal_state in ('failed', 'pending', 'confirmed'))
        or (old.disposal_state = 'confirmed' and new.disposal_state = 'confirmed')
      ) then
      raise exception 'python_run_terminal_immutable' using errcode = '55000';
    end if;
    return new;
  end if;
  if old.provider_execution_id is not null
      and old.provider_execution_id is distinct from new.provider_execution_id
    or old.execution_result_digest is not null
      and old.execution_result_digest is distinct from new.execution_result_digest
    or old.terminal_outcome is not null
      and old.terminal_outcome is distinct from new.terminal_outcome
    or old.learner_stdout <> '' or old.learner_stderr <> ''
    or old.learner_exit_code is not null
    or old.cancellation_request_id is not null
      and old.cancellation_request_id is distinct from new.cancellation_request_id
    or old.cancellation_requested_at is not null
      and old.cancellation_requested_at is distinct from new.cancellation_requested_at
    or old.completed_at is not null and old.completed_at is distinct from new.completed_at
    or new.updated_at < old.updated_at then
    raise exception 'python_run_reconciliation_immutable' using errcode = '55000';
  end if;
  if not (
    (old.state = 'authorized' and new.state in ('authorized', 'queued', 'running', 'cancel_requested', 'failed', 'cancelled'))
    or (old.state = 'queued' and new.state in ('queued', 'running', 'cancel_requested', 'failed', 'cancelled'))
    or (old.state = 'running' and new.state in ('running', 'cancel_requested', 'completed', 'failed', 'cancelled'))
    or (old.state = 'cancel_requested' and new.state in ('cancel_requested', 'failed', 'cancelled'))
  ) then
    raise exception 'python_run_transition_invalid' using errcode = '55000';
  end if;
  if new.state in ('authorized', 'queued', 'running')
    and new.disposal_state <> 'not_requested' then
    raise exception 'python_run_disposal_transition_invalid' using errcode = '55000';
  end if;
  return new;
end
$$;

create function exam_delivery.begin_python_execution(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_item_id uuid,
  p_expected_revision integer,
  p_client_request_id uuid,
  p_execution_request_id uuid,
  p_execution_request_digest text,
  p_wall_time_ms integer,
  p_memory_bytes bigint,
  p_output_bytes integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
  v_authorization jsonb;
  v_workspace exam_delivery.python_lab_workspaces%rowtype;
  v_run exam_delivery.python_execution_runs%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  if p_expected_revision is null or p_expected_revision < 1
    or p_client_request_id is null or p_execution_request_id is null
    or p_execution_request_digest !~ '^[0-9a-f]{64}$'
    or p_wall_time_ms <> 20000 or p_memory_bytes <> 134217728
    or p_output_bytes <> 1048576 then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  v_authorization := exam_delivery.authorize_python_lab_item(
    p_actor_id, p_attempt_id, p_item_id, 'run_request'
  );
  if not coalesce((v_authorization->>'ok')::boolean, false) then
    return v_authorization;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('issue86-run:' || p_item_id::text, 0));

  select * into v_run
  from exam_delivery.python_execution_runs run
  where run.client_request_id = p_client_request_id;
  if found then
    if v_run.attempt_id <> p_attempt_id or v_run.attempt_item_id <> p_item_id
      or v_run.workspace_revision <> p_expected_revision
      or v_run.wall_time_ms <> p_wall_time_ms
      or v_run.memory_bytes <> p_memory_bytes
      or v_run.output_bytes <> p_output_bytes then
      return jsonb_build_object('ok', false, 'code', 'run_request_conflict');
    end if;
    return jsonb_build_object(
      'ok', true, 'runId', v_run.id, 'state', v_run.state,
      'replayed', true, 'executionRequestId', v_run.execution_request_id,
      'executionRequestDigest', v_run.execution_request_digest,
      'workspaceRevision', v_run.workspace_revision,
      'workspaceHash', v_run.workspace_hash,
      'createdAt', v_run.created_at, 'updatedAt', v_run.updated_at
    );
  end if;

  if exists (
    select 1 from exam_delivery.python_execution_runs active
    where active.attempt_item_id = p_item_id
      and active.state in ('authorized', 'queued', 'running', 'cancel_requested')
  ) then
    return jsonb_build_object('ok', false, 'code', 'run_in_progress');
  end if;
  select * into v_workspace
  from exam_delivery.python_lab_workspaces workspace
  where workspace.attempt_id = p_attempt_id
    and workspace.attempt_item_id = p_item_id
  for update;
  if not found or v_workspace.current_revision <> p_expected_revision then
    return jsonb_build_object('ok', false, 'code', 'revision_conflict');
  end if;

  insert into exam_delivery.python_execution_runs(
    attempt_id, attempt_item_id, workspace_revision, workspace_hash,
    client_request_id, execution_request_id, orchestration_request_digest,
    execution_request_digest, state, wall_time_ms, memory_bytes, output_bytes,
    created_at, updated_at
  ) values (
    p_attempt_id, p_item_id, v_workspace.current_revision, v_workspace.workspace_hash,
    p_client_request_id, p_execution_request_id,
    exam_delivery.python_orchestration_request_digest(
      p_attempt_id, p_item_id, v_workspace.current_revision,
      v_workspace.workspace_hash, p_execution_request_id
    ),
    p_execution_request_digest, 'running', p_wall_time_ms, p_memory_bytes,
    p_output_bytes, v_now, v_now
  ) returning * into v_run;

  return jsonb_build_object(
    'ok', true, 'runId', v_run.id, 'state', v_run.state,
    'replayed', false, 'executionRequestId', v_run.execution_request_id,
    'executionRequestDigest', v_run.execution_request_digest,
    'workspaceRevision', v_run.workspace_revision,
    'workspaceHash', v_run.workspace_hash,
    'createdAt', v_run.created_at, 'updatedAt', v_run.updated_at
  );
exception when unique_violation then
  return jsonb_build_object('ok', false, 'code', 'run_in_progress');
end
$$;

create function exam_delivery.complete_python_execution(
  p_run_id uuid,
  p_execution_request_digest text,
  p_provider_execution_id text,
  p_execution_result_digest text,
  p_state text,
  p_terminal_outcome text,
  p_stdout text,
  p_stderr text,
  p_exit_code integer,
  p_disposal_confirmed boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
  v_run exam_delivery.python_execution_runs%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  if p_run_id is null or p_execution_request_digest !~ '^[0-9a-f]{64}$'
    or p_execution_result_digest !~ '^[0-9a-f]{64}$'
    or p_provider_execution_id is null
    or octet_length(p_provider_execution_id) not between 1 and 128
    or p_provider_execution_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    or p_stdout is null or p_stderr is null or p_disposal_confirmed is not true
    or not (
      (p_state = 'completed' and p_terminal_outcome = 'completed' and p_exit_code = 0)
      or (p_state = 'failed' and p_terminal_outcome = 'failed'
        and (p_exit_code is null or p_exit_code between 1 and 255))
      or (p_state = 'failed' and p_terminal_outcome in ('timeout', 'resource_limit')
        and p_exit_code is null)
      or (p_state = 'cancelled' and p_terminal_outcome = 'cancelled'
        and p_exit_code is null)
    ) then
    return jsonb_build_object('ok', false, 'code', 'invalid_execution_result');
  end if;
  select * into v_run from exam_delivery.python_execution_runs run
  where run.id = p_run_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'run_not_found');
  end if;
  if v_run.execution_request_digest <> p_execution_request_digest
    or octet_length(p_stdout) + octet_length(p_stderr) > v_run.output_bytes then
    return jsonb_build_object('ok', false, 'code', 'execution_binding_mismatch');
  end if;
  if v_run.state in ('completed', 'failed', 'cancelled') then
    if v_run.provider_execution_id <> p_provider_execution_id
      or v_run.execution_result_digest <> p_execution_result_digest
      or v_run.state <> p_state or v_run.terminal_outcome <> p_terminal_outcome
      or v_run.learner_stdout <> p_stdout or v_run.learner_stderr <> p_stderr
      or v_run.learner_exit_code is distinct from p_exit_code
      or v_run.disposal_state <> 'confirmed' then
      return jsonb_build_object('ok', false, 'code', 'terminal_rebinding_prohibited');
    end if;
  else
    if v_run.state = 'cancel_requested' and p_state = 'completed' then
      return jsonb_build_object('ok', false, 'code', 'invalid_lifecycle_transition');
    end if;
    update exam_delivery.python_execution_runs set
      provider_execution_id = p_provider_execution_id,
      execution_result_digest = p_execution_result_digest,
      state = p_state,
      terminal_outcome = p_terminal_outcome,
      learner_stdout = p_stdout,
      learner_stderr = p_stderr,
      learner_exit_code = p_exit_code,
      disposal_state = 'confirmed',
      disposed_at = v_now,
      completed_at = v_now,
      updated_at = v_now
    where id = p_run_id
    returning * into v_run;
  end if;
  return jsonb_build_object(
    'ok', true, 'runId', v_run.id, 'state', v_run.state,
    'terminalOutcome', v_run.terminal_outcome,
    'stdout', v_run.learner_stdout, 'stderr', v_run.learner_stderr,
    'exitCode', v_run.learner_exit_code,
    'cancellationRequestedAt', v_run.cancellation_requested_at,
    'disposalState', v_run.disposal_state,
    'createdAt', v_run.created_at, 'updatedAt', v_run.updated_at
  );
end
$$;

create or replace function exam_delivery.get_python_run(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_item_id uuid,
  p_run_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_authorization jsonb;
  v_run exam_delivery.python_execution_runs%rowtype;
begin
  if p_run_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  v_authorization := exam_delivery.authorize_python_lab_item(
    p_actor_id, p_attempt_id, p_item_id, 'run_status'
  );
  if not coalesce((v_authorization->>'ok')::boolean, false) then
    return v_authorization;
  end if;
  select * into v_run from exam_delivery.python_execution_runs run
  where run.id = p_run_id and run.attempt_id = p_attempt_id
    and run.attempt_item_id = p_item_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'run_not_found');
  end if;
  return jsonb_build_object(
    'ok', true, 'runId', v_run.id, 'state', v_run.state,
    'terminalOutcome', v_run.terminal_outcome,
    'stdout', v_run.learner_stdout, 'stderr', v_run.learner_stderr,
    'exitCode', v_run.learner_exit_code,
    'cancellationRequestedAt', v_run.cancellation_requested_at,
    'disposalState', v_run.disposal_state,
    'createdAt', v_run.created_at, 'updatedAt', v_run.updated_at
  );
end
$$;

create function exam_delivery.get_python_execution_authority(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_item_id uuid,
  p_run_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_authorization jsonb;
  v_run exam_delivery.python_execution_runs%rowtype;
  v_workspace jsonb;
begin
  v_authorization := exam_delivery.authorize_python_lab_item(
    p_actor_id, p_attempt_id, p_item_id, 'run_status'
  );
  if not coalesce((v_authorization->>'ok')::boolean, false) then
    return v_authorization;
  end if;
  select run.* into v_run
  from exam_delivery.python_execution_runs run
  where run.id = p_run_id and run.attempt_id = p_attempt_id
    and run.attempt_item_id = p_item_id;
  if not found or v_run.client_request_id is null then
    return jsonb_build_object('ok', false, 'code', 'run_not_found');
  end if;
  select revision.workspace into v_workspace
  from exam_delivery.python_lab_workspace_revisions revision
  where revision.attempt_id = v_run.attempt_id
    and revision.attempt_item_id = v_run.attempt_item_id
    and revision.revision = v_run.workspace_revision
    and revision.workspace_hash = v_run.workspace_hash;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'run_not_found');
  end if;
  return jsonb_build_object(
    'ok', true, 'runId', v_run.id, 'state', v_run.state,
    'executionRequestId', v_run.execution_request_id,
    'executionRequestDigest', v_run.execution_request_digest,
    'workspace', v_workspace, 'workspaceRevision', v_run.workspace_revision,
    'workspaceHash', v_run.workspace_hash, 'wallTimeMs', v_run.wall_time_ms,
    'memoryBytes', v_run.memory_bytes, 'outputBytes', v_run.output_bytes
  );
end
$$;

create function public.certsim_service_begin_python_execution(
  p_actor_id uuid, p_attempt_id uuid, p_item_id uuid,
  p_expected_revision integer, p_client_request_id uuid,
  p_execution_request_id uuid, p_execution_request_digest text,
  p_wall_time_ms integer, p_memory_bytes bigint, p_output_bytes integer
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select exam_delivery.begin_python_execution(
    p_actor_id, p_attempt_id, p_item_id, p_expected_revision,
    p_client_request_id, p_execution_request_id, p_execution_request_digest,
    p_wall_time_ms, p_memory_bytes, p_output_bytes
  )
$$;

create function public.certsim_service_complete_python_execution(
  p_run_id uuid, p_execution_request_digest text,
  p_provider_execution_id text, p_execution_result_digest text,
  p_state text, p_terminal_outcome text, p_stdout text, p_stderr text,
  p_exit_code integer, p_disposal_confirmed boolean
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select exam_delivery.complete_python_execution(
    p_run_id, p_execution_request_digest, p_provider_execution_id,
    p_execution_result_digest, p_state, p_terminal_outcome,
    p_stdout, p_stderr, p_exit_code, p_disposal_confirmed
  )
$$;

create function public.certsim_service_get_python_execution_authority(
  p_actor_id uuid, p_attempt_id uuid, p_item_id uuid, p_run_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select exam_delivery.get_python_execution_authority(
    p_actor_id, p_attempt_id, p_item_id, p_run_id
  )
$$;

alter function exam_delivery.guard_python_execution_run() owner to postgres;
alter function exam_delivery.begin_python_execution(
  uuid, uuid, uuid, integer, uuid, uuid, text, integer, bigint, integer
) owner to postgres;
alter function exam_delivery.complete_python_execution(
  uuid, text, text, text, text, text, text, text, integer, boolean
) owner to postgres;
alter function exam_delivery.get_python_execution_authority(
  uuid, uuid, uuid, uuid
) owner to postgres;
alter function public.certsim_service_begin_python_execution(
  uuid, uuid, uuid, integer, uuid, uuid, text, integer, bigint, integer
) owner to postgres;
alter function public.certsim_service_complete_python_execution(
  uuid, text, text, text, text, text, text, text, integer, boolean
) owner to postgres;
alter function public.certsim_service_get_python_execution_authority(
  uuid, uuid, uuid, uuid
) owner to postgres;

revoke all on function exam_delivery.begin_python_execution(
  uuid, uuid, uuid, integer, uuid, uuid, text, integer, bigint, integer
), exam_delivery.complete_python_execution(
  uuid, text, text, text, text, text, text, text, integer, boolean
), public.certsim_service_begin_python_execution(
  uuid, uuid, uuid, integer, uuid, uuid, text, integer, bigint, integer
), public.certsim_service_complete_python_execution(
  uuid, text, text, text, text, text, text, text, integer, boolean
), exam_delivery.get_python_execution_authority(
  uuid, uuid, uuid, uuid
), public.certsim_service_get_python_execution_authority(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated, service_role;

grant execute on function exam_delivery.begin_python_execution(
  uuid, uuid, uuid, integer, uuid, uuid, text, integer, bigint, integer
), exam_delivery.complete_python_execution(
  uuid, text, text, text, text, text, text, text, integer, boolean
), public.certsim_service_begin_python_execution(
  uuid, uuid, uuid, integer, uuid, uuid, text, integer, bigint, integer
), public.certsim_service_complete_python_execution(
  uuid, text, text, text, text, text, text, text, integer, boolean
), exam_delivery.get_python_execution_authority(
  uuid, uuid, uuid, uuid
), public.certsim_service_get_python_execution_authority(
  uuid, uuid, uuid, uuid
) to service_role;

comment on function exam_delivery.begin_python_execution(
  uuid, uuid, uuid, integer, uuid, uuid, text, integer, bigint, integer
) is 'Service-only idempotent Issue #86 execution begin; binds the exact saved revision and server-authored R2 request.';
comment on function exam_delivery.complete_python_execution(
  uuid, text, text, text, text, text, text, text, integer, boolean
) is 'Service-only terminal Issue #86 execution persistence with bounded learner output and confirmed disposal.';

notify pgrst, 'reload schema';

commit;
