begin;
select plan(35);

select ok(exam_delivery.package_v2_runtime_supported('certsim-ai901-weighted-generator-v2','certsim-ai901-exact-scorer-v2',null),'AI-901 NULL runtime remains supported');
select ok(exam_delivery.package_v2_runtime_supported('certsim-ai901-weighted-generator-v2','certsim-ai901-exact-scorer-v2','certsim-protected-pbq-runtime-v1'),'AI-901 protected PBQ runtime truth table remains supported');
select ok(exam_delivery.package_v2_runtime_supported('certsim-az204-grouped-generator-v1','certsim-az204-exact-scorer-v1',null),'AZ-204 runtime remains supported');
select ok(exam_delivery.package_v2_runtime_supported('certsim-security-plus-pbq-first-generator-v1','certsim-security-plus-authoritative-pbq-scorer-v1','certsim-protected-pbq-runtime-v1'),'Security+ runtime remains supported');
select ok(exam_delivery.package_v2_runtime_supported('certsim-az400-case-workspace-generator-v1','certsim-az400-authoritative-scorer-v1','certsim-protected-pbq-runtime-v1'),'AZ-400 runtime remains supported');
select ok(exam_delivery.package_v2_runtime_supported('certsim-sc200-canonical-forms-v1','certsim-selected-response-partial-v1',null),'SC-200 runtime remains supported');
select ok(exam_delivery.package_v2_runtime_supported('certsim-python-standard-canonical-forms-v1','certsim-versioned-structured-partial-v1',null),'Python Standard NULL runtime is supported');
select ok(not exam_delivery.package_v2_runtime_supported('certsim-python-standard-canonical-forms-v1','certsim-versioned-structured-partial-v1','certsim-protected-pbq-runtime-v1'),'Python Standard cannot claim protected PBQ runtime');
select ok(not exam_delivery.package_v2_runtime_supported('certsim-python-standard-canonical-forms-v1','certsim-versioned-structured-partial-v1','synthetic-runtime'),'Python Standard rejects arbitrary runtime');
select ok(not exam_delivery.package_v2_runtime_supported('certsim-python-standard-canonical-forms-v1','certsim-selected-response-partial-v1',null),'Python generator rejects wrong scorer');
select ok(not exam_delivery.package_v2_runtime_supported('certsim-sc200-canonical-forms-v1','certsim-versioned-structured-partial-v1',null),'Python scorer rejects wrong generator');
select ok(not exam_delivery.package_v2_runtime_supported('synthetic-generator','synthetic-scorer',null),'unknown runtime tuple remains rejected');

select is((select pg_get_userbyid(proowner) from pg_proc where oid='exam_delivery.package_v2_runtime_supported(text,text,text)'::regprocedure),'postgres','runtime registry owner is postgres');
select ok(not (select prosecdef from pg_proc where oid='exam_delivery.package_v2_runtime_supported(text,text,text)'::regprocedure),'runtime registry is invoker');
select is((select provolatile::text from pg_proc where oid='exam_delivery.package_v2_runtime_supported(text,text,text)'::regprocedure),'i','runtime registry is immutable');
select is((select proparallel::text from pg_proc where oid='exam_delivery.package_v2_runtime_supported(text,text,text)'::regprocedure),'u','runtime registry remains parallel unsafe');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid='exam_delivery.package_v2_runtime_supported(text,text,text)'::regprocedure),'runtime registry search path is empty');
select ok(has_function_privilege('postgres','exam_delivery.package_v2_runtime_supported(text,text,text)','execute') and not has_function_privilege('anon','exam_delivery.package_v2_runtime_supported(text,text,text)','execute') and not has_function_privilege('authenticated','exam_delivery.package_v2_runtime_supported(text,text,text)','execute') and not has_function_privilege('service_role','exam_delivery.package_v2_runtime_supported(text,text,text)','execute'),'runtime registry ACL is exact');

