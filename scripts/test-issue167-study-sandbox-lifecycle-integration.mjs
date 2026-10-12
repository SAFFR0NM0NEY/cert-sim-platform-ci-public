import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const databaseUrl = required('SUPABASE_DB_URL');
const databaseHost = new URL(databaseUrl).hostname;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(databaseHost)) {
  throw new Error('ISSUE167_DISPOSABLE_LOCAL_DATABASE_REQUIRED');
}

const psql = process.env.PSQL_PATH?.trim() || 'psql';
const ids = {
  owner: '16700000-0000-4000-8000-000000000001',
  conflictOwner: '16700000-0000-4000-8000-000000000002',
  concurrentOwner: '16700000-0000-4000-8000-000000000003',
  replayOwner: '16700000-0000-4000-8000-000000000004',
  organisation: '16700000-0000-4000-8000-000000000010',
  oldPackage: '16700000-0000-4000-8000-000000000100',
  oldProfile: '16700000-0000-4000-8000-000000000101',
  oldQuestionA: '16700000-0000-4000-8000-000000000102',
  oldQuestionB: '16700000-0000-4000-8000-000000000103',
  currentPackage: '16700000-0000-4000-8000-000000000110',
  currentProfile: '16700000-0000-4000-8000-000000000111',
  currentQuestionA: '16700000-0000-4000-8000-000000000112',
  currentQuestionB: '16700000-0000-4000-8000-000000000113',
  unavailablePackage: '16700000-0000-4000-8000-000000000120',
  unavailableProfile: '16700000-0000-4000-8000-000000000121',
  unavailableQuestionA: '16700000-0000-4000-8000-000000000122',
  unavailableQuestionB: '16700000-0000-4000-8000-000000000123',
};

runSql(`
  insert into auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
  ('00000000-0000-0000-0000-000000000000','${ids.owner}','authenticated','authenticated','owner-167@example.invalid','','{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','${ids.conflictOwner}','authenticated','authenticated','conflict-167@example.invalid','','{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','${ids.concurrentOwner}','authenticated','authenticated','concurrent-167@example.invalid','','{}','{}',now(),now()),
  ('00000000-0000-0000-0000-000000000000','${ids.replayOwner}','authenticated','authenticated','replay-167@example.invalid','','{}','{}',now(),now());
  update public.profiles set status='active' where id in ('${ids.owner}','${ids.conflictOwner}','${ids.concurrentOwner}','${ids.replayOwner}');
  insert into public.organisations(id,name,organisation_type,status)
    values('${ids.organisation}','Issue 167 disposable fixture','internal','active');
  insert into public.memberships(user_id,organisation_id,role,status) values
    ('${ids.owner}','${ids.organisation}','platform_owner','active'),
    ('${ids.conflictOwner}','${ids.organisation}','platform_owner','active'),
    ('${ids.concurrentOwner}','${ids.organisation}','platform_owner','active'),
    ('${ids.replayOwner}','${ids.organisation}','platform_owner','active');

  insert into exam_delivery.package_versions(
    id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,
    package_schema_version,generator_version,scorer_version,created_at
  ) values
    ('${ids.oldPackage}','issue-167-fixture','1.0.0',repeat('1',40),repeat('2',64),repeat('3',64),'certsim-protected-package-v2','issue167','issue167','2026-08-01 00:00Z'),
    ('${ids.currentPackage}','issue167fixture','2.0.0',repeat('4',40),repeat('5',64),repeat('6',64),'certsim-protected-package-v2','issue167','issue167','2026-08-02 00:00Z'),
    ('${ids.unavailablePackage}','issue167fixture','3.0.0',repeat('7',40),repeat('8',64),repeat('9',64),'certsim-protected-package-v2','issue167','issue167','2026-08-03 00:00Z');
  insert into exam_delivery.package_profiles(id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config) values
    ('${ids.oldProfile}','${ids.oldPackage}','standard-profile','Issue 167 historical profile',2,60,'{}'),
    ('${ids.currentProfile}','${ids.currentPackage}','standard-profile','Issue 167 current profile',2,60,'{}'),
    ('${ids.unavailableProfile}','${ids.unavailablePackage}','standard-profile','Issue 167 unavailable profile',2,60,'{}');
  insert into exam_delivery.package_questions(
    id,package_version_id,question_id,question_type,domain_key,section_key,source_ordinal,presentation_payload,content_hash
  ) values
    ('${ids.oldQuestionA}','${ids.oldPackage}','issue167-old-a','single-choice','d1','standard',1,'{"stem":"safe old a"}',repeat('a',64)),
    ('${ids.oldQuestionB}','${ids.oldPackage}','issue167-old-b','single-choice','d1','standard',2,'{"stem":"safe old b"}',repeat('b',64)),
    ('${ids.currentQuestionA}','${ids.currentPackage}','issue167-current-a','single-choice','d1','standard',1,'{"stem":"safe current a"}',repeat('c',64)),
    ('${ids.currentQuestionB}','${ids.currentPackage}','issue167-current-b','single-choice','d1','standard',2,'{"stem":"safe current b"}',repeat('d',64)),
    ('${ids.unavailableQuestionA}','${ids.unavailablePackage}','issue167-unavailable-a','single-choice','d1','standard',1,'{"stem":"safe unavailable a"}',repeat('e',64)),
    ('${ids.unavailableQuestionB}','${ids.unavailablePackage}','issue167-unavailable-b','single-choice','d1','standard',2,'{"stem":"safe unavailable b"}',repeat('f',64));
  update exam_delivery.package_versions
    set status='published',published_at='2026-09-01 00:00Z'
    where id in ('${ids.oldPackage}','${ids.currentPackage}','${ids.unavailablePackage}');
  insert into exam_delivery.exam_profile_activations(
    package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by
  ) values
    ('${ids.oldPackage}','${ids.oldProfile}',true,'production',now(),'${ids.owner}'),
    ('${ids.currentPackage}','${ids.currentProfile}',true,'production',now(),'${ids.owner}');
  insert into exam_delivery.practice_policies(
    canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
    maximum_completed_attempts,maximum_session_items,immediate_feedback,
    review_release_policy,answer_release_policy
  )
  select 'issue167fixture',package_version,'standard-profile',purpose::exam_delivery.attempt_purpose,
    'production_authorized',true,null,40,purpose='study_sandbox',
    case when purpose='study_sandbox' then 'immediate_study_feedback' else 'after_submission' end,
    case when purpose='study_sandbox' then 'immediate_study_feedback' else 'after_submission' end
  from unnest(array['1.0.0','2.0.0','3.0.0']) package_version
  cross join unnest(array[
    'self_directed_exam','study_sandbox','targeted_domain','weak_area','pbq_practice'
  ]) purpose;
`);

