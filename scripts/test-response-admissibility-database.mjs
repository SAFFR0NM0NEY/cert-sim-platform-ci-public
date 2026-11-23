import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { sha256Canonical } from './backend-exam-publication/canonical-json.mjs';
import { RESPONSE_ADMISSIBILITY_CASES, responseCaseCandidate, mixedResponseCandidate, correctSyntheticResponse, MIXED_POLICIES } from './fixtures/response-admissibility.mjs';

const phase = process.argv.includes('--before') ? 'before' : 'after';
const db = process.env.SUPABASE_DB_URL, api = process.env.SUPABASE_URL;
for (const value of [db, api]) if (!value || !['127.0.0.1','localhost','[::1]'].includes(new URL(value).hostname)) throw Error('DISPOSABLE_RESPONSE_PROOF_REQUIRED');
if (!process.env.RUNNER_TEMP) throw Error('DISPOSABLE_TEMP_REQUIRED');
const root = phase === 'before' ? process.env.RESPONSE_ORIGINAL_SOURCE : process.cwd();
if (!root) throw Error('EXACT_ORIGINAL_SOURCE_REQUIRED');
const { validateExamOperationsCandidate } = await import(pathToFileURL(path.join(root, 'scripts/backend-exam-publication/exam-operations-candidate.mjs')).href);
const client = key => createClient(api, key, { auth: { persistSession: false, autoRefreshToken: false } });
const admin = client(process.env.SUPABASE_SERVICE_ROLE_KEY);
let assertions = 0;
const eq = (a, b, label) => { assert.deepEqual(a, b, label); assertions++; };
function sql(input) {
  const r = spawnSync('psql', [db, '-XqAt', '-v', 'ON_ERROR_STOP=1'], { input, encoding: 'utf8' });
  if (r.status) throw Error('SYNTHETIC_RESPONSE_SQL_FAILED');
  return r.stdout.trim();
}
const quoted = v => '$response$' + JSON.stringify(v) + '$response$::jsonb';
async function user(label) {
  const email = `response-${label}-${crypto.randomUUID()}@example.invalid`, password = `T!${crypto.randomUUID()}f8`;
  const r = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (r.error) throw Error('SYNTHETIC_AUTH_FAILED');
  return { id: r.data.user.id, email, password };
}
const owner = await user('owner'), learner = await user('learner'), org = crypto.randomUUID();
sql(`update public.profiles set status='active',default_role='platform_owner',user_type='platform' where id='${owner.id}';
 insert into public.organisations(id,name,organisation_type,status) values('${org}','Synthetic response proof','internal','active');
 insert into public.memberships(user_id,organisation_id,role,status) values('${owner.id}','${org}','platform_owner','active'),('${learner.id}','${org}','student','active');`);
