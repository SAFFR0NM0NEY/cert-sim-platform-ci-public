begin;
select plan(39);

select is((select pg_get_userbyid(proowner) from pg_proc where oid='exam_delivery.prepare_canonical_forms_on_publish()'::regprocedure),'postgres','form trigger function owner remains postgres');
select ok((select prosecdef from pg_proc where oid='exam_delivery.prepare_canonical_forms_on_publish()'::regprocedure),'form trigger function remains security definer');
select is((select provolatile::text from pg_proc where oid='exam_delivery.prepare_canonical_forms_on_publish()'::regprocedure),'v','form trigger function remains volatile');
select is((select proparallel::text from pg_proc where oid='exam_delivery.prepare_canonical_forms_on_publish()'::regprocedure),'u','form trigger function remains parallel unsafe');
select ok((select proconfig @> array['search_path=""','statement_timeout=15s'] from pg_proc where oid='exam_delivery.prepare_canonical_forms_on_publish()'::regprocedure),'form trigger remains bounded with empty search path');
select ok(has_function_privilege('postgres','exam_delivery.prepare_canonical_forms_on_publish()','execute') and not has_function_privilege('anon','exam_delivery.prepare_canonical_forms_on_publish()','execute') and not has_function_privilege('authenticated','exam_delivery.prepare_canonical_forms_on_publish()','execute') and not has_function_privilege('service_role','exam_delivery.prepare_canonical_forms_on_publish()','execute'),'form trigger ACL remains postgres-only');
select ok(exists(select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='package_versions' and t.tgname='prepare_canonical_forms_before_publish' and not t.tgisinternal),'canonical-form publication trigger remains installed');
select ok((select pg_get_functiondef('exam_delivery.prepare_canonical_forms_on_publish()'::regprocedure) ~ 'certsim-python-standard-forms-v1' and pg_get_functiondef('exam_delivery.prepare_canonical_forms_on_publish()'::regprocedure) ~ 'skillGroupTargets' and pg_get_functiondef('exam_delivery.prepare_canonical_forms_on_publish()'::regprocedure) ~ 'minimumCoverageTagCounts'),'Python dispatch and existing rich v2 validation coexist');

insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ('00000000-0000-0000-0000-000000000000','85100000-0000-0000-0000-000000000001','authenticated','authenticated','owner851@example.invalid','','{}','{}',now(),now());
update public.profiles set status='active' where id='85100000-0000-0000-0000-000000000001';
insert into public.organisations(id,name,organisation_type,status) values ('85100000-0000-0000-0000-000000000010','Issue 85 Python forms','internal','active');
insert into public.memberships(user_id,organisation_id,role,status) values ('85100000-0000-0000-0000-000000000001','85100000-0000-0000-0000-000000000010','platform_owner','active');

