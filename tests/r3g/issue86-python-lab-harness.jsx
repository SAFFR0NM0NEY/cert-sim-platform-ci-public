import React from 'react';
import { createRoot } from 'react-dom/client';
import PythonLabWorkspace from '../../src/components/exam/PythonLabWorkspace.jsx';
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
    if (mode === 'resume') return workspaceRead(4, resumedWorkspace);
    if (mode === 'conflict' && reads > 1) return workspaceRead(7, serverConflictWorkspace);
    return workspaceRead(0, null);
  },
  async savePythonWorkspace(...args) {
    record('savePythonWorkspace', args.slice(0, 5));
    saves += 1;
    if (mode === 'conflict' && saves === 1) {
      throw Object.assign(new Error('A newer workspace revision is saved.'), { code: 'revision_conflict' });
    }
    return {
      itemId,
      revision: Number(args[3]) + 1,
      workspaceHash,
      updatedAt: '2026-09-14T12:00:00Z',
    };
  },
  async requestPythonRun(...args) {
    record('requestPythonRun', args.slice(0, 4));
    if (mode === 'output') {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
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

createRoot(document.getElementById('root')).render(
  <main>
    <h1>Issue 86 Python lab</h1>
    <PythonLabWorkspace
      attemptId={attemptId}
      client={client}
      itemId={itemId}
      presentation={presentation}
    />
  </main>,
);
