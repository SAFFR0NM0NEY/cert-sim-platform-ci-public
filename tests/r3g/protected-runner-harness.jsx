import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ProtectedExamRunner from '../../src/components/exam/ProtectedExamRunner.jsx';
import { az204ExamDefinition, az400ExamDefinition } from '../../src/exams/examRegistry.protected.js';
import '../../src/styles/global.css';

function Harness() {
  const [open, setOpen] = useState(true);
  const [language, setLanguage] = useState(
    new URLSearchParams(window.location.search).get('language') ?? 'csharp',
  );
  const az204 = new URLSearchParams(window.location.search).get('exam') === 'az204';
  const assignmentId = new URLSearchParams(window.location.search).get('assignment') ?? '';
  const exam = az204 ? az204ExamDefinition : az400ExamDefinition;
  const profile = exam.strictBetaProfiles.find((entry) => entry.id === (az204 ? 'standard-profile' : 'az400-sectioned-full-exam-profile'));
  const request = { purpose: 'self_directed_exam', count: az204 ? 50 : 80, includePbqs: true, mixStrategy: 'balanced', ...(az204 ? { language } : {}) };
  return <>{open ? <ProtectedExamRunner assignmentId={assignmentId} codingLanguagePreference={az204 ? language : null} examConfig={exam} onCodingLanguagePreferenceChange={setLanguage} onExit={() => setOpen(false)} practiceRequest={assignmentId ? null : request} profile={profile} selectedMode={exam.strictBetaMode} session={{ access_token: 'fixture-token' }} student={{ name: 'Fixture learner' }} /> : <main><h1>Selected exam dashboard</h1><button onClick={() => setOpen(true)}>Return to protected attempt</button></main>}</>;
}
createRoot(document.getElementById('root')).render(<Harness />);
