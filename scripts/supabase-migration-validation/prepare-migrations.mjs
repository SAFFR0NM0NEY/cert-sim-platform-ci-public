import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOURCE_MIGRATIONS = Object.freeze([
  '20260101000001_certsim_identity_foundation.sql',
  '20260101000002_certsim_attempt_result_storage.sql',
  '20260101000003_identity_management_policy_fix.sql',
  '20260101000004_trainer_dashboard_policies.sql',
  '20260101000005_exam_assignment_mvp.sql',
  '20260101000006_profile_display_name_management.sql',
  '20260101000007_scoped_admin_detail_access.sql',
  '20260101000008_role_access_matrix_and_developer.sql',
  '20260101000009_account_lifecycle_cleanup.sql',
  '20260101000010_report_workflow_polish.sql',
  '20260101000011_invites_access_codes_onboarding.sql',
  '20260101000012_reception_placement_results.sql',
  '20260101000013_protected_exam_delivery_foundation.sql',
  '20260827071056_protected_exam_delivery_operations.sql',
  '20260827104924_protected_exam_delivery_publication.sql',
  '20260827161104_protected_exam_assignment_authorization.sql',
  '20260827174825_protected_assignment_invoker_boundary.sql',
  '20260827190935_protected_attempt_interruption_recovery.sql',
  '20260827192557_protected_attempt_identity_recovery.sql',
  '20260828142514_multi_exam_protected_delivery_foundation.sql',
  '20260828192747_generic_multi_exam_publication_lifecycle.sql',
  '20260828221028_lock_down_generic_lifecycle_helpers.sql',
  '20260828224638_package_v2_release_policy_declarations.sql',
  '20260828232102_expose_protected_attempt_package_version.sql',
  '20260829200302_repair_package_v2_dropdown_scoring.sql',
  '20260830075212_protected_practice_history_and_language.sql',
  '20260830093145_separate_practice_assessment_authorization.sql',
  '20260830102456_purpose_aware_attempt_continuation.sql',
  '20260830113215_purpose_aware_current_attempt_discovery.sql',
  '20260830121020_expired_practice_replacement_lifecycle.sql',
  '20260830131152_protected_result_authority_marker.sql',
  '20260831090240_repair_package_v2_ordering_scoring.sql',
  '20260901082946_purpose_aware_readiness_and_weak_area.sql',
  '20260901091859_allow_ai901_package_v2_runtime.sql',
  '20260901102814_protected_access_history_staff_analytics.sql',
  '20260901114217_purpose_aware_fixed_profile_counts.sql',
  '20260901122402_unify_attempt_continuation_authorization.sql',
  '20260901134555_bind_profile_eligibility_to_package_version.sql',
  '20260901185404_production_authorized_access_contract.sql',
  '20260901203655_protected_unified_history_analytics.sql',
  '20260901214515_r3d_staff_analytics_contract.sql',
  '20260901224945_r3e_assignment_scoped_performance.sql',
  '20260902052516_r3f_scoped_analytics_and_attempt_reconciliation.sql',
  '20260902143000_protected_runner_flags_and_issue_reports.sql',
  '20260902150000_r3h_atomic_attempt_replacement.sql',
  '20260902170209_issue25_legacy_result_compatibility.sql',
  '20260902175259_issue23_performance_dashboard_contract.sql',
  '20260902181321_issue23_scoped_assessment_history.sql',
  '20260902211457_learner_progress_summary_metrics.sql',
  '20260903034551_issue26_bounded_staff_filters.sql',
  '20260903041403_issue26_campus_scope_runtime_fix.sql',
  '20260903062901_issue26_legacy_classification_performance.sql',
  '20260903084553_p0_production_recovery_52_57.sql',
  '20260903120000_issue59_function_definition_line_ending_preflight.sql',
  '20260903161929_issue_59_functional_recovery.sql',
  '20260904161938_issue65_full_untimed_practice_sessions.sql',
]);

