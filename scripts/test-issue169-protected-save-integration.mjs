import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
  deserializeProtectedResponse,
  serializeProtectedResponse,
} from '../src/lib/protectedExamContract.js';
import { validateAndCanonicalizePBQResponse } from './backend-exam-publication/pbq-runtime.mjs';

const databaseUrl = required('SUPABASE_DB_URL');
const databaseHost = new URL(databaseUrl).hostname;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(databaseHost)) {
  throw new Error('ISSUE169_DISPOSABLE_LOCAL_DATABASE_REQUIRED');
}
const psql = process.env.PSQL_PATH?.trim() || 'psql';
const ownerId = '16900000-0000-4000-8000-000000000001';
const organisationId = '16900000-0000-4000-8000-000000000002';
const packageId = '16900000-0000-4000-8000-000000000003';
const profileId = '16900000-0000-4000-8000-000000000004';
const attemptId = '16900000-0000-4000-8000-000000000005';

const mapAllowlist = (entries, commandIds = []) => ({
  targetIds: entries.map(([targetId]) => targetId),
  answerIdsByTarget: Object.fromEntries(entries),
  commandIds,
});

const fixtures = [
  {
    id: 'interactive-config',
    questionId: 'issue169-config',
    questionType: 'pbq-config-panel',
    questionUuid: '16900000-0000-4000-8000-000000000010',
    itemUuid: '16900000-0000-4000-8000-000000000020',
    requestUuid: '16900000-0000-4000-8000-000000000030',
    allowlist: mapAllowlist([
      ['config-evidence', ['selected']],
      ['config-decision', ['allow', 'deny']],
    ]),
    browserAnswer: {
      'config-evidence': 'selected',
      'config-decision': 'allow',
      perHostCommandHistory: { host: ['inspect'] },
      perHostTerminalTranscript: { host: [{ id: 'browser-timestamp', output: 'terminal output' }] },
    },
  },
  {
    id: 'interactive-firewall',
    questionId: 'issue169-firewall',
    questionType: 'pbq-firewall',
    questionUuid: '16900000-0000-4000-8000-000000000011',
    itemUuid: '16900000-0000-4000-8000-000000000021',
    requestUuid: '16900000-0000-4000-8000-000000000031',
    allowlist: mapAllowlist([
      ['firewall-evidence', ['selected']],
      ['firewall-decision', ['permit', 'block']],
    ]),
    browserAnswer: {
      'firewall-evidence': 'selected',
      'firewall-decision': 'block',
      perHostCommandHistory: {},
      perHostTerminalTranscript: {},
    },
  },
  {
    id: 'interactive-hotspot',
    questionId: 'issue169-hotspot',
    questionType: 'pbq-hotspot',
    questionUuid: '16900000-0000-4000-8000-000000000012',
    itemUuid: '16900000-0000-4000-8000-000000000022',
    requestUuid: '16900000-0000-4000-8000-000000000032',
    allowlist: mapAllowlist([
      ['hotspot-evidence', ['selected']],
      ['hotspot-decision', ['zone-a', 'zone-b']],
    ]),
    browserAnswer: {
      'hotspot-evidence': 'selected',
      'hotspot-decision': 'zone-b',
      perHostCommandHistory: { sensor: [] },
      perHostTerminalTranscript: { sensor: [] },
    },
  },
  {
    id: 'interactive-multi-host',
    questionId: 'issue169-multi-host',
    questionType: 'pbq-multi-host-terminal',
    questionUuid: '16900000-0000-4000-8000-000000000013',
    itemUuid: '16900000-0000-4000-8000-000000000023',
    requestUuid: '16900000-0000-4000-8000-000000000033',
    allowlist: mapAllowlist([
      ['host-evidence', ['inspected']],
      ['host-decision', ['isolate', 'retain']],
    ], ['inspect-host']),
    browserAnswer: {
      'host-evidence': 'inspected',
      'host-decision': 'isolate',
      executedCommands: ['inspect-host'],
      perHostCommandHistory: { host: ['inspect host'] },
      perHostTerminalTranscript: { host: [{ id: 'browser-timestamp', output: 'terminal output' }] },
    },
  },
].map((fixture, index) => {
  const question = {
    type: fixture.questionType,
    tasks: { interactionStyle: 'interactive-topology' },
    responseAllowlist: fixture.allowlist,
  };
  const response = serializeProtectedResponse(question, fixture.browserAnswer);
  assert.deepEqual(
    validateAndCanonicalizePBQResponse({ responseAllowlist: fixture.allowlist }, response).value,
    response,
    `${fixture.id} JS validator parity failed`,
  );
  return {
    ...fixture,
    index: index + 1,
    question,
    response,
    presentation: {
      type: fixture.questionType,
      tasks: { interactionStyle: 'interactive-topology' },
      responseAllowlist: fixture.allowlist,
    },
    scoring: {
      strategy: 'per-component-map',
      expectedMap: response.selectedAnswers,
      requiredCommandIds: [],
    },
  };
});

