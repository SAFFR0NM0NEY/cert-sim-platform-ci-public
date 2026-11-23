import {replyLegacyCompletionContract} from './legacy-completion-contract.js';
export async function installIdentityAndProtectedRoutes(page, {
  availabilityStatus,
  id,
  role,
  selectedCount,
  packageVersion = '1.0.0',
  examKey = 'sc100',
  timeLimitMinutes = 100,
}) {
  const evidence = { attemptPosts: 0, availability: null };
  await page.addInitScript(({ id }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: 'fixture-access-token',
      refresh_token: 'fixture-refresh-token',
      token_type: 'bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: {
        id,
        email: 'identity@example.invalid',
        role: 'authenticated',
        aud: 'authenticated',
        user_metadata: {},
      },
    }));
  }, { id });

  await page.route('http://127.0.0.1:4178/api/**', async (route) => {
    if (await replyLegacyCompletionContract(route)) return;
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204 });
    if (url.pathname === '/api/auth/v1/user') {
      return json(route, 200, { id, email: 'identity@example.invalid', role: 'authenticated', aud: 'authenticated', user_metadata: {} });
    }
    if (url.pathname.startsWith('/api/rest/v1/profiles')) {
      return json(route, 200, [{ id, email: 'identity@example.invalid', display_name: 'Access Fixture', full_name: 'Access Fixture', user_type: role === 'student' ? 'student' : 'staff', default_role: role, status: 'active' }], { 'content-range': '0-0/1' });
    }
    if (url.pathname.startsWith('/api/rest/v1/memberships')) {
      return json(route, 200, [{ id: `${id.slice(0, -1)}3`, user_id: id, organisation_id: null, campus_id: null, group_id: null, role, status: 'active', created_at: '2026-09-17T00:00:00Z', updated_at: '2026-09-17T00:00:00Z', organisation: null, campus: null, group: null }], { 'content-range': '0-0/1' });
    }
    if (url.pathname.includes('/functions/v1/certsim-protected-exam/attempts/current-bindings')) {
      return json(route, 200, { candidates: [] });
    }
    if (url.pathname.includes('/functions/v1/certsim-protected-exam/practice/availability')) {
      evidence.availability = Object.fromEntries(url.searchParams);
      if (availabilityStatus === 403) {
        return json(route, 403, { error: { code: 'access_not_granted' } });
      }
      return json(route, 200, {
        ok: true,
        examKey,
        packageVersion,
        profileKey: evidence.availability.profileId,
        purpose: 'self_directed_exam',
        selectedCount,
        fixedProfileSize: true,
        timed: true,
        timeLimitMinutes,
        profileComposition: {
          questionCount: selectedCount,
          standardQuestionCount: selectedCount,
          executableCount: 0,
          caseStudyCount: 0,
          caseStudyQuestionCount: 0,
          pbqCount: 0,
        },
      });
    }
    if (request.method() === 'POST' && url.pathname.includes('/functions/v1/certsim-protected-exam/')) {
      evidence.attemptPosts += 1;
      return json(route, 500, { error: { code: 'unexpected_attempt_start' } });
    }
    return json(route, 200, [], { 'content-range': '*/0' });
  });
  return evidence;
}

function json(route, status, body, headers = {}) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers,
    body: JSON.stringify(body),
  });
}