const attempts = new Map();
function createAttempt({ owner = ids.owner, packageId = ids.oldPackage, profileId = ids.oldProfile,
  questionIds = [ids.oldQuestionA, ids.oldQuestionB], purpose = 'study_sandbox',
  status = 'abandoned', responseCount = 1, withResult = false, withReview = false }) {
  const attemptId = randomUUID();
  const itemIds = questionIds.map(() => randomUUID());
  const requestId = randomUUID();
  const values = questionIds.map((questionId, index) => `(
    '${itemIds[index]}','${attemptId}','${packageId}','${questionId}',${index + 1},
    '[]','{"safe":"presentation-${index + 1}"}',repeat('${index + 1}',64)
  )`).join(',');
  runSql(`
    insert into exam_delivery.attempts(
      id,owner_id,package_version_id,package_profile_id,client_request_id,status,
      generator_version,scorer_version,created_at,started_at,expires_at,purpose,
      practice_configuration,language_preference,practice_last_activity_at,practice_idle_expires_at
    ) values(
      '${attemptId}','${owner}','${packageId}','${profileId}','${requestId}','in_progress',
      'issue167','issue167',statement_timestamp()-interval '10 days',statement_timestamp()-interval '10 days',
      ${purpose === 'assigned_assessment' || purpose === 'self_directed_exam' ? "statement_timestamp()+interval '1 hour'" : 'null'},
      '${purpose}','{}','not_applicable',statement_timestamp()-interval '9 days',statement_timestamp()+interval '21 days'
    );
    insert into exam_delivery.attempt_items(
      id,attempt_id,package_version_id,package_question_id,presented_question_number,
      option_order,presentation_snapshot,presentation_hash
    ) values ${values};
    insert into exam_delivery.attempt_item_protected_content(
      attempt_item_id,attempt_id,scoring_snapshot,review_snapshot,protected_snapshot_hash
    ) select id,attempt_id,'{"correct":"fixture-secret"}','{"explanation":"fixture-secret"}',repeat('a',64)
      from exam_delivery.attempt_items where attempt_id='${attemptId}';
    ${itemIds.slice(0, responseCount).map((itemId, index) => `
      insert into exam_delivery.attempt_responses(id,attempt_id,attempt_item_id,response_payload,revision,last_request_id)
      values('${randomUUID()}','${attemptId}','${itemId}','{"answer":"fixture-secret-${index + 1}"}',${index + 3},'${randomUUID()}');
    `).join('')}
    ${status === 'completed'
      ? `update exam_delivery.attempts set status='completed',submitted_at=statement_timestamp(),completed_at=statement_timestamp() where id='${attemptId}';`
      : status === 'in_progress' ? '' : `update exam_delivery.attempts set status='${status}' where id='${attemptId}';`}
    ${withResult ? `
      insert into exam_delivery.attempt_results(
        attempt_id,submission_id,response_hash,scorer_version,raw_score,max_score,
        raw_percentage,passed,domain_summary,result_summary,submitted_at,completed_at,created_at
      ) values('${attemptId}','${randomUUID()}',repeat('b',64),'issue167',0,1,0,false,'{}','{}',
        statement_timestamp()-interval '2 seconds',statement_timestamp()-interval '1 second',statement_timestamp());
    ` : ''}
    ${withReview ? `
      insert into exam_delivery.review_snapshots(attempt_id,release_status,review_payload,review_hash,created_at)
      values('${attemptId}','withheld','{}',repeat('c',64),statement_timestamp());
    ` : ''}
  `);
  const created = { attemptId, itemIds, requestId, owner, packageId, profileId, purpose, status };
  attempts.set(attemptId, created);
  return created;
}

