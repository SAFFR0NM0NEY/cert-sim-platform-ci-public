import { test, expect } from '@playwright/test';
import crypto from 'node:crypto';

const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deadline = new Date(Date.now() + 120 * 60_000).toISOString();
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const option = [{ id: 'a', text: 'Option A' }, { id: 'b', text: 'Option B' }];
const makeItem = (index, type, section, questionNumber) => ({ itemId: `item-${index}`, questionId: `source-${index}`, questionNumber, questionType: type, domain: 'Sanitized domain', section, response: null, revision: 0, presentation: type === 'case-study-context' ? { title: `Case ${index}`, content: 'Sanitized case.', facts: [] } : type.startsWith('pbq-') ? { type, title: `Lab ${index}`, scenario: 'Sanitized.', instructions: ['Choose.'], tasks: { prompt: 'Choose.', answerOptions: option.map(({ id, text }) => ({ id, label: text })) }, safetyNote: 'Fixture.' } : { question: `Sanitized question ${index}`, options: option } });
const multiHostItem = {
  itemId: 'item-81', questionId: 'source-81', questionNumber: 79,
  questionType: 'pbq-multi-host-terminal', domain: 'Sanitized domain', section: 'pbq',
  response: null, revision: 0,
  presentation: {
    type: 'pbq-multi-host-terminal', title: 'Multi-host fixture', scenario: 'Sanitized.',
    instructions: ['Inspect the host and choose.'], safetyNote: 'Fixture.',
    assets: { hosts: [{ id: 'host-a', label: 'Host A', description: 'Synthetic host.', prompt: 'host-a$', allowedCommands: ['inspect'], commandOutputs: { inspect: 'Synthetic command output.' } }] },
    tasks: {
      prompt: 'Inspect and decide.',
      commandEvidenceTargets: [{ id: 'evidence-target-a', hostId: 'host-a', label: 'Host evidence', commands: ['inspect'] }],
      decisionTargets: [{ id: 'decision-target-a', label: 'Final decision', requirement: 'Choose a synthetic option.', options: [{ id: 'option-a', label: 'Option A' }] }],
    },
    responseAllowlist: {
      targetIds: ['evidence-target-a', 'decision-target-a'],
      answerIdsByTarget: [
        { targetId: 'evidence-target-a', answerIds: ['inspected'] },
        { targetId: 'decision-target-a', answerIds: ['option-a'] },
      ],
      commandIds: [],
    },
  },
};
const makeInteractiveTopologyItem = ({
  index,
  type,
  evidenceId,
  decisionId,
  selectedValue,
}) => ({
  itemId: `item-${index}`,
  questionId: `source-${index}`,
  questionNumber: index - 2,
  questionType: type,
  domain: 'Sanitized domain',
  section: 'pbq',
  response: null,
  revision: 0,
  presentation: {
    type,
    title: `${type} interactive-topology fixture`,
    scenario: 'Sanitized interactive topology.',
    instructions: ['Inspect the synthetic device and choose scorer responses.'],
    safetyNote: 'Fixture.',
    assets: {
      devices: [{
        id: `${type}-host`,
        label: `${type} host`,
        description: 'Synthetic host.',
        allowedCommands: ['inspect'],
        tools: [{ id: 'inspect', label: `Inspect ${type} host`, command: 'inspect' }],
        commandOutputs: { inspect: `${type} browser-only terminal output.` },
      }],
    },
    tasks: {
      interactionStyle: 'interactive-topology',
      prompt: `Resolve the ${type} fixture.`,
      evidenceItems: [{ id: evidenceId, label: `${type} evidence`, detail: 'Synthetic evidence.' }],
      selectionOptions: [{ id: 'selected', label: 'Selected' }],
      decisionTargets: [{
        id: decisionId,
        label: `${type} decision`,
        requirement: 'Choose a synthetic option.',
        options: [{ id: selectedValue, label: 'Synthetic option' }],
      }],
    },
    responseAllowlist: {
      targetIds: [evidenceId, decisionId],
      answerIdsByTarget: [
        { targetId: evidenceId, answerIds: ['selected'] },
        { targetId: decisionId, answerIds: [selectedValue] },
      ],
      commandIds: [],
    },
  },
});
const topologyConfigItem = makeInteractiveTopologyItem({
  index: 81,
  type: 'pbq-config-panel',
  evidenceId: 'config-evidence',
  decisionId: 'config-decision',
  selectedValue: 'config-value',
});
const topologyFirewallItem = makeInteractiveTopologyItem({
  index: 82,
  type: 'pbq-firewall',
  evidenceId: 'firewall-evidence',
  decisionId: 'firewall-decision',
  selectedValue: 'firewall-value',
});
const items = [makeItem(1,'case-study-context','case-1',null), ...Array.from({length:6},(_,i)=>makeItem(i+2,'single-choice','case-1',i+1)), makeItem(8,'case-study-context','case-2',null), ...Array.from({length:6},(_,i)=>makeItem(i+9,'single-choice','case-2',i+7)), ...Array.from({length:66},(_,i)=>makeItem(i+15,'single-choice','standard',i+13)), multiHostItem, makeItem(82,'pbq-workspace','pbq',80)];

test('interactive-topology config-panel and firewall save allowlisted state and resume', async ({ page }) => {
  const topologyItems = [...items.slice(0, -2), topologyConfigItem, topologyFirewallItem];
  const saves = [];
  const savedResponses = new Map();
  let active = false;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/certsim-protected-exam')[1];
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    const attempt = { attemptId, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', status:'in_progress', startedAt:'2026-09-10T08:00:00.000Z', expiresAt:null, timed:false, itemCount:80, purpose:'study_sandbox', languagePreference:null };
    const resumedItems = topologyItems.map((item) => savedResponses.has(item.itemId)
      ? { ...item, response: savedResponses.get(item.itemId), revision: 1 }
      : item);
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates: active ? [{ ...attempt, selectedCount:80, fixedProfileSize:false, replacementPermitted:false }] : [] });
    if (path.startsWith('/practice/recoverable-sandboxes')) return json({ candidates: [] });
    if (path.startsWith('/practice/availability')) return json({ examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', purpose:'study_sandbox', selectedCount:80, timed:false, timeLimitMinutes:null, fixedProfileSize:false, adjustedCount:false });
    if (path === '/practice/sessions') { active = true; return json({ attempt, items: resumedItems, page: { returnedThrough:82, totalCount:82, hasMore:false } }, 201); }
    if (path === `/attempts/${attemptId}`) return json({ attempt, items: resumedItems, page: { returnedThrough:82, totalCount:82, hasMore:false } });
    if (path.endsWith('/flags')) return json({ itemIds: [] });
    const savedItem = [topologyConfigItem, topologyFirewallItem].find((item) => path.includes(`/${item.itemId}/response`));
    if (savedItem) {
      const body = request.postDataJSON();
      saves.push({ itemId: savedItem.itemId, response: body.response });
      savedResponses.set(savedItem.itemId, body.response);
      return json({ itemId: savedItem.itemId, revision:1, updatedAt:new Date().toISOString() });
    }
    return json({ error: { code: 'unexpected_fixture_route' } }, 500);
  });

  await page.goto('/tests/r3g/protected-runner-harness.html?purpose=study_sandbox');
  await page.getByRole('button', { name: 'Start practice' }).click();
  await page.getByRole('button', { name: 'Go to lab 1' }).click();
  await page.getByRole('button', { name: 'Inspect pbq-config-panel host' }).click();
  await expect(page.getByText('pbq-config-panel browser-only terminal output.')).toBeVisible();
  await page.getByRole('checkbox', { name: /pbq-config-panel evidence/ }).check();
  await page.getByRole('combobox', { name: /pbq-config-panel decision/ }).selectOption('config-value');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('checkbox', { name: /pbq-firewall evidence/ }).check();
  await page.getByRole('combobox', { name: /pbq-firewall decision/ }).selectOption('firewall-value');
  await page.getByRole('button', { name: 'Previous' }).click();

  expect(saves).toEqual([
    {
      itemId: topologyConfigItem.itemId,
      response: { selectedAnswers: { 'config-evidence': 'selected', 'config-decision': 'config-value' } },
    },
    {
      itemId: topologyFirewallItem.itemId,
      response: { selectedAnswers: { 'firewall-evidence': 'selected', 'firewall-decision': 'firewall-value' } },
    },
  ]);
  expect(JSON.stringify(saves)).not.toMatch(/perHostCommandHistory|perHostTerminalTranscript|browser-only terminal output/);
  await expect(page.getByText('The protected exam request was not valid.')).toHaveCount(0);

  await page.reload();
  await page.getByRole('button', { name: 'Go to lab 1' }).click();
  await expect(page.getByRole('checkbox', { name: /pbq-config-panel evidence/ })).toBeChecked();
  await expect(page.getByRole('combobox', { name: /pbq-config-panel decision/ })).toHaveValue('config-value');
  await expect(page.getByText('pbq-config-panel browser-only terminal output.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Go to lab 2' }).click();
  await expect(page.getByRole('checkbox', { name: /pbq-firewall evidence/ })).toBeChecked();
  await expect(page.getByRole('combobox', { name: /pbq-firewall decision/ })).toHaveValue('firewall-value');
});

