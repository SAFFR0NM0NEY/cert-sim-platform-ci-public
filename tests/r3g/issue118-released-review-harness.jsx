import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReleasedReviewWorkspace from '../../src/components/exam/ReleasedReviewWorkspace.jsx';
import { ProtectedResultDetail } from '../../src/protected/ProtectedSavedResultsPage.jsx';
import '../../src/styles/global.css';

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') ?? 'workspace';
const exactAttemptId = 'attempt-118-exact-fixture';
const internalQuestionId = '8f5e0da6-c3be-4aa1-b6c4-a49f00e52318';
const internalItemId = '695416e6-a5e5-4a79-8ae6-13c462e827f0';

const choicePresentation = {
  type: 'single-choice',
  stem: 'Choose the released learner-safe answer.',
  options: [
    { id: 'choice-private-a', text: 'Use the released safe option.' },
    { id: 'choice-private-b', text: 'Use the alternative option.' },
  ],
};

function standardItem(index, overrides = {}) {
  const statuses = ['Correct', 'Incorrect', 'Partial', 'Incomplete', 'Unanswered'];
  return {
    itemId: index === 1 ? internalItemId : `private-item-${index}`,
    questionId: index === 1 ? internalQuestionId : `private-question-${index}`,
    questionNumber: index,
    questionType: 'single-choice',
    presentation: { ...choicePresentation, stem: `Released question prompt ${index}` },
    response: { answer: 'choice-private-a' },
    correctAnswer: { correctAnswer: 'choice-private-a' },
    status: statuses[(index - 1) % statuses.length],
    earnedPoints: 1,
    maxPoints: 1,
    explanation: `Released explanation ${index}`,
    remediation: `Released next step ${index}`,
    ...overrides,
  };
}

const reviewItems = Array.from({ length: 90 }, (_, index) => standardItem(index + 1));
reviewItems[1] = standardItem(2, {
  questionType: 'matching-v1',
  presentation: {
    prompt: 'Match each released service.',
    sources: [{ id: 'source-private-a', text: 'Source A' }],
    targets: [{ id: 'target-private-a', text: 'Target A' }],
  },
  response: { answer: { 'source-private-a': 'target-private-a' } },
  correctAnswer: { correctPairs: { 'source-private-a': 'target-private-a' } },
});
reviewItems[2] = standardItem(3, {
  questionType: 'reorder',
  presentation: { stem: 'Order the released steps.', items: [{ id: 'step-private-a', text: 'First safe step' }, { id: 'step-private-b', text: 'Second safe step' }] },
  response: { answer: ['step-private-b', 'step-private-a'] },
  correctAnswer: { correctOrder: ['step-private-a', 'step-private-b'] },
});
reviewItems[3] = standardItem(4, {
  questionType: 'dropdown-code',
  presentation: { stem: 'Complete the released command.', blanks: [{ id: 'blank-private-a', label: 'Argument', options: ['--safe', '--review'] }] },
  response: { answer: { 'blank-private-a': '--safe' } },
  correctAnswer: { blanks: [{ correctAnswer: '--review' }] },
});
reviewItems[4] = standardItem(5, {
  questionType: 'true-false-composite-v1',
  presentation: { prompt: 'Evaluate the released statements.', statements: [{ id: 'statement-private-a', text: 'The statement is learner safe.' }] },
  response: { answer: { 'statement-private-a': true } },
  correctAnswer: { correctAnswers: { 'statement-private-a': true } },
});
reviewItems[5] = standardItem(6, {
  questionType: 'pbq-config-panel',
  presentation: {
    stem: 'Review the released Security+ configuration.',
    tasks: { configurationTargets: [{ id: 'security-private-server', label: 'Server A', options: [{ id: 'security-private-allow', label: 'Allow HTTPS' }, { id: 'security-private-deny', label: 'Deny traffic' }] }] },
  },
  response: { selectedAnswers: { 'security-private-server': 'security-private-deny' } },
  correctAnswer: { expectedMap: { 'security-private-server': 'security-private-allow' }, requiredCommandIds: [] },
});
reviewItems[6] = standardItem(7, {
  questionType: 'pbq-config-panel',
  presentation: {
    stem: 'Review the released AZ-400 workspace decision.',
    tasks: { interactionStyle: 'workspace', workspace: { tabs: [{ id: 'tab-private', title: 'Deployment', decisions: [{ id: 'environment-private', prompt: 'Deployment environment', options: [{ id: 'production-private', label: 'Production' }, { id: 'staging-private', label: 'Staging' }] }] }] } },
  },
  response: { selectedAnswers: { 'environment-private': 'staging-private' } },
  correctAnswer: { expectedMap: { 'environment-private': 'production-private' }, requiredCommandIds: [] },
});
reviewItems[7] = {
  itemId: 'python-private-item',
  questionNumber: 8,
  questionType: 'executable-python-lab-v1',
  status: 'Correct',
  earnedPoints: 4,
  maxPoints: 5,
};
reviewItems[8] = standardItem(9, {
  questionType: 'pbq-config-panel',
  presentation: { stem: 'Malformed released answer fixture.', tasks: { configurationTargets: [{ id: 'known-private-target', label: 'Server A', options: [{ id: 'known-private-option', label: 'Production' }] }] } },
  response: { selectedAnswers: { 'known-private-target': 'unknown-private-option' } },
  correctAnswer: { displayUnavailable: true },
  status: 'Unanswered',
});
reviewItems[9] = {
  itemId: 'context-private-item',
  questionId: 'context-private-question',
  questionNumber: null,
  questionType: 'case-study-context',
  presentation: { heading: 'Released case-study context', description: 'Use this released context for the following questions.' },
  status: 'Informational',
};
reviewItems[10] = standardItem(11, { status: 'Server reviewed' });

const review = { items: reviewItems };
window.issue118Fixture = { getReviewAttemptIds: [], mutations: 0 };

function SavedResultHarness() {
  const [backCount, setBackCount] = useState(0);
  const client = {
    getPrintableSummary: async () => ({
      attemptId: exactAttemptId,
      exam: { key: 'security-plus-sy0-701' },
      profile: { name: 'Released review fixture' },
      purpose: 'self_directed_exam',
      source: 'protected',
      percentage: 80,
      passed: true,
      completedAt: '2026-09-18T10:00:00.000Z',
      reviewStatus: mode === 'saved-withheld' ? 'withheld' : 'released',
    }),
    getReview: async (attemptId) => {
      window.issue118Fixture.getReviewAttemptIds.push(attemptId);
      if (mode === 'saved-error') {
        const error = new Error('private provider failure detail');
        error.code = 'provider_failure';
        throw error;
      }
      return { review };
    },
  };
  return (
    <main>
      <ProtectedResultDetail attemptId={exactAttemptId} client={client} onBack={() => setBackCount((value) => value + 1)} />
      <output data-testid="back-count">{backCount}</output>
    </main>
  );
}

function Harness() {
  const [returned, setReturned] = useState(0);
  if (mode.startsWith('saved-')) return <SavedResultHarness />;
  return <main><ReleasedReviewWorkspace review={review} onReturn={() => setReturned((value) => value + 1)} /><output data-testid="return-count">{returned}</output></main>;
}

createRoot(document.getElementById('root')).render(<Harness />);
