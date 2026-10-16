-- Issue #201: independent, future-only trusted Python expiry authority.
-- No deployment, activation, backfill, dispatch, scheduler or provider call.
begin;

create table exam_delivery.python_expiry_control (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false
);
insert into exam_delivery.python_expiry_control values(true,false);

-- Capture activation at INSERT, not at deferred-trigger execution. An attempt
-- inserted before activation cannot acquire authority by delaying its commit.
create table exam_delivery.python_expiry_creation_gates (
  attempt_id uuid primary key references exam_delivery.attempts(id),
  created_at timestamptz not null default clock_timestamp()
);
create table exam_delivery.python_expiry_capabilities (
  attempt_id uuid primary key references exam_delivery.expiry_authority(attempt_id),
  version integer not null default 1 check(version=1),
  created_at timestamptz not null default clock_timestamp()
);
create table exam_delivery.python_expiry_preparations (
  attempt_id uuid primary key references exam_delivery.python_expiry_capabilities(attempt_id),
  submission_id uuid not null unique,
  prepared_at timestamptz not null default clock_timestamp(),
  foreign key(attempt_id,submission_id) references
    exam_delivery.python_submission_grading_sessions(attempt_id,submission_id)
);
create table exam_delivery.python_expiry_inventory (
  attempt_id uuid not null references exam_delivery.python_expiry_preparations(attempt_id),
  attempt_item_id uuid primary key,
  package_question_id uuid not null references exam_delivery.package_questions(id),
  workspace_revision integer,
  workspace_hash text,
  material_digest text,
  grading_contract_version text,
  maximum_raw_points integer not null check(maximum_raw_points between 1 and 1000000),
  scoring_hash text not null check(scoring_hash ~ '^[0-9a-f]{64}$'),
  foreign key(attempt_id,attempt_item_id) references exam_delivery.attempt_items(attempt_id,id),
  foreign key(attempt_id,attempt_item_id,workspace_revision,workspace_hash) references
    exam_delivery.python_lab_workspace_revisions(attempt_id,attempt_item_id,revision,workspace_hash),
  check ((workspace_revision is null and workspace_hash is null)
    or (workspace_revision is not null and workspace_revision>0
      and workspace_hash is not null and workspace_hash ~ '^[0-9a-f]{64}$'
      and material_digest is not null and material_digest ~ '^[0-9a-f]{64}$'
      and grading_contract_version is not null))
);
create index python_expiry_inventory_attempt on exam_delivery.python_expiry_inventory(attempt_id,attempt_item_id);
create table exam_delivery.python_expiry_events (
  id bigint generated always as identity primary key,
  attempt_id uuid not null references exam_delivery.python_expiry_capabilities(attempt_id),
  event text not null check(event in ('prepared','materialized','completed')),
  occurred_at timestamptz not null default clock_timestamp()
);

create function exam_delivery.set_python_expiry_capability(p_enabled boolean) returns void
language sql security definer set search_path='' as $$
  update exam_delivery.python_expiry_control set enabled=p_enabled where singleton
$$;

create function exam_delivery.capture_python_expiry_creation() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if (select enabled from exam_delivery.python_expiry_control where singleton)
    and (select enabled from exam_delivery.expiry_activation where singleton) then
    insert into exam_delivery.python_expiry_creation_gates(attempt_id) values(new.id);
  end if;
  return new;
end $$;
create trigger capture_python_expiry_creation after insert on exam_delivery.attempts
for each row execute function exam_delivery.capture_python_expiry_creation();

create function exam_delivery.issue_python_expiry_capability() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  -- z_enrol_new_expiry_attempt has already frozen finalized form/cycle,
  -- continuation, owner, assignment, package/scorer and release authority.
  if exists(select 1 from exam_delivery.python_expiry_creation_gates where attempt_id=new.id)
    and exists(select 1 from exam_delivery.attempt_items i
      join exam_delivery.package_questions q on q.id=i.package_question_id
      where i.attempt_id=new.id and q.question_type='executable-python-lab-v1')
    and exists(select 1 from exam_delivery.expiry_authority where attempt_id=new.id) then
    insert into exam_delivery.python_expiry_capabilities(attempt_id) values(new.id);
  end if;
  return new;
