import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SOURCE_MIGRATIONS,
  SOURCE_MIGRATION_HASHES,
  discoverSourceMigrations,
  prepareMigrationWorkspace,
  validateMigrationNames,
} from './supabase-migration-validation/prepare-migrations.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = path.join(projectRoot, '.github', 'workflows', 'backend-exam-delivery-db-validation.yml');
const configPath = path.join(projectRoot, 'supabase', 'config.toml');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'certsim-supabase-migrations-'));

try {
  assert.deepEqual(await discoverSourceMigrations(), SOURCE_MIGRATIONS);
  assert.equal(Object.keys(SOURCE_MIGRATION_HASHES).length, 95);
  assert.throws(
    () => validateMigrationNames(['0001_certsim_identity_foundation.sql']),
    /Legacy four-digit migration filenames/,
  );
  assert.throws(() => validateMigrationNames(SOURCE_MIGRATIONS.slice(0, 12)), /Migration set mismatch/);
  assert.throws(
    () => validateMigrationNames([...SOURCE_MIGRATIONS.slice(0, 1), SOURCE_MIGRATIONS[0], ...SOURCE_MIGRATIONS.slice(2)]),
    /Duplicate canonical migration timestamps/,
  );
  assert.throws(
    () => validateMigrationNames([...SOURCE_MIGRATIONS.slice(0, 13), '20260827071057_unexpected.sql']),
    /Migration set mismatch/,
  );
  assert.throws(
    () => validateMigrationNames([SOURCE_MIGRATIONS[1], SOURCE_MIGRATIONS[0], ...SOURCE_MIGRATIONS.slice(2)]),
    /Migration set mismatch/,
  );

  const baseline = await prepareMigrationWorkspace({
    setName: 'baseline',
    outputRoot: path.join(temporaryRoot, 'baseline'),
  });
  const foundation = await prepareMigrationWorkspace({
    setName: 'foundation',
    outputRoot: path.join(temporaryRoot, 'foundation'),
  });
  const operations = await prepareMigrationWorkspace({
    setName: 'operations',
    outputRoot: path.join(temporaryRoot, 'operations'),
  });
  const publication = await prepareMigrationWorkspace({ setName: 'publication', outputRoot: path.join(temporaryRoot, 'publication') });
  const issue59Preflight = await prepareMigrationWorkspace({ setName: 'issue59-preflight', outputRoot: path.join(temporaryRoot, 'issue59-preflight') });
  const assignment = await prepareMigrationWorkspace({ setName: 'assignment', outputRoot: path.join(temporaryRoot, 'assignment') });

  assert.equal(baseline.files.length, 12);
  assert.equal(foundation.files.length, 13);
  assert.equal(operations.files.length, 14);
  assert.equal(publication.files.length, 15);
  assert.equal(issue59Preflight.files.length, 53);
  assert.equal(assignment.files.length, 95);
  assert.deepEqual(baseline.files.map(({ fileName }) => fileName), SOURCE_MIGRATIONS.slice(0, 12));
  assert.deepEqual(foundation.files.map(({ fileName }) => fileName), SOURCE_MIGRATIONS.slice(0, 13));
  assert.deepEqual(operations.files.map(({ fileName }) => fileName), SOURCE_MIGRATIONS.slice(0, 14));
  assert.deepEqual(publication.files.map(({ fileName }) => fileName), SOURCE_MIGRATIONS.slice(0, 15));
  assert.deepEqual(issue59Preflight.files.map(({ fileName }) => fileName), SOURCE_MIGRATIONS.slice(0, 53));
  assert.deepEqual(assignment.files.map(({ fileName }) => fileName), SOURCE_MIGRATIONS);
  assert.ok(!baseline.files.some(({ fileName }) => fileName.startsWith('20260101000013_')));
  assert.ok(foundation.files.some(({ fileName }) => fileName.startsWith('20260101000013_')));
  assert.equal(SOURCE_MIGRATIONS.at(-42), '20260903120000_issue59_function_definition_line_ending_preflight.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-41), '20260903161929_issue_59_functional_recovery.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-40), '20260904161938_issue65_full_untimed_practice_sessions.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-39), '20260905090355_issue65_live_acceptance_lifecycle_fix.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-38), '20260905153716_ai901_canonical_form_rotation.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-37), '20260905192938_cross_version_package_compatibility.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-36), '20260906104745_register_sc200_runtime_contract.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-35), '20260906115046_selected_response_partial_scorer.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-34), '20260906134050_live_assignment_v2.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-33), '20260906143802_issue83_staged_exam_release.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-32), '20260907072022_issue83_sc200_mode_parity.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-31), '20260907101759_issue83_sc200_successor_cutover.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-30), '20260907152537_issue101_authoritative_trainer_analytics.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-29), '20260907175904_issue101_bounded_training_dashboard_learners.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-28), '20260907202755_issue101_staff_dashboard_summary_alias_fix.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-27), '20260908074922_issue101_learner_domain_parity.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-26), '20260908120351_issue85_python_standard_interaction_scoring.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-25), '20260908134811_issue85_python_standard_publication_contract.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-24), '20260908151342_issue85_python_standard_form_materialization.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-23), '20260908155215_issue85_inf303_release_configuration.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-22), '20260908182505_issue85_inf303_compact_mode_parity.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-21), '20260908182511_issue85_inf303_successor_cutover.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-20), '20260909072811_issue124_protected_array_response_validator_fix.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-19), '20260910133143_issue147_weak_area_options.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-18), '20260910172710_issue160_platform_owner_weak_area.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-17), '20260911093103_issue150_training_dashboard_learner_detail.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-16), '20260911215509_issue167_study_sandbox_lifecycle_recovery.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-15), '20260912144534_issue167_resume_rpc_volatility_fix.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-14), '20260914120212_issue86_python_lab_orchestration.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-13), '20260915063933_issue86_modal_execution_completion.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-12), '20260916103000_issue86_trusted_grading_completion.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-11), '20260916155319_issue86_python_next_generation_release_prep.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-10), '20260917074357_platform_owner_protected_exam_bypass.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-9), '20260917121244_issue86_executable_submission_run_restore.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-8), '20260917185333_issue86_live_submit_recovery.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-7), '20260920124528_issue133_examops_phase4b.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-6), '20260921044626_issue133_phase5a_operator_readonly.sql');
  assert.ok(Number(SOURCE_MIGRATIONS.at(-6).slice(0, 14)) > 20260101000013);
  assert.ok(SOURCE_MIGRATIONS.every((name) => !/^\d{4}_/.test(name)));

  for (const result of [baseline, foundation, operations, publication, issue59Preflight, assignment]) {
    const relativeOutput = path.relative(projectRoot, result.outputRoot);
    assert.ok(
      path.isAbsolute(relativeOutput) || relativeOutput.startsWith(`..${path.sep}`),
      'prepared workspace must be outside the repository',
    );
    const preparedFiles = (await readdir(path.join(result.outputRoot, 'supabase', 'migrations'))).sort();
    assert.deepEqual(preparedFiles, result.files.map(({ fileName }) => fileName));
    assert.equal(new Set(preparedFiles).size, preparedFiles.length);
    preparedFiles.forEach((name) => assert.match(name, /^\d{14}_.+\.sql$/));
  }

  const workflow = await readFile(workflowPath, 'utf8');
  const config = await readFile(configPath, 'utf8');

  assert.match(workflow, /^name: Backend exam-delivery database validation$/m);
  assert.match(workflow, /supabase@2\.115\.0/g);
  assert.match(workflow, /if:\s*always\(\)/g);
  assert.match(workflow, /stop --no-backup/g);
  assert.match(workflow, /--set baseline/);
  assert.match(workflow, /--set foundation/);
  assert.match(workflow, /--set operations/);
  assert.match(workflow, /--set publication/);
  assert.match(workflow, /--set issue59-preflight/);
  assert.match(workflow, /--set assignment/);
  assert.match(workflow, /issue59-crlf-production-shape\.sql/);
  assert.match(workflow, /issue59-crlf-postcheck\.sql/);
  assert.match(workflow, /db push --local --yes/);
  assert.match(workflow, /db advisors --local --type security --level info --fail-on error/);
  assert.match(workflow, /db advisors --local --type performance --level info --fail-on error/);
  assert.equal((workflow.match(/runs-on:\s*ubuntu-latest/g) ?? []).length, 1);
  assert.match(workflow, /group:\s*database-validation-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}/);
  assert.match(workflow, /cancel-in-progress:\s*true/);
  assert.match(workflow, /package-lock\.json/);
  assert.doesNotMatch(workflow, /^\s*- package\.json$/m);
  assert.equal((workflow.match(/Confirm pinned Supabase CLI once/g) ?? []).length, 1);
  assert.equal((workflow.match(/supabase@2\.115\.0 --version/g) ?? []).length, 1);
  assert.match(workflow, /for project in baseline foundation operations publication assignment/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflow, /qngnoctsdhzcpagesvxz|\.supabase\.co/i);
  assert.doesNotMatch(workflow, /supabase\s+(?:link|migration\s+repair|functions\s+deploy)/i);
  assert.doesNotMatch(workflow, /db\s+push[^\n]*(?:--linked|--project-ref|--db-url)/i);
  assert.doesNotMatch(workflow, /db\s+reset[^\n]*(?:--linked|--project-ref|--db-url)/i);
  assert.doesNotMatch(workflow, /migration\s+(?:up|repair)|db\s+pull/i);
  assert.doesNotMatch(config, /supabase\.co|certsimplatform\.com|qngnoctsdhzcpagesvxz/i);
  assert.doesNotMatch(config, /password|secret|token|oauth/i);
  assert.match(config, /major_version\s*=\s*17/);
  assert.match(config, /\[db\.seed\][\s\S]*?enabled\s*=\s*false/);

  console.log('PASS Supabase migration CI preparation and workflow validation');
  console.log(`  ${SOURCE_MIGRATIONS.length} canonical source migrations are hash-pinned; isolated copies retain their filenames.`);
  console.log('  Workflow is local-only, secret-free, CLI-pinned, and always cleans up containers.');
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