// Audited abandonment, authoritative counts, replay behavior, and rollback.
const deliberate = createAttempt({ status: 'in_progress', responseCount: 2 });
const activeRecovery = rpc('certsim_protected_recover_study_sandbox', [ids.owner, deliberate.attemptId, randomUUID()]);
assert.deepEqual({ ok: activeRecovery.ok, code: activeRecovery.code }, { ok: false, code: 'invalid_lifecycle_transition' });
const abandonRequest = randomUUID();
const abandoned = rpc('certsim_protected_abandon_attempt', [ids.owner, deliberate.attemptId, abandonRequest]);
assert.equal(abandoned.ok, true);
assert.equal(abandoned.attemptId, deliberate.attemptId);
assert.equal(abandoned.savedResponseCount, 2);
assert.equal(scalar(`select status from exam_delivery.attempts where id='${deliberate.attemptId}'`), 'abandoned');
assert.equal(Number(scalar(`select count(*) from exam_delivery.attempt_abandonment_events where attempt_id='${deliberate.attemptId}'`)), 1);
assert.equal(Number(scalar(`select response_count_snapshot from exam_delivery.attempt_abandonment_events where attempt_id='${deliberate.attemptId}'`)), 2);
assert.equal(scalar(`select reason_code from exam_delivery.attempt_abandonment_events where attempt_id='${deliberate.attemptId}'`), 'learner_discarded_study_sandbox');
assert.equal(scalar(`select source_action from exam_delivery.attempt_abandonment_events where attempt_id='${deliberate.attemptId}'`), 'study_sandbox_discard');
assert.doesNotMatch(scalar(`select to_jsonb(event)::text from exam_delivery.attempt_abandonment_events event where attempt_id='${deliberate.attemptId}'`), /fixture-secret|answer|payload/i);
const abandonReplay = rpc('certsim_protected_abandon_attempt', [ids.owner, deliberate.attemptId, abandonRequest]);
assert.deepEqual(abandonReplay, abandoned);
const secondAbandon = rpc('certsim_protected_abandon_attempt', [ids.owner, deliberate.attemptId, randomUUID()]);
assert.equal(secondAbandon.ok, false);
assert.equal(Number(scalar(`select count(*) from exam_delivery.attempt_abandonment_events where attempt_id='${deliberate.attemptId}'`)), 1);
const deliberateRecovery = rpc('certsim_protected_recover_study_sandbox', [ids.owner, deliberate.attemptId, randomUUID()]);
assert.deepEqual({ ok: deliberateRecovery.ok, code: deliberateRecovery.code }, { ok: false, code: 'sandbox_discarded' });

