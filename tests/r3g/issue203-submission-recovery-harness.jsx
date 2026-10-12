import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ProtectedExamRunner from '../../src/components/exam/ProtectedExamRunner.jsx';
import { pythonNextGenerationExamDefinition } from '../../src/exams/examRegistry.protected.js';
import '../../src/styles/global.css';

const fixtureUserId = '20300000-0000-4000-8000-000000000001';

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const requestedProfile = params.get('profile') === 'no-lab'
    ? 'pythonnextgeneration-no-lab'
    : 'pythonnextgeneration-lab';
  const profile = pythonNextGenerationExamDefinition.strictBetaProfiles
    .find((entry) => entry.id === requestedProfile);
  const [open, setOpen] = useState(true);
  const [instance, setInstance] = useState(0);
  const [accessToken, setAccessToken] = useState('issue203-fixture-token');
  const [userId, setUserId] = useState(fixtureUserId);
  const [practiceRevision, setPracticeRevision] = useState(0);
  const navigationGuard = useRef(null);

  useEffect(() => {
    window.__issue203FixtureUserId = fixtureUserId;
    window.__setIssue203AccessToken = setAccessToken;
    window.__setIssue203UserId = setUserId;
    window.__reinitializeIssue203Attempt = () => setPracticeRevision((value) => value + 1);
    window.__unmountIssue203Runner = () => setOpen(false);
    window.__remountIssue203Runner = () => {
      setInstance((value) => value + 1);
      setOpen(true);
    };
    window.__requestIssue203Navigation = async () => {
      const allowed = await navigationGuard.current?.();
      if (allowed) setOpen(false);
      return allowed === true;
    };
    return () => {
      delete window.__issue203FixtureUserId;
      delete window.__setIssue203AccessToken;
      delete window.__setIssue203UserId;
      delete window.__reinitializeIssue203Attempt;
      delete window.__unmountIssue203Runner;
      delete window.__remountIssue203Runner;
      delete window.__requestIssue203Navigation;
    };
  }, []);

  if (!open) {
    return <main><h1>Issue 203 fixture dashboard</h1></main>;
  }

  return <ProtectedExamRunner
    key={`${requestedProfile}:${instance}`}
    examConfig={pythonNextGenerationExamDefinition}
    onExit={() => setOpen(false)}
    onRegisterNavigationGuard={(guard) => { navigationGuard.current = guard; }}
    practiceRequest={{
      purpose: 'self_directed_exam',
      count: profile.totalScoredQuestions + practiceRevision,
      includePbqs: true,
      mixStrategy: 'balanced',
    }}
    profile={profile}
    selectedMode={pythonNextGenerationExamDefinition.strictBetaMode}
    session={{ access_token: accessToken, user: { id: userId } }}
    student={{ name: 'Synthetic learner' }}
  />;
}

createRoot(document.getElementById('root')).render(<Harness />);
