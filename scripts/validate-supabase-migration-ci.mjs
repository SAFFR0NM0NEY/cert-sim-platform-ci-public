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
  assert.equal(Object.keys(SOURCE_MIGRATION_HASHES).length, 57);
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
  assert.equal(assignment.files.length, 57);
  assert.deepEqual(baseline.files.map(({ fileName }) => fileName), SOURCE_MIGRATIONS.slice(0, 12));
  assert.deepEqual(foundation.files.map(({ fileName }) => fileName), SOURCE_MIGRATIONS.slice(0, 13));
  assert.deepEqual(operations.files.map(({ fileName }) => fileName), SOURCE_MIGRATIONS.slice(0, 14));
  assert.deepEqual(publication.files.map(({ fileName }) => fileName), SOURCE_MIGRATIONS.slice(0, 15));
  assert.deepEqual(issue59Preflight.files.map(({ fileName }) => fileName), SOURCE_MIGRATIONS.slice(0, 53));
  assert.deepEqual(assignment.files.map(({ fileName }) => fileName), SOURCE_MIGRATIONS);
  assert.ok(!baseline.files.some(({ fileName }) => fileName.startsWith('20260101000013_')));
  assert.ok(foundation.files.some(({ fileName }) => fileName.startsWith('20260101000013_')));
  assert.equal(SOURCE_MIGRATIONS.at(-5), '20260903084553_p0_production_recovery_52_57.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-4), '20260903120000_issue59_function_definition_line_ending_preflight.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-3), '20260903161929_issue_59_functional_recovery.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-2), '20260904161938_issue65_full_untimed_practice_sessions.sql');
  assert.equal(SOURCE_MIGRATIONS.at(-1), '20260905090355_issue65_live_acceptance_lifecycle_fix.sql');
  assert.ok(Number(SOURCE_MIGRATIONS.at(-1).slice(0, 14)) > 20260101000013);
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
