begin;
select plan(38);

select has_function('exam_delivery','package_v2_response_valid',array['text','jsonb','jsonb']);

-- Multi-select array validation must remain order-independent and fail closed.
select ok(exam_delivery.package_v2_response_valid('multi-select','{"options":[{"id":"a"},{"id":"b"},{"id":"c"}]}','{"answer":["a","b"]}'),'multi-select accepts allowed identifiers');
select ok(exam_delivery.package_v2_response_valid('multi-select','{"options":[{"id":"a"},{"id":"b"},{"id":"c"}]}','{"answer":["b","a"]}'),'multi-select accepts allowed identifiers in reverse order');
select isnt(exam_delivery.package_v2_response_valid('multi-select','{"options":[{"id":"a"},{"id":"b"},{"id":"c"}]}','{"answer":["a","unknown"]}'),true,'multi-select rejects unknown identifiers without an exception');
select isnt(exam_delivery.package_v2_response_valid('multi-select','{"options":[{"id":"a"},{"id":"b"},{"id":"c"}]}','{"answer":["a","a"]}'),true,'multi-select rejects duplicate identifiers without an exception');
select isnt(exam_delivery.package_v2_response_valid('multi-select','{"options":[{"id":"a"}]}','{"answer":{"a":true}}'),true,'multi-select rejects object answers');
select isnt(exam_delivery.package_v2_response_valid('multi-select','{"options":[{"id":"a"}]}','{"answer":"a"}'),true,'multi-select rejects scalar answers');
select isnt(exam_delivery.package_v2_response_valid('multi-select','{"options":[{"id":"a"}]}','{"answer":["a"],"unsupported":true}'),true,'multi-select preserves the response-key allowlist');
select isnt(exam_delivery.package_v2_response_valid('multi-select','{"options":[]}',jsonb_build_object('answer',(select jsonb_agg(value::text) from generate_series(1,51) value))),true,'multi-select preserves the 50-selection bound');

-- Reorder validation checks membership and uniqueness, not correctness/order.
select ok(exam_delivery.package_v2_response_valid('reorder','{"items":[{"id":"a"},{"id":"b"},{"id":"c"}]}','{"answer":["b","a","c"]}'),'reorder accepts an allowed sequence without scoring it');
select isnt(exam_delivery.package_v2_response_valid('reorder','{"items":[{"id":"a"},{"id":"b"},{"id":"c"}]}','{"answer":["a","unknown"]}'),true,'reorder rejects unknown identifiers without an exception');
select isnt(exam_delivery.package_v2_response_valid('reorder','{"items":[{"id":"a"},{"id":"b"},{"id":"c"}]}','{"answer":["a","a"]}'),true,'reorder rejects duplicate identifiers without an exception');
select isnt(exam_delivery.package_v2_response_valid('reorder','{"items":[{"id":"a"}]}','{"answer":{"a":1}}'),true,'reorder rejects object answers');
select isnt(exam_delivery.package_v2_response_valid('reorder','{"items":[{"id":"a"}]}','{"answer":"a"}'),true,'reorder rejects scalar answers');
select isnt(exam_delivery.package_v2_response_valid('reorder','{"items":[]}',jsonb_build_object('answer',(select jsonb_agg(value::text) from generate_series(1,101) value))),true,'reorder preserves the 100-entry bound');

