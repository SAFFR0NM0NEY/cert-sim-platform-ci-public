begin;

-- Issue #86 trusted grading completion. Protected grading material remains in
-- the existing scoring snapshot; these rows bind submission identity, the
-- frozen workspace revision, R2 execution, R4 evidence, and generic scoring.

create table exam_delivery.python_submission_grading_sessions (
  attempt_id uuid primary key references exam_delivery.attempts(id) on delete restrict,
  submission_id uuid not null unique,
  created_at timestamptz not null default statement_timestamp(),
  constraint python_submission_grading_sessions_binding_unique
    unique (attempt_id, submission_id)
);

create table exam_delivery.python_submission_grading_runs (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null,
  submission_id uuid not null,
  attempt_item_id uuid not null,
  attempt_number integer not null,
  run_id uuid not null unique references exam_delivery.python_execution_runs(id) on delete restrict,
  materialization_id uuid not null unique,
  grading_session_id uuid not null unique,
  workspace_revision integer not null,
  workspace_hash text not null,
  material_digest text not null,
  grading_contract_version text not null,
  maximum_raw_points integer not null,
  created_at timestamptz not null default statement_timestamp(),
  constraint python_submission_grading_runs_session_fk
    foreign key (attempt_id, submission_id)
    references exam_delivery.python_submission_grading_sessions(attempt_id, submission_id)
    on delete restrict,
  constraint python_submission_grading_runs_item_fk
    foreign key (attempt_id, attempt_item_id)
    references exam_delivery.attempt_items(attempt_id, id)
    on delete restrict,
  constraint python_submission_grading_runs_workspace_fk
    foreign key (attempt_id, attempt_item_id, workspace_revision, workspace_hash)
    references exam_delivery.python_lab_workspace_revisions(
      attempt_id, attempt_item_id, revision, workspace_hash
    ) on delete restrict,
  constraint python_submission_grading_runs_attempt_number_check
    check (attempt_number > 0),
  constraint python_submission_grading_runs_workspace_revision_check
    check (workspace_revision > 0),
  constraint python_submission_grading_runs_workspace_hash_check
    check (workspace_hash ~ '^[0-9a-f]{64}$'),
  constraint python_submission_grading_runs_material_digest_check
    check (material_digest ~ '^[0-9a-f]{64}$'),
  constraint python_submission_grading_runs_contract_check check (
    octet_length(grading_contract_version) between 1 and 128
    and grading_contract_version ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  ),
  constraint python_submission_grading_runs_points_check
    check (maximum_raw_points between 1 and 1000000),
  constraint python_submission_grading_runs_attempt_unique
    unique (attempt_id, attempt_item_id, attempt_number)
);

create index python_submission_grading_runs_lookup_idx
  on exam_delivery.python_submission_grading_runs(
    attempt_id, submission_id, attempt_item_id, attempt_number desc
  );

alter table exam_delivery.python_submission_grading_sessions enable row level security;
alter table exam_delivery.python_submission_grading_runs enable row level security;

create function exam_delivery.guard_python_submission_grading_immutable()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'python_submission_grading_row_immutable' using errcode = '55000';
end
$$;

create trigger guard_python_submission_grading_sessions_immutable
before update or delete on exam_delivery.python_submission_grading_sessions
for each row execute function exam_delivery.guard_python_submission_grading_immutable();

create trigger guard_python_submission_grading_runs_immutable
before update or delete on exam_delivery.python_submission_grading_runs
for each row execute function exam_delivery.guard_python_submission_grading_immutable();

