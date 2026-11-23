begin;
select no_plan();

select has_function('exam_delivery','package_v2_response_valid',array['text','jsonb','jsonb'],'shared response validator exists');
select has_function('exam_delivery','score_package_v2_response',array['text','jsonb','jsonb','boolean'],'generic scorer exists');
select has_function('exam_delivery','score_package_v2_response_with_presentation',array['text','jsonb','jsonb','jsonb','boolean'],'presentation-aware scorer exists');
select has_function('exam_delivery','score_selected_response_partial',array['text','jsonb','jsonb','jsonb','boolean'],'selected-response partial scorer exists');
select has_function('exam_delivery','score_package_v2_response_for_scorer',array['text','text','jsonb','jsonb','jsonb','boolean'],'scorer router exists');

-- The boolean validator must fail closed for ordinary malformed learner input.
select ok(exam_delivery.package_v2_response_valid('single-choice','{"options":[{"id":"a"}]}','{"answer":"a"}'),'single choice accepts an allowed identifier');
select isnt(exam_delivery.package_v2_response_valid('single-choice','{"options":[{"id":"a"}]}','{"answer":"x"}'),true,'single choice rejects an unknown identifier');
select isnt(exam_delivery.package_v2_response_valid('single-choice','{"options":[{"id":"a"}]}','{"answer":["a"]}'),true,'single choice rejects the wrong response type');
select ok(exam_delivery.package_v2_response_valid('multi-select','{"options":[{"id":"a"},{"id":"b"}]}','{"answer":["b","a"]}'),'multi select accepts an order-independent allowed set');
select isnt(exam_delivery.package_v2_response_valid('multi-select','{"options":[{"id":"a"}]}','{"answer":["a","a"]}'),true,'multi select rejects duplicates');
select isnt(exam_delivery.package_v2_response_valid('multi-select','{"options":[{"id":"a"}]}','{"answer":["x"]}'),true,'multi select rejects an unknown member');
select ok(exam_delivery.package_v2_response_valid('reorder','{"items":[{"id":"a"},{"id":"b"}]}','{"answer":["b","a"]}'),'reorder validation accepts allowed members before scoring order');
select isnt(exam_delivery.package_v2_response_valid('reorder','{"items":[{"id":"a"}]}','{"answer":["x"]}'),true,'reorder rejects an unknown member');
select ok(exam_delivery.package_v2_response_valid('drag-drop-match','{}','{"answer":{"s":"t"}}'),'drag/drop map envelope is accepted');
select isnt(exam_delivery.package_v2_response_valid('drag-drop-match','{}','{"answer":[]}'),true,'drag/drop rejects a non-map answer');
select ok(exam_delivery.package_v2_response_valid('dropdown-code','{}','{"answer":{"b":"o"}}'),'dropdown code map envelope is accepted');
select ok(exam_delivery.package_v2_response_valid('dropdown-command','{}','{"answer":{"b":"o"}}'),'dropdown command map envelope is accepted');
select ok(exam_delivery.package_v2_response_valid('true-false-single-v1','{}','{"answer":true}'),'true/false single accepts boolean');
select isnt(exam_delivery.package_v2_response_valid('true-false-single-v1','{}','{"answer":"true"}'),true,'true/false single rejects string coercion');
select ok(exam_delivery.package_v2_response_valid('true-false-composite-v1','{"statements":[{"id":"s1"},{"id":"s2"}]}','{"answer":{"s1":true}}'),'true/false composite permits a partial keyed response');
select isnt(exam_delivery.package_v2_response_valid('true-false-composite-v1','{"statements":[{"id":"s1"}]}','{"answer":{"x":true}}'),true,'true/false composite rejects unknown keys');
select ok(exam_delivery.package_v2_response_valid('matching-v1','{"sources":[{"id":"s1"}],"targets":[{"id":"t1"}],"allowTargetReuse":false}','{"answer":{"s1":"t1"}}'),'matching accepts an allowed pair');
select isnt(exam_delivery.package_v2_response_valid('matching-v1','{"sources":[{"id":"s1"},{"id":"s2"}],"targets":[{"id":"t1"}],"allowTargetReuse":false}','{"answer":{"s1":"t1","s2":"t1"}}'),true,'matching rejects target reuse when prohibited');
select ok(exam_delivery.package_v2_response_valid('code-dropdown-completion-v1','{"blanks":[{"id":"b1","options":[{"id":"o1"}]}]}','{"answer":{"b1":"o1"}}'),'structured code dropdown accepts an allowed option');
select isnt(exam_delivery.package_v2_response_valid('code-dropdown-completion-v1','{"blanks":[{"id":"b1","options":[{"id":"o1"}]}]}','{"answer":{"b1":"x"}}'),true,'structured code dropdown rejects an unknown option');
select ok(exam_delivery.package_v2_response_valid('pbq-answer','{"responseAllowlist":{"answerIds":["a"]}}','{"selectedAnswer":"a"}'),'PBQ selectedAnswer accepts an allowed identifier');
select ok(exam_delivery.package_v2_response_valid('pbq-order','{"responseAllowlist":{"orderIds":["a","b"]}}','{"selectedOrder":["b","a"]}'),'PBQ selectedOrder accepts allowed identifiers');
select ok(exam_delivery.package_v2_response_valid('pbq-map','{"responseAllowlist":{"targetIds":["t"],"answerIdsByTarget":{"t":["a"]}}}','{"selectedAnswers":{"t":"a"}}'),'PBQ selectedAnswers accepts an allowed map');
select ok(exam_delivery.package_v2_response_valid('pbq-command','{"responseAllowlist":{"commandIds":["run"]}}','{"executedCommands":["run"]}'),'PBQ executedCommands accepts an allowed command');
select isnt(exam_delivery.package_v2_response_valid('pbq-command','{"responseAllowlist":{"commandIds":["run"]}}','{"executedCommands":["x"]}'),true,'PBQ commands reject unknown identifiers');
select isnt(exam_delivery.package_v2_response_valid('single-choice','{"options":[{"id":"a"}]}','{"answer":"a","unexpected":true}'),true,'unsupported response fields fail closed');
select ok(exam_delivery.package_v2_response_valid('case-study-context','{}','{}'),'context/no-response item accepts the empty response');
select ok(exam_delivery.package_v2_response_valid('informational','{}','{}'),'informational/no-response item accepts the empty response');

