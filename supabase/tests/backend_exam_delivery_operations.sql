begin;
create extension if not exists pgtap with schema extensions;
select plan(51);

select has_function('public','certsim_protected_check_eligibility',array['uuid','text','text'],'eligibility wrapper exists');
select has_function('public','certsim_protected_start_attempt',array['uuid','text','text','uuid'],'start wrapper exists');
select has_function('public','certsim_protected_resume_attempt',array['uuid','uuid'],'resume wrapper exists');
select has_function('public','certsim_protected_save_response',array['uuid','uuid','uuid','jsonb','integer','uuid'],'save wrapper exists');
select has_function('public','certsim_protected_submit_attempt',array['uuid','uuid','uuid'],'submit wrapper exists');
select has_function('public','certsim_protected_get_result',array['uuid','uuid'],'result wrapper exists');
select has_function('public','certsim_protected_get_review',array['uuid','uuid'],'review wrapper exists');

select ok(not has_function_privilege('anon','public.certsim_protected_start_attempt(uuid,text,text,uuid)','EXECUTE'),'anon cannot start');
select ok(not has_function_privilege('authenticated','public.certsim_protected_start_attempt(uuid,text,text,uuid)','EXECUTE'),'authenticated cannot start');
select ok(not has_function_privilege('public','public.certsim_protected_start_attempt(uuid,text,text,uuid)','EXECUTE'),'PUBLIC cannot start');
select ok(has_function_privilege('service_role','public.certsim_protected_start_attempt(uuid,text,text,uuid)','EXECUTE'),'service_role can execute start wrapper');
select ok(not has_table_privilege('service_role','exam_delivery.attempts','SELECT,INSERT,UPDATE,DELETE'),'service_role has no direct attempt table access');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'certsim_protected_%' and p.prosecdef),0,'no public wrapper is SECURITY DEFINER');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'certsim_protected_%' and not (p.proconfig @> array['search_path=""'])),0,'all wrappers use empty search_path');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.prosecdef and not (p.proconfig @> array['search_path=""'])),0,'all private definers use empty search_path');
select ok(not has_function_privilege('authenticated','exam_delivery.submit_attempt(uuid,uuid,uuid)','EXECUTE'),'browser role cannot execute private submit');
select ok(not has_schema_privilege('authenticated','exam_delivery','USAGE'),'authenticated cannot use private schema');

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','11000000-0000-0000-0000-000000000001','authenticated','authenticated','eligible@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','11000000-0000-0000-0000-000000000002','authenticated','authenticated','other@example.invalid','','{}','{}',now(),now());
update public.profiles set status='active' where id in ('11000000-0000-0000-0000-000000000001','11000000-0000-0000-0000-000000000002');
insert into public.organisations(id,name,organisation_type,status) values('12000000-0000-0000-0000-000000000001','Synthetic Org','training_provider','active');
insert into public.campuses(id,organisation_id,name,code,status) values('12000000-0000-0000-0000-000000000002','12000000-0000-0000-0000-000000000001','Synthetic Campus','SYN','active');
insert into public."groups"(id,organisation_id,campus_id,name,status) values('12000000-0000-0000-0000-000000000003','12000000-0000-0000-0000-000000000001','12000000-0000-0000-0000-000000000002','Synthetic Group','active');
insert into public.memberships(user_id,organisation_id,campus_id,group_id,role,status) values
('11000000-0000-0000-0000-000000000001','12000000-0000-0000-0000-000000000001','12000000-0000-0000-0000-000000000002','12000000-0000-0000-0000-000000000003','student','active'),
('11000000-0000-0000-0000-000000000002','12000000-0000-0000-0000-000000000001','12000000-0000-0000-0000-000000000002','12000000-0000-0000-0000-000000000003','student','active');
insert into public.exam_assignments(organisation_id,campus_id,group_id,exam_key,profile_id,title,status,available_from,due_at) values
('12000000-0000-0000-0000-000000000001','12000000-0000-0000-0000-000000000002','12000000-0000-0000-0000-000000000003','ai-901','synthetic-six','Synthetic assignment','active',now()-interval '1 hour',now()+interval '1 day');

