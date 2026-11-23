begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select no_plan();

select has_schema('exam_delivery', 'private exam_delivery schema exists');
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relkind in ('r','p')), 13, 'exam_delivery has 13 tables');
select is((select count(*)::integer from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='exam_delivery' and t.typtype='e'), 4, 'exam_delivery has four enums');
select is((select count(*)::integer from pg_constraint c join pg_namespace n on n.oid=c.connamespace where n.nspname='exam_delivery'), 115, 'exam_delivery constraint catalogue matches');
select is((select count(*)::integer from pg_indexes where schemaname='exam_delivery'), 43, 'exam_delivery index catalogue matches');
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relkind in ('r','p') and c.relrowsecurity), 13, 'RLS is enabled on all exam_delivery tables');
select is((select count(*)::integer from pg_policies where schemaname='exam_delivery'), 0, 'no exam_delivery RLS policy exposes rows');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery'), 6, 'only six trigger helpers exist');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.prosecdef), 0, 'no exam_delivery function is SECURITY DEFINER');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='exam_delivery' and p.proconfig @> array['search_path=""']), 6, 'all trigger helpers use an empty search_path');
select is((select count(*)::integer from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and not t.tgisinternal), 10, 'ten lifecycle triggers exist');
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='exam_delivery' and c.relkind in ('v','m')), 0, 'no browser-facing view exists');

select ok(not has_schema_privilege('public','exam_delivery','USAGE'), 'PUBLIC cannot use exam_delivery schema');
select ok(not has_schema_privilege('anon','exam_delivery','USAGE'), 'anon cannot use exam_delivery schema');
select ok(not has_schema_privilege('authenticated','exam_delivery','USAGE'), 'authenticated cannot use exam_delivery schema');
select ok(not has_schema_privilege('service_role','exam_delivery','USAGE'), 'service_role cannot use exam_delivery schema');
select is((select count(*)::integer from information_schema.role_table_grants where table_schema='exam_delivery' and grantee in ('PUBLIC','anon','authenticated','service_role')), 0, 'browser-facing roles have no table grants');
select is((select count(*)::integer from information_schema.role_routine_grants where routine_schema='exam_delivery' and grantee in ('PUBLIC','anon','authenticated','service_role')), 0, 'browser-facing roles have no function grants');
select is((select count(*)::integer from information_schema.role_usage_grants where object_schema='exam_delivery' and grantee in ('PUBLIC','anon','authenticated','service_role')), 0, 'browser-facing roles have no enum usage grants');
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join unnest(array['anon','authenticated','service_role']) role_name where n.nspname='exam_delivery' and c.relkind in ('r','p') and has_table_privilege(role_name, c.oid, 'SELECT,INSERT,UPDATE,DELETE')), 0, 'anon, authenticated, and service_role have no direct table access');
select is((select count(*)::integer from pg_default_acl d join pg_namespace n on n.oid=d.defaclnamespace cross join lateral aclexplode(coalesce(d.defaclacl, acldefault(d.defaclobjtype, d.defaclrole))) a left join pg_roles r on r.oid=a.grantee where n.nspname='exam_delivery' and coalesce(r.rolname,'PUBLIC') in ('PUBLIC','anon','authenticated','service_role')), 0, 'default privileges remain restricted');

select is((select count(*)::integer from exam_delivery.pilot_gates), 1, 'exactly one pilot gate is seeded');
select results_eq('select exam_key, enabled, enabled_at, disabled_at from exam_delivery.pilot_gates', $$values ('ai-901'::text, false, null::timestamptz, null::timestamptz)$$, 'AI-901 is seeded disabled with no lifecycle timestamps');
select is_empty('select 1 from exam_delivery.pilot_access', 'pilot allowlist starts empty');
select is((select sum(row_count)::integer from (
  select count(*) row_count from exam_delivery.package_versions union all
  select count(*) from exam_delivery.package_profiles union all
  select count(*) from exam_delivery.package_questions union all
  select count(*) from exam_delivery.package_question_protected_content union all
  select count(*) from exam_delivery.publication_runs union all
  select count(*) from exam_delivery.attempts union all
  select count(*) from exam_delivery.attempt_items union all
  select count(*) from exam_delivery.attempt_item_protected_content union all
  select count(*) from exam_delivery.attempt_responses union all
  select count(*) from exam_delivery.attempt_results union all
  select count(*) from exam_delivery.review_snapshots
) seeded_rows), 0, 'protected delivery data tables start empty');