test('multi-host PBQ saves only allowlisted scorer state and restores selections with an ephemeral terminal', async ({ page }) => {
  const saves = [];
  let active = false;
  let savedResponse = null;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/certsim-protected-exam')[1];
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    const attempt = { attemptId, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', status:'in_progress', startedAt:'2026-09-10T08:00:00.000Z', expiresAt:null, timed:false, itemCount:80, purpose:'study_sandbox', languagePreference:null };
    const resumedItems = items.map((item) => item.itemId === multiHostItem.itemId
      ? { ...item, response: savedResponse, revision: savedResponse ? 1 : 0 }
      : item);
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates: active ? [{ ...attempt, selectedCount:80, fixedProfileSize:false, replacementPermitted:false }] : [] });
    if (path.startsWith('/practice/recoverable-sandboxes')) return json({ candidates: [] });
    if (path.startsWith('/practice/availability')) return json({ examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', purpose:'study_sandbox', selectedCount:80, timed:false, timeLimitMinutes:null, fixedProfileSize:false, adjustedCount:false });
    if (path === '/practice/sessions') { active = true; return json({ attempt, items: resumedItems, page: { returnedThrough:82, totalCount:82, hasMore:false } }, 201); }
    if (path === `/attempts/${attemptId}`) return json({ attempt, items: resumedItems, page: { returnedThrough:82, totalCount:82, hasMore:false } });
    if (path.endsWith('/flags')) return json({ itemIds: [] });
    if (path.includes(`/${multiHostItem.itemId}/response`)) {
      const body = request.postDataJSON();
      saves.push(body);
      savedResponse = body.response;
      return json({ itemId: multiHostItem.itemId, revision:1, updatedAt:new Date().toISOString() });
    }
    return json({ error: { code: 'unexpected_fixture_route' } }, 500);
  });

  await page.goto('/tests/r3g/protected-runner-harness.html?purpose=study_sandbox');
  await page.getByRole('button', { name: 'Start practice' }).click();
  await page.getByRole('button', { name: 'Go to lab 1' }).click();
  await page.locator('.pbq-terminal input[name="command"]').fill('inspect');
  await page.locator('.pbq-terminal input[name="command"]').press('Enter');
  await expect(page.getByText('Synthetic command output.')).toBeVisible();
  await page.locator('.pbq-config-row select').selectOption('option-a');
  await page.getByRole('button', { name: 'Next' }).click();
  expect(saves).toHaveLength(1);
  expect(saves[0].response).toEqual({ selectedAnswers: { 'evidence-target-a': 'inspected', 'decision-target-a': 'option-a' } });
  expect(JSON.stringify(saves[0].response)).not.toMatch(/perHostCommandHistory|perHostTerminalTranscript|Synthetic command output/);

  await page.reload();
  await page.getByRole('button', { name: 'Go to lab 1' }).click();
  await expect(page.locator('.pbq-config-row select')).toHaveValue('option-a');
  await expect(page.getByText('Inspected', { exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic command output.')).toHaveCount(0);
});

test('active runner preserves an unsaved answer across token rotation and one authentication retry', async ({ page }) => {
  const authorization = [];
  const saveBodies = [];
  let saveRequests = 0;
  let committedSaves = 0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/certsim-protected-exam')[1];
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates: [] });
    if (path.startsWith('/practice/availability')) return json({ examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', purpose:'self_directed_exam', available:true, selectedCount:80, adjustedCount:false, profileQuestionCount:80, timeLimitMinutes:120, fixedProfileSize:true, domainCounts:{}, missedCount:0, newCount:80, pbqCount:2, languages:[] });
    if (path === '/practice/sessions') return json({ attempt:{ attemptId, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', status:'in_progress', startedAt:'2026-09-02T10:00:00.000Z', expiresAt:deadline, timeLimitMinutes:120, purpose:'self_directed_exam', languagePreference:null }, items }, 201);
    if (path.endsWith('/flags')) return json({ itemIds: [] });
    if (path.includes('/response')) {
      saveRequests += 1;
      authorization.push(request.headers().authorization);
      saveBodies.push(request.postDataJSON());
      if (saveRequests === 1) {
        await page.evaluate(() => window.__setProtectedAccessToken('rotated-token'));
        return json({ error: { code: 'unauthenticated' } }, 401);
      }
      committedSaves += 1;
      return json({ itemId:'item-15', revision:1, updatedAt:new Date().toISOString() });
    }
    return json({ error: { code: 'unexpected_fixture_route' } }, 500);
  });

  await page.goto('/tests/r3g/protected-runner-harness.html');
  await page.getByRole('button', { name: /Start/ }).click();
  await page.getByRole('button', { name: 'Go to question 13' }).click();
  await page.locator('.question-card input[type="radio"]').first().check();
  await page.getByRole('button', { name: 'Go to question 14' }).click();
  await expect(page.getByText('Standard Questions: Question 14 of 66')).toBeVisible();
  expect(authorization).toEqual(['Bearer fixture-token', 'Bearer rotated-token']);
  expect(saveBodies).toHaveLength(2);
  expect(saveBodies[0]).toEqual(saveBodies[1]);
  expect(saveBodies[0]).toMatchObject({ expectedRevision: 0 });
  expect(committedSaves).toBe(1);
});

test('routed protected runner recovers technical refresh, then abandons explicitly without a result', async ({ page }) => {
  const recorder = { starts: [], saves: [], flags: [], issues: [], submits: [], abandons: [], resumes: [], bindings: [], deadline };
  let active = false; let saved = null; let flagged = false;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request = route.request(); const url = new URL(request.url()); const routePath = url.pathname.split('/certsim-protected-exam')[1]; const method = request.method(); const body = request.postDataJSON?.() ?? null;
    const json = (value, status=200) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(value) });
    if (routePath.startsWith('/practice/availability')) return json({ examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', purpose:'self_directed_exam', available:true, selectedCount:80, adjustedCount:false, profileQuestionCount:80, timeLimitMinutes:120, fixedProfileSize:true, domainCounts:{}, missedCount:0, newCount:80, pbqCount:2, languages:['not_applicable'] });
    if (routePath.startsWith('/attempts/current-bindings')) { recorder.bindings.push(active); return json({ candidates: active ? [{ attemptId, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', purpose:'self_directed_exam', languagePreference:null, startedAt:'2026-09-02T10:00:00.000Z', expiresAt:deadline, replacementPermitted:true }] : [] }); }
    if (routePath === '/practice/sessions' && method === 'POST') { recorder.starts.push(body); active=true; return json({ attempt:{ attemptId, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', status:'in_progress', startedAt:'2026-09-02T10:00:00.000Z', expiresAt:deadline, timeLimitMinutes:120, purpose:'self_directed_exam', languagePreference:null }, items }, 201); }
    if (routePath === `/attempts/${attemptId}`) { recorder.resumes.push({ attemptId }); return json({ attempt:{ attemptId, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', status:'in_progress', startedAt:'2026-09-02T10:00:00.000Z', expiresAt:deadline, timeLimitMinutes:120, purpose:'self_directed_exam', languagePreference:null }, items:items.map((item)=>item.itemId==='item-15' ? {...item,response:saved?.response??null,revision:saved?.revision??0}:item) }); }
    if (routePath.endsWith('/flags') && method === 'GET') return json({ itemIds: flagged ? ['item-15'] : [] });
    if (routePath.includes('/response') && method === 'PUT') { saved={ response:body.response, revision:body.expectedRevision+1 }; recorder.saves.push({ itemId:'item-15', expectedRevision:body.expectedRevision, revision:saved.revision, response:body.response }); return json({ itemId:'item-15', revision:saved.revision, updatedAt:new Date().toISOString() }); }
    if (routePath.includes('/flag') && method === 'PUT') { flagged=body.flagged; recorder.flags.push({ itemId:'item-15', flagged }); return json({ itemId:'item-15', flagged, updatedAt:new Date().toISOString() }); }
    if (routePath.includes('/issue') && method === 'POST') { recorder.issues.push({ itemId:'item-15', received:Boolean(body.message) }); return json({ received:true }); }
    if (routePath === `/attempts/${attemptId}/abandon` && method === 'POST') { recorder.abandons.push(body); active=false; return json({ attemptId, status:'abandoned', abandonedAt:new Date().toISOString() }); }
    if (routePath.endsWith('/submit')) { recorder.submits.push(body); return json({}); }
    return json({ error:{ code:'unexpected_fixture_route' } },500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html');
  await page.getByRole('button', { name:/Start/ }).click();
  await expect(page.getByText(/119:/)).toBeVisible();
  await expect(page.getByRole('button', { name:'Go to question 13' })).toHaveText('13');
  await page.getByRole('button', { name:'Go to question 13' }).click();
  await expect(page.getByText('Standard Questions: Question 13 of 66')).toBeVisible();
  await page.locator('.question-card input[type="radio"]').first().check();
  await page.getByRole('button', { name:'Flag for review' }).click();
  await page.getByRole('button', { name:'Report question issue' }).click(); await page.getByLabel('What appears to be wrong?').fill('Sanitized issue'); await page.getByRole('button', { name:'Send report' }).click();
  await page.getByRole('button', { name:'Go to question 14' }).click();
  await page.reload();
  await expect(page.getByText(/119:/)).toBeVisible();
  await page.getByRole('button', { name:'Go to question 13' }).click();
  await expect(page.locator('.question-card input[type="radio"]').first()).toBeChecked();
  await expect(page.getByRole('button', { name:'Remove flag' })).toBeVisible();
  await expect(page.getByText(/119:/)).toBeVisible();
  const ledger = { startMutations:recorder.starts.length, attemptFingerprint:hash(attemptId), savedRevision:recorder.saves.at(-1)?.revision??null, expectedRevision:recorder.saves.at(-1)?.expectedRevision??null, submittedOnExit:recorder.submits.length, resumeOperations:recorder.resumes.length, resumedAttemptFingerprint:hash(recorder.resumes.at(-1)?.attemptId), responseRestored:await page.locator('.question-card input[type="radio"]').first().isChecked(), flagRestored:await page.getByRole('button',{name:'Remove flag'}).isVisible(), profileFingerprint:hash(recorder.starts[0]?.profileId), languageFingerprint:hash(recorder.starts[0]?.language ?? null), questionOrderFingerprint:hash(items.map((item)=>item.questionId)), optionOrderFingerprint:hash(items.map((item)=>item.presentation.options?.map((entry)=>entry.id)??[])), deadlineFingerprint:hash(deadline), secondStartMutations:Math.max(0,recorder.starts.length-1), flagMutations:recorder.flags.length, issueMutations:recorder.issues.length };
  expect(ledger).toMatchObject({startMutations:1,savedRevision:1,expectedRevision:0,submittedOnExit:0,resumeOperations:1,responseRestored:true,flagRestored:true,secondStartMutations:0,flagMutations:1,issueMutations:1});
  expect(recorder.starts[0]).not.toHaveProperty('language');
  expect(ledger.attemptFingerprint).toBe(ledger.resumedAttemptFingerprint);
  page.once('dialog',(dialog)=>dialog.accept());
  await page.getByRole('button', { name:'End attempt' }).click();
  await expect(page.getByRole('heading', { name:'Selected exam dashboard' })).toBeVisible();
  expect(recorder.abandons).toHaveLength(1);
  expect(recorder.submits).toHaveLength(0);
});

test('Study Sandbox Save & exit saves once, never abandons, and resumes the same response', async ({ page }) => {
  const sandboxId = '16700000-0000-4000-8000-000000000001';
  const sandboxItem = makeItem(1, 'single-choice', 'standard', 1);
  let active = false;
  let savedResponse = null;
  let saves = 0;
  let exits = 0;
  let abandons = 0;
  let recoverableReads = 0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/certsim-protected-exam')[1];
    const body = request.postDataJSON?.();
    const json = (value, status = 200) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(value) });
    const attempt = { attemptId:sandboxId, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', status:'in_progress', startedAt:'2026-09-11T08:00:00Z', expiresAt:null, timed:false, itemCount:1, purpose:'study_sandbox', languagePreference:null };
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates: active ? [{ ...attempt, selectedCount:1, fixedProfileSize:false, profileComposition:{}, replacementPermitted:false }] : [] });
    if (path.startsWith('/practice/availability')) return json({ examKey:'az400', packageVersion:'1.0.0', profileKey:attempt.profileKey, purpose:'study_sandbox', selectedCount:1, timed:false, timeLimitMinutes:null, fixedProfileSize:false, adjustedCount:false });
    if (path.startsWith('/practice/recoverable-sandboxes')) { recoverableReads += 1; return json({ candidates:[] }); }
    if (path === '/practice/sessions') { active = true; return json({ attempt, items:[sandboxItem], page:{ returnedThrough:1, totalCount:1, hasMore:false } }, 201); }
    if (path === `/attempts/${sandboxId}`) return json({ attempt, items:[{ ...sandboxItem, response:savedResponse, revision:savedResponse ? 1 : 0 }], page:{ returnedThrough:1, totalCount:1, hasMore:false } });
    if (path.endsWith('/flags')) return json({ itemIds:[] });
    if (path.includes('/response')) { saves += 1; savedResponse = body.response; return json({ itemId:sandboxItem.itemId, revision:1, updatedAt:'2026-09-11T08:05:00Z' }); }
    if (path.endsWith('/abandon')) { abandons += 1; return json({ attemptId:sandboxId, status:'abandoned', abandonedAt:'2026-09-11T08:06:00Z' }); }
    return json({ error:{ code:'unexpected_fixture_route' } }, 500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html?purpose=study_sandbox');
  await page.getByRole('button', { name:'Start practice' }).click();
  await page.locator('.question-card input[type="radio"]').first().check();
  await page.getByRole('button', { name:'Save & exit' }).evaluate((button) => { button.click(); button.click(); });
  await expect(page.getByRole('heading', { name:'Selected exam dashboard' })).toBeVisible();
  exits += 1;
  expect({ saves, abandons, recoverableReads }).toEqual({ saves:1, abandons:0, recoverableReads:1 });
  await page.getByRole('button', { name:'Return to protected attempt' }).click();
  await expect(page.locator('.question-card input[type="radio"]').first()).toBeChecked();
  expect({ saves, abandons, recoverableReads, exits }).toEqual({ saves:1, abandons:0, recoverableReads:1, exits:1 });
  await expect(page.getByText(/resume this Study Sandbox within the 30-day inactivity window/i)).toBeVisible();
});

test('Study Sandbox Save & exit stays in the runner when the current response cannot be saved', async ({ page }) => {
  const sandboxId = '16700000-0000-4000-8000-000000000002';
  const sandboxItem = makeItem(1, 'single-choice', 'standard', 1);
  let abandons = 0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname.split('/certsim-protected-exam')[1];
    const json = (value, status = 200) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(value) });
    const attempt = { attemptId:sandboxId, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', status:'in_progress', startedAt:'2026-09-11T08:00:00Z', expiresAt:null, timed:false, itemCount:1, purpose:'study_sandbox', languagePreference:null };
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates:[] });
    if (path.startsWith('/practice/availability')) return json({ examKey:'az400', packageVersion:'1.0.0', profileKey:attempt.profileKey, purpose:'study_sandbox', selectedCount:1, timed:false, timeLimitMinutes:null, fixedProfileSize:false, adjustedCount:false });
    if (path.startsWith('/practice/recoverable-sandboxes')) return json({ candidates:[] });
    if (path === '/practice/sessions') return json({ attempt, items:[sandboxItem], page:{ returnedThrough:1, totalCount:1, hasMore:false } }, 201);
    if (path.endsWith('/flags')) return json({ itemIds:[] });
    if (path.includes('/response')) return json({ error:{ code:'stale_response' } }, 409);
    if (path.endsWith('/abandon')) { abandons += 1; return json({}); }
    return json({ error:{ code:'unexpected_fixture_route' } }, 500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html?purpose=study_sandbox');
  await page.getByRole('button', { name:'Start practice' }).click();
  await page.locator('.question-card input[type="radio"]').first().check();
  await page.getByRole('button', { name:'Save & exit' }).click();
  await expect(page.getByRole('region', { name:'AZ-400 exam workspace' })).toBeVisible();
  await expect(page.getByText(/Not saved:/)).toBeVisible();
  expect(abandons).toBe(0);
});

test('Study Sandbox discard cancellation is safe and an ambiguous committed discard stays locked for one stable retry', async ({ page }) => {
  const sandboxId = '16700000-0000-4000-8000-000000000003';
  const sandboxItem = makeItem(1, 'single-choice', 'standard', 1);
  const events = [];
  const abandonBodies = [];
  let abandonCalls = 0;
  let logicalAbandons = 0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname.split('/certsim-protected-exam')[1]; const body = request.postDataJSON?.();
    const json = (value, status = 200) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(value) });
    const attempt = { attemptId:sandboxId, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', status:'in_progress', startedAt:'2026-09-11T08:00:00Z', expiresAt:null, timed:false, itemCount:1, purpose:'study_sandbox', languagePreference:null };
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates:[] });
    if (path.startsWith('/practice/availability')) return json({ examKey:'az400', packageVersion:'1.0.0', profileKey:attempt.profileKey, purpose:'study_sandbox', selectedCount:1, timed:false, timeLimitMinutes:null, fixedProfileSize:false, adjustedCount:false });
    if (path.startsWith('/practice/recoverable-sandboxes')) return json({ candidates:[] });
    if (path === '/practice/sessions') return json({ attempt, items:[sandboxItem], page:{ returnedThrough:1, totalCount:1, hasMore:false } }, 201);
    if (path.endsWith('/flags')) return json({ itemIds:[] });
    if (path.includes('/response')) { events.push('save'); return json({ itemId:sandboxItem.itemId, revision:1, updatedAt:'2026-09-11T08:05:00Z' }); }
    if (path.endsWith('/lifecycle-summary')) { events.push('summary'); return json({ attemptId:sandboxId, purpose:'study_sandbox', status:'in_progress', savedResponseCount:7 }); }
    if (path.endsWith('/abandon')) {
      events.push('abandon'); abandonCalls += 1; abandonBodies.push(body);
      if (abandonCalls === 1) {
        logicalAbandons += 1;
        return route.abort('failed');
      }
      return json({ attemptId:sandboxId, status:'abandoned', abandonedAt:'2026-09-11T08:06:00Z', savedResponseCount:7 });
    }
    return json({ error:{ code:'unexpected_fixture_route' } }, 500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html?purpose=study_sandbox');
  await page.getByRole('button', { name:'Start practice' }).click();
  await page.locator('.question-card input[type="radio"]').first().check();
  await page.getByRole('button', { name:'Discard saved sandbox' }).click();
  await expect(page.getByRole('dialog', { name:'Permanently discard this Study Sandbox?' })).toContainText('7 saved responses');
  expect(events.slice(0, 2)).toEqual(['save', 'summary']);
  await page.getByRole('button', { name:'Cancel' }).click();
  await expect(page.getByRole('dialog', { name:'Permanently discard this Study Sandbox?' })).toHaveCount(0);
  await expect(page.locator('.question-card input[type="radio"]').first()).toBeEnabled();
  await expect(page.getByRole('button', { name:'Save & exit' })).toBeEnabled();
  expect(abandonBodies).toHaveLength(0);
  await page.locator('.question-card input[type="radio"]').nth(1).check();
  await expect(page.locator('.question-card input[type="radio"]').nth(1)).toBeChecked();
  await page.getByRole('button', { name:'Discard saved sandbox' }).click();
  await page.getByRole('button', { name:'Permanently discard' }).evaluate((button) => { button.click(); button.click(); });
  await expect(page.getByRole('dialog', { name:'Permanently discard this Study Sandbox?' })).toBeVisible();
  await expect(page.getByRole('button', { name:'Retry discard' })).toBeVisible();
  await expect(page.getByRole('button', { name:'Cancel' })).toBeDisabled();
  await expect(page.locator('.question-card input[type="radio"]').first()).toBeDisabled();
  await expect(page.getByRole('button', { name:'Go to question 1' })).toBeDisabled();
  await expect(page.getByRole('button', { name:'Save & exit' })).toBeDisabled();
  await expect(page.getByRole('button', { name:'Flag for review' })).toBeDisabled();
  await page.getByRole('button', { name:'Cancel' }).evaluate((button) => button.click());
  await expect(page.getByRole('dialog', { name:'Permanently discard this Study Sandbox?' })).toBeVisible();
  await expect(page.getByRole('button', { name:'Retry discard' })).toBeVisible();
  expect(abandonBodies).toHaveLength(1);
  expect(logicalAbandons).toBe(1);
  await page.getByRole('button', { name:'Retry discard' }).click();
  await expect(page.getByRole('heading', { name:'Selected exam dashboard' })).toBeVisible();
  expect(abandonBodies).toHaveLength(2);
  expect(logicalAbandons).toBe(1);
  expect(abandonBodies[0].requestId).toBe(abandonBodies[1].requestId);
  expect(new Set(abandonBodies.map((body) => body.requestId)).size).toBe(1);
});

test('Study Sandbox discard fails closed when lifecycle purpose or status does not match', async ({ page }) => {
  const sandboxId = '16700000-0000-4000-8000-000000000004';
  const sandboxItem = makeItem(1, 'single-choice', 'standard', 1);
  let abandons = 0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const path = new URL(route.request().url()).pathname.split('/certsim-protected-exam')[1];
    const json = (value, status = 200) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(value) });
    const attempt = { attemptId:sandboxId, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', status:'in_progress', startedAt:'2026-09-11T08:00:00Z', expiresAt:null, timed:false, itemCount:1, purpose:'study_sandbox', languagePreference:null };
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates:[] });
    if (path.startsWith('/practice/availability')) return json({ examKey:'az400', packageVersion:'1.0.0', profileKey:attempt.profileKey, purpose:'study_sandbox', selectedCount:1, timed:false, timeLimitMinutes:null, fixedProfileSize:false, adjustedCount:false });
    if (path.startsWith('/practice/recoverable-sandboxes')) return json({ candidates:[] });
    if (path === '/practice/sessions') return json({ attempt, items:[sandboxItem], page:{ returnedThrough:1, totalCount:1, hasMore:false } }, 201);
    if (path.endsWith('/flags')) return json({ itemIds:[] });
    if (path.endsWith('/lifecycle-summary')) return json({ attemptId:sandboxId, purpose:'study_sandbox', status:'abandoned', savedResponseCount:1 });
    if (path.endsWith('/abandon')) { abandons += 1; return json({}); }
    return json({ error:{ code:'unexpected_fixture_route' } }, 500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html?purpose=study_sandbox');
  await page.getByRole('button', { name:'Start practice' }).click();
  await page.getByRole('button', { name:'Discard saved sandbox' }).click();
  await expect(page.getByText(/lifecycle state could not be verified/i)).toBeVisible();
  await expect(page.getByRole('dialog', { name:'Permanently discard this Study Sandbox?' })).toHaveCount(0);
  expect(abandons).toBe(0);
});

test('Study Sandbox discard stops before summary and abandonment when dirty save fails', async ({ page }) => {
  const sandboxId = '16700000-0000-4000-8000-000000000009';
  const sandboxItem = makeItem(1, 'single-choice', 'standard', 1);
  let summaries = 0; let abandons = 0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const path = new URL(route.request().url()).pathname.split('/certsim-protected-exam')[1];
    const json = (value, status = 200) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(value) });
    const attempt = { attemptId:sandboxId, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', status:'in_progress', startedAt:'2026-09-11T08:00:00Z', expiresAt:null, timed:false, itemCount:1, purpose:'study_sandbox', languagePreference:null };
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates:[] });
    if (path.startsWith('/practice/availability')) return json({ examKey:'az400', packageVersion:'1.0.0', profileKey:attempt.profileKey, purpose:'study_sandbox', selectedCount:1, timed:false, timeLimitMinutes:null, fixedProfileSize:false, adjustedCount:false });
    if (path.startsWith('/practice/recoverable-sandboxes')) return json({ candidates:[] });
    if (path === '/practice/sessions') return json({ attempt, items:[sandboxItem], page:{ returnedThrough:1, totalCount:1, hasMore:false } }, 201);
    if (path.endsWith('/flags')) return json({ itemIds:[] });
    if (path.includes('/response')) return json({ error:{ code:'stale_response' } }, 409);
    if (path.endsWith('/lifecycle-summary')) { summaries += 1; return json({}); }
    if (path.endsWith('/abandon')) { abandons += 1; return json({}); }
    return json({ error:{ code:'unexpected_fixture_route' } }, 500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html?purpose=study_sandbox');
  await page.getByRole('button', { name:'Start practice' }).click();
  await page.locator('.question-card input[type="radio"]').first().check();
  await page.getByRole('button', { name:'Discard saved sandbox' }).click();
  await expect(page.getByText(/Not saved:/)).toBeVisible();
  await expect(page.getByRole('dialog', { name:'Permanently discard this Study Sandbox?' })).toHaveCount(0);
  expect({ summaries, abandons }).toEqual({ summaries:0, abandons:0 });
});

test('historical Study Sandbox recovery is explicit, metadata-only, stable on retry, and resumes the same attempt', async ({ page }) => {
  const firstId = '16700000-0000-4000-8000-000000000005';
  const secondId = '16700000-0000-4000-8000-000000000006';
  const sandboxItem = { ...makeItem(1, 'single-choice', 'standard', 1), response:{ answer:'a' }, revision:1 };
  const recoveryBodies = [];
  let recoverCalls = 0;
  let starts = 0;
  let resumes = 0;
  let abandons = 0;
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request = route.request(); const path = new URL(request.url()).pathname.split('/certsim-protected-exam')[1]; const body = request.postDataJSON?.();
    const json = (value, status = 200) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(value) });
    const candidate = (id, count) => ({ attemptId:id, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:`Sectioned ${count}`, purpose:'study_sandbox', languagePreference:null, startedAt:`2026-09-0${count}T08:00:00Z`, lastActivityAt:`2026-09-0${count}T09:00:00Z`, itemCount:1, savedResponseCount:count, recoverable:true, questionText:'must not render', answer:'must not render' });
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates:[] });
    if (path.startsWith('/practice/availability')) return json({ examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', purpose:'study_sandbox', selectedCount:1, timed:false, timeLimitMinutes:null, fixedProfileSize:false, adjustedCount:false });
    if (path.startsWith('/practice/recoverable-sandboxes')) return json({ candidates:[candidate(firstId, 1), candidate(secondId, 2)] });
    if (path === `/practice/sessions/${firstId}/recover`) {
      recoverCalls += 1; recoveryBodies.push(body);
      return recoverCalls === 1
        ? json({ error:{ code:'internal_failure' } }, 503)
        : json({ attemptId:firstId, status:'in_progress', recoveredAt:'2026-09-11T10:00:00Z', savedResponseCount:1, items:[{ question:'recovery-endpoint-content-must-not-render' }] });
    }
    if (path === `/attempts/${firstId}`) { resumes += 1; return json({ attempt:{ ...candidate(firstId, 1), status:'in_progress', expiresAt:null, timed:false }, items:[sandboxItem], page:{ returnedThrough:1, totalCount:1, hasMore:false } }); }
    if (path === '/practice/sessions') { starts += 1; return json({ error:{ code:'unexpected_start' } }, 500); }
    if (path.endsWith('/abandon')) { abandons += 1; return json({}); }
    if (path.endsWith('/flags')) return json({ itemIds:[] });
    return json({ error:{ code:'unexpected_fixture_route' } }, 500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html?purpose=study_sandbox');
  await expect(page.getByRole('button', { name:'Recover saved sandbox' })).toHaveCount(2);
  await expect(page.getByRole('button', { name:'Start new' })).toBeVisible();
  await expect(page.getByText('must not render')).toHaveCount(0);
  expect({ recoverCalls, starts, resumes, abandons }).toEqual({ recoverCalls:0, starts:0, resumes:0, abandons:0 });
  await page.getByRole('button', { name:'Recover saved sandbox' }).first().click();
  await expect(page.getByRole('button', { name:'Retry recovery' })).toBeVisible();
  await expect(page.getByRole('button', { name:'Recover saved sandbox' })).toBeDisabled();
  await expect(page.getByRole('button', { name:'Start new' })).toBeDisabled();
  await page.getByRole('button', { name:'Retry recovery' }).click();
  await expect.poll(() => ({ recoverCalls, resumes })).toEqual({ recoverCalls:2, resumes:1 });
  expect(pageErrors).toEqual([]);
  await expect(page.getByRole('region', { name:'AZ-400 exam workspace' })).toBeVisible();
  await expect(page.locator('.question-card input[type="radio"]').first()).toBeChecked();
  await expect(page.getByText('recovery-endpoint-content-must-not-render')).toHaveCount(0);
  expect({ recoverCalls, starts, resumes, abandons }).toEqual({ recoverCalls:2, starts:0, resumes:1, abandons:0 });
  expect(recoveryBodies[0]).toEqual(recoveryBodies[1]);
  expect(recoveryBodies[0]).toEqual({ requestId:recoveryBodies[0].requestId });
});

test('Start new remains explicit with historical candidates and does not recover or discard them', async ({ page }) => {
  const historicalId = '16700000-0000-4000-8000-000000000010';
  const newId = '16700000-0000-4000-8000-000000000011';
  const sandboxItem = makeItem(1, 'single-choice', 'standard', 1);
  let starts = 0; let recovers = 0; let abandons = 0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const path = new URL(route.request().url()).pathname.split('/certsim-protected-exam')[1];
    const json = (value, status = 200) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(value) });
    const binding = { examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', purpose:'study_sandbox', languagePreference:null, startedAt:'2026-09-01T08:00:00Z', lastActivityAt:'2026-09-01T09:00:00Z', itemCount:1, savedResponseCount:1, recoverable:true };
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates:[] });
    if (path.startsWith('/practice/availability')) return json({ ...binding, selectedCount:1, timed:false, timeLimitMinutes:null, fixedProfileSize:false, adjustedCount:false });
    if (path.startsWith('/practice/recoverable-sandboxes')) return json({ candidates:[{ ...binding, attemptId:historicalId }] });
    if (path === '/practice/sessions') { starts += 1; return json({ attempt:{ ...binding, attemptId:newId, status:'in_progress', expiresAt:null, timed:false }, items:[sandboxItem], page:{ returnedThrough:1, totalCount:1, hasMore:false } }, 201); }
    if (path.endsWith('/recover')) { recovers += 1; return json({}); }
    if (path.endsWith('/abandon')) { abandons += 1; return json({}); }
    if (path.endsWith('/flags')) return json({ itemIds:[] });
    return json({ error:{ code:'unexpected_fixture_route' } }, 500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html?purpose=study_sandbox');
  await page.getByRole('button', { name:'Start new' }).click();
  await expect(page.getByRole('region', { name:'AZ-400 exam workspace' })).toBeVisible();
  expect({ starts, recovers, abandons }).toEqual({ starts:1, recovers:0, abandons:0 });
});

test('active Study Sandbox binding has priority over historical discovery', async ({ page }) => {
  const sandboxId = '16700000-0000-4000-8000-000000000007';
  const sandboxItem = makeItem(1, 'single-choice', 'standard', 1);
  let recoverableReads = 0;
  let resumes = 0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const path = new URL(route.request().url()).pathname.split('/certsim-protected-exam')[1];
    const json = (value, status = 200) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(value) });
    const attempt = { attemptId:sandboxId, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', status:'in_progress', startedAt:'2026-09-11T08:00:00Z', expiresAt:null, timed:false, itemCount:1, purpose:'study_sandbox', languagePreference:null, selectedCount:1, fixedProfileSize:false, profileComposition:{}, replacementPermitted:false };
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates:[attempt] });
    if (path.startsWith('/practice/recoverable-sandboxes')) { recoverableReads += 1; return json({ candidates:[] }); }
    if (path === `/attempts/${sandboxId}`) { resumes += 1; return json({ attempt, items:[sandboxItem], page:{ returnedThrough:1, totalCount:1, hasMore:false } }); }
    if (path.endsWith('/flags')) return json({ itemIds:[] });
    return json({ error:{ code:'unexpected_fixture_route' } }, 500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html?purpose=study_sandbox');
  await expect(page.getByRole('region', { name:'AZ-400 exam workspace' })).toBeVisible();
  expect({ recoverableReads, resumes }).toEqual({ recoverableReads:0, resumes:1 });
});

test('active-sandbox recovery conflict refreshes active binding without start or destructive cleanup', async ({ page }) => {
  const sandboxId = '16700000-0000-4000-8000-000000000008';
  const sandboxItem = makeItem(1, 'single-choice', 'standard', 1);
  let active = false;
  let recovers = 0;
  let starts = 0;
  let abandons = 0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const path = new URL(route.request().url()).pathname.split('/certsim-protected-exam')[1];
    const json = (value, status = 200) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(value) });
    const attempt = { attemptId:sandboxId, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', purpose:'study_sandbox', languagePreference:null, startedAt:'2026-09-11T08:00:00Z', expiresAt:null, timed:false, itemCount:1, selectedCount:1, fixedProfileSize:false, profileComposition:{}, replacementPermitted:false };
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates:active ? [{ ...attempt, status:'in_progress' }] : [] });
    if (path.startsWith('/practice/availability')) return json({ examKey:'az400', packageVersion:'1.0.0', profileKey:attempt.profileKey, purpose:'study_sandbox', selectedCount:1, timed:false, timeLimitMinutes:null, fixedProfileSize:false, adjustedCount:false });
    if (path.startsWith('/practice/recoverable-sandboxes')) return json({ candidates:[{ ...attempt, lastActivityAt:'2026-09-11T09:00:00Z', savedResponseCount:1, recoverable:true }] });
    if (path === `/practice/sessions/${sandboxId}/recover`) { recovers += 1; active = true; return json({ error:{ code:'active_sandbox_exists' } }, 409); }
    if (path === `/attempts/${sandboxId}`) return json({ attempt:{ ...attempt, status:'in_progress' }, items:[sandboxItem], page:{ returnedThrough:1, totalCount:1, hasMore:false } });
    if (path === '/practice/sessions') { starts += 1; return json({}); }
    if (path.endsWith('/abandon')) { abandons += 1; return json({}); }
    if (path.endsWith('/flags')) return json({ itemIds:[] });
    return json({ error:{ code:'unexpected_fixture_route' } }, 500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html?purpose=study_sandbox');
  await page.getByRole('button', { name:'Recover saved sandbox' }).click();
  await expect(page.getByRole('region', { name:'AZ-400 exam workspace' })).toBeVisible();
  expect({ recovers, starts, abandons }).toEqual({ recovers:1, starts:0, abandons:0 });
});

