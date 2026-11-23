import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ProtectedExamRunner from '../../src/components/exam/ProtectedExamRunner.jsx';
import ProtectedSavedResultsPage from '../../src/protected/ProtectedSavedResultsPage.jsx';
import { examRegistry, pythonNextGenerationExamDefinition } from '../../src/exams/examRegistry.protected.js';
import '../../src/styles/global.css';

// Synthetic harness only. Credentials/configuration stay in this mounted
// component's memory, never URL/storage/analytics. Production never imports it.
function Harness() {
  const [config, setConfig] = useState(null);
  const [view, setView] = useState('runner');
  const [instance, setInstance] = useState(0);
  const [attemptId, setAttemptId] = useState('');
  const guard = useRef(null);
  useEffect(() => {
    window.__mountLearnerStatusFixture = (next) => { setConfig(next); setView(next.view ?? 'runner'); setAttemptId(''); setInstance((n) => n + 1); };
    window.__changeLearnerStatusConfig = (next) => setConfig((previous) => ({ ...previous, ...next }));
    window.__changeLearnerStatusSession = (session) => setConfig((previous) => ({ ...previous, session }));
    window.__leaveLearnerStatusFixture = async () => {
      const allowed = await guard.current?.();
      if (allowed !== false) setView('home');
      return allowed !== false;
    };
    return () => {
      delete window.__mountLearnerStatusFixture;
      delete window.__changeLearnerStatusSession;
      delete window.__changeLearnerStatusConfig;
      delete window.__leaveLearnerStatusFixture;
    };
  }, []);
  const exam = examRegistry.find((entry) => entry.id === config?.examId) ?? pythonNextGenerationExamDefinition;
  const profile = useMemo(() => {
    const profileId = config?.profileId ?? (config?.kind === 'lab' ? 'pythonnextgeneration-lab' : 'pythonnextgeneration-no-lab');
    const selected = exam.strictBetaProfiles.find((p) => p.id === profileId) ?? exam.strictBetaProfiles[0];
    return { ...selected, totalScoredQuestions: config?.count ?? (config?.kind === 'lab' ? 9 : 2), timeLimitMinutes: 1,
      standardQuestionCount: config?.count ?? (config?.kind === 'lab' ? 9 : 2), caseStudyQuestionCount: 0, caseStudyCount: 0, pbqCount: 0 };
  }, [exam, config?.profileId, config?.kind, config?.count]);
  if (!config) return <main><h1>Synthetic learner acceptance</h1></main>;
  if (view === 'home') return <main><h1>Exam dashboard</h1><button onClick={() => { setAttemptId(''); setView('history'); }}>Open Saved Results</button><button onClick={() => { setInstance((n) => n + 1); setView('runner'); }}>Open exam</button></main>;
  if (view === 'history') return <ProtectedSavedResultsPage
    key={'history|' + instance} attemptId={attemptId} session={config.session}
    onOpenDetail={setAttemptId} onReturnToList={() => setAttemptId('')}
    onReturnHome={() => setView('home')} onOpenAccount={() => setView('home')} />;
  return <ProtectedExamRunner key={'runner|' + instance}
    examConfig={exam} profile={profile}
    practiceRequest={{ purpose: config.purpose ?? 'self_directed_exam', count: profile.totalScoredQuestions, includePbqs: true, mixStrategy: 'balanced',
      ...(config.assignmentId ? { assignmentId: config.assignmentId } : {}), ...(config.language ? { language: config.language } : {}) }}
    selectedMode={exam.strictBetaMode}
    session={config.session} student={{ name: 'Synthetic learner' }}
    onExit={() => setView('home')} onRegisterNavigationGuard={(next) => { guard.current = next; }} />;
}
createRoot(document.getElementById('root')).render(<Harness />);
