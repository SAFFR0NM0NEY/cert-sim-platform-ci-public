import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  DEVELOPER_REPORT_VIEWS,
  filterDeveloperReports,
} from '../src/lib/developerReportViews.js';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const [account, developer, home, organisation, trainer, styles] = await Promise.all([
  read('src/components/account/AccountPage.jsx'),
  read('src/components/developer/DeveloperDashboardPage.jsx'),
  read('src/components/exam/Home.jsx'),
  read('src/components/admin/OrganisationManagementPage.jsx'),
  read('src/components/trainer/TrainerDashboardPage.jsx'),
  read('src/styles/global.css'),
]);

assert.match(styles, /\.management-tabs :is\(a, button\)/);
assert.match(styles, /flex-wrap: wrap/);
assert.match(organisation, /aria-current=\{activeSection === section\.id \? 'page'/);

for (const source of [account, trainer]) {
  assert.match(source, /Training Dashboard/);
  assert.doesNotMatch(source, /Performance Dashboard/);
}
assert.match(trainer, /Training Dashboard \| CertSim Platform/);

assert.match(developer, /Active reports/);
assert.match(developer, /Resolved reports \(\{totals\.resolved\}\)/);
assert.match(developer, /There is no current report work/);
assert.match(developer, /setFilters\(\(current\) => \(\{ \.\.\.current, status: '' \}\)\)/);

const reports = [
  { id: 'open', status: 'open', priority: 'normal', source: 'question_reports', reportType: 'question_issue', title: 'Open' },
  { id: 'review', status: 'in_review', priority: 'normal', source: 'platform_issue_reports', reportType: 'platform_bug', title: 'Review' },
  { id: 'need-info', status: 'need_info', priority: 'high', source: 'platform_issue_reports', reportType: 'access_issue', title: 'Need info' },
  { id: 'resolved', status: 'resolved', priority: 'normal', source: 'question_reports', reportType: 'question_issue', title: 'Resolved' },
  { id: 'dismissed', status: 'dismissed', priority: 'low', source: 'platform_issue_reports', reportType: 'other', title: 'Dismissed' },
];
const emptyFilters = { priority: '', source: '', search: '', status: '', reportType: '' };
assert.deepEqual(
  filterDeveloperReports(reports, DEVELOPER_REPORT_VIEWS.active, emptyFilters).map(({ id }) => id),
  ['open', 'review', 'need-info'],
);
assert.deepEqual(
  filterDeveloperReports(reports, DEVELOPER_REPORT_VIEWS.resolved, emptyFilters).map(({ id }) => id),
  ['resolved'],
);
assert.deepEqual(
  filterDeveloperReports(reports, DEVELOPER_REPORT_VIEWS.active, { ...emptyFilters, priority: 'high' }).map(({ id }) => id),
  ['need-info'],
);

assert.match(home, /Guide and Saved Results/);
assert.match(home, /View Saved Results/);
assert.match(home, /Guide coming soon/);
assert.match(home, /Open Student Guide/);
assert.match(home, /disabled=\{!exam\}/);
assert.doesNotMatch(home, /guideActionLabel|handleGuideAction/);

console.log(JSON.stringify({
  ok: true,
  issues: [76, 80],
  activeReportStatuses: 3,
  resolvedViewIsExplicit: true,
  managementTabsSupportButtons: true,
  guideMisrouteRemoved: true,
}));
