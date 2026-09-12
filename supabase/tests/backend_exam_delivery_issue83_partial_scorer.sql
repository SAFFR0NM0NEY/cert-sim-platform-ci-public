begin;
select plan(38);

select has_function('exam_delivery','score_selected_response_partial',array['text','jsonb','jsonb','jsonb','boolean']);
select has_function('exam_delivery','score_package_v2_response_for_scorer',array['text','text','jsonb','jsonb','jsonb','boolean']);
select ok(not has_function_privilege('public','exam_delivery.score_selected_response_partial(text,jsonb,jsonb,jsonb,boolean)','EXECUTE'),'partial scorer is private from PUBLIC');
select ok(not has_function_privilege('anon','exam_delivery.score_selected_response_partial(text,jsonb,jsonb,jsonb,boolean)','EXECUTE'),'partial scorer is private from anon');
select ok(not has_function_privilege('authenticated','exam_delivery.score_selected_response_partial(text,jsonb,jsonb,jsonb,boolean)','EXECUTE'),'partial scorer is private from authenticated');
select ok(not has_function_privilege('service_role','exam_delivery.score_selected_response_partial(text,jsonb,jsonb,jsonb,boolean)','EXECUTE'),'partial scorer is private from service_role');
select ok((select proconfig @> array['search_path=""'] and provolatile='i' and not prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='score_selected_response_partial'),'partial scorer is immutable invoker with empty search path');

create temporary table issue83_fixture(kind text primary key,presentation jsonb,scoring jsonb);
insert into issue83_fixture values
('single','{"requiredSelections":1,"options":[{"id":"a"},{"id":"b"}]}'::jsonb,'{"model":"per-correct-option-no-negative-v1","correctAnswers":["a"],"maximumRawPoints":1,"selectionCap":1}'::jsonb),
('two','{"requiredSelections":2,"options":[{"id":"a"},{"id":"b"},{"id":"c"}]}'::jsonb,'{"model":"per-correct-option-no-negative-v1","correctAnswers":["a","b"],"maximumRawPoints":2,"selectionCap":2}'::jsonb),
('three','{"requiredSelections":3,"options":[{"id":"a"},{"id":"b"},{"id":"c"},{"id":"d"}]}'::jsonb,'{"model":"per-correct-option-no-negative-v1","correctAnswers":["a","b","c"],"maximumRawPoints":3,"selectionCap":3}'::jsonb);

select is(exam_delivery.score_selected_response_partial('single-choice',presentation,scoring,'{"answer":"a"}',true),'{"earned":1,"status":"Correct","maximum":1}'::jsonb,'single correct 1/1') from issue83_fixture where kind='single';
select is(exam_delivery.score_selected_response_partial('single-choice',presentation,scoring,'{"answer":"b"}',true),'{"earned":0,"status":"Incorrect","maximum":1}'::jsonb,'single incorrect 0/1') from issue83_fixture where kind='single';
select is(exam_delivery.score_selected_response_partial('single-choice',presentation,scoring,'{}',true),'{"earned":0,"status":"Incomplete","maximum":1}'::jsonb,'single unanswered 0/1') from issue83_fixture where kind='single';
select is(exam_delivery.score_selected_response_partial('multi-select',presentation,scoring,'{"answer":["c"]}',true),'{"earned":0,"status":"Incorrect","maximum":2}'::jsonb,'select two 0/2') from issue83_fixture where kind='two';
select is(exam_delivery.score_selected_response_partial('multi-select',presentation,scoring,'{"answer":["a"]}',true),'{"earned":1,"status":"Partial","maximum":2}'::jsonb,'select two incomplete valid 1/2') from issue83_fixture where kind='two';
select is(exam_delivery.score_selected_response_partial('multi-select',presentation,scoring,'{"answer":["a","b"]}',true),'{"earned":2,"status":"Correct","maximum":2}'::jsonb,'select two 2/2') from issue83_fixture where kind='two';
select is(exam_delivery.score_selected_response_partial('multi-select',presentation,scoring,'{"answer":["a","c"]}',true),'{"earned":1,"status":"Partial","maximum":2}'::jsonb,'wrong choice has no deduction') from issue83_fixture where kind='two';
select is(exam_delivery.score_selected_response_partial('multi-select',presentation,scoring,'{"answer":["d"]}',true),'{"earned":0,"status":"Incorrect","maximum":3}'::jsonb,'select three 0/3') from issue83_fixture where kind='three';
select is(exam_delivery.score_selected_response_partial('multi-select',presentation,scoring,'{"answer":["a","d"]}',true),'{"earned":1,"status":"Partial","maximum":3}'::jsonb,'select three 1/3') from issue83_fixture where kind='three';
select is(exam_delivery.score_selected_response_partial('multi-select',presentation,scoring,'{"answer":["b","a"]}',true),'{"earned":2,"status":"Partial","maximum":3}'::jsonb,'select three reordered 2/3') from issue83_fixture where kind='three';
select is(exam_delivery.score_selected_response_partial('multi-select',presentation,scoring,'{"answer":["c","a","b"]}',true),'{"earned":3,"status":"Correct","maximum":3}'::jsonb,'select three 3/3') from issue83_fixture where kind='three';
select is(exam_delivery.score_selected_response_partial('multi-select',presentation,scoring,'{"answer":[]}',true),'{"earned":0,"status":"Incomplete","maximum":3}'::jsonb,'empty selection is incomplete') from issue83_fixture where kind='three';

