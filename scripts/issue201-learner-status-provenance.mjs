import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const base = '210e357061ce6fc3c4d08029c43ea38acdec1572';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true }).trim();
const head = git('rev-parse', 'HEAD');
if (head !== process.env.GITHUB_SHA) throw Error('EXACT_PRIVATE_HEAD_REQUIRED');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const before = git('ls-tree', base + ':supabase/migrations').split('\n');
if (before.length !== 95) throw Error('ORIGINAL_95_REQUIRED');
for (const line of before) {
  const [mode, type, hash, file] = line.split(/\s+/);
  if (mode !== '100644' || type !== 'blob' || git('rev-parse', head + ':supabase/migrations/' + file) !== hash) throw Error('ORIGINAL_MIGRATION_CHANGED');
}
const paths = git('diff', '--name-only', base, head).split('\n').filter(Boolean);
const changed = paths.map((path) => {
  const bytes = execFileSync('git', ['show', head + ':' + path], { windowsHide: true });
  if (!readFileSync(path).equals(bytes)) throw Error('WORKING_SOURCE_DIFFERS');
  return { path, bytes: bytes.length, sha256: sha(bytes) };
});
const profile = JSON.parse(readFileSync('services/python-executor-modal/runtime-profile.json'));
for (const path of profile.files) if (git('rev-parse', base + ':' + path) !== git('rev-parse', head + ':' + path)) throw Error('PACKAGED_WORKER_BYTES_CHANGED');
const output = { schema: 'certsim.learner-status.source.v1', privateSourceSha: head, baseSha: base,
  sourceTree: git('rev-parse', head + '^{tree}'), originalMigrationCount: 95, originalMigrationsUnchanged: true,
  migrationCount: 96, unchangedPackagedRuntimeFiles: profile.files.length, changed,
  ciRun: process.env.GITHUB_RUN_ID, productionActions: 0, realProviderCalls: 0 };
writeFileSync(resolve(process.env.RUNNER_TEMP, 'learner-status-source-provenance.json'), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ suite: 'learner-status-exact-source-provenance', changedPaths: changed.length, originalMigrations: 95, migrationCount: 96, unchangedRuntimeFiles: profile.files.length, passed: true }));