end $$;
create constraint trigger zz_issue_python_expiry_capability after insert on exam_delivery.attempts
deferrable initially deferred for each row execute function exam_delivery.issue_python_expiry_capability();

-- Called only inside bounded fixed wrappers, after the attempt lock.
create function exam_delivery.check_python_expiry_lease(p_attempt_id uuid,p_token uuid) returns text
language plpgsql security definer set search_path='' as $$
declare a exam_delivery.attempts%rowtype; s exam_delivery.expiry_processing%rowtype;
begin
  if not exists(select 1 from exam_delivery.python_expiry_capabilities where attempt_id=p_attempt_id and version=1)
    then return 'python_expiry_capability_missing'; end if;
  if not exam_delivery.lock_expiry_attempt(p_attempt_id,null) then return 'not_enrolled'; end if;
  select * into strict a from exam_delivery.attempts where id=p_attempt_id;
  if not exists(select 1 from exam_delivery.expiry_authority c
    where c.attempt_id=a.id and c.identity=exam_delivery.expiry_identity(a)
      and c.continuation=(select to_jsonb(x) from exam_delivery.attempt_continuation_contracts x where x.attempt_id=a.id))
    then return 'python_expiry_authority_mismatch'; end if;
  if a.status not in ('in_progress','completed') then return 'invalid_lifecycle_transition'; end if;
  if a.expires_at>clock_timestamp() then return 'not_due'; end if;
  -- An already committed compatible result may be reconciled without new work.
  if exists(select 1 from exam_delivery.attempt_results r
    join exam_delivery.expiry_bindings b on b.attempt_id=r.attempt_id and b.submission_id=r.submission_id
    where r.attempt_id=a.id and r.server_authoritative and a.status='completed') then return 'completed'; end if;
  if exists(select 1 from exam_delivery.attempt_results where attempt_id=a.id)
    or a.status='completed' then return 'submission_conflict'; end if;
  select * into s from exam_delivery.expiry_processing where attempt_id=a.id for update;
  if not found or p_token is null or s.state<>'claimed' or s.lease_token is distinct from p_token
    or s.lease_until<=clock_timestamp() then return 'stale_lease'; end if;
  return null;
end $$;

-- Reuse the effective trusted preparation implementation, with exactly two
-- differences: private durable authority replaces learner authorization, and
-- existing generations are never replaced by preparation replay. The original
-- manual implementation and its grants remain untouched.
do $migration$
declare source text; old_auth text;
begin
  source:=pg_get_functiondef('exam_delivery.prepare_python_submission_before_expiry_foundation(uuid,uuid,uuid)'::regprocedure);
  old_auth:=$anchor$exam_delivery.authorize_attempt_continuation(p_attempt_id, 'submit')$anchor$;
  if position(old_auth in source)=0
    or position($anchor$if not found or v_latest.state in ('completed','failed','cancelled') then$anchor$ in source)=0 then
    raise exception 'python_expiry_preparation_source_mismatch';
  end if;
  source:=replace(source,'exam_delivery.prepare_python_submission_before_expiry_foundation(',
    'exam_delivery.prepare_python_expiry_core(');
  source:=replace(source,old_auth,'exam_delivery.authorize_python_expiry_core(p_attempt_id,p_actor_id,p_submission_id)');
  source:=replace(source,$anchor$if not found or v_latest.state in ('completed','failed','cancelled') then$anchor$,
    'if not found then');
  execute source;
end $migration$;

