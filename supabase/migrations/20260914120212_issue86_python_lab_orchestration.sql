begin;

-- Issue #86 R5: durable Python-lab orchestration only. This migration does not
-- activate an executor, create provider resources, store protected grading
-- material, or expose grading evidence ingestion through the Data API.

create function exam_delivery.python_workspace_valid(p_workspace jsonb)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if p_workspace is null or jsonb_typeof(p_workspace) <> 'object' then return false; end if;
  if (select count(*) <> 2 or not bool_and(key in ('entryPoint', 'files'))
      from jsonb_object_keys(p_workspace) key) then return false; end if;
  if jsonb_typeof(p_workspace->'entryPoint') <> 'string'
    or octet_length(p_workspace->>'entryPoint') not between 1 and 240
    or (p_workspace->>'entryPoint') !~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*[.]py$'
    or (p_workspace->>'entryPoint') ~ '(^|/)[.]{1,2}(/|$)'
    or jsonb_typeof(p_workspace->'files') <> 'array'
    or jsonb_array_length(p_workspace->'files') not between 1 and 16 then
    return false;
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_workspace->'files') file
    where jsonb_typeof(file) <> 'object'
      or case when jsonb_typeof(file) = 'object' then
        (select count(*) <> 2 or not bool_and(key in ('path', 'content'))
         from jsonb_object_keys(file) key)
        or jsonb_typeof(file->'path') <> 'string'
        or jsonb_typeof(file->'content') <> 'string'
        or octet_length(file->>'path') not between 1 and 240
        or (file->>'path') !~ '^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*[.]py$'
        or (file->>'path') ~ '(^|/)[.]{1,2}(/|$)'
        or octet_length(file->>'content') > 65536
      else true end
  ) then return false; end if;
  if (select count(*) <> count(distinct lower(file->>'path'))
      from jsonb_array_elements(p_workspace->'files') file) then return false; end if;
  if (select coalesce(sum(octet_length(file->>'content')), 0) > 262144
      from jsonb_array_elements(p_workspace->'files') file) then return false; end if;
  if not exists (
    select 1 from jsonb_array_elements(p_workspace->'files') file
    where file->>'path' = p_workspace->>'entryPoint'
  ) then return false; end if;
  return true;
exception when others then
  return false;
end
$$;

create function exam_delivery.normalize_python_workspace(p_workspace jsonb)
returns jsonb
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_files jsonb;
begin
  if not exam_delivery.python_workspace_valid(p_workspace) then
    raise exception 'invalid_python_workspace' using errcode = '22023';
  end if;
  select jsonb_agg(
    jsonb_build_object('path', file->>'path', 'content', file->>'content')
    order by (file->>'path') collate "C"
  ) into v_files
  from jsonb_array_elements(p_workspace->'files') file;
  return jsonb_build_object('entryPoint', p_workspace->>'entryPoint', 'files', v_files);
end
$$;

