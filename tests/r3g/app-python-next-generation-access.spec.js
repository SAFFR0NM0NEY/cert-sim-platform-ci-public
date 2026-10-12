import { expect, test } from '@playwright/test';

const ownerId = '86000000-0000-4000-8000-000000000001';
const learnerId = '86000000-0000-4000-8000-000000000002';

test('Platform Owner can reach an available Python Next Generation profile without an assignment', async ({ page }) => {
  const evidence = await installIdentityAndProtectedRoutes(page, {
    id: ownerId,
    role: 'platform_owner',
    availabilityStatus: 200,
    selectedCount: 31,
  });

  await page.goto('/exams');
  await page.getByRole('button', { name: /Python Python Next Generation Certiport/i }).click();
  await expect(page).toHaveURL('/exams/python-next-generation');
  await page.getByRole('button', { name: 'Start Lab' }).click();

  await expect(page).toHaveURL('/exams/python-next-generation/lab');
  await expect(page.getByRole('heading', { name: 'Exam details' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start exam' })).toBeEnabled();
  await expect.poll(() => evidence.availability?.profileId).toBe('pythonnextgeneration-lab');
  expect(evidence.availability?.assignmentId).toBeUndefined();
  expect(evidence.attemptPosts).toBe(0);
});

test('unassigned student sees Python Next Generation but the server denies attempt availability', async ({ page }) => {
  const evidence = await installIdentityAndProtectedRoutes(page, {
    id: learnerId,
    role: 'student',
    availabilityStatus: 403,
    selectedCount: 35,
  });

  await page.goto('/exams');
  await page.getByRole('button', { name: /Python Python Next Generation Certiport/i }).click();
  await expect(page).toHaveURL('/exams/python-next-generation');
  await page.getByRole('button', { name: 'Start No-Lab' }).click();

  await expect(page).toHaveURL('/exams/python-next-generation/no-lab');
  await expect(page.getByText('This protected exam requires an active assignment or entitlement.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start exam' })).toHaveCount(0);
  await expect.poll(() => evidence.availability?.profileId).toBe('pythonnextgeneration-no-lab');
  expect(evidence.availability?.assignmentId).toBeUndefined();
  expect(evidence.attemptPosts).toBe(0);
});

async function installIdentityAndProtectedRoutes(page, {
  availabilityStatus,
  id,
  role,
  selectedCount,
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
        examKey: 'pythonnextgeneration',
        packageVersion: '1.0.0',
        profileKey: evidence.availability.profileId,
        purpose: 'self_directed_exam',
        selectedCount,
        fixedProfileSize: true,
        timed: true,
        timeLimitMinutes: 50,
        profileComposition: {
          questionCount: selectedCount,
          standardQuestionCount: selectedCount === 31 ? 24 : 35,
          executableCount: selectedCount === 31 ? 7 : 0,
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
