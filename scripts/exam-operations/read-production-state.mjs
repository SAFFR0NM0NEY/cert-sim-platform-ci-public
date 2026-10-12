import { execFile } from 'node:child_process';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SUPABASE_CLI_VERSION = '2.115.0';
const EXAM_KEY_PATTERN = /^[a-z0-9]+$/;

export async function readProductionExamOperationsState(examKey, options = {}) {
  const normalized = normalizeExamKey(examKey);
  if (!normalized) throw new Error('EXAMOPS_EXAM_KEY_INVALID');
  const workdir = path.resolve(
    options.workdir
      ?? process.env.CERTSIM_SUPABASE_WORKDIR
      ?? process.cwd(),
  );
  const invocation = npxInvocation();
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), 'certsim-examops-read-'),
  );
  const capabilityFile = path.join(temporaryDirectory, 'exam-health-capability-read-only.sql');
  const queryFile = path.join(temporaryDirectory, 'exam-health-read-only.sql');

  try {
    const execute = options.execute ?? execFileAsync;
    await writeFile(capabilityFile, buildExamOperationsCapabilityQuery(), {
      encoding: 'utf8', flag: 'wx',
    });
    const capability = await executeReadQuery({
      execute, invocation, queryFile: capabilityFile, workdir,
    });
    await writeFile(queryFile, buildExamOperationsReadQuery(normalized, {
      genericReleaseOperations: capability.genericReleaseOperations === true,
    }), { encoding: 'utf8', flag: 'wx' });
    const { stdout } = await executeReadQuery({
      execute, invocation, queryFile, workdir, raw: true,
    });
    return parseSupabaseQueryOutput(stdout);
  } catch {
    throw new Error('READ_ONLY_DATA_ACCESS_BLOCKER');
  } finally {
    await unlink(capabilityFile).catch(() => {});
    await unlink(queryFile).catch(() => {});
    await rmdir(temporaryDirectory).catch(() => {});
  }
}

async function executeReadQuery({ execute, invocation, queryFile, workdir, raw = false }) {
  const args = [
    ...invocation.prefixArgs,
    '--yes',
    `supabase@${SUPABASE_CLI_VERSION}`,
    'db',
    'query',
    '--linked',
    '--output-format',
    'json',
    '--log-level',
    'error',
    '--file',
    queryFile,
    '--workdir',
    workdir,
  ];
  const result = await execute(invocation.command, args, {
    cwd: workdir,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    env: process.env,
  });
  return raw ? result : parseSupabaseQueryOutput(result.stdout);
}

function npxInvocation() {
  if (process.platform !== 'win32') {
    return { command: 'npx', prefixArgs: [] };
  }
  return {
    command: process.execPath,
    prefixArgs: [
      path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'),
    ],
  };
}

export function parseSupabaseQueryOutput(output) {
  const lines = String(output ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trimStart().startsWith('{'));
  if (start < 0) throw new Error('READ_ONLY_DATA_ACCESS_BLOCKER');
  let candidate = '';
  for (let index = start; index < lines.length; index += 1) {
    candidate += `${lines[index]}\n`;
    try {
      const parsed = JSON.parse(candidate);
      const snapshot = parsed?.rows?.[0]?.snapshot;
      if (!snapshot || typeof snapshot !== 'object') {
        throw new Error('READ_ONLY_DATA_ACCESS_BLOCKER');
      }
      return snapshot;
    } catch (error) {
      if (error?.message === 'READ_ONLY_DATA_ACCESS_BLOCKER') throw error;
    }
  }
  throw new Error('READ_ONLY_DATA_ACCESS_BLOCKER');
}

export function buildExamOperationsCapabilityQuery() {
  return `select jsonb_build_object(
  'genericReleaseOperations',to_regclass('exam_delivery.exam_release_operations') is not null
) as snapshot`;
}

