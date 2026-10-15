const SCOPE_QUERY_KEYS = Object.freeze({
  organisationId: 'organisation',
  campusId: 'campus',
  groupId: 'group',
  assignmentId: 'assignment',
  examKey: 'exam',
  progressStatus: 'progress',
  readinessStatus: 'readiness',
  resultStatus: 'status',
  search: 'q',
  returnSection: 'return',
});

const RETURN_SECTIONS = new Set(['overview', 'analytics', 'assignments', 'students', 'results']);

export function readTrainerStudentScope(search = '') {
  const params = new URLSearchParams(search);
  const scope = Object.fromEntries(Object.entries(SCOPE_QUERY_KEYS).map(([key, queryKey]) =>
    [key, params.get(queryKey) ?? '']));
  if (!RETURN_SECTIONS.has(scope.returnSection)) scope.returnSection = 'students';
  return scope;
}

export function buildTrainerStudentPath(membershipId, scope = {}) {
  if (!membershipId) return '/trainer/dashboard';
  return `/trainer/students/${encodeURIComponent(membershipId)}${buildScopeQuery(scope)}`;
}

export function buildTrainerDashboardPath(scope = {}) {
  const section = RETURN_SECTIONS.has(scope.returnSection) ? scope.returnSection : 'students';
  const path = section === 'overview' ? '/trainer/dashboard' : `/trainer/dashboard/${section}`;
  return `${path}${buildScopeQuery({ ...scope, returnSection: '' })}`;
}

function buildScopeQuery(scope) {
  const params = new URLSearchParams();
  Object.entries(SCOPE_QUERY_KEYS).forEach(([key, queryKey]) => {
    if (scope[key]) params.set(queryKey, scope[key]);
  });
  const query = params.toString();
  return query ? `?${query}` : '';
}
