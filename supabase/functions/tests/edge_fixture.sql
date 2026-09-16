update public.profiles set status='active' where id=:'actor_id'::uuid;
insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values('00000000-0000-0000-0000-000000000000','15000000-0000-4000-8000-000000000090','authenticated','authenticated','edge-outsider-86@example.invalid','','{}','{}',now(),now());
update public.profiles set status='active' where id='15000000-0000-4000-8000-000000000090';
insert into public.organisations(id,name,organisation_type,status) values('12000000-0000-4000-8000-000000000001','Synthetic Edge Org','training_provider','active');
insert into public.campuses(id,organisation_id,name,code,status) values('12000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000001','Synthetic Edge Campus','EDGE','active');
insert into public."groups"(id,organisation_id,campus_id,name,status) values('12000000-0000-4000-8000-000000000003','12000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000002','Synthetic Edge Group','active');
insert into public.memberships(user_id,organisation_id,campus_id,group_id,role,status) values(:'actor_id'::uuid,'12000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000003','student','active');
insert into public.exam_assignments(organisation_id,campus_id,group_id,exam_key,profile_id,title,status,available_from,due_at) values('12000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000003','ai-901','ai901-controlled-beta-compact','Synthetic Edge assignment','active',now()-interval '1 hour',now()+interval '1 day');
insert into exam_delivery.package_versions(id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,package_schema_version,generator_version,scorer_version) values('13000000-0000-4000-8000-000000000001','ai901','1.0.0','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc','certsim-protected-package-v1','edge-test-generator','edge-test-scorer');
insert into exam_delivery.package_profiles(id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config) values('13000000-0000-4000-8000-000000000002','13000000-0000-4000-8000-000000000001','ai901-controlled-beta-compact','Synthetic compact',1,30,'{"domainDistribution":{"synthetic":1},"scoringContract":{"scoreScale":{"min":0,"max":1000,"pass":700}}}');
insert into exam_delivery.package_questions(id,package_version_id,question_id,question_type,domain_key,section_key,source_ordinal,presentation_payload,content_hash) values
('14000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','synthetic-edge-single','single-choice','synthetic','skill',1,'{"prompt":"Synthetic prompt","options":[{"id":"a","text":"A"},{"id":"b","text":"B"}]}','0000000000000000000000000000000000000000000000000000000000000001'),
('14000000-0000-4000-8000-000000000086','13000000-0000-4000-8000-000000000001','synthetic-edge-python','pbq-workspace','synthetic','python',2,'{"interactionVersion":"executable-python-lab-v1"}','0000000000000000000000000000000000000000000000000000000000000086');
insert into exam_delivery.package_question_protected_content(question_id,package_version_id,scoring_payload,review_payload) values('14000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','{"model":"exact-single","correctOptionId":"a","maxPoints":1}','{"explanation":"Synthetic explanation","remediation":"Synthetic remediation"}');
update exam_delivery.package_versions set status='published',published_at=now() where id='13000000-0000-4000-8000-000000000001';
insert into exam_delivery.exam_profile_activations(package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by)
values('13000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000002',true,'production',now(),:'actor_id'::uuid);
insert into exam_delivery.practice_policies(canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy)
values('ai901','1.0.0','ai901-controlled-beta-compact','study_sandbox','open_authenticated',true,10,true,'immediate_study_feedback','immediate_study_feedback');
insert into exam_delivery.exam_entitlements(package_version_id,package_profile_id,target_type,group_id,enabled,valid_from,reason_code,created_by,entitlement_source)
values('13000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000002','group','12000000-0000-4000-8000-000000000003',true,now()-interval '1 hour','issue86_fixture',:'actor_id'::uuid,'assignment');
update exam_delivery.pilot_gates set enabled=true,enabled_at=now(),disabled_at=null where exam_key='ai-901';
insert into exam_delivery.pilot_access(user_id,exam_key,enabled,access_starts_at,access_ends_at) values(:'actor_id'::uuid,'ai-901',true,now()-interval '1 hour',now()+interval '1 day');
insert into exam_delivery.protected_assignments(
  learner_id,organisation_id,package_version_id,package_profile_id,status,
  available_from,expires_at,maximum_attempts,review_release_policy,
  answer_release_policy,assigned_by
) values (
  :'actor_id'::uuid,'12000000-0000-4000-8000-000000000001',
  '13000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000002',
  'active',now()-interval '1 hour',null,1,'never','never',:'actor_id'::uuid
);
insert into exam_delivery.attempts(
  id,owner_id,package_version_id,package_profile_id,client_request_id,status,generator_version,scorer_version,
  created_at,started_at,expires_at,purpose,practice_configuration,language_preference,practice_last_activity_at,practice_idle_expires_at
) values
('15000000-0000-4000-8000-000000000086',:'actor_id'::uuid,'13000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000002','15000000-0000-4000-8000-000000000087','in_progress','edge-test-generator','edge-test-scorer',now(),now(),null,'study_sandbox','{}','not_applicable',now(),now()+interval '30 days'),
('15000000-0000-4000-8000-000000000091','15000000-0000-4000-8000-000000000090','13000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000002','15000000-0000-4000-8000-000000000092','in_progress','edge-test-generator','edge-test-scorer',now(),now(),null,'study_sandbox','{}','not_applicable',now(),now()+interval '30 days');
insert into exam_delivery.attempt_items(
  id,attempt_id,package_version_id,package_question_id,presented_question_number,option_order,presentation_snapshot,presentation_hash
) values
('15000000-0000-4000-8000-000000000088','15000000-0000-4000-8000-000000000086','13000000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000086',1,'[]','{"interactionVersion":"executable-python-lab-v1"}',repeat('8',64)),
('15000000-0000-4000-8000-000000000093','15000000-0000-4000-8000-000000000091','13000000-0000-4000-8000-000000000001','14000000-0000-4000-8000-000000000086',1,'[]','{"interactionVersion":"executable-python-lab-v1"}',repeat('9',64));