const az204Items = [
  ...Array.from({ length: 43 }, (_, index) => makeItem(index + 1, 'single-choice', 'standard', index + 1)),
  makeItem(44, 'case-study-context', 'az204-long-case', null),
  ...Array.from({ length: 7 }, (_, index) => makeItem(index + 45, 'single-choice', 'az204-long-case', index + 44)),
];
const az204Attempt = (id, language, assignmentId = null) => ({ attemptId:id, assignmentId, examKey:'az204', packageVersion:'1.1.0', profileKey:'standard-profile', profileName:'Standard', status:'in_progress', startedAt:'2026-09-02T12:00:00.000Z', expiresAt:deadline, timeLimitMinutes:120, purpose:'self_directed_exam', languagePreference:language });

test('untimed targeted practice uses authoritative setup semantics and refreshes domain availability', async ({ page }) => {
  const requests = [];
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.split('/certsim-protected-exam')[1];
    const json = (value) => route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(value) });
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates:[] });
    if (path.startsWith('/practice/availability')) {
      requests.push(Object.fromEntries(url.searchParams));
      return json({ examKey:'az204', packageVersion:'1.1.0', profileKey:'standard-profile', purpose:'targeted_domain', selectedCount:59, timed:false, timeLimitMinutes:null, adjustedCount:false });
    }
    return route.fulfill({ status:500, contentType:'application/json', body:JSON.stringify({ error:{ code:'unexpected_fixture_route' } }) });
  });
  await page.goto('/tests/r3g/protected-runner-harness.html?exam=az204&purpose=targeted_domain&domain=develop-azure-compute-solutions');
  await expect(page.getByRole('heading',{name:'Practice details'})).toBeVisible();
  await expect(page.getByText('Untimed',{exact:true})).toBeVisible();
  await expect(page.getByText('59',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Start practice'})).toBeEnabled();
  await expect(page.getByText(/original server timer continues/)).toHaveCount(0);
  await page.getByLabel('Practice domain').selectOption('Develop for Azure storage');
  await expect.poll(() => requests.at(-1)?.domain).toBe('develop-for-azure-storage');
});