export const SOURCE_MIGRATION_HASHES = Object.freeze({
  '20260101000001_certsim_identity_foundation.sql': 'ee3e29e10ee7f56a48790e22a67671f1ca12670682b1f37b7817040a84a9b1e7',
  '20260101000002_certsim_attempt_result_storage.sql': '6b78634f5667fb29572b430d90359c174fc182bfed809e3eb9d409e824ec49c9',
  '20260101000003_identity_management_policy_fix.sql': 'c494e0fb25d7d278158cfcadd47bf70cb4e0e06c6dc88778a355312c0a639093',
  '20260101000004_trainer_dashboard_policies.sql': '75ca3d3c259d9265bef076114412916a042eaf6bbaca2d6f45090701577d45f1',
  '20260101000005_exam_assignment_mvp.sql': '452ee101d337d2a73cc83edcdbc2f1b31daf3f134d59261a4b70c0c937ac0a00',
  '20260101000006_profile_display_name_management.sql': 'bac678e236797719f22a43276ff4cc1a312e9582aa697a9a09a20ba090110cac',
  '20260101000007_scoped_admin_detail_access.sql': 'c9a7f0ba651a22f24e9a560c55f25dd857709287878e5bc5971ba4b2c2347cee',
  '20260101000008_role_access_matrix_and_developer.sql': 'acc1adb5ad52ee5af15136e32b1b63297e478184cb7690d46d40632552b7f426',
  '20260101000009_account_lifecycle_cleanup.sql': '8a7fa76c0608d5ccb8fed0573e5443299107f4868a70b7500f72b65c6fab3faa',
  '20260101000010_report_workflow_polish.sql': '7822b0caf03f86e646669b51f3e9c4d57ac870ad49bb42828fcaa54fc879ae3b',
  '20260101000011_invites_access_codes_onboarding.sql': 'a81560e6e54c6d716958268fc3fcbba5167f74ad35efe7138784d2fe4662d4f4',
  '20260101000012_reception_placement_results.sql': 'a553271d1479c4552fbc77e2a4240ef74735e4f69ffa900b5ea839a36321f189',
  '20260101000013_protected_exam_delivery_foundation.sql': '5d03add78615c89bbaea42a7b56aa85c37c68b2359dae4fc121ade9615059844',
  '20260827071056_protected_exam_delivery_operations.sql': '37eb1021baa4841be9ed9f5d930131fb603430182e56df1adc79869afdf31fa4',
  '20260827104924_protected_exam_delivery_publication.sql': 'a10e8f607d4cd0da4817f6e9cdaeed1a1ef6810a5e1b4e02668999338aa85eed',
  '20260827161104_protected_exam_assignment_authorization.sql': '9cafb5cda47cae6d59924e39eed9b2330dd88e94da946098753672bdc3cd2637',
  '20260827174825_protected_assignment_invoker_boundary.sql': '6ddd1a293cbbbcb6880a718a03e1ea29d001b2d410e5dc4a68800ad26390c8f1',
  '20260827190935_protected_attempt_interruption_recovery.sql': '2a7f2a19059fc7401af55455facb133cfba46581b1c8e585541fb98bdc1aec6e',
  '20260827192557_protected_attempt_identity_recovery.sql': 'de1e9a12f7239a2184142a8ef575e9b0fc2049e48ff92b1a28f59be5b787884e',
  '20260828142514_multi_exam_protected_delivery_foundation.sql': '32d3b854dc00a9d1fa8479e7b6d8a073b4ae6b36ae8e4edd45c4362083dbb507',
  '20260828192747_generic_multi_exam_publication_lifecycle.sql': 'a3d9b150c8bc3ddbe1c72a27254014195aba3ccdc108efc0a5367260276721c4',
  '20260828221028_lock_down_generic_lifecycle_helpers.sql': '968546d3e49f46bc753aa0e2e385148f56581f9bef7f5016ec8528bc2187ebfc',
  '20260828224638_package_v2_release_policy_declarations.sql': 'bf0a1d2c896e5651625d6dc605fce4ca4859bb5a74acc27b523fed6c1e2ee978',
  '20260828232102_expose_protected_attempt_package_version.sql': '1f22f824858a14d203bfdca8b26eb797dd0efcf2f532c005601574ba25f437ad',
  '20260829200302_repair_package_v2_dropdown_scoring.sql': '945e03ae0d254f191fe9741c41945da508587876eb0e80d4272c39d6d5b5b3de',
  '20260830075212_protected_practice_history_and_language.sql': '21dfed07dd94affcc553a44521388bfe3aeb236d95c54b2ec7df665d800833f2',
  '20260830093145_separate_practice_assessment_authorization.sql': 'e0f72c6b3125f0f70240ee8879eef3faae4263dc4f22dd9a4f6c417292d9c361',
  '20260830102456_purpose_aware_attempt_continuation.sql': '92cd1989187a503cd2109ea079091e5a38e36ced901b9f48f163d06b6be704af',
  '20260830113215_purpose_aware_current_attempt_discovery.sql': 'e3068b813edc7d3ebc2312f8f906e79a4a77d4bd41db6e54dea7430529a72b8f',
  '20260830121020_expired_practice_replacement_lifecycle.sql': '940127cd1da5b68ec1df82f6934a528fd0feacffb44cc2022f99fc271071a483',
  '20260830131152_protected_result_authority_marker.sql': '43a80f65a8e9a20e78c7e3c19262c2b3f935f6f3b3403c6047794e0c8e4bc0e2',
  '20260831090240_repair_package_v2_ordering_scoring.sql': '58548eff06d1b1f3887535903fcdc224a1dddef5782ed63a8cf9242c6f85d6fa',
  '20260901082946_purpose_aware_readiness_and_weak_area.sql': '8953f3f0d79ea0bfcdb15d5c31e757ef34b4e4c6e5b7d7c8e9169648ed575ec3',
  '20260901091859_allow_ai901_package_v2_runtime.sql': '65525101f91df2fe4820396c34f9593a54cb9d711505d1bd0f81b239d47c716c',
  '20260901102814_protected_access_history_staff_analytics.sql': '385abd203436b107d666c3d418251f81a8816806ab1dc2f456cd116ad78057b9',
  '20260901114217_purpose_aware_fixed_profile_counts.sql': '3f149423a7cabc2e232269c3ed4792d5051278b63fe7c3ce1e00429f17e9236b',
  '20260901122402_unify_attempt_continuation_authorization.sql': '81269a0624ffde46ee9500ab90476f5427628819a92d88fd4088f8a794d6b2f4',
  '20260901134555_bind_profile_eligibility_to_package_version.sql': 'ee5b7068bce77aef2bc0eb083eb16dcb0777eaaf5fcac772d0d8819c073832a7',
  '20260901185404_production_authorized_access_contract.sql': '2686483e40a182264042821c340d4903b3ed6288e7c1c6f0de1f148043e6c390',
  '20260901203655_protected_unified_history_analytics.sql': 'c7d125b4b6c4bf4c64227f1f7ee27614622be0effcf8296bb6b9c346a83d820e',
  '20260901214515_r3d_staff_analytics_contract.sql': '362dc439a4501168dd81243c73940810b1052669f1e0011d0d4a4d4a20db3eca',
  '20260901224945_r3e_assignment_scoped_performance.sql': '1c047f5270fd2bf077611140b4df8fdfcfab82be7ba7639e16d9438e0222b85b',
  '20260902052516_r3f_scoped_analytics_and_attempt_reconciliation.sql': 'e38c855cdbd23365190a566737cb23340f517b8585ca9ebc63966d245519d240',
  '20260902143000_protected_runner_flags_and_issue_reports.sql': '037043de2e7cfd76ddc86aa54673440b468cfabd165f37a5abe7a1582573ce4a',
  '20260902150000_r3h_atomic_attempt_replacement.sql': 'a8a175d5063b80822086504a76e4e7f8301910f242e95f5b38edb81214ed8f29',
  '20260902170209_issue25_legacy_result_compatibility.sql': '52b679fb91b40602faea424d472039c236e1c18c0d6674a46cd2774c2a7ec257',
  '20260902175259_issue23_performance_dashboard_contract.sql': '55cf0477d31ca56d5dc4193a7705beaa79ecbbb060e459db2c53b29c850ff57a',
  '20260902181321_issue23_scoped_assessment_history.sql': 'c4982a1943f7060f6d4969d54236fcb2719b575feac671f50676ee74f3183319',
  '20260902211457_learner_progress_summary_metrics.sql': 'ee13a1e0f923d7bca283f765c2231c690bd0185af570a34a9701fc1acd9dae7d',
  '20260903034551_issue26_bounded_staff_filters.sql': 'da5d35e989f84e239926ece04d68f989199986b296d5fbb96833a528d339a04c',
  '20260903041403_issue26_campus_scope_runtime_fix.sql': '1664254d8bbeb75e7eb38c4d6cfab121877a53c8a9b808776bed402a3f77d36d',
  '20260903062901_issue26_legacy_classification_performance.sql': 'd39a887ea322881435f8afd7f3f2dbbe6be9d8fdd5debde4777c59aefde2bcc7',
  '20260903084553_p0_production_recovery_52_57.sql': '78840df042ed88249df54da6429d255bfffa8e6e3789e624b5db3a733f7782aa',
  '20260903120000_issue59_function_definition_line_ending_preflight.sql': '04372a4f9a2ada64a00298053ef43c454b690ffa34f0a70b8d55fff4584ddf48',
  '20260903161929_issue_59_functional_recovery.sql': '0e1e80fcf7d3c37d15ce558fd7a2ebcf5e6b2bfed6dcfb685e99bafef47d9877',
  '20260904161938_issue65_full_untimed_practice_sessions.sql': 'e28ae5c34e33260d50840031bc6a318c43f5f1bfeb0acc48d4de4223aebe0855',
});

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourceDirectory = path.join(projectRoot, 'supabase', 'migrations');
const sourceConfigPath = path.join(projectRoot, 'supabase', 'config.toml');
export async function discoverSourceMigrations() {
  const discovered = (await readdir(sourceDirectory))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  validateMigrationNames(discovered);
  return discovered;
}

