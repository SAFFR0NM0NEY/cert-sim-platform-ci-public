import { test, expect } from '@playwright/test';

const attemptId = '85000000-0000-4000-8000-000000000001';
const deadline = new Date(Date.now() + 120 * 60_000).toISOString();
const sources = [
  { id: 'source-a', text: 'Source A' },
  { id: 'source-b', text: 'Source B' },
  { id: 'source-c', text: 'Source C' },
];
const targets = [
  { id: 'target-1', text: 'Target 1' },
  { id: 'target-2', text: 'Target 2' },
  { id: 'target-3', text: 'Target 3' },
];
const options = [{ id: 'a', text: 'Option A' }, { id: 'b', text: 'Option B' }];

function fillerItem(index, section, questionNumber) {
  return {
    itemId: `item-${index}`, questionId: `fixture-${index}`, questionNumber,
    questionType: 'single-choice', domain: 'Synthetic domain', section,
    response: null, revision: 0,
    presentation: { type: 'single-choice', question: `Synthetic question ${index}.`, options },
  };
}

function caseItem(index, section) {
  return {
    itemId: `item-${index}`, questionId: `fixture-${index}`, questionNumber: null,
    questionType: 'case-study-context', domain: 'Synthetic domain', section,
    response: null, revision: 0,
    presentation: { type: 'case-study-context', title: `Case ${index}`, content: 'Synthetic case.', facts: [] },
  };
}

function matchingItem(allowTargetReuse = false) {
  return {
    itemId: 'item-15', questionId: 'fixture-matching', questionNumber: 13,
    questionType: 'matching-v1', domain: 'Synthetic domain', section: 'standard',
    response: null, revision: 0,
    presentation: { type: 'matching-v1', question: 'Match the synthetic values.', sources, targets, allowTargetReuse },
  };
}

function packageV2MatchingResponseValid(response, allowTargetReuse) {
  const answer = response?.answer;
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return false;
  const sourceIds = new Set(sources.map(({ id }) => id));
  const targetIds = new Set(targets.map(({ id }) => id));
  const entries = Object.entries(answer);
  if (entries.some(([sourceId, targetId]) => !sourceIds.has(sourceId) || !targetIds.has(targetId))) return false;
  return allowTargetReuse || new Set(entries.map(([, targetId]) => targetId)).size === entries.length;
}

const nextItem = {
  itemId: 'item-16', questionId: 'fixture-next', questionNumber: 14,
  questionType: 'true-false-single-v1', domain: 'Synthetic domain', section: 'standard',
  response: null, revision: 0,
  presentation: { type: 'true-false-single-v1', question: 'Synthetic next question.', statementId: 'statement-1' },
};

