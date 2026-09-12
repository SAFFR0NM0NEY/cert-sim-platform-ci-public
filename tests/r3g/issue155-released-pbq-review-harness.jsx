import React from 'react';
import { createRoot } from 'react-dom/client';
import ReleasedReviewAnswer from '../../src/components/exam/ReleasedReviewAnswer.jsx';

const mode = new URLSearchParams(window.location.search).get('mode') ?? 'security';
const fixtures = {
  security: {
    questionType: 'pbq-config-panel',
    presentation: {
      tasks: {
        configurationTargets: [
          { id: 'security-server', label: 'Server A', options: [{ id: 'security-allow', label: 'Allow HTTPS' }, { id: 'security-deny', label: 'Deny traffic' }] },
        ],
      },
    },
    response: { selectedAnswers: { 'security-server': 'security-deny' } },
    correct: { expectedMap: { 'security-server': 'security-allow' }, requiredCommandIds: [] },
  },
  az400: {
    questionType: 'pbq-config-panel',
    presentation: {
      tasks: {
        interactionStyle: 'workspace',
        workspace: {
          tabs: [{
            id: 'workspace-tab',
            title: 'Deployment',
            decisions: [{ id: 'workspace-environment', prompt: 'Deployment environment', options: [{ id: 'workspace-production', label: 'Production' }, { id: 'workspace-staging', label: 'Staging' }] }],
          }],
        },
      },
    },
    response: { selectedAnswers: { 'workspace-environment': 'workspace-staging' } },
    correct: { expectedMap: { 'workspace-environment': 'workspace-production' }, requiredCommandIds: [] },
  },
  malformed: {
    questionType: 'pbq-config-panel',
    presentation: { tasks: { configurationTargets: [{ id: 'target-a', label: 'Server A', options: [{ id: 'safe-a', label: 'Production' }] }] } },
    response: { selectedAnswers: { 'target-a': 'private-option-id' } },
    correct: { strategy: 'future-private-strategy', expectedMap: { 'target-a': 'safe-a' } },
  },
  empty: {
    questionType: 'pbq-hotspot',
    presentation: { tasks: { evidenceItems: [{ id: 'evidence-a', label: 'Server A alert' }], selectionOptions: [{ id: 'select-a', label: 'Escalate' }] } },
    response: {},
    correct: {},
  },
  wholeState: {
    questionType: 'pbq-config-panel',
    presentation: { stem: 'Validate the released configuration state.' },
    response: { displayUnavailable: true },
    correct: { displayUnavailable: true },
  },
};

function Harness() {
  const fixture = fixtures[mode];
  return (
    <main>
      <h1>Released PBQ review</h1>
      <dl>
        <div><dt>Your response</dt><dd><ReleasedReviewAnswer presentation={fixture.presentation} questionType={fixture.questionType} value={fixture.response} /></dd></div>
        <div><dt>Correct answer</dt><dd><ReleasedReviewAnswer correct presentation={fixture.presentation} questionType={fixture.questionType} value={fixture.correct} /></dd></div>
      </dl>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Harness />);