export function validateMigrationNames(discovered) {
  if (discovered.some((name) => /^\d{4}_/.test(name))) {
    throw new Error('Legacy four-digit migration filenames are not supported.');
  }

  const versions = discovered.map((name) => name.match(/^(\d{14})_.+\.sql$/)?.[1]);

  if (versions.some((version) => !version)) {
    throw new Error('Every migration must use a 14-digit canonical timestamp.');
  }
  if (new Set(versions).size !== versions.length) {
    throw new Error('Duplicate canonical migration timestamps are not supported.');
  }
  if (JSON.stringify(discovered) !== JSON.stringify(SOURCE_MIGRATIONS)) {
    throw new Error(
      `Migration set mismatch. Expected ${SOURCE_MIGRATIONS.join(', ')}; found ${discovered.join(', ') || 'none'}.`,
    );
  }

  SOURCE_MIGRATIONS.forEach((name, index) => {
    if (index < 13) {
      const expectedNumber = `202601010000${String(index + 1).padStart(2, '0')}`;
      if (name.slice(0, 14) !== expectedNumber) {
        throw new Error(`Migration order mismatch at ${name}; expected ${expectedNumber}.`);
      }
    } else if (index === 13 && name !== '20260827071056_protected_exam_delivery_operations.sql') {
      throw new Error(`Operations migration filename mismatch: ${name}.`);
    } else if (index === 14 && name !== '20260827104924_protected_exam_delivery_publication.sql') {
      throw new Error(`Publication migration filename mismatch: ${name}.`);
    } else if (index === 15 && name !== '20260827161104_protected_exam_assignment_authorization.sql') {
      throw new Error(`Protected assignment migration filename mismatch: ${name}.`);
    } else if (index === 16 && name !== '20260827174825_protected_assignment_invoker_boundary.sql') {
      throw new Error(`Protected assignment boundary migration filename mismatch: ${name}.`);
    } else if (index === 17 && name !== '20260827190935_protected_attempt_interruption_recovery.sql') {
      throw new Error(`Protected attempt recovery migration filename mismatch: ${name}.`);
    } else if (index === 18 && name !== '20260827192557_protected_attempt_identity_recovery.sql') {
      throw new Error(`Protected attempt identity recovery migration filename mismatch: ${name}.`);
    } else if (index === 19 && name !== '20260828142514_multi_exam_protected_delivery_foundation.sql') {
      throw new Error(`Multi-exam foundation migration filename mismatch: ${name}.`);
    } else if (index === 20 && name !== '20260828192747_generic_multi_exam_publication_lifecycle.sql') {
      throw new Error(`Generic lifecycle migration filename mismatch: ${name}.`);
    } else if (index === 21 && name !== '20260828221028_lock_down_generic_lifecycle_helpers.sql') {
      throw new Error(`Generic lifecycle privilege migration filename mismatch: ${name}.`);
    } else if (index === 22 && name !== '20260828224638_package_v2_release_policy_declarations.sql') {
      throw new Error(`Package release-policy migration filename mismatch: ${name}.`);
    } else if (index === 23 && name !== '20260828232102_expose_protected_attempt_package_version.sql') {
      throw new Error(`Protected attempt package-version projection migration filename mismatch: ${name}.`);
    } else if (index === 24 && name !== '20260829200302_repair_package_v2_dropdown_scoring.sql') {
      throw new Error(`Package-v2 dropdown scoring repair migration filename mismatch: ${name}.`);
    } else if (index === 25 && name !== '20260830075212_protected_practice_history_and_language.sql') {
      throw new Error(`Protected practice/history migration filename mismatch: ${name}.`);
    } else if (index === 26 && name !== '20260830093145_separate_practice_assessment_authorization.sql') {
      throw new Error(`Practice/assessment authorization migration filename mismatch: ${name}.`);
    } else if (index === 27 && name !== '20260830102456_purpose_aware_attempt_continuation.sql') {
      throw new Error(`Purpose-aware continuation migration filename mismatch: ${name}.`);
    } else if (index === 28 && name !== '20260830113215_purpose_aware_current_attempt_discovery.sql') {
      throw new Error(`Purpose-aware current discovery migration filename mismatch: ${name}.`);
    } else if (index === 29 && name !== '20260830121020_expired_practice_replacement_lifecycle.sql') {
      throw new Error(`Expired practice replacement migration filename mismatch: ${name}.`);
    } else if (index === 30 && name !== '20260830131152_protected_result_authority_marker.sql') {
      throw new Error(`Protected result authority marker migration filename mismatch: ${name}.`);
    } else if (index === 31 && name !== '20260831090240_repair_package_v2_ordering_scoring.sql') {
      throw new Error(`Package-v2 ordering scorer repair migration filename mismatch: ${name}.`);
    }
  });

}

