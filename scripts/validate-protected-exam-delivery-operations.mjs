import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationName = '20260827071056_protected_exam_delivery_operations.sql';
const migrationPath = path.join(root, 'supabase', 'migrations', migrationName);
const sql = await readFile(migrationPath, 'utf8');
const migrations = (await readdir(path.join(root, 'supabase', 'migrations'))).filter((name) => name.endsWith('.sql')).sort();
const operations = ['check_eligibility','start_attempt','resume_attempt','save_response','submit_attempt','get_result','get_review'];

assert.equal(migrations[13], migrationName);
assert.match(migrationName, /^\d{14}_protected_exam_delivery_operations\.sql$/);
assert.ok(Number(migrationName.slice(0, 14)) > 20260101000013);
assert.doesNotMatch(sql, /publish_package|release_review|create\s+policy|raw_user_meta_data|auth\.role\s*\(/i);
assert.doesNotMatch(sql, /execute\s+format|\bformat\s*\(|\bdynamic\s+sql\b/i);
assert.doesNotMatch(sql, /execute\s*\(\s*p_(?:action|payload)|generic.*(?:action|payload)/i);
assert.doesNotMatch(sql, /grant\s+(?:select|insert|update|delete|all)[^;]*exam_delivery[^;]*service_role/i);
assert.doesNotMatch(sql, /grant\s+execute[^;]*to\s+(?:public|anon|authenticated)/i);

for (const name of operations) {
  assert.match(sql, new RegExp(`create\\s+function\\s+exam_delivery\\.${name}\\s*\\(`, 'i'));
  assert.match(sql, new RegExp(`create\\s+function\\s+public\\.certsim_protected_${name}\\s*\\(`, 'i'));
  assert.match(sql, new RegExp(`revoke\\s+execute\\s+on\\s+function\\s+public\\.certsim_protected_${name}[\\s\\S]*?from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role`, 'i'));
  assert.match(sql, new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.certsim_protected_${name}[\\s\\S]*?to\\s+service_role`, 'i'));
}

const publicBlocks = [...sql.matchAll(/create\s+function\s+public\.certsim_protected_[\s\S]*?\$\$\s*;/gi)].map((match) => match[0]);
assert.equal(publicBlocks.length, operations.length);
for (const block of publicBlocks) {
  assert.match(block, /security\s+invoker/i);
  assert.match(block, /set\s+search_path\s*=\s*''/i);
  assert.doesNotMatch(block, /security\s+definer/i);
  assert.match(block, /returns\s+jsonb/i);
}

const privateDefiners = [...sql.matchAll(/create\s+function\s+exam_delivery\.(?:check_eligibility|start_attempt|resume_attempt|save_response|submit_attempt|get_result|get_review)[\s\S]*?\$\$\s*;/gi)].map((match) => match[0]);
assert.equal(privateDefiners.length, operations.length);
for (const block of privateDefiners) {
  assert.match(block, /security\s+definer/i);
  assert.match(block, /set\s+search_path\s*=\s*''/i);
  assert.match(block, /returns\s+jsonb/i);
}

assert.match(sql, /revoke\s+all\s+on\s+all\s+tables\s+in\s+schema\s+exam_delivery\s+from\s+service_role/i);
assert.match(sql, /attempts_one_active_profile_idx/i);
assert.match(sql, /attempt_responses_request_unique/i);
assert.match(sql, /statement_timeout/i);
assert.match(sql, /for\s+update/i);
assert.match(sql, /pg_advisory_xact_lock/i);

const projection = sql.slice(sql.indexOf('insert into public.exam_attempts'), sql.indexOf('return exam_delivery.get_result'));
for (const forbidden of ['correctAnswer','explanation','remediation','scoring_snapshot','review_snapshot','package_hash','authoring_metadata']) {
  assert.doesNotMatch(projection, new RegExp(forbidden, 'i'));
}

const changed = (await readFile(path.join(root, 'package.json'), 'utf8'));
assert.match(changed, /validate:db-operations/);

console.log(`PASS Protected exam-delivery operations static validation (${migrationName})`);
console.log('  Seven server-only wrappers; no publication, review-release, browser grant, direct private-table grant, or protected projection field.');