const ownerClient = client(process.env.SUPABASE_ANON_KEY);
eq((await ownerClient.auth.signInWithPassword(owner)).error, null, 'owner auth');
async function publish(c) {
  // Hash the actual mutated payload; never reuse the original candidate hash.
  return ownerClient.rpc('certsim_protected_publish_package', { p_request: {
    publicationRequestId: crypto.randomUUID(), sourceCommitSha: 'd'.repeat(40), packagePayload: c, packageHash: sha256Canonical(c),
  } });
}
function enable(c, actors = [learner.id]) {
  const exam = c.exam.examKey;
  const pkg = sql(`select id from exam_delivery.package_versions where exam_key='${exam}' and package_version='${c.exam.packageVersion}'`);
  sql(`insert into public.exam_catalog(exam_key,slug,title,lifecycle,exam_type) values('${exam}','${exam}','Synthetic response','test','certification') on conflict (exam_key) do nothing;
   insert into exam_delivery.exam_access_policies(canonical_exam_key,access_mode,enabled,enabled_at,require_assignment) values('${exam}','open_authenticated',true,now(),false) on conflict (canonical_exam_key) do nothing;`);
  for (const p of c.profiles) {
    const profile = sql(`select id from exam_delivery.package_profiles where package_version_id='${pkg}' and profile_key='${p.profileKey}'`);
    sql(`insert into exam_delivery.exam_profile_activations(package_version_id,package_profile_id,enabled,activation_kind,enabled_at,created_by) values('${pkg}','${profile}',true,'production',now(),'${owner.id}');
     insert into exam_delivery.practice_policies(canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,maximum_completed_attempts,maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy)
     values('${exam}','${c.exam.packageVersion}','${p.profileKey}','self_directed_exam','production_authorized',true,null,50,false,'after_submission','after_submission');
     insert into exam_delivery.package_profile_defaults(canonical_exam_key,profile_key,purpose,package_version_id,package_profile_id,configured_by)
     values('${exam}','${p.profileKey}','self_directed_exam','${pkg}','${profile}','${owner.id}') on conflict (canonical_exam_key,profile_key,purpose) do update set package_version_id=excluded.package_version_id,package_profile_id=excluded.package_profile_id;`);
    for (const actor of actors) sql(`insert into exam_delivery.exam_entitlements(package_version_id,package_profile_id,target_type,learner_id,enabled,valid_from,reason_code,created_by)
     values('${pkg}','${profile}','learner','${actor}',true,now()-interval '1 minute','synthetic_response','${owner.id}');`);
  }
}
async function start(c, profile = c.profiles[0].profileKey, actor = learner.id) {
  const r = await admin.rpc('certsim_protected_count_contract', { p_actor_id: actor, p_operation: 'practiceStart',
    p_arguments: { p_request: { examKey: c.exam.examKey, profileId: profile, purpose: 'self_directed_exam', language: 'not_applicable', includePbqs: true, mixStrategy: 'balanced', clientRequestId: crypto.randomUUID() } },
    p_count_contract: 'certsim-authorised-form-count-v1' });
  eq(r.error, null, 'normal start transport'); eq(r.data.ok, true, 'normal start');
  return r.data;
}
const save = (a, item, response, revision = 0, request = crypto.randomUUID()) => admin.rpc('certsim_protected_save_response', {
  p_actor_id: learner.id, p_attempt_id: a.attempt.attemptId, p_item_id: item.itemId, p_response: response, p_expected_revision: revision, p_request_id: request,
});
async function submit(a, expectedEarned, expectedMaximum) {
  const r = await admin.rpc('certsim_protected_submit_attempt', { p_actor_id: learner.id, p_attempt_id: a.attempt.attemptId, p_submission_id: crypto.randomUUID() });
  eq(r.error, null, 'normal submit'); eq(r.data.ok, true, 'completed');
  const id = a.attempt.attemptId;
  const actual = JSON.parse(sql(`select jsonb_build_array(raw_score,max_score,(result_summary->>'questionCount')::integer) from exam_delivery.attempt_results where attempt_id='${id}'`));
  eq(actual, [expectedEarned, expectedMaximum, a.items.length], 'actual immutable result denominator');
  eq(sql(`select count(*) from exam_delivery.attempt_results where attempt_id='${id}'`), '1', 'one authoritative result');
  eq(sql(`select count(*) from public.exam_results where attempt_id='${id}'`), '1', 'one history projection');
  return actual;
}
const matrix = [], failures = [];
for (const [index, entry] of RESPONSE_ADMISSIBILITY_CASES.entries()) {
  const c = responseCaseCandidate(entry, `response217${phase}${index}`), preflight = validateExamOperationsCandidate(c);
  eq(preflight.ok, phase === 'before' ? entry.beforeJs : entry.accepted, 'matrix preflight ' + entry.id);
  const r = await publish(c), accepted = !r.error && r.data?.ok === true;
  eq(accepted, phase === 'before' ? entry.beforePublication : entry.accepted, 'matrix publication ' + entry.id);
  if (!accepted) {
    // Failure audit rows may legitimately be written. No usable package/children may survive.
    eq(sql(`select count(*) from exam_delivery.package_versions where exam_key='${c.exam.examKey}'`), '0', 'atomic publication rollback');
    eq(sql(`select count(*) from exam_delivery.package_forms f join exam_delivery.package_versions v on v.id=f.package_version_id where v.exam_key='${c.exam.examKey}'`), '0');
    if (phase === 'after') {
      eq(r.error?.code, '22023', 'controlled invalid-input SQLSTATE');
      eq(/^variable_form_[a-z_]+$/.test(r.error?.message ?? ''), true, 'safe controlled validation error');
    }
    failures.push({ case: entry.id, code: r.error?.code, controlled: phase === 'after' });
    if (phase === 'before' && entry.id === 'scored-type-0') {
      eq(preflight.ok, true); eq(r.error?.code, '22023');
      eq(r.error?.message, 'variable_form_response_invalid');
      console.log(JSON.stringify({ suite: 'response-original-scored-disagreement', preflightAccepted: true, publicationRejected: true, sqlstate: r.error.code, safeError: r.error.message }));
    }
  }
  matrix.push({ case: entry.id, expected: entry.accepted, preflight: preflight.ok, published: accepted, sqlstate: r.error?.code ?? null });
  if (phase === 'before' && ['matching-shared-omitted','matching-shared-false','matching-policy-type-2'].includes(entry.id)) {
    enable(c); const first = await start(c); await submit(first, 0, 6);
    const a = await start(c), item = a.items.find(i => i.questionType === 'matching-v1'), q = c.questions.find(q => q.id === item.questionId);
    const rejected = await save(a, item, correctSyntheticResponse(q));
    eq(Boolean(rejected.error) || rejected.data?.ok === false, true, 'original full correct response rejected');
    eq(sql(`select count(*) from exam_delivery.attempt_responses where attempt_id='${a.attempt.attemptId}' and attempt_item_id='${item.itemId}'`), '0');
    if (entry.id === 'matching-policy-type-2') eq(rejected.error?.code, '22P02', 'actual malformed policy cast');
    else {
      const partial = await save(a, item, { answer: { a: 'x', b: 'y' } }); eq(partial.error, null); eq(partial.data.revision, 1);
      for (const other of a.items.filter(i => i.itemId !== item.itemId)) {
        const saved = await save(a, other, correctSyntheticResponse(c.questions.find(q => q.id === other.questionId))); eq(saved.error, null);
      }
      await submit(a, 9, 10);
    }
    console.log(JSON.stringify({ suite: 'response-original-save-consequence', case: entry.id, fullCorrectSaveRejected: true, sqlstate: rejected.error?.code ?? rejected.data?.code, manufacturedEvidence: false }));
  }
}
console.log(JSON.stringify({ suite: 'response-publication-matrix', phase, rows: matrix.length, accepted: matrix.filter(x => x.published).length, rejected: matrix.filter(x => !x.published).length, matchingJsSqlParity: matrix.every(x => x.preflight === x.published), assertions, syntheticOnly: true }));
await writeFile(path.join(process.env.RUNNER_TEMP, `response-${phase}-matrix.json`), JSON.stringify({ phase, matrix, failures, assertions }), { mode: 0o600 });