create function pg_temp.issue85_python_form_request(p_exam text,p_request uuid,p_fault text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  payload jsonb;
  questions jsonb := '[]'::jsonb;
  forms jsonb;
  reserves jsonb := '["q7","q8"]'::jsonb;
  first_members jsonb := '["q1","q2","q3"]'::jsonb;
  second_members jsonb := '["q4","q5","q6"]'::jsonb;
  runtime jsonb := jsonb_build_object(
    'generatorVersion','certsim-python-standard-canonical-forms-v1',
    'scorerVersion','certsim-versioned-structured-partial-v1'
  );
  form_contract jsonb;
  i integer;
  qtype text;
begin
  for i in 1..8 loop
    qtype := (array['true-false-single-v1','true-false-composite-v1','matching-v1','code-dropdown-completion-v1'])[((i-1)%4)+1];
    questions := questions || jsonb_build_array(jsonb_build_object(
      'id','q'||i,'type',qtype,'domainKey','synthetic-domain',
      'presentation',jsonb_build_object('prompt','Synthetic fixture','interactionVersion',qtype),
      'privateScoring',jsonb_build_object('maximumRawPoints',1),
      'privateReview','{}'::jsonb
    ));
  end loop;

  if p_fault='duplicate_question' then first_members := '["q1","q1","q3"]'::jsonb; end if;
  if p_fault='cross_form_duplicate' then second_members := '["q3","q5","q6"]'::jsonb; end if;
  if p_fault='missing_question' then first_members := '["q999","q2","q3"]'::jsonb; end if;
  if p_fault='reserve_overlap' then reserves := '["q1","q8"]'::jsonb; end if;
  if p_fault='incomplete_inventory' then reserves := '["q7"]'::jsonb; end if;
  if p_fault='malformed_reserve' then reserves := '["q7",1]'::jsonb; end if;

  forms := jsonb_build_array(
    jsonb_build_object('formKey','PY-F01','ordinal',1,'questionIds',first_members,'membershipHash',exam_delivery.canonical_sha256(first_members),'rawMaximum',case when p_fault='wrong_raw_maximum' then 4 else 3 end),
    jsonb_build_object('formKey',case when p_fault='duplicate_form_key' then 'PY-F01' else 'PY-F02' end,'ordinal',2,'questionIds',second_members,'membershipHash',case when p_fault='wrong_membership_hash' then repeat('0',64) else exam_delivery.canonical_sha256(second_members) end,'rawMaximum',3)
  );
  if p_fault='malformed_form' then forms := jsonb_set(forms,'{0}','"invalid"'::jsonb); end if;

  form_contract := jsonb_build_object(
    'contractVersion',case when p_fault='wrong_contract_version' then 'unsupported-forms-v1' else 'certsim-python-standard-forms-v1' end,
    'cycleLength',2,
    'reservePolicy','profile-specific-reserve',
    'reserveQuestionIds',reserves,
    'forms',forms
  );
  if p_fault='wrong_runtime' then runtime := jsonb_build_object('generatorVersion','certsim-sc200-canonical-forms-v1','scorerVersion','certsim-selected-response-partial-v1'); end if;

  payload := jsonb_build_object(
    'packageSchemaVersion','certsim-protected-package-v2',
    'validationContractVersion','certsim-protected-multi-exam-validation-v1',
    'exam',jsonb_build_object('examKey',p_exam,'packageVersion','1.0.0','capabilities',jsonb_build_array('true-false-single-v1','true-false-composite-v1','matching-v1','code-dropdown-completion-v1')),
    'source',jsonb_build_object('sourceHash',repeat('a',64),'validationHash',repeat('b',64)),
    'runtime',runtime,
    'profiles',case when p_exam='fixture85pymulti' then jsonb_build_array(
      jsonb_build_object('profileKey','python-standard','displayName','Python Standard','questionCount',3,'timeLimitMinutes',60,'selection',jsonb_build_object('canonicalForms',form_contract,'scoringContract','synthetic')),
      jsonb_build_object('profileKey','python-compact','displayName','Python Compact','questionCount',2,'timeLimitMinutes',30,'selection',jsonb_build_object('canonicalForms',jsonb_build_object(
        'contractVersion','certsim-python-standard-forms-v1','cycleLength',2,'reservePolicy','profile-specific-reserve',
        'reserveQuestionIds',jsonb_build_array('q3','q6','q7','q8'),
        'forms',jsonb_build_array(
          jsonb_build_object('formKey','PY-C01','ordinal',1,'questionIds',jsonb_build_array('q1','q2'),'membershipHash',exam_delivery.canonical_sha256(jsonb_build_array('q1','q2')),'rawMaximum',2),
          jsonb_build_object('formKey','PY-C02','ordinal',2,'questionIds',jsonb_build_array('q4','q5'),'membershipHash',exam_delivery.canonical_sha256(jsonb_build_array('q4','q5')),'rawMaximum',2)
        )
      ),'scoringContract','synthetic'))
    ) else jsonb_build_array(jsonb_build_object('profileKey','python-standard','displayName','Python Standard','questionCount',3,'timeLimitMinutes',60,'selection',jsonb_build_object('canonicalForms',form_contract,'scoringContract','synthetic'))) end,
    'questions',questions,
    'releasePolicy',jsonb_build_object('review','after_submission','answers','after_submission')
  );
  return jsonb_build_object('publicationRequestId',p_request,'sourceCommitSha',repeat('c',40),'packagePayload',payload,'packageHash',exam_delivery.canonical_sha256(payload));
end $$;

set local request.jwt.claim.sub='85100000-0000-0000-0000-000000000001';
set local role authenticated;
select lives_ok($$select public.certsim_protected_publish_package(pg_temp.issue85_python_form_request('fixture85pyok','85100000-0000-0000-0000-000000000100'))$$,'Python fixed-form package publishes through the public RPC');
reset role;

select is((select count(*)::integer from exam_delivery.package_versions where exam_key='fixture85pyok' and status='published'),1,'Python fixture reaches published state');
select is((select count(*)::integer from exam_delivery.package_forms f join exam_delivery.package_versions pv on pv.id=f.package_version_id where pv.exam_key='fixture85pyok'),2,'Python forms are materialized');
select is((select count(*)::integer from exam_delivery.package_form_questions fq join exam_delivery.package_versions pv on pv.id=fq.package_version_id where pv.exam_key='fixture85pyok'),6,'Python form memberships are materialized');
select is((select count(*)::integer from exam_delivery.package_reserve_questions r join exam_delivery.package_versions pv on pv.id=r.package_version_id where pv.exam_key='fixture85pyok'),2,'Python reserves are materialized');
select results_eq($$select declared_review_release_policy,declared_answer_release_policy from exam_delivery.package_versions where exam_key='fixture85pyok'$$,$$values ('after_submission'::text,'after_submission'::text)$$,'Python package declares after-submission review and answers');
select ok((select bool_and(not (blueprint_contract ?| array['skillGroupTargets','requiredObjectiveKeys','minimumCoverageTagCounts','difficultyRequirements'])) from exam_delivery.package_forms f join exam_delivery.package_versions pv on pv.id=f.package_version_id where pv.exam_key='fixture85pyok'),'Python blueprint metadata contains no invented rich-v2 fields');

set local role authenticated;
select lives_ok($$select public.certsim_protected_publish_package(pg_temp.issue85_python_form_request('fixture85pymulti','85100000-0000-0000-0000-000000000121'))$$,'multi-profile Python package publishes through the normal RPC');
reset role;
select is((select count(*)::integer from exam_delivery.package_profiles pp join exam_delivery.package_versions pv on pv.id=pp.package_version_id where pv.exam_key='fixture85pymulti'),2,'multi-profile Python package stores both profiles');
select is((select count(*)::integer from exam_delivery.package_forms f join exam_delivery.package_versions pv on pv.id=f.package_version_id where pv.exam_key='fixture85pymulti'),4,'multi-profile Python forms materialize independently');
select is((select count(*)::integer from exam_delivery.package_form_questions fq join exam_delivery.package_versions pv on pv.id=fq.package_version_id where pv.exam_key='fixture85pymulti'),10,'multi-profile memberships retain profile scope');
select results_eq($$select profile_key,jsonb_array_length(selection_config#>'{canonicalForms,reserveQuestionIds}') from exam_delivery.package_profiles pp join exam_delivery.package_versions pv on pv.id=pp.package_version_id where pv.exam_key='fixture85pymulti' order by profile_key$$,$$values ('python-compact'::text,4),('python-standard'::text,2)$$,'profile-specific reserves remain preserved in immutable selection contracts');
select is((select count(*)::integer from exam_delivery.package_reserve_questions r join exam_delivery.package_versions pv on pv.id=r.package_version_id where pv.exam_key='fixture85pymulti'),2,'package-global reserve contains only questions unused by every profile');

insert into exam_delivery.exam_release_candidates(
  canonical_exam_key,package_version,profile_key,release_template,
  catalogue_slug,catalogue_title,catalogue_vendor,catalogue_exam_type,catalogue_source_type
) values ('fixture85pyok','1.0.0','python-standard','standard_active_exam_v1',
  'fixture85pyok','Synthetic Python Standard','Fixture','certification','official_source');
set local role authenticated;
select lives_ok($$select public.certsim_configure_exam_release_stage(jsonb_build_object(
  'examKey','fixture85pyok','packageVersion','1.0.0','profileKey','python-standard',
  'releaseStage','standard_active_exam_v1','requestId','85100000-0000-0000-0000-000000000120'))$$,
  'Python Standard configures through the controlled release RPC');
reset role;
select is((select count(*)::integer from public.exam_catalog where exam_key='fixture85pyok' and status='active'),1,'Python Standard catalogue row is active');
select is((select count(*)::integer from exam_delivery.exam_profile_activations a join exam_delivery.package_versions pv on pv.id=a.package_version_id where pv.exam_key='fixture85pyok' and a.enabled),1,'Python Standard profile is activated once');
select is((select count(*)::integer from exam_delivery.practice_policies where canonical_exam_key='fixture85pyok' and enabled and purpose in ('self_directed_exam','study_sandbox','targeted_domain','weak_area') and purpose<>'pbq_practice'),4,'non-PBQ Python practice policies are enabled');
select is((select count(*)::integer from exam_delivery.practice_policies where canonical_exam_key='fixture85pyok' and purpose='pbq_practice'),0,'PBQ practice is not created without PBQ inventory');

select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_python_form_request('fixture85pycontract','85100000-0000-0000-0000-000000000101','wrong_contract_version'))$$,'22023',null,'unknown form contract fails closed');
select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_python_form_request('fixture85pyruntime','85100000-0000-0000-0000-000000000102','wrong_runtime'))$$,'22023',null,'Python form contract on a non-Python runtime fails');
select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_python_form_request('fixture85pymalformed','85100000-0000-0000-0000-000000000103','malformed_form'))$$,'22023',null,'malformed Python form fails');
select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_python_form_request('fixture85pyformkey','85100000-0000-0000-0000-000000000104','duplicate_form_key'))$$,'22023',null,'duplicate Python form key fails');
select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_python_form_request('fixture85pyduplicate','85100000-0000-0000-0000-000000000105','duplicate_question'))$$,'22023',null,'duplicate question within a Python form fails');
select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_python_form_request('fixture85pycross','85100000-0000-0000-0000-000000000106','cross_form_duplicate'))$$,'22023',null,'question reuse across Python forms fails');
select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_python_form_request('fixture85pyoverlap','85100000-0000-0000-0000-000000000107','reserve_overlap'))$$,'22023',null,'Python reserve and form overlap fails');
select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_python_form_request('fixture85pymissing','85100000-0000-0000-0000-000000000108','missing_question'))$$,'22023',null,'missing Python package question fails');
select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_python_form_request('fixture85pyhash','85100000-0000-0000-0000-000000000109','wrong_membership_hash'))$$,'22023',null,'incorrect Python membership hash fails');
select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_python_form_request('fixture85pymaximum','85100000-0000-0000-0000-000000000110','wrong_raw_maximum'))$$,'22023',null,'incorrect Python raw maximum fails');
select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_python_form_request('fixture85pyinventory','85100000-0000-0000-0000-000000000111','incomplete_inventory'))$$,'22023',null,'incomplete Python package inventory union fails');
select throws_ok($$select exam_delivery.publish_package_v2(pg_temp.issue85_python_form_request('fixture85pyreserve','85100000-0000-0000-0000-000000000112','malformed_reserve'))$$,'22023',null,'malformed Python reserve collection fails');
select is((select count(*)::integer from exam_delivery.package_versions where exam_key like 'fixture85py%'),2,'all failed Python publications remain atomic');

select * from finish();
rollback;