-- Adjacent existing validator branches remain supported.
select ok(exam_delivery.package_v2_response_valid('single-choice','{"options":[{"id":"a"}]}','{"answer":"a"}'),'single-choice remains valid');
select isnt(exam_delivery.package_v2_response_valid('single-choice','{"options":[{"id":"a"}]}','{"answer":"unknown"}'),true,'single-choice unknown identifiers remain invalid');
select ok(exam_delivery.package_v2_response_valid('drag-drop-match','{}','{"answer":{"left":"right"}}'),'drag-drop match remains valid');
select ok(exam_delivery.package_v2_response_valid('dropdown-code','{}','{"answer":{"blank":"choice"}}'),'dropdown code remains valid');
select ok(exam_delivery.package_v2_response_valid('dropdown-command','{}','{"answer":{"blank":"choice"}}'),'dropdown command remains valid');
select ok(exam_delivery.package_v2_response_valid('true-false-single-v1','{}','{"answer":false}'),'true-false single remains valid');
select isnt(exam_delivery.package_v2_response_valid('true-false-single-v1','{}','{"answer":"false"}'),true,'true-false single strings remain invalid');
select ok(exam_delivery.package_v2_response_valid('true-false-composite-v1','{"statements":[{"id":"s1"}]}','{"answer":{"s1":true}}'),'true-false composite remains valid');
select isnt(exam_delivery.package_v2_response_valid('true-false-composite-v1','{"statements":[{"id":"s1"}]}','{"answer":{"unknown":true}}'),true,'true-false composite unknown statements remain invalid');
select ok(exam_delivery.package_v2_response_valid('matching-v1','{"sources":[{"id":"s1"}],"targets":[{"id":"t1"}],"allowTargetReuse":false}','{"answer":{"s1":"t1"}}'),'matching remains valid');
select isnt(exam_delivery.package_v2_response_valid('matching-v1','{"sources":[{"id":"s1"}],"targets":[{"id":"t1"}]}','{"answer":{"s1":"unknown"}}'),true,'matching unknown targets remain invalid');
select ok(exam_delivery.package_v2_response_valid('code-dropdown-completion-v1','{"blanks":[{"id":"b1","options":[{"id":"o1"}]}]}','{"answer":{"b1":"o1"}}'),'code dropdown completion remains valid');
select isnt(exam_delivery.package_v2_response_valid('code-dropdown-completion-v1','{"blanks":[{"id":"b1","options":[{"id":"o1"}]}]}','{"answer":{"b1":"unknown"}}'),true,'code dropdown completion unknown options remain invalid');

-- PBQ array/map branches retain their current allowlist behavior.
select ok(exam_delivery.package_v2_response_valid('pbq-order','{"responseAllowlist":{"orderIds":["a","b"]}}','{"selectedOrder":["b","a"]}'),'PBQ selected order remains valid');
select isnt(exam_delivery.package_v2_response_valid('pbq-order','{"responseAllowlist":{"orderIds":["a","b"]}}','{"selectedOrder":["unknown"]}'),true,'PBQ selected order rejects unknown identifiers');
select ok(exam_delivery.package_v2_response_valid('pbq-command','{"responseAllowlist":{"commandIds":["run"]}}','{"executedCommands":["run"]}'),'PBQ commands remain valid');
select isnt(exam_delivery.package_v2_response_valid('pbq-command','{"responseAllowlist":{"commandIds":["run"]}}','{"executedCommands":["unknown"]}'),true,'PBQ commands reject unknown identifiers');
select ok(exam_delivery.package_v2_response_valid('pbq-match','{"responseAllowlist":{"targetIds":["t1"],"answerIdsByTarget":{"t1":["a1"]}}}','{"selectedAnswers":{"t1":"a1"}}'),'PBQ selected answers remain valid');
select isnt(exam_delivery.package_v2_response_valid('pbq-match','{"responseAllowlist":{"targetIds":["t1"],"answerIdsByTarget":{"t1":["a1"]}}}','{"selectedAnswers":{"t1":"unknown"}}'),true,'PBQ selected answers reject unknown identifiers');

select volatility_is('exam_delivery','package_v2_response_valid',array['text','jsonb','jsonb'],'immutable');
select isnt((select prosecdef from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='package_v2_response_valid'),true,'response validator remains security invoker');
select ok((select proconfig @> array['search_path=""'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='package_v2_response_valid'),'response validator retains an empty search path');
select ok(not has_function_privilege('authenticated','exam_delivery.package_v2_response_valid(text,jsonb,jsonb)','EXECUTE'),'response validator remains private from authenticated browsers');

select * from finish();
rollback;