insert into exam_delivery.package_versions(id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,package_schema_version,generator_version,scorer_version) values
('13000000-0000-0000-0000-000000000001','ai-901','1.0.0','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','certsim-protected-package-v1','test-generator','test-scorer');
insert into exam_delivery.package_profiles(id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config) values
('13000000-0000-0000-0000-000000000002','13000000-0000-0000-0000-000000000001','synthetic-six','Synthetic six types',6,30,'{"domainDistribution":{"synthetic":6},"scoringContract":{"scoreScale":{"min":0,"max":1000,"pass":700}}}');

insert into exam_delivery.package_questions(id,package_version_id,question_id,question_type,domain_key,section_key,source_ordinal,presentation_payload,content_hash) values
('14000000-0000-0000-0000-000000000001','13000000-0000-0000-0000-000000000001','synthetic-single','single-choice','synthetic','skill',1,'{"prompt":"Single","options":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}','0000000000000000000000000000000000000000000000000000000000000001'),
('14000000-0000-0000-0000-000000000002','13000000-0000-0000-0000-000000000001','synthetic-multi','multi-select','synthetic','skill',2,'{"prompt":"Multi","options":[{"id":"a","text":"A"},{"id":"b","text":"B"},{"id":"c","text":"C"}]}','0000000000000000000000000000000000000000000000000000000000000002'),
('14000000-0000-0000-0000-000000000003','13000000-0000-0000-0000-000000000001','synthetic-order','reorder','synthetic','skill',3,'{"prompt":"Order","items":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}','0000000000000000000000000000000000000000000000000000000000000003'),
('14000000-0000-0000-0000-000000000004','13000000-0000-0000-0000-000000000001','synthetic-match','drag-drop-match','synthetic','skill',4,'{"prompt":"Match","prompts":[{"id":"p","text":"P"}],"options":[{"id":"a","text":"A"}]}','0000000000000000000000000000000000000000000000000000000000000004'),
('14000000-0000-0000-0000-000000000005','13000000-0000-0000-0000-000000000001','synthetic-code','dropdown-code','synthetic','skill',5,'{"prompt":"Code","template":"x","blanks":[{"id":"x","label":"X","options":[{"id":"x-option-1","text":"A"}]}]}','0000000000000000000000000000000000000000000000000000000000000005'),
('14000000-0000-0000-0000-000000000006','13000000-0000-0000-0000-000000000001','synthetic-command','dropdown-command','synthetic','skill',6,'{"prompt":"Command","template":"x","blanks":[{"id":"x","label":"X","options":[{"id":"x-option-1","text":"A"}]}]}','0000000000000000000000000000000000000000000000000000000000000006');
insert into exam_delivery.package_question_protected_content(question_id,package_version_id,scoring_payload,review_payload) values
('14000000-0000-0000-0000-000000000001','13000000-0000-0000-0000-000000000001','{"model":"exact-single","correctOptionId":"a","maxPoints":1}','{"explanation":"E","remediation":"R"}'),
('14000000-0000-0000-0000-000000000002','13000000-0000-0000-0000-000000000001','{"model":"exact-set","correctOptionIds":["a","b"],"requiredSelectionCount":2,"maxPoints":1}','{"explanation":"E","remediation":"R"}'),
('14000000-0000-0000-0000-000000000003','13000000-0000-0000-0000-000000000001','{"model":"exact-order","correctItemIds":["a","b"],"maxPoints":1}','{"explanation":"E","remediation":"R"}'),
('14000000-0000-0000-0000-000000000004','13000000-0000-0000-0000-000000000001','{"model":"exact-pairs","correctPairs":{"p":"a"},"maxPoints":1}','{"explanation":"E","remediation":"R"}'),
('14000000-0000-0000-0000-000000000005','13000000-0000-0000-0000-000000000001','{"model":"exact-dropdowns","correctOptionIdsByBlank":{"x":"x-option-1"},"maxPoints":1}','{"explanation":"E","remediation":"R"}'),
('14000000-0000-0000-0000-000000000006','13000000-0000-0000-0000-000000000001','{"model":"exact-dropdowns","correctOptionIdsByBlank":{"x":"x-option-1"},"maxPoints":1}','{"explanation":"E","remediation":"R"}');
update exam_delivery.package_versions set status='published',published_at=now() where id='13000000-0000-0000-0000-000000000001';