create or replace function exam_delivery.save_python_workspace(
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
  perform pg_advisory_xact_lock(hashtextextended('issue86-submission:' || p_attempt_id::text, 0));
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
  if exists (
    select 1 from exam_delivery.python_submission_grading_sessions session
    where session.attempt_id = p_attempt_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'submission_in_progress');
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

create function exam_delivery.prepare_python_submission_grading(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_submission_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
declare
  v_attempt exam_delivery.attempts%rowtype;
  v_existing_submission uuid;
  v_session exam_delivery.python_submission_grading_sessions%rowtype;
  v_authorization jsonb;
  v_item record;
  v_latest record;
  v_attempt_number integer;
  v_run_id uuid;
  v_client_request_id uuid;
  v_execution_request_id uuid;
  v_materialization_id uuid;
  v_grading_session_id uuid;
  v_items jsonb;
  v_ready boolean;
begin
  if p_actor_id is null or p_attempt_id is null or p_submission_id is null then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  perform pg_advisory_xact_lock(hashtextextended('issue86-submission:' || p_attempt_id::text, 0));
  select * into v_attempt from exam_delivery.attempts attempt
  where attempt.id = p_attempt_id and attempt.owner_id = p_actor_id
  for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'attempt_not_found'); end if;
  select result.submission_id into v_existing_submission
  from exam_delivery.attempt_results result where result.attempt_id = p_attempt_id;
  if found then
    if v_existing_submission = p_submission_id then
      return jsonb_build_object('ok', true, 'required', false, 'ready', true, 'completed', true, 'items', '[]'::jsonb);
    end if;
    return jsonb_build_object('ok', false, 'code', 'submission_conflict');
  end if;
  v_authorization := exam_delivery.authorize_attempt_continuation(p_attempt_id, 'submit');
  if not coalesce((v_authorization->>'ok')::boolean, false) then return v_authorization; end if;
  if (v_authorization->>'ownerId')::uuid <> p_actor_id then
    return jsonb_build_object('ok', false, 'code', 'attempt_not_found');
  end if;
  if not exists (
    select 1 from exam_delivery.attempt_items item
    join exam_delivery.package_questions question on question.id = item.package_question_id
    where item.attempt_id = p_attempt_id
      and question.question_type = 'executable-python-lab-v1'
  ) then
    return jsonb_build_object('ok', true, 'required', false, 'ready', true, 'completed', false, 'items', '[]'::jsonb);
  end if;
  if exists (
    select 1
    from exam_delivery.attempt_items item
    join exam_delivery.package_questions question on question.id = item.package_question_id
    left join exam_delivery.python_lab_workspaces workspace
      on workspace.attempt_id = item.attempt_id and workspace.attempt_item_id = item.id
    where item.attempt_id = p_attempt_id
      and question.question_type = 'executable-python-lab-v1'
      and workspace.attempt_item_id is null
  ) then
    return jsonb_build_object('ok', false, 'code', 'python_workspace_required');
  end if;
  if exists (
    select 1
    from exam_delivery.attempt_items item
    join exam_delivery.package_questions question on question.id = item.package_question_id
    join exam_delivery.attempt_item_protected_content protected on protected.attempt_item_id = item.id
    where item.attempt_id = p_attempt_id
      and question.question_type = 'executable-python-lab-v1'
      and (
        jsonb_typeof(protected.scoring_snapshot) <> 'object'
        or not exam_delivery.json_has_exact_keys(
          protected.scoring_snapshot, array['maximumRawPoints','trustedGrading']
        )
        or jsonb_typeof(protected.scoring_snapshot->'maximumRawPoints') <> 'number'
        or protected.scoring_snapshot->>'maximumRawPoints' !~ '^[1-9][0-9]*$'
        or jsonb_typeof(protected.scoring_snapshot->'trustedGrading') <> 'object'
        or not exam_delivery.json_has_exact_keys(
          protected.scoring_snapshot->'trustedGrading',
          array['status','materialDigest','gradingMaterial']
        )
        or protected.scoring_snapshot#>>'{trustedGrading,status}' <> 'compiled'
        or protected.scoring_snapshot#>>'{trustedGrading,materialDigest}' !~ '^[0-9a-f]{64}$'
        or jsonb_typeof(protected.scoring_snapshot#>'{trustedGrading,gradingMaterial}') <> 'object'
        or not exam_delivery.json_has_exact_keys(
          protected.scoring_snapshot#>'{trustedGrading,gradingMaterial}',
          array['contractVersion','taskId','maximumRawPoints','rules']
        )
        or protected.scoring_snapshot#>>'{trustedGrading,gradingMaterial,contractVersion}'
          <> 'certsim-python-trusted-grading-v1'
        or protected.scoring_snapshot#>>'{trustedGrading,gradingMaterial,taskId}' <> question.question_id
        or protected.scoring_snapshot#>>'{trustedGrading,gradingMaterial,maximumRawPoints}'
          <> protected.scoring_snapshot->>'maximumRawPoints'
        or jsonb_typeof(protected.scoring_snapshot#>'{trustedGrading,gradingMaterial,rules}') <> 'array'
        or jsonb_array_length(protected.scoring_snapshot#>'{trustedGrading,gradingMaterial,rules}') not between 1 and 128
      )
  ) then
    return jsonb_build_object('ok', false, 'code', 'grading_material_invalid');
  end if;

  select * into v_session
  from exam_delivery.python_submission_grading_sessions session
  where session.attempt_id = p_attempt_id;
  if found and v_session.submission_id <> p_submission_id then
    return jsonb_build_object('ok', false, 'code', 'submission_conflict');
  end if;
  if not found then
    insert into exam_delivery.python_submission_grading_sessions(attempt_id, submission_id)
    values (p_attempt_id, p_submission_id)
    returning * into v_session;
  end if;

  for v_item in
    select item.id item_id, workspace.current_revision, workspace.workspace_hash,
      (protected.scoring_snapshot->>'maximumRawPoints')::integer maximum_raw_points,
      protected.scoring_snapshot#>>'{trustedGrading,materialDigest}' material_digest,
      protected.scoring_snapshot#>>'{trustedGrading,gradingMaterial,contractVersion}' grading_contract_version
    from exam_delivery.attempt_items item
    join exam_delivery.package_questions question on question.id = item.package_question_id
    join exam_delivery.attempt_item_protected_content protected on protected.attempt_item_id = item.id
    join exam_delivery.python_lab_workspaces workspace
      on workspace.attempt_id = item.attempt_id and workspace.attempt_item_id = item.id
    where item.attempt_id = p_attempt_id
      and question.question_type = 'executable-python-lab-v1'
    order by item.presented_question_number, item.id
  loop
    if exists (
      select 1
      from exam_delivery.python_submission_grading_runs submission_run
      join exam_delivery.python_grading_evidence evidence on evidence.run_id = submission_run.run_id
      where submission_run.attempt_id = p_attempt_id
        and submission_run.submission_id = p_submission_id
        and submission_run.attempt_item_id = v_item.item_id
    ) then continue; end if;

    select submission_run.*, run.state into v_latest
    from exam_delivery.python_submission_grading_runs submission_run
    join exam_delivery.python_execution_runs run on run.id = submission_run.run_id
    where submission_run.attempt_id = p_attempt_id
      and submission_run.submission_id = p_submission_id
      and submission_run.attempt_item_id = v_item.item_id
    order by submission_run.attempt_number desc limit 1;
    if not found or v_latest.state in ('completed','failed','cancelled') then
      v_attempt_number := coalesce(v_latest.attempt_number, 0) + 1;
      v_run_id := gen_random_uuid();
      v_client_request_id := gen_random_uuid();
      v_execution_request_id := gen_random_uuid();
      v_materialization_id := gen_random_uuid();
      v_grading_session_id := gen_random_uuid();
      insert into exam_delivery.python_execution_runs(
        id, attempt_id, attempt_item_id, workspace_revision, workspace_hash,
        client_request_id, execution_request_id, orchestration_request_digest,
        state, wall_time_ms, memory_bytes, output_bytes
      ) values (
        v_run_id, p_attempt_id, v_item.item_id, v_item.current_revision,
        v_item.workspace_hash, v_client_request_id, v_execution_request_id,
        exam_delivery.python_orchestration_request_digest(
          p_attempt_id, v_item.item_id, v_item.current_revision,
          v_item.workspace_hash, v_execution_request_id
        ), 'authorized', 20000, 134217728, 1048576
      );
      insert into exam_delivery.python_submission_grading_runs(
        attempt_id, submission_id, attempt_item_id, attempt_number, run_id,
        materialization_id, grading_session_id, workspace_revision, workspace_hash,
        material_digest, grading_contract_version, maximum_raw_points
      ) values (
        p_attempt_id, p_submission_id, v_item.item_id, v_attempt_number, v_run_id,
        v_materialization_id, v_grading_session_id, v_item.current_revision,
        v_item.workspace_hash, v_item.material_digest,
        v_item.grading_contract_version, v_item.maximum_raw_points
      );
    end if;
  end loop;

  with executable as (
    select item.id item_id, item.presented_question_number,
      workspace.workspace,
      protected.scoring_snapshot#>'{trustedGrading,gradingMaterial}' grading_material
    from exam_delivery.attempt_items item
    join exam_delivery.package_questions question on question.id = item.package_question_id
    join exam_delivery.attempt_item_protected_content protected on protected.attempt_item_id = item.id
    join exam_delivery.python_lab_workspaces workspace
      on workspace.attempt_id = item.attempt_id and workspace.attempt_item_id = item.id
    where item.attempt_id = p_attempt_id
      and question.question_type = 'executable-python-lab-v1'
  ), selected as (
    select executable.*, submission_run.*, run.execution_request_id,
      run.execution_request_digest, run.state, run.created_at run_created_at,
      evidence.evidence_id is not null graded
    from executable
    cross join lateral (
      select candidate.*
      from exam_delivery.python_submission_grading_runs candidate
      left join exam_delivery.python_grading_evidence candidate_evidence
        on candidate_evidence.run_id = candidate.run_id
      where candidate.attempt_id = p_attempt_id
        and candidate.submission_id = p_submission_id
        and candidate.attempt_item_id = executable.item_id
      order by (candidate_evidence.evidence_id is not null) desc,
        candidate.attempt_number desc
      limit 1
    ) submission_run
    join exam_delivery.python_execution_runs run on run.id = submission_run.run_id
    left join exam_delivery.python_grading_evidence evidence on evidence.run_id = run.id
  )
  select jsonb_agg(jsonb_build_object(
    'itemId', item_id,
    'runId', run_id,
    'state', case when graded then 'graded' else state end,
    'attemptNumber', attempt_number,
    'executionRequestId', execution_request_id,
    'executionRequestDigest', execution_request_digest,
    'workspaceRevision', workspace_revision,
    'workspaceHash', workspace_hash,
    'workspace', workspace,
    'materializationId', materialization_id,
    'gradingSessionId', grading_session_id,
    'materialDigest', material_digest,
    'gradingContractVersion', grading_contract_version,
    'maximumRawPoints', maximum_raw_points,
    'gradingMaterial', grading_material,
    'createdAt', run_created_at
  ) order by presented_question_number, item_id), bool_and(graded)
  into v_items, v_ready from selected;

  return jsonb_build_object(
    'ok', true, 'required', true, 'ready', coalesce(v_ready, false),
    'completed', false, 'items', coalesce(v_items, '[]'::jsonb)
  );
end
$$;

create function exam_delivery.materialize_python_submission_grading(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_submission_id uuid,
  p_item_id uuid,
  p_run_id uuid,
  p_execution_request_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
  v_submission_run exam_delivery.python_submission_grading_runs%rowtype;
  v_run exam_delivery.python_execution_runs%rowtype;
  v_materialization exam_delivery.python_grading_materializations%rowtype;
begin
  if p_execution_request_digest !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok', false, 'code', 'invalid_request');
  end if;
  if not exists (
    select 1 from exam_delivery.attempts attempt
    where attempt.id = p_attempt_id and attempt.owner_id = p_actor_id
  ) then return jsonb_build_object('ok', false, 'code', 'attempt_not_found'); end if;
  perform pg_advisory_xact_lock(hashtextextended('issue86-grading-run:' || p_run_id::text, 0));
  select * into v_submission_run
  from exam_delivery.python_submission_grading_runs submission_run
  where submission_run.attempt_id = p_attempt_id
    and submission_run.submission_id = p_submission_id
    and submission_run.attempt_item_id = p_item_id
    and submission_run.run_id = p_run_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'grading_binding_mismatch'); end if;
  select * into v_run from exam_delivery.python_execution_runs run
  where run.id = p_run_id for update;
  select * into v_materialization
  from exam_delivery.python_grading_materializations materialization
  where materialization.id = v_submission_run.materialization_id;

  if found then
    if v_materialization.run_id <> p_run_id
      or v_materialization.execution_request_digest <> p_execution_request_digest
      or v_materialization.grading_session_id <> v_submission_run.grading_session_id
      or v_materialization.material_digest <> v_submission_run.material_digest
      or v_materialization.grading_contract_version <> v_submission_run.grading_contract_version
      or v_materialization.maximum_raw_points <> v_submission_run.maximum_raw_points
      or v_run.execution_request_digest <> p_execution_request_digest then
      return jsonb_build_object('ok', false, 'code', 'grading_binding_mismatch');
    end if;
    return jsonb_build_object(
      'ok', true, 'claimed', false, 'state', v_run.state,
      'runId', p_run_id, 'materializationId', v_submission_run.materialization_id,
      'gradingSessionId', v_submission_run.grading_session_id
    );
  end if;
  if v_run.state <> 'authorized' or v_run.execution_request_digest is not null
    or v_run.workspace_revision <> v_submission_run.workspace_revision
    or v_run.workspace_hash <> v_submission_run.workspace_hash then
    return jsonb_build_object('ok', false, 'code', 'grading_reconciliation_required');
  end if;
  update exam_delivery.python_execution_runs set
    execution_request_digest = p_execution_request_digest,
    state = 'running', updated_at = statement_timestamp()
  where id = p_run_id returning * into v_run;
  insert into exam_delivery.python_grading_materializations(
    id, grading_session_id, run_id, execution_request_digest, material_digest,
    grading_contract_version, maximum_raw_points
  ) values (
    v_submission_run.materialization_id, v_submission_run.grading_session_id,
    p_run_id, p_execution_request_digest, v_submission_run.material_digest,
    v_submission_run.grading_contract_version, v_submission_run.maximum_raw_points
  );
  return jsonb_build_object(
    'ok', true, 'claimed', true, 'state', v_run.state,
    'runId', p_run_id, 'materializationId', v_submission_run.materialization_id,
    'gradingSessionId', v_submission_run.grading_session_id
  );
exception when unique_violation or foreign_key_violation or check_violation then
  return jsonb_build_object('ok', false, 'code', 'grading_binding_mismatch');
end
$$;

create or replace function exam_delivery.persist_verified_python_grading_evidence(
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
declare
  v_existing exam_delivery.python_grading_evidence%rowtype;
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
  select * into v_existing from exam_delivery.python_grading_evidence evidence
  where evidence.evidence_id = p_evidence_id or evidence.run_id = p_run_id
    or evidence.materialization_id = p_materialization_id
    or evidence.grading_session_id = p_grading_session_id;
  if found then
    if v_existing.evidence_id = p_evidence_id
      and v_existing.run_id = p_run_id
      and v_existing.materialization_id = p_materialization_id
      and v_existing.grading_session_id = p_grading_session_id
      and v_existing.execution_request_digest = p_execution_request_digest
      and v_existing.execution_result_digest = p_execution_result_digest
      and v_existing.material_digest = p_material_digest
      and v_existing.grading_contract_version = p_grading_contract_version
      and v_existing.earned_raw_points = p_earned_raw_points
      and v_existing.maximum_raw_points = p_maximum_raw_points
      and v_existing.rule_points = p_rule_points then
      return jsonb_build_object(
        'ok', true, 'replayed', true, 'evidenceId', p_evidence_id,
        'earnedRawPoints', p_earned_raw_points,
        'maximumRawPoints', p_maximum_raw_points
      );
    end if;
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
    'ok', true, 'replayed', false, 'evidenceId', p_evidence_id,
    'earnedRawPoints', p_earned_raw_points,
    'maximumRawPoints', p_maximum_raw_points
  );
exception when foreign_key_violation or unique_violation or check_violation then
  return jsonb_build_object('ok', false, 'code', 'grading_binding_mismatch');
end
$$;

create function exam_delivery.score_attempt_item_with_trusted_grading(
  p_attempt_id uuid,
  p_submission_id uuid,
  p_item_id uuid,
  p_scorer_version text,
  p_question_type text,
  p_presentation jsonb,
  p_scoring jsonb,
  p_response jsonb,
  p_scored boolean
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_evidence exam_delivery.python_grading_evidence%rowtype;
begin
  if p_question_type <> 'executable-python-lab-v1' then
    return exam_delivery.score_package_v2_response_for_scorer(
      p_scorer_version, p_question_type, p_presentation, p_scoring,
      p_response, p_scored
    );
  end if;
  if not p_scored then return jsonb_build_object('earned',0,'maximum',0,'status','Informational'); end if;
  select evidence.* into v_evidence
  from exam_delivery.python_submission_grading_runs submission_run
  join exam_delivery.python_grading_evidence evidence on evidence.run_id = submission_run.run_id
  where submission_run.attempt_id = p_attempt_id
    and submission_run.submission_id = p_submission_id
    and submission_run.attempt_item_id = p_item_id;
  if not found then raise exception 'grading_incomplete' using errcode = '55000'; end if;
  return jsonb_build_object(
    'earned', v_evidence.earned_raw_points,
    'maximum', v_evidence.maximum_raw_points,
    'status', case
      when v_evidence.earned_raw_points = v_evidence.maximum_raw_points then 'Correct'
      when v_evidence.earned_raw_points > 0 then 'Partial'
      else 'Incorrect'
    end
  );
end
$$;

create function exam_delivery.submit_attempt_v2_with_trusted_grading(
  p_actor_id uuid,
  p_attempt_id uuid,
  p_submission_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
declare
  v_attempt record; v_existing exam_delivery.attempt_results%rowtype; v_now timestamptz:=statement_timestamp();
  v_response_hash text; v_raw numeric; v_max numeric; v_percentage numeric; v_scaled integer; v_pass_mark integer; v_passed boolean;
  v_domain jsonb; v_summary jsonb; v_review jsonb; v_catalog_id uuid;
begin
  if p_actor_id is null or p_submission_id is null then return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  select a.*,pv.exam_key,pv.package_version,pv.package_schema_version,pp.profile_key,pp.time_limit_minutes,pp.selection_config
    into v_attempt from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
    where a.id=p_attempt_id and a.owner_id=p_actor_id for update of a;
  if not found then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  select * into v_existing from exam_delivery.attempt_results where attempt_id=p_attempt_id;
  if found then if v_existing.submission_id=p_submission_id then return exam_delivery.get_result(p_actor_id,p_attempt_id); end if; return jsonb_build_object('ok',false,'code','submission_conflict'); end if;
  if v_attempt.status<>'in_progress' then return jsonb_build_object('ok',false,'code','invalid_lifecycle_transition'); end if;
  if not coalesce((exam_delivery.check_eligibility_v2(p_actor_id,v_attempt.exam_key,v_attempt.profile_key)->>'eligible')::boolean,false) then return jsonb_build_object('ok',false,'code','exam_unavailable'); end if;
  if not exists (
    select 1 from exam_delivery.python_submission_grading_sessions session
    where session.attempt_id=p_attempt_id and session.submission_id=p_submission_id
  ) or exists (
    select 1 from exam_delivery.attempt_items item
    join exam_delivery.package_questions question on question.id=item.package_question_id
    where item.attempt_id=p_attempt_id and question.question_type='executable-python-lab-v1'
      and not exists (
        select 1 from exam_delivery.python_submission_grading_runs submission_run
        join exam_delivery.python_grading_evidence evidence on evidence.run_id=submission_run.run_id
        where submission_run.attempt_id=p_attempt_id
          and submission_run.submission_id=p_submission_id
          and submission_run.attempt_item_id=item.id
      )
  ) then return jsonb_build_object('ok',false,'code','grading_incomplete'); end if;

  select encode(extensions.digest(convert_to(coalesce(jsonb_agg(jsonb_build_object(
    'itemId',i.id,'response',r.response_payload,
    'workspaceRevision',case when q.question_type='executable-python-lab-v1' then w.current_revision end,
    'workspaceHash',case when q.question_type='executable-python-lab-v1' then w.workspace_hash end
  ) order by i.id)::text,'[]'),'UTF8'),'sha256'),'hex') into v_response_hash
    from exam_delivery.attempt_items i
    join exam_delivery.package_questions q on q.id=i.package_question_id
    left join exam_delivery.attempt_responses r on r.attempt_id=i.attempt_id and r.attempt_item_id=i.id
    left join exam_delivery.python_lab_workspaces w on w.attempt_id=i.attempt_id and w.attempt_item_id=i.id
    where i.attempt_id=p_attempt_id;
  with scored as (
    select q.domain_key,coalesce(r.response_payload,'{}'::jsonb) response,
      exam_delivery.score_attempt_item_with_trusted_grading(
        p_attempt_id,p_submission_id,i.id,v_attempt.scorer_version,q.question_type,
        i.presentation_snapshot,pc.scoring_snapshot,coalesce(r.response_payload,'{}'::jsonb),
        coalesce((meta.authoring_metadata->>'scored')::boolean,true)
      ) score
    from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id
    join exam_delivery.package_question_protected_content meta on meta.question_id=q.id
    join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id
    left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id where i.attempt_id=p_attempt_id
  ) select coalesce(sum((score->>'earned')::numeric),0),coalesce(sum((score->>'maximum')::numeric),0) into v_raw,v_max from scored;
  if v_max<=0 then raise exception 'scoring_contract_invalid' using errcode='22023'; end if;
  with scored as (
    select q.domain_key,exam_delivery.score_attempt_item_with_trusted_grading(
      p_attempt_id,p_submission_id,i.id,v_attempt.scorer_version,q.question_type,
      i.presentation_snapshot,pc.scoring_snapshot,coalesce(r.response_payload,'{}'::jsonb),
      coalesce((meta.authoring_metadata->>'scored')::boolean,true)
    ) score
    from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id where i.attempt_id=p_attempt_id
  ), domains as (
    select domain_key,jsonb_build_object('domain',domain_key,'correct',count(*) filter(where score->>'status'='Correct'),'total',count(*) filter(where (score->>'maximum')::numeric>0),'earnedPoints',sum((score->>'earned')::numeric),'maxPoints',sum((score->>'maximum')::numeric),'percentage',case when sum((score->>'maximum')::numeric)>0 then round(100*sum((score->>'earned')::numeric)/sum((score->>'maximum')::numeric),2) else 0 end) value from scored group by domain_key
  ) select coalesce(jsonb_object_agg(domain_key,value),'{}'::jsonb) into v_domain from domains;
  select jsonb_build_object(
    'questionCount',count(*) filter(where coalesce((meta.authoring_metadata->>'scored')::boolean,true)),
    'presentedCount',count(*),
    'answeredCount',count(*) filter(where r.id is not null or (q.question_type='executable-python-lab-v1' and w.attempt_item_id is not null))
  ) into v_summary
    from exam_delivery.attempt_items i
    join exam_delivery.package_questions q on q.id=i.package_question_id
    join exam_delivery.package_question_protected_content meta on meta.question_id=i.package_question_id
    left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id
    left join exam_delivery.python_lab_workspaces w on w.attempt_item_id=i.id
    where i.attempt_id=p_attempt_id;
  select jsonb_build_object('items',jsonb_agg(
    jsonb_build_object(
      'itemId',i.id,'questionNumber',i.presented_question_number,'questionId',q.question_id,
      'questionType',q.question_type,'domain',q.domain_key,'section',q.section_key,
      'presentation',i.presentation_snapshot,'response',coalesce(r.response_payload,'{}'::jsonb),
      'status',score.value->>'status','earnedPoints',(score.value->>'earned')::numeric,
      'maxPoints',(score.value->>'maximum')::numeric
    ) || case when q.question_type='executable-python-lab-v1' then '{}'::jsonb else jsonb_build_object(
      'correctAnswer',pc.scoring_snapshot,'explanation',pc.review_snapshot->>'explanation',
      'remediation',pc.review_snapshot->>'remediation'
    ) end order by i.presented_question_number
  )) into v_review
    from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id cross join lateral (select exam_delivery.score_attempt_item_with_trusted_grading(p_attempt_id,p_submission_id,i.id,v_attempt.scorer_version,q.question_type,i.presentation_snapshot,pc.scoring_snapshot,coalesce(r.response_payload,'{}'::jsonb),coalesce((meta.authoring_metadata->>'scored')::boolean,true)) value) score where i.attempt_id=p_attempt_id;
  v_percentage:=round(100*v_raw/v_max,4); v_pass_mark:=coalesce((v_attempt.selection_config#>>'{scoringContract,scoreScale,pass}')::integer,700); v_scaled:=round(v_percentage*10); v_passed:=v_scaled>=v_pass_mark;
  v_summary:=v_summary||jsonb_build_object('rawScore',v_raw,'maxScore',v_max,'rawPercentage',v_percentage,'scaledScore',v_scaled,'passed',v_passed,'passMark',v_pass_mark);
  insert into exam_delivery.attempt_results(attempt_id,submission_id,response_hash,scorer_version,raw_score,max_score,raw_percentage,passed,domain_summary,result_summary,server_authoritative,submitted_at,completed_at,created_at) values(p_attempt_id,p_submission_id,v_response_hash,v_attempt.scorer_version,v_raw,v_max,v_percentage,v_passed,v_domain,v_summary,true,v_now,v_now,v_now);
  insert into exam_delivery.review_snapshots(attempt_id,release_status,review_payload,review_hash,created_at) values(p_attempt_id,'withheld',v_review,encode(extensions.digest(convert_to(v_review::text,'UTF8'),'sha256'),'hex'),v_now);
  update exam_delivery.attempts set status='completed',submitted_at=v_now,completed_at=v_now where id=p_attempt_id;
  select id into v_catalog_id from public.exam_catalog where exam_delivery.normalize_exam_key(exam_key)=exam_delivery.normalize_exam_key(v_attempt.exam_key) and status='active' limit 1;
  insert into public.exam_attempts(id,user_id,exam_catalog_id,exam_key,exam_version,profile_id,mode_label,status,started_at,submitted_at,duration_seconds,time_limit_minutes,selected_question_ids,presented_order_snapshot,attempt_snapshot,client_app_version,created_at,updated_at)
  select p_attempt_id,p_actor_id,v_catalog_id,v_attempt.exam_key,v_attempt.package_version,v_attempt.profile_key,'Protected Exam','submitted',v_attempt.started_at,v_now,greatest(0,extract(epoch from v_now-v_attempt.started_at)::integer),v_attempt.time_limit_minutes,jsonb_agg(q.question_id order by i.presented_question_number),jsonb_build_object('questionIds',jsonb_agg(q.question_id order by i.presented_question_number),'itemTypes',jsonb_agg(jsonb_build_object('id',q.question_id,'type',q.question_type,'domain',q.domain_key,'isScored',coalesce((meta.authoring_metadata->>'scored')::boolean,true)) order by i.presented_question_number)),jsonb_build_object('attemptId',p_attempt_id,'sourceFlow','protected-exam-delivery','serverAuthoritative',true),'protected-server-v2',v_attempt.created_at,v_now from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id where i.attempt_id=p_attempt_id;
  insert into public.exam_responses(attempt_id,question_id,question_type,response_snapshot,presented_snapshot,is_answered,is_scored,created_at)
  select p_attempt_id,q.question_id,q.question_type,coalesce(r.response_payload,'{}'::jsonb),i.presentation_snapshot,(r.id is not null or (q.question_type='executable-python-lab-v1' and w.attempt_item_id is not null)),coalesce((meta.authoring_metadata->>'scored')::boolean,true),v_now
  from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id join exam_delivery.package_question_protected_content meta on meta.question_id=q.id left join exam_delivery.attempt_responses r on r.attempt_item_id=i.id left join exam_delivery.python_lab_workspaces w on w.attempt_item_id=i.id where i.attempt_id=p_attempt_id;
  insert into public.exam_results(attempt_id,user_id,exam_key,profile_id,scoring_engine_version,raw_score,raw_percentage,scaled_score,passed,pass_mark,domain_breakdown,pbq_breakdown,case_study_breakdown,weak_areas,result_snapshot,created_at) values(p_attempt_id,p_actor_id,v_attempt.exam_key,v_attempt.profile_key,v_attempt.scorer_version,v_raw,v_percentage,v_scaled,v_passed,v_pass_mark,v_domain,'{}','{}','[]',v_summary,v_now);
  insert into public.exam_reports(attempt_id,user_id,report_type,report_title,report_snapshot,pdf_generated,created_at) values(p_attempt_id,p_actor_id,'study_report_snapshot','Protected Exam Study Report',jsonb_build_object('result',v_summary,'domainBreakdown',v_domain,'reviewStatus','withheld','serverAuthoritative',true),false,v_now);
  return exam_delivery.get_result(p_actor_id,p_attempt_id);
end
$$;

create or replace function exam_delivery.submit_attempt_v2(p_actor_id uuid,p_attempt_id uuid,p_submission_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare v_authorization jsonb; v_result jsonb; v_existing uuid; v_release boolean:=false; v_trusted boolean:=false;
begin
  select r.submission_id into v_existing from exam_delivery.attempt_results r join exam_delivery.attempts a on a.id=r.attempt_id
    where r.attempt_id=p_attempt_id and a.owner_id=p_actor_id;
  if found then
    if v_existing=p_submission_id then return exam_delivery.get_result(p_actor_id,p_attempt_id); end if;
    return jsonb_build_object('ok',false,'code','submission_conflict'); end if;
  select exists(
    select 1 from exam_delivery.python_submission_grading_sessions session
    join exam_delivery.attempts attempt on attempt.id=session.attempt_id
    where session.attempt_id=p_attempt_id and session.submission_id=p_submission_id
      and attempt.owner_id=p_actor_id
  ) into v_trusted;
  if v_trusted then
    if exists (
      select 1 from exam_delivery.attempt_items item
      join exam_delivery.package_questions question on question.id=item.package_question_id
      where item.attempt_id=p_attempt_id and question.question_type='executable-python-lab-v1'
        and not exists (
          select 1 from exam_delivery.python_submission_grading_runs submission_run
          join exam_delivery.python_grading_evidence evidence on evidence.run_id=submission_run.run_id
          where submission_run.attempt_id=p_attempt_id
            and submission_run.submission_id=p_submission_id
            and submission_run.attempt_item_id=item.id
        )
    ) then return jsonb_build_object('ok',false,'code','grading_incomplete'); end if;
  else
    v_authorization:=exam_delivery.authorize_attempt_continuation(p_attempt_id,'submit');
    if not coalesce((v_authorization->>'ok')::boolean,false) then return v_authorization; end if;
    if (v_authorization->>'ownerId')::uuid<>p_actor_id then return jsonb_build_object('ok',false,'code','attempt_not_found'); end if;
  end if;
  perform set_config('certsim.attempt_continuation_id',p_attempt_id::text,true);
  perform set_config('certsim.attempt_continuation_operation','submit',true);
  v_result:=case when v_trusted
    then exam_delivery.submit_attempt_v2_with_trusted_grading(p_actor_id,p_attempt_id,p_submission_id)
    else exam_delivery.submit_attempt_v2_with_assessment_gate(p_actor_id,p_attempt_id,p_submission_id)
  end;
  perform set_config('certsim.attempt_continuation_id','',true);
  perform set_config('certsim.attempt_continuation_operation','',true);
  if coalesce((v_result->>'ok')::boolean,false) then
    select case when a.source_assignment_id is not null then
      a.assignment_review_release_policy='after_submission'
      else p.review_release_policy<>'never' and p.answer_release_policy<>'never' end into v_release
    from exam_delivery.attempts a join exam_delivery.package_versions pv on pv.id=a.package_version_id
    join exam_delivery.package_profiles pp on pp.id=a.package_profile_id
    left join exam_delivery.practice_policies p on p.canonical_exam_key=exam_delivery.normalize_exam_key(pv.exam_key)
      and p.package_version=pv.package_version and p.profile_key=pp.profile_key and p.purpose=a.purpose
    where a.id=p_attempt_id;
    if coalesce(v_release,false) then
      update exam_delivery.review_snapshots set release_status='released',released_at=statement_timestamp()
        where attempt_id=p_attempt_id and release_status='withheld';
      update public.exam_reports set report_snapshot=jsonb_set(report_snapshot,'{reviewStatus}','"released"'::jsonb,true)
        where attempt_id=p_attempt_id and report_type='study_report_snapshot';
    end if;
    return exam_delivery.get_result(p_actor_id,p_attempt_id);
  end if;
  return v_result;
end
$$;

create function public.certsim_service_prepare_python_submission_grading(
  p_actor_id uuid, p_attempt_id uuid, p_submission_id uuid
)
returns jsonb language sql security invoker set search_path='' as $$
  select exam_delivery.prepare_python_submission_grading(p_actor_id,p_attempt_id,p_submission_id)
$$;

create function public.certsim_service_materialize_python_submission_grading(
  p_actor_id uuid, p_attempt_id uuid, p_submission_id uuid, p_item_id uuid,
  p_run_id uuid, p_execution_request_digest text
)
returns jsonb language sql security invoker set search_path='' as $$
  select exam_delivery.materialize_python_submission_grading(
    p_actor_id,p_attempt_id,p_submission_id,p_item_id,p_run_id,p_execution_request_digest
  )
$$;

create function public.certsim_service_persist_verified_python_grading_evidence(
  p_evidence_id uuid, p_run_id uuid, p_materialization_id uuid,
  p_grading_session_id uuid, p_execution_request_digest text,
  p_execution_result_digest text, p_material_digest text,
  p_grading_contract_version text, p_earned_raw_points integer,
  p_maximum_raw_points integer, p_rule_points jsonb
)
returns jsonb language sql security invoker set search_path='' as $$
  select exam_delivery.persist_verified_python_grading_evidence(
    p_evidence_id,p_run_id,p_materialization_id,p_grading_session_id,
    p_execution_request_digest,p_execution_result_digest,p_material_digest,
    p_grading_contract_version,p_earned_raw_points,p_maximum_raw_points,p_rule_points
  )
$$;

create or replace function exam_delivery.package_v2_runtime_supported(
  p_generator text,
  p_scorer text,
  p_pbq_runtime text default null
)
returns boolean
language sql
immutable
parallel unsafe
security invoker
set search_path = ''
as $$
  select (
    (p_generator,p_scorer) in (
      ('certsim-ai901-weighted-generator-v2','certsim-ai901-exact-scorer-v2'),
      ('certsim-az204-grouped-generator-v1','certsim-az204-exact-scorer-v1'),
      ('certsim-security-plus-pbq-first-generator-v1','certsim-security-plus-authoritative-pbq-scorer-v1'),
      ('certsim-az400-case-workspace-generator-v1','certsim-az400-authoritative-scorer-v1'),
      ('certsim-sc200-canonical-forms-v1','certsim-selected-response-partial-v1')
    )
    and (p_pbq_runtime is null or p_pbq_runtime = 'certsim-protected-pbq-runtime-v1')
  ) or (
    p_generator = 'certsim-python-standard-canonical-forms-v1'
    and p_scorer = 'certsim-versioned-structured-partial-v1'
    and p_pbq_runtime is null
  ) or (
    p_generator = 'certsim-python-next-generation-canonical-forms-v1'
    and p_scorer = 'certsim-python-trusted-grading-v1'
    and p_pbq_runtime is null
  )
$$;

create or replace function exam_delivery.publish_package_v2(p_request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '15s'
as $$
declare
  v_actor uuid := auth.uid();
  v_payload jsonb := p_request->'packagePayload';
  v_request_id uuid;
  v_exam_key text;
  v_version text;
  v_source_commit text := p_request->>'sourceCommitSha';
  v_source_hash text;
  v_validation_hash text;
  v_package_hash text := p_request->>'packageHash';
  v_actual_hash text;
  v_generator text;
  v_scorer text;
  v_pbq_runtime text;
  v_package_id uuid;
  v_existing record;
  v_profile_count integer;
  v_question_count integer;
begin
  if v_actor is null then
    raise exception 'publication_auth_required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.user_id = v_actor and m.role = 'platform_owner' and m.status = 'active'
  ) then
    raise exception 'publication_forbidden' using errcode = '42501';
  end if;
  if pg_catalog.pg_column_size(p_request) > 16777216
     or jsonb_typeof(p_request) <> 'object'
     or not exam_delivery.json_has_exact_keys(
       p_request,array['publicationRequestId','sourceCommitSha','packagePayload','packageHash']
     ) then
    raise exception 'publication_invalid_request' using errcode = '22023';
  end if;
  begin
    v_request_id := (p_request->>'publicationRequestId')::uuid;
  exception when others then
    raise exception 'publication_invalid_request' using errcode = '22023';
  end;
  if jsonb_typeof(v_payload) <> 'object'
     or v_payload->>'packageSchemaVersion' <> 'certsim-protected-package-v2'
     or v_payload->>'validationContractVersion' <> 'certsim-protected-multi-exam-validation-v1'
     or jsonb_typeof(v_payload->'exam') <> 'object'
     or jsonb_typeof(v_payload->'source') <> 'object'
     or jsonb_typeof(v_payload->'runtime') <> 'object'
     or jsonb_typeof(v_payload->'profiles') <> 'array'
     or jsonb_array_length(v_payload->'profiles') < 1
     or jsonb_typeof(v_payload->'questions') <> 'array'
     or jsonb_array_length(v_payload->'questions') < 1
     or jsonb_array_length(v_payload->'questions') > 5000 then
    raise exception 'publication_contract_unsupported' using errcode = '22023';
  end if;
  if jsonb_typeof(v_payload#>'{exam,capabilities}') <> 'array'
     or jsonb_array_length(v_payload#>'{exam,capabilities}') < 1
     or exists(
       select 1 from jsonb_array_elements_text(v_payload#>'{exam,capabilities}') capability
       where capability not in (
         'single-choice','multi-select','reorder','drag-drop-match','dropdown-code','dropdown-command',
         'true-false-single-v1','true-false-composite-v1','matching-v1','code-dropdown-completion-v1',
         'case-study-context','informational','pbq-terminal','pbq-multi-host-terminal','pbq-firewall',
         'pbq-siem','pbq-network-diagram','pbq-config-panel','pbq-hotspot','pbq-drag-drop-match',
         'pbq-ordering','pbq-workspace','executable-python-lab-v1'
       )
     ) or (
       select count(*)<>count(distinct capability)
       from jsonb_array_elements_text(v_payload#>'{exam,capabilities}') capability
     ) or exists(
       select 1 from jsonb_array_elements(v_payload->'profiles') p
       where jsonb_typeof(p)<>'object' or nullif(p->>'profileKey','') is null
         or (p->>'questionCount')::integer<1 or (p->>'timeLimitMinutes')::integer<1
         or jsonb_typeof(p->'selection')<>'object'
     ) or (
       select count(*)<>count(distinct p->>'profileKey') from jsonb_array_elements(v_payload->'profiles') p
     ) then
    raise exception 'publication_contract_unsupported' using errcode = '22023';
  end if;

  v_exam_key := exam_delivery.normalize_exam_key(v_payload#>>'{exam,examKey}');
  v_version := v_payload#>>'{exam,packageVersion}';
  v_source_hash := v_payload#>>'{source,sourceHash}';
  v_validation_hash := v_payload#>>'{source,validationHash}';
  v_generator := v_payload#>>'{runtime,generatorVersion}';
  v_scorer := v_payload#>>'{runtime,scorerVersion}';
  v_pbq_runtime := v_payload#>>'{runtime,pbqRuntimeVersion}';
  v_actual_hash := exam_delivery.canonical_sha256(v_payload);

  if v_exam_key is null or v_exam_key !~ '^[a-z0-9]+$'
     or v_version is null or v_version !~ '^[a-z0-9][a-z0-9._-]*$'
     or v_source_commit !~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
     or v_source_hash !~ '^[0-9a-f]{64}$'
     or v_validation_hash !~ '^[0-9a-f]{64}$'
     or v_package_hash !~ '^[0-9a-f]{64}$'
     or v_actual_hash <> v_package_hash
     or not exam_delivery.package_v2_runtime_supported(v_generator,v_scorer,v_pbq_runtime)
     or jsonb_typeof(v_payload->'releasePolicy') <> 'object'
     or not exam_delivery.json_has_exact_keys(v_payload->'releasePolicy',array['review','answers'])
     or (
       v_payload#>>'{releasePolicy,review}',
       v_payload#>>'{releasePolicy,answers}'
     ) not in (
       ('never','never'),
       ('after_submission','after_submission')
     ) then
    raise exception 'publication_contract_unsupported' using errcode = '22023';
  end if;

  if exists (
    select 1 from jsonb_array_elements(v_payload->'questions') q
    where jsonb_typeof(q) <> 'object'
       or nullif(q->>'id','') is null
       or nullif(q->>'type','') is null
       or nullif(q->>'domainKey','') is null
       or not (v_payload#>'{exam,capabilities}' @> jsonb_build_array(q->>'type'))
       or jsonb_typeof(q->'presentation') <> 'object'
       or jsonb_typeof(coalesce(q->'privateReview','{}'::jsonb)) <> 'object'
       or (coalesce((q->>'scored')::boolean,true) and jsonb_typeof(q->'privateScoring') <> 'object')
       or not exam_delivery.presentation_is_safe(q->'presentation')
       or (q->>'type' = 'executable-python-lab-v1' and (
         q#>>'{presentation,interactionVersion}' <> 'executable-python-lab-v1'
         or q#>>'{presentation,language}' <> 'python'
         or jsonb_typeof(q->'privateScoring') <> 'object'
         or not exam_delivery.json_has_exact_keys(q->'privateScoring',array['maximumRawPoints','trustedGrading'])
         or jsonb_typeof(q#>'{privateScoring,maximumRawPoints}') <> 'number'
         or q#>>'{privateScoring,maximumRawPoints}' !~ '^[1-9][0-9]*$'
         or jsonb_typeof(q#>'{privateScoring,trustedGrading}') <> 'object'
         or not exam_delivery.json_has_exact_keys(
           q#>'{privateScoring,trustedGrading}',array['status','materialDigest','gradingMaterial']
         )
         or q#>>'{privateScoring,trustedGrading,status}' <> 'compiled'
         or q#>>'{privateScoring,trustedGrading,materialDigest}' !~ '^[0-9a-f]{64}$'
         or jsonb_typeof(q#>'{privateScoring,trustedGrading,gradingMaterial}') <> 'object'
         or not exam_delivery.json_has_exact_keys(
           q#>'{privateScoring,trustedGrading,gradingMaterial}',
           array['contractVersion','taskId','maximumRawPoints','rules']
         )
         or q#>>'{privateScoring,trustedGrading,gradingMaterial,contractVersion}'
           <> 'certsim-python-trusted-grading-v1'
         or q#>>'{privateScoring,trustedGrading,gradingMaterial,taskId}' <> q->>'id'
         or q#>>'{privateScoring,trustedGrading,gradingMaterial,maximumRawPoints}'
           <> q#>>'{privateScoring,maximumRawPoints}'
         or jsonb_typeof(q#>'{privateScoring,trustedGrading,gradingMaterial,rules}') <> 'array'
         or jsonb_array_length(q#>'{privateScoring,trustedGrading,gradingMaterial,rules}') not between 1 and 128
       ))
       or (q->>'type' <> 'executable-python-lab-v1' and q#>'{privateScoring,trustedGrading}' is not null)
  ) or (
    select count(*) <> count(distinct q->>'id')
    from jsonb_array_elements(v_payload->'questions') q
  ) or exists(
    select 1 from jsonb_array_elements(v_payload->'questions') q
    where q->>'type' in ('case-study-context','informational')
      and coalesce((q->>'scored')::boolean,true)
  ) or exists(
    select 1 from jsonb_array_elements(v_payload->'questions') child
    where child#>>'{group,role}'='question' and not exists(
      select 1 from jsonb_array_elements(v_payload->'questions') context
      where context#>>'{group,groupKey}'=child#>>'{group,groupKey}'
        and context#>>'{group,role}'='context' and coalesce((context->>'scored')::boolean,true)=false
    )
  ) or exists(
    select 1 from (
      select q#>>'{group,groupKey}' group_key,(q#>>'{group,order}')::integer group_order,count(*) count
      from jsonb_array_elements(v_payload->'questions') q
      where nullif(q#>>'{group,groupKey}','') is not null
      group by 1,2 having count(*)>1
    ) duplicates
  ) then
    raise exception 'publication_question_invalid' using errcode = '22023';
  end if;

  select * into v_existing from exam_delivery.publication_runs
  where publication_request_id = v_request_id;
  if found then
    if v_existing.expected_package_hash = v_package_hash
       and v_existing.expected_validation_hash = v_validation_hash
       and v_existing.source_commit_sha = v_source_commit
       and v_existing.status = 'succeeded' then
      return jsonb_build_object(
        'ok',true,'classification','idempotent_replay','replayed',true,
        'examKey',v_exam_key,'packageVersion',v_version,
        'profileCount',jsonb_array_length(v_payload->'profiles'),
        'questionCount',jsonb_array_length(v_payload->'questions'),
        'packageHash',v_package_hash,'validationHash',v_validation_hash
      );
    end if;
    raise exception 'publication_request_conflict' using errcode = '23505';
  end if;

  select * into v_existing from exam_delivery.package_versions
  where exam_key = v_exam_key and package_version = v_version;
  if found then
    if v_existing.package_hash = v_package_hash
       and v_existing.validation_hash = v_validation_hash
       and v_existing.source_commit_sha = v_source_commit
       and v_existing.package_schema_version = 'certsim-protected-package-v2' then
      return jsonb_build_object(
        'ok',true,'classification','exact_match','replayed',true,
        'examKey',v_exam_key,'packageVersion',v_version,
        'profileCount',(select count(*) from exam_delivery.package_profiles where package_version_id=v_existing.id),
        'questionCount',(select count(*) from exam_delivery.package_questions where package_version_id=v_existing.id),
        'packageHash',v_package_hash,'validationHash',v_validation_hash
      );
    end if;
    raise exception 'publication_identity_conflict' using errcode = '23505';
  end if;
  if exists (select 1 from exam_delivery.package_versions where package_hash=v_package_hash) then
    raise exception 'publication_hash_conflict' using errcode = '23505';
  end if;

  insert into exam_delivery.package_versions(
    exam_key,package_version,source_commit_sha,validation_hash,package_hash,
    package_schema_version,generator_version,scorer_version,status
  ) values (
    v_exam_key,v_version,v_source_commit,v_validation_hash,v_package_hash,
    'certsim-protected-package-v2',v_generator,v_scorer,'draft'
  ) returning id into v_package_id;

  insert into exam_delivery.package_profiles(
    package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config
  )
  select v_package_id,p->>'profileKey',coalesce(nullif(p->>'displayName',''),p->>'profileKey'),
         (p->>'questionCount')::integer,(p->>'timeLimitMinutes')::integer,p->'selection'
  from jsonb_array_elements(v_payload->'profiles') p;
  get diagnostics v_profile_count = row_count;

  with source as (
    select q,ordinality::integer ordinal
    from jsonb_array_elements(v_payload->'questions') with ordinality as value(q,ordinality)
  ), inserted as (
    insert into exam_delivery.package_questions(
      package_version_id,question_id,question_type,domain_key,section_key,
      source_ordinal,presentation_payload,content_hash
    )
    select v_package_id,q->>'id',q->>'type',q->>'domainKey',nullif(q->>'sectionKey',''),
           ordinal,q->'presentation',exam_delivery.canonical_sha256(jsonb_build_object(
             'presentation',q->'presentation','scoring',coalesce(q->'privateScoring','{}'::jsonb),
             'review',coalesce(q->'privateReview','{}'::jsonb),'group',coalesce(q->'group','{}'::jsonb),
             'scored',coalesce((q->>'scored')::boolean,true)
           ))
    from source
    returning id,question_id
  )
  insert into exam_delivery.package_question_protected_content(
    question_id,package_version_id,scoring_payload,review_payload,authoring_metadata
  )
  select i.id,v_package_id,coalesce(q->'privateScoring','{}'::jsonb),
         coalesce(q->'privateReview','{}'::jsonb),
         jsonb_build_object('scored',coalesce((q->>'scored')::boolean,true),'group',coalesce(q->'group','{}'::jsonb))
  from inserted i
  join jsonb_array_elements(v_payload->'questions') q on q->>'id'=i.question_id;
  get diagnostics v_question_count = row_count;

  if v_profile_count <> jsonb_array_length(v_payload->'profiles')
     or v_question_count <> jsonb_array_length(v_payload->'questions') then
    raise exception 'publication_atomicity_failure' using errcode = 'P0001';
  end if;

  update exam_delivery.package_versions
  set status='published',published_at=statement_timestamp()
  where id=v_package_id;
  insert into exam_delivery.publication_runs(
    publication_request_id,package_version_id,actor_user_id,source_commit_sha,
    expected_validation_hash,expected_package_hash,actual_package_hash,status,completed_at
  ) values (
    v_request_id,v_package_id,v_actor,v_source_commit,v_validation_hash,
    v_package_hash,v_actual_hash,'succeeded',statement_timestamp()
  );

  return jsonb_build_object(
    'ok',true,'classification','new_candidate','replayed',false,
    'examKey',v_exam_key,'packageVersion',v_version,'profileCount',v_profile_count,
    'questionCount',v_question_count,'packageHash',v_package_hash,'validationHash',v_validation_hash
  );
exception
  when unique_violation then
    raise exception 'publication_conflict' using errcode = '23505';
end
$$;

alter function exam_delivery.guard_python_submission_grading_immutable() owner to postgres;
alter function exam_delivery.save_python_workspace(uuid,uuid,uuid,jsonb,integer,uuid) owner to postgres;
alter function exam_delivery.prepare_python_submission_grading(uuid,uuid,uuid) owner to postgres;
alter function exam_delivery.materialize_python_submission_grading(uuid,uuid,uuid,uuid,uuid,text) owner to postgres;
alter function exam_delivery.persist_verified_python_grading_evidence(uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,jsonb) owner to postgres;
alter function exam_delivery.score_attempt_item_with_trusted_grading(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,boolean) owner to postgres;
alter function exam_delivery.submit_attempt_v2_with_trusted_grading(uuid,uuid,uuid) owner to postgres;
alter function exam_delivery.submit_attempt_v2(uuid,uuid,uuid) owner to postgres;
alter function exam_delivery.package_v2_runtime_supported(text,text,text) owner to postgres;
alter function exam_delivery.publish_package_v2(jsonb) owner to postgres;
alter function public.certsim_service_prepare_python_submission_grading(uuid,uuid,uuid) owner to postgres;
alter function public.certsim_service_materialize_python_submission_grading(uuid,uuid,uuid,uuid,uuid,text) owner to postgres;
alter function public.certsim_service_persist_verified_python_grading_evidence(uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,jsonb) owner to postgres;

revoke all on table exam_delivery.python_submission_grading_sessions,
  exam_delivery.python_submission_grading_runs from public,anon,authenticated,service_role;
revoke all on function exam_delivery.guard_python_submission_grading_immutable(),
  exam_delivery.prepare_python_submission_grading(uuid,uuid,uuid),
  exam_delivery.materialize_python_submission_grading(uuid,uuid,uuid,uuid,uuid,text),
  exam_delivery.persist_verified_python_grading_evidence(uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,jsonb),
  exam_delivery.score_attempt_item_with_trusted_grading(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,boolean),
  exam_delivery.submit_attempt_v2_with_trusted_grading(uuid,uuid,uuid),
  public.certsim_service_prepare_python_submission_grading(uuid,uuid,uuid),
  public.certsim_service_materialize_python_submission_grading(uuid,uuid,uuid,uuid,uuid,text),
  public.certsim_service_persist_verified_python_grading_evidence(uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,jsonb)
from public,anon,authenticated,service_role;

grant execute on function exam_delivery.prepare_python_submission_grading(uuid,uuid,uuid),
  exam_delivery.materialize_python_submission_grading(uuid,uuid,uuid,uuid,uuid,text),
  exam_delivery.persist_verified_python_grading_evidence(uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,jsonb),
  public.certsim_service_prepare_python_submission_grading(uuid,uuid,uuid),
  public.certsim_service_materialize_python_submission_grading(uuid,uuid,uuid,uuid,uuid,text),
  public.certsim_service_persist_verified_python_grading_evidence(uuid,uuid,uuid,uuid,text,text,text,text,integer,integer,jsonb)
to service_role;

revoke execute on function exam_delivery.package_v2_runtime_supported(text,text,text)
from public,anon,authenticated,service_role;
grant execute on function exam_delivery.package_v2_runtime_supported(text,text,text) to postgres;
revoke execute on function exam_delivery.publish_package_v2(jsonb)
from public,anon,authenticated,service_role;
grant execute on function exam_delivery.publish_package_v2(jsonb) to authenticated;

comment on table exam_delivery.python_submission_grading_sessions is
  'Issue #86 immutable final-submission claim; freezes executable workspace revisions before trusted grading.';
comment on function exam_delivery.prepare_python_submission_grading(uuid,uuid,uuid) is
  'Service-only protected materialization authority; returns private grading material only to the trusted Edge path.';
comment on function exam_delivery.materialize_python_submission_grading(uuid,uuid,uuid,uuid,uuid,text) is
  'Claims one immutable submission grading run and binds its exact canonical R2 request digest.';

notify pgrst, 'reload schema';

commit;