const rollbackAttempt = createAttempt({ owner: ids.replayOwner, status: 'in_progress', responseCount: 1 });
runSql(`
  create function exam_delivery.issue167_test_reject_abandonment_event()
  returns trigger language plpgsql set search_path='' as $$
  begin
    if new.attempt_id='${rollbackAttempt.attemptId}' then raise exception 'synthetic_issue167_event_failure'; end if;
    return new;
  end $$;
  create trigger issue167_test_reject_abandonment_event
  before insert on exam_delivery.attempt_abandonment_events
  for each row execute function exam_delivery.issue167_test_reject_abandonment_event();
`);
expectSqlFailure(`select public.certsim_protected_abandon_attempt('${ids.replayOwner}','${rollbackAttempt.attemptId}','${randomUUID()}')`, /synthetic_issue167_event_failure/);
assert.equal(scalar(`select status from exam_delivery.attempts where id='${rollbackAttempt.attemptId}'`), 'in_progress');
assert.equal(Number(scalar(`select count(*) from exam_delivery.attempt_abandonment_events where attempt_id='${rollbackAttempt.attemptId}'`)), 0);
runSql(`drop trigger issue167_test_reject_abandonment_event on exam_delivery.attempt_abandonment_events; drop function exam_delivery.issue167_test_reject_abandonment_event()`);
assert.equal(rpc('certsim_protected_abandon_attempt', [ids.replayOwner, rollbackAttempt.attemptId, randomUUID()]).ok, true);
expectSqlFailure(`update exam_delivery.attempt_abandonment_events set response_count_snapshot=99 where attempt_id='${deliberate.attemptId}'`, /immutable/i);
expectSqlFailure(`delete from exam_delivery.attempt_abandonment_events where attempt_id='${deliberate.attemptId}'`, /immutable/i);

// Historical discovery and authoritative lifecycle summary.
const recoverable = createAttempt({ responseCount: 2 });
const zeroResponse = createAttempt({ responseCount: 0 });
const resultAttempt = createAttempt({ responseCount: 1, withResult: true });
const reviewAttempt = createAttempt({ responseCount: 1, withResult: true, withReview: true });
const completed = createAttempt({ status: 'completed', responseCount: 1 });
const expired = createAttempt({ status: 'expired', responseCount: 1 });
const voided = createAttempt({ status: 'voided', responseCount: 1 });
const assigned = createAttempt({ purpose: 'assigned_assessment', responseCount: 1 });
const selfDirected = createAttempt({ purpose: 'self_directed_exam', responseCount: 1 });
const targeted = createAttempt({ purpose: 'targeted_domain', responseCount: 1 });
const weakArea = createAttempt({ purpose: 'weak_area', responseCount: 1 });
const pbqPractice = createAttempt({ purpose: 'pbq_practice', responseCount: 1 });
const replacementLinked = createAttempt({ responseCount: 1 });
const replacementPartner = createAttempt({ responseCount: 1 });
runSql(`insert into exam_delivery.attempt_replacements(replaced_attempt_id,replacement_attempt_id,owner_id,request_id,reason_code)
  values('${replacementLinked.attemptId}','${replacementPartner.attemptId}','${ids.owner}','${randomUUID()}','learner_started_new_attempt')`);
const expiryLinked = createAttempt({ responseCount: 1 });
const expiryPartner = createAttempt({ responseCount: 1 });
runSql(`insert into exam_delivery.practice_attempt_expirations(expired_attempt_id,replacement_attempt_id,owner_id,reason_code,response_count,expired_at,replacement_started_at)
  values('${expiryLinked.attemptId}','${expiryPartner.attemptId}','${ids.owner}','practice_window_expired',1,statement_timestamp()-interval '1 day',statement_timestamp())`);
const unavailable = createAttempt({
  packageId: ids.unavailablePackage,
  profileId: ids.unavailableProfile,
  questionIds: [ids.unavailableQuestionA, ids.unavailableQuestionB],
  responseCount: 1,
});

