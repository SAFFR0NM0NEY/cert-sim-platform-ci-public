import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const databaseUrl = required('SUPABASE_DB_URL');
const apiUrl = required('SUPABASE_URL').replace(/\/$/, '');
const serviceRoleKey = required('SUPABASE_SERVICE_ROLE_KEY');
assertLocal(databaseUrl, 'ISSUE167_DISPOSABLE_LOCAL_DATABASE_REQUIRED');
assertLocal(apiUrl, 'ISSUE167_DISPOSABLE_LOCAL_POSTGREST_REQUIRED');

const psql = process.env.PSQL_PATH?.trim() || 'psql';
const ids = {
  owner: '16740000-0000-4000-8000-000000000001',
  organisation: '16740000-0000-4000-8000-000000000002',
  package: '16740000-0000-4000-8000-000000000003',
  profile: '16740000-0000-4000-8000-000000000004',
  attempt: '16740000-0000-4000-8000-000000000005',
  attemptRequest: '16740000-0000-4000-8000-000000000006',
  questionA: '16740000-0000-4000-8000-000000000010',
  questionB: '16740000-0000-4000-8000-000000000011',
  itemA: '16740000-0000-4000-8000-000000000020',
  itemB: '16740000-0000-4000-8000-000000000021',
  response: '16740000-0000-4000-8000-000000000030',
  responseRequest: '16740000-0000-4000-8000-000000000031',
};
const savedResponse = { selectedOptionIds: ['saved-response-167-b4a'] };