select is((select pg_get_userbyid(proowner) from pg_proc where oid='exam_delivery.publish_package_v2(jsonb)'::regprocedure),'postgres','publisher owner is postgres');
select ok((select prosecdef from pg_proc where oid='exam_delivery.publish_package_v2(jsonb)'::regprocedure),'publisher remains definer');
select is((select provolatile::text from pg_proc where oid='exam_delivery.publish_package_v2(jsonb)'::regprocedure),'v','publisher remains volatile');
select ok((select proconfig @> array['search_path=""','statement_timeout=15s'] from pg_proc where oid='exam_delivery.publish_package_v2(jsonb)'::regprocedure),'publisher remains bounded with empty search path');
select ok(has_function_privilege('postgres','exam_delivery.publish_package_v2(jsonb)','execute') and has_function_privilege('authenticated','exam_delivery.publish_package_v2(jsonb)','execute') and not has_function_privilege('anon','exam_delivery.publish_package_v2(jsonb)','execute') and not has_function_privilege('service_role','exam_delivery.publish_package_v2(jsonb)','execute'),'publisher ACL is exact');

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('00000000-0000-0000-0000-000000000000','85000000-0000-0000-0000-000000000001','authenticated','authenticated','owner85@example.invalid','','{}','{}',now(),now()),
('00000000-0000-0000-0000-000000000000','85000000-0000-0000-0000-000000000002','authenticated','authenticated','learner85@example.invalid','','{}','{}',now(),now());
update public.profiles set status='active' where id::text like '85000000-%';
insert into public.organisations(id,name,organisation_type,status) values ('85000000-0000-0000-0000-000000000010','Issue 85 fixture','internal','active');
insert into public.memberships(user_id,organisation_id,role,status) values
('85000000-0000-0000-0000-000000000001','85000000-0000-0000-0000-000000000010','platform_owner','active'),
('85000000-0000-0000-0000-000000000002','85000000-0000-0000-0000-000000000010','student','active');

create function pg_temp.issue85_request(p_exam text,p_request uuid,p_capabilities jsonb,p_generator text default 'certsim-python-standard-canonical-forms-v1',p_scorer text default 'certsim-versioned-structured-partial-v1',p_pbq text default null,p_profile_count integer default 4,p_unsafe boolean default false)
returns jsonb language plpgsql as $$
declare payload jsonb;
begin
  payload:=jsonb_build_object(
    'packageSchemaVersion','certsim-protected-package-v2','validationContractVersion','certsim-protected-multi-exam-validation-v1',
    'exam',jsonb_build_object('examKey',p_exam,'packageVersion','1.0.0','capabilities',p_capabilities),
    'source',jsonb_build_object('sourceHash',repeat('a',64),'validationHash',repeat('b',64)),
    'runtime',jsonb_strip_nulls(jsonb_build_object('generatorVersion',p_generator,'scorerVersion',p_scorer,'pbqRuntimeVersion',p_pbq)),
    'profiles',jsonb_build_array(jsonb_build_object('profileKey','fixture','displayName','Fixture','questionCount',p_profile_count,'timeLimitMinutes',60,'selection','{}'::jsonb)),
    'questions',jsonb_build_array(
      jsonb_build_object('id','q1','type','true-false-single-v1','domainKey','d1','presentation',case when p_unsafe then '{"prompt":"Synthetic","correctAnswer":true}'::jsonb else '{"prompt":"Synthetic","statements":[]}'::jsonb end,'privateScoring','{"correctValue":true}'::jsonb,'privateReview','{}'::jsonb),
      jsonb_build_object('id','q2','type','true-false-composite-v1','domainKey','d1','presentation','{"prompt":"Synthetic","statements":[{"id":"s1","text":"Synthetic"}]}'::jsonb,'privateScoring','{"correctValuesByStatement":{"s1":true}}'::jsonb,'privateReview','{}'::jsonb),
      jsonb_build_object('id','q3','type','matching-v1','domainKey','d1','presentation','{"prompt":"Synthetic","sources":[{"id":"s1","text":"Synthetic"}],"targets":[{"id":"t1","text":"Synthetic"}]}'::jsonb,'privateScoring','{"correctTargetIdsBySource":{"s1":"t1"}}'::jsonb,'privateReview','{}'::jsonb),
      jsonb_build_object('id','q4','type','code-dropdown-completion-v1','domainKey','d1','presentation','{"prompt":"Synthetic","blanks":[{"id":"b1","label":"Synthetic","options":[{"id":"o1","text":"Synthetic"}]}]}'::jsonb,'privateScoring','{"correctOptionIdsByBlank":{"b1":"o1"},"maximumRawPoints":1}'::jsonb,'privateReview','{}'::jsonb)
    ),
    'releasePolicy',jsonb_build_object('review','after_submission','answers','after_submission')
  );
  return jsonb_build_object('publicationRequestId',p_request,'sourceCommitSha',repeat('c',40),'packagePayload',payload,'packageHash',exam_delivery.canonical_sha256(payload));
