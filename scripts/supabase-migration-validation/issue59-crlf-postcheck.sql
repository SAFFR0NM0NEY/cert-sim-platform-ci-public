do $$
declare
  v_signature text;
  v_definition text;
begin
  foreach v_signature in array array[
    'exam_delivery.replace_current_practice_attempt(uuid,jsonb)',
    'exam_delivery.list_current_attempt_bindings(uuid,text,text)',
    'exam_delivery.materialize_attempt_items(uuid,uuid,integer)',
    'exam_delivery.start_assignment_attempt(uuid,text,text,uuid,uuid)',
    'exam_delivery.discover_assignment_attempt(uuid,text,text,text,text,text,uuid)'
  ] loop
    v_definition := pg_get_functiondef(v_signature::regprocedure);
    if strpos(v_definition, E'\r\n') <> 0 then
      raise exception 'issue59_crlf_postcheck_line_endings_remain:%', v_signature;
    end if;
  end loop;

  if pg_get_functiondef(
      'exam_delivery.replace_current_practice_attempt(uuid,jsonb)'::regprocedure
    ) not like '%v_existing.source_assignment_id<>(p_request->>''assignmentId'')::uuid%'
    or pg_get_functiondef(
      'exam_delivery.list_current_attempt_bindings(uuid,text,text)'::regprocedure
    ) not like '%''assignmentId'',a.source_assignment_id%'
    or pg_get_functiondef(
      'exam_delivery.materialize_attempt_items(uuid,uuid,integer)'::regprocedure
    ) not like '%learner_weak_domain_evidence%'
    or pg_get_functiondef(
      'exam_delivery.start_assignment_attempt(uuid,text,text,uuid,uuid)'::regprocedure
    ) not like '%''self_directed_exam'',v_assignment.id%'
    or pg_get_functiondef(
      'exam_delivery.discover_assignment_attempt(uuid,text,text,text,text,text,uuid)'::regprocedure
    ) not like '%p_purpose<>''self_directed_exam''%' then
    raise exception 'issue59_crlf_postcheck_recovery_contract_missing';
  end if;
end
$$;