const discovery = rpc('certsim_protected_list_recoverable_study_sandboxes', [ids.owner, 'issue-167-fixture', 'standard-profile', 20]);
assert.equal(discovery.ok, true);
assert.deepEqual(discovery.candidates.map((candidate) => candidate.attemptId), [recoverable.attemptId]);
const candidate = discovery.candidates[0];
assert.deepEqual(Object.keys(candidate).sort(), [
  'attemptId','examKey','itemCount','languagePreference','lastActivityAt','packageVersion',
  'profileKey','profileName','purpose','recoverable','savedResponseCount','startedAt',
].sort());
assert.equal(candidate.savedResponseCount, 2);
assert.equal(candidate.itemCount, 2);
assert.equal(candidate.recoverable, true);
assert.doesNotMatch(JSON.stringify(discovery), /fixture-secret|responsePayload|presentation|questionId|itemId|correct/i);
assert.deepEqual(rpc('certsim_protected_list_recoverable_study_sandboxes', [ids.conflictOwner, 'issue167fixture', 'standard-profile', 20]).candidates, []);

const summary = rpc('certsim_protected_get_attempt_lifecycle_summary', [ids.owner, recoverable.attemptId]);
assert.deepEqual(summary, {
  ok: true,
  attemptId: recoverable.attemptId,
  purpose: 'study_sandbox',
  status: 'abandoned',
  savedResponseCount: 2,
});
assert.deepEqual(rpc('certsim_protected_get_attempt_lifecycle_summary', [ids.conflictOwner, recoverable.attemptId]), { ok: false, code: 'attempt_not_found' });
assert.doesNotMatch(JSON.stringify(summary), /fixture-secret|responsePayload|answer|presentation|questionId|itemId/i);

// Recovery preserves every protected row and resets only the inactivity window.
const before = preservationSnapshot(recoverable.attemptId);
const recoveryRequest = randomUUID();
const recovered = rpc('certsim_protected_recover_study_sandbox', [ids.owner, recoverable.attemptId, recoveryRequest]);
assert.equal(recovered.ok, true);
assert.equal(recovered.attemptId, recoverable.attemptId);
assert.equal(recovered.status, 'in_progress');
assert.equal(recovered.savedResponseCount, 2);
const after = preservationSnapshot(recoverable.attemptId);
assert.deepEqual(after.stableAttempt, before.stableAttempt);
assert.equal(after.attemptId, before.attemptId);
assert.equal(after.startedAt, before.startedAt);
assert.equal(after.packageId, before.packageId);
assert.equal(after.profileId, before.profileId);
assert.equal(after.itemRows, before.itemRows);
assert.equal(after.responseRows, before.responseRows);
assert.equal(after.protectedRows, before.protectedRows);
assert.equal(after.status, 'in_progress');
assert.equal(Number(after.idleDays), 30);
assert.equal(Number(scalar(`select count(*) from exam_delivery.attempt_results where attempt_id='${recoverable.attemptId}'`)), 0);
assert.equal(Number(scalar(`select count(*) from exam_delivery.review_snapshots where attempt_id='${recoverable.attemptId}'`)), 0);
assert.equal(Number(scalar(`select count(*) from exam_delivery.attempt_recovery_events where attempt_id='${recoverable.attemptId}'`)), 1);
assert.equal(Number(scalar(`select response_count_snapshot from exam_delivery.attempt_recovery_events where attempt_id='${recoverable.attemptId}'`)), 2);
assert.doesNotMatch(scalar(`select to_jsonb(event)::text from exam_delivery.attempt_recovery_events event where attempt_id='${recoverable.attemptId}'`), /fixture-secret|answer|payload/i);
const recoveryReplay = rpc('certsim_protected_recover_study_sandbox', [ids.owner, recoverable.attemptId, recoveryRequest]);
assert.deepEqual(recoveryReplay, recovered);
const secondRecovery = rpc('certsim_protected_recover_study_sandbox', [ids.owner, recoverable.attemptId, randomUUID()]);
assert.equal(secondRecovery.ok, false);
assert.equal(Number(scalar(`select count(*) from exam_delivery.attempt_recovery_events where attempt_id='${recoverable.attemptId}'`)), 1);
expectSqlFailure(`update exam_delivery.attempt_recovery_events set response_count_snapshot=99 where attempt_id='${recoverable.attemptId}'`, /immutable/i);
expectSqlFailure(`delete from exam_delivery.attempt_recovery_events where attempt_id='${recoverable.attemptId}'`, /immutable/i);