runSql(`
begin;
insert into auth.users(id,email,raw_user_meta_data)
values ('${ids.owner}'::uuid,'issue167-b4a-owner@example.invalid','{}'::jsonb);
update public.profiles
set default_role='platform_owner',user_type='platform',status='active'
where id='${ids.owner}'::uuid;
insert into public.organisations(id,name,organisation_type,status)
values ('${ids.organisation}'::uuid,'Issue 167 B4A disposable fixture','internal','active');
insert into public.memberships(user_id,organisation_id,role,status)
values ('${ids.owner}'::uuid,'${ids.organisation}'::uuid,'platform_owner','active');

insert into exam_delivery.package_versions(
  id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,
  package_schema_version,generator_version,scorer_version,status,
  declared_review_release_policy,declared_answer_release_policy
) values (
  '${ids.package}'::uuid,'issue167resume','1.0.0',repeat('a',40),repeat('b',64),repeat('c',64),
  'certsim-protected-package-v2','issue167-b4a-generator','issue167-b4a-scorer',
  'draft','after_submission','after_submission'
);
insert into exam_delivery.package_profiles(
  id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config
) values (
  '${ids.profile}'::uuid,'${ids.package}'::uuid,'issue167-resume','Issue 167 resume profile',2,60,
  '{"standardQuestionCount":2,"pbqCount":0}'::jsonb
);
insert into exam_delivery.exam_profile_activations(
  package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by
) values ('${ids.package}'::uuid,'${ids.profile}'::uuid,true,'production',statement_timestamp(),'${ids.owner}'::uuid);
insert into exam_delivery.practice_policies(
  canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
  maximum_completed_attempts,maximum_concurrent_sessions,maximum_session_items,
  immediate_feedback,review_release_policy,answer_release_policy
) values (
  'issue167resume','1.0.0','issue167-resume','study_sandbox','production_authorized',true,
  null,1,20,true,'immediate_study_feedback','immediate_study_feedback'
);

insert into exam_delivery.package_questions(
  id,package_version_id,question_id,question_type,domain_key,section_key,
  source_ordinal,presentation_payload,content_hash
) values
  ('${ids.questionA}'::uuid,'${ids.package}'::uuid,'issue167-resume-a','single-choice','synthetic','standard',1,
    '{"stem":"Synthetic resume question A","options":[{"id":"saved-response-167-b4a","text":"A"}]}'::jsonb,repeat('d',64)),
  ('${ids.questionB}'::uuid,'${ids.package}'::uuid,'issue167-resume-b','single-choice','synthetic','standard',2,
    '{"stem":"Synthetic resume question B","options":[{"id":"answer-b","text":"B"}]}'::jsonb,repeat('e',64));
insert into exam_delivery.package_question_protected_content(
  question_id,package_version_id,scoring_payload,review_payload,authoring_metadata
) values
  ('${ids.questionA}'::uuid,'${ids.package}'::uuid,'{"correctOptionIds":["saved-response-167-b4a"]}'::jsonb,
    '{"explanation":"Synthetic A"}'::jsonb,'{"scored":true}'::jsonb),
  ('${ids.questionB}'::uuid,'${ids.package}'::uuid,'{"correctOptionIds":["answer-b"]}'::jsonb,
    '{"explanation":"Synthetic B"}'::jsonb,'{"scored":true}'::jsonb);
update exam_delivery.package_versions
set status='published',published_at=statement_timestamp()
where id='${ids.package}'::uuid;

insert into exam_delivery.attempts(
  id,owner_id,package_version_id,package_profile_id,client_request_id,status,
  generator_version,scorer_version,created_at,started_at,expires_at,purpose,
  practice_configuration,language_preference,practice_last_activity_at,practice_idle_expires_at
) values (
  '${ids.attempt}'::uuid,'${ids.owner}'::uuid,'${ids.package}'::uuid,'${ids.profile}'::uuid,
  '${ids.attemptRequest}'::uuid,'in_progress','issue167-b4a-generator','issue167-b4a-scorer',
  statement_timestamp()-interval '1 day',statement_timestamp()-interval '1 day',null,'study_sandbox',
  '{}'::jsonb,'not_applicable',statement_timestamp()-interval '5 minutes',statement_timestamp()+interval '29 days'
);
insert into exam_delivery.attempt_items(
  id,attempt_id,package_version_id,package_question_id,presented_question_number,
  section_ordinal,option_order,presentation_snapshot,presentation_hash
) values
  ('${ids.itemA}'::uuid,'${ids.attempt}'::uuid,'${ids.package}'::uuid,'${ids.questionA}'::uuid,1,1,'[]'::jsonb,
    '{"stem":"Synthetic resume question A","options":[{"id":"saved-response-167-b4a","text":"A"}]}'::jsonb,repeat('f',64)),
  ('${ids.itemB}'::uuid,'${ids.attempt}'::uuid,'${ids.package}'::uuid,'${ids.questionB}'::uuid,2,2,'[]'::jsonb,
    '{"stem":"Synthetic resume question B","options":[{"id":"answer-b","text":"B"}]}'::jsonb,repeat('1',64));
insert into exam_delivery.attempt_item_protected_content(
  attempt_item_id,attempt_id,scoring_snapshot,review_snapshot,protected_snapshot_hash
) values
  ('${ids.itemA}'::uuid,'${ids.attempt}'::uuid,'{"correctOptionIds":["saved-response-167-b4a"]}'::jsonb,
    '{"explanation":"Synthetic A"}'::jsonb,repeat('2',64)),
  ('${ids.itemB}'::uuid,'${ids.attempt}'::uuid,'{"correctOptionIds":["answer-b"]}'::jsonb,
    '{"explanation":"Synthetic B"}'::jsonb,repeat('3',64));
insert into exam_delivery.attempt_responses(
  id,attempt_id,attempt_item_id,response_payload,revision,last_request_id
) values (
  '${ids.response}'::uuid,'${ids.attempt}'::uuid,'${ids.itemA}'::uuid,
  '${sqlJson(savedResponse)}'::jsonb,4,'${ids.responseRequest}'::uuid
);
commit;
`);

const before = snapshot();
const response = await fetch(`${apiUrl}/rest/v1/rpc/certsim_protected_resume_attempt`, {
  method: 'POST',
  headers: {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ p_actor_id: ids.owner, p_attempt_id: ids.attempt }),
});
const responseText = await response.text();
const result = parseJson(responseText);
if (!response.ok) {
  if (result?.code === '25006') {
    throw new Error('POSTGREST_RESUME_SQLSTATE_25006');
  }
  throw new Error(`ISSUE167_POSTGREST_RESUME_FAILED_${response.status}_${safeError(result?.code ?? responseText)}`);
}

assert.equal(result.ok, true, 'protected resume must return ok');
assert.equal(result.attempt?.attemptId, ids.attempt, 'protected resume must return the original attempt');
assert.equal(result.attempt?.status, 'in_progress', 'protected resume must retain in_progress state');
assert.equal(result.attempt?.purpose, 'study_sandbox', 'protected resume must retain Study Sandbox purpose');
assert.equal(result.attempt?.itemCount, 2, 'protected resume must return the original item count');
assert.equal(result.items?.length, 2, 'protected resume must return the original items');
assert.deepEqual(result.items?.[0]?.response, savedResponse, 'protected resume must restore the saved response');
assert.equal(result.items?.[0]?.revision, 4, 'protected resume must restore the response revision');
assert.deepEqual(result.page, {
  afterPosition: 0,
  returnedThrough: 2,
  totalCount: 2,
  hasMore: false,
});
assert.doesNotMatch(JSON.stringify(result), /correctOptionIds|Synthetic A|Synthetic B/);

