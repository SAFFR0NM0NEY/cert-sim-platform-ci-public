import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ProtectedExamRunner from '../../src/components/exam/ProtectedExamRunner.jsx';
import ProtectedSavedResultsPage from '../../src/protected/ProtectedSavedResultsPage.jsx';
import { inf303ExamDefinition } from '../../src/exams/examRegistry.protected.js';
import '../../src/styles/global.css';
const profile = { id: 'inf303-standard', name: 'Synthetic variable Standard', totalScoredQuestions: 5,
  standardQuestionCount: 5, timeLimitMinutes: 45, caseStudyCount: 0, caseStudyQuestionCount: 0, pbqCount: 0 };
const exam = { ...inf303ExamDefinition, title: 'Synthetic variable Python', strictBetaProfiles: [profile] };
function Harness() {
  const [session, setSession] = useState(null), [view, setView] = useState('runner'), [instance, setInstance] = useState(0);
  const [attemptId, setAttemptId] = useState('');
  const [profileKey, setProfileKey] = useState('inf303-standard');
  const [purpose, setPurpose] = useState('self_directed_exam');
  const selectedProfile = useMemo(() => profileKey === 'inf303-standard' ? profile : { ...profile, id: profileKey, totalScoredQuestions:2, standardQuestionCount:2, timeLimitMinutes:60 }, [profileKey]);
  const selectedExam = useMemo(() => profileKey === 'inf303-standard' ? exam : { ...exam, strictBetaProfiles: [selectedProfile] }, [profileKey, selectedProfile]);
  useEffect(() => {
    window.__mountCombinedFixture = (next, key = 'inf303-standard', nextPurpose = 'self_directed_exam') => { setSession(next); setProfileKey(key); setPurpose(nextPurpose); setView('runner'); setInstance(n => n+1); };
    return () => { delete window.__mountCombinedFixture; };
  }, []);
  if (!session) return <h1>Synthetic variable form acceptance</h1>;
  if (view === 'home') return <main><h1>Synthetic dashboard</h1><button onClick={() => { setAttemptId(''); setView('history'); }}>Saved Results</button><button onClick={() => { setInstance(n => n+1); setView('runner'); }}>Open exam</button></main>;
  if (view === 'history') return <ProtectedSavedResultsPage session={session} attemptId={attemptId} onOpenDetail={setAttemptId} onReturnToList={() => setAttemptId('')} onReturnHome={() => setView('home')} onOpenAccount={() => setView('home')} />;
  return <ProtectedExamRunner key={instance} examConfig={selectedExam} profile={selectedProfile} session={session}
    practiceRequest={{ purpose, includePbqs: true, mixStrategy: 'balanced' }}
    selectedMode={exam.strictBetaMode} student={{ name: 'Synthetic learner' }} onExit={() => setView('home')} />;
}
createRoot(document.getElementById('root')).render(<Harness />);