select is((exam_delivery.check_eligibility('11000000-0000-0000-0000-000000000001','ai-901','synthetic-six')->>'reasonCode'),'pilot_disabled','disabled gate blocks eligibility');
update exam_delivery.pilot_gates set enabled=true,enabled_at=now(),disabled_at=null where exam_key='ai-901';
select is((exam_delivery.check_eligibility('11000000-0000-0000-0000-000000000001','ai-901','synthetic-six')->>'reasonCode'),'not_allowlisted','allowlist required');
insert into exam_delivery.pilot_access(user_id,exam_key,enabled,access_starts_at,access_ends_at) values('11000000-0000-0000-0000-000000000001','ai-901',true,now()-interval '1 hour',now()+interval '1 day');
select is((exam_delivery.check_eligibility('11000000-0000-0000-0000-000000000001','ai-901','synthetic-six')->>'reasonCode'),'eligible','fully eligible user passes');
select is((exam_delivery.check_eligibility('11000000-0000-0000-0000-000000000002','ai-901','synthetic-six')->>'reasonCode'),'not_allowlisted','other user denied');
select is((exam_delivery.check_eligibility('11000000-0000-0000-0000-000000000001','ai-901','wrong')->>'reasonCode'),'not_assigned','profile mismatch denied');

select is((exam_delivery.start_attempt('11000000-0000-0000-0000-000000000001','ai-901','synthetic-six','15000000-0000-0000-0000-000000000001')->>'ok')::boolean,true,'start succeeds');
select is((select count(*)::integer from exam_delivery.attempt_items),6,'all six type items selected');
select is((select count(*)::integer from exam_delivery.attempt_item_protected_content),6,'protected snapshots separated');
select is((exam_delivery.start_attempt('11000000-0000-0000-0000-000000000001','ai-901','synthetic-six','15000000-0000-0000-0000-000000000001')->>'ok')::boolean,true,'identical start replay returns attempt');
select is((exam_delivery.start_attempt('11000000-0000-0000-0000-000000000001','ai-901','synthetic-six','15000000-0000-0000-0000-000000000002')->>'code'),'active_attempt_exists','second active attempt rejected');
select is((exam_delivery.resume_attempt('11000000-0000-0000-0000-000000000002',(select id from exam_delivery.attempts limit 1))->>'code'),'attempt_not_found','unowned resume is indistinguishable');
select is(jsonb_array_length(exam_delivery.resume_attempt('11000000-0000-0000-0000-000000000001',(select id from exam_delivery.attempts limit 1))->'items'),6,'resume preserves six items');
select ok((exam_delivery.resume_attempt('11000000-0000-0000-0000-000000000001',(select id from exam_delivery.attempts limit 1))::text !~* 'correctOption|explanation|remediation'),'resume leaks no protected fields');

select is(exam_delivery.score_response('{"model":"exact-single","correctOptionId":"a"}','{"answer":"a"}'),1::numeric,'single scoring parity');
select is(exam_delivery.score_response('{"model":"exact-set","correctOptionIds":["a","b"]}','{"answer":["b","a"]}'),1::numeric,'set scoring ignores order');
select is(exam_delivery.score_response('{"model":"exact-order","correctItemIds":["a","b"]}','{"answer":["b","a"]}'),0::numeric,'ordering scoring requires order');
select is(exam_delivery.score_response('{"model":"exact-pairs","correctPairs":{"p":"a"}}','{"answer":{"p":"a"}}'),1::numeric,'matching scoring parity');
select is(exam_delivery.score_response('{"model":"exact-dropdowns","correctOptionIdsByBlank":{"x":"a"}}','{"answer":{"x":"a"}}'),1::numeric,'dropdown scoring parity');
select ok(not exam_delivery.validate_response('single-choice','{"answer":[]}'),'malformed response rejected');