create function exam_delivery.authorize_python_expiry_core(p_attempt_id uuid,p_actor_id uuid,p_submission_id uuid)
returns jsonb language sql security definer set search_path='' as $$
  select case when exists(select 1 from exam_delivery.python_expiry_capabilities c
    join exam_delivery.expiry_authority a using(attempt_id)
    join exam_delivery.expiry_bindings b using(attempt_id)
    join exam_delivery.attempts t on t.id=a.attempt_id
    where c.attempt_id=p_attempt_id and a.owner_id=p_actor_id and b.submission_id=p_submission_id
      and t.status='in_progress' and a.deadline<=clock_timestamp()
      and a.identity=exam_delivery.expiry_identity(t))
    then jsonb_build_object('ok',true,'ownerId',p_actor_id)
    else jsonb_build_object('ok',false,'code','python_expiry_authority_mismatch') end
$$;

create function exam_delivery.python_expiry_progress(p_attempt_id uuid) returns jsonb
language sql security definer set search_path='' as $$
  select jsonb_build_object('ok',true,'submissionId',p.submission_id,
    'preparedAt',p.prepared_at,'effectiveAt',b.effective_at,'reason',b.reason,
    'ready',not exists(select 1 from exam_delivery.python_expiry_inventory i
      where i.attempt_id=p.attempt_id and i.workspace_revision is not null and not exists(
        select 1 from exam_delivery.python_submission_grading_runs r
        join exam_delivery.python_grading_evidence e on e.run_id=r.run_id
        where r.attempt_id=i.attempt_id and r.submission_id=p.submission_id
          and r.attempt_item_id=i.attempt_item_id)),
    'items',coalesce((select jsonb_agg(jsonb_build_object('itemId',i.attempt_item_id,
      'workspaceRevision',i.workspace_revision,'workspaceHash',i.workspace_hash,
      'maximumRawPoints',i.maximum_raw_points,'materialDigest',i.material_digest,
      'gradingContractVersion',i.grading_contract_version,
      'runId',r.run_id,'materializationId',r.materialization_id,'gradingSessionId',r.grading_session_id,
      'executionRequestId',x.execution_request_id,'state',case
        when i.workspace_revision is null then 'unanswered'
        when e.evidence_id is not null then 'graded' else x.state end,
      'disposalState',x.disposal_state,'generation',r.attempt_number) order by i.attempt_item_id)
      from exam_delivery.python_expiry_inventory i
      left join lateral(select sr.* from exam_delivery.python_submission_grading_runs sr
        left join exam_delivery.python_grading_evidence ev on ev.run_id=sr.run_id
        where sr.attempt_id=i.attempt_id and sr.attempt_item_id=i.attempt_item_id
          and sr.submission_id=p.submission_id
        order by (ev.evidence_id is not null) desc,sr.attempt_number desc limit 1) r on true
      left join exam_delivery.python_execution_runs x on x.id=r.run_id
      left join exam_delivery.python_grading_evidence e on e.run_id=r.run_id
      where i.attempt_id=p.attempt_id),'[]'::jsonb))
  from exam_delivery.python_expiry_preparations p
  join exam_delivery.expiry_bindings b using(attempt_id) where p.attempt_id=p_attempt_id
$$;