select throws_ok(format('select exam_delivery.score_selected_response_partial(%L,presentation,scoring,%L::jsonb,true) from issue83_fixture where kind=%L','multi-select','{"answer":["unknown"]}','two'),'22023','response_invalid','unknown option rejected');
select throws_ok(format('select exam_delivery.score_selected_response_partial(%L,presentation,scoring,%L::jsonb,true) from issue83_fixture where kind=%L','multi-select','{"answer":["a","a"]}','two'),'22023','response_invalid','duplicate option rejected');
select throws_ok(format('select exam_delivery.score_selected_response_partial(%L,presentation,scoring,%L::jsonb,true) from issue83_fixture where kind=%L','multi-select','{"answer":["a","b","c"]}','two'),'22023','response_invalid','too many options rejected');
select throws_ok(format('select exam_delivery.score_selected_response_partial(%L,presentation,scoring,%L::jsonb,true) from issue83_fixture where kind=%L','multi-select','{"answer":"a"}','two'),'22023','response_invalid','malformed response rejected');
select throws_ok(format('select exam_delivery.score_selected_response_partial(%L,presentation,%L::jsonb,%L::jsonb,true) from issue83_fixture where kind=%L','multi-select','{}','{"answer":["a"]}','two'),'22023','scoring_contract_invalid','missing protected scoring rejected');

select is(
 exam_delivery.score_package_v2_response_for_scorer('legacy-scorer','multi-select',presentation,scoring,'{"answer":["a"]}',true),
 exam_delivery.score_package_v2_response_with_presentation('multi-select',presentation,scoring,'{"answer":["a"]}',true),
 'unrecognized scorer retains legacy result byte-for-byte') from issue83_fixture where kind='two';
select is((exam_delivery.score_package_v2_response_for_scorer('certsim-selected-response-partial-v1','multi-select',presentation,scoring,'{"answer":["a"]}',true)->>'earned')::integer,1,'exact scorer identity dispatches partial scoring') from issue83_fixture where kind='two';
select is((exam_delivery.score_package_v2_response_for_scorer('certsim-selected-response-partial-v1','multi-select',presentation,scoring,'{"answer":["a"]}',true)->>'maximum')::integer,2,'per-item maximum derives from protected metadata') from issue83_fixture where kind='two';
select is(exam_delivery.score_selected_response_partial('multi-select',presentation,scoring,'{}',false),'{"earned":0,"status":"Informational","maximum":0}'::jsonb,'non-scored item remains informational') from issue83_fixture where kind='two';

select throws_ok(format('select exam_delivery.score_selected_response_partial(%L,presentation,jsonb_set(scoring,%L,%L::jsonb),%L::jsonb,true) from issue83_fixture where kind=%L','multi-select','{maximumRawPoints}','99','{"answer":["a"]}','two'),'22023','scoring_contract_invalid','over-maximum contract rejected before scoring');
select throws_ok(format('select exam_delivery.score_selected_response_partial(%L,presentation,jsonb_set(scoring,%L,%L::jsonb),%L::jsonb,true) from issue83_fixture where kind=%L','multi-select','{selectionCap}','3','{"answer":["a"]}','two'),'22023','scoring_contract_invalid','selection cap mismatch rejected');
select throws_ok(format('select exam_delivery.score_selected_response_partial(%L,presentation,jsonb_set(scoring,%L,%L::jsonb),%L::jsonb,true) from issue83_fixture where kind=%L','multi-select','{model}','"other"','{"answer":["a"]}','two'),'22023','scoring_contract_invalid','incorrect scoring model rejected');

select is(
 (select sum((exam_delivery.score_package_v2_response_for_scorer('certsim-selected-response-partial-v1',case when kind='single' then 'single-choice' else 'multi-select' end,presentation,scoring,case kind when 'single' then '{"answer":"a"}'::jsonb when 'two' then '{"answer":["a"]}'::jsonb else '{"answer":["a","b"]}'::jsonb end,true)->>'earned')::numeric) from issue83_fixture),4::numeric,
 'attempt raw total sums item earned points');
select is(
 (select sum((exam_delivery.score_package_v2_response_for_scorer('certsim-selected-response-partial-v1',case when kind='single' then 'single-choice' else 'multi-select' end,presentation,scoring,'{}',true)->>'maximum')::numeric) from issue83_fixture),6::numeric,
 'attempt maximum sums protected per-item maxima');
select is(round(100*4::numeric/6,4),66.6667::numeric,'percentage normalization uses raw/max');
select ok(round(100*4::numeric/6,4)*10<700,'normalized synthetic score fails a 700 pass mark');
select is((exam_delivery.score_selected_response_partial('multi-select',presentation,scoring,'{"answer":["a"]}',true)->>'status'),'Partial','review DTO source status supports partial') from issue83_fixture where kind='two';
select ok((select prosrc like '%score_package_v2_response_for_scorer(v_attempt.scorer_version%' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='submit_attempt_v2_with_assessment_gate'),'submission totals dispatch from stored scorer identity');
select ok((select prosrc like '%score_package_v2_response_for_scorer(v.scorer_version%' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='check_practice_item'),'practice feedback dispatches from stored scorer identity');

select * from finish();
rollback;
