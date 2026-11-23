import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const upgradeUrl = localDatabase('SUPABASE_DB_URL');
const negativeUrl = localDatabase('ISSUE133_NEGATIVE_DB_URL');
const concurrencyUrl = localDatabase('ISSUE133_CONCURRENCY_DB_URL');
const psql = process.env.PSQL_PATH?.trim() || 'psql';
const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'supabase',
  'migrations',
  '20260920124528_issue133_examops_phase4b.sql',
);
const migrationSql = await readFile(migrationPath, 'utf8');
const migrationVersion = '20260920124528';
const migrationName = 'issue133_examops_phase4b';
const lockPattern = /lock table exam_delivery\.attempts\s+in share row exclusive mode\s+nowait;/i;
const lockMatch = lockPattern.exec(migrationSql);
assert.ok(lockMatch, 'attempt backfill lock missing');
const migrationBeforeLock = migrationSql.slice(0, lockMatch.index);
const migrationFromLock = migrationSql.slice(lockMatch.index);
const users = Array.from({ length: 12 }, (_, index) => (
  `13350000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
));
const organisation = '13350000-0000-4000-8000-000000000100';
const packageId = '13350000-0000-4000-8000-000000000101';
const profileId = '13350000-0000-4000-8000-000000000102';
const questionId = '13350000-0000-4000-8000-000000000103';
const assignmentId = '13350000-0000-4000-8000-000000000104';
const attemptIds = Object.freeze({
  assigned: '13350000-0000-4000-8000-000000000201',
  selfDirected: '13350000-0000-4000-8000-000000000202',
  sandbox: '13350000-0000-4000-8000-000000000203',
  targeted: '13350000-0000-4000-8000-000000000204',
  weak: '13350000-0000-4000-8000-000000000205',
  pbq: '13350000-0000-4000-8000-000000000206',
  attributed: '13350000-0000-4000-8000-000000000207',
  frozen: '13350000-0000-4000-8000-000000000208',
  idleExpired: '13350000-0000-4000-8000-000000000209',
  timedExpired: '13350000-0000-4000-8000-000000000210',
  explicitlyExpired: '13350000-0000-4000-8000-000000000211',
  postMigrationValid: '13350000-0000-4000-8000-000000000212',
  postMigrationRejected: '13350000-0000-4000-8000-000000000213',
});
const noPolicyProfileId = '13350000-0000-4000-8000-000000000105';
const durationRuns = [];

seedUpgradeFixture(upgradeUrl, true);
const attemptsBefore = scalar(upgradeUrl, attemptDigestSql());
durationRuns.push(await applyTimedMigration(upgradeUrl));
assert.equal(scalar(upgradeUrl, `select count(*) from exam_delivery.attempt_continuation_contracts`), '8');
assert.equal(scalar(upgradeUrl, attemptDigestSql()), attemptsBefore);
assert.equal(scalar(upgradeUrl, `select count(*) from exam_delivery.attempt_continuation_contracts where expiry_mode='timed'`), '3');
assert.equal(scalar(upgradeUrl, `select count(*) from exam_delivery.attempt_continuation_contracts where expiry_mode='practice_idle'`), '5');
assert.equal(scalar(upgradeUrl, `select assignment_binding_kind from exam_delivery.attempt_continuation_contracts where attempt_id='${attemptIds.attributed}'`), 'legacy_assignment');
assert.equal(scalar(upgradeUrl, `select immediate_feedback::text from exam_delivery.attempt_continuation_contracts where attempt_id='${attemptIds.attributed}'`), 'true');
assert.equal(scalar(upgradeUrl, `select immediate_feedback::text from exam_delivery.attempt_continuation_contracts where attempt_id='${attemptIds.sandbox}'`), 'true');
assert.equal(scalar(upgradeUrl, `select review_release_policy||':'||answer_release_policy from exam_delivery.attempt_continuation_contracts where attempt_id='${attemptIds.weak}'`), 'never:never');
assert.equal(scalar(upgradeUrl, `select count(*) from exam_delivery.attempt_continuation_contracts where attempt_id in ('${attemptIds.idleExpired}','${attemptIds.timedExpired}','${attemptIds.explicitlyExpired}')`), '0');
assert.equal(json(upgradeUrl, `select exam_delivery.authorize_attempt_continuation('${attemptIds.frozen}','submit')::text`).ok, true);
assert.equal(json(upgradeUrl, `select exam_delivery.authorize_attempt_continuation('${attemptIds.frozen}','resume')::text`).code, 'invalid_lifecycle_transition');

const immutableUpdate = execute(upgradeUrl, `update exam_delivery.attempt_continuation_contracts set immediate_feedback=false where attempt_id='${attemptIds.sandbox}'`);
assert.notEqual(immutableUpdate.status, 0);
assert.match(immutableUpdate.stderr, /append_only_mutation_denied/);
const immutableDelete = execute(upgradeUrl, `delete from exam_delivery.attempt_continuation_contracts where attempt_id='${attemptIds.sandbox}'`);
assert.notEqual(immutableDelete.status, 0);
assert.match(immutableDelete.stderr, /append_only_mutation_denied/);

seedUpgradeFixture(negativeUrl, false);
const negative = applyTrackedMigration(negativeUrl, false);
assert.notEqual(negative.status, 0);
assert.match(negative.stderr, /BLOCKED_CONTINUATION_RISK/);
assert.equal(scalar(negativeUrl, `select to_regclass('exam_delivery.attempt_continuation_contracts') is null`), 't');
assert.equal(migrationHistoryCount(negativeUrl), '0');

seedUpgradeFixture(concurrencyUrl, true);
const writerLock = await holdAttemptWriterLock(concurrencyUrl);
const contended = applyTrackedMigration(concurrencyUrl, false);
assert.notEqual(contended.status, 0);
assert.match(contended.stderr, /could not obtain lock on relation "(?:exam_delivery\.)?attempts"/i);
assert.equal(migration89ObjectCount(concurrencyUrl), '0');
assert.equal(migrationHistoryCount(concurrencyUrl), '0');
await writerLock.release();

durationRuns.push(await applyTimedMigration(concurrencyUrl));
assert.equal(migrationHistoryCount(concurrencyUrl), '1');
assert.equal(scalar(concurrencyUrl, `select count(*) from exam_delivery.attempt_continuation_contracts`), '8');
provePostMigrationAttemptContractGuarantee(concurrencyUrl);

run(negativeUrl, practicePolicyFixtureSql());
durationRuns.push(await applyTimedMigration(negativeUrl));
assert.equal(migrationHistoryCount(negativeUrl), '1');
assert.equal(scalar(negativeUrl, `select count(*) from exam_delivery.attempt_continuation_contracts`), '8');

const maximumTotalMs = Math.max(...durationRuns.map((run) => run.totalMs));
const maximumLockHeldMs = Math.max(...durationRuns.map((run) => run.lockHeldMs));

console.log(JSON.stringify({
  ok: true,
  previousMigrationBoundary: '20260917185333_issue86_live_submit_recovery.sql',
  migrationAppliedAlone: true,
  backfilledContracts: 8,
  assignedAssessmentTimed: 'PASS',
  selfDirectedTimed: 'PASS',
  studySandbox: 'PASS',
  targetedDomain: 'PASS',
  weakArea: 'PASS',
  pbqPractice: 'PASS',
  assignmentAttributedPractice: 'PASS',
  frozenPythonFinalSubmission: 'PASS',
  excludedExpiredAttempts: 3,
  sourceAttemptsPreserved: true,
  immutableContracts: 'PASS',
  ambiguousStateFailsClosed: 'PASS',
  concurrentWriterMigrationFailure: 'PASS',
  contendedMigrationPartialObjects: 0,
  contendedMigrationHistoryRows: 0,
  successfulRetryAfterWriterRelease: 'PASS',
  postMigrationAttemptContractGuarantee: 'PASS',
  contractBuilderFailureRollsBackAttempt: 'PASS',
  lockDurationRuns: durationRuns,
  maximumTotalMs,
  maximumLockHeldMs,
  productionMutations: 0,
}, null, 2));

function seedUpgradeFixture(databaseUrl, includePolicies) {
  const authRows = users.map((id, index) => (
    `('${id}','issue133-upgrade-${index + 1}@example.invalid','{}'::jsonb)`
  )).join(',\n');
  const profileRows = users.map((id, index) => (
    `('${id}','issue133-upgrade-${index + 1}@example.invalid','individual','student','active')`
  )).join(',\n');
  const policySql = includePolicies ? practicePolicyFixtureSql() : '';
  run(databaseUrl, `
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations(
  version text primary key,
  statements text[],
  name text
);
insert into supabase_migrations.schema_migrations(version,name,statements)
values('20260917185333','issue86_live_submit_recovery',array['-- disposable migration-88 boundary']::text[])
on conflict(version) do nothing;
insert into auth.users(id,email,raw_user_meta_data) values ${authRows};
insert into public.profiles(id,email,user_type,default_role,status) values ${profileRows}
on conflict(id) do update set status='active';
insert into public.organisations(id,name,organisation_type,status)
values('${organisation}','Issue 133 upgrade fixture','internal','active');
insert into public.memberships(user_id,organisation_id,role,status)
values('${users[0]}','${organisation}','student','active');
insert into exam_delivery.package_versions(
  id,exam_key,package_version,source_commit_sha,validation_hash,package_hash,
  package_schema_version,generator_version,scorer_version,status,
  declared_review_release_policy,declared_answer_release_policy
) values(
  '${packageId}','issue133upgrade','1.0.0','${'1'.repeat(40)}','${'2'.repeat(64)}','${'3'.repeat(64)}',
  'certsim-protected-package-v2','certsim-python-standard-canonical-forms-v1',
  'certsim-versioned-structured-partial-v1','draft','after_submission','after_submission'
);
insert into exam_delivery.package_profiles(
  id,package_version_id,profile_key,display_name,question_count,time_limit_minutes,selection_config
) values
  ('${profileId}','${packageId}','full','Upgrade full',1,30,'{}'::jsonb),
  ('${noPolicyProfileId}','${packageId}','no-policy','No policy fixture',1,30,'{}'::jsonb);
insert into exam_delivery.package_questions(
  id,package_version_id,question_id,question_type,domain_key,source_ordinal,presentation_payload,content_hash
) values(
  '${questionId}','${packageId}','upgrade-python','executable-python-lab-v1','d1',1,
  '{"prompt":"Synthetic executable fixture"}'::jsonb,'${'4'.repeat(64)}'
);
insert into exam_delivery.package_question_protected_content(
  question_id,package_version_id,scoring_payload,review_payload,authoring_metadata
) values(
  '${questionId}','${packageId}','{"maximumRawPoints":1}'::jsonb,
  '{"explanation":"Synthetic fixture"}'::jsonb,'{"scored":true}'::jsonb
);
update exam_delivery.package_versions set status='published',published_at=statement_timestamp()
where id='${packageId}';
${policySql}
insert into public.exam_assignments(
  id,organisation_id,student_user_id,exam_key,profile_id,title,status,
  available_from,due_at,assigned_by
) values(
  '${assignmentId}','${organisation}','${users[6]}','issue133upgrade','full',
  'Upgrade assignment fixture','active',statement_timestamp()-interval '1 day',
  statement_timestamp()+interval '1 day','${users[0]}'
);

insert into exam_delivery.attempts(
  id,owner_id,package_version_id,package_profile_id,client_request_id,status,
  generator_version,scorer_version,created_at,started_at,expires_at,purpose,
  practice_last_activity_at,practice_idle_expires_at,source_assignment_id,
  source_organisation_id,attribution_source
) values
  ('${attemptIds.assigned}','${users[0]}','${packageId}','${profileId}','13350000-0000-4000-8000-000000000301','in_progress','fixture-generator','fixture-scorer',statement_timestamp()-interval '5 minutes',statement_timestamp()-interval '5 minutes',statement_timestamp()+interval '25 minutes','assigned_assessment',null,null,null,null,null),
  ('${attemptIds.selfDirected}','${users[1]}','${packageId}','${profileId}','13350000-0000-4000-8000-000000000302','in_progress','fixture-generator','fixture-scorer',statement_timestamp()-interval '5 minutes',statement_timestamp()-interval '5 minutes',statement_timestamp()+interval '25 minutes','self_directed_exam',null,null,null,null,'personal_self_directed'),
  ('${attemptIds.sandbox}','${users[2]}','${packageId}','${profileId}','13350000-0000-4000-8000-000000000303','in_progress','fixture-generator','fixture-scorer',statement_timestamp()-interval '5 minutes',statement_timestamp()-interval '5 minutes',null,'study_sandbox',statement_timestamp(),statement_timestamp()+interval '2 hours',null,null,'personal_self_directed'),
  ('${attemptIds.targeted}','${users[3]}','${packageId}','${profileId}','13350000-0000-4000-8000-000000000304','in_progress','fixture-generator','fixture-scorer',statement_timestamp()-interval '5 minutes',statement_timestamp()-interval '5 minutes',null,'targeted_domain',statement_timestamp(),statement_timestamp()+interval '2 hours',null,null,'personal_self_directed'),
  ('${attemptIds.weak}','${users[4]}','${packageId}','${profileId}','13350000-0000-4000-8000-000000000305','in_progress','fixture-generator','fixture-scorer',statement_timestamp()-interval '5 minutes',statement_timestamp()-interval '5 minutes',null,'weak_area',statement_timestamp(),statement_timestamp()+interval '2 hours',null,null,'personal_self_directed'),
  ('${attemptIds.pbq}','${users[5]}','${packageId}','${profileId}','13350000-0000-4000-8000-000000000306','in_progress','fixture-generator','fixture-scorer',statement_timestamp()-interval '5 minutes',statement_timestamp()-interval '5 minutes',null,'pbq_practice',statement_timestamp(),statement_timestamp()+interval '2 hours',null,null,'personal_self_directed'),
  ('${attemptIds.attributed}','${users[6]}','${packageId}','${profileId}','13350000-0000-4000-8000-000000000307','in_progress','fixture-generator','fixture-scorer',statement_timestamp()-interval '5 minutes',statement_timestamp()-interval '5 minutes',null,'study_sandbox',statement_timestamp(),statement_timestamp()+interval '2 hours','${assignmentId}','${organisation}','assignment'),
  ('${attemptIds.frozen}','${users[7]}','${packageId}','${profileId}','13350000-0000-4000-8000-000000000308','in_progress','fixture-generator','fixture-scorer',statement_timestamp()-interval '40 minutes',statement_timestamp()-interval '40 minutes',statement_timestamp()-interval '10 minutes','assigned_assessment',null,null,null,null,null),
  ('${attemptIds.idleExpired}','${users[8]}','${packageId}','${profileId}','13350000-0000-4000-8000-000000000309','in_progress','fixture-generator','fixture-scorer',statement_timestamp()-interval '3 hours',statement_timestamp()-interval '3 hours',null,'targeted_domain',statement_timestamp()-interval '3 hours',statement_timestamp()-interval '1 minute',null,null,'personal_self_directed'),
  ('${attemptIds.timedExpired}','${users[9]}','${packageId}','${profileId}','13350000-0000-4000-8000-000000000310','in_progress','fixture-generator','fixture-scorer',statement_timestamp()-interval '40 minutes',statement_timestamp()-interval '40 minutes',statement_timestamp()-interval '10 minutes','self_directed_exam',null,null,null,null,'personal_self_directed'),
  ('${attemptIds.explicitlyExpired}','${users[10]}','${packageId}','${profileId}','13350000-0000-4000-8000-000000000311','expired','fixture-generator','fixture-scorer',statement_timestamp()-interval '3 hours',statement_timestamp()-interval '3 hours',null,'pbq_practice',statement_timestamp()-interval '3 hours',statement_timestamp()-interval '1 minute',null,null,'personal_self_directed');
insert into exam_delivery.python_submission_grading_sessions(attempt_id,submission_id,created_at)
values('${attemptIds.frozen}','13350000-0000-4000-8000-000000000401',statement_timestamp()-interval '20 minutes');
commit;
  `);
}

function practicePolicyFixtureSql() {
  return `
insert into exam_delivery.practice_policies(
  canonical_exam_key,package_version,profile_key,purpose,access_mode,enabled,
  maximum_completed_attempts,cooldown_seconds,maximum_concurrent_sessions,
  maximum_session_items,immediate_feedback,review_release_policy,answer_release_policy
) values
  ('issue133upgrade','1.0.0','full','self_directed_exam','production_authorized',true,null,0,1,10,false,'after_submission','after_submission'),
  ('issue133upgrade','1.0.0','full','study_sandbox','production_authorized',true,null,0,1,10,true,'immediate_study_feedback','immediate_study_feedback'),
  ('issue133upgrade','1.0.0','full','targeted_domain','production_authorized',true,null,0,1,10,false,'after_submission','after_submission'),
  ('issue133upgrade','1.0.0','full','weak_area','production_authorized',true,null,0,1,10,false,'never','never'),
  ('issue133upgrade','1.0.0','full','pbq_practice','production_authorized',true,null,0,1,10,false,'after_submission','after_submission');
`;
}

function applyTrackedMigration(databaseUrl, expectSuccess) {
  const result = spawnSync(psql, [
    '-X', '-q', '-1', '-v', 'ON_ERROR_STOP=1', '-d', databaseUrl,
    '-f', migrationPath, '-c', migrationHistoryInsertSql(),
  ], { encoding: 'utf8', windowsHide: true });
  if (expectSuccess && result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Phase 4B migration failed');
  }
  return result;
}

async function applyTimedMigration(databaseUrl) {
  const session = createPsqlSession(databaseUrl);
  const totalStartedAt = performance.now();
  session.write(`begin;\n${migrationBeforeLock}\nselect 'ISSUE133_BEFORE_ATTEMPT_LOCK';\n`);
  await session.waitFor('ISSUE133_BEFORE_ATTEMPT_LOCK');

  const lockStartedAt = performance.now();
  session.write(`${migrationFromLock}\n${migrationHistoryInsertSql()}\ncommit;\nselect 'ISSUE133_MIGRATION_COMMITTED';\n\\q\n`);
  session.end();
  await session.waitFor('ISSUE133_MIGRATION_COMMITTED');
  await session.expectSuccess();
  const committedAt = performance.now();

  return Object.freeze({
    totalMs: Number((committedAt - totalStartedAt).toFixed(1)),
    lockHeldMs: Number((committedAt - lockStartedAt).toFixed(1)),
  });
}

async function holdAttemptWriterLock(databaseUrl) {
  const session = createPsqlSession(databaseUrl);
  session.write(`
begin;
lock table exam_delivery.attempts in row exclusive mode;
select 'ISSUE133_WRITER_LOCK_HELD';
  `);
  await session.waitFor('ISSUE133_WRITER_LOCK_HELD');
  return Object.freeze({
    async release() {
      session.write(`rollback;\nselect 'ISSUE133_WRITER_LOCK_RELEASED';\n\\q\n`);
      session.end();
      await session.waitFor('ISSUE133_WRITER_LOCK_RELEASED');
      await session.expectSuccess();
    },
  });
}

function provePostMigrationAttemptContractGuarantee(databaseUrl) {
  run(databaseUrl, `
begin;
insert into exam_delivery.attempts(
  id,owner_id,package_version_id,package_profile_id,client_request_id,status,
  generator_version,scorer_version,created_at,started_at,expires_at,purpose,
  practice_last_activity_at,practice_idle_expires_at,attribution_source
) values(
  '${attemptIds.postMigrationValid}','${users[11]}','${packageId}','${profileId}',
  '13350000-0000-4000-8000-000000000312','in_progress','fixture-generator',
  'fixture-scorer',statement_timestamp(),statement_timestamp(),null,'study_sandbox',
  statement_timestamp(),statement_timestamp()+interval '2 hours','personal_self_directed'
);
do $issue133$
begin
  if not exists(select 1 from exam_delivery.attempts where id='${attemptIds.postMigrationValid}')
    or not exists(select 1 from exam_delivery.attempt_continuation_contracts
      where attempt_id='${attemptIds.postMigrationValid}') then
    raise exception 'ISSUE133_POST_MIGRATION_CONTRACT_MISSING';
  end if;
end $issue133$;
commit;
  `);
  assert.equal(scalar(databaseUrl, `
    select (exists(select 1 from exam_delivery.attempts where id='${attemptIds.postMigrationValid}')
      and exists(select 1 from exam_delivery.attempt_continuation_contracts
        where attempt_id='${attemptIds.postMigrationValid}'))::text
  `), 'true');

  const rejected = execute(databaseUrl, `
insert into exam_delivery.attempts(
  id,owner_id,package_version_id,package_profile_id,client_request_id,status,
  generator_version,scorer_version,created_at,started_at,expires_at,purpose,
  practice_last_activity_at,practice_idle_expires_at,attribution_source
) values(
  '${attemptIds.postMigrationRejected}','${users[11]}','${packageId}','${noPolicyProfileId}',
  '13350000-0000-4000-8000-000000000313','in_progress','fixture-generator',
  'fixture-scorer',statement_timestamp(),statement_timestamp(),null,'weak_area',
  statement_timestamp(),statement_timestamp()+interval '2 hours','personal_self_directed'
)
  `);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /CONTINUATION_CONTRACT_POLICY_AMBIGUOUS/);
  assert.equal(scalar(databaseUrl, `
    select count(*) from exam_delivery.attempts where id='${attemptIds.postMigrationRejected}'
  `), '0');
  assert.equal(scalar(databaseUrl, `
    select count(*) from exam_delivery.attempt_continuation_contracts
    where attempt_id='${attemptIds.postMigrationRejected}'
  `), '0');
}

function migration89ObjectCount(databaseUrl) {
  return scalar(databaseUrl, `
select ((to_regclass('exam_delivery.attempt_continuation_contracts') is not null)::int
  +(to_regclass('exam_delivery.exam_release_operations') is not null)::int
  +(to_regclass('exam_delivery.exam_release_operation_events') is not null)::int)::text
  `);
}

function migrationHistoryCount(databaseUrl) {
  return scalar(databaseUrl, `
select count(*) from supabase_migrations.schema_migrations where version='${migrationVersion}'
  `);
}

function migrationHistoryInsertSql() {
  return `insert into supabase_migrations.schema_migrations(version,name,statements)
values('${migrationVersion}','${migrationName}',array['-- Issue 133 disposable migration harness']::text[]);`;
}

function createPsqlSession(databaseUrl) {
  const child = spawn(psql, ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', databaseUrl], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stdout = '';
  let stderr = '';
  let exited = false;
  let exitCode = null;
  const waiters = new Set();

  const settleWaiters = () => {
    for (const waiter of waiters) {
      if (stdout.includes(waiter.marker)) {
        clearTimeout(waiter.timeout);
        waiters.delete(waiter);
        waiter.resolve();
      } else if (exited) {
        clearTimeout(waiter.timeout);
        waiters.delete(waiter);
        waiter.reject(new Error(stderr || stdout || `psql exited ${exitCode}`));
      }
    }
  };

  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    settleWaiters();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('error', (error) => {
    stderr += error.stack || error.message;
  });
  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code) => {
      exited = true;
      exitCode = code;
      settleWaiters();
      resolve(code);
    });
  });

  return Object.freeze({
    write(sql) {
      child.stdin.write(sql);
    },
    end() {
      child.stdin.end();
    },
    waitFor(marker) {
      if (stdout.includes(marker)) return Promise.resolve();
      if (exited) return Promise.reject(new Error(stderr || stdout || `psql exited ${exitCode}`));
      return new Promise((resolve, reject) => {
        const waiter = { marker, resolve, reject, timeout: null };
        waiter.timeout = setTimeout(() => {
          waiters.delete(waiter);
          reject(new Error(`Timed out waiting for ${marker}: ${stderr || stdout}`));
        }, 120_000);
        waiters.add(waiter);
      });
    },
    async expectSuccess() {
      const code = await exitPromise;
      if (code !== 0) throw new Error(stderr || stdout || `psql exited ${code}`);
    },
  });
}

function attemptDigestSql() {
  return `select exam_delivery.canonical_sha256(coalesce(jsonb_agg(to_jsonb(attempt) order by attempt.id),'[]'::jsonb)) from exam_delivery.attempts attempt`;
}

function execute(databaseUrl, sql) {
  return spawnSync(psql, ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', databaseUrl], {
    input: `${sql.trim()}\n`,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function run(databaseUrl, sql) {
  const result = execute(databaseUrl, sql);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'psql failed');
  return result.stdout.trim();
}

function scalar(databaseUrl, sql) {
  return run(databaseUrl, sql).split(/\r?\n/).filter(Boolean).at(-1)?.trim() ?? '';
}

function json(databaseUrl, sql) {
  return JSON.parse(scalar(databaseUrl, sql));
}

function localDatabase(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  const host = new URL(value).hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new Error('ISSUE133_DISPOSABLE_LOCAL_DATABASE_REQUIRED');
  }
  return value;
}
