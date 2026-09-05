begin;
select plan(41);

select has_table('exam_delivery','package_forms','private canonical form table exists');
select has_table('exam_delivery','package_form_questions','private canonical membership table exists');
select has_table('exam_delivery','package_reserve_questions','private reserve table exists');
select has_column('exam_delivery','attempts','canonical_form_id','attempt stores immutable form identity');
select has_column('exam_delivery','attempts','canonical_form_cycle','attempt stores immutable form cycle');
select has_column('exam_delivery','package_versions','declared_review_release_policy','package stores declared review release');
select has_column('exam_delivery','package_versions','declared_answer_release_policy','package stores declared answer release');
select has_function('exam_delivery','prepare_canonical_forms_on_publish',array[]::text[]);
select has_function('exam_delivery','allocate_canonical_form',array['uuid']);
select has_function('exam_delivery','materialize_attempt_items_issue21_unrotated_base',array['uuid','uuid','integer']);
select has_function('exam_delivery','materialize_attempt_items',array['uuid','uuid','integer']);
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='package_forms'),'form RLS enabled');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='package_form_questions'),'membership RLS enabled');
select ok((select relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='package_reserve_questions'),'reserve RLS enabled');
select ok(not has_table_privilege('authenticated','exam_delivery.package_forms','SELECT'),'authenticated cannot read form definitions');
select ok(not has_table_privilege('authenticated','exam_delivery.package_form_questions','SELECT'),'authenticated cannot read membership');
select ok(not has_table_privilege('authenticated','exam_delivery.package_reserve_questions','SELECT'),'authenticated cannot read reserve membership');
select ok(not has_table_privilege('anon','exam_delivery.package_forms','SELECT'),'anonymous cannot read form definitions');
select ok(not has_table_privilege('service_role','exam_delivery.package_form_questions','SELECT'),'service role has no direct membership access');
select ok(not has_function_privilege('authenticated','exam_delivery.allocate_canonical_form(uuid)','EXECUTE'),'browser cannot allocate a form');
select ok(not has_function_privilege('service_role','exam_delivery.allocate_canonical_form(uuid)','EXECUTE'),'Edge cannot select a trusted form directly');
select is((select count(*)::integer from pg_policies where schemaname='exam_delivery' and tablename in ('package_forms','package_form_questions','package_reserve_questions')),0,'private canonical tables expose no browser RLS policy');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.package_forms'::regclass and contype='f' and pg_get_constraintdef(oid) ~ 'package_profile_id, package_version_id'),'form profile is constrained to the same package version');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.package_form_questions'::regclass and contype='f' and pg_get_constraintdef(oid) ~ 'form_id, package_profile_id, package_version_id'),'membership form/profile/version is constrained as one package identity');
select ok((select count(*)>=2 from pg_constraint where conrelid in ('exam_delivery.package_form_questions'::regclass,'exam_delivery.package_reserve_questions'::regclass) and contype='f' and pg_get_constraintdef(oid) ~ 'package_question_id, package_version_id'),'formal and reserve questions are constrained to the same package version');
select ok(exists(select 1 from pg_constraint where conrelid='exam_delivery.package_form_questions'::regclass and contype='u' and pg_get_constraintdef(oid) ~ 'package_profile_id, package_question_id'),'a question cannot occupy two forms in one profile');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=5s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='allocate_canonical_form'),'allocator is bounded and search-path safe');
select ok((select prosecdef and proconfig @> array['search_path=""','statement_timeout=15s'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='materialize_attempt_items'),'materializer is bounded and search-path safe');
select ok((select pg_get_functiondef(p.oid) ~ 'pg_advisory_xact_lock' and pg_get_functiondef(p.oid) ~ 'owner_id.*package_version_id.*package_profile_id' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='allocate_canonical_form'),'allocator serializes learner/package/profile cycle');
select ok((select pg_get_functiondef(p.oid) ~ 'purpose not in.*assigned_assessment.*self_directed_exam' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='allocate_canonical_form'),'practice purposes do not consume formal forms');
select ok((select pg_get_functiondef(p.oid) ~ 'materialize_attempt_items_issue21_unrotated_base' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='materialize_attempt_items'),'packages without forms preserve legacy materialization');
select ok((select pg_get_functiondef(p.oid) ~ 'canonical_form_runtime_validation_failed' and pg_get_functiondef(p.oid) ~ 'skillGroupTargets' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='materialize_attempt_items'),'formal materialization fails closed on generic count and blueprint drift');
select ok((select pg_get_functiondef(p.oid) !~* 'ai901|foundry|concepts|ai901Subskill' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='prepare_canonical_forms_on_publish'),'publication runtime contains no exam-specific identifiers');
select ok((select pg_get_functiondef(p.oid) ~ 'requiredObjectiveKeys' and pg_get_functiondef(p.oid) ~ 'minimumCoverageTagCounts' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='prepare_canonical_forms_on_publish'),'publication validates generic objectives and coverage tags');
select ok(exists(select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='attempts' and t.tgname='guard_attempt_form_assignment' and not t.tgisinternal),'attempt form assignment is immutable');
select ok(exists(select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='package_versions' and t.tgname='prepare_canonical_forms_before_publish' and not t.tgisinternal),'publication persists validated forms atomically');
select ok(exists(select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relname='practice_policies' and t.tgname='guard_declared_self_directed_release_policy' and not t.tgisinternal),'self-directed release policy follows immutable package declaration');
select ok(
  (select pg_get_functiondef(p.oid) ~ 'self_directed_release_policy_conflicts_with_package' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='guard_declared_self_directed_release_policy')
  and (select pg_get_functiondef(p.oid) ~ 'after_submission' from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proname='prepare_canonical_forms_on_publish'),
  'publication requires after-submission and policy guard rejects declaration drift'
);

insert into exam_delivery.package_versions(id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,package_schema_version,generator_version,scorer_version)
values
  ('21000000-0000-0000-0000-000000000001','issue21a','1.0.0',repeat('a',40),repeat('b',64),repeat('c',64),'synthetic','synthetic','synthetic'),
  ('21000000-0000-0000-0000-000000000002','issue21b','1.0.0',repeat('d',40),repeat('e',64),repeat('f',64),'synthetic','synthetic','synthetic');
insert into exam_delivery.package_profiles(id,package_version_id,profile_key,display_name,question_count,time_limit_minutes)
values
  ('21000000-0000-0000-0000-000000000011','21000000-0000-0000-0000-000000000001','full','Full',1,10),
  ('21000000-0000-0000-0000-000000000012','21000000-0000-0000-0000-000000000001','compact','Compact',1,10),
  ('21000000-0000-0000-0000-000000000013','21000000-0000-0000-0000-000000000002','full','Full',1,10);
insert into exam_delivery.package_questions(id,package_version_id,question_id,question_type,domain_key,source_ordinal,presentation_payload,content_hash)
values
  ('21000000-0000-0000-0000-000000000021','21000000-0000-0000-0000-000000000001','q1','single-choice','d1',1,'{}',repeat('1',64)),
  ('21000000-0000-0000-0000-000000000023','21000000-0000-0000-0000-000000000001','q3','single-choice','d1',2,'{}',repeat('5',64)),
  ('21000000-0000-0000-0000-000000000022','21000000-0000-0000-0000-000000000002','q2','single-choice','d1',1,'{}',repeat('2',64));
insert into exam_delivery.package_forms(id,package_version_id,package_profile_id,form_key,form_ordinal,question_count,membership_hash,blueprint_contract)
values
  ('21000000-0000-0000-0000-000000000031','21000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000011','F1',1,1,repeat('3',64),'{}'),
  ('21000000-0000-0000-0000-000000000032','21000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000011','F2',2,1,repeat('4',64),'{}');
insert into exam_delivery.package_form_questions(form_id,package_profile_id,package_version_id,package_question_id,presentation_ordinal)
values ('21000000-0000-0000-0000-000000000031','21000000-0000-0000-0000-000000000011','21000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000021',1);

select throws_ok(
  $$insert into exam_delivery.package_form_questions values ('21000000-0000-0000-0000-000000000031','21000000-0000-0000-0000-000000000011','21000000-0000-0000-0000-000000000002','21000000-0000-0000-0000-000000000022',2)$$,
  '23503', null, 'cross-package question membership is rejected by composite foreign keys');
select throws_ok(
  $$insert into exam_delivery.package_form_questions values ('21000000-0000-0000-0000-000000000031','21000000-0000-0000-0000-000000000012','21000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000023',2)$$,
  '23503', null, 'cross-profile form membership is rejected by the form/profile/version foreign key');
select throws_ok(
  $$insert into exam_delivery.package_form_questions values ('21000000-0000-0000-0000-000000000032','21000000-0000-0000-0000-000000000011','21000000-0000-0000-0000-000000000001','21000000-0000-0000-0000-000000000021',1)$$,
  '23505', null, 'one question cannot be placed in two canonical forms for one profile');

select * from finish();
rollback;
