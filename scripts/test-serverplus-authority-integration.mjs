// Private CI only. Real Auth/PostgREST/PostgreSQL; private payloads stay in memory/stdin.
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { assertDisposableTargets } from './assert-disposable-targets.mjs';
import { syntheticSc100 } from './sc100-compatibility/synthetic-fixture.mjs';
import { sha256Canonical as sha } from './backend-exam-publication/canonical-json.mjs';
import { SERVERPLUS_CONTRACT, preflightServerPlusPublication, issueServerPlusPublicationIntent, loadServerPlusPublicationPackage, publishServerPlusWithIntent } from './serverplus-publication/serverplus-authority.mjs';

const api = process.env.SUPABASE_URL, db = process.env.SUPABASE_DB_URL;
assertDisposableTargets(api, db);
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== 'SAFFR0NM0NEY/cert-sim-protected-content' || !process.env.CERTSIM_PRIVATE_CONTENT_ROOT) throw Error('PRIVATE_DISPOSABLE_CI_ONLY');
const root = process.env.CERTSIM_PRIVATE_CONTENT_ROOT, temp = process.env.RUNNER_TEMP;
let assertions = 0, stage = 'setup', warm;
const gate = (condition, code) => { assertions++; if (!condition) throw Error(String(code).toUpperCase().replace(/[^A-Z0-9_]/g,'_')); };
const eq = (a, b, code) => gate(JSON.stringify(a) === JSON.stringify(b), code);
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const json = value => quote(JSON.stringify(value)) + '::jsonb';
const pgEnv = { ...process.env, PGOPTIONS: '-c client_min_messages=error' };
const sql = query => {
  const result = spawnSync('psql', [db, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate'], { input: query, encoding: 'utf8', env: pgEnv });
  if (result.status !== 0) { const state = result.stderr?.match(/(?:ERROR|FATAL):\s+([0-9A-Z]{5})(?:\s|:)/)?.[1] ?? 'UNAVAILABLE'; throw Error('SQL_FIXTURE_FAILED_' + state); }
  assertions++;
  return result.stdout.trim();
};
class Session {
  constructor() {
    this.output = ''; this.pending = [];
    this.child = spawn('psql', [db, '-XqAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate'], { stdio: ['pipe', 'pipe', 'pipe'], env: pgEnv });
    this.child.stdout.setEncoding('utf8'); this.child.stderr.on('data', () => {});
    this.child.stdout.on('data', value => { this.output += value; const p = this.pending[0]; if (p && this.output.includes(p.end)) { const out = this.output.slice(0, this.output.indexOf(p.end)); this.output = this.output.slice(this.output.indexOf(p.end) + p.end.length); this.pending.shift(); p.resolve(out.trim()); } });
    this.child.on('close', () => { for (const p of this.pending) p.reject(Error('WARM_SESSION_FAILED')); this.pending = []; });
  }
  run(query) { return new Promise((resolve, reject) => { const end = 'END_' + crypto.randomUUID().replaceAll('-', ''); this.pending.push({ end, resolve, reject }); this.child.stdin.write(query + '\n\\echo ' + end + '\n'); }); }
  close() { this.child.stdin.end(); }
}
const client = token => createClient(api, process.env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false }, ...(token ? { global: { headers: { Authorization: 'Bearer ' + token } } } : {}) });
const admin = createClient(api, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const cases = [];
async function denied(c, name, args, label, code) {
  const result = await c.rpc(name, args);
  gate(!!result.error, 'DENIAL_REQUIRED_' + label);
  if (code) eq(result.error.code, code, 'DENIAL_CODE_' + label);
  cases.push({ label, code: result.error.code });
}
const request = (intent, candidate) => ({ p_request: { contractVersion: SERVERPLUS_CONTRACT, intentId: intent.intentId, request: { publicationRequestId: intent.publicationRequestId, sourceCommitSha: intent.applicationSourceSha, packagePayload: candidate, packageHash: sha(candidate) } } });
let approvalSerial = 900000;
const approval = () => 'https://github.com/SAFFR0NM0NEY/cert-sim-platform/issues/222#issuecomment-' + (++approvalSerial);

async function main() {
  eq(sql('select count(*) from supabase_migrations.schema_migrations'), '101', 'BEFORE_102');
  const issuer = spawnSync('python3', [root + '/reviews/serverplus-sk0005/package/configure-authority-test-issuer.py'], { encoding: 'utf8' });
  gate(issuer.status === 0, 'LOCAL_AUTH_ISSUER_CONFIGURATION');
  let healthy = false;
  for (let n = 0; n < 30; n++) { try { if ((await fetch(api + '/auth/v1/health', { headers: { apikey: process.env.SUPABASE_ANON_KEY } })).ok) { healthy = true; break; } } catch {} await new Promise(resolve => setTimeout(resolve, 1000)); }
  gate(healthy, 'LOCAL_AUTH_READY');
  const org = crypto.randomUUID();
  sql(`insert into public.organisations(id,name,organisation_type,status) values('${org}','Authority fixture','internal','active')`);
  async function actor(role, profileStatus = 'active') {
    const email = crypto.randomUUID() + '@example.invalid', password = 'T!' + crypto.randomUUID();
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true }); gate(!created.error, 'SYNTHETIC_AUTH_CREATE');
    const id = created.data.user.id;
    sql(`update public.profiles set status=${quote(profileStatus)} where id='${id}';insert into public.memberships(user_id,organisation_id,role,status) values('${id}','${org}',${quote(role)},'active')`);
    const c = client(), signed = await c.auth.signInWithPassword({ email, password }); gate(!signed.error, 'REAL_AUTH_SIGNIN');
    const claims = JSON.parse(Buffer.from(signed.data.session.access_token.split('.')[1], 'base64url'));
    eq(claims.iss, 'https://qngnoctsdhzcpagesvxz.supabase.co/auth/v1', 'REAL_AUTH_ISSUER');
    return { id, c, claims, token: signed.data.session.access_token };
  }
  const owner = await actor('platform_owner'), other = await actor('platform_owner'), staff = await actor('trainer'), learner = await actor('student'), inactive = await actor('platform_owner', 'suspended');
  const candidate = (await import(pathToFileURL(root + '/serverplus-package-candidate.mjs'))).buildServerPlusCandidate('READ_ONLY_SOURCE_QUALIFICATION', '1.0.0');
  eq(sha(candidate), '26e2caf5a3a838ea274f09938076a734aa734e14cb5535ff11a4203c05fdfefe', 'FINAL_IMMUTABLE_HASH');
  const unrelated = syntheticSc100(); unrelated.exam.examKey = 'serverpluspreservation';
  const unrelatedRequest = { publicationRequestId: crypto.randomUUID(), sourceCommitSha: process.env.CERTSIM_SOURCE_SHA, packagePayload: unrelated, packageHash: sha(unrelated) };
  const first = await owner.c.rpc('certsim_protected_publish_package', { p_request: unrelatedRequest }); gate(!first.error, 'LEGACY_GENERIC_BEFORE_102');
  warm = new Session();
  await warm.run(`set role authenticated;select set_config('request.jwt.claims',${quote(JSON.stringify(owner.claims))},false);select public.certsim_protected_publish_package(${json(unrelatedRequest)});prepare old_direct(jsonb) as select exam_delivery.publish_package_v2($1);`);
  stage = 'migration102';
  const up = spawnSync('npx', ['--yes', 'supabase@2.114.0', '--agent', 'no', '--workdir', temp + '/certsim-compact-combined', 'migration', 'up', '--local'], { encoding: 'utf8' });
  gate(up.status === 0, 'MIGRATION_102_APPLIED_ISOLATED');
  eq(sql('select count(*) from supabase_migrations.schema_migrations'), '102', 'COMPLETE_102_CHAIN');
  await warm.run(`do $test$ begin begin perform public.certsim_protected_publish_package(${json({ ...unrelatedRequest, packagePayload: candidate, packageHash: sha(candidate) })});raise exception 'WARM_BYPASS';exception when sqlstate '42501' then null;end;end $test$;`);
  await warm.run(`do $test$ begin begin execute 'execute old_direct('||quote_literal(${json({ ...unrelatedRequest, packagePayload: candidate, packageHash: sha(candidate) })}::text)||'::jsonb)';raise exception 'PREPARED_BYPASS';exception when sqlstate '42501' then null;end;end $test$;`);
  warm.close(); warm = null; assertions += 2;
  const legacy = await owner.c.rpc('certsim_protected_publish_package', { p_request: unrelatedRequest }); gate(!legacy.error && legacy.data.classification === 'idempotent_replay', 'UNRELATED_LEGACY_REPLAY_PRESERVED');
  const original = sql("select md5(to_jsonb(v)::text) from exam_delivery.package_versions v where exam_key='serverpluspreservation'");
  stage = 'authority_negatives';
  const preflight = await preflightServerPlusPublication(owner.c);
  const issueArgs = () => ({ p_request: { contractVersion: SERVERPLUS_CONTRACT, identity: structuredClone(preflight.identity), expectedStateHash: preflight.stateHash, releaseDiffHash: preflight.releaseDiffHash, approvalReference: approval(), confirmation: 'ISSUE_SERVERPLUS_1_0_0_ONCE', applicationSourceSha: process.env.CERTSIM_SOURCE_SHA, protectedSourceSha: process.env.GITHUB_SHA } });
  for (const [name, c] of [['anon', client()], ['learner', learner.c], ['staff', staff.c], ['inactive', inactive.c]]) await denied(c, 'certsim_serverplus_issue_publication_intent', issueArgs(), name);
  const inspect = JSON.parse(spawnSync('docker', ['inspect', 'supabase_auth_certsim-backend-exam-delivery-validation'], { encoding: 'utf8' }).stdout)[0];
  const secret = inspect.Config.Env.find(value => value.startsWith('GOTRUE_JWT_SECRET=')).slice('GOTRUE_JWT_SECRET='.length);
  const signed = (claims, key) => { const data = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url') + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url'); return data + '.' + createHmac('sha256', key).update(data).digest('base64url'); };
  await denied(client(signed({ ...owner.claims, iss: 'https://wrong.invalid/auth/v1' }, secret)), 'certsim_serverplus_issue_publication_intent', issueArgs(), 'wrong_signed_issuer');
  await denied(client(signed(owner.claims, 'unrelated-synthetic-signing-key')), 'certsim_serverplus_issue_publication_intent', issueArgs(), 'foreign_signing_key');
  for (const key of ['examKey', 'packageVersion', 'packageHash', 'validationHash', 'sourceHash', 'projectRef', 'reviewedSourceCommit', 'inventoryIdentityHash']) {
    const args = issueArgs(); args.p_request.identity[key] = 'invalid'; await denied(owner.c, 'certsim_serverplus_issue_publication_intent', args, 'issue_' + key); args.p_request.identity = preflight.identity = (await preflightServerPlusPublication(owner.c)).identity;
  }
  const extra = issueArgs(); extra.p_request.ownerAuthorized = true; await denied(owner.c, 'certsim_serverplus_issue_publication_intent', extra, 'forged_extra_field');
  const missing = issueArgs(); delete missing.p_request.confirmation; await denied(owner.c, 'certsim_serverplus_issue_publication_intent', missing, 'missing_confirmation');
  const stale = issueArgs(); stale.p_request.expectedStateHash = '0'.repeat(64); await denied(owner.c, 'certsim_serverplus_issue_publication_intent', stale, 'stale_issuance');
  const issue = async () => issueServerPlusPublicationIntent({ client: owner.c, preflight: await preflightServerPlusPublication(owner.c), approvalReference: approval(), confirmation: 'ISSUE_SERVERPLUS_1_0_0_ONCE', applicationSourceSha: process.env.CERTSIM_SOURCE_SHA, protectedSourceSha: process.env.GITHUB_SHA });
  let intent = await issue();
  await denied(other.c, 'certsim_serverplus_issue_publication_intent', issueArgs(), 'other_owner_global_intent_conflict');
  await denied(other.c, 'certsim_serverplus_revoke_publication_intent', { p_intent_id: intent.intentId }, 'cross_owner_revoke');
  for (const alias of ['serverplussk0005', 'Server Plus', 'CompTIA Server+', 'SK0-005', 'server-plus', 'comptiaserversk0005', 'serversk0005', 'serverplusclone']) {
    const changed = structuredClone(candidate); changed.exam.examKey = alias;
    await denied(owner.c, 'certsim_protected_publish_package', { p_request: { ...unrelatedRequest, packagePayload: changed, packageHash: sha(changed) } }, 'generic_bypass_' + alias, '42501');
  }
  const stripped = structuredClone(candidate);
  stripped.exam.examKey='arbitrarybankclone'; stripped.source.sourceHash='0'.repeat(64); stripped.source.validationHash='1'.repeat(64); delete stripped.source.reviewedSourceCommit; stripped.questions.reverse();
  await denied(owner.c,'certsim_protected_publish_package',{p_request:{...unrelatedRequest,packagePayload:stripped,packageHash:sha(stripped)}},'unlisted_alias_stripped_metadata_reordered_inventory','42501');
  const metadataOnly=syntheticSc100();metadataOnly.exam.examKey='metadatabankclone';metadataOnly.source.sourceHash=candidate.source.sourceHash;
  await denied(owner.c,'certsim_protected_publish_package',{p_request:{...unrelatedRequest,packagePayload:metadataOnly,packageHash:sha(metadataOnly)}},'source_identity_independent_of_exam_name','42501');
  const provisional = structuredClone(candidate); provisional.exam.packageVersion = '1.0.0-serverplus-provisional';
  await denied(owner.c, 'certsim_protected_publish_package', { p_request: { ...unrelatedRequest, packagePayload: provisional, packageHash: sha(provisional) } }, 'generic_provisional', '42501');
  await denied(other.c, 'certsim_serverplus_get_publication_intent', { p_intent_id: intent.intentId }, 'cross_owner_read');
  await denied(other.c, 'certsim_serverplus_publish_with_intent', request(intent, candidate), 'cross_owner_consume');
  for (const key of ['packageHash', 'sourceCommitSha', 'publicationRequestId']) { const args = request(intent, candidate); args.p_request.request[key] = key === 'publicationRequestId' ? crypto.randomUUID() : '0'.repeat(key === 'sourceCommitSha' ? 40 : 64); await denied(owner.c, 'certsim_serverplus_publish_with_intent', args, 'consume_' + key); }
  for (const [label, mutate] of [['version', p => { p.exam.packageVersion = '1.0.1'; }], ['source', p => { p.source.sourceHash = '0'.repeat(64); }], ['validation', p => { p.source.validationHash = '0'.repeat(64); }], ['invalid_payload', p => { p.questions = []; }]]) { const p = structuredClone(candidate); mutate(p); await denied(owner.c, 'certsim_serverplus_publish_with_intent', request(intent, p), label); }
  await denied(owner.c, 'certsim_serverplus_publish_with_intent', { p_request: { contractVersion: SERVERPLUS_CONTRACT, intentId: crypto.randomUUID(), request: {} } }, 'unknown_intent');
  eq(sql(`select status from exam_delivery.serverplus_publication_intents where id=${quote(intent.intentId)}`), 'issued', 'NEGATIVES_DO_NOT_SPEND_VALID_INTENT');
  for (const role of ['anon', 'authenticated', 'service_role']) eq(sql(`select has_function_privilege(${quote(role)},'exam_delivery.publish_package_v2_before_serverplus_authority(jsonb)','EXECUTE')`), 'f', 'PRIVATE_CORE_REVOKED');
  eq(sql("select has_table_privilege('authenticated','exam_delivery.serverplus_publication_intents','SELECT,INSERT,UPDATE,DELETE')"), 'f', 'NO_INTENT_TABLE_ACCESS');
  eq(sql("select relrowsecurity from pg_class where oid='exam_delivery.serverplus_publication_intents'::regclass"), 't', 'INTENT_RLS_ENABLED');
  for (const body of [
    `update exam_delivery.serverplus_publication_intents set status='revoked',finished_at=clock_timestamp() where id=${quote(intent.intentId)}`,
    `select exam_delivery.publish_package_v2_before_serverplus_authority('{}'::jsonb)`
  ]) {
    sql(`set role authenticated;do $test$ begin begin ${body};raise exception 'PRIVILEGE_BYPASS';exception when insufficient_privilege then null;end;end $test$;`);
  }
  sql(`do $test$ begin begin update exam_delivery.serverplus_publication_intents set expires_at=expires_at+interval '1 second' where id=${quote(intent.intentId)};raise exception 'IMMUTABLE_IDENTITY_BYPASS';exception when insufficient_privilege then null;end;begin delete from exam_delivery.serverplus_publication_intent_events where intent_id=${quote(intent.intentId)};raise exception 'AUDIT_BYPASS';exception when insufficient_privilege then null;end;end $test$;`);
  const envelope = request(intent,candidate); envelope.p_request.force=true;
  await denied(owner.c,'certsim_serverplus_publish_with_intent',envelope,'extra_consume_envelope');
  const wrongContract=request(intent,candidate);wrongContract.p_request.contractVersion='ACTIVATE';
  await denied(owner.c,'certsim_serverplus_publish_with_intent',wrongContract,'wrong_operation_contract');
  await owner.c.rpc('certsim_serverplus_revoke_publication_intent', { p_intent_id: intent.intentId });
  await denied(owner.c, 'certsim_serverplus_publish_with_intent', request(intent, candidate), 'revoked_intent');
  // Simulate a genuinely aged persisted row, using local fixture authority only.
  const expired = sql(`insert into exam_delivery.serverplus_publication_intents(actor_id,project_ref,approval_reference,application_source_sha,protected_source_sha,identity,state_hash,release_diff_hash,created_at,expires_at) select actor_id,project_ref,${quote(approval())},application_source_sha,protected_source_sha,identity,state_hash,release_diff_hash,clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '6 minutes' from exam_delivery.serverplus_publication_intents where id=${quote(intent.intentId)} returning id`);
  const expiredRead = await owner.c.rpc('certsim_serverplus_get_publication_intent', { p_intent_id: expired });
  await denied(owner.c, 'certsim_serverplus_publish_with_intent', request(expiredRead.data, candidate), 'expired_intent');
  await owner.c.rpc('certsim_serverplus_revoke_publication_intent', { p_intent_id: expired });
  intent = await issue();
  // Local draft fixture: changed hosted package state must invalidate an issued intent.
  sql(`insert into exam_delivery.package_versions(exam_key,package_version,source_commit_sha,validation_hash,package_hash,package_schema_version,generator_version,scorer_version,status) select 'serverplussk0005','synthetic-conflict',source_commit_sha,validation_hash,${quote(sha({ fixture: crypto.randomUUID() }))},package_schema_version,generator_version,scorer_version,'draft' from exam_delivery.package_versions where exam_key='serverpluspreservation'`);
  await denied(owner.c,'certsim_serverplus_publish_with_intent',request(intent,candidate),'changed_hosted_package_state','40001');
  sql("delete from exam_delivery.package_versions where exam_key='serverplussk0005' and package_version='synthetic-conflict' and status='draft'");
  // A legacy, differently named draft with stripped metadata but the same frozen
  // question identities is relevant hosted state even without protected answer rows.
  const aliasId=sql(`insert into exam_delivery.package_versions(exam_key,package_version,source_commit_sha,validation_hash,package_hash,package_schema_version,generator_version,scorer_version,status) select 'arbitrarybankclone','synthetic-conflict',source_commit_sha,${quote(sha({validation:crypto.randomUUID()}))},${quote(sha({package:crypto.randomUUID()}))},package_schema_version,generator_version,scorer_version,'draft' from exam_delivery.package_versions where exam_key='serverpluspreservation' returning id`);
  sql(`insert into exam_delivery.package_questions(package_version_id,question_id,question_type,domain_key,source_ordinal,presentation_payload,content_hash) select ${quote(aliasId)}::uuid,value#>>'{}','single-choice','synthetic',ordinality,'{}'::jsonb,repeat('f',64) from jsonb_array_elements(${json(candidate.questions.map(q=>q.id))}) with ordinality`);
  await denied(owner.c,'certsim_serverplus_publish_with_intent',request(intent,candidate),'source_bound_unknown_hosted_alias','40001');
  sql(`delete from exam_delivery.package_questions where package_version_id=${quote(aliasId)};delete from exam_delivery.package_versions where id=${quote(aliasId)}`);
  const pendingRun=sql(`insert into exam_delivery.publication_runs(publication_request_id,actor_user_id,source_commit_sha,expected_validation_hash,expected_package_hash,status) values('${crypto.randomUUID()}',${quote(owner.id)},${quote(process.env.CERTSIM_SOURCE_SHA)},${quote(sha({validation:crypto.randomUUID()}))},${quote(sha({package:crypto.randomUUID()}))},'pending') returning id`);
  await denied(owner.c,'certsim_serverplus_publish_with_intent',request(intent,candidate),'competing_pending_publication','40001');
  sql(`delete from exam_delivery.publication_runs where id=${quote(pendingRun)}`);
  sql("insert into public.exam_catalog(exam_key,slug,title,lifecycle,exam_type,status) values('CompTIA Server+','authority-disabled-alias','Synthetic','draft','certification','draft')");
  await denied(owner.c, 'certsim_serverplus_publish_with_intent', request(intent, candidate), 'disabled_alias_state_changed');
  sql("delete from public.exam_catalog where slug='authority-disabled-alias'");
  const runtime = sql("select pg_get_functiondef('exam_delivery.package_v2_runtime_supported(text,text,text)'::regprocedure)");
  sql("create or replace function exam_delivery.package_v2_runtime_supported(p_generator text,p_scorer text,p_pbq_runtime text default null) returns boolean language sql immutable security invoker set search_path='' as $$select null::boolean$$");
  await denied(owner.c, 'certsim_serverplus_publish_with_intent', request(intent, candidate), 'null_runtime_capability');
  const nullState = await owner.c.rpc('certsim_serverplus_publication_preflight', { p_request: { contractVersion: SERVERPLUS_CONTRACT } });
  eq(nullState.data.ready, false, 'NULL_CAPABILITY_FAILS_CLOSED');
  const nullIssue = issueArgs(); nullIssue.p_request.expectedStateHash = nullState.data.stateHash; nullIssue.p_request.releaseDiffHash = nullState.data.releaseDiffHash;
  await denied(owner.c, 'certsim_serverplus_issue_publication_intent', nullIssue, 'null_capability_direct_issue');
  sql(runtime);
  sql("insert into supabase_migrations.schema_migrations(version,name) values('99999999999999','synthetic_drift')");
  await denied(owner.c, 'certsim_serverplus_publish_with_intent', request(intent, candidate), 'migration_drift');
  sql("delete from supabase_migrations.schema_migrations where version='99999999999999'");
  await owner.c.rpc('certsim_serverplus_revoke_publication_intent', { p_intent_id: intent.intentId });
  intent = await issue();
  sql("create function exam_delivery.authority_fail_fixture() returns trigger language plpgsql set search_path='' as $$begin if NEW.exam_key='serverplussk0005' then raise exception 'synthetic_failure';end if;return NEW;end$$;create trigger authority_failure before insert on exam_delivery.package_versions for each row execute function exam_delivery.authority_fail_fixture()");
  stage = 'controlled_failure';
  const failed = await owner.c.rpc('certsim_serverplus_publish_with_intent', request(intent, candidate));
  gate(!failed.error && failed.data.status === 'failed', 'CONTROLLED_FAILURE_TERMINAL');
  eq(sql("select count(*) from exam_delivery.package_versions where exam_key='serverplussk0005'"), '0', 'FAILED_PUBLICATION_ATOMIC');
  await denied(owner.c, 'certsim_serverplus_publish_with_intent', request(intent, candidate), 'failed_intent_cannot_retry');
  sql('drop trigger authority_failure on exam_delivery.package_versions;drop function exam_delivery.authority_fail_fixture()');
  stage = 'concurrent_commit_lost_response';
  intent = await issue();
  const loaded = await loadServerPlusPublicationPackage({ contentRoot: root, client: owner.c, intentId: intent.intentId });
  sql("create function exam_delivery.authority_sleep_fixture() returns trigger language plpgsql set search_path='' as $$begin if NEW.exam_key='serverplussk0005' then perform pg_catalog.pg_sleep(4);end if;return NEW;end$$;create trigger authority_pause before insert on exam_delivery.package_versions for each row execute function exam_delivery.authority_sleep_fixture()");
  let consumes = 0, actualResult;
  const lost = { auth: owner.c.auth, rpc: async (name, args) => { const result = await owner.c.rpc(name, args); if (name === 'certsim_serverplus_publish_with_intent') { consumes++; actualResult = result; return { error: { code: 'SYNTHETIC_LOST_RESPONSE' } }; } return result; } };
  const pending = publishServerPlusWithIntent({ client: lost, loaded });
  let sleeping = false;
  for (let n = 0; n < 30; n++) { if (Number(sql("select count(*) from pg_stat_activity where wait_event='PgSleep' and query like '%certsim_serverplus_publish_with_intent%'")) > 0) { sleeping = true; break; } await new Promise(resolve => setTimeout(resolve, 100)); }
  gate(sleeping, 'REAL_FIRST_DATABASE_SESSION_IN_FLIGHT');
  await denied(owner.c, 'certsim_serverplus_publish_with_intent', request(intent, candidate), 'concurrent_second_database_session', '55P03');
  const reconciled = await pending;
  gate(!actualResult.error && actualResult.data.status === 'consumed', 'ONE_REAL_COMMITTED_PUBLICATION');
  gate(reconciled.status === 'STOP_RECONCILED_NO_RETRY' && reconciled.committed === true, 'LOST_RESPONSE_READ_ONLY_RECONCILIATION');
  eq(consumes, 1, 'NO_AUTOMATIC_SECOND_CONSUME');
  await denied(owner.c, 'certsim_serverplus_publish_with_intent', request(intent, candidate), 'repeat_consumed_intent');
  await denied(owner.c, 'certsim_serverplus_revoke_publication_intent', { p_intent_id: intent.intentId }, 'cannot_revoke_consumed');
  await denied(owner.c, 'certsim_serverplus_issue_publication_intent', issueArgs(), 'no_new_intent_after_publication');
  eq(sql("select count(*) from exam_delivery.package_versions where exam_key='serverplussk0005' and package_version='1.0.0'"), '1', 'ONE_IMMUTABLE_EFFECT');
  eq(sql("select count(*) from exam_delivery.publication_runs where expected_package_hash='26e2caf5a3a838ea274f09938076a734aa734e14cb5535ff11a4203c05fdfefe' and status='succeeded'"), '1', 'ONE_PUBLICATION_LEDGER');
  eq(sql("select count(*) from exam_delivery.serverplus_publication_intents where status='consumed'"), '1', 'ONE_CONSUMED_INTENT');
  eq(sql("select count(*) from exam_delivery.package_forms f join exam_delivery.package_versions p on p.id=f.package_version_id where p.exam_key='serverplussk0005'"), '4', 'FOUR_FORMS_MATERIALIZED');
  for (const profile of candidate.profiles) {
    eq(JSON.parse(sql(`select jsonb_build_array(pp.question_count,pp.time_limit_minutes) from exam_delivery.package_profiles pp join exam_delivery.package_versions p on p.id=pp.package_version_id where p.exam_key='serverplussk0005' and pp.profile_key=${quote(profile.profileKey)}`)),[profile.questionCount,profile.timeLimitMinutes],'PROFILE_CONFIGURATION_MATERIALIZED');
    for (const form of profile.selection.canonicalForms.forms) {
      eq(sql(`select f.membership_hash from exam_delivery.package_forms f join exam_delivery.package_profiles pp on pp.id=f.package_profile_id join exam_delivery.package_versions p on p.id=f.package_version_id where p.exam_key='serverplussk0005' and pp.profile_key=${quote(profile.profileKey)} and f.form_key=${quote(form.formKey)}`),form.membershipHash,'FORM_MEMBERSHIP_METADATA');
      eq(sql(`select exam_delivery.canonical_sha256(jsonb_agg(q.question_id order by fq.presentation_ordinal)) from exam_delivery.package_form_questions fq join exam_delivery.package_questions q on q.id=fq.package_question_id join exam_delivery.package_forms f on f.id=fq.form_id join exam_delivery.package_profiles pp on pp.id=f.package_profile_id join exam_delivery.package_versions p on p.id=f.package_version_id where p.exam_key='serverplussk0005' and pp.profile_key=${quote(profile.profileKey)} and f.form_key=${quote(form.formKey)}`),form.membershipHash,'ACTUAL_ORDERED_FORM_MATERIALIZATION');
    }
  }
  eq(sql("select count(*) from exam_delivery.exam_entitlements e join exam_delivery.package_versions p on p.id=e.package_version_id where p.exam_key='serverplussk0005'"),'0','NO_IMPLICIT_ENTITLEMENTS');
  eq(sql("select count(*) from exam_delivery.package_profile_defaults where canonical_exam_key='serverplussk0005'"),'0','NO_IMPLICIT_DEFAULTS');
  eq(sql("select count(*) from exam_delivery.practice_policies where canonical_exam_key='serverplussk0005'"),'0','NO_IMPLICIT_PRACTICE_POLICIES');
  eq(sql("select count(*) from public.exam_catalog where exam_key='serverplussk0005'"), '0', 'NO_IMPLICIT_ACTIVATION');
  eq(sql("select count(*) from public.exam_assignments where exam_key='serverplussk0005'"), '0', 'NO_IMPLICIT_ASSIGNMENT');
  eq(sql("select md5(to_jsonb(v)::text) from exam_delivery.package_versions v where exam_key='serverpluspreservation'"), original, 'OTHER_EXAM_UNCHANGED');
  eq(sql('select count(*) from supabase_migrations.schema_migrations'), '102', 'FINAL_LEDGER_102');
  const proof = { ok: true, scope: 'serverplus-one-use-authority-v1', assertions, negativeCases: cases, positiveCommittedPublications: 1, consumedIntents: 1, concurrentSeparateDatabaseSessions: true, lostResponseReconciled: true, consumeCallsAfterLostResponse: consumes, controlledFailureAtomicAndTerminal: true, genericLegacyReplayPreserved: true, warmedDispatcherAndPreparedCallDenied: true, noImplicitActivationOrAssignments: true, otherExamPreserved: true, actualAuthWithSyntheticLocalKeyAndProductionShapedIssuer: true, physicalProductionProjectNotTested: true, migrationCount: 102, applicationSha: process.env.CERTSIM_SOURCE_SHA, privateSha: process.env.GITHUB_SHA, packageHash: sha(candidate), productionActions: 0 };
  fs.writeFileSync(temp + '/serverplus-authority-proof.json', JSON.stringify(proof));
  console.log(JSON.stringify(proof));
}
try { await main(); } catch (error) { console.log(JSON.stringify({ ok: false, stage, assertions, code: /^[A-Z0-9_]+$/.test(error.message) ? error.message : 'SANITIZED_PRIVATE_TEST_FAILURE', productionActions: 0 })); process.exitCode = 1; }
finally { warm?.close(); }