const rejectionCases = [
  [zeroResponse, 'zero-response abandoned sandbox'],
  [completed, 'completed sandbox'],
  [expired, 'expired sandbox'],
  [voided, 'voided sandbox'],
  [assigned, 'assigned assessment'],
  [selfDirected, 'self-directed exam'],
  [targeted, 'targeted domain'],
  [weakArea, 'weak area'],
  [pbqPractice, 'PBQ practice'],
  [resultAttempt, 'result-bearing sandbox'],
  [reviewAttempt, 'review-bearing sandbox'],
  [replacementLinked, 'replacement-linked sandbox'],
  [expiryLinked, 'expiry-linked sandbox'],
  [unavailable, 'unavailable package/profile'],
];
for (const [attempt, label] of rejectionCases) {
  assert.equal(rpc('certsim_protected_recover_study_sandbox', [attempt.owner, attempt.attemptId, randomUUID()]).ok, false, `${label} recovered`);
}
const activeAttempt = createAttempt({ owner: ids.conflictOwner, packageId: ids.oldPackage, profileId: ids.oldProfile, questionIds: [ids.oldQuestionA, ids.oldQuestionB], status: 'in_progress', responseCount: 1 });
assert.equal(rpc('certsim_protected_recover_study_sandbox', [ids.conflictOwner, activeAttempt.attemptId, randomUUID()]).ok, false);
const wrongOwnerCandidate = createAttempt({ owner: ids.replayOwner, packageId: ids.currentPackage, profileId: ids.currentProfile, questionIds: [ids.currentQuestionA, ids.currentQuestionB], responseCount: 1 });
assert.deepEqual(rpc('certsim_protected_recover_study_sandbox', [ids.owner, wrongOwnerCandidate.attemptId, randomUUID()]), { ok: false, code: 'attempt_not_found' });

// Direct terminal reversals remain closed for every terminal status.
for (const terminal of [zeroResponse, completed, expired, voided]) {
  expectSqlFailure(`update exam_delivery.attempts set status='in_progress',submitted_at=null,completed_at=null,practice_last_activity_at=statement_timestamp(),practice_idle_expires_at=statement_timestamp()+interval '30 days' where id='${terminal.attemptId}'`, /terminal|lifecycle/i);
}

// An active same normalized exam/profile on another package blocks recovery and
// is neither replaced nor abandoned.
const conflictCandidate = createAttempt({ owner: ids.conflictOwner, packageId: ids.currentPackage, profileId: ids.currentProfile, questionIds: [ids.currentQuestionA, ids.currentQuestionB], responseCount: 1 });
const conflictResult = rpc('certsim_protected_recover_study_sandbox', [ids.conflictOwner, conflictCandidate.attemptId, randomUUID()]);
assert.deepEqual({ ok: conflictResult.ok, code: conflictResult.code }, { ok: false, code: 'active_sandbox_exists' });
assert.equal(scalar(`select status from exam_delivery.attempts where id='${activeAttempt.attemptId}'`), 'in_progress');
assert.equal(Number(scalar(`select count(*) from exam_delivery.attempt_replacements where replaced_attempt_id='${activeAttempt.attemptId}' or replacement_attempt_id='${activeAttempt.attemptId}'`)), 0);
assert.equal(Number(scalar(`select count(*) from exam_delivery.attempt_abandonment_events where attempt_id='${activeAttempt.attemptId}'`)), 0);
assert.deepEqual(rpc('certsim_protected_list_recoverable_study_sandboxes', [ids.conflictOwner, 'issue167fixture', 'standard-profile', 20]).candidates, []);

// Two simultaneous candidates share the canonical binding lock: exactly one
// transition succeeds and only one active sandbox remains.
const concurrentOld = createAttempt({ owner: ids.concurrentOwner, responseCount: 1 });
const concurrentCurrent = createAttempt({ owner: ids.concurrentOwner, packageId: ids.currentPackage, profileId: ids.currentProfile, questionIds: [ids.currentQuestionA, ids.currentQuestionB], responseCount: 1 });
const concurrentResults = await Promise.all([
  concurrentRpc(ids.concurrentOwner, concurrentOld.attemptId, randomUUID()),
  concurrentRpc(ids.concurrentOwner, concurrentCurrent.attemptId, randomUUID()),
]);
assert.equal(concurrentResults.filter((result) => result.ok === true).length, 1);
assert.equal(concurrentResults.filter((result) => result.code === 'active_sandbox_exists').length, 1);
assert.equal(Number(scalar(`select count(*) from exam_delivery.attempts attempt join exam_delivery.package_versions package on package.id=attempt.package_version_id join exam_delivery.package_profiles profile on profile.id=attempt.package_profile_id where attempt.owner_id='${ids.concurrentOwner}' and attempt.status='in_progress' and attempt.purpose='study_sandbox' and exam_delivery.normalize_exam_key(package.exam_key)='issue167fixture' and profile.profile_key='standard-profile'`)), 1);
assert.equal(Number(scalar(`select count(*) from exam_delivery.attempt_recovery_events where actor_id='${ids.concurrentOwner}'`)), 1);