create function exam_delivery.python_workspace_hash(p_workspace jsonb)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select encode(
    extensions.digest(
      convert_to(exam_delivery.normalize_python_workspace(p_workspace)::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  )
$$;

create function exam_delivery.python_orchestration_request_digest(
  p_attempt_id uuid,
  p_item_id uuid,
  p_workspace_revision integer,
  p_workspace_hash text,
  p_execution_request_id uuid
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select encode(
    extensions.digest(
      convert_to(
        'certsim.python-execution.orchestration-request.v1' || chr(31) ||
        jsonb_build_object(
          'attemptId', p_attempt_id,
          'itemId', p_item_id,
          'workspaceRevision', p_workspace_revision,
          'workspaceHash', p_workspace_hash,
          'executionRequestId', p_execution_request_id
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

create function exam_delivery.python_grading_rules_valid(
  p_rules jsonb,
  p_earned_raw_points integer,
  p_maximum_raw_points integer
)
returns boolean
language plpgsql
immutable
security invoker
set search_path = ''
as $$
begin
  if p_rules is null or p_earned_raw_points is null or p_maximum_raw_points is null
    or jsonb_typeof(p_rules) <> 'array'
    or jsonb_array_length(p_rules) not between 1 and 128
    or p_maximum_raw_points not between 1 and 1000000
    or p_earned_raw_points not between 0 and p_maximum_raw_points then
    return false;
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_rules) rule
    where jsonb_typeof(rule) <> 'object'
      or case when jsonb_typeof(rule) = 'object' then
        (select count(*) <> 3
          or not bool_and(key in ('ruleId', 'earnedRawPoints', 'maximumRawPoints'))
         from jsonb_object_keys(rule) key)
        or jsonb_typeof(rule->'ruleId') <> 'string'
        or octet_length(rule->>'ruleId') not between 1 and 128
        or (rule->>'ruleId') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        or jsonb_typeof(rule->'earnedRawPoints') <> 'number'
        or jsonb_typeof(rule->'maximumRawPoints') <> 'number'
        or (rule->>'earnedRawPoints') !~ '^[0-9]+$'
        or (rule->>'maximumRawPoints') !~ '^[0-9]+$'
        or (rule->>'maximumRawPoints')::numeric not between 1 and 1000000
        or (rule->>'earnedRawPoints')::numeric > (rule->>'maximumRawPoints')::numeric
      else true end
  ) then return false; end if;
  if (select count(*) <> count(distinct rule->>'ruleId')
      from jsonb_array_elements(p_rules) rule) then return false; end if;
  if (select sum((rule->>'earnedRawPoints')::numeric) <> p_earned_raw_points
      from jsonb_array_elements(p_rules) rule) then return false; end if;
  if (select sum((rule->>'maximumRawPoints')::numeric) <> p_maximum_raw_points
      from jsonb_array_elements(p_rules) rule) then return false; end if;
  return true;
exception when others then
  return false;
end
$$;

create table exam_delivery.python_lab_workspaces (
  attempt_item_id uuid primary key,
  attempt_id uuid not null,
  current_revision integer not null,
  workspace jsonb not null,
  workspace_hash text not null,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  constraint python_lab_workspaces_item_fk
    foreign key (attempt_id, attempt_item_id)
    references exam_delivery.attempt_items(attempt_id, id)
    on delete restrict,
  constraint python_lab_workspaces_revision_check check (current_revision > 0),
  constraint python_lab_workspaces_workspace_check
    check (exam_delivery.python_workspace_valid(workspace)),
  constraint python_lab_workspaces_hash_check
    check (workspace_hash ~ '^[0-9a-f]{64}$'),
  constraint python_lab_workspaces_hash_matches_check
    check (workspace_hash = exam_delivery.python_workspace_hash(workspace)),
  constraint python_lab_workspaces_timestamp_check check (updated_at >= created_at),
  constraint python_lab_workspaces_current_unique
    unique (attempt_id, attempt_item_id, current_revision, workspace_hash)
);

create table exam_delivery.python_lab_workspace_revisions (
  attempt_item_id uuid not null,
  attempt_id uuid not null,
  revision integer not null,
  expected_revision integer not null,
  request_id uuid not null,
  workspace jsonb not null,
  workspace_hash text not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint python_lab_workspace_revisions_pk primary key (attempt_item_id, revision),
  constraint python_lab_workspace_revisions_item_fk
    foreign key (attempt_id, attempt_item_id)
    references exam_delivery.attempt_items(attempt_id, id)
    on delete restrict,
  constraint python_lab_workspace_revisions_request_unique unique (request_id),
  constraint python_lab_workspace_revisions_binding_unique
    unique (attempt_id, attempt_item_id, revision, workspace_hash),
  constraint python_lab_workspace_revisions_revision_check
    check (revision > 0 and expected_revision >= 0 and revision = expected_revision + 1),
  constraint python_lab_workspace_revisions_workspace_check
    check (exam_delivery.python_workspace_valid(workspace)),
  constraint python_lab_workspace_revisions_hash_check
    check (workspace_hash ~ '^[0-9a-f]{64}$'),
  constraint python_lab_workspace_revisions_hash_matches_check
    check (workspace_hash = exam_delivery.python_workspace_hash(workspace))
);

create table exam_delivery.python_execution_runs (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null,
  attempt_item_id uuid not null,
  workspace_revision integer not null,
  workspace_hash text not null,
  execution_request_id uuid not null,
  orchestration_request_digest text not null,
  execution_request_digest text,
  state text not null default 'authorized',
  provider_execution_id text,
  execution_result_digest text,
  terminal_outcome text,
  cancellation_request_id uuid,
  cancellation_requested_at timestamptz,
  disposal_state text not null default 'not_requested',
  disposed_at timestamptz,
  created_at timestamptz not null default statement_timestamp(),
  updated_at timestamptz not null default statement_timestamp(),
  completed_at timestamptz,
  constraint python_execution_runs_item_fk
    foreign key (attempt_id, attempt_item_id)
    references exam_delivery.attempt_items(attempt_id, id)
    on delete restrict,
  constraint python_execution_runs_workspace_fk
    foreign key (attempt_id, attempt_item_id, workspace_revision, workspace_hash)
    references exam_delivery.python_lab_workspace_revisions(
      attempt_id, attempt_item_id, revision, workspace_hash
    )
    on delete restrict,
  constraint python_execution_runs_request_unique unique (execution_request_id),
  constraint python_execution_runs_provider_unique unique (provider_execution_id),
  constraint python_execution_runs_cancellation_unique unique (cancellation_request_id),
  constraint python_execution_runs_orchestration_request_digest_unique
    unique (id, orchestration_request_digest),
  constraint python_execution_runs_execution_request_digest_unique
    unique (id, execution_request_digest),
  constraint python_execution_runs_execution_binding_unique
    unique (id, execution_request_digest, execution_result_digest),
  constraint python_execution_runs_revision_check check (workspace_revision > 0),
  constraint python_execution_runs_workspace_hash_check
    check (workspace_hash ~ '^[0-9a-f]{64}$'),
  constraint python_execution_runs_orchestration_request_digest_check
    check (orchestration_request_digest ~ '^[0-9a-f]{64}$'),
  constraint python_execution_runs_execution_request_digest_check
    check (execution_request_digest is null or execution_request_digest ~ '^[0-9a-f]{64}$'),
  constraint python_execution_runs_orchestration_request_digest_matches_check check (
    orchestration_request_digest = exam_delivery.python_orchestration_request_digest(
      attempt_id, attempt_item_id, workspace_revision, workspace_hash,
      execution_request_id
    )
  ),
  constraint python_execution_runs_execution_request_ready_check check (
    state = 'authorized' or execution_request_digest is not null
  ),
  constraint python_execution_runs_provider_id_check check (
    provider_execution_id is null
    or (octet_length(provider_execution_id) between 1 and 128
      and provider_execution_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  ),
  constraint python_execution_runs_result_digest_check check (
    execution_result_digest is null or execution_result_digest ~ '^[0-9a-f]{64}$'
  ),
  constraint python_execution_runs_state_check check (
    state in ('authorized', 'queued', 'running', 'cancel_requested', 'completed', 'failed', 'cancelled')
  ),
  constraint python_execution_runs_outcome_check check (
    terminal_outcome is null or terminal_outcome in ('completed', 'timeout', 'resource_limit', 'failed', 'cancelled')
  ),
  constraint python_execution_runs_terminal_check check (
    (state in ('authorized', 'queued', 'running', 'cancel_requested')
      and execution_result_digest is null and terminal_outcome is null and completed_at is null)
    or
    (state in ('completed', 'failed', 'cancelled')
      and execution_result_digest is not null and terminal_outcome is not null and completed_at is not null)
  ),
  constraint python_execution_runs_cancellation_check check (
    (cancellation_request_id is null and cancellation_requested_at is null
      and state not in ('cancel_requested', 'cancelled'))
    or
    (cancellation_request_id is not null and cancellation_requested_at is not null
      and state in ('cancel_requested', 'cancelled', 'failed'))
  ),
  constraint python_execution_runs_disposal_check check (
    disposal_state in ('not_requested', 'pending', 'confirmed', 'failed')
    and ((disposal_state = 'confirmed' and disposed_at is not null)
      or (disposal_state <> 'confirmed' and disposed_at is null))
  ),
  constraint python_execution_runs_timestamp_check check (
    updated_at >= created_at
    and (completed_at is null or completed_at >= created_at)
    and (cancellation_requested_at is null or cancellation_requested_at >= created_at)
    and (disposed_at is null or disposed_at >= created_at)
  )
);

create index python_execution_runs_attempt_item_created_idx
  on exam_delivery.python_execution_runs(attempt_id, attempt_item_id, created_at desc, id desc);

create unique index python_execution_runs_one_active_item_idx
  on exam_delivery.python_execution_runs(attempt_item_id)
  where state in ('authorized', 'queued', 'running', 'cancel_requested');

create table exam_delivery.python_grading_materializations (
  id uuid primary key,
  grading_session_id uuid not null unique,
  run_id uuid not null unique,
  execution_request_digest text not null,
  material_digest text not null,
  grading_contract_version text not null,
  maximum_raw_points integer not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint python_grading_materializations_run_fk
    foreign key (run_id, execution_request_digest)
    references exam_delivery.python_execution_runs(id, execution_request_digest)
    on delete restrict,
  constraint python_grading_materializations_binding_unique
    unique (
      id, run_id, grading_session_id, execution_request_digest, material_digest,
      grading_contract_version, maximum_raw_points
    ),
  constraint python_grading_materializations_execution_request_digest_check
    check (execution_request_digest ~ '^[0-9a-f]{64}$'),
  constraint python_grading_materializations_material_digest_check
    check (material_digest ~ '^[0-9a-f]{64}$'),
  constraint python_grading_materializations_contract_check check (
    octet_length(grading_contract_version) between 1 and 128
    and grading_contract_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint python_grading_materializations_points_check
    check (maximum_raw_points between 1 and 1000000)
);

create table exam_delivery.python_grading_evidence (
  evidence_id uuid primary key,
  run_id uuid not null unique,
  materialization_id uuid not null unique,
  grading_session_id uuid not null unique,
  execution_request_digest text not null,
  execution_result_digest text not null,
  material_digest text not null,
  grading_contract_version text not null,
  earned_raw_points integer not null,
  maximum_raw_points integer not null,
  rule_points jsonb not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint python_grading_evidence_run_fk
    foreign key (run_id, execution_request_digest, execution_result_digest)
    references exam_delivery.python_execution_runs(id, execution_request_digest, execution_result_digest)
    on delete restrict,
  constraint python_grading_evidence_materialization_fk
    foreign key (
      materialization_id, run_id, grading_session_id, execution_request_digest,
      material_digest, grading_contract_version, maximum_raw_points
    ) references exam_delivery.python_grading_materializations(
      id, run_id, grading_session_id, execution_request_digest,
      material_digest, grading_contract_version, maximum_raw_points
    ) on delete restrict,
  constraint python_grading_evidence_execution_request_digest_check
    check (execution_request_digest ~ '^[0-9a-f]{64}$'),
  constraint python_grading_evidence_result_digest_check
    check (execution_result_digest ~ '^[0-9a-f]{64}$'),
  constraint python_grading_evidence_material_digest_check
    check (material_digest ~ '^[0-9a-f]{64}$'),
  constraint python_grading_evidence_points_check check (
    maximum_raw_points between 1 and 1000000
    and earned_raw_points between 0 and maximum_raw_points
  ),
  constraint python_grading_evidence_rules_check check (
    exam_delivery.python_grading_rules_valid(
      rule_points, earned_raw_points, maximum_raw_points
    )
  )
);

alter table exam_delivery.python_lab_workspaces enable row level security;
alter table exam_delivery.python_lab_workspace_revisions enable row level security;
alter table exam_delivery.python_execution_runs enable row level security;
alter table exam_delivery.python_grading_materializations enable row level security;
alter table exam_delivery.python_grading_evidence enable row level security;

create function exam_delivery.guard_python_immutable_row()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'python_orchestration_row_immutable' using errcode = '55000';
end
$$;

create trigger guard_python_workspace_revisions_immutable
before update or delete on exam_delivery.python_lab_workspace_revisions
for each row execute function exam_delivery.guard_python_immutable_row();

create trigger guard_python_materializations_immutable
before update or delete on exam_delivery.python_grading_materializations
for each row execute function exam_delivery.guard_python_immutable_row();

create trigger guard_python_evidence_immutable
before update or delete on exam_delivery.python_grading_evidence
for each row execute function exam_delivery.guard_python_immutable_row();

create function exam_delivery.guard_python_execution_run()
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
    or old.execution_request_id is distinct from new.execution_request_id
    or old.orchestration_request_digest is distinct from new.orchestration_request_digest
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
    or old.cancellation_request_id is not null
      and old.cancellation_request_id is distinct from new.cancellation_request_id
    or old.cancellation_requested_at is not null
      and old.cancellation_requested_at is distinct from new.cancellation_requested_at
    or old.completed_at is not null and old.completed_at is distinct from new.completed_at
    or new.updated_at < old.updated_at then
    raise exception 'python_run_reconciliation_immutable' using errcode = '55000';
  end if;
  if not (
    (old.state = 'authorized' and new.state in ('authorized', 'queued', 'cancel_requested', 'failed', 'cancelled'))
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

create trigger guard_python_execution_run_transition
before update or delete on exam_delivery.python_execution_runs
for each row execute function exam_delivery.guard_python_execution_run();

create function exam_delivery.authorize_python_lab_item(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_item_id uuid,
  p_operation text
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
begin
  if p_actor_id is null or p_attempt_id is null or p_item_id is null
    or p_operation not in ('workspace_read', 'workspace_save', 'run_request', 'run_status', 'run_cancel') then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not exists (
    select 1
    from exam_delivery.attempts attempt
    join exam_delivery.attempt_items item
      on item.attempt_id = attempt.id and item.id = p_item_id
    where attempt.id = p_attempt_id
      and attempt.owner_id = p_actor_id
      and item.presentation_snapshot->>'interactionVersion' = 'executable-python-lab-v1'
  ) then
    return jsonb_build_object('ok', false, 'code', 'attempt_not_found');
  end if;
  v_authorization := exam_delivery.authorize_attempt_continuation(
    p_attempt_id,
    case when p_operation = 'workspace_read' or p_operation = 'run_status'
      then 'resume' else 'save_response' end
  );
  if not coalesce((v_authorization->>'ok')::boolean, false) then
    return v_authorization;
  end if;
  if (v_authorization->>'ownerId')::uuid <> p_actor_id then
    return jsonb_build_object('ok', false, 'code', 'attempt_not_found');
  end if;
  return jsonb_build_object('ok', true);
end
$$;

create function exam_delivery.get_python_workspace(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_item_id uuid
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
  v_workspace exam_delivery.python_lab_workspaces%rowtype;
begin
  v_authorization := exam_delivery.authorize_python_lab_item(
    p_actor_id, p_attempt_id, p_item_id, 'workspace_read'
  );
  if not coalesce((v_authorization->>'ok')::boolean, false) then
    return v_authorization;
  end if;
  select * into v_workspace
  from exam_delivery.python_lab_workspaces workspace
  where workspace.attempt_id = p_attempt_id and workspace.attempt_item_id = p_item_id;
  if not found then
    return jsonb_build_object(
      'ok', true, 'itemId', p_item_id, 'exists', false, 'revision', 0,
      'workspaceHash', null, 'workspace', null, 'updatedAt', null
    );
  end if;
  return jsonb_build_object(
    'ok', true, 'itemId', p_item_id, 'exists', true,
    'revision', v_workspace.current_revision,
    'workspaceHash', v_workspace.workspace_hash,
    'workspace', v_workspace.workspace,
    'updatedAt', v_workspace.updated_at
  );
end
$$;

create function exam_delivery.save_python_workspace(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_item_id uuid,
  p_workspace jsonb,
  p_expected_revision integer,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
  v_authorization jsonb;
  v_normalized jsonb;
  v_hash text;
  v_existing_revision exam_delivery.python_lab_workspace_revisions%rowtype;
  v_current exam_delivery.python_lab_workspaces%rowtype;
  v_next_revision integer;
  v_now timestamptz := statement_timestamp();
begin
  if p_expected_revision is null or p_expected_revision < 0 or p_request_id is null
    or not exam_delivery.python_workspace_valid(p_workspace) then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  v_authorization := exam_delivery.authorize_python_lab_item(
    p_actor_id, p_attempt_id, p_item_id, 'workspace_save'
  );
  if not coalesce((v_authorization->>'ok')::boolean, false) then
    return v_authorization;
  end if;
  v_normalized := exam_delivery.normalize_python_workspace(p_workspace);
  v_hash := exam_delivery.python_workspace_hash(v_normalized);
  perform pg_advisory_xact_lock(hashtextextended('issue86-workspace:' || p_item_id::text, 0));

  select * into v_existing_revision
  from exam_delivery.python_lab_workspace_revisions revision
  where revision.request_id = p_request_id;
  if found then
    if v_existing_revision.attempt_id = p_attempt_id
      and v_existing_revision.attempt_item_id = p_item_id
      and v_existing_revision.expected_revision = p_expected_revision
      and v_existing_revision.workspace_hash = v_hash then
      return jsonb_build_object(
        'ok', true, 'itemId', p_item_id,
        'revision', v_existing_revision.revision,
        'workspaceHash', v_existing_revision.workspace_hash,
        'updatedAt', v_existing_revision.created_at
      );
    end if;
    return jsonb_build_object('ok', false, 'code', 'workspace_request_conflict');
  end if;

  select * into v_current
  from exam_delivery.python_lab_workspaces workspace
  where workspace.attempt_item_id = p_item_id
  for update;
  if found and v_current.current_revision <> p_expected_revision then
    return jsonb_build_object('ok', false, 'code', 'revision_conflict');
  end if;
  if not found and p_expected_revision <> 0 then
    return jsonb_build_object('ok', false, 'code', 'revision_conflict');
  end if;
  v_next_revision := p_expected_revision + 1;

  insert into exam_delivery.python_lab_workspace_revisions(
    attempt_item_id, attempt_id, revision, expected_revision, request_id,
    workspace, workspace_hash, created_at
  ) values (
    p_item_id, p_attempt_id, v_next_revision, p_expected_revision, p_request_id,
    v_normalized, v_hash, v_now
  );
  insert into exam_delivery.python_lab_workspaces(
    attempt_item_id, attempt_id, current_revision, workspace, workspace_hash,
    created_at, updated_at
  ) values (
    p_item_id, p_attempt_id, v_next_revision, v_normalized, v_hash, v_now, v_now
  ) on conflict (attempt_item_id) do update set
    current_revision = excluded.current_revision,
    workspace = excluded.workspace,
    workspace_hash = excluded.workspace_hash,
    updated_at = excluded.updated_at;

  return jsonb_build_object(
    'ok', true, 'itemId', p_item_id, 'revision', v_next_revision,
    'workspaceHash', v_hash, 'updatedAt', v_now
  );
exception when unique_violation then
  select * into v_existing_revision
  from exam_delivery.python_lab_workspace_revisions revision
  where revision.request_id = p_request_id;
  if found and v_existing_revision.attempt_id = p_attempt_id
    and v_existing_revision.attempt_item_id = p_item_id
    and v_existing_revision.expected_revision = p_expected_revision
    and v_existing_revision.workspace_hash = v_hash then
    return jsonb_build_object(
      'ok', true, 'itemId', p_item_id,
      'revision', v_existing_revision.revision,
      'workspaceHash', v_existing_revision.workspace_hash,
      'updatedAt', v_existing_revision.created_at
    );
  end if;
  return jsonb_build_object('ok', false, 'code', 'workspace_request_conflict');
end
$$;

create function exam_delivery.request_python_run(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_item_id uuid,
  p_expected_revision integer,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_authorization jsonb;
begin
  if p_expected_revision is null or p_expected_revision < 1 or p_request_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  v_authorization := exam_delivery.authorize_python_lab_item(
    p_actor_id, p_attempt_id, p_item_id, 'run_request'
  );
  if not coalesce((v_authorization->>'ok')::boolean, false) then
    return v_authorization;
  end if;
  if not exists (
    select 1 from exam_delivery.python_lab_workspaces workspace
    where workspace.attempt_id = p_attempt_id
      and workspace.attempt_item_id = p_item_id
      and workspace.current_revision = p_expected_revision
  ) then
    return jsonb_build_object('ok', false, 'code', 'revision_conflict');
  end if;
  -- Deliberately no insert and no provider call while the executor is disabled.
  return jsonb_build_object('ok', false, 'code', 'executor_disabled');
end
$$;

create function exam_delivery.get_python_run(
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
    'cancellationRequestedAt', v_run.cancellation_requested_at,
    'disposalState', v_run.disposal_state,
    'createdAt', v_run.created_at, 'updatedAt', v_run.updated_at
  );
end
$$;

create function exam_delivery.cancel_python_run(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_item_id uuid,
  p_run_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
  v_authorization jsonb;
  v_run exam_delivery.python_execution_runs%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  if p_run_id is null or p_request_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  v_authorization := exam_delivery.authorize_python_lab_item(
    p_actor_id, p_attempt_id, p_item_id, 'run_cancel'
  );
  if not coalesce((v_authorization->>'ok')::boolean, false) then
    return v_authorization;
  end if;
  select * into v_run from exam_delivery.python_execution_runs run
  where run.id = p_run_id and run.attempt_id = p_attempt_id
    and run.attempt_item_id = p_item_id
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'run_not_found');
  end if;
  if v_run.state in ('completed', 'failed') then
    return jsonb_build_object('ok', false, 'code', 'invalid_lifecycle_transition');
  end if;
  if v_run.state not in ('cancel_requested', 'cancelled') then
    if exists (
      select 1 from exam_delivery.python_execution_runs existing
      where existing.cancellation_request_id = p_request_id and existing.id <> p_run_id
    ) then
      return jsonb_build_object('ok', false, 'code', 'run_request_conflict');
    end if;
    update exam_delivery.python_execution_runs set
      state = 'cancel_requested',
      cancellation_request_id = p_request_id,
      cancellation_requested_at = v_now,
      disposal_state = 'pending',
      updated_at = v_now
    where id = p_run_id
    returning * into v_run;
  end if;
  return jsonb_build_object(
    'ok', true, 'runId', v_run.id, 'state', v_run.state,
    'terminalOutcome', v_run.terminal_outcome,
    'cancellationRequestedAt', v_run.cancellation_requested_at,
    'disposalState', v_run.disposal_state,
    'createdAt', v_run.created_at, 'updatedAt', v_run.updated_at
  );
end
$$;

-- This is the R5 persistence integration point after successful R4 HMAC
-- verification. It intentionally receives no signature/key and is not granted
-- to service_role or any browser role in R5.
create function exam_delivery.persist_verified_python_grading_evidence(
  p_evidence_id uuid,
  p_run_id uuid,
  p_materialization_id uuid,
  p_grading_session_id uuid,
  p_execution_request_digest text,
  p_execution_result_digest text,
  p_material_digest text,
  p_grading_contract_version text,
  p_earned_raw_points integer,
  p_maximum_raw_points integer,
  p_rule_points jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
begin
  if p_evidence_id is null or p_run_id is null or p_materialization_id is null
    or p_grading_session_id is null
    or p_execution_request_digest !~ '^[0-9a-f]{64}$'
    or p_execution_result_digest !~ '^[0-9a-f]{64}$'
    or p_material_digest !~ '^[0-9a-f]{64}$'
    or not exam_delivery.python_grading_rules_valid(
      p_rule_points, p_earned_raw_points, p_maximum_raw_points
    ) then
    return jsonb_build_object('ok', false, 'code', 'invalid_grading_evidence');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('issue86-evidence:' || p_run_id::text, 0));
  if exists (
    select 1 from exam_delivery.python_grading_evidence evidence
    where evidence.evidence_id = p_evidence_id or evidence.run_id = p_run_id
      or evidence.materialization_id = p_materialization_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'grading_evidence_replay');
  end if;
  if not exists (
    select 1 from exam_delivery.python_execution_runs run
    where run.id = p_run_id and run.state in ('completed', 'failed', 'cancelled')
      and run.execution_request_digest = p_execution_request_digest
      and run.execution_result_digest = p_execution_result_digest
  ) then
    return jsonb_build_object('ok', false, 'code', 'grading_binding_mismatch');
  end if;
  insert into exam_delivery.python_grading_evidence(
    evidence_id, run_id, materialization_id, grading_session_id,
    execution_request_digest, execution_result_digest, material_digest,
    grading_contract_version, earned_raw_points, maximum_raw_points, rule_points
  ) values (
    p_evidence_id, p_run_id, p_materialization_id, p_grading_session_id,
    p_execution_request_digest, p_execution_result_digest, p_material_digest,
    p_grading_contract_version, p_earned_raw_points, p_maximum_raw_points,
    p_rule_points
  );
  return jsonb_build_object(
    'ok', true, 'evidenceId', p_evidence_id,
    'earnedRawPoints', p_earned_raw_points,
    'maximumRawPoints', p_maximum_raw_points
  );
exception when foreign_key_violation or unique_violation or check_violation then
  return jsonb_build_object('ok', false, 'code', 'grading_binding_mismatch');
end
$$;

create function public.certsim_protected_get_python_workspace(
  p_actor_id uuid, p_attempt_id uuid, p_item_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select exam_delivery.get_python_workspace(p_actor_id, p_attempt_id, p_item_id)
$$;

create function public.certsim_protected_save_python_workspace(
  p_actor_id uuid, p_attempt_id uuid, p_item_id uuid, p_workspace jsonb,
  p_expected_revision integer, p_request_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select exam_delivery.save_python_workspace(
    p_actor_id, p_attempt_id, p_item_id, p_workspace,
    p_expected_revision, p_request_id
  )
$$;

create function public.certsim_protected_request_python_run(
  p_actor_id uuid, p_attempt_id uuid, p_item_id uuid,
  p_expected_revision integer, p_request_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select exam_delivery.request_python_run(
    p_actor_id, p_attempt_id, p_item_id, p_expected_revision, p_request_id
  )
$$;

create function public.certsim_protected_get_python_run(
  p_actor_id uuid, p_attempt_id uuid, p_item_id uuid, p_run_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select exam_delivery.get_python_run(p_actor_id, p_attempt_id, p_item_id, p_run_id)
$$;

create function public.certsim_protected_cancel_python_run(
  p_actor_id uuid, p_attempt_id uuid, p_item_id uuid,
  p_run_id uuid, p_request_id uuid
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select exam_delivery.cancel_python_run(
    p_actor_id, p_attempt_id, p_item_id, p_run_id, p_request_id
  )
$$;

alter table exam_delivery.python_lab_workspaces owner to postgres;
alter table exam_delivery.python_lab_workspace_revisions owner to postgres;
alter table exam_delivery.python_execution_runs owner to postgres;
alter table exam_delivery.python_grading_materializations owner to postgres;
alter table exam_delivery.python_grading_evidence owner to postgres;

alter function exam_delivery.python_workspace_valid(jsonb) owner to postgres;
alter function exam_delivery.normalize_python_workspace(jsonb) owner to postgres;
alter function exam_delivery.python_workspace_hash(jsonb) owner to postgres;
alter function exam_delivery.python_orchestration_request_digest(uuid, uuid, integer, text, uuid) owner to postgres;
alter function exam_delivery.python_grading_rules_valid(jsonb, integer, integer) owner to postgres;
alter function exam_delivery.guard_python_immutable_row() owner to postgres;
alter function exam_delivery.guard_python_execution_run() owner to postgres;
alter function exam_delivery.authorize_python_lab_item(uuid, uuid, uuid, text) owner to postgres;
alter function exam_delivery.get_python_workspace(uuid, uuid, uuid) owner to postgres;
alter function exam_delivery.save_python_workspace(uuid, uuid, uuid, jsonb, integer, uuid) owner to postgres;
alter function exam_delivery.request_python_run(uuid, uuid, uuid, integer, uuid) owner to postgres;
alter function exam_delivery.get_python_run(uuid, uuid, uuid, uuid) owner to postgres;
alter function exam_delivery.cancel_python_run(uuid, uuid, uuid, uuid, uuid) owner to postgres;
alter function exam_delivery.persist_verified_python_grading_evidence(
  uuid, uuid, uuid, uuid, text, text, text, text, integer, integer, jsonb
) owner to postgres;
alter function public.certsim_protected_get_python_workspace(uuid, uuid, uuid) owner to postgres;
alter function public.certsim_protected_save_python_workspace(uuid, uuid, uuid, jsonb, integer, uuid) owner to postgres;
alter function public.certsim_protected_request_python_run(uuid, uuid, uuid, integer, uuid) owner to postgres;
alter function public.certsim_protected_get_python_run(uuid, uuid, uuid, uuid) owner to postgres;
alter function public.certsim_protected_cancel_python_run(uuid, uuid, uuid, uuid, uuid) owner to postgres;

revoke all on table exam_delivery.python_lab_workspaces,
  exam_delivery.python_lab_workspace_revisions,
  exam_delivery.python_execution_runs,
  exam_delivery.python_grading_materializations,
  exam_delivery.python_grading_evidence
from public, anon, authenticated, service_role;

revoke execute on function exam_delivery.python_workspace_valid(jsonb),
  exam_delivery.normalize_python_workspace(jsonb),
  exam_delivery.python_workspace_hash(jsonb),
  exam_delivery.python_orchestration_request_digest(uuid, uuid, integer, text, uuid),
  exam_delivery.python_grading_rules_valid(jsonb, integer, integer),
  exam_delivery.guard_python_immutable_row(),
  exam_delivery.guard_python_execution_run(),
  exam_delivery.authorize_python_lab_item(uuid, uuid, uuid, text),
  exam_delivery.get_python_workspace(uuid, uuid, uuid),
  exam_delivery.save_python_workspace(uuid, uuid, uuid, jsonb, integer, uuid),
  exam_delivery.request_python_run(uuid, uuid, uuid, integer, uuid),
  exam_delivery.get_python_run(uuid, uuid, uuid, uuid),
  exam_delivery.cancel_python_run(uuid, uuid, uuid, uuid, uuid),
  exam_delivery.persist_verified_python_grading_evidence(
    uuid, uuid, uuid, uuid, text, text, text, text, integer, integer, jsonb
  )
from public, anon, authenticated, service_role;

revoke execute on function public.certsim_protected_get_python_workspace(uuid, uuid, uuid),
  public.certsim_protected_save_python_workspace(uuid, uuid, uuid, jsonb, integer, uuid),
  public.certsim_protected_request_python_run(uuid, uuid, uuid, integer, uuid),
  public.certsim_protected_get_python_run(uuid, uuid, uuid, uuid),
  public.certsim_protected_cancel_python_run(uuid, uuid, uuid, uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function exam_delivery.get_python_workspace(uuid, uuid, uuid),
  exam_delivery.save_python_workspace(uuid, uuid, uuid, jsonb, integer, uuid),
  exam_delivery.request_python_run(uuid, uuid, uuid, integer, uuid),
  exam_delivery.get_python_run(uuid, uuid, uuid, uuid),
  exam_delivery.cancel_python_run(uuid, uuid, uuid, uuid, uuid)
to service_role;

grant execute on function public.certsim_protected_get_python_workspace(uuid, uuid, uuid),
  public.certsim_protected_save_python_workspace(uuid, uuid, uuid, jsonb, integer, uuid),
  public.certsim_protected_request_python_run(uuid, uuid, uuid, integer, uuid),
  public.certsim_protected_get_python_run(uuid, uuid, uuid, uuid),
  public.certsim_protected_cancel_python_run(uuid, uuid, uuid, uuid, uuid)
to service_role;

comment on table exam_delivery.python_lab_workspace_revisions is
  'Immutable learner workspace revisions; no protected grading material.';
comment on table exam_delivery.python_execution_runs is
  'Provider-neutral run authority with distinct orchestration and canonical R2 execution-request digests. R5 creates no learner-requested run while disabled.';
comment on table exam_delivery.python_grading_evidence is
  'Opaque verified raw-point evidence only; generic CertSim remains final scoring authority.';
comment on function exam_delivery.persist_verified_python_grading_evidence(
  uuid, uuid, uuid, uuid, text, text, text, text, integer, integer, jsonb
) is
  'Internal disabled R5 persistence hook. Grant only after trusted R4 verification integration.';

notify pgrst, 'reload schema';

commit;
