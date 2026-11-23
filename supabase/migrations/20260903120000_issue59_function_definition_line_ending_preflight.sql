-- Normalize only the database-stored line endings of the five pre-Issue59
-- functions whose definitions are inspected by guarded textual rewrites.
-- The migration file's own checkout line endings are intentionally irrelevant.
do $$
declare
  v_signature text;
  v_function regprocedure;
  v_definition text;
  v_normalized text;
  v_after_definition text;
  v_before record;
  v_after record;
begin
  foreach v_signature in array array[
    'exam_delivery.replace_current_practice_attempt(uuid,jsonb)',
    'exam_delivery.list_current_attempt_bindings(uuid,text,text)',
    'exam_delivery.materialize_attempt_items(uuid,uuid,integer)',
    'exam_delivery.start_assignment_attempt(uuid,text,text,uuid,uuid)',
    'exam_delivery.discover_assignment_attempt(uuid,text,text,text,text,text,uuid)'
  ] loop
    v_function := to_regprocedure(v_signature);
    if v_function is null then
      raise exception 'issue59_line_ending_preflight_missing_function:%', v_signature;
    end if;

    select p.oid, p.proowner, p.proacl, p.prosecdef, p.provolatile,
      p.proparallel, p.proconfig, p.proargtypes, p.prorettype, p.prolang
    into strict v_before
    from pg_catalog.pg_proc p
    where p.oid = v_function::oid;

    v_definition := pg_get_functiondef(v_function);
    v_normalized := replace(v_definition, E'\r\n', E'\n');

    if v_signature = 'exam_delivery.replace_current_practice_attempt(uuid,jsonb)'
      and strpos(v_normalized,
        E'if v_existing.protected_assignment_id is not null or v_existing.source_assignment_id is not null\n    or v_existing.attribution_source=''assignment''\n    or exists') = 0 then
      raise exception 'issue59_line_ending_preflight_replacement_contract_drift';
    elsif v_signature = 'exam_delivery.list_current_attempt_bindings(uuid,text,text)'
      and (strpos(v_normalized, '''attemptId'',a.id,') = 0
        or strpos(v_normalized,
          E'    and a.source_assignment_id is null\n    and a.attribution_source is distinct from ''assignment''\n') = 0) then
      raise exception 'issue59_line_ending_preflight_binding_contract_drift';
    elsif v_signature = 'exam_delivery.materialize_attempt_items(uuid,uuid,integer)'
      and (v_normalized not like '%where v_attempt.purpose<>''assigned_assessment''%'
        or v_normalized not like '%where v_attempt.purpose=''assigned_assessment''%'
        or v_normalized not like '%(pbq or case_study)%') then
      raise exception 'issue59_line_ending_preflight_materializer_contract_drift';
    elsif v_signature = 'exam_delivery.start_assignment_attempt(uuid,text,text,uuid,uuid)'
      and (strpos(v_normalized,
        'or nullif(v_assignment.profile_id,'''') is null or v_assignment.profile_id<>p_profile_key') = 0
        or strpos(v_normalized, '''assigned_assessment'',v_assignment.id') = 0) then
      raise exception 'issue59_line_ending_preflight_assignment_start_contract_drift';
    elsif v_signature = 'exam_delivery.discover_assignment_attempt(uuid,text,text,text,text,text,uuid)'
      and strpos(v_normalized, 'p_purpose<>''assigned_assessment''') = 0 then
      raise exception 'issue59_line_ending_preflight_assignment_discovery_contract_drift';
    end if;

    if v_definition <> v_normalized then
      execute v_normalized;
    end if;

    v_function := to_regprocedure(v_signature);
    select p.oid, p.proowner, p.proacl, p.prosecdef, p.provolatile,
      p.proparallel, p.proconfig, p.proargtypes, p.prorettype, p.prolang
    into strict v_after
    from pg_catalog.pg_proc p
    where p.oid = v_function::oid;

    if v_after.oid is distinct from v_before.oid
      or v_after.proowner is distinct from v_before.proowner
      or v_after.proacl is distinct from v_before.proacl
      or v_after.prosecdef is distinct from v_before.prosecdef
      or v_after.provolatile is distinct from v_before.provolatile
      or v_after.proparallel is distinct from v_before.proparallel
      or v_after.proconfig is distinct from v_before.proconfig
      or v_after.proargtypes is distinct from v_before.proargtypes
      or v_after.prorettype is distinct from v_before.prorettype
      or v_after.prolang is distinct from v_before.prolang then
      raise exception 'issue59_line_ending_preflight_function_identity_drift:%', v_signature;
    end if;

    v_after_definition := pg_get_functiondef(v_function);
    if strpos(v_after_definition, E'\r\n') <> 0
      or replace(v_after_definition, E'\r\n', E'\n') <> v_normalized then
      raise exception 'issue59_line_ending_preflight_definition_drift:%', v_signature;
    end if;
  end loop;
end
$$;
