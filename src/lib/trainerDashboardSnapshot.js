const SECTION_NAMES = ['groups', 'students', 'history', 'analytics'];

export function composeTrainerDashboardSnapshot({
  identity,
  groupsResult,
  studentsResult,
  historyResult,
  analyticsResult,
}) {
  const sectionErrors = Object.fromEntries(
    SECTION_NAMES.map((name) => {
      const result = { groups: groupsResult, students: studentsResult, history: historyResult, analytics: analyticsResult }[name];
      return [name, result?.ok ? '' : result?.message || `Could not load ${name}.`];
    }),
  );
  const groups = groupsResult?.ok ? groupsResult.data ?? [] : [];
  const students = studentsResult?.ok ? studentsResult.data ?? [] : [];
  const results = historyResult?.ok ? historyResult.data ?? [] : [];
  return {
    identity,
    groups,
    students,
    results,
    resultsPagination: historyResult?.ok
      ? historyResult.pagination ?? { hasMore: false, nextCursor: null, pageSize: 25 }
      : { hasMore: false, nextCursor: null, pageSize: 25 },
    authoritativeAnalytics: analyticsResult?.ok ? analyticsResult.data : null,
    sectionErrors,
    totals: { groups: groups.length, students: students.length, results: results.length },
  };
}

export function dashboardSummaryValue({ loading, error, value }) {
  if (loading) return 'Loading…';
  if (error) return 'Unavailable';
  return value;
}