test('explicit App assignment context reaches the protected start mutation unchanged', async ({ page }) => {
  const assignmentId = '15000000-0000-4000-8000-000000000001';
  const starts = [];
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/certsim-protected-exam')[1];
    const body = request.postDataJSON?.();
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path.startsWith('/practice/availability')) {
      expect(new URL(request.url()).searchParams.get('assignmentId')).toBe(assignmentId);
      return json({ examKey:'az204', packageVersion:'1.1.0', profileKey:'standard-profile', purpose:'self_directed_exam', available:true, selectedCount:50, adjustedCount:false, profileQuestionCount:50, timeLimitMinutes:120, fixedProfileSize:true, domainCounts:{}, missedCount:0, newCount:50, pbqCount:0, languages:['csharp','python','mixed'] });
    }
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates: [] });
    if (path === '/practice/sessions') {
      starts.push(body);
      return json({ attempt: az204Attempt(attemptId, 'csharp', assignmentId), items: az204Items }, 201);
    }
    if (path.endsWith('/flags')) return json({ itemIds: [] });
    return json({ error: { code: 'unexpected_fixture_route' } }, 500);
  });
  await page.goto(`/tests/r3g/protected-runner-harness.html?exam=az204&assignment=${assignmentId}`);
  await page.getByRole('button', { name: 'Start exam' }).click();
  await expect(page.getByText('Standard Questions: Question 1 of 43')).toBeVisible();
  expect(starts).toHaveLength(1);
  expect(starts[0].assignmentId).toBe(assignmentId);
});