const sql = `
begin;
insert into auth.users(id,email,raw_user_meta_data)
values ('${ownerId}'::uuid,'issue169-owner@example.invalid','{}'::jsonb);
update public.profiles set default_role='platform_owner',user_type='platform' where id='${ownerId}'::uuid;
insert into public.organisations(id,name,organisation_type,status)
values ('${organisationId}'::uuid,'Issue 169 disposable fixture','internal','active');
insert into public.memberships(user_id,organisation_id,role,status)
values ('${ownerId}'::uuid,'${organisationId}'::uuid,'platform_owner','active');

insert into exam_delivery.package_versions(
  id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,
  package_schema_version,generator_version,scorer_version,status,
  declared_review_release_policy,declared_answer_release_policy
) values (
  '${packageId}'::uuid,'issue169','1.0.0','${'a'.repeat(40)}','${'b'.repeat(64)}','${'c'.repeat(64)}',
  'certsim-protected-package-v2','issue169-generator-v1','certsim-az400-authoritative-scorer-v1',
  'draft','after_submission','after_submission'
);
insert into exam_delivery.package_profiles(
  id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config
) values (
  '${profileId}'::uuid,'${packageId}'::uuid,'issue169-profile','Issue 169 profile',4,60,
  '{"standardQuestionCount":0,"pbqCount":4}'::jsonb
);
insert into exam_delivery.exam_profile_activations(
  package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by
) values ('${packageId}'::uuid,'${profileId}'::uuid,true,'production',statement_timestamp(),'${ownerId}'::uuid);
insert into exam_delivery.practice_policies(
  canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
  maximum_completed_attempts,maximum_concurrent_sessions,maximum_session_items,
  immediate_feedback,review_release_policy,answer_release_policy
) values (
  'issue169','1.0.0','issue169-profile','self_directed_exam','controlled_beta',true,
  null,1,10,false,'after_submission','after_submission'
);

${fixtures.map((fixture) => `
insert into exam_delivery.package_questions(
  id,package_version_id,question_id,question_type,domain_key,section_key,
  source_ordinal,presentation_payload,content_hash
) values (
  '${fixture.questionUuid}'::uuid,'${packageId}'::uuid,'${fixture.questionId}',
  '${fixture.questionType}','synthetic','pbq',${fixture.index},
  '${quoteJson(fixture.presentation)}'::jsonb,'${String(fixture.index).repeat(64)}'
);
insert into exam_delivery.package_question_protected_content(
  question_id,package_version_id,scoring_payload,review_payload,authoring_metadata
) values (
  '${fixture.questionUuid}'::uuid,'${packageId}'::uuid,'${quoteJson(fixture.scoring)}'::jsonb,
  '{"explanation":"Synthetic","remediation":"Synthetic"}'::jsonb,'{"scored":true}'::jsonb
);`).join('\n')}

update exam_delivery.package_versions
set status='published',published_at=statement_timestamp()
where id='${packageId}'::uuid;

insert into exam_delivery.attempts(
  id,owner_id,package_version_id,package_profile_id,client_request_id,status,
  generator_version,scorer_version,created_at,started_at,expires_at,purpose,
  practice_configuration,language_preference
) values (
  '${attemptId}'::uuid,'${ownerId}'::uuid,'${packageId}'::uuid,'${profileId}'::uuid,
  '16900000-0000-4000-8000-000000000006'::uuid,'in_progress',
  'issue169-generator-v1','certsim-az400-authoritative-scorer-v1',
  statement_timestamp(),statement_timestamp(),statement_timestamp()+interval '2 hours',
  'self_directed_exam','{}'::jsonb,'not_applicable'
);

${fixtures.map((fixture) => `
insert into exam_delivery.attempt_items(
  id,attempt_id,package_version_id,package_question_id,presented_question_number,
  section_ordinal,option_order,presentation_snapshot,presentation_hash
) values (
  '${fixture.itemUuid}'::uuid,'${attemptId}'::uuid,'${packageId}'::uuid,
  '${fixture.questionUuid}'::uuid,${fixture.index},${fixture.index},'[]'::jsonb,
  '${quoteJson(fixture.presentation)}'::jsonb,'${String(fixture.index + 4).repeat(64)}'
);
insert into exam_delivery.attempt_item_protected_content(
  attempt_item_id,attempt_id,scoring_snapshot,review_snapshot,protected_snapshot_hash
) values (
  '${fixture.itemUuid}'::uuid,'${attemptId}'::uuid,'${quoteJson(fixture.scoring)}'::jsonb,
  '{"explanation":"Synthetic","remediation":"Synthetic"}'::jsonb,
  '${['9', 'a', 'b', 'c'][fixture.index - 1].repeat(64)}'
);`).join('\n')}

do $issue169$
declare
  v_result jsonb;
begin
  v_result := public.certsim_protected_save_response(
    '${ownerId}'::uuid,'${attemptId}'::uuid,'${fixtures[0].itemUuid}'::uuid,
    '${quoteJson({ selectedAnswers: fixtures[0].browserAnswer })}'::jsonb,
    0,'16900000-0000-4000-8000-000000000039'::uuid
  );
  if v_result->>'code' is distinct from 'invalid_response' then
    raise exception 'ISSUE169_OLD_BROWSER_SHAPE_NOT_REJECTED_%',v_result;
  end if;
  if exists(select 1 from exam_delivery.attempt_responses where attempt_item_id='${fixtures[0].itemUuid}'::uuid) then
    raise exception 'ISSUE169_REJECTED_RESPONSE_PERSISTED';
  end if;
${fixtures.map((fixture) => `
  v_result := public.certsim_protected_save_response(
    '${ownerId}'::uuid,'${attemptId}'::uuid,'${fixture.itemUuid}'::uuid,
    '${quoteJson(fixture.response)}'::jsonb,0,'${fixture.requestUuid}'::uuid
  );
  if not coalesce((v_result->>'ok')::boolean,false) or (v_result->>'revision')::integer<>1 then
    raise exception 'ISSUE169_${fixture.id.toUpperCase().replaceAll('-', '_')}_SAVE_FAILED_%',v_result;
  end if;`).join('\n')}
  if (select count(*) from exam_delivery.attempt_responses where attempt_id='${attemptId}'::uuid)<>4 then
    raise exception 'ISSUE169_RESPONSE_COUNT_INVALID';
  end if;
  if exists(
    select 1 from exam_delivery.attempt_responses
    where attempt_id='${attemptId}'::uuid
      and response_payload::text ~* 'perHostCommandHistory|perHostTerminalTranscript|terminal output|browser-timestamp'
  ) then
    raise exception 'ISSUE169_BROWSER_STATE_PERSISTED';
  end if;
end
$issue169$;

select 'ISSUE169_RESUME=' || public.certsim_protected_resume_attempt(
  '${ownerId}'::uuid,'${attemptId}'::uuid
)::text;
commit;
`;

