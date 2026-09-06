begin;
select plan(95);

select has_function('exam_delivery','publish_package_v2',array['jsonb']);
select has_function('exam_delivery','create_protected_assignment_v2',array['uuid','uuid','text','text','text','timestamptz','timestamptz','integer','text','text']);
select has_function('exam_delivery','check_eligibility_v2',array['uuid','text','text']);
select has_function('exam_delivery','start_attempt_v2',array['uuid','text','text','uuid']);
select has_function('exam_delivery','submit_attempt_v2',array['uuid','uuid','uuid']);
select has_function('exam_delivery','package_v2_response_valid',array['text','jsonb','jsonb']);
select has_function('exam_delivery','score_package_v2_response',array['text','jsonb','jsonb','boolean']);
select has_function('exam_delivery','score_package_v2_response_with_presentation',array['text','jsonb','jsonb','jsonb','boolean']);
select has_function('public','certsim_protected_create_assignment_v2',array['uuid','uuid','text','text','text','timestamptz','timestamptz','integer','text','text']);
select ok(exam_delivery.package_v2_runtime_supported('certsim-ai901-weighted-generator-v2','certsim-ai901-exact-scorer-v2',null),'AI-901 v2 runtime pair is admitted');
select ok(not exam_delivery.package_v2_runtime_supported('certsim-ai901-weighted-generator-v2','certsim-az204-exact-scorer-v1',null),'AI-901 generator cannot be paired with another scorer');
select ok(exam_delivery.package_v2_runtime_supported('certsim-sc200-canonical-forms-v1','certsim-selected-response-partial-v1',null),'SC-200 reviewed runtime pair is admitted');
select ok(not exam_delivery.package_v2_runtime_supported('certsim-sc200-canonical-forms-v1','certsim-az204-exact-scorer-v1',null),'SC-200 generator rejects another scorer');
select ok(not exam_delivery.package_v2_runtime_supported('certsim-az204-grouped-generator-v1','certsim-selected-response-partial-v1',null),'SC-200 scorer rejects another generator');
select ok(not exam_delivery.package_v2_runtime_supported('certsim-sc200-canonical-forms-v1','certsim-selected-response-partial-v1','unsupported-runtime'),'SC-200 pair rejects unsupported third capability');
select ok(not exam_delivery.package_v2_runtime_supported('unknown-generator','unknown-scorer',null),'unknown runtime pair remains rejected');
select ok(not has_function_privilege('authenticated','exam_delivery.package_v2_runtime_supported(text,text,text)','EXECUTE'),'browser role cannot invoke private runtime registry');

