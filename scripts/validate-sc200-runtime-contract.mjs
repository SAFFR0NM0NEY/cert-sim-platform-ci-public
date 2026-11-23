import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const name = '20260906104745_register_sc200_runtime_contract.sql';
const sql = await readFile(`supabase/migrations/${name}`, 'utf8');
const normalized = sql.replaceAll('\r\n', '\n');
const hash = createHash('sha256').update(Buffer.from(normalized, 'utf8')).digest('hex');

for (const fragment of [
  'certsim-ai901-weighted-generator-v2', 'certsim-ai901-exact-scorer-v2',
  'certsim-az204-grouped-generator-v1', 'certsim-az204-exact-scorer-v1',
  'certsim-security-plus-pbq-first-generator-v1', 'certsim-security-plus-authoritative-pbq-scorer-v1',
  'certsim-az400-case-workspace-generator-v1', 'certsim-az400-authoritative-scorer-v1',
  'certsim-sc200-canonical-forms-v1', 'certsim-selected-response-partial-v1',
  "security invoker", "parallel unsafe", "set search_path = ''", 'owner to postgres',
  'from public, anon, authenticated, service_role', 'to postgres',
  'sc200_runtime_precondition_drift', 'sc200_runtime_postcondition_failed',
]) assert.match(sql, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

assert.doesNotMatch(sql, /insert\s+into|update\s+|delete\s+from|create\s+(?:table|policy)|grant\s+execute[^;]+to\s+(?:public|anon|authenticated|service_role)/i);
assert.equal((sql.match(/\('certsim-sc200-canonical-forms-v1','certsim-selected-response-partial-v1'\)/g) ?? []).length, 1);
console.log(JSON.stringify({ ok: true, issue: 83, migration: name, sha256: hash, registeredTuples: 1, browserGrants: 0 }));
