import { createClient } from '@supabase/supabase-js';
import { spawnSync } from 'node:child_process';

const url = required('SUPABASE_URL');
const anonKey = required('SUPABASE_ANON_KEY');
const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');
const databaseUrl = required('SUPABASE_DB_URL');
const admin = client(serviceKey);

const owner = await createUser('owner');
const learner = await createUser('learner');
const concurrentLearner = await createUser('concurrent');
const recoveryLearner = await createUser('recovery');
const other = await createUser('other');
const metadataImpostor = await createUser('metadata', { role: 'platform_owner' });
const organisationId = crypto.randomUUID();
const otherOrganisationId = crypto.randomUUID();

sql(`
  insert into public.organisations(id,name,organisation_type,status) values
    ('${organisationId}','Assignment integration org','internal','active'),
    ('${otherOrganisationId}','Other assignment org','internal','active');
  insert into public.memberships(user_id,organisation_id,role,status) values
    ('${owner.id}','${organisationId}','platform_owner','active'),
    ('${learner.id}','${organisationId}','student','active'),
    ('${concurrentLearner.id}','${organisationId}','student','active'),
    ('${recoveryLearner.id}','${organisationId}','student','active'),
    ('${other.id}','${otherOrganisationId}','student','active');
`);

const request = {
  p_target_user_id: learner.id,
  p_organisation_id: organisationId,
  p_package_version: '1.0.0',
  p_profile_key: 'ai901-controlled-beta-compact',
  p_available_from: new Date(Date.now() - 60_000).toISOString(),
  p_expires_at: null,
  p_maximum_attempts: 1,
  p_review_release_policy: 'never',
  p_answer_release_policy: 'never',
};

await expectRpcDenied(client(anonKey), 'certsim_protected_create_assignment', request, 'ANON');
await expectRpcDenied(admin, 'certsim_protected_create_assignment', request, 'SERVICE_ROLE');
await expectRpcDenied(await signedIn(learner), 'certsim_protected_create_assignment', request, 'LEARNER');
await expectRpcDenied(await signedIn(metadataImpostor), 'certsim_protected_create_assignment', request, 'USER_METADATA');
await expectRpcDenied(await signedIn(owner), 'certsim_protected_create_assignment', { ...request, p_target_user_id: other.id }, 'CROSS_ORG');
await expectRpcDenied(await signedIn(owner), 'certsim_protected_create_assignment', { ...request, p_profile_key: 'missing-profile' }, 'MISMATCHED_PROFILE');

const ownerClient = await signedIn(owner);
const created = await ownerClient.rpc('certsim_protected_create_assignment', request);
if (created.error || created.data?.profileKey !== 'ai901-controlled-beta-compact' || created.data?.maximumAttempts !== 1) fail('OWNER_ASSIGNMENT_FAILED');
await expectRpcDenied(ownerClient, 'certsim_protected_create_assignment', request, 'DUPLICATE');

let eligibility = await admin.rpc('certsim_protected_check_eligibility', { p_actor_id: learner.id, p_exam_key: 'ai-901', p_profile_key: request.p_profile_key });
expectCode(eligibility, 'pilot_disabled');
sql(`update exam_delivery.pilot_gates set enabled=true,enabled_at=now(),disabled_at=null where exam_key='ai-901'`);
eligibility = await admin.rpc('certsim_protected_check_eligibility', { p_actor_id: learner.id, p_exam_key: 'ai-901', p_profile_key: request.p_profile_key });
expectCode(eligibility, 'not_allowlisted');
sql(`insert into exam_delivery.pilot_access(user_id,exam_key,enabled,access_starts_at) values ('${learner.id}','ai-901',true,now()-interval '1 minute')`);
eligibility = await admin.rpc('certsim_protected_check_eligibility', { p_actor_id: learner.id, p_exam_key: 'ai-901', p_profile_key: request.p_profile_key });
if (eligibility.error || eligibility.data?.eligible !== true || eligibility.data?.remainingAttempts !== 1) fail('ELIGIBILITY_FAILED');

const requestId = crypto.randomUUID();
const startArgs = { p_actor_id: learner.id, p_exam_key: 'ai-901', p_profile_key: request.p_profile_key, p_request_id: requestId };
const first = await admin.rpc('certsim_protected_start_attempt', startArgs);
const attemptId = first.data?.attempt?.attemptId;
if (first.error || first.data?.ok !== true || !attemptId) fail('START_FAILED');
const replay = await admin.rpc('certsim_protected_start_attempt', startArgs);
if (replay.error || replay.data?.attempt?.attemptId !== attemptId) fail('IDEMPOTENT_REPLAY_FAILED');
const second = await admin.rpc('certsim_protected_start_attempt', { ...startArgs, p_request_id: crypto.randomUUID() });
expectCode(second, 'attempt_limit_reached');

