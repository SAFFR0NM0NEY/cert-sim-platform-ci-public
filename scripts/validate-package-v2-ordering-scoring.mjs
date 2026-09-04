import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationName = '20260831090240_repair_package_v2_ordering_scoring.sql';
const migration = await readFile(`supabase/migrations/${migrationName}`, 'utf8');

assert.match(migration, /create or replace function exam_delivery\.score_package_v2_response\(/i);
assert.match(migration, /with ordinality e\(value,n\)[\s\S]*?->>\(\(e\.n-1\)::integer\)=e\.value/i);
assert.match(migration, /immutable[\s\S]*?security invoker[\s\S]*?set search_path = ''/i);
assert.match(migration, /revoke execute[\s\S]*?from public,anon,authenticated,service_role/i);
assert.doesNotMatch(migration, /grant execute/i);
assert.doesNotMatch(migration, /dynamic|execute\s+format|\beval\b|question_id/i);

console.log(`PASS package-v2 ordering scorer repair validation (${migrationName})`);
