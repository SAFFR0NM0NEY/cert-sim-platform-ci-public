import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const databaseUrl = required('SUPABASE_DB_URL');
const psql = process.env.PSQL_PATH?.trim() || 'psql';
const host = new URL(databaseUrl).hostname;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
  throw new Error('DISPOSABLE_LOCAL_DATABASE_REQUIRED');
}

const ownerId = '86200000-0000-4000-8000-000000000001';
const examKey = 'pythonnextgeneration';
const packageVersion = '1.0.0';
const profiles = ['pythonnextgeneration-no-lab', 'pythonnextgeneration-lab'];

const initial = queryEvidence();
assert.deepEqual({
  candidates: initial.candidates,
  packages: initial.packages,
  published: initial.published,
  profiles: initial.profiles,
  activations: initial.activations,
  defaults: initial.defaults,
  policies: initial.policies,
  catalogue: initial.catalogue,
  requests: initial.requests,
}, {
  candidates: 2,
  packages: 1,
  published: 1,
  profiles: 2,
  activations: 0,
  defaults: 0,
  policies: 0,
  catalogue: 0,
  requests: 0,
});
assert.deepEqual(initial.profileKeys, [...profiles].sort());

const transaction = run(`
begin;
create temporary table issue86_release_responses(label text primary key,response jsonb) on commit drop;
insert into issue86_release_responses values
  ('noLabAcceptance',exam_delivery.configure_exam_release_stage(
    '${ownerId}',
    '{"examKey":"${examKey}","packageVersion":"${packageVersion}","profileKey":"${profiles[0]}","releaseStage":"acceptance","requestId":"86210000-0000-4000-8000-000000000001"}'::jsonb
  )),
  ('labAcceptance',exam_delivery.configure_exam_release_stage(
    '${ownerId}',
    '{"examKey":"${examKey}","packageVersion":"${packageVersion}","profileKey":"${profiles[1]}","releaseStage":"acceptance","requestId":"86210000-0000-4000-8000-000000000002"}'::jsonb
  )),
  ('noLabActive',exam_delivery.configure_exam_release_stage(
    '${ownerId}',
    '{"examKey":"${examKey}","packageVersion":"${packageVersion}","profileKey":"${profiles[0]}","releaseStage":"standard_active_exam_v1","requestId":"86210000-0000-4000-8000-000000000003"}'::jsonb
  )),
  ('labActive',exam_delivery.configure_exam_release_stage(
    '${ownerId}',
    '{"examKey":"${examKey}","packageVersion":"${packageVersion}","profileKey":"${profiles[1]}","releaseStage":"standard_active_exam_v1","requestId":"86210000-0000-4000-8000-000000000004"}'::jsonb
  ));
select 'ISSUE86_RELEASE_EVIDENCE:' || json_build_object(
  'responses',(select jsonb_object_agg(label,response) from issue86_release_responses),
  'activations',(select count(*) from exam_delivery.exam_profile_activations a join exam_delivery.package_versions pv on pv.id=a.package_version_id where pv.exam_key='${examKey}' and pv.package_version='${packageVersion}' and a.enabled),
  'defaults',(select count(*) from exam_delivery.package_profile_defaults where canonical_exam_key='${examKey}' and enabled),
  'defaultMismatches',(select count(*) from exam_delivery.package_profile_defaults d join exam_delivery.package_profiles pp on pp.id=d.package_profile_id join exam_delivery.package_versions pv on pv.id=d.package_version_id where d.canonical_exam_key='${examKey}' and (pv.exam_key<>'${examKey}' or pv.package_version<>'${packageVersion}' or pp.profile_key<>d.profile_key or pp.package_version_id<>pv.id)),
  'policies',(select count(*) from exam_delivery.practice_policies where canonical_exam_key='${examKey}' and package_version='${packageVersion}' and enabled),
  'nonNullAttemptLimits',(select count(*) from exam_delivery.practice_policies where canonical_exam_key='${examKey}' and package_version='${packageVersion}' and maximum_completed_attempts is not null),
  'pbqPractice',(select count(*) from exam_delivery.practice_policies where canonical_exam_key='${examKey}' and package_version='${packageVersion}' and purpose='pbq_practice'),
  'nonStudyPolicyDrift',(select count(*) from exam_delivery.practice_policies where canonical_exam_key='${examKey}' and package_version='${packageVersion}' and purpose<>'study_sandbox' and (review_release_policy<>'after_submission' or answer_release_policy<>'after_submission')),
  'packagePolicyExact',(select count(*) from exam_delivery.package_versions where exam_key='${examKey}' and package_version='${packageVersion}' and declared_review_release_policy='after_submission' and declared_answer_release_policy='after_submission'),
  'catalogueRows',(select count(*) from public.exam_catalog where exam_key='${examKey}'),
  'catalogueExact',(select count(*) from public.exam_catalog where exam_key='${examKey}' and slug='${examKey}' and title='Python Next Generation' and vendor='Certiport' and exam_type='certification' and source_type='official_source' and current_version='${packageVersion}' and status='active'),
  'requests',(select count(*) from exam_delivery.exam_release_configuration_requests r join exam_delivery.package_versions pv on pv.id=r.package_version_id where pv.exam_key='${examKey}' and pv.package_version='${packageVersion}')
)::text;
rollback;
`);
const marker = transaction.split(/\r?\n/).find((line) => line.startsWith('ISSUE86_RELEASE_EVIDENCE:'));
assert.ok(marker, 'release simulation evidence marker is missing');
const evidence = JSON.parse(marker.slice('ISSUE86_RELEASE_EVIDENCE:'.length));