-- Direct scorer parity: correctness, ordering, exact/set and partial-credit contracts.
select is(exam_delivery.score_package_v2_response('single-choice','{"correctAnswer":"a"}','{"answer":"a"}',true)->>'status','Correct','single choice scores correct');
select is(exam_delivery.score_package_v2_response('single-choice','{"correctAnswer":"a"}','{"answer":"b"}',true)->>'earned','0','single choice scores incorrect as zero');
select is(exam_delivery.score_package_v2_response('multi-select','{"correctAnswers":["a","b"]}','{"answer":["b","a"]}',true)->>'status','Correct','generic multi select uses exact set semantics');
select is(exam_delivery.score_package_v2_response('multi-select','{"correctAnswers":["a","b"]}','{"answer":["a"]}',true)->>'earned','0','generic multi select does not invent partial credit');
select is(exam_delivery.score_package_v2_response('reorder','{"correctOrder":["a","b"]}','{"answer":["a","b"]}',true)->>'status','Correct','reorder scores exact order');
select is(exam_delivery.score_package_v2_response('reorder','{"correctOrder":["a","b"]}','{"answer":["b","a"]}',true)->>'earned','0','reorder rejects reversed order at scoring');
select is(exam_delivery.score_package_v2_response('drag-drop-match','{"correctPairs":{"s":"t"}}','{"answer":{"s":"t"}}',true)->>'status','Correct','drag/drop exact map scores correct');
select is(exam_delivery.score_package_v2_response_with_presentation('dropdown-code','{"blanks":[{"id":"b1"}]}','{"blanks":[{"correctAnswer":"o1"}]}','{"answer":{"b1":"o1"}}',true)->>'status','Correct','dropdown code uses presentation-owned blank identifiers');
select is(exam_delivery.score_package_v2_response_with_presentation('dropdown-command','{"blanks":[{"id":"b1"}]}','{"blanks":[{"correctAnswer":"o1"}]}','{"answer":{"b1":"x"}}',true)->>'earned','0','dropdown command incorrect response scores zero');
select is(exam_delivery.score_package_v2_response('true-false-single-v1','{"correctValue":true}','{"answer":true}',true)->>'earned','1','true/false single scores 0/1');
select is(exam_delivery.score_package_v2_response('true-false-composite-v1','{"correctValuesByStatement":{"s1":true,"s2":false}}','{"answer":{"s1":true}}',true)->>'status','Incomplete','partial composite response remains incomplete');
select is(exam_delivery.score_package_v2_response('true-false-composite-v1','{"correctValuesByStatement":{"s1":true,"s2":false}}','{"answer":{"s1":true}}',true)->>'earned','1','composite earns per-statement credit');
select is(exam_delivery.score_package_v2_response('matching-v1','{"correctTargetIdsBySource":{"s1":"t1","s2":"t2"}}','{"answer":{"s1":"t1","s2":"x"}}',true)->>'status','Partial','matching earns per-pair partial credit');
select is(exam_delivery.score_package_v2_response('code-dropdown-completion-v1','{"correctOptionIdsByBlank":{"b1":"o1","b2":"o2"},"pointsByBlank":{"b1":2,"b2":1},"maximumRawPoints":3}','{"answer":{"b1":"o1","b2":"x"}}',true)->>'earned','2','structured code dropdown honors configured blank points');
select is(exam_delivery.score_package_v2_response('pbq-map','{"strategy":"per-component-map","expectedMap":{"t1":"a1","t2":"a2"}}','{"selectedAnswers":{"t1":"a1","t2":"x"}}',true)->>'status','Partial','PBQ component map scores partial credit');
select is(exam_delivery.score_package_v2_response('pbq-order','{"strategy":"exact-ordered-sequence","expectedOrder":["a","b"]}','{"selectedOrder":["a","b"]}',true)->>'earned','2','PBQ ordered sequence scores by position');
select is(exam_delivery.score_package_v2_response('pbq-command','{"strategy":"weighted-rule-evaluation","expectedAnswer":"done","finalAnswerPoints":1,"criteria":[{"points":2,"commandIds":["run"]}]}','{"selectedAnswer":"done","executedCommands":["run"]}',true)->>'earned','3','PBQ weighted rule scorer combines final and command credit');
select is(exam_delivery.score_package_v2_response('pbq-state','{"strategy":"exact-whole-state","expectedAnswer":{"ready":true}}','{"selectedAnswer":{"ready":true}}',true)->>'status','Correct','PBQ exact whole state scores correct');
select is(exam_delivery.score_package_v2_response('single-choice','{}','{}',false)->>'status','Informational','non-scored context remains informational');