export async function prepareMigrationWorkspace({ setName, outputRoot }) {
  if (!['baseline', 'foundation', 'operations', 'publication', 'issue59-preflight', 'assignment'].includes(setName)) {
    throw new Error('Migration set must be baseline, foundation, operations, publication, issue59-preflight, or assignment.');
  }
  if (!path.isAbsolute(outputRoot)) {
    throw new Error('Output root must be an absolute temporary path.');
  }

  const resolvedOutput = path.resolve(outputRoot);
  const relativeToProject = path.relative(projectRoot, resolvedOutput);

  if (relativeToProject === '' || (!relativeToProject.startsWith('..') && !path.isAbsolute(relativeToProject))) {
    throw new Error('Prepared migrations must be written outside the repository.');
  }

  const discovered = await discoverSourceMigrations();
  const selected = setName === 'baseline'
    ? discovered.slice(0, 12)
    : setName === 'foundation'
      ? discovered.slice(0, 13)
      : setName === 'operations' ? discovered.slice(0, 14)
        : setName === 'publication' ? discovered.slice(0, 15)
          : setName === 'issue59-preflight'
            ? discovered.slice(0, discovered.indexOf('20260903120000_issue59_function_definition_line_ending_preflight.sql'))
            : discovered;
  const targetSupabase = path.join(resolvedOutput, 'supabase');
  const targetMigrations = path.join(targetSupabase, 'migrations');

  await rm(resolvedOutput, { recursive: true, force: true });
  await mkdir(targetMigrations, { recursive: true });
  await copyFile(sourceConfigPath, path.join(targetSupabase, 'config.toml'));

  const files = [];

  for (const sourceName of selected) {
    const sourcePath = path.join(sourceDirectory, sourceName);
    const bytes = await readFile(sourcePath);
    const sourceHash = canonicalSha256(bytes);

    if (sourceHash !== SOURCE_MIGRATION_HASHES[sourceName]) {
      throw new Error(`Source migration hash changed: ${sourceName}.`);
    }

    const targetPath = path.join(targetMigrations, sourceName);
    await copyFile(sourcePath, targetPath);

    if (sha256(await readFile(targetPath)) !== sha256(bytes)) {
      throw new Error(`Prepared migration bytes differ from source: ${sourceName}.`);
    }

    files.push(Object.freeze({ fileName: sourceName, sha256: sourceHash }));
  }

  return Object.freeze({ setName, outputRoot: resolvedOutput, files: Object.freeze(files) });
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalSha256(bytes) {
  return sha256(Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'), 'utf8'));
}

async function runCli() {
  const result = await prepareMigrationWorkspace(parseArguments(process.argv.slice(2)));

  console.log(`Prepared ${result.setName} canonical migration filenames:`);
  result.files.forEach(({ fileName }) => {
    console.log(`  ${fileName}`);
  });
}

function parseArguments(args) {
  const values = {};

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];

    if (!['--set', '--output'].includes(flag) || !value) {
      throw new Error('Usage: node prepare-migrations.mjs --set <baseline|foundation|operations|publication|issue59-preflight|assignment> --output <absolute-temp-path>');
    }
    values[flag] = value;
  }

  return { setName: values['--set'], outputRoot: values['--output'] };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runCli();
}
