import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [app, page, dashboardHook, assignmentHook, progressHook, scopeHook, styles] = await Promise.all([
  read('src/App.jsx'),
  read('src/components/trainer/TrainerDashboardPage.jsx'),
  read('src/hooks/useTrainerDashboard.js'),
  read('src/hooks/useExamAssignments.js'),
  read('src/hooks/useAssignmentProgress.js'),
  read('src/hooks/useTrainerScope.js'),
  read('src/styles/global.css'),
]);

for (const section of ['analytics', 'assignments', 'students', 'results']) {
  assert.match(app, new RegExp(`trainer/dashboard/\\$\\{section\\}`));
  assert.match(page, new RegExp(`id: '${section}'`));
}
assert.match(app, /trainer\/dashboard\/results\//);
assert.match(app, /trainerResultId/);
assert.match(page, /aria-current=\{activeSection === section\.id \? 'page'/);
assert.match(page, /href=\{getTrainerSectionPath\(section\.id\)\}/);
assert.doesNotMatch(page, /role="tab"|role="tablist"|aria-selected/);
assert.doesNotMatch(page, /id: 'detail', label: 'Result Detail'/);
assert.match(page, /Learner Progress/);
assert.match(page, /activeSection = 'overview'/);
assert.match(page, /readTrainerFiltersFromUrl/);
assert.match(page, /window\.history\.replaceState/);
assert.match(page, /organisationId: params\.get\('organisation'\)/);
assert.match(page, /enabled: \['overview', 'analytics', 'assignments'\]\.includes\(activeSection\)/);
for (const hook of [dashboardHook, assignmentHook, progressHook, scopeHook]) {
  assert.match(hook, /enabled = true/);
  assert.match(hook, /reason: 'disabled'/);
}
assert.match(styles, /\.management-tabs a:focus-visible/);
assert.match(app, /heading\.focus\(\{ preventScroll: true \}\)/);
assert.doesNotMatch(page, /Trainer Dashboard|Trainer\/Admin Tools|Staff\/Admin tools/);

console.log(JSON.stringify({ ok: true, issue: 27, routeBackedSections: 5, fakeTabs: false, workflowLoadingGated: true }));