insert into auth.users (instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ('00000000-0000-0000-0000-000000000000','10000000-0000-0000-0000-000000000001','authenticated','authenticated','phase17d2@example.invalid','','{}','{}',now(),now());

insert into exam_delivery.package_versions (id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,package_schema_version,generator_version,scorer_version)
values ('20000000-0000-0000-0000-000000000001','ai-901','phase17d2','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','1','test-generator','test-scorer');
insert into exam_delivery.package_profiles (id,package_version_id,profile_key,display_name,question_count)
values ('20000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000001','standard','Test profile',1);
insert into exam_delivery.package_questions (id,package_version_id,question_id,question_type,domain_key,source_ordinal,presentation_payload,content_hash)
values ('20000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001','fake-question-1','single','fake-domain',1,'{}','dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd');
insert into exam_delivery.package_question_protected_content (question_id,package_version_id,scoring_payload,review_payload)
values ('20000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000001','{}','{}');

select lives_ok($$update exam_delivery.package_profiles set display_name='Draft profile' where id='20000000-0000-0000-0000-000000000002'$$, 'draft package children can change');
update exam_delivery.package_versions set status='published', published_at=now() where id='20000000-0000-0000-0000-000000000001';
select throws_ok($$update exam_delivery.package_versions set package_version='changed' where id='20000000-0000-0000-0000-000000000001'$$, 'P0001', 'Published package identity and content are immutable.', 'published package identity is immutable');
select throws_ok($$update exam_delivery.package_profiles set display_name='Changed' where id='20000000-0000-0000-0000-000000000002'$$, 'P0001', 'Published package children are immutable.', 'published package children are immutable');
select throws_ok($$insert into exam_delivery.package_profiles (package_version_id,profile_key,display_name,question_count) values ('20000000-0000-0000-0000-000000000001','late','Late',1)$$, 'P0001', 'Package children may only be written while the package is draft.', 'new children cannot be added after publication');

insert into exam_delivery.attempts (id,owner_id,package_version_id,package_profile_id,client_request_id,generator_version,scorer_version,expires_at)
values ('30000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000002','30000000-0000-0000-0000-000000000002','test-generator','test-scorer',now()+interval '1 hour');
insert into exam_delivery.attempt_items (id,attempt_id,package_version_id,package_question_id,presented_question_number,presentation_snapshot,presentation_hash)
values ('30000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000003',1,'{}','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
insert into exam_delivery.attempt_item_protected_content (attempt_item_id,attempt_id,scoring_snapshot,review_snapshot,protected_snapshot_hash)
values ('30000000-0000-0000-0000-000000000003','30000000-0000-0000-0000-000000000001','{}','{}','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
insert into exam_delivery.attempt_responses (id,attempt_id,attempt_item_id,response_payload)
values ('30000000-0000-0000-0000-000000000004','30000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000003','{}');
select lives_ok($$update exam_delivery.attempt_responses set response_payload='{"answer":"A"}', revision=1 where id='30000000-0000-0000-0000-000000000004'$$, 'responses can change while attempt is in progress');
select throws_ok($$update exam_delivery.attempt_items set presented_question_number=2 where id='30000000-0000-0000-0000-000000000003'$$, 'P0001', 'Protected snapshot and result rows are immutable.', 'attempt items are immutable');
update exam_delivery.attempts set status='submitted',submitted_at=now() where id='30000000-0000-0000-0000-000000000001';
select throws_ok($$update exam_delivery.attempts set status='in_progress',submitted_at=null where id='30000000-0000-0000-0000-000000000001'$$, 'P0001', 'Invalid protected attempt lifecycle transition.', 'attempt lifecycle is forward-only');
select throws_ok($$update exam_delivery.attempt_responses set revision=2 where id='30000000-0000-0000-0000-000000000004'$$, 'P0001', 'Responses may only change while the protected attempt is in progress.', 'responses freeze after submission');
update exam_delivery.attempts set status='completed',completed_at=now() where id='30000000-0000-0000-0000-000000000001';
insert into exam_delivery.attempt_results (attempt_id,submission_id,response_hash,scorer_version,raw_score,max_score,raw_percentage,passed,submitted_at,completed_at,created_at)
select id,'30000000-0000-0000-0000-000000000005','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','test-scorer',1,1,100,true,submitted_at,completed_at,completed_at from exam_delivery.attempts where id='30000000-0000-0000-0000-000000000001';
insert into exam_delivery.review_snapshots (attempt_id,review_payload,review_hash)
values ('30000000-0000-0000-0000-000000000001','{}','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
select throws_ok($$update exam_delivery.attempt_results set raw_score=0 where attempt_id='30000000-0000-0000-0000-000000000001'$$, 'P0001', 'Protected snapshot and result rows are immutable.', 'attempt results are immutable');
select lives_ok($$update exam_delivery.review_snapshots set release_status='released',released_at=now() where attempt_id='30000000-0000-0000-0000-000000000001'$$, 'review can move forward to released');
select throws_ok($$update exam_delivery.review_snapshots set release_status='withheld',released_at=null where attempt_id='30000000-0000-0000-0000-000000000001'$$, 'P0001', 'Invalid review-release transition.', 'review release is forward-only');

select * from finish();
rollback;
