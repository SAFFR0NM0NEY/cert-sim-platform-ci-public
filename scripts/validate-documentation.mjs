import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderExamPortfolio } from './generate-exam-portfolio.mjs';

const paths = [
  '.gitattributes',
  'README.md',
  'AGENTS.md',
  'docs/README.md',
  'docs/DEVELOPMENT_OPERATING_MODEL.md',
  'docs/CERTSIM_ARCHITECTURE_STANDARD.md',
  'docs/CI_OPERATING_MODEL.md',
  'docs/PRODUCTION_RUNBOOK.md',
  'docs/EXAM_PORTFOLIO.md',
  '.github/pull_request_template.md',
  '.github/workflows/frontend-feature-validation.yml',
  'package.json',
];
const contents = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await readFile(path, 'utf8')])));
const read = (path) => contents[path];

assert.match(read('.gitattributes'), /^docs\/EXAM_PORTFOLIO\.md text eol=lf$/m);
assert.match(read('README.md'), /\[documentation index\]\(docs\/README\.md\)/i);
for (const link of ['CERTSIM_ARCHITECTURE_STANDARD.md', 'DEVELOPMENT_OPERATING_MODEL.md', 'CI_OPERATING_MODEL.md', 'PRODUCTION_RUNBOOK.md', 'EXAM_PORTFOLIO.md', '../AGENTS.md']) {
  assert.ok(read('docs/README.md').includes(`](${link})`), `Documentation index must link ${link}.`);
}
for (const status of ['AUTHORITATIVE', 'GENERATED', 'REFERENCE/HISTORICAL']) {
  assert.ok(read('docs/README.md').includes(status), `Documentation index must define ${status}.`);
}

for (const stale of [/optional accounts/i, /browser-local attempt history/i, /local AZ-204 question bank/i, /localStorage/i, /automatic scoring/i, /migrations\/0001_certsim/i, /frontend-only mode/i]) {
  assert.doesNotMatch(read('README.md'), stale, `README contains stale architecture phrase: ${stale}`);
}

const architecture = read('docs/CERTSIM_ARCHITECTURE_STANDARD.md');
for (const contract of ['certsim-protected-exam', 'server-authoritative', 'Cloudflare Pages', 'Study Sandbox', 'private reviewed `main`']) {
  assert.ok(architecture.includes(contract), `Architecture standard is missing ${contract}.`);
}

const runbook = read('docs/PRODUCTION_RUNBOOK.md');
for (const contract of ['scripts/deploy-protected-production.mjs', 'certsimplatform.com', 'DEPLOY_PROTECTED_PRODUCTION', 'current-SHA maintenance', 'verify_jwt=true']) {
  assert.ok(runbook.includes(contract), `Production runbook is missing ${contract}.`);
}

const ci = read('docs/CI_OPERATING_MODEL.md');
for (const contract of ['SAFFR0NM0NEY/cert-sim-platform-ci-public', 'CI_SOURCE_SHA.txt', 'candidate/**', 'one-workflow-file delta', 'zero executed steps']) {
  assert.ok(ci.includes(contract), `CI operating model is missing ${contract}.`);
}

const agents = read('AGENTS.md');
assert.match(agents, /Documentation impact: none — <reason>/);
assert.match(agents, /Material changes to architecture/);
assert.match(agents, /Never force-push/);

const prTemplate = read('.github/pull_request_template.md');
assert.match(prTemplate, /Documentation impact: updated/);
assert.match(prTemplate, /Documentation impact: none — <reason>/);

const workflow = read('.github/workflows/frontend-feature-validation.yml');
assert.match(workflow, /^\s*- docs\/\*\*$/m);
assert.match(workflow, /^\s*run: npm run validate:docs$/m);

const packageJson = JSON.parse(read('package.json'));
assert.equal(packageJson.scripts['validate:docs'], 'node scripts/validate-documentation.mjs');
assert.equal(read('docs/EXAM_PORTFOLIO.md'), renderExamPortfolio(), 'Generated exam portfolio is stale.');

console.log(JSON.stringify({ ok: true, requiredDocuments: 8, staleReadmePatterns: 7, portfolioCurrent: true, portfolioEol: 'lf' }));
