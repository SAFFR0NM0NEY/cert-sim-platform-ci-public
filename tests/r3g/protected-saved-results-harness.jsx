import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ProtectedSavedResultsPage from '../../src/protected/ProtectedSavedResultsPage.jsx';
import '../../src/styles/global.css';

function Harness() {
  const [started, setStarted] = useState(null);
  const params = new URLSearchParams(window.location.search);
  const [language, setLanguage] = useState(params.get('language') ?? 'csharp');
  const attemptId = params.get('attemptId') ?? '';
  return <main><ProtectedSavedResultsPage attemptId={attemptId} codingLanguagePreference={language} onCodingLanguagePreferenceChange={setLanguage} session={{ access_token: 'fixture-token' }} openWeakAreaPractice onReturnToList={() => {}} onStartWeakAreaPractice={setStarted} /><output data-testid="language-preference">{language}</output>{started ? <output data-testid="started">{JSON.stringify(started)}</output> : null}</main>;
}
createRoot(document.getElementById('root')).render(<Harness />);