const unownedResult = await admin.rpc('certsim_protected_get_result', { p_actor_id: other.id, p_attempt_id: attemptId });
expectCode(unownedResult, 'attempt_not_found');
const submitted = await admin.rpc('certsim_protected_submit_attempt', { p_actor_id: learner.id, p_attempt_id: attemptId, p_submission_id: crypto.randomUUID() });
if (submitted.error || submitted.data?.ok !== true) fail('SUBMIT_FAILED');
const review = await admin.rpc('certsim_protected_get_review', { p_actor_id: learner.id, p_attempt_id: attemptId });
expectCode(review, 'review_unavailable');

const recoveryRequest = { ...request, p_target_user_id: recoveryLearner.id };
const recoveryAssignment = await ownerClient.rpc('certsim_protected_create_assignment', recoveryRequest);
if (recoveryAssignment.error || recoveryAssignment.data?.maximumAttempts !== 1) fail('RECOVERY_ASSIGNMENT_FAILED');
sql(`insert into exam_delivery.pilot_access(user_id,exam_key,enabled,access_starts_at) values ('${recoveryLearner.id}','ai-901',true,now()-interval '1 minute')`);
const recoveryStartArgs = { p_actor_id: recoveryLearner.id, p_exam_key: 'ai-901', p_profile_key: request.p_profile_key, p_request_id: crypto.randomUUID() };
const interrupted = await admin.rpc('certsim_protected_start_attempt', recoveryStartArgs);
const interruptedId = interrupted.data?.attempt?.attemptId;
if (interrupted.error || !interruptedId) fail('INTERRUPTED_START_FAILED');
const current = await admin.rpc('certsim_protected_resume_current_attempt', { p_actor_id: recoveryLearner.id, p_exam_key: 'ai-901', p_profile_key: request.p_profile_key });
if (current.error || current.data?.attempt?.attemptId !== interruptedId) fail('CURRENT_ATTEMPT_FAILED');
const crossUserCurrent = await admin.rpc('certsim_protected_resume_current_attempt', { p_actor_id: other.id, p_exam_key: 'ai-901', p_profile_key: request.p_profile_key });
expectCode(crossUserCurrent, 'not_allowlisted');
sql(`alter table exam_delivery.attempts disable trigger guard_attempt_identity_and_lifecycle; update exam_delivery.attempts set created_at=created_at-interval '31 minutes',started_at=started_at-interval '31 minutes',expires_at=expires_at-interval '31 minutes' where id='${interruptedId}'::uuid; alter table exam_delivery.attempts enable trigger guard_attempt_identity_and_lifecycle`);
const expiredCurrent = await admin.rpc('certsim_protected_resume_current_attempt', { p_actor_id: recoveryLearner.id, p_exam_key: 'ai-901', p_profile_key: request.p_profile_key });
expectCode(expiredCurrent, 'attempt_expired');
await expectRpcDenied(await signedIn(recoveryLearner), 'certsim_protected_authorize_unique_ai901_recovery', { p_reason_code: 'operator_harness_response_serialization_failure' }, 'LEARNER_RECOVERY');
const recovered = await ownerClient.rpc('certsim_protected_authorize_unique_ai901_recovery', { p_reason_code: 'operator_harness_response_serialization_failure' });
if (recovered.error || recovered.data?.interruptedStatus !== 'voided' || recovered.data?.maximumRecoveries !== 1) fail('OWNER_RECOVERY_FAILED');
await expectRpcDenied(ownerClient, 'certsim_protected_authorize_unique_ai901_recovery', { p_reason_code: 'operator_harness_response_serialization_failure' }, 'DUPLICATE_RECOVERY');
const replacementStarts = await Promise.all([
  admin.rpc('certsim_protected_start_attempt', { ...recoveryStartArgs, p_request_id: crypto.randomUUID() }),
  admin.rpc('certsim_protected_start_attempt', { ...recoveryStartArgs, p_request_id: crypto.randomUUID() }),
]);
const replacementSuccess = replacementStarts.filter(({ error, data }) => !error && data?.attempt?.attemptId);
const replacementDenial = replacementStarts.filter(({ error, data }) => !error && data?.code === 'attempt_limit_reached');
if (replacementSuccess.length !== 1 || replacementDenial.length !== 1) fail('RECOVERY_CONCURRENCY_FAILED');
const replacementId = replacementSuccess[0].data.attempt.attemptId;
const replacementSubmitted = await admin.rpc('certsim_protected_submit_attempt', { p_actor_id: recoveryLearner.id, p_attempt_id: replacementId, p_submission_id: crypto.randomUUID() });
if (replacementSubmitted.error || replacementSubmitted.data?.ok !== true) fail('RECOVERY_SUBMIT_FAILED');
await expectRpcDenied(ownerClient, 'certsim_protected_authorize_technical_recovery', { p_attempt_id: replacementId, p_reason_code: 'operator_harness_response_serialization_failure' }, 'SUBMITTED_RECOVERY');
sql(`select 1/((count(*)=1 and bool_and(reason_code='operator_harness_response_serialization_failure') and bool_and(replacement_attempt_id is not null))::integer) from exam_delivery.attempt_technical_recoveries where protected_assignment_id=(select protected_assignment_id from exam_delivery.attempts where id='${interruptedId}'::uuid)`);

