import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ExamWorkspacePresentation from '../../src/components/exam/ExamWorkspacePresentation.jsx';
import PythonLabWorkspace from '../../src/components/exam/PythonLabWorkspace.jsx';
import ReleasedExecutablePythonReview from '../../src/components/exam/ReleasedExecutablePythonReview.jsx';
import '../../src/styles/global.css';

const attemptId = '86000000-0000-4000-8000-000000000201';
const itemId = '86000000-0000-4000-8000-000000000202';
const workspaceHash = 'b'.repeat(64);
const starterWorkspace = {
  entryPoint: 'main.py',
  files: [
    { path: 'main.py', content: 'print("starter")\n' },
    { path: 'support/helper.py', content: 'VALUE = 1\n' },
  ],
};
const resumedWorkspace = {
  entryPoint: 'main.py',
  files: [
    { path: 'main.py', content: 'print("restored")\n' },
    { path: 'support/helper.py', content: 'VALUE = 4\n' },
  ],
};
const serverConflictWorkspace = {
  entryPoint: 'main.py',
  files: [
    { path: 'main.py', content: 'print("server")\n' },
    { path: 'support/helper.py', content: 'VALUE = 7\n' },
  ],
};

const mode = new URLSearchParams(window.location.search).get('mode') ?? 'starter';
const rendersPublishedShape = ['real-shape', 'real-shape-resume', 'real-shape-run-restore'].includes(mode);
const rendersReview = mode === 'review';
const persistedWorkspaceKey = `issue86:${attemptId}:${itemId}`;
const persistedRunKey = `${persistedWorkspaceKey}:latest-run`;
const calls = [];
let reads = 0;
let saves = 0;
window.__issue86PythonLabCalls = calls;

function record(method, args) {
  calls.push({ method, args: structuredClone(args) });
}

const client = {
  async getPythonWorkspace(...args) {
    record('getPythonWorkspace', args.slice(0, 2));
    reads += 1;
    if (mode === 'real-shape-resume' || mode === 'real-shape-run-restore') {
      const persisted = window.localStorage.getItem(persistedWorkspaceKey);
      if (persisted) {
        const parsed = JSON.parse(persisted);
        return workspaceRead(parsed.revision, parsed.workspace);
      }
    }
    if (mode === 'resume') return workspaceRead(4, resumedWorkspace);
    if (mode === 'conflict' && reads > 1) return workspaceRead(7, serverConflictWorkspace);
    return workspaceRead(0, null);
  },
  async getLatestPythonRun(...args) {
    record('getLatestPythonRun', args.slice(0, 2));
    const persistedWorkspace = window.localStorage.getItem(persistedWorkspaceKey);
    const revision = persistedWorkspace ? JSON.parse(persistedWorkspace).revision : 4;
    if (mode === 'real-shape-run-restore') {
      const persistedRun = window.localStorage.getItem(persistedRunKey);
      if (persistedRun) {
        const parsed = JSON.parse(persistedRun);
        return { itemId, workspaceRevision: revision, run: parsed.revision === revision ? parsed.run : null };
      }
    }
    return { itemId, workspaceRevision: revision, run: null };
  },
  async savePythonWorkspace(...args) {
    record('savePythonWorkspace', args.slice(0, 5));
    saves += 1;
    if (mode === 'conflict' && saves === 1) {
      throw Object.assign(new Error('A newer workspace revision is saved.'), { code: 'revision_conflict' });
    }
    const saved = {
      itemId,
      revision: Number(args[3]) + 1,
      workspaceHash,
      updatedAt: '2026-09-14T12:00:00Z',
    };
    if (mode === 'real-shape-resume' || mode === 'real-shape-run-restore') {
      window.localStorage.setItem(persistedWorkspaceKey, JSON.stringify({
        revision: saved.revision,
        workspace: args[2],
      }));
    }
    return saved;
  },
  async requestPythonRun(...args) {
    record('requestPythonRun', args.slice(0, 4));
    if (mode === 'output' || mode === 'real-shape-run-restore') {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const run = {
        runId: '86000000-0000-4000-8000-000000000203',
        state: 'failed',
        terminalOutcome: 'failed',
        stdout: 'learner stdout\n',
        stderr: 'learner stderr\n',
        exitCode: 2,
        cancellationRequestedAt: null,
        disposalState: 'confirmed',
        createdAt: '2026-09-15T12:00:00Z',
        updatedAt: '2026-09-15T12:00:01Z',
      };
      if (mode === 'real-shape-run-restore') {
        window.localStorage.setItem(persistedRunKey, JSON.stringify({ revision: args[2], run }));
      }
      return run;
    }
    throw Object.assign(new Error('Python execution is not available yet.'), {
      code: 'executor_disabled',
      httpStatus: 503,
    });
  },
  async getPythonRun(...args) {
    record('getPythonRun', args.slice(0, 3));
    throw new Error('Unexpected status call in browser fixture.');
  },
  async cancelPythonRun(...args) {
    record('cancelPythonRun', args.slice(0, 4));
    throw new Error('Unexpected cancel call in browser fixture.');
  },
};

