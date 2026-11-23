import { useEffect, useState } from 'react';

import useAuthSession from '../hooks/useAuthSession.js';
import { signInWithEmailPassword } from '../lib/authService.js';
import {
  signOutMaintenanceSession,
  verifyMaintenancePlatformOwnerAccess,
} from '../lib/maintenanceAccessService.js';

const maintenanceMessage =
  'CertSim is currently undergoing scheduled maintenance while we upgrade protected exam delivery. Please do not begin or continue an exam until service is restored. Trainers and administrators will be informed when normal access resumes.';

export default function MaintenanceApp() {
  const auth = useAuthSession();
  const [showOwnerAccess, setShowOwnerAccess] = useState(false);
  const [credentials, setCredentials] = useState({ email: '', password: '' });
  const [accessState, setAccessState] = useState('blocked');
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    async function verifyAccess() {
      if (auth.loading) return;
      if (!auth.isAuthenticated) {
        if (active) setAccessState('blocked');
        return;
      }
      setAccessState('verifying');
      const result = await verifyMaintenancePlatformOwnerAccess();
      if (!active) return;
      setAccessState(result.ok ? 'owner' : 'denied');
      setMessage(result.ok ? '' : 'This signed-in account does not have Platform Owner maintenance access.');
    }
    verifyAccess();
    return () => { active = false; };
  }, [auth.isAuthenticated, auth.loading, auth.user?.id]);

  if (accessState === 'owner') {
    return (
      <main className="maintenance-page" data-maintenance-boundary="owner-safe-shell">
        <section className="maintenance-card maintenance-owner-shell" aria-labelledby="maintenance-owner-heading">
          <Brand />
          <p className="maintenance-eyebrow">Platform Owner maintenance access</p>
          <h1 id="maintenance-owner-heading">Maintenance-safe shell</h1>
          <p>Authoritative Platform Owner membership verified.</p>
          <p className="maintenance-notice">Exam delivery remains unavailable. No exam, practice, assignment, or learner lifecycle action can be started from this shell.</p>
          <button className="maintenance-button" type="button" onClick={handleSignOut}>Sign out</button>
          {message && <p className="maintenance-error" role="alert">{message}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="maintenance-page" data-maintenance-boundary="public">
      <section className="maintenance-card" aria-labelledby="maintenance-heading">
        <Brand />
        <p className="maintenance-eyebrow">Scheduled maintenance</p>
        <h1 id="maintenance-heading">CertSim is temporarily unavailable</h1>
        <p className="maintenance-copy">{maintenanceMessage}</p>

        {!showOwnerAccess && !auth.isAuthenticated && (
          <button className="maintenance-button" type="button" onClick={() => setShowOwnerAccess(true)}>
            Platform Owner Access
          </button>
        )}

        {(showOwnerAccess || auth.isAuthenticated) && (
          <div className="maintenance-access-panel" aria-live="polite">
            {auth.loading || accessState === 'verifying' ? (
              <p>Verifying maintenance access…</p>
            ) : auth.isAuthenticated ? (
              <>
                <p className="maintenance-error" role="alert">{message || 'Maintenance access could not be verified.'}</p>
                <button className="maintenance-button secondary" type="button" onClick={handleSignOut}>Sign out</button>
              </>
            ) : (
              <form onSubmit={handleSignIn}>
                <h2>Platform Owner Access</h2>
                <p>Sign in normally. Access is granted only after authoritative active Platform Owner membership verification.</p>
                <label>Email<input type="email" autoComplete="email" required value={credentials.email} onChange={(event) => updateCredential('email', event.target.value)} /></label>
                <label>Password<input type="password" autoComplete="current-password" required value={credentials.password} onChange={(event) => updateCredential('password', event.target.value)} /></label>
                {message && <p className="maintenance-error" role="alert">{message}</p>}
                <button className="maintenance-button" type="submit" disabled={submitting}>{submitting ? 'Signing in…' : 'Sign in for Platform Owner Access'}</button>
              </form>
            )}
          </div>
        )}
      </section>
    </main>
  );

  function updateCredential(field, value) {
    setCredentials((current) => ({ ...current, [field]: value }));
  }

  async function handleSignIn(event) {
    event.preventDefault();
    setSubmitting(true);
    setMessage('');
    const result = await signInWithEmailPassword(credentials.email.trim(), credentials.password);
    setCredentials((current) => ({ ...current, password: '' }));
    setSubmitting(false);
    if (result.error) setMessage('Sign-in failed. Check the credentials and try again.');
  }

  async function handleSignOut() {
    setMessage('');
    const result = await signOutMaintenanceSession();
    if (!result.ok) {
      setMessage('Sign-out could not be confirmed. Maintenance access remains blocked.');
      setAccessState('blocked');
      return;
    }
    setAccessState('blocked');
    setShowOwnerAccess(false);
    setCredentials({ email: '', password: '' });
  }
}

function Brand() {
  return <img className="maintenance-logo" src="/brand/certsim-platform-wordmark-dark-display.png" alt="CertSim Platform" />;
}