create function exam_delivery.prepare_python_expiry(p_attempt_id uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare code text; a exam_delivery.attempts%rowtype; session exam_delivery.python_submission_grading_sessions%rowtype;
  submission uuid; result jsonb;
begin
  code:=exam_delivery.check_python_expiry_lease(p_attempt_id,p_token);
  if code='completed' then
    perform exam_delivery.complete_expiry_record(p_attempt_id);
    return jsonb_build_object('ok',true,'completed',true);
  end if;
  if code is not null then return jsonb_build_object('ok',false,'code',code); end if;
  if exists(select 1 from exam_delivery.python_expiry_preparations where attempt_id=p_attempt_id) then
    return exam_delivery.python_expiry_progress(p_attempt_id);
  end if;
  select * into strict a from exam_delivery.attempts where id=p_attempt_id;
  select * into session from exam_delivery.python_submission_grading_sessions where attempt_id=p_attempt_id;
  if found then
    if session.created_at>=a.expires_at then return jsonb_build_object('ok',false,'code','submission_conflict'); end if;
    submission:=session.submission_id;
    perform exam_delivery.bind_expiry_submission(p_attempt_id,submission,'manual',session.created_at);
  else
    if exists(select 1 from exam_delivery.expiry_bindings where attempt_id=p_attempt_id) then
      return jsonb_build_object('ok',false,'code','submission_conflict');
    end if;
    submission:=gen_random_uuid();
    perform exam_delivery.bind_expiry_submission(p_attempt_id,submission,'time_limit_expiry',a.expires_at);
    insert into exam_delivery.python_submission_grading_sessions(attempt_id,submission_id,created_at)
      values(p_attempt_id,submission,clock_timestamp());
  end if;
  result:=exam_delivery.prepare_python_expiry_core(a.owner_id,p_attempt_id,submission);
  -- Exception rolls back the binding, session and any partial run creation.
  if not coalesce((result->>'ok')::boolean,false) then raise exception 'python_expiry_preparation_failed'; end if;
  insert into exam_delivery.python_expiry_preparations(attempt_id,submission_id) values(p_attempt_id,submission);
  insert into exam_delivery.python_expiry_inventory(attempt_id,attempt_item_id,package_question_id,
    workspace_revision,workspace_hash,material_digest,grading_contract_version,maximum_raw_points,scoring_hash)
  select i.attempt_id,i.id,i.package_question_id,w.current_revision,w.workspace_hash,
    pc.scoring_snapshot#>>'{trustedGrading,materialDigest}',
    pc.scoring_snapshot#>>'{trustedGrading,gradingMaterial,contractVersion}',
    (pc.scoring_snapshot->>'maximumRawPoints')::integer,
    encode(extensions.digest(convert_to(pc.scoring_snapshot::text,'UTF8'),'sha256'),'hex')
  from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id
  join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.id
  left join exam_delivery.python_lab_workspaces w on w.attempt_id=i.attempt_id and w.attempt_item_id=i.id
  where i.attempt_id=p_attempt_id and q.question_type='executable-python-lab-v1';
  insert into exam_delivery.python_expiry_events(attempt_id,event) values(p_attempt_id,'prepared');
  return exam_delivery.python_expiry_progress(p_attempt_id);
end $$;

-- Keep the current scorer/projections/redaction exactly. Only its current-profile
-- eligibility input becomes the frozen expiry authority/selection configuration.
-- No expiry point calculation or alternative result/history implementation.
do $migration$
declare source text; anchor text;
begin
  source:=pg_get_functiondef('exam_delivery.submit_attempt_v2_with_trusted_grading(uuid,uuid,uuid)'::regprocedure);
  anchor:=$anchor$exam_delivery.check_eligibility_v2(p_actor_id,v_attempt.exam_key,v_attempt.profile_key)->>'eligible'$anchor$;
  if position(anchor in source)=0 or position('pp.selection_config' in source)=0
    or position('v_now timestamptz:=statement_timestamp()' in source)=0 then
    raise exception 'python_expiry_scorer_source_mismatch';
  end if;
  source:=replace(source,'exam_delivery.submit_attempt_v2_with_trusted_grading(',
    'exam_delivery.score_python_expiry_core(');
  source:=replace(source,anchor,
    'exam_delivery.authorize_python_expiry_core(p_attempt_id,p_actor_id,p_submission_id)->>''ok''');
  source:=replace(source,'pp.selection_config',
    '(select c.selection_config from exam_delivery.expiry_authority c where c.attempt_id=a.id) selection_config');
  -- The outer operation already holds the attempt lock. A request that waited
  -- must not record its earlier statement-start as physical completion time.
  source:=replace(source,'v_now timestamptz:=statement_timestamp()',
    'v_now timestamptz:=clock_timestamp()');
  execute source;
end $migration$;

create function exam_delivery.complete_python_expiry(p_attempt_id uuid,p_token uuid) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='15s' as $$
declare code text; result jsonb; owner_id uuid; submission uuid;
begin
  code:=exam_delivery.check_python_expiry_lease(p_attempt_id,p_token);
  if code='completed' then
    perform exam_delivery.complete_expiry_record(p_attempt_id);
    return jsonb_build_object('ok',true,'completed',true);
  end if;
  if code is not null then return jsonb_build_object('ok',false,'code',code); end if;
  select p.submission_id,a.owner_id into submission,owner_id
    from exam_delivery.python_expiry_preparations p join exam_delivery.expiry_authority a using(attempt_id)
    where p.attempt_id=p_attempt_id;
  if not found then return jsonb_build_object('ok',false,'code','python_expiry_preparation_required'); end if;
  if exists(select 1 from exam_delivery.attempt_items i
    join exam_delivery.package_questions q on q.id=i.package_question_id
    where i.attempt_id=p_attempt_id and q.question_type='executable-python-lab-v1'
      and not exists(select 1 from exam_delivery.python_expiry_inventory f
        where f.attempt_id=i.attempt_id and f.attempt_item_id=i.id and f.package_question_id=i.package_question_id))
    or exists(select 1 from exam_delivery.python_submission_grading_runs r
      join exam_delivery.python_execution_runs x on x.id=r.run_id
      where r.attempt_id=p_attempt_id and r.submission_id=submission
        and (x.state not in ('completed','failed','cancelled') or x.disposal_state<>'confirmed')) then
    return jsonb_build_object('ok',false,'code','grading_incomplete','pending',true);
  end if;
  -- Every saved workspace must have exact verified evidence, confirmed disposal,
  -- and matching frozen task/material/capacity. Terminal alone is insufficient.
  if exists(select 1 from exam_delivery.python_expiry_inventory i
    join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.attempt_item_id
    left join exam_delivery.python_lab_workspaces w on w.attempt_item_id=i.attempt_item_id
    where i.attempt_id=p_attempt_id and (
      i.scoring_hash<>encode(extensions.digest(convert_to(pc.scoring_snapshot::text,'UTF8'),'sha256'),'hex')
      or i.workspace_revision is distinct from w.current_revision
      or i.workspace_hash is distinct from w.workspace_hash
      or (i.workspace_revision is not null and not exists(
        select 1 from exam_delivery.python_submission_grading_runs r
        join exam_delivery.python_execution_runs x on x.id=r.run_id
        join exam_delivery.python_grading_evidence e on e.run_id=r.run_id
        join exam_delivery.python_grading_materializations m on m.id=r.materialization_id and m.run_id=r.run_id
        where r.attempt_id=i.attempt_id and r.attempt_item_id=i.attempt_item_id and r.submission_id=submission
          and r.workspace_revision=i.workspace_revision and r.workspace_hash=i.workspace_hash
          and r.material_digest=i.material_digest and r.grading_contract_version=i.grading_contract_version
          and r.maximum_raw_points=i.maximum_raw_points and e.maximum_raw_points=i.maximum_raw_points
          and x.workspace_revision=i.workspace_revision and x.workspace_hash=i.workspace_hash
          and x.state in ('completed','failed','cancelled') and x.disposal_state='confirmed'
          and e.execution_request_digest=x.execution_request_digest
          and e.execution_result_digest=x.execution_result_digest
          and m.execution_request_digest=x.execution_request_digest
      )))) then return jsonb_build_object('ok',false,'code','grading_incomplete','pending',true); end if;
  result:=exam_delivery.score_python_expiry_core(owner_id,p_attempt_id,submission);
  if not coalesce((result->>'ok')::boolean,false) then raise exception 'python_expiry_scoring_failed'; end if;
  perform exam_delivery.complete_expiry_record(p_attempt_id);
  insert into exam_delivery.python_expiry_events(attempt_id,event) values(p_attempt_id,'completed');
  return jsonb_build_object('ok',true,'completed',true);
end $$;

-- Read authority is separate from execution-start authority. No digest/state,
-- lease, generation, evidence or result writes occur here. Inputs stay private.
create function exam_delivery.read_python_expiry_task(p_attempt_id uuid,p_token uuid,p_item_id uuid,p_run_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='8s' as $$
declare code text; result jsonb;
begin
  code:=exam_delivery.check_python_expiry_lease(p_attempt_id,p_token);
  if code is not null then return jsonb_build_object('ok',false,'code',code); end if;
  if not exists(select 1 from exam_delivery.python_expiry_preparations where attempt_id=p_attempt_id) then
    return jsonb_build_object('ok',false,'code','python_expiry_preparation_required');
  end if;
  select jsonb_build_object('ok',true,'submissionId',p.submission_id,'itemId',i.attempt_item_id,
    'runId',x.id,'materializationId',r.materialization_id,'gradingSessionId',r.grading_session_id,
    'executionRequestId',x.execution_request_id,'executionRequestDigest',x.execution_request_digest,
    'state',x.state,'workspaceRevision',i.workspace_revision,'workspaceHash',i.workspace_hash,
    'workspace',w.workspace,'gradingMaterial',pc.scoring_snapshot#>'{trustedGrading,gradingMaterial}',
    'materialDigest',i.material_digest,'gradingContractVersion',i.grading_contract_version,
    'maximumRawPoints',i.maximum_raw_points,'wallTimeMs',x.wall_time_ms,
    'memoryBytes',x.memory_bytes,'outputBytes',x.output_bytes) into result
  from exam_delivery.python_expiry_preparations p
  join exam_delivery.python_expiry_inventory i on i.attempt_id=p.attempt_id
  join exam_delivery.attempt_items ai on ai.attempt_id=i.attempt_id and ai.id=i.attempt_item_id
    and ai.package_question_id=i.package_question_id
  join exam_delivery.python_submission_grading_runs r on r.attempt_id=i.attempt_id
    and r.submission_id=p.submission_id and r.attempt_item_id=i.attempt_item_id
    and r.workspace_revision=i.workspace_revision and r.workspace_hash=i.workspace_hash
    and r.material_digest=i.material_digest and r.grading_contract_version=i.grading_contract_version
    and r.maximum_raw_points=i.maximum_raw_points
  join exam_delivery.python_execution_runs x on x.id=r.run_id and x.attempt_id=i.attempt_id
    and x.attempt_item_id=i.attempt_item_id and x.workspace_revision=i.workspace_revision and x.workspace_hash=i.workspace_hash
  join exam_delivery.python_lab_workspace_revisions w on w.attempt_id=i.attempt_id
    and w.attempt_item_id=i.attempt_item_id and w.revision=i.workspace_revision and w.workspace_hash=i.workspace_hash
  join exam_delivery.attempt_item_protected_content pc on pc.attempt_item_id=i.attempt_item_id
  where p.attempt_id=p_attempt_id and i.attempt_item_id=p_item_id and x.id=p_run_id
    and exam_delivery.python_workspace_valid(w.workspace)
    and exam_delivery.python_workspace_hash(w.workspace)=i.workspace_hash
    and i.scoring_hash=encode(extensions.digest(convert_to(pc.scoring_snapshot::text,'UTF8'),'sha256'),'hex')
    and pc.scoring_snapshot#>>'{trustedGrading,materialDigest}'=i.material_digest
    and pc.scoring_snapshot#>>'{trustedGrading,gradingMaterial,contractVersion}'=i.grading_contract_version
    and (pc.scoring_snapshot->>'maximumRawPoints')::integer=i.maximum_raw_points;
  if result is null then return jsonb_build_object('ok',false,'code','grading_binding_mismatch'); end if;
  return result;
end $$;

create function exam_delivery.materialize_python_expiry(p_attempt_id uuid,p_token uuid,p_item_id uuid,p_run_id uuid,p_execution_request_digest text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='8s' as $$
declare inputs jsonb; result jsonb; owner_id uuid; submission uuid;
begin
  inputs:=exam_delivery.read_python_expiry_task(p_attempt_id,p_token,p_item_id,p_run_id);
  if not coalesce((inputs->>'ok')::boolean,false) then return inputs; end if;
  select p.submission_id,a.owner_id into submission,owner_id from exam_delivery.python_expiry_preparations p
    join exam_delivery.expiry_authority a using(attempt_id) where p.attempt_id=p_attempt_id;
  if not found then return jsonb_build_object('ok',false,'code','python_expiry_preparation_required'); end if;
  if p_execution_request_digest is null or p_execution_request_digest !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('ok',false,'code','invalid_request'); end if;
  result:=exam_delivery.materialize_python_submission_grading(owner_id,p_attempt_id,submission,p_item_id,p_run_id,p_execution_request_digest);
  if coalesce((result->>'ok')::boolean,false) then
    result:=result||jsonb_build_object('workspace',inputs->'workspace','gradingMaterial',inputs->'gradingMaterial');
  end if;
  if coalesce((result->>'claimed')::boolean,false) then
    insert into exam_delivery.python_expiry_events(attempt_id,event) values(p_attempt_id,'materialized');
  end if;
  return result;
end $$;

create function public.certsim_service_claim_python_expiry(p_attempt_id uuid) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
begin
  if not exists(select 1 from exam_delivery.python_expiry_capabilities where attempt_id=p_attempt_id and version=1) then
    return jsonb_build_object('ok',false,'code','python_expiry_capability_missing');
  end if;
  return exam_delivery.claim_expiry(p_attempt_id);
end $$;
create function public.certsim_service_prepare_python_expiry(p_attempt_id uuid,p_token uuid) returns jsonb
language sql security definer set search_path='' as $$select exam_delivery.prepare_python_expiry(p_attempt_id,p_token)$$;
create function public.certsim_service_complete_python_expiry(p_attempt_id uuid,p_token uuid) returns jsonb
language sql security definer set search_path='' as $$select exam_delivery.complete_python_expiry(p_attempt_id,p_token)$$;
create function public.certsim_service_read_python_expiry_task(p_attempt_id uuid,p_token uuid,p_item_id uuid,p_run_id uuid)
returns jsonb language sql security definer set search_path='' as $$
select exam_delivery.read_python_expiry_task(p_attempt_id,p_token,p_item_id,p_run_id)$$;
create function public.certsim_service_materialize_python_expiry(p_attempt_id uuid,p_token uuid,p_item_id uuid,p_run_id uuid,p_execution_request_digest text)
returns jsonb language sql security definer set search_path='' as $$
select exam_delivery.materialize_python_expiry(p_attempt_id,p_token,p_item_id,p_run_id,p_execution_request_digest)$$;

do $security$
declare name text; f record;
begin
  foreach name in array array['python_expiry_creation_gates','python_expiry_capabilities',
    'python_expiry_preparations','python_expiry_inventory','python_expiry_events'] loop
    execute format('create trigger immutable before update or delete on exam_delivery.%I for each row execute function exam_delivery.examops_guard_append_only()',name);
  end loop;
  foreach name in array array['python_expiry_control','python_expiry_creation_gates','python_expiry_capabilities',
    'python_expiry_preparations','python_expiry_inventory','python_expiry_events'] loop
    execute format('alter table exam_delivery.%I enable row level security',name);
    execute format('revoke all on exam_delivery.%I from public,anon,authenticated,service_role',name);
  end loop;
  for f in select oid::regprocedure signature from pg_proc
    where pronamespace in ('exam_delivery'::regnamespace,'public'::regnamespace)
      and proname like '%python_expiry%' loop
    execute format('alter function %s owner to postgres',f.signature);
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f.signature);
  end loop;
end $security$;
revoke all on sequence exam_delivery.python_expiry_events_id_seq from public,anon,authenticated,service_role;
grant execute on function public.certsim_service_claim_python_expiry(uuid),
  public.certsim_service_prepare_python_expiry(uuid,uuid),
  public.certsim_service_complete_python_expiry(uuid,uuid),
  public.certsim_service_read_python_expiry_task(uuid,uuid,uuid,uuid),
  public.certsim_service_materialize_python_expiry(uuid,uuid,uuid,uuid,text) to service_role;
commit;