for (const [label, profileKey, releaseStage] of [
  ['noLabAcceptance', profiles[0], 'acceptance'],
  ['labAcceptance', profiles[1], 'acceptance'],
  ['noLabActive', profiles[0], 'standard_active_exam_v1'],
  ['labActive', profiles[1], 'standard_active_exam_v1'],
]) {
  assert.deepEqual(evidence.responses[label], {
    ok: true,
    configured: true,
    replayed: false,
    examKey,
    packageVersion,
    profileKey,
    releaseStage,
  });
}
assert.deepEqual({
  activations: evidence.activations,
  defaults: evidence.defaults,
  defaultMismatches: evidence.defaultMismatches,
  policies: evidence.policies,
  nonNullAttemptLimits: evidence.nonNullAttemptLimits,
  pbqPractice: evidence.pbqPractice,
  nonStudyPolicyDrift: evidence.nonStudyPolicyDrift,
  packagePolicyExact: evidence.packagePolicyExact,
  catalogueRows: evidence.catalogueRows,
  catalogueExact: evidence.catalogueExact,
  requests: evidence.requests,
}, {
  activations: 2,
  defaults: 10,
  defaultMismatches: 0,
  policies: 8,
  nonNullAttemptLimits: 0,
  pbqPractice: 0,
  nonStudyPolicyDrift: 0,
  packagePolicyExact: 1,
  catalogueRows: 1,
  catalogueExact: 1,
  requests: 4,
});

const afterRollback = queryEvidence();
assert.deepEqual({
  activations: afterRollback.activations,
  defaults: afterRollback.defaults,
  policies: afterRollback.policies,
  catalogue: afterRollback.catalogue,
  requests: afterRollback.requests,
}, { activations: 0, defaults: 0, policies: 0, catalogue: 0, requests: 0 });

console.log(JSON.stringify({
  ok: true,
  packagePublication: 'verified',
  candidates: initial.candidates,
  profiles,
  acceptanceStages: 2,
  activeStages: 2,
  logicalCatalogueRows: evidence.catalogueRows,
  maximumCompletedAttempts: null,
  pbqPracticePolicies: evidence.pbqPractice,
  declaredReleasePolicy: 'after_submission',
  transactionRolledBack: true,
  productionMutations: 0,
}, null, 2));

function queryEvidence() {
  return JSON.parse(scalar(`select json_build_object(
    'candidates',(select count(*) from exam_delivery.exam_release_candidates where canonical_exam_key='${examKey}' and package_version='${packageVersion}'),
    'packages',(select count(*) from exam_delivery.package_versions where exam_key='${examKey}' and package_version='${packageVersion}'),
    'published',(select count(*) from exam_delivery.package_versions where exam_key='${examKey}' and package_version='${packageVersion}' and status='published'),
    'profiles',(select count(*) from exam_delivery.package_profiles pp join exam_delivery.package_versions pv on pv.id=pp.package_version_id where pv.exam_key='${examKey}' and pv.package_version='${packageVersion}'),
    'profileKeys',(select coalesce(json_agg(pp.profile_key order by pp.profile_key),'[]'::json) from exam_delivery.package_profiles pp join exam_delivery.package_versions pv on pv.id=pp.package_version_id where pv.exam_key='${examKey}' and pv.package_version='${packageVersion}'),
    'activations',(select count(*) from exam_delivery.exam_profile_activations a join exam_delivery.package_versions pv on pv.id=a.package_version_id where pv.exam_key='${examKey}' and pv.package_version='${packageVersion}'),
    'defaults',(select count(*) from exam_delivery.package_profile_defaults where canonical_exam_key='${examKey}'),
    'policies',(select count(*) from exam_delivery.practice_policies where canonical_exam_key='${examKey}' and package_version='${packageVersion}'),
    'catalogue',(select count(*) from public.exam_catalog where exam_key='${examKey}'),
    'requests',(select count(*) from exam_delivery.exam_release_configuration_requests r join exam_delivery.package_versions pv on pv.id=r.package_version_id where pv.exam_key='${examKey}' and pv.package_version='${packageVersion}')
  )::text`));
}

function execute(sql) {
  return spawnSync(psql, ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', databaseUrl], {
    input: `${sql.trim()}\n`,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function run(sql) {
  const result = execute(sql);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'psql failed');
  return result.stdout.trim();
}

function scalar(sql) {
  return run(sql).split(/\r?\n/).filter(Boolean).at(-1)?.trim() ?? '';
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}