end $$;

set local request.jwt.claim.sub='85000000-0000-0000-0000-000000000001';
select lives_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_request('fixture85ok','85000000-0000-0000-0000-000000000100','["true-false-single-v1","true-false-composite-v1","matching-v1","code-dropdown-completion-v1"]'))$$,'synthetic Python package with all structured capabilities publishes');
select is((select count(*)::integer from exam_delivery.package_versions where exam_key='fixture85ok' and status='published'),1,'successful fixture is atomically published');
select is((select count(*)::integer from exam_delivery.package_questions q join exam_delivery.package_versions p on p.id=q.package_version_id where p.exam_key='fixture85ok'),4,'all synthetic questions publish');

select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_request('fixture85unknown','85000000-0000-0000-0000-000000000101','["true-false-single-v1","true-false-composite-v1","matching-v1","code-dropdown-completion-v1","synthetic-unsupported"]'))$$,'22023','publication_contract_unsupported','unsupported capability is rejected');
select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_request('fixture85duplicate','85000000-0000-0000-0000-000000000102','["true-false-single-v1","true-false-single-v1","true-false-composite-v1","matching-v1","code-dropdown-completion-v1"]'))$$,'22023','publication_contract_unsupported','duplicate capability is rejected');
select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_request('fixture85pbq','85000000-0000-0000-0000-000000000103','["true-false-single-v1","true-false-composite-v1","matching-v1","code-dropdown-completion-v1"]','certsim-python-standard-canonical-forms-v1','certsim-versioned-structured-partial-v1','certsim-protected-pbq-runtime-v1'))$$,'22023','publication_contract_unsupported','Python protected PBQ runtime is rejected');
select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_request('fixture85runtime','85000000-0000-0000-0000-000000000104','["true-false-single-v1","true-false-composite-v1","matching-v1","code-dropdown-completion-v1"]','certsim-python-standard-canonical-forms-v1','certsim-selected-response-partial-v1'))$$,'22023','publication_contract_unsupported','mismatched Python runtime is rejected');
select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_request('fixture85profile','85000000-0000-0000-0000-000000000105','["true-false-single-v1","true-false-composite-v1","matching-v1","code-dropdown-completion-v1"]','certsim-python-standard-canonical-forms-v1','certsim-versioned-structured-partial-v1',null,0))$$,'22023','publication_contract_unsupported','malformed profile is rejected');
select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_request('fixture85unsafe','85000000-0000-0000-0000-000000000106','["true-false-single-v1","true-false-composite-v1","matching-v1","code-dropdown-completion-v1"]','certsim-python-standard-canonical-forms-v1','certsim-versioned-structured-partial-v1',null,4,true))$$,'22023','publication_question_invalid','unsafe presentation is rejected');
select is((select count(*)::integer from exam_delivery.package_versions where exam_key like 'fixture85%' and exam_key<>'fixture85ok'),0,'all failed publications remain atomic');

set local request.jwt.claim.sub='85000000-0000-0000-0000-000000000002';
select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_request('fixture85forbidden','85000000-0000-0000-0000-000000000107','["true-false-single-v1","true-false-composite-v1","matching-v1","code-dropdown-completion-v1"]'))$$,'42501','publication_forbidden','non-platform-owner is denied');

set local role anon;
select throws_ok($$select public.certsim_protected_publish_package('{}'::jsonb)$$,'42501',null,'anon publication execution is denied');
reset role;

select * from finish();
rollback;