select is((exam_delivery.save_response('11000000-0000-0000-0000-000000000001',(select id from exam_delivery.attempts limit 1),(select i.id from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id where q.question_type='single-choice'),'{"answer":"a"}',0,'16000000-0000-0000-0000-000000000001')->>'revision')::integer,1,'response save increments revision');
select is((exam_delivery.save_response('11000000-0000-0000-0000-000000000001',(select id from exam_delivery.attempts limit 1),(select i.id from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id where q.question_type='single-choice'),'{"answer":"a"}',0,'16000000-0000-0000-0000-000000000001')->>'revision')::integer,1,'response replay is idempotent');
select is((exam_delivery.save_response('11000000-0000-0000-0000-000000000001',(select id from exam_delivery.attempts limit 1),(select i.id from exam_delivery.attempt_items i join exam_delivery.package_questions q on q.id=i.package_question_id where q.question_type='single-choice'),'{"answer":"b"}',0,'16000000-0000-0000-0000-000000000002')->>'code'),'stale_response','stale revision rejected');

update exam_delivery.pilot_gates set enabled=false,enabled_at=null where exam_key='ai-901';
select is((exam_delivery.resume_attempt('11000000-0000-0000-0000-000000000001',(select id from exam_delivery.attempts limit 1))->>'code'),'pilot_unavailable','disabled gate freezes resume');
select is((exam_delivery.save_response('11000000-0000-0000-0000-000000000001',(select id from exam_delivery.attempts limit 1),(select i.id from exam_delivery.attempt_items i limit 1),'{"answer":"a"}',0,'16000000-0000-0000-0000-000000000003')->>'code'),'pilot_unavailable','disabled gate freezes response saves');
update exam_delivery.pilot_gates set enabled=true,enabled_at=now(),disabled_at=null where exam_key='ai-901';

select is((exam_delivery.submit_attempt('11000000-0000-0000-0000-000000000001',(select id from exam_delivery.attempts limit 1),'17000000-0000-0000-0000-000000000001')->>'ok')::boolean,true,'submission succeeds atomically');
select is((select status::text from exam_delivery.attempts limit 1),'completed','submission completes attempt');
select is((select release_status::text from exam_delivery.review_snapshots limit 1),'withheld','review remains withheld');
select is((exam_delivery.submit_attempt('11000000-0000-0000-0000-000000000001',(select id from exam_delivery.attempts limit 1),'17000000-0000-0000-0000-000000000001')->>'ok')::boolean,true,'submission replay returns result');
select is((exam_delivery.submit_attempt('11000000-0000-0000-0000-000000000001',(select id from exam_delivery.attempts limit 1),'17000000-0000-0000-0000-000000000002')->>'code'),'submission_conflict','conflicting submission rejected');
select is((exam_delivery.get_review('11000000-0000-0000-0000-000000000001',(select id from exam_delivery.attempts limit 1))->>'code'),'review_unavailable','withheld review unavailable');
update exam_delivery.review_snapshots
set release_status='released', released_at=greatest(created_at, clock_timestamp())
where attempt_id=(select id from exam_delivery.attempts limit 1);
select is((exam_delivery.get_review('11000000-0000-0000-0000-000000000001',(select id from exam_delivery.attempts limit 1))->>'ok')::boolean,true,'released review is readable by owner');
select is((select count(*)::integer from public.exam_attempts where id=(select id from exam_delivery.attempts limit 1)),1,'public attempt projection exists');
select is((select count(*)::integer from public.exam_results where attempt_id=(select id from exam_delivery.attempts limit 1)),1,'public result projection exists');
select ok((select (attempt_snapshot||presented_order_snapshot)::text !~* 'correctOption|explanation|remediation|scoring|packageHash' from public.exam_attempts limit 1),'public projection excludes protected keys');

select * from finish();
rollback;