const presentation = {
  interactionVersion: 'executable-python-lab-v1',
  task: 'Complete the browser-fixture Python task.',
  instructions: ['Edit a learner-visible file.', 'Save before requesting a run.'],
  starterWorkspace,
  allowedFilenames: ['main.py', 'support/helper.py'],
};
const publishedPresentation = {
  coverageTags: ['synthetic-python', 'executable-python-lab-v1'],
  difficulty: 'medium',
  editableFiles: ['main.py'],
  instructions: 'Implement the learner-visible synthetic requirement and save your work.',
  interactionVersion: 'executable-python-lab-v1',
  language: 'python',
  officialObjectiveKey: 'synthetic-objective',
  officialSkillGroup: 'executable-python-lab-v1',
  starterCode: 'def synthetic_function():\n    return None\n',
};

function workspaceRead(revision, workspace) {
  return {
    itemId,
    exists: Boolean(workspace),
    revision,
    workspaceHash: workspace ? workspaceHash : null,
    workspace,
    updatedAt: workspace ? '2026-09-14T12:00:00Z' : null,
  };
}

function FormalLabHarness() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const questions = [
    {
      id: '86000000-0000-4000-8000-000000000204',
      questionNumber: 1,
      type: 'single-choice',
      stem: 'Select the synthetic placeholder.',
      options: [{ id: 'a', text: 'Synthetic option' }],
    },
    {
      id: itemId,
      questionNumber: 2,
      type: 'executable-python-lab-v1',
      ...publishedPresentation,
    },
  ];
  const exam = {
    code: 'Python Next Generation',
    deliveryMode: 'protected',
    durationMinutes: 50,
    name: 'Python Next Generation',
    profile: { name: 'Lab', timeLimitMinutes: 50, totalScoredQuestions: 31 },
    mode: { name: 'Formal Lab' },
  };
  return <ExamWorkspacePresentation
    actionControls={<div className="exam-actions"><button type="button">Save response</button></div>}
    answers={{}}
    caseStudyBlocks={[]}
    currentIndex={currentIndex}
    currentSection="normal"
    exam={exam}
    exitDescription="The same formal attempt remains available for resume."
    exitLabel="Save & exit"
    flaggedQuestionIds={[]}
    fullscreenSupported={false}
    isFullscreen={false}
    isQuestionMapOpen={false}
    isSectionedExam={false}
    navigatorQuestions={questions}
    normalQuestions={questions}
    onAnswerChange={() => {}}
    onCloseQuestionMap={() => {}}
    onExit={() => {}}
    onNavigate={setCurrentIndex}
    onOpenQuestionMap={() => {}}
    onToggleFullscreen={() => {}}
    overlays={null}
    pbqQuestions={[]}
    progressLabel={`Question ${currentIndex + 1} of ${questions.length}`}
    pythonLab={{ attemptId, client }}
    questionStateById={{}}
    scoredAnswerSummary="0 answered"
    timed={false}
  />;
}

function ReleasedReviewHarness() {
  const statuses = [
    ['Correct', 5, 5],
    ['Partial', 3, 5],
    ['Incorrect', 0, 5],
    ['Unanswered', 0, 5],
  ];
  return (
    <main>
      <h1>Released executable review</h1>
      {statuses.map(([status, earnedPoints, maxPoints], index) => (
        <ReleasedExecutablePythonReview
          item={{
            itemId: `safe-item-${index}`,
            questionNumber: index + 1,
            questionType: 'executable-python-lab-v1',
            status,
            earnedPoints,
            maxPoints,
          }}
          key={status}
        />
      ))}
    </main>
  );
}

createRoot(document.getElementById('root')).render(rendersReview
  ? <ReleasedReviewHarness />
  : rendersPublishedShape
  ? <FormalLabHarness />
  : <main>
      <h1>Issue 86 Python lab</h1>
      <PythonLabWorkspace
        attemptId={attemptId}
        client={client}
        itemId={itemId}
        presentation={presentation}
      />
    </main>);