export function buildExamOperationsReadQuery(examKey, options = {}) {
  const normalized = normalizeExamKey(examKey);
  if (!normalized) throw new Error('EXAMOPS_EXAM_KEY_INVALID');
  const literal = `'${normalized}'`;
  const genericReleaseCte = options.genericReleaseOperations === true
    ? `latest_generic_release as (
  select jsonb_build_object(
    'packageVersion',pv.package_version,
    'profileKey',null,
    'releaseStage','examops-'||lower(operation.operation_type),
    'configuredAt',coalesce(operation.completed_at,operation.created_at),
    'source','generic-exam-operations',
    'operationType',operation.operation_type,
    'resultState',operation.result_state
  ) value
  from exam_delivery.exam_release_operations operation
  left join exam_packages pv on pv.id=operation.target_package_id
  join params on operation.canonical_exam_key=params.exam_key
  where operation.result_state='succeeded'
    and operation.operation_type in ('ACTIVATE','ROLLBACK')
  order by coalesce(operation.completed_at,operation.created_at) desc,operation.id desc
  limit 1
),`
    : `latest_generic_release as (
  select null::jsonb value
),`;
  return `with
params as (
  select ${literal}::text as exam_key
),
exam_packages as (
  select pv.*
  from exam_delivery.package_versions pv, params
  where exam_delivery.normalize_exam_key(pv.exam_key)=params.exam_key
),
package_profiles as (
  select pp.*
  from exam_delivery.package_profiles pp
  join exam_packages pv on pv.id=pp.package_version_id
),
packages_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'internalPackageId',pv.id,
    'packageVersion',pv.package_version,
    'status',pv.status,
    'supersedesInternalPackageId',pv.supersedes_package_version_id,
    'validationHash',pv.validation_hash,
    'packageHash',pv.package_hash,
    'packageSchemaVersion',pv.package_schema_version,
    'generatorVersion',pv.generator_version,
    'scorerVersion',pv.scorer_version,
    'declaredReviewReleasePolicy',pv.declared_review_release_policy,
    'declaredAnswerReleasePolicy',pv.declared_answer_release_policy,
    'publishedAt',pv.published_at
  ) order by pv.package_version),'[]'::jsonb) value
  from exam_packages pv
),
profiles_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'internalProfileId',pp.id,
    'internalPackageId',pp.package_version_id,
    'profileKey',pp.profile_key,
    'displayName',pp.display_name,
    'questionCount',pp.question_count,
    'timeLimitMinutes',pp.time_limit_minutes,
    'standardQuestionCount',case when jsonb_typeof(pp.selection_config->'standardQuestionCount')='number' then (pp.selection_config->>'standardQuestionCount')::integer end,
    'normalScoredQuestionCount',case when jsonb_typeof(pp.selection_config->'normalScoredQuestionCount')='number' then (pp.selection_config->>'normalScoredQuestionCount')::integer end,
    'caseStudyCount',case when jsonb_typeof(pp.selection_config->'caseStudyCount')='number' then (pp.selection_config->>'caseStudyCount')::integer end,
    'longCaseStudyCount',case when jsonb_typeof(pp.selection_config->'longCaseStudyCount')='number' then (pp.selection_config->>'longCaseStudyCount')::integer end,
    'shortCaseStudyCount',case when jsonb_typeof(pp.selection_config->'shortCaseStudyCount')='number' then (pp.selection_config->>'shortCaseStudyCount')::integer end,
    'caseStudyQuestionCount',case when jsonb_typeof(pp.selection_config->'caseStudyQuestionCount')='number' then (pp.selection_config->>'caseStudyQuestionCount')::integer end,
    'pbqCount',case when jsonb_typeof(pp.selection_config->'pbqCount')='number' then (pp.selection_config->>'pbqCount')::integer end,
    'executableCount',case when jsonb_typeof(pp.selection_config->'executableCount')='number' then (pp.selection_config->>'executableCount')::integer end,
    'sectionOrder',pp.selection_config->'sectionOrder',
    'formContractVersion',pp.selection_config#>>'{canonicalForms,contractVersion}'
  ) order by pp.profile_key,pv.package_version),'[]'::jsonb) value
  from package_profiles pp
  join exam_packages pv on pv.id=pp.package_version_id
),
questions_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'internalPackageId',q.package_version_id,
    'questionIdentity',q.question_id,
    'contentHash',q.content_hash,
    'interactionType',q.question_type,
    'domainKey',q.domain_key,
    'objectiveKey',coalesce(nullif(q.section_key,''),nullif(q.presentation_payload->>'officialObjectiveKey','')),
    'scored',coalesce((protected.authoring_metadata->>'scored')::boolean,true),
    'caseRole',protected.authoring_metadata#>>'{group,role}'
  ) order by pv.package_version,q.question_id),'[]'::jsonb) value
  from exam_delivery.package_questions q
  join exam_packages pv on pv.id=q.package_version_id
  left join exam_delivery.package_question_protected_content protected
    on protected.question_id=q.id and protected.package_version_id=q.package_version_id
),
forms_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'internalPackageId',form.package_version_id,
    'internalProfileId',form.package_profile_id,
    'formOrdinal',form.form_ordinal,
    'membershipHash',form.membership_hash,
    'itemCount',form.question_count,
    'scoredItemCount',(
      select count(*)::integer
      from exam_delivery.package_form_questions member
      join exam_delivery.package_question_protected_content protected
        on protected.question_id=member.package_question_id
       and protected.package_version_id=member.package_version_id
      where member.form_id=form.id
        and coalesce((protected.authoring_metadata->>'scored')::boolean,true)
    )
  ) order by pv.package_version,profile.profile_key,form.form_ordinal),'[]'::jsonb) value
  from exam_delivery.package_forms form
  join exam_packages pv on pv.id=form.package_version_id
  join package_profiles profile on profile.id=form.package_profile_id
),
package_stats_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'internalPackageId',pv.id,
    'caseStudyGroupCount',(
      select count(distinct protected.authoring_metadata#>>'{group,groupKey}')::integer
      from exam_delivery.package_questions q
      join exam_delivery.package_question_protected_content protected
        on protected.question_id=q.id and protected.package_version_id=q.package_version_id
      where q.package_version_id=pv.id
        and protected.authoring_metadata#>>'{group,role}'='context'
        and nullif(protected.authoring_metadata#>>'{group,groupKey}','') is not null
    ),
    'reserveItemCount',(
      select count(*)::integer from exam_delivery.package_reserve_questions reserve
      where reserve.package_version_id=pv.id
    )
  ) order by pv.package_version),'[]'::jsonb) value
  from exam_packages pv
),
defaults_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'internalPackageId',d.package_version_id,
    'internalProfileId',d.package_profile_id,
    'packageVersion',pv.package_version,
    'profileKey',d.profile_key,
    'purpose',d.purpose,
    'enabled',d.enabled
  ) order by d.profile_key,d.purpose),'[]'::jsonb) value
  from exam_delivery.package_profile_defaults d
  left join exam_packages pv on pv.id=d.package_version_id
  join params on d.canonical_exam_key=params.exam_key
),
activations_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'internalPackageId',activation.package_version_id,
    'internalProfileId',activation.package_profile_id,
    'packageVersion',pv.package_version,
    'profileKey',profile.profile_key,
    'activationKind',activation.activation_kind,
    'enabled',activation.enabled
  ) order by pv.package_version,profile.profile_key,activation.activation_kind),'[]'::jsonb) value
  from exam_delivery.exam_profile_activations activation
  join exam_packages pv on pv.id=activation.package_version_id
  join package_profiles profile on profile.id=activation.package_profile_id
),
policies_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'internalPackageId',pv.id,
    'internalProfileId',profile.id,
    'packageVersion',policy.package_version,
    'profileKey',policy.profile_key,
    'purpose',policy.purpose,
    'enabled',policy.enabled,
    'accessMode',policy.access_mode,
    'maximumSessionItems',policy.maximum_session_items,
    'immediateFeedback',policy.immediate_feedback,
    'reviewReleasePolicy',policy.review_release_policy,
    'answerReleasePolicy',policy.answer_release_policy
  ) order by policy.package_version,policy.profile_key,policy.purpose),'[]'::jsonb) value
  from exam_delivery.practice_policies policy
  join params on policy.canonical_exam_key=params.exam_key
  left join exam_packages pv on pv.package_version=policy.package_version
  left join package_profiles profile
    on profile.package_version_id=pv.id and profile.profile_key=policy.profile_key
),
attempts_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'packageVersion',active.package_version,
    'profileKey',active.profile_key,
    'purpose',active.purpose,
    'activeCount',active.active_count
  ) order by active.package_version,active.profile_key,active.purpose),'[]'::jsonb) value
  from (
    select pv.package_version,profile.profile_key,a.purpose,count(*)::integer active_count
    from exam_delivery.attempts a
    join exam_packages pv on pv.id=a.package_version_id
    join package_profiles profile on profile.id=a.package_profile_id
    where a.status='in_progress'
      and (
        (a.purpose in ('assigned_assessment','self_directed_exam')
          and a.expires_at is not null and a.expires_at>statement_timestamp())
        or
        (a.purpose in ('study_sandbox','targeted_domain','weak_area','pbq_practice')
          and a.practice_idle_expires_at is not null
          and a.practice_idle_expires_at>statement_timestamp())
      )
      and not exists (
        select 1 from exam_delivery.attempt_replacements replacement
        where replacement.replaced_attempt_id=a.id
      )
      and not exists (
        select 1 from exam_delivery.practice_attempt_expirations expiration
        where expiration.expired_attempt_id=a.id
      )
    group by pv.package_version,profile.profile_key,a.purpose
  ) active
),
latest_publication as (
  select jsonb_build_object(
    'packageVersion',pv.package_version,
    'status',run.status,
    'errorCode',run.error_code,
    'createdAt',run.created_at,
    'completedAt',run.completed_at
  ) value
  from exam_delivery.publication_runs run
  join exam_packages pv on pv.id=run.package_version_id
  order by run.created_at desc
  limit 1
),
${genericReleaseCte}
latest_release as (
  select jsonb_build_object(
    'packageVersion',pv.package_version,
    'profileKey',profile.profile_key,
    'releaseStage',request.release_stage,
    'configuredAt',request.configured_at
  ) value
  from exam_delivery.exam_release_configuration_requests request
  join exam_packages pv on pv.id=request.package_version_id
  join package_profiles profile on profile.id=request.package_profile_id
  join params on request.canonical_exam_key=params.exam_key
  order by request.configured_at desc
  limit 1
)
select jsonb_build_object(
  'examKey',(select exam_key from params),
  'observedAt',statement_timestamp(),
  'packages',(select value from packages_json),
  'profiles',(select value from profiles_json),
  'questionRecords',(select value from questions_json),
  'forms',(select value from forms_json),
  'packageStats',(select value from package_stats_json),
  'defaults',(select value from defaults_json),
  'activations',(select value from activations_json),
  'practicePolicies',(select value from policies_json),
  'attemptAggregates',(select value from attempts_json),
  'latestPublication',(select value from latest_publication),
  'latestReleaseConfiguration',coalesce(
    (select value from latest_generic_release),
    (select value from latest_release)
  )
) as snapshot`;
}

function normalizeExamKey(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return EXAM_KEY_PATTERN.test(normalized) ? normalized : null;
}
