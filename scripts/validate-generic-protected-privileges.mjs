import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const migrationName = '20260828221028_lock_down_generic_lifecycle_helpers.sql';
const migration = await readFile(`supabase/migrations/${migrationName}`, 'utf8');
const canonical = migration.replaceAll('\r\n', '\n');
const hash = createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex');

const signatures = [
  'check_eligibility_v2\\(uuid, text, text\\)',
  'start_attempt_v2\\(uuid, text, text, uuid\\)',
  'submit_attempt_v2\\(uuid, uuid, uuid\\)',
  'package_v2_response_valid\\(text, jsonb, jsonb\\)',
];

for (const signature of signatures) {
  assert.match(
    migration,
    new RegExp(`revoke execute on function exam_delivery\\.${signature}\\s+from public, anon, authenticated, service_role`, 'i'),
  );
}

assert.match(
  migration,
  /alter default privileges for role postgres in schema exam_delivery\s+revoke execute on functions from public/i,
);
assert.doesNotMatch(migration, /grant\s+execute/i);
assert.doesNotMatch(migration, /\b(?:insert|update|delete|truncate|drop|alter\s+table|create\s+policy)\b/i);
assert.doesNotMatch(migration, /\b(?:anon|authenticated|service_role)\b[\s\S]*\bgrant\b|\bgrant\b[\s\S]*\b(?:anon|authenticated|service_role)\b/i);

console.log(`PASS generic protected privilege remediation (${migrationName})`);
console.log(`  Canonical SHA-256: ${hash}`);
console.log('  Four v2 helpers are owner-internal; future postgres functions in exam_delivery require explicit grants.');
