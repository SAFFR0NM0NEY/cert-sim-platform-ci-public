begin;
select no_plan();

select has_function('exam_delivery','get_exam_operations_health',array['uuid','text']);
select has_function('public','certsim_examops_get_health',array['text']);

select ok((
  select prosecdef and provolatile='s'
    and proconfig @> array['search_path=""','statement_timeout=10s']
  from pg_proc
  where oid='exam_delivery.get_exam_operations_health(uuid,text)'::regprocedure
),'private health is a bounded stable fixed-search-path definer');
select ok((
  select prosecdef and provolatile='s'
    and proconfig @> array['search_path=""','statement_timeout=10s']
  from pg_proc
  where oid='public.certsim_examops_get_health(text)'::regprocedure
),'public health wrapper is a bounded stable fixed-search-path definer');

select ok(has_function_privilege(
  'authenticated','public.certsim_examops_get_health(text)','EXECUTE'
),'authenticated can reach the checked health wrapper');
select ok(not has_function_privilege(
  'anon','public.certsim_examops_get_health(text)','EXECUTE'
),'anonymous cannot execute the health wrapper');
select ok(not has_function_privilege(
  'service_role','public.certsim_examops_get_health(text)','EXECUTE'
),'service role has no wrapper bypass');
select ok(not has_function_privilege(
  'authenticated','exam_delivery.get_exam_operations_health(uuid,text)','EXECUTE'
),'private health function is denied to authenticated');
select ok(not has_function_privilege(
  'service_role','exam_delivery.get_exam_operations_health(uuid,text)','EXECUTE'
),'service role cannot bypass private health');
select ok(not has_function_privilege(
  'anon','exam_delivery.get_exam_operations_health(uuid,text)','EXECUTE'
),'anonymous cannot execute private health');

select ok(
  pg_get_functiondef('public.certsim_examops_get_health(text)'::regprocedure)
    ~ 'auth\.uid\(\)' and
  pg_get_functiondef('public.certsim_examops_get_health(text)'::regprocedure)
    ~ 'examops_actor_is_platform_owner',
  'wrapper derives the caller and requires active Platform Owner authority'
);
select ok(
  pg_get_functiondef('exam_delivery.get_exam_operations_health(uuid,text)'::regprocedure)
    ~ 'validate_current_exam_release_configuration',
  'health reuses Phase 4B current-state validation'
);
select ok(
  pg_get_functiondef('exam_delivery.get_exam_operations_health(uuid,text)'::regprocedure)
    ~ 'attempt_continuation_contracts',
  'health derives safe continuation aggregates'
);
select ok(
  pg_get_functiondef('exam_delivery.get_exam_operations_health(uuid,text)'::regprocedure)
    ~ 'operation.result_state=''succeeded''' and
  pg_get_functiondef('exam_delivery.get_exam_operations_health(uuid,text)'::regprocedure)
    ~ 'operation.operation_type in \(''ACTIVATE'',''ROLLBACK''\)',
  'current release evidence uses only successful configuration-changing generic operations'
);
select ok(
  pg_get_functiondef('exam_delivery.get_exam_operations_health(uuid,text)'::regprocedure)
    !~* 'package_question|question_id|response_payload|scoring_payload|review_payload|authoring_metadata|email',
  'health definition excludes protected content and identity sources'
);
select ok(
  pg_get_functiondef('exam_delivery.get_exam_operations_health(uuid,text)'::regprocedure)
    !~* '\m(insert|update|delete|truncate)\M',
  'health function has no data mutation statement'
);

select * from finish();
rollback;