test('AZ-204 keeps one language selector, resumes locked C#, and starts one explicit Python replacement', async ({ page }) => {
  const oldId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; const nextId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  let replacements=0; let resumes=0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request=route.request(); const path=new URL(request.url()).pathname.split('/certsim-protected-exam')[1]; const body=request.postDataJSON?.();
    const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(path.startsWith('/practice/availability')) return json({examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',purpose:'self_directed_exam',available:true,selectedCount:50,adjustedCount:false,profileQuestionCount:50,timeLimitMinutes:120,fixedProfileSize:true,domainCounts:{},missedCount:0,newCount:50,pbqCount:0,languages:['csharp','python','mixed']});
    if(path.startsWith('/attempts/current-bindings')) return json({candidates:[{attemptId:oldId,examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',profileName:'Standard',purpose:'self_directed_exam',languagePreference:'csharp',startedAt:'2026-09-02T12:00:00.000Z',expiresAt:deadline,replacementPermitted:true}]});
    if(path===`/attempts/${oldId}`){resumes+=1;return json({attempt:az204Attempt(oldId,'csharp'),items:az204Items});}
    if(path==='/practice/sessions/replace'){replacements+=1;expect(body).toMatchObject({examKey:'az204',profileId:'standard-profile',language:'python'});return json({attempt:az204Attempt(nextId,'python'),items:az204Items},201);}
    if(path.endsWith('/flags')) return json({itemIds:[]});
    return json({error:{code:'unexpected_fixture_route'}},500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html?exam=az204&language=python');
  await expect(page.locator('.coding-language-panel')).toHaveCount(1);
  await page.getByRole('radio',{name:/^Python\b/}).check();
  await expect(page.getByRole('button',{name:/Resume attempt.*Standard.*csharp/i})).toBeVisible();
  await expect(page.getByRole('button',{name:'Start new attempt'})).toBeVisible();
  page.once('dialog',(dialog)=>dialog.accept());
  await page.getByRole('button',{name:'Start new attempt'}).dblclick();
  await expect(page.getByText('Standard Questions: Question 1 of 43')).toBeVisible();
  expect(replacements).toBe(1); expect(resumes).toBe(0);
});

for (const [activeLanguage, selectedLanguage] of [
  ['csharp', 'mixed'],
  ['python', 'csharp'],
  ['mixed', 'python'],
]) {
  test(`AZ-204 keeps active ${activeLanguage} separate from new ${selectedLanguage}`, async ({ page }) => {
    const oldId='abababab-abab-4bab-8bab-abababababab'; const nextId='cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    const requests=[]; let resumes=0; let availabilityReads=0; let confirmation='';
    await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
      const request=route.request(); const path=new URL(request.url()).pathname.split('/certsim-protected-exam')[1]; const body=request.postDataJSON?.();
      const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
      if(path.startsWith('/practice/availability')) { availabilityReads+=1; return json({examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',purpose:'self_directed_exam',available:true,selectedCount:50,adjustedCount:false,profileQuestionCount:50,timeLimitMinutes:120,fixedProfileSize:true,domainCounts:{},missedCount:0,newCount:50,pbqCount:0,languages:['csharp','python','mixed']}); }
      if(path.startsWith('/attempts/current-bindings')) return json({candidates:[{attemptId:oldId,examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',profileName:'Standard',purpose:'self_directed_exam',languagePreference:activeLanguage,startedAt:'2026-09-02T12:00:00.000Z',expiresAt:deadline,replacementPermitted:true}]});
      if(path===`/attempts/${oldId}`){resumes+=1;return json({attempt:az204Attempt(oldId,activeLanguage),items:az204Items});}
      if(path==='/practice/sessions/replace'){requests.push(body);return json({attempt:az204Attempt(nextId,selectedLanguage),items:az204Items},201);}
      if(path.endsWith('/flags')) return json({itemIds:[]});
      return json({error:{code:'unexpected_fixture_route'}},500);
    });
    page.on('dialog',async (dialog)=>{confirmation=dialog.message();await dialog.accept();});
    await page.goto(`/tests/r3g/protected-runner-harness.html?exam=az204&language=${selectedLanguage}`);
    await expect(page.getByRole('button',{name:new RegExp(`Resume attempt.*${activeLanguage}`,'i')})).toBeVisible();
    await page.getByRole('radio',{name:new RegExp(`^${selectedLanguage === 'csharp' ? 'C#' : selectedLanguage}`,'i')}).check();
    await expect(page.getByRole('radio',{name:new RegExp(`^${selectedLanguage === 'csharp' ? 'C#' : selectedLanguage}`,'i')})).toBeChecked();
    expect({requests:requests.length,resumes,availabilityReads}).toEqual({requests:0,resumes:0,availabilityReads:0});
    await page.getByRole('button',{name:'Start new attempt'}).click();
  await expect(page.getByText('Standard Questions: Question 1 of 43')).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({examKey:'az204',profileId:'standard-profile',language:selectedLanguage});
    expect(confirmation.toLowerCase()).toContain(selectedLanguage === 'csharp' ? 'csharp' : selectedLanguage);
    expect(confirmation.toLowerCase()).toContain(activeLanguage === 'csharp' ? 'csharp' : activeLanguage);
    expect(resumes).toBe(0);
  });
}

test('AZ-204 stale availability cannot reset a learner-selected new-attempt language', async ({ page }) => {
  const oldId='12121212-1212-4212-8212-121212121212'; const nextId='34343434-3434-4434-8434-343434343434';
  const replacements=[]; let availabilityReads=0; let resumes=0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request=route.request(); const path=new URL(request.url()).pathname.split('/certsim-protected-exam')[1]; const body=request.postDataJSON?.();
    const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(path.startsWith('/practice/availability')) { availabilityReads+=1; await new Promise((resolve)=>setTimeout(resolve,150)); return json({examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',purpose:'self_directed_exam',available:true,selectedCount:50,adjustedCount:false,profileQuestionCount:50,timeLimitMinutes:120,fixedProfileSize:true,domainCounts:{},missedCount:0,newCount:50,pbqCount:0,languages:['csharp','python','mixed']}); }
    if(path.startsWith('/attempts/current-bindings')) return json({candidates:[{attemptId:oldId,examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',profileName:'Standard',purpose:'self_directed_exam',languagePreference:'csharp',startedAt:'2026-09-02T12:00:00.000Z',expiresAt:deadline,replacementPermitted:true}]});
    if(path===`/attempts/${oldId}`){resumes+=1;return json({attempt:az204Attempt(oldId,'csharp'),items:az204Items});}
    if(path==='/practice/sessions/replace'){replacements.push(body);return json({attempt:az204Attempt(nextId,'python'),items:az204Items},201);}
    if(path.endsWith('/flags')) return json({itemIds:[]});
    return json({error:{code:'unexpected_fixture_route'}},500);
  });
    await page.goto('/tests/r3g/protected-runner-harness.html?exam=az204&language=mixed');
  await page.getByRole('radio',{name:/^Python\b/}).check();
  await expect(page.getByRole('radio',{name:/^Python\b/})).toBeChecked();
  await expect(page.getByRole('button',{name:/Resume attempt.*csharp/i})).toBeVisible();
  await expect(page.getByRole('radio',{name:/^Python\b/})).toBeChecked();
  expect({availabilityReads,resumes,replacements:replacements.length}).toEqual({availabilityReads:0,resumes:0,replacements:0});
  page.once('dialog',(dialog)=>dialog.accept());
  await page.getByRole('button',{name:'Start new attempt'}).click();
  await expect(page.getByText('Standard Questions: Question 1 of 43')).toBeVisible();
  expect(replacements).toHaveLength(1);
  expect(replacements[0].language).toBe('python');
});

for (const assigned of [true, false]) {
  test(`ambiguous ${assigned ? 'assigned' : 'unassigned'} replacement recovery preserves exact context`, async ({ page }) => {
    const oldId='71717171-7171-4171-8171-717171717171';
    const nextId='72727272-7272-4272-8272-727272727272';
    const assignmentId=assigned ? '15000000-0000-4000-8000-000000000001' : null;
    let replacements=0; const recoveryQueries=[];
    await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
      const request=route.request(); const url=new URL(request.url()); const path=url.pathname.split('/certsim-protected-exam')[1];
      const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
      if(path.startsWith('/attempts/current-bindings')) return json({candidates:[{attemptId:oldId,assignmentId,examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',profileName:'Standard',purpose:'self_directed_exam',languagePreference:'csharp',startedAt:'2026-09-02T12:00:00.000Z',expiresAt:deadline,replacementPermitted:true}]});
      if(path==='/practice/sessions/replace') { replacements+=1; return json({error:{code:'internal_failure'}},503); }
      if(path.startsWith('/attempts/current')) {
        recoveryQueries.push(Object.fromEntries(url.searchParams));
        return json({attempt:az204Attempt(nextId,'python',assignmentId),items:az204Items});
      }
      if(path.endsWith('/flags')) return json({itemIds:[]});
      return json({error:{code:'unexpected_fixture_route'}},500);
    });
    const suffix=assigned ? `&assignment=${assignmentId}` : '';
    await page.goto(`/tests/r3g/protected-runner-harness.html?exam=az204&language=python${suffix}`);
    await page.getByRole('radio',{name:/^Python\b/}).check();
    page.once('dialog',(dialog)=>dialog.accept());
    await page.getByRole('button',{name:'Start new attempt'}).click();
  await expect(page.getByText('Standard Questions: Question 1 of 43')).toBeVisible();
    expect(replacements).toBe(1);
    expect(recoveryQueries).toHaveLength(1);
    expect(recoveryQueries[0]).toMatchObject({profileId:'standard-profile',purpose:'self_directed_exam',language:'python'});
    expect(recoveryQueries[0]).not.toHaveProperty('packageVersion');
    if(assigned) expect(recoveryQueries[0].assignmentId).toBe(assignmentId);
    else expect(recoveryQueries[0]).not.toHaveProperty('assignmentId');
  });
}

test('AZ-204 automatically recovers the single matching-language attempt', async ({ page }) => {
  const oldId='56565656-5656-4656-8656-565656565656'; let resumes=0; let starts=0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request=route.request(); const path=new URL(request.url()).pathname.split('/certsim-protected-exam')[1];
    const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(path.startsWith('/practice/availability')) return json({examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',purpose:'self_directed_exam',available:true,selectedCount:50,adjustedCount:false,profileQuestionCount:50,timeLimitMinutes:120,fixedProfileSize:true,domainCounts:{},missedCount:0,newCount:50,pbqCount:0,languages:['csharp','python','mixed']});
    if(path.startsWith('/attempts/current-bindings')) return json({candidates:[{attemptId:oldId,examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',profileName:'Standard',purpose:'self_directed_exam',languagePreference:'python',startedAt:'2026-09-02T12:00:00.000Z',expiresAt:deadline,replacementPermitted:true}]});
    if(path===`/attempts/${oldId}`){resumes+=1;return json({attempt:az204Attempt(oldId,'python'),items:az204Items});}
    if(path==='/practice/sessions'){starts+=1;return json({error:{code:'unexpected_start'}},500);}
    if(path.endsWith('/flags')) return json({itemIds:[]});
    return json({error:{code:'unexpected_fixture_route'}},500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html?exam=az204&language=python');
  await expect(page.getByText('Standard Questions: Question 1 of 43')).toBeVisible();
  await expect(page.getByRole('button',{name:/Resume attempt/})).toHaveCount(0);
  expect({resumes,starts}).toEqual({resumes:1,starts:0});
});

test('non-language technical entry automatically resumes without replacement', async ({ page }) => {
  const oldId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'; let resumes=0; let replacements=0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request=route.request(); const path=new URL(request.url()).pathname.split('/certsim-protected-exam')[1]; const body=request.postDataJSON?.();
    const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(path.startsWith('/practice/availability')) return json({examKey:'az400',packageVersion:'1.0.0',profileKey:'az400-sectioned-full-exam-profile',purpose:'self_directed_exam',available:true,selectedCount:80,adjustedCount:false,profileQuestionCount:80,timeLimitMinutes:120,fixedProfileSize:true,domainCounts:{},missedCount:0,newCount:80,pbqCount:2,languages:[]});
    if(path.startsWith('/attempts/current-bindings')) return json({candidates:[{attemptId:oldId,examKey:'az400',packageVersion:'1.0.0',profileKey:'az400-sectioned-full-exam-profile',profileName:'Sectioned',purpose:'self_directed_exam',languagePreference:null,startedAt:'2026-09-02T12:00:00.000Z',expiresAt:deadline,replacementPermitted:true}]});
    if(path===`/attempts/${oldId}`){resumes+=1;return json({attempt:{attemptId:oldId,examKey:'az400',packageVersion:'1.0.0',profileKey:'az400-sectioned-full-exam-profile',profileName:'Sectioned',status:'in_progress',startedAt:'2026-09-02T12:00:00.000Z',expiresAt:deadline,timeLimitMinutes:120,purpose:'self_directed_exam',languagePreference:null},items});}
    if(path==='/practice/sessions/replace'){replacements+=1;return json({error:{code:'unexpected_replace'}},500);}
    if(path.endsWith('/flags')) return json({itemIds:[]});
    return json({error:{code:'unexpected_fixture_route'}},500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html');
  await expect(page.getByRole('region',{name:'AZ-400 exam workspace'})).toBeVisible();
  expect({resumes,replacements}).toEqual({resumes:1,replacements:0});
});

test('stale advertised resume recovers inline to Start exam without a terminal screen', async ({ page }) => {
  const staleId='dddddddd-dddd-4ddd-8ddd-dddddddddddd'; let bindingReads=0;
  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const path=new URL(route.request().url()).pathname.split('/certsim-protected-exam')[1];
    const json=(value,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if(path.startsWith('/practice/availability')) return json({examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',purpose:'self_directed_exam',available:true,selectedCount:50,adjustedCount:false,profileQuestionCount:50,timeLimitMinutes:120,fixedProfileSize:true,domainCounts:{},missedCount:0,newCount:50,pbqCount:0,languages:['csharp','python','mixed']});
    if(path.startsWith('/attempts/current-bindings')){bindingReads+=1;return json({candidates:bindingReads===1?[{attemptId:staleId,examKey:'az204',packageVersion:'1.1.0',profileKey:'standard-profile',profileName:'Standard',purpose:'self_directed_exam',languagePreference:'csharp',startedAt:'2026-09-02T12:00:00.000Z',expiresAt:deadline,replacementPermitted:true}]:[]});}
    if(path===`/attempts/${staleId}`) return json({error:{code:'attempt_not_found'}},404);
    return json({error:{code:'unexpected_fixture_route'}},500);
  });
  await page.goto('/tests/r3g/protected-runner-harness.html?exam=az204');
  await expect(page.getByRole('button',{name:'Start exam'})).toBeVisible();
  await expect(page.getByText(/No resumable protected attempt/)).toHaveCount(0);
  await expect(page.locator('.coding-language-panel')).toHaveCount(1);
});

test('released shuffled choice review renders stable option text as accessible lists', async ({ page }) => {
  const reviewOptions = [
    { id: 'D', text: 'Allow anonymous access.' },
    { id: 'B', text: 'Store a client secret.' },
    { id: 'A', text: 'Use managed identity.' },
    { id: 'C', text: 'Use a shared access key.' },
  ];
  const reviewItems = [
    { itemId: 'review-single', questionId: 'single', questionType: 'single-choice', domain: 'Identity', section: 'standard', response: { answer: 'A' }, status: 'Correct', earnedPoints: 1, maxPoints: 1, correctAnswer: { correctAnswer: 'A' }, presentation: { type: 'single-choice', question: 'Synthetic single choice.', options: reviewOptions } },
    { itemId: 'review-two', questionId: 'select-two', questionType: 'multi-select', domain: 'Identity', section: 'standard', response: { answer: ['A'] }, status: 'Partial', earnedPoints: 1, maxPoints: 2, correctAnswer: { correctAnswers: ['A', 'C'] }, presentation: { type: 'multi-select', question: 'Synthetic select two.', options: reviewOptions } },
    { itemId: 'review-three', questionId: 'select-three', questionType: 'multi-select', domain: 'Identity', section: 'standard', response: { answer: ['D'] }, status: 'Incorrect', earnedPoints: 0, maxPoints: 3, correctAnswer: { correctOptionIds: ['A', 'C', 'D'] }, presentation: { type: 'multi-select', question: 'Synthetic select three.', options: [...reviewOptions].reverse() } },
    { itemId: 'review-match', questionId: 'matching', questionType: 'drag-drop-match', domain: 'Identity', section: 'standard', response: { answer: { 'left-a': 'right-y' } }, status: 'Partial', earnedPoints: 0.5, maxPoints: 1, correctAnswer: { correctPairs: { 'left-a': 'right-x', 'left-b': 'right-y' } }, presentation: { type: 'drag-drop-match', question: 'Synthetic matching.', prompts: [{ id: 'left-a', text: 'Detect objects in an image' }, { id: 'left-b', text: 'Extract text from a document' }], options: [{ id: 'right-y', text: 'Document Intelligence' }, { id: 'right-x', text: 'Azure AI Vision' }] } },
  ];

  await page.route('**/functions/v1/certsim-protected-exam/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.split('/certsim-protected-exam')[1];
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path.startsWith('/practice/availability')) return json({ examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', purpose:'self_directed_exam', available:true, selectedCount:80, adjustedCount:false, profileQuestionCount:80, timeLimitMinutes:120, fixedProfileSize:true, domainCounts:{}, missedCount:0, newCount:80, pbqCount:2, languages:[] });
    if (path.startsWith('/attempts/current-bindings')) return json({ candidates: [] });
    if (path === '/practice/sessions' && request.method() === 'POST') return json({ attempt:{ attemptId, examKey:'az400', packageVersion:'1.0.0', profileKey:'az400-sectioned-full-exam-profile', profileName:'Sectioned', status:'in_progress', startedAt:'2026-09-02T10:00:00.000Z', expiresAt:deadline, timeLimitMinutes:120, purpose:'self_directed_exam', languagePreference:null }, items }, 201);
    if (path.endsWith('/flags')) return json({ itemIds: [] });
    if (path.endsWith('/submit')) return json({ result:{ attemptId, examKey:'az400', profileKey:'az400-sectioned-full-exam-profile', completedAt:new Date().toISOString(), questionCount:80, answeredCount:0, rawScore:0, maxScore:80, rawPercentage:0, scaledScore:0, passed:false, passMark:700, domainBreakdown:[], reviewStatus:'released', serverAuthoritative:true } });
    if (path.endsWith('/review')) return json({ review: { items: reviewItems } });
    return json({ error: { code: 'unexpected_fixture_route' } }, 500);
  });

  await page.goto('/tests/r3g/protected-runner-harness.html');
  await page.getByRole('button', { name: /Start/ }).click();
  await page.getByRole('button', { name: 'Go to lab 2' }).click();
  await page.getByRole('button', { name: 'Submit exam' }).click();
  await page.getByRole('button', { name: 'Submit Final Attempt' }).click();
  await page.getByRole('button', { name: 'View released review' }).click();

  const reviewCards = page.locator('.protected-review-list article');
  await expect(reviewCards).toHaveCount(4);
  await expect(reviewCards.nth(0).locator('.released-answer-list').nth(1).getByRole('listitem')).toHaveText(['Use managed identity.']);
  await expect(reviewCards.nth(1).locator('.released-answer-list').nth(1).getByRole('listitem')).toHaveText(['Use managed identity.', 'Use a shared access key.']);
  await expect(reviewCards.nth(2).locator('.released-answer-list').nth(1).getByRole('listitem')).toHaveText(['Use managed identity.', 'Use a shared access key.', 'Allow anonymous access.']);
  await expect(reviewCards.nth(3).locator('.released-answer-list').nth(0).getByRole('listitem')).toHaveText(['Detect objects in an image → Document Intelligence']);
  await expect(reviewCards.nth(3).locator('.released-answer-list').nth(1).getByRole('listitem')).toHaveText(['Detect objects in an image → Azure AI Vision', 'Extract text from a document → Document Intelligence']);
  await expect(page.getByText('A, C', { exact: true })).toHaveCount(0);
  await expect(page.getByText(/left-a|right-x|correctPairs|answer:/)).toHaveCount(0);
});
