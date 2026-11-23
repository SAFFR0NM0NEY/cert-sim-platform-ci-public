import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migration = await readFile(new URL('../supabase/migrations/20260906115046_selected_response_partial_scorer.sql', import.meta.url), 'utf8');

for (const token of [
  'score_selected_response_partial',
  'score_package_v2_response_for_scorer',
  'validate_selected_response_for_item',
  "p_scorer_version='certsim-selected-response-partial-v1'",
  "p_scoring->>'model'<>'per-correct-option-no-negative-v1'",
  'maximumRawPoints',
  'selectionCap',
  'requiredSelections',
  'response_invalid',
  'greatest(0,least(v_required,v_earned))',
]) assert.ok(migration.includes(token), `missing ${token}`);

assert.doesNotMatch(migration, /sc200|sc-200/i);
assert.doesNotMatch(migration, /grant execute[\s\S]{0,250}score_(?:selected_response_partial|package_v2_response_for_scorer)[\s\S]{0,100}to (?:public|anon|authenticated|service_role)/i);
assert.match(migration, /create or replace function exam_delivery\.submit_attempt_v2_with_assessment_gate/);
assert.equal((migration.match(/score_package_v2_response_for_scorer\(v_attempt\.scorer_version/g) ?? []).length, 3);
assert.match(migration, /perform exam_delivery\.validate_selected_response_for_item\(p_attempt_id,p_item_id,p_response\)/);
assert.match(migration, /select a\.purpose,a\.status,a\.scorer_version/);

console.log(JSON.stringify({ ok: true, issue: 83, scorer: 'certsim-selected-response-partial-v1' }));