select is(exam_delivery.score_selected_response_partial('multi-select','{"requiredSelections":2,"options":[{"id":"a"},{"id":"b"},{"id":"c"}]}','{"model":"per-correct-option-no-negative-v1","correctAnswers":["a","b"],"selectionCap":2,"maximumRawPoints":2}','{"answer":["a"]}',true)->>'status','Partial','selected-response partial scorer gives bounded partial credit');
select is(exam_delivery.score_package_v2_response_for_scorer('certsim-selected-response-partial-v1','multi-select','{"requiredSelections":2,"options":[{"id":"a"},{"id":"b"},{"id":"c"}]}','{"model":"per-correct-option-no-negative-v1","correctAnswers":["a","b"],"selectionCap":2,"maximumRawPoints":2}','{"answer":["a","c"]}',true)->>'earned','1','router selects the SC-200 partial scorer');
select is(exam_delivery.score_package_v2_response_for_scorer('certsim-ai901-exact-scorer-v2','multi-select','{}','{"correctAnswers":["a","b"]}','{"answer":["a"]}',true)->>'earned','0','router preserves generic exact scoring for non-partial runtimes');
select throws_ok($$select exam_delivery.score_selected_response_partial('multi-select','{"requiredSelections":1,"options":[{"id":"a"}]}','{"model":"per-correct-option-no-negative-v1","correctAnswers":["a"],"selectionCap":1,"maximumRawPoints":1}','{"answer":["unknown"]}',true)$$,'22023','response_invalid','partial scorer rejects malformed learner input predictably');

select ok(not has_function_privilege('authenticated','exam_delivery.package_v2_response_valid(text,jsonb,jsonb)','EXECUTE'),'validator remains private from browsers');
select ok(not has_function_privilege('authenticated','exam_delivery.score_package_v2_response(text,jsonb,jsonb,boolean)','EXECUTE'),'generic scorer remains private from browsers');
select ok(not has_function_privilege('authenticated','exam_delivery.score_selected_response_partial(text,jsonb,jsonb,jsonb,boolean)','EXECUTE'),'partial scorer remains private from browsers');

select * from finish();
rollback;
