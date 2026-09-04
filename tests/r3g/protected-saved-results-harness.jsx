import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import ProtectedSavedResultsPage from '../../src/protected/ProtectedSavedResultsPage.jsx';
import '../../src/styles/global.css';

function Harness() {
  const [started, setStarted] = useState(null);
  return <main><ProtectedSavedResultsPage session={{ access_token: 'fixture-token' }} openWeakAreaPractice onStartWeakAreaPractice={setStarted} />{started ? <output data-testid="started">{JSON.stringify(started)}</output> : null}</main>;
}
createRoot(document.getElementById('root')).render(<Harness />);