const result = spawnSync(
  psql,
  [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-f', '-'],
  { input: sql, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
);
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`ISSUE169_DATABASE_INTEGRATION_FAILED\n${result.stdout}\n${result.stderr}`);
}

const resumeLine = result.stdout
  .split(/\r?\n/)
  .find((line) => line.startsWith('ISSUE169_RESUME='));
assert.ok(resumeLine, 'Issue #169 resume marker missing');
const resumed = JSON.parse(resumeLine.slice('ISSUE169_RESUME='.length));
assert.equal(resumed.ok, true);
assert.equal(resumed.attempt?.attemptId, attemptId);
assert.equal(resumed.items?.length, fixtures.length);
for (const fixture of fixtures) {
  const resumedItem = resumed.items.find((item) => item.itemId === fixture.itemUuid);
  assert.ok(resumedItem, `${fixture.id} missing after resume`);
  assert.equal(resumedItem.revision, 1, `${fixture.id} revision drifted`);
  assert.deepEqual(resumedItem.response, fixture.response, `${fixture.id} response drifted`);
  const browserState = deserializeProtectedResponse(fixture.question, resumedItem.response);
  assert.deepEqual(
    serializeProtectedResponse(fixture.question, browserState),
    fixture.response,
    `${fixture.id} deserialize/serialize round-trip drifted`,
  );
}
assert.doesNotMatch(
  JSON.stringify(resumed.items.map((item) => item.response)),
  /perHostCommandHistory|perHostTerminalTranscript|terminal output|browser-timestamp/i,
);

console.log('Issue #169 actual protected save RPC integration and resume round-trip passed for config-panel, firewall, hotspot, and multi-host.');

function quoteJson(value) {
  return JSON.stringify(value).replaceAll("'", "''");
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}
