import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [frontend, database, edge, documentation] = await Promise.all([
  readFile('.github/workflows/frontend-feature-validation.yml', 'utf8'),
  readFile('.github/workflows/backend-exam-delivery-db-validation.yml', 'utf8'),
  readFile('.github/workflows/backend-exam-delivery-edge-validation.yml', 'utf8'),
  readFile('docs/github-actions-cost-optimization.md', 'utf8'),
]);

for (const [name, workflow] of Object.entries({ frontend, database, edge })) {
  assert.match(workflow, /workflow_dispatch:/, `${name} must retain a manual full-gate entry point.`);
  assert.match(workflow, new RegExp(`group: ${name}-validation-\\$\\{\\{ github\\.event\\.pull_request\\.number \\|\\| github\\.ref \\}\\}`));
  assert.match(workflow, /cancel-in-progress:\s*true/);
}

assert.match(frontend, /^\s*- package\.json$/m);
assert.match(frontend, /^\s*- package-lock\.json$/m);
assert.match(frontend, /^\s*- scripts\/validate-\*\.mjs$/m);

assert.match(database, /^\s*- package-lock\.json$/m);
assert.doesNotMatch(database, /^\s*- package\.json$/m);
assert.equal((database.match(/runs-on:\s*ubuntu-latest/g) ?? []).length, 1);
assert.equal((database.match(/Confirm pinned Supabase CLI once/g) ?? []).length, 1);
for (const setName of ['baseline', 'foundation', 'operations', 'publication', 'assignment']) {
  assert.match(database, new RegExp(`--set ${setName} --output`));
  assert.match(database, new RegExp(`certsim-${setName}`));
}
assert.match(database, /for project in baseline foundation operations publication assignment/);
assert.match(database, /db lint --local --level warning/);
assert.match(database, /db advisors --local --type security --level info --fail-on error/);
assert.match(database, /db advisors --local --type performance --level info --fail-on error/);

assert.doesNotMatch(edge, /^\s*- package(?:-lock)?\.json$/m);
assert.match(edge, /^\s*- scripts\/supabase-migration-validation\/\*\*$/m);
const unitSection = edge.slice(edge.indexOf('edge-unit-static:'), edge.indexOf('edge-disposable-integration:'));
const integrationSection = edge.slice(edge.indexOf('edge-disposable-integration:'));
assert.doesNotMatch(unitSection, /supabase@|supabase stop/);
assert.match(unitSection, /deno --version/);
assert.match(integrationSection, /supabase@2\.114\.0/);
assert.doesNotMatch(integrationSection, /supabase@2\.115\.0/);
assert.match(integrationSection, /supabase-cli-2\.114\.0/);
assert.match(integrationSection, /actions\/cache@v4/);
assert.match(integrationSection, /stop --no-backup/);

assert.match(documentation, /Frontend only/);
assert.match(documentation, /Manual full gate/);
assert.match(documentation, /Never execute untrusted public-fork pull-request code/);

console.log(JSON.stringify({
  ok: true,
  frontendJobs: 1,
  databaseJobs: 1,
  edgeJobs: 2,
  isolatedDatabaseProjects: 5,
  manualWorkflowFamilies: 3,
}));