const mixed = mixedResponseCandidate(), browserUsers = [];
for (const policy of MIXED_POLICIES) browserUsers.push({ policy, ...await user('browser-' + policy) });
sql(`insert into public.memberships(user_id,organisation_id,role,status) values ${browserUsers.map(u => `('${u.id}','${org}','student','active')`).join(',')}`);
const published = await publish(mixed); eq(published.error, null); eq(published.data.ok, true);
enable(mixed, [learner.id, ...browserUsers.map(u => u.id)]);
const credit = [];
for (const policy of MIXED_POLICIES) {
  for (const turn of [0,1,2,3]) {
    const a = await start(mixed, `response-${policy}`), maximum = a.items.length === 4 ? 8 : 10;
    eq((Date.parse(a.attempt.expiresAt)-Date.parse(a.attempt.startedAt))/1000, 2700);
    const matchingItem = a.items.find(i => i.questionType === 'matching-v1');
    for (const item of a.items) {
      const q = mixed.questions.find(q => q.id === item.questionId);
      if (turn > 1 && item !== matchingItem) continue;
      let response = correctSyntheticResponse(q);
      if (turn === 2) response = { answer: { a: 'x' } };
      if (turn === 3) response = { answer: policy === 'true' ? { a: 'y', b: 'y' } : { a: 'y', b: 'x' } };
      if (item === matchingItem && policy !== 'true') {
        const invalid = await save(a, item, { answer: { a: 'x', b: 'x' } });
        eq(Boolean(invalid.error) || invalid.data?.ok === false, true, 'forbidden learner reuse remains denied');
      }
      eq(sql(`select exam_delivery.package_v2_response_valid('${q.type}',${quoted(q.presentation)},${quoted(response)})`), 't', 'actual response validator');
      const request = crypto.randomUUID(), saved = await save(a, item, response, 0, request);
      eq(saved.error, null); eq(saved.data.revision, 1, 'normal revision');
      const replay = await save(a, item, response, 0, request); eq(replay.error, null); eq(replay.data.revision, 1, 'save replay');
      eq(JSON.parse(sql(`select response_payload from exam_delivery.attempt_responses where attempt_id='${a.attempt.attemptId}' and attempt_item_id='${item.itemId}'`)), response, 'persisted answer');
      const scored = JSON.parse(sql(`select exam_delivery.score_package_v2_response('${q.type}',${quoted(q.privateScoring)},(select response_payload from exam_delivery.attempt_responses where attempt_id='${a.attempt.attemptId}' and attempt_item_id='${item.itemId}'),true)`));
      const itemMaximum = q.type === 'true-false-single-v1' ? 1 : q.type === 'code-dropdown-completion-v1' ? 3 : 2;
      eq(scored.maximum, itemMaximum, 'independent per-family actual scorer maximum');
      eq(scored.earned, turn < 2 ? itemMaximum : turn === 2 ? 1 : 0, 'actual persisted-response scorer credit');
    }
    const earned = turn < 2 ? maximum : turn === 2 ? 1 : 0;
    const actual = await submit(a, earned, maximum);
    credit.push({ policy, mode: turn < 2 ? 'full' : turn === 2 ? 'partial-matching' : 'wrong-admissible-matching', count: a.items.length, earned: actual[0], maximum: actual[1] });
  }
}
console.log(JSON.stringify({ suite: 'response-four-family-save-scoring', phase, assertions, results: credit, allFullCreditAttainable: true, directCompletedOrEvidenceInserts: 0, syntheticOnly: true }));
// Publish each browser policy under the runner's registered profile identity.
// Only disposable access/default scaffolding selects the package before a test.
for (const account of browserUsers) {
  const c = mixedResponseCandidate();
  c.exam.packageVersion = `browser-${account.policy}.1`;
  c.profiles = [c.profiles.find(p => p.profileKey === `response-${account.policy}`)];
  c.profiles[0].profileKey = 'inf303-standard';
  const publication = await publish(c); eq(publication.error, null); eq(publication.data.ok, true);
  enable(c, [account.id]);
  account.packageVersion = c.exam.packageVersion;
}
await writeFile(path.join(process.env.RUNNER_TEMP, 'response-browser-accounts.json'), JSON.stringify(browserUsers), { mode: 0o600 });
await writeFile(path.join(process.env.RUNNER_TEMP, `response-${phase}-proof.json`), JSON.stringify({ phase, assertions, publicationMatrix: matrix, credit, syntheticOnly: true }), { mode: 0o600 });