async function installFixture(page, { allowTargetReuse = false } = {}) {
  const saves = [];
  const items = [
    caseItem(1, 'case-1'),
    ...Array.from({ length: 6 }, (_, index) => fillerItem(index + 2, 'case-1', index + 1)),
    caseItem(8, 'case-2'),
    ...Array.from({ length: 6 }, (_, index) => fillerItem(index + 9, 'case-2', index + 7)),
    matchingItem(allowTargetReuse),
    nextItem,
    ...Array.from({ length: 64 }, (_, index) => fillerItem(index + 17, 'standard', index + 15)),
    { ...fillerItem(81, 'pbq', 79), questionType: 'pbq-siem', presentation: { type: 'pbq-siem', title: 'Synthetic lab', scenario: 'Synthetic.', instructions: ['Choose.'], tasks: { prompt: 'Choose.', answerOptions: options.map(({ id, text }) => ({ id, label: text })) }, safetyNote: 'Synthetic.' } },
    { ...fillerItem(82, 'pbq', 80), questionType: 'pbq-workspace', presentation: { type: 'pbq-workspace', title: 'Synthetic lab', scenario: 'Synthetic.', instructions: ['Choose.'], tasks: { prompt: 'Choose.', answerOptions: options.map(({ id, text }) => ({ id, label: text })) }, safetyNote: 'Synthetic.' } },
  ];
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/certsim-protected-exam')[1];
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates: [] });
    if (path.startsWith('/practice/availability')) return json({ examKey: 'az400', packageVersion: '1.0.0', profileKey: 'az400-sectioned-full-exam-profile', purpose: 'self_directed_exam', available: true, selectedCount: 80, adjustedCount: false, profileQuestionCount: 80, timeLimitMinutes: 120, fixedProfileSize: true, domainCounts: {}, missedCount: 0, newCount: 80, pbqCount: 2, languages: [] });
    if (path === '/practice/sessions') return json({ attempt: { attemptId, examKey: 'az400', packageVersion: '1.0.0', profileKey: 'az400-sectioned-full-exam-profile', profileName: 'Synthetic', status: 'in_progress', startedAt: new Date().toISOString(), expiresAt: deadline, timeLimitMinutes: 120, purpose: 'self_directed_exam', languagePreference: null }, items }, 201);
    if (path.endsWith('/flags')) return json({ itemIds: [] });
    if (path.includes('/response')) {
      const body = request.postDataJSON();
      if (!packageV2MatchingResponseValid(body.response, allowTargetReuse)) return json({ error: { code: 'invalid_response' } }, 400);
      saves.push(body);
      return json({ itemId: 'item-15', revision: 1, updatedAt: new Date().toISOString() });
    }
    return json({ error: { code: 'unexpected_fixture_route' } }, 500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html');
  await page.getByRole('button', { name: /Start/ }).click();
  await page.getByRole('button', { name: 'Go to question 13' }).click();
  return saves;
}

test('partial matching saves only completed pairs and navigates once', async ({ page }) => {
  const saves = await installFixture(page);
  await page.getByLabel('Match for Source A').selectOption('target-1');
  await expect(page.getByLabel('Match for Source B').locator('option[value="target-1"]')).toHaveAttribute('disabled', '');
  await expect(page.getByLabel('Match for Source C').locator('option[value="target-1"]')).toHaveAttribute('disabled', '');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Standard Questions: Question 14 of 66')).toBeVisible();
  expect(saves).toHaveLength(1);
  expect(saves[0].response).toEqual({ answer: { 'source-a': 'target-1' } });
  await expect(page.getByText(/protected exam request was not valid/i)).toHaveCount(0);
});

test('clearing removes the key and makes the target available again', async ({ page }) => {
  const saves = await installFixture(page);
  await page.getByLabel('Match for Source A').selectOption('target-1');
  await expect(page.getByLabel('Match for Source B').locator('option[value="target-1"]')).toHaveAttribute('disabled', '');
  await page.getByLabel('Match for Source A').selectOption('');
  await expect(page.getByLabel('Match for Source A')).toHaveValue('');
  await expect(page.getByLabel('Match for Source B').locator('option[value="target-1"]')).not.toHaveAttribute('disabled', '');
  await page.getByRole('button', { name: 'Next' }).click();
  expect(saves).toHaveLength(1);
  expect(saves[0].response).toEqual({ answer: {} });
});

test('allowTargetReuse keeps an already selected target available', async ({ page }) => {
  await installFixture(page, { allowTargetReuse: true });
  await page.getByLabel('Match for Source A').selectOption('target-1');
  await expect(page.getByLabel('Match for Source B').locator('option[value="target-1"]')).not.toHaveAttribute('disabled', '');
  await expect(page.getByLabel('Match for Source C').locator('option[value="target-1"]')).not.toHaveAttribute('disabled', '');
});

test('complete matching saves every unique pair and navigates once', async ({ page }) => {
  const saves = await installFixture(page);
  await page.getByLabel('Match for Source A').selectOption('target-1');
  await page.getByLabel('Match for Source B').selectOption('target-2');
  await page.getByLabel('Match for Source C').selectOption('target-3');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Standard Questions: Question 14 of 66')).toBeVisible();
  expect(saves).toHaveLength(1);
  expect(saves[0].response).toEqual({ answer: { 'source-a': 'target-1', 'source-b': 'target-2', 'source-c': 'target-3' } });
});
