import { expect, test } from '@playwright/test';

const assignmentId = '15000000-0000-4000-8000-000000000001';
const learnerId = '25000000-0000-4000-8000-000000000001';

test('SC-200 assignment exposes its assignment-aware start action through the standard route', async ({ page }) => {
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
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204 });
    if (url.pathname === '/api/auth/v1/user') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: learnerId, email: 'student@example.invalid', role: 'authenticated', aud: 'authenticated', user_metadata: {} }) });
    }
    if (url.pathname.startsWith('/api/rest/v1/profiles')) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '0-0/1' }, body: JSON.stringify([{ id: learnerId, email: 'student@example.invalid', display_name: 'Assigned Student', full_name: 'Assigned Student', user_type: 'individual', default_role: 'student', status: 'active' }]) });
    }
    if (url.pathname.startsWith('/api/rest/v1/memberships')) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '*/0' }, body: '[]' });
    }
    if (url.pathname.startsWith('/api/rest/v1/exam_assignments')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{
        id: assignmentId, organisation_id: '35000000-0000-4000-8000-000000000001', campus_id: null, group_id: null,
        student_user_id: learnerId, exam_catalog_id: null, exam_key: 'sc200', profile_id: 'sc200-full',
        title: 'SC-200 acceptance', instructions: '', assigned_by: '45000000-0000-4000-8000-000000000001',
        assignment_type: 'assessment', status: 'active', due_at: null, available_from: null,
        created_at: '2026-09-06T10:00:00Z', updated_at: '2026-09-06T10:00:00Z', contract_version: 'live-v2',
        maximum_attempts: 1, review_release_policy: 'after_submission', answer_release_policy: 'after_submission',
        examCatalog: null, organisation: { id: '35000000-0000-4000-8000-000000000001', name: 'Test', organisation_type: 'academy', status: 'active' },
        campus: null, group: null, student: { id: learnerId, email: 'student@example.invalid', full_name: 'Assigned Student', display_name: 'Assigned Student', status: 'active' },
        assignedBy: { id: '45000000-0000-4000-8000-000000000001', email: 'owner@example.invalid', full_name: 'Owner', display_name: 'Owner', status: 'active' },
      }]) });
    }
    if (url.pathname.includes('/functions/v1/certsim-protected-exam/history')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [], nextCursor: null }) });
    }
    if (url.pathname.includes('/functions/v1/certsim-protected-exam/attempts/current-bindings')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ candidates: [] }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'content-range': '*/0' }, body: '[]' });
  });

  await page.goto('/account/assignments');
  const start = page.getByRole('link', { name: 'Start assigned exam' });
  await expect(start).toBeVisible();
  await expect(start).toHaveAttribute('href', `/exams/sc200/full?assignment=${assignmentId}`);
  await start.click();
  await expect(page).toHaveURL(new RegExp(`/exams/sc200/full\\?assignment=${assignmentId}$`));
  await expect(page.getByRole('button', { name: 'Start exam' })).toBeVisible();

  await page.goto('/exams');
  await expect(page.getByRole('button', { name: /SC-200 Microsoft Security Operations Analyst/ })).toBeVisible();

  await page.goto('/exams/sc200/full');
  await expect(page).toHaveURL('/exams/sc200/full');
  await expect(page.getByRole('button', { name: 'Start exam' })).toBeVisible();
});