// Same-request concurrency is idempotent and cannot duplicate evidence.
const replayRequest = randomUUID();
const replayResults = await Promise.all([
  concurrentRpc(ids.replayOwner, wrongOwnerCandidate.attemptId, replayRequest),
  concurrentRpc(ids.replayOwner, wrongOwnerCandidate.attemptId, replayRequest),
]);
assert.equal(replayResults.every((result) => result.ok === true && result.attemptId === wrongOwnerCandidate.attemptId), true);
assert.equal(Number(scalar(`select count(*) from exam_delivery.attempt_recovery_events where attempt_id='${wrongOwnerCandidate.attemptId}'`)), 1);

console.log(JSON.stringify({
  status: 'PASS',
  issue: 167,
  abandonment: 'audited-atomic-idempotent',
  recovery: 'owner-bound-preserving-idempotent',
  discovery: 'bounded-safe-isolated',
  concurrency: 'single-active-sandbox',
}));

function preservationSnapshot(attemptId) {
  const value = scalar(`
    select jsonb_build_object(
      'attemptId',attempt.id,
      'status',attempt.status,
      'stableAttempt',to_jsonb(attempt)-array[
        'status','practice_last_activity_at','practice_idle_expires_at'
      ],
      'startedAt',attempt.started_at,
      'packageId',attempt.package_version_id,
      'profileId',attempt.package_profile_id,
      'idleDays',extract(epoch from (attempt.practice_idle_expires_at-attempt.practice_last_activity_at))/86400,
      'itemRows',(select string_agg(item.id::text||'|'||item.presentation_snapshot::text||'|'||item.presentation_hash,';' order by item.presented_question_number) from exam_delivery.attempt_items item where item.attempt_id=attempt.id),
      'responseRows',(select string_agg(response.id::text||'|'||response.attempt_item_id::text||'|'||response.response_payload::text||'|'||response.revision::text,';' order by response.attempt_item_id) from exam_delivery.attempt_responses response where response.attempt_id=attempt.id),
      'protectedRows',(select string_agg(content.attempt_item_id::text||'|'||content.scoring_snapshot::text||'|'||content.review_snapshot::text||'|'||content.protected_snapshot_hash,';' order by content.attempt_item_id) from exam_delivery.attempt_item_protected_content content where content.attempt_id=attempt.id)
    ) from exam_delivery.attempts attempt where attempt.id='${attemptId}'
  `);
  return JSON.parse(value);
}

function rpc(name, args) {
  return JSON.parse(scalar(`select public.${name}(${args.map(sqlLiteral).join(',')})`));
}

function concurrentRpc(actorId, attemptId, requestId) {
  const statement = `select public.certsim_protected_recover_study_sandbox('${actorId}','${attemptId}','${requestId}')`;
  return new Promise((resolve, reject) => {
    const child = spawn(psql, [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ISSUE167_CONCURRENT_RPC_FAILED: ${safeError(stderr)}`));
      try { resolve(JSON.parse(lastLine(stdout))); } catch (error) { reject(error); }
    });
  });
}

function scalar(statement) {
  return lastLine(runSql(statement));
}

function runSql(statement) {
  const result = spawnSync(psql, [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`ISSUE167_SQL_FAILED: ${safeError(result.stderr)}`);
  return result.stdout;
}

function expectSqlFailure(statement, pattern) {
  const result = spawnSync(psql, [databaseUrl, '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', statement], { encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0, 'expected SQL command to fail closed');
  assert.match(result.stderr, pattern);
}

function sqlLiteral(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
}

function lastLine(value) {
  return value.trim().split(/\r?\n/).at(-1) ?? '';
}

function safeError(value) {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').replace(/fixture-secret[^\s]*/gi, '[REDACTED]').slice(0, 500);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`MISSING_${name}`);
  return value;
}
