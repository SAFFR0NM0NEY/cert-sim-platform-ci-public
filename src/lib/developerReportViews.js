export const DEVELOPER_REPORT_VIEWS = Object.freeze({
  active: 'active',
  resolved: 'resolved',
});

export const ACTIVE_DEVELOPER_REPORT_STATUSES = Object.freeze([
  'open',
  'in_review',
  'need_info',
]);

export function isReportInDeveloperView(report, view) {
  if (view === DEVELOPER_REPORT_VIEWS.resolved) {
    return report?.status === 'resolved';
  }

  return ACTIVE_DEVELOPER_REPORT_STATUSES.includes(report?.status);
}

export function filterDeveloperReports(reports = [], view, filters = {}) {
  return reports.filter(
    (report) =>
      isReportInDeveloperView(report, view) && matchesReportFilters(report, filters),
  );
}

function matchesReportFilters(report, filters) {
  if (filters.status && report.status !== filters.status) {
    return false;
  }

  if (filters.priority && report.priority !== filters.priority) {
    return false;
  }

  if (filters.source && report.source !== filters.source) {
    return false;
  }

  if (filters.reportType && report.reportType !== filters.reportType) {
    return false;
  }

  const search = String(filters.search ?? '').trim().toLowerCase();

  if (!search) {
    return true;
  }

  return [
    report.title,
    report.message,
    report.examKey,
    report.questionId,
    report.routePath,
    report.reporter?.displayName,
    report.reporter?.email,
  ]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(search));
}
