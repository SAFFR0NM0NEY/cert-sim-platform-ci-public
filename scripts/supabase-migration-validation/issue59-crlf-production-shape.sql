-- Disposable-test fixture only. Reproduce the database representation observed
-- in production without changing function semantics or identity/security data.
do $$
declare
  v_signature text;
  v_function regprocedure;
  v_definition text;
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
      raise exception 'issue59_crlf_fixture_missing_function:%', v_signature;
    end if;

    select p.oid, p.proowner, p.proacl, p.prosecdef, p.provolatile,
      p.proparallel, p.proconfig, p.proargtypes, p.prorettype, p.prolang
    into strict v_before
    from pg_catalog.pg_proc p
    where p.oid = v_function::oid;

    v_definition := replace(pg_get_functiondef(v_function), E'\r\n', E'\n');
    execute replace(v_definition, E'\n', E'\r\n');

    v_function := to_regprocedure(v_signature);
    select p.oid, p.proowner, p.proacl, p.prosecdef, p.provolatile,
      p.proparallel, p.proconfig, p.proargtypes, p.prorettype, p.prolang
    into strict v_after
    from pg_catalog.pg_proc p
    where p.oid = v_function::oid;

    if strpos(pg_get_functiondef(v_function), E'\r\n') = 0 then
      raise exception 'issue59_crlf_fixture_not_reproduced:%', v_signature;
    end if;
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
      raise exception 'issue59_crlf_fixture_function_identity_drift:%', v_signature;
    end if;
  end loop;
end
$$;