const concurrentRequest = { ...request, p_target_user_id: concurrentLearner.id };
const concurrentAssignment = await ownerClient.rpc('certsim_protected_create_assignment', concurrentRequest);
if (concurrentAssignment.error || concurrentAssignment.data?.maximumAttempts !== 1) fail('CONCURRENT_ASSIGNMENT_FAILED');
sql(`insert into exam_delivery.pilot_access(user_id,exam_key,enabled,access_starts_at) values ('${concurrentLearner.id}','ai-901',true,now()-interval '1 minute')`);
const concurrentArgs = { p_actor_id: concurrentLearner.id, p_exam_key: 'ai-901', p_profile_key: request.p_profile_key };
const concurrentStarts = await Promise.all([
  admin.rpc('certsim_protected_start_attempt', { ...concurrentArgs, p_request_id: crypto.randomUUID() }),
  admin.rpc('certsim_protected_start_attempt', { ...concurrentArgs, p_request_id: crypto.randomUUID() }),
]);
const concurrentSuccesses = concurrentStarts.filter(({ error, data }) => !error && data?.ok === true);
const concurrentDenials = concurrentStarts.filter(({ error, data }) => !error && data?.code === 'attempt_limit_reached');
if (concurrentSuccesses.length !== 1 || concurrentDenials.length !== 1) fail('CONCURRENT_START_SERIALIZATION_FAILED');

sql(`select 1/((count(*)=1 and bool_and(protected_assignment_id is not null))::integer) from exam_delivery.attempts where owner_id='${learner.id}'::uuid`);
console.log(JSON.stringify({ status: 'PASS', profile: request.p_profile_key, maximumAttempts: 1, assignmentAuthority: 'platform_owner', idempotency: 'preserved', secondAttempt: 'rejected', concurrentStarts: 'one-created', technicalRecovery: 'one-audited-replacement', currentAttempt: 'identity-derived', review: 'withheld' }, null, 2));

function client(key) { return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }); }
function required(name) { const value = process.env[name]?.trim(); if (!value) fail(`MISSING_${name}`); return value; }
function fail(code) { throw new Error(code); }
function sql(statement) { const result = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-c', statement], { stdio: 'ignore' }); if (result.status !== 0) fail('SQL_FIXTURE_FAILED'); }
async function createUser(label, userMetadata = {}) {
  const email = `assignment-${label}-${crypto.randomUUID()}@example.invalid`;
  const password = `T!${crypto.randomUUID()}z7`;
  const result = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: userMetadata });
  if (result.error) fail('AUTH_FIXTURE_FAILED');
  return { id: result.data.user.id, email, password };
}
async function signedIn(user) { const result = client(anonKey); const auth = await result.auth.signInWithPassword({ email: user.email, password: user.password }); if (auth.error) fail('SIGN_IN_FAILED'); return result; }
async function expectRpcDenied(rpcClient, name, args, label) { const result = await rpcClient.rpc(name, args); if (!result.error) fail(`${label}_NOT_DENIED`); }
function expectCode(result, code) { if (result.error || result.data?.code !== code && result.data?.reasonCode !== code) fail(`EXPECTED_${code.toUpperCase()}`); }
