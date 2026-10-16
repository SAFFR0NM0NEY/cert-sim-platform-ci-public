import { test, expect } from '@playwright/test';

import { getProtectedAttemptInventory } from '../../src/lib/protectedAttemptInventory.js';
import { toPresentationQuestion } from '../../src/lib/protectedExamContract.js';

const attemptId = '15300000-0000-4000-8000-000000000001';
const deadline = new Date(Date.now() + 120 * 60_000).toISOString();
const options = [{ id: 'a', text: 'Synthetic option A' }, { id: 'b', text: 'Synthetic option B' }];
const profileComposition = {
  questionCount: 50,
  standardQuestionCount: 43,
  caseStudyQuestionCount: 7,
  caseStudyCount: 1,
  pbqCount: 0,
};

function item(index, { context = false, caseStudyId = '', section = 'standalone' } = {}) {
  return {
    itemId: `synthetic-item-${index}`,
    questionId: `synthetic-source-${index}`,
    questionNumber: context ? null : index,
    questionType: context ? 'case-study-context' : 'single-choice',
    domain: 'Synthetic domain',
    section,
    response: null,
    revision: 0,
    presentation: context
      ? { title: 'Synthetic context', content: 'Synthetic safe context.', facts: [], caseStudyId, caseStudySize: 'long' }
      : { question: `Synthetic question ${index}`, options, ...(caseStudyId ? { caseStudyId, caseStudySize: 'long' } : {}) },
  };
}

function attemptItems({ standard = 43, caseQuestions = 7, contexts = 1 } = {}) {
  return [
    ...Array.from({ length: standard }, (_, index) => item(index + 1)),
    ...Array.from({ length: contexts }, (_, index) => item(100 + index, {
      context: true,
      caseStudyId: `synthetic-workload-${index + 1}`,
      section: `workload-context-${index + 1}`,
    })),
    ...Array.from({ length: caseQuestions }, (_, index) => item(200 + index, {
      caseStudyId: `synthetic-workload-${(index % Math.max(contexts, 1)) + 1}`,
      section: `workload-${(index % Math.max(contexts, 1)) + 1}`,
    })),
  ];
}

function legacyInventory(items) {
  const projected = items.map(toPresentationQuestion);
  const scored = projected.filter((entry) => entry.type !== 'case-study-info');
  const section = (entry) => entry.type === 'case-study-info' || /case/i.test(String(entry.section))
    ? 'case-study'
    : entry.type.startsWith('pbq-') ? 'pbq' : 'standard';
  return {
    totalScoredQuestions: scored.length,
    standardQuestionCount: scored.filter((entry) => section(entry) === 'standard').length,
    caseStudyQuestionCount: scored.filter((entry) => section(entry) === 'case-study').length,
    caseStudyCount: projected.filter((entry) => entry.type === 'case-study-info').length,
    pbqCount: scored.filter((entry) => section(entry) === 'pbq').length,
  };
}

async function mockAttempt(page, items) {
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/certsim-protected-exam')[1];
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates: [] });
    if (path.startsWith('/practice/availability')) return json({
      examKey: 'az204', packageVersion: '1.1.0', profileKey: 'standard-profile', purpose: 'self_directed_exam',
      available: true, selectedCount: 50, adjustedCount: false, profileQuestionCount: 50, timeLimitMinutes: 120,
      fixedProfileSize: true, profileComposition, domainCounts: {}, missedCount: 0, newCount: 50,
      pbqCount: 0, languages: ['csharp', 'python', 'mixed'],
    });
    if (path === '/practice/sessions') return json({
      attempt: {
        attemptId, examKey: 'az204', packageVersion: '1.1.0', profileKey: 'standard-profile', profileName: 'Standard',
        status: 'in_progress', startedAt: '2026-09-10T08:00:00.000Z', expiresAt: deadline,
        timeLimitMinutes: 120, purpose: 'self_directed_exam', languagePreference: 'csharp',
      },
      items,
    }, 201);
    if (path.endsWith('/flags')) return json({ itemIds: [] });
    return json({ error: { code: 'unexpected_fixture_route' } }, 500);
  });
}

test('valid existing AZ-204 Standard DTO reproduces the legacy mismatch and now renders', async ({ page }) => {
  const items = attemptItems();
  expect(legacyInventory(items)).toEqual({
    totalScoredQuestions: 50,
    standardQuestionCount: 50,
    caseStudyQuestionCount: 0,
    caseStudyCount: 1,
    pbqCount: 0,
  });
  expect(getProtectedAttemptInventory(items.map(toPresentationQuestion))).toEqual({
    totalScoredQuestions: 50,
    standardQuestionCount: 43,
    caseStudyQuestionCount: 7,
    caseStudyCount: 1,
    pbqCount: 0,
  });

  await mockAttempt(page, items);
  await page.goto('/tests/r3g/protected-runner-harness.html?exam=az204');
  await page.getByRole('button', { name: 'Start exam' }).click();
  await expect(page.getByLabel('AZ-204 exam workspace')).toBeVisible();
  await expect(page.getByText('Standard Questions: Question 1 of 43')).toBeVisible();
  await expect(page.getByText('Protected attempt inventory does not match the selected profile.')).toHaveCount(0);
});

test('malformed AZ-204 Standard DTO remains fail closed', async ({ page }) => {
  await mockAttempt(page, attemptItems({ standard: 44, caseQuestions: 6, contexts: 1 }));
  await page.goto('/tests/r3g/protected-runner-harness.html?exam=az204');
  await page.getByRole('button', { name: 'Start exam' }).click();
  await expect(page.getByText('Protected attempt inventory does not match the selected profile.')).toBeVisible();
  await expect(page.getByLabel('AZ-204 exam workspace')).toHaveCount(0);
});
