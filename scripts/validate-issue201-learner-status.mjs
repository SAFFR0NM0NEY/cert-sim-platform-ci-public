import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { SOURCE_MIGRATIONS, SOURCE_MIGRATION_HASHES, discoverSourceMigrations } from './supabase-migration-validation/prepare-migrations.mjs';
const root = resolve(import.meta.dirname, '..');
const base = '210e357061ce6fc3c4d08029c43ea38acdec1572';
const git = (...args) => execFileSync('git', ['-c', 'safe.directory=' + root, '-C', root, ...args], { windowsHide: true });
const canonical = (bytes) => Buffer.from(bytes.toString('utf8').replaceAll('\r\n', '\n'));
const digest = (bytes) => createHash('sha256').update(canonical(bytes)).digest('hex');
assert.deepEqual(await discoverSourceMigrations(), SOURCE_MIGRATIONS);
assert.equal(SOURCE_MIGRATIONS.length, 102);
assert.equal(Object.keys(SOURCE_MIGRATION_HASHES).length, 102);
for (const name of SOURCE_MIGRATIONS) assert.equal(digest(readFileSync(resolve(root, 'supabase/migrations', name))), SOURCE_MIGRATION_HASHES[name], 'Pinned migration hash: ' + name);
const original = git('ls-tree', base + ':supabase/migrations').toString().trim().split('\n');
assert.equal(original.length, 95);
for (const row of original) {
  const [mode, type, , name] = row.split(/\s+/);
  assert.equal(mode, '100644'); assert.equal(type, 'blob');
  assert.equal(canonical(readFileSync(resolve(root, 'supabase/migrations', name))).equals(git('show', base + ':supabase/migrations/' + name)), true, 'Original migration unchanged: ' + name);
}
const profile = JSON.parse(readFileSync(resolve(root, 'services/python-executor-modal/runtime-profile.json')));
for (const path of [...profile.files, 'services/python-executor-modal/modal_app.py']) {
  assert.equal(canonical(readFileSync(resolve(root, path))).equals(git('show', base + ':' + path)), true, 'Packaged runtime dependency unchanged: ' + path);
}
assert.equal(Object.values(profile.gateDefaults).every((value) => value === 'false'), true);
const sql = readFileSync(resolve(root, 'supabase/migrations/20261016124752_issue201_learner_completion_status.sql'), 'utf8');
const bodies = [...sql.matchAll(/as \$\$([\s\S]*?)\$\$/g)].map((v) => v[1]);
assert.equal(bodies.length, 5);
for (const body of bodies) {
  assert.doesNotMatch(body, /\b(insert|update|delete|truncate|execute|perform|call)\b|for\s+(update|share)|pg_advisory|pg_notify/i, 'Status function must remain read-only');
  const calls = [...body.matchAll(/exam_delivery\.([a-z_]+)\s*\(/g)].map((v) => v[1]);
  assert.equal(calls.every((v) => ['learner_completion_status_dto', 'normalize_exam_key', 'get_learner_completion_status', 'list_learner_pending_completions'].includes(v)), true, 'Only audited pure status helpers');
}
assert.match(sql, /owner_id,deadline desc,attempt_id desc/);
assert.match(sql, /limit 65/); assert.match(sql, /limit 64/);
assert.match(sql, /p_page_size>20/); assert.match(sql, /cardinality\(p_watch_attempt_ids\)>20/);
assert.equal((sql.match(/set statement_timeout='3s'/g) ?? []).length, 4);
assert.equal((sql.match(/language (?:sql|plpgsql) stable/g) ?? []).length, 5);
const workflow = readFileSync(resolve(root, '.github/workflows/issue201-learner-status.yml'), 'utf8');
assert.doesNotMatch(workflow, /\bschedule:|\bcron:|\$\{\{\s*secrets\./);
assert.match(workflow, /contents: read/);
assert.match(workflow, /feat\/issue201-learner-expiry-status/);
console.log(JSON.stringify({ suite: 'learner-status-scope-static', migrations: SOURCE_MIGRATIONS.length, originalMigrationsUnchanged: 95,
  packagedRuntimeFilesUnchanged: profile.files.length, legacyDescriptorUnchanged: true,
  fixedReadFunctions: bodies.length, publicStatementTimeoutMs: 3000, pendingPageLimit: 20,
  discoveryWindow: 64, lookahead: 1, deploymentAuthority: false, passed: true }));