const after = snapshot();
assert.deepEqual(after.stableAttempt, before.stableAttempt, 'resume may not alter stable attempt fields');
assert.ok(after.activityEpoch > before.activityEpoch, 'resume must refresh practice_last_activity_at');
assert.ok(after.idleExpiryEpoch > before.idleExpiryEpoch, 'resume must refresh practice_idle_expires_at');
assert.equal(after.attemptCount, before.attemptCount, 'resume may not create or delete attempts');
assert.deepEqual(after.itemRows, before.itemRows, 'resume may not alter attempt items');
assert.deepEqual(after.protectedRows, before.protectedRows, 'resume may not alter protected snapshots');
assert.deepEqual(after.responseRows, before.responseRows, 'resume may not alter saved responses');
assert.equal(after.responseCount, 1, 'resume must preserve the saved response count');
assert.equal(after.resultCount, 0, 'resume may not create results');
assert.equal(after.reviewCount, 0, 'resume may not create reviews');
assert.equal(after.lifecycleEventCount, 0, 'resume may not create recovery or abandonment evidence');
assert.equal(after.linkageCount, 0, 'resume may not create replacement or expiration linkage');

console.log(JSON.stringify({
  status: 'PASS',
  issue: 167,
  transport: 'local-postgrest-post',
  sqlstate25006: 'not-returned',
  activityRefresh: 'preserved-authoritative-write',
  savedResponse: 'restored',
}));

function snapshot() {
  return JSON.parse(scalar(`
    select jsonb_build_object(
      'stableAttempt',to_jsonb(attempt)-array['practice_last_activity_at','practice_idle_expires_at'],
      'activityEpoch',extract(epoch from attempt.practice_last_activity_at),
      'idleExpiryEpoch',extract(epoch from attempt.practice_idle_expires_at),
      'attemptCount',(select count(*) from exam_delivery.attempts where owner_id='${ids.owner}'::uuid and package_profile_id='${ids.profile}'::uuid),
      'itemRows',(select jsonb_agg(to_jsonb(item) order by item.presented_question_number) from exam_delivery.attempt_items item where item.attempt_id=attempt.id),
      'protectedRows',(select jsonb_agg(to_jsonb(content) order by content.attempt_item_id) from exam_delivery.attempt_item_protected_content content where content.attempt_id=attempt.id),
      'responseRows',(select jsonb_agg(to_jsonb(saved) order by saved.attempt_item_id) from exam_delivery.attempt_responses saved where saved.attempt_id=attempt.id),
      'responseCount',(select count(*) from exam_delivery.attempt_responses where attempt_id=attempt.id),
      'resultCount',(select count(*) from exam_delivery.attempt_results where attempt_id=attempt.id),
      'reviewCount',(select count(*) from exam_delivery.review_snapshots where attempt_id=attempt.id),
      'lifecycleEventCount',(select count(*) from exam_delivery.attempt_abandonment_events where attempt_id=attempt.id)
        +(select count(*) from exam_delivery.attempt_recovery_events where attempt_id=attempt.id),
      'linkageCount',(select count(*) from exam_delivery.attempt_replacements where replaced_attempt_id=attempt.id or replacement_attempt_id=attempt.id)
        +(select count(*) from exam_delivery.practice_attempt_expirations where expired_attempt_id=attempt.id or replacement_attempt_id=attempt.id)
    )
    from exam_delivery.attempts attempt
    where attempt.id='${ids.attempt}'::uuid
  `));
}

function scalar(statement) {
  return runSql(statement).trim().split(/\r?\n/).at(-1) ?? '';
}

function runSql(statement) {
  const result = spawnSync(psql, [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`ISSUE167_SQL_FAILED_${safeError(result.stderr)}`);
  return result.stdout;
}

function assertLocal(value, code) {
  const hostname = new URL(value).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) throw new Error(code);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`ISSUE167_POSTGREST_NON_JSON_RESPONSE_${safeError(value)}`);
  }
}

function sqlJson(value) {
  return JSON.stringify(value).replaceAll("'", "''");
}

function safeError(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replaceAll(serviceRoleKey, '[REDACTED]').slice(0, 500);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}
