import { useEffect, useRef, useState } from 'react';
import { createProtectedExamClient } from '../../lib/protectedExamClient.js';
import { createProtectedAccessTokenProvider } from '../../lib/protectedAccessToken.js';
import { refreshCurrentSession } from '../../lib/authService.js';
import { PYTHON_CATALOGUE_PROFILES, activePythonAvailabilityRequest, projectActivePythonCatalogue } from '../../lib/activeExamCatalogue.js';
import { getProfilePresentation } from '../../lib/examProfilePresentation.js';

export default function ActivePythonCatalogue({ exam, session, onStart }) {
  const latest = useRef(session); latest.current = session;
  const owner = session?.user?.id ?? '';
  const [observed, setObserved] = useState(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    setObserved(null);
    if (!owner || !session?.access_token) return undefined;
    let active = true, controller;
    const client = createProtectedExamClient({ getAccessToken: createProtectedAccessTokenProvider({
      getCurrentAccessToken: () => latest.current?.access_token, refreshSession: refreshCurrentSession,
    }) });
    const read = async () => {
      controller?.abort(); controller = new AbortController(); const signal = controller.signal;
      setObserved(null);
      try {
        const responses = await Promise.all(PYTHON_CATALOGUE_PROFILES.map(profileId =>
          client.getPracticeAvailability(activePythonAvailabilityRequest(profileId), { signal })));
        if (active && !signal.aborted) setObserved({ owner, value: projectActivePythonCatalogue(responses) });
      } catch { if (active && !signal.aborted) setObserved(null); }
    };
    const focus = () => { if (document.visibilityState !== 'hidden') void read(); };
    void read(); window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => { active = false; controller?.abort(); window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus); };
  }, [owner, Boolean(session?.access_token), revision]);
  const catalogue = owner && session?.access_token && observed?.owner === owner ? observed.value : null;
  return <section className="exam-card" aria-label="Timed exam attempts">
    <p className="eyebrow">Timed attempts</p><h3>Timed Attempts</h3>
    <p aria-live="polite">{catalogue ? `Current server configuration: ${catalogue.packageVersion}.`
      : 'The server confirms the current package, question counts and timer during setup.'}</p>
    <button className="secondary-button" onClick={() => setRevision(value => value + 1)}>Refresh configuration</button>
    <div className="exam-mode-grid dashboard-mode-grid">
      {PYTHON_CATALOGUE_PROFILES.map((profileKey, index) => {
        const profile = catalogue?.profiles[index];
        const name = getProfilePresentation({ examKey: 'inf303', profileKey }).name;
        return <article className="exam-mode-card" key={profileKey}>
          <h4>{name}</h4><p>{index === 0 ? 'A complete timed examination simulation.' : 'A shorter timed examination simulation.'}</p>
          <dl className="exam-stats compact"><div><dt>Scored items</dt><dd>{profile?.countLabel ?? 'Confirmed during setup'}</dd></div>
            <div><dt>Timer</dt><dd>{profile ? `${profile.minutes} minutes` : 'Confirmed during setup'}</dd></div></dl>
          <button className="primary-button" onClick={() => onStart?.(exam.id, profileKey)}>Start {name}</button>
        </article>;
      })}
    </div>
  </section>;
}
