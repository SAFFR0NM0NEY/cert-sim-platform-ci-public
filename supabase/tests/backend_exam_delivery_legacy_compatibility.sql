begin;
select plan(16);

select has_function('exam_delivery','classify_legacy_result',array['text','text','jsonb','jsonb','text','timestamp with time zone','numeric','numeric'],'legacy classifier exists');
select is(exam_delivery.classify_legacy_result('strict-beta-compact',null,'{}','{}','submitted',now(),35,70),'self_directed_exam','formal historical profile is an assessment');
select is(exam_delivery.classify_legacy_result(null,null,'{}','{"purpose":"assigned_assessment"}','submitted',now(),35,70),'assigned_assessment','explicit assessment purpose is preserved');
select is(exam_delivery.classify_legacy_result('weak-area-focus',null,'{}','{}','submitted',now(),8,80),'weak_area','weak-area history remains practice');
select is(exam_delivery.classify_legacy_result(null,'Study Sandbox','{}','{}','submitted',now(),8,80),'study_sandbox','sandbox remains excluded practice');
select is(exam_delivery.classify_legacy_result(null,'Targeted Practice','{}','{}','submitted',now(),8,80),'targeted_domain','targeted practice remains excluded practice');
select is(exam_delivery.classify_legacy_result(null,'PBQ Preview','{}','{}','submitted',now(),8,80),'pbq_practice','PBQ preview remains excluded practice');
select is(exam_delivery.classify_legacy_result(null,'Case Study Preview','{}','{}','submitted',now(),8,80),'study_sandbox','case preview remains excluded practice');
select is(exam_delivery.classify_legacy_result(null,null,'{}','{}','submitted',now(),35,70),'unclassified','insufficient evidence remains unclassified');
select is(exam_delivery.classify_legacy_result('strict-beta-compact',null,'{}','{}','in_progress',null,35,70),'unclassified','unfinished legacy activity is not promoted');
select is(exam_delivery.classify_legacy_result('strict-beta-compact',null,'{}','{}','submitted',now(),null,null),'unclassified','missing score evidence is not promoted');
select ok(not has_function_privilege('anon','exam_delivery.classify_legacy_result(text,text,jsonb,jsonb,text,timestamptz,numeric,numeric)','EXECUTE') and not has_function_privilege('authenticated','exam_delivery.classify_legacy_result(text,text,jsonb,jsonb,text,timestamptz,numeric,numeric)','EXECUTE') and not has_function_privilege('service_role','exam_delivery.classify_legacy_result(text,text,jsonb,jsonb,text,timestamptz,numeric,numeric)','EXECUTE'),'classifier is internal-only');
select ok(has_function_privilege('service_role','exam_delivery.list_history(uuid,text,text,integer)','EXECUTE') and not has_function_privilege('authenticated','exam_delivery.list_history(uuid,text,text,integer)','EXECUTE'),'history remains behind the Edge service boundary');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=8s'] from pg_proc where oid='exam_delivery.list_history(uuid,text,text,integer)'::regprocedure),'learner history remains bounded definer code');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=10s'] from pg_proc where oid='exam_delivery.list_staff_history(uuid,text,integer)'::regprocedure),'staff history remains bounded definer code');
select ok((select pg_get_functiondef('exam_delivery.list_history(uuid,text,text,integer)'::regprocedure) ~ 'a.user_id=p_actor_id' and pg_get_functiondef('exam_delivery.list_history(uuid,text,text,integer)'::regprocedure) ~ 'r.user_id=p_actor_id'),'learner history retains exact attempt and result ownership filters');

select * from finish();
rollback;
