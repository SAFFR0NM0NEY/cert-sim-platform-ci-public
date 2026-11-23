import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationPath = new URL('../supabase/migrations/20260909072811_issue124_protected_array_response_validator_fix.sql', import.meta.url);
const testPath = new URL('../supabase/tests/backend_exam_delivery_issue124.sql', import.meta.url);
const integrationPath = new URL('./test-generic-protected-lifecycle-integration.mjs', import.meta.url);
const workflowPath = new URL('../.github/workflows/backend-exam-delivery-db-validation.yml', import.meta.url);

const migration = (await readFile(migrationPath, 'utf8')).replace(/\r\n/g, '\n');
const tests = await readFile(testPath, 'utf8');
const integration = await readFile(integrationPath, 'utf8');
const workflow = await readFile(workflowPath, 'utf8');

assert.match(migration, /create or replace function exam_delivery\.package_v2_response_valid\(\s*p_question_type text, p_presentation jsonb, p_response jsonb\s*\)/i);
assert.match(migration, /language plpgsql[\s\S]+immutable[\s\S]+security invoker[\s\S]+set search_path = ''/i);
assert.match(migration, /jsonb_array_elements_text\(v_answer\) as selected\(selected_value\)/i);
assert.match(migration, /jsonb_array_elements\(coalesce\(p_presentation->'options','\[\]'::jsonb\)\) as allowed\(option_value\)/i);
assert.match(migration, /allowed\.option_value->>'id'=selected\.selected_value/i);
assert.match(migration, /jsonb_array_elements\(coalesce\(p_presentation->'items','\[\]'::jsonb\)\) as allowed\(item_value\)/i);
assert.match(migration, /allowed\.item_value->>'id'=selected\.selected_value/i);
assert.doesNotMatch(migration, /jsonb_array_elements_text\(v_answer\)\s+value\b/i);
assert.doesNotMatch(migration, /score_package_v2_response/);

for (const contract of [
  "pg_catalog.pg_column_size(p_response) > 65536",
  "key not in ('answer','selectedAnswer','selectedAnswers','selectedOrder','executedCommands','revision')",
  "jsonb_array_length(v_answer)<=50",
  "jsonb_array_length(v_answer)<=100",
  "true-false-single-v1",
  "true-false-composite-v1",
  "matching-v1",
  "code-dropdown-completion-v1",
  "drag-drop-match",
  "dropdown-code",
  "dropdown-command",
  "p_question_type like 'pbq-%'",
]) assert.ok(migration.includes(contract), `missing preserved validator contract: ${contract}`);

assert.match(migration, /revoke execute on function exam_delivery\.package_v2_response_valid\(text,jsonb,jsonb\) from public,anon,authenticated,service_role/i);
assert.match(tests, /multi-select accepts allowed identifiers/);
assert.match(tests, /reorder accepts an allowed sequence/);
assert.match(tests, /PBQ selected order remains valid/);
assert.match(tests, /response validator remains private from authenticated browsers/);
assert.match(integration, /ARRAY_RESPONSE_MULTI_SELECT_FIXTURE_MISSING/);
assert.match(integration, /ARRAY_RESPONSE_REORDER_FIXTURE_MISSING/);
assert.match(integration, /INVALID_NOT_CONTROLLED/);
assert.match(integration, /revision=1/);
assert.match(
  workflow,
  /backend_exam_delivery_issue85_successor_cutover\.sql \\\r?\n\s+backend_exam_delivery_issue124\.sql \\\r?\n\s+backend_exam_delivery_issue127\.sql \\\r?\n\s+backend_exam_delivery_issue147\.sql \\\r?\n\s+backend_exam_delivery_issue160\.sql \\\r?\n\s+backend_exam_delivery_issue167\.sql\r?\n\s+do/,
  'Issue #124 pgTAP must remain connected to the continued database suite list',
);

console.log('Issue #124 protected array response validator fix validated.');
