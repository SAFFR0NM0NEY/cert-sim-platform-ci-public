import { expect, test } from '@playwright/test';

const assignmentId = '15000000-0000-4000-8000-000000000001';
const learnerId = '25000000-0000-4000-8000-000000000001';
const attemptId = '35000000-0000-4000-8000-000000000001';

test('actual App forwards assignment provenance through availability and start', async ({ page }) => {
  const captured = { availability: null, start: null, posts: [] };
  page.on('request', (request) => {
    if (request.method() === 'POST') captured.posts.push({ url: request.url(), body: request.postData() });
  });
  await page.addInitScript(({ learnerId }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', token_type: 'bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: learnerId, email: 'student@example.invalid', role: 'authenticated', aud: 'authenticated', user_metadata: {} },
    }));
  }, { learnerId });
  await page.route('http://127.0.0.1:4178/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: {
        'access-control-allow-origin': 'http://127.0.0.1:4178',
        'access-control-allow-headers': 'authorization, apikey, content-type',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      } });
    }
    if (url.pathname === '/api/auth/v1/user') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: learnerId, email: 'student@example.invalid', role: 'authenticated', aud: 'authenticated', user_metadata: {} }) });
    }
    if (url.pathname.startsWith('/api/rest/v1/profiles')) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '0-0/1' }, body: JSON.stringify([{ id: learnerId, email: 'student@example.invalid', display_name: 'Network Student', full_name: 'Network Student', user_type: 'individual', default_role: 'student', status: 'active' }]) });
    }
    if (url.pathname.startsWith('/api/rest/v1/memberships')) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '*/0' }, body: '[]' });
    }
    if (url.pathname.includes('/functions/v1/certsim-protected-exam/attempts/current-bindings')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [] }) });
    }
    if (url.pathname.includes('/functions/v1/certsim-protected-exam/practice/availability')) {
      captured.availability = Object.fromEntries(url.searchParams);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, examKey: 'az204', packageVersion: '1.1.0', profileKey: 'full-profile', purpose: 'self_directed_exam',
        selectedCount: 60, fixedProfileSize: true, profileComposition: { questionCount: 60, standardQuestionCount: 60, caseStudyQuestionCount: 0, caseStudyCount: 0, pbqCount: 0 },
      }) });
    }
    if (url.pathname.includes('/functions/v1/certsim-protected-exam/practice/sessions') && request.method() === 'POST') {
      captured.start = JSON.parse(request.postData() || '{}');
      return route.fulfill({ status: 201, contentType: 'application/json', headers: { 'access-control-allow-origin': 'http://127.0.0.1:4178' }, body: JSON.stringify({
        attempt: { attemptId, assignmentId, examKey: 'az204', packageVersion: '1.1.0', profileKey: 'full-profile', purpose: 'self_directed_exam', languagePreference: 'csharp', status: 'in_progress', startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 7200000).toISOString() },
        items: [],
      }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '*/0' }, body: '[]' });
  });

  await page.goto(`/exams/az204?assignment=${assignmentId}`);
  await page.getByRole('button', { name: 'Start Full' }).click();
  await expect.poll(() => captured.availability?.assignmentId).toBe(assignmentId);
  await expect(page.getByText(/Coding language/i).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start exam' })).toBeVisible();
  await page.getByRole('button', { name: 'Start exam' }).click();
  await expect.poll(() => captured.start ?? captured.posts).toMatchObject({ assignmentId });
});

test('Account save refreshes the App identity used by the next attempt without duplicate mount loading', async ({ page }) => {
  let displayName = 'Name A';
  let profileReads = 0;
  await page.addInitScript(({ learnerId }) => {
    localStorage.setItem('sb-127-auth-token', JSON.stringify({
      access_token: 'fixture-access-token', refresh_token: 'fixture-refresh-token', token_type: 'bearer',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: learnerId, email: 'student@example.invalid', role: 'authenticated', aud: 'authenticated', user_metadata: {} },
    }));
  }, { learnerId });
  await page.route('http://127.0.0.1:4178/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/auth/v1/user') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: learnerId, email: 'student@example.invalid', role: 'authenticated', aud: 'authenticated', user_metadata: {} }) });
    }
    if (url.pathname.startsWith('/api/rest/v1/profiles')) {
      if (request.method() === 'PATCH') {
        displayName = request.postDataJSON().display_name;
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: learnerId, email: 'student@example.invalid', display_name: displayName, full_name: displayName, user_type: 'individual', default_role: 'student', status: 'active' }) });
      }
      profileReads += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '0-0/1' }, body: JSON.stringify([{ id: learnerId, email: 'student@example.invalid', display_name: displayName, full_name: displayName, user_type: 'individual', default_role: 'student', status: 'active' }]) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '*/0' }, body: '[]' });
  });

  await page.goto('/account');
  await page.getByText('Profile management', { exact: true }).click();
  await expect(page.getByLabel('Display name / username')).toHaveValue('Name A');
  expect(profileReads).toBe(1);
  await page.getByLabel('Display name / username').fill('Name B');
  await page.getByRole('button', { name: 'Save display name' }).click();
  await expect(page.getByText('Profile display name updated.')).toBeVisible();
  expect(profileReads).toBe(2);
  await page.evaluate(() => {
    history.pushState({}, '', '/exams/az204');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.getByRole('button', { name: 'Start Full' }).click();
  await expect(page.getByText('Learner:').locator('..')).toContainText('Name B');
});