select ok((select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='publish_package_v2'),'publisher is definer');
select ok(not (select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='certsim_protected_publish_package'),'publication wrapper is invoker');
select ok((select proconfig @> array['search_path=""','statement_timeout=15s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='publish_package_v2'),'publisher is bounded');
select ok((select pg_get_functiondef(p.oid) ~ 'auth.uid\(\)' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='publish_package_v2'),'publisher derives actor');
select ok(not has_function_privilege('public','public.certsim_protected_publish_package(jsonb)','EXECUTE'),'PUBLIC denied publication');
select ok(not has_function_privilege('anon','public.certsim_protected_publish_package(jsonb)','EXECUTE'),'anon denied publication');
select ok(has_function_privilege('authenticated','public.certsim_protected_publish_package(jsonb)','EXECUTE'),'authenticated owner may enter checked publication');
select ok(not has_function_privilege('service_role','public.certsim_protected_publish_package(jsonb)','EXECUTE'),'service role denied publication');
select ok(not has_function_privilege('authenticated','public.certsim_protected_check_eligibility(uuid,text,text)','EXECUTE'),'browser cannot bypass Edge eligibility');
select ok(has_function_privilege('service_role','public.certsim_protected_check_eligibility(uuid,text,text)','EXECUTE'),'Edge runtime may call eligibility');
select ok(has_function_privilege('service_role','public.certsim_protected_start_attempt(uuid,text,text,uuid)','EXECUTE'),'Edge runtime may call start');
select ok(has_function_privilege('service_role','public.certsim_protected_submit_attempt(uuid,uuid,uuid)','EXECUTE'),'Edge runtime may call submit');
select ok(has_function_privilege('service_role','public.certsim_protected_save_response(uuid,uuid,uuid,jsonb,integer,uuid)','EXECUTE'),'Edge runtime may call response save');
select ok((select is_nullable='YES' from information_schema.columns where table_schema='exam_delivery' and table_name='attempts' and column_name='protected_assignment_id'),'open-authenticated attempts may omit assignments');
select ok((select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='resume_attempt'),'resume attempt retains its definer boundary');
select ok((select proconfig @> array['search_path=""','statement_timeout=10s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='resume_attempt'),'resume attempt has empty search path and bounded timeout');
select ok((select position('packageVersion' in pg_get_functiondef(p.oid))>0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='resume_attempt'),'resume projection exposes immutable package version');
select ok(not has_function_privilege('authenticated','exam_delivery.resume_attempt(uuid,uuid)','EXECUTE') and has_function_privilege('service_role','exam_delivery.resume_attempt(uuid,uuid)','EXECUTE'),'resume remains Edge-runtime-only');

select ok(not has_schema_privilege('public','exam_delivery','USAGE'),'PUBLIC has no private schema usage');
select ok(not has_schema_privilege('anon','exam_delivery','USAGE'),'anon has no private schema usage');
select ok(has_schema_privilege('authenticated','exam_delivery','USAGE'),'authenticated retains publication-chain schema usage');

select ok((select bool_and(r.rolname='postgres') from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='exam_delivery' and p.proname in ('check_eligibility_v2','start_attempt_v2','submit_attempt_v2','package_v2_response_valid')),'remediated helpers retain postgres ownership');
select ok((select bool_and(p.prosecdef) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname in ('check_eligibility_v2','start_attempt_v2','submit_attempt_v2')),'lifecycle helpers remain security definer');
select ok(not (select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='package_v2_response_valid'),'response validator remains security invoker');
select ok((select bool_and(p.proconfig @> array['search_path=""']) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname in ('check_eligibility_v2','start_attempt_v2','submit_attempt_v2','package_v2_response_valid')),'remediated helpers retain empty search paths');
select ok((select bool_and(case p.proname when 'check_eligibility_v2' then p.proconfig @> array['statement_timeout=10s'] when 'start_attempt_v2' then p.proconfig @> array['statement_timeout=15s'] when 'submit_attempt_v2' then p.proconfig @> array['statement_timeout=15s'] else not coalesce(p.proconfig,array[]::text[])::text[] && array['statement_timeout=10s','statement_timeout=15s'] end) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname in ('check_eligibility_v2','start_attempt_v2','submit_attempt_v2','package_v2_response_valid')),'remediated helper timeouts remain bounded as designed');

select ok((select position('never' in pg_get_functiondef(p.oid))>0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='publish_package_v2'),'package-v2 publication retains never/never declaration');
select ok((select position('after_submission' in pg_get_functiondef(p.oid))>0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='publish_package_v2'),'package-v2 publication accepts paired after-submission declaration');
select ok((select position('json_has_exact_keys' in pg_get_functiondef(p.oid))>0 and position('releasePolicy' in pg_get_functiondef(p.oid))>0 and position('answers' in pg_get_functiondef(p.oid))>0 and position('review' in pg_get_functiondef(p.oid))>0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='publish_package_v2'),'release policy requires exact review and answer keys');
select ok((select position('p_review_release_policy' in pg_get_functiondef(p.oid))>0 and position('p_answer_release_policy' in pg_get_functiondef(p.oid))>0 and position('never' in pg_get_functiondef(p.oid))>0 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='create_protected_assignment_v2'),'effective assignments remain constrained to never/never');

select ok((select count(*)=0 from information_schema.role_table_grants where table_schema='exam_delivery' and grantee in ('PUBLIC','anon','authenticated','service_role')),'no direct delivery-table grants exist');
select ok(not exists(select 1 from pg_default_acl d join pg_namespace n on n.oid=d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a where n.nspname='exam_delivery' and d.defaclobjtype='f' and a.grantee=0 and a.privilege_type='EXECUTE'),'future postgres-owned exam_delivery functions do not default to PUBLIC execute');

select ok(not has_function_privilege('public','exam_delivery.check_eligibility_v2(uuid,text,text)','EXECUTE'),'PUBLIC denied v2 eligibility');
select ok(not has_function_privilege('anon','exam_delivery.check_eligibility_v2(uuid,text,text)','EXECUTE'),'anon denied v2 eligibility');
select ok(not has_function_privilege('authenticated','exam_delivery.check_eligibility_v2(uuid,text,text)','EXECUTE'),'authenticated denied v2 eligibility');
select ok(not has_function_privilege('service_role','exam_delivery.check_eligibility_v2(uuid,text,text)','EXECUTE'),'service role uses fixed eligibility wrapper only');
select ok(not has_function_privilege('public','exam_delivery.start_attempt_v2(uuid,text,text,uuid)','EXECUTE'),'PUBLIC denied v2 start');
select ok(not has_function_privilege('anon','exam_delivery.start_attempt_v2(uuid,text,text,uuid)','EXECUTE'),'anon denied v2 start');
select ok(not has_function_privilege('authenticated','exam_delivery.start_attempt_v2(uuid,text,text,uuid)','EXECUTE'),'authenticated denied v2 start');
select ok(not has_function_privilege('service_role','exam_delivery.start_attempt_v2(uuid,text,text,uuid)','EXECUTE'),'service role uses fixed start wrapper only');
select ok(not has_function_privilege('public','exam_delivery.submit_attempt_v2(uuid,uuid,uuid)','EXECUTE'),'PUBLIC denied v2 submit');
select ok(not has_function_privilege('anon','exam_delivery.submit_attempt_v2(uuid,uuid,uuid)','EXECUTE'),'anon denied v2 submit');
select ok(not has_function_privilege('authenticated','exam_delivery.submit_attempt_v2(uuid,uuid,uuid)','EXECUTE'),'authenticated denied v2 submit');
select ok(not has_function_privilege('service_role','exam_delivery.submit_attempt_v2(uuid,uuid,uuid)','EXECUTE'),'service role uses fixed submit wrapper only');
select ok(not has_function_privilege('public','exam_delivery.package_v2_response_valid(text,jsonb,jsonb)','EXECUTE'),'PUBLIC denied v2 response validator');
select ok(not has_function_privilege('anon','exam_delivery.package_v2_response_valid(text,jsonb,jsonb)','EXECUTE'),'anon denied v2 response validator');
select ok(not has_function_privilege('authenticated','exam_delivery.package_v2_response_valid(text,jsonb,jsonb)','EXECUTE'),'authenticated denied v2 response validator');
select ok(not has_function_privilege('service_role','exam_delivery.package_v2_response_valid(text,jsonb,jsonb)','EXECUTE'),'response validator remains owner-internal only');
select ok(not has_function_privilege('public','exam_delivery.score_package_v2_response(text,jsonb,jsonb,boolean)','EXECUTE'),'PUBLIC denied fixed package-v2 scorer');
select ok(not has_function_privilege('anon','exam_delivery.score_package_v2_response(text,jsonb,jsonb,boolean)','EXECUTE'),'anon denied fixed package-v2 scorer');
select ok(not has_function_privilege('authenticated','exam_delivery.score_package_v2_response(text,jsonb,jsonb,boolean)','EXECUTE'),'authenticated denied fixed package-v2 scorer');
select ok(not has_function_privilege('service_role','exam_delivery.score_package_v2_response(text,jsonb,jsonb,boolean)','EXECUTE'),'service role enters scoring only through fixed lifecycle wrappers');
select ok(not (select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='score_package_v2_response'),'fixed package-v2 scorer remains security invoker');
select ok((select provolatile='i' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='score_package_v2_response'),'fixed package-v2 scorer remains immutable');
select ok((select proconfig @> array['search_path=""'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='score_package_v2_response'),'fixed package-v2 scorer retains an empty search path');

set local role authenticated;
select throws_ok($$select exam_delivery.start_attempt_v2(null,null,null,null)$$,'42501',null,'authenticated direct lifecycle execution fails');
reset role;
set local role anon;
select throws_ok($$select exam_delivery.check_eligibility_v2(null,null,null)$$,'42501',null,'anonymous direct lifecycle execution fails');
reset role;

select is(exam_delivery.score_package_v2_response('single-choice','{"correctAnswer":"a"}','{"answer":"a"}',true)->>'status','Correct','single choice scores authoritatively');
select is(exam_delivery.score_package_v2_response('multi-select','{"correctAnswers":["a","b"]}','{"answer":["b","a"]}',true)->>'status','Correct','set comparison is unordered');
select is(exam_delivery.score_package_v2_response('reorder','{"correctOrder":["a","b"]}','{"answer":["b","a"]}',true)->>'status','Incorrect','ordered comparison remains ordered');
select is(exam_delivery.score_package_v2_response('pbq-config-panel','{"strategy":"per-component-map","expectedMap":{"x":"a","y":"b"}}','{"selectedAnswers":{"x":"a"}}',true)->>'status','Partial','PBQ partial result is preserved');
select is((exam_delivery.score_package_v2_response('case-study-context','{}','{}',false)->>'maximum')::integer,0,'informational context is not scored');
select is(
  exam_delivery.score_package_v2_response_with_presentation(
    'dropdown-code',
    '{"blanks":[{"id":"first"},{"id":"second"}]}',
    '{"blanks":[{"correctAnswer":"alpha"},{"correctAnswer":"beta"}]}',
    '{"answer":{"first":"alpha","second":"beta"}}',
    true
  )->>'status',
  'Correct',
  'dropdown scoring pairs presentation identifiers with protected answers by ordinal position'
);
select is(
  exam_delivery.score_package_v2_response_with_presentation(
    'dropdown-command',
    '{"blanks":[{"id":"first"},{"id":"second"}]}',
    '{"blanks":[{"correctAnswer":"alpha"},{"correctAnswer":"beta"}]}',
    '{"answer":{"first":"beta","second":"alpha"}}',
    true
  )->>'status',
  'Incorrect',
  'dropdown scoring preserves per-blank identity rather than comparing value sets'
);
select is(
  exam_delivery.score_package_v2_response('pbq-config-panel','{"strategy":"per-component-map","expectedMap":{"x":"a","y":"b"}}','{"selectedAnswers":{"x":"a"}}',true)->>'status',
  'Partial',
  'configuration-panel PBQ preserves per-component partial credit'
);
select is(
  exam_delivery.score_package_v2_response('pbq-firewall','{"strategy":"per-component-map","expectedMap":{"rule":"allow"}}','{"selectedAnswers":{"rule":"allow"}}',true)->>'status',
  'Correct',
  'firewall PBQ scores its fixed component map'
);
select is(
  exam_delivery.score_package_v2_response('pbq-multi-host-terminal','{"strategy":"per-component-positive","expectedMap":{"host-a":"ready","host-b":"ready"}}','{"selectedAnswers":{"host-a":"ready"}}',true)->>'status',
  'Partial',
  'multi-host PBQ preserves positive component credit'
);
select is(
  exam_delivery.score_package_v2_response('pbq-ordering','{"strategy":"exact-ordered-sequence","expectedOrder":["a","b","c"]}','{"selectedOrder":["a","c","b"]}',true)->>'status',
  'Partial',
  'ordering PBQ uses an integer JSON index and preserves positional credit'
);
select is(
  exam_delivery.score_package_v2_response('pbq-terminal','{"strategy":"weighted-rule-evaluation","expectedAnswer":"done","finalAnswerPoints":2,"criteria":[{"points":1,"commandIds":["inspect"]}]}','{"selectedAnswer":"pending","executedCommands":["inspect"]}',true)->>'status',
  'Partial',
  'terminal PBQ preserves weighted partial credit'
);
select is(
  (
    with distribution(question_type,scoring,response,copies) as (values
      ('pbq-config-panel','{"strategy":"per-component-map","expectedMap":{"x":"a"}}'::jsonb,'{"selectedAnswers":{"x":"a"}}'::jsonb,4),
      ('pbq-firewall','{"strategy":"per-component-map","expectedMap":{"x":"a"}}'::jsonb,'{"selectedAnswers":{"x":"a"}}'::jsonb,1),
      ('pbq-multi-host-terminal','{"strategy":"per-component-map","expectedMap":{"x":"a"}}'::jsonb,'{"selectedAnswers":{"x":"a"}}'::jsonb,3),
      ('pbq-ordering','{"strategy":"exact-ordered-sequence","expectedOrder":["a","b"]}'::jsonb,'{"selectedOrder":["a","b"]}'::jsonb,1),
      ('pbq-terminal','{"strategy":"weighted-rule-evaluation","expectedAnswer":"done","finalAnswerPoints":1,"criteria":[]}'::jsonb,'{"selectedAnswer":"done","executedCommands":[]}'::jsonb,1)
    ), scored as (
      select exam_delivery.score_package_v2_response(question_type,scoring,response,true) score
      from distribution cross join lateral generate_series(1,copies)
    )
    select jsonb_build_object('items',count(*),'earned',sum((score->>'earned')::numeric),'maximum',sum((score->>'maximum')::numeric)) from scored
  ),
  '{"items":10,"earned":11,"maximum":11}'::jsonb,
  'preserved 4/1/3/1/1 PBQ distribution aggregates deterministically'
);
select throws_ok(
  $$select exam_delivery.score_package_v2_response_with_presentation(
    'dropdown-code','{"blanks":[{}]}','{"blanks":[{"correctAnswer":"alpha"}]}',
    '{"answer":{}}',true
  )$$,
  '22023',
  'scoring_contract_invalid',
  'dropdown scoring rejects a missing presentation identifier deterministically'
);

select is((select count(*)::integer from exam_delivery.exam_access_policies),0,'migration creates no policy');
select is((select count(*)::integer from exam_delivery.exam_access_learners),0,'migration creates no allowlist');
select is((select count(*)::integer from exam_delivery.protected_assignments),0,'migration creates no assignment');
select is((select count(*)::integer from exam_delivery.attempts),0,'migration creates no attempt');
select is((select count(*)::integer from exam_delivery.package_versions),0,'migration publishes no package');
select is(
  (
    select count(*)::integer
    from exam_delivery.pilot_gates
    where exam_key = 'ai-901'
      and not enabled
  ),
  1,
  'remediation preserves the sole disabled AI-901 gate'
);
select is((select count(*)::integer from exam_delivery.attempt_results),0,'migration creates no result');

select * from finish();
rollback;
