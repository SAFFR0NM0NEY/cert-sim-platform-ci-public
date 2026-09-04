import { useState } from 'react';

import {
  requestPasswordReset,
  signInWithEmailPassword,
  signUpWithEmailPassword,
  updatePassword,
} from '../../lib/authService.js';
import { updateOwnProfileDisplayName } from '../../lib/profileService.js';
import useCurrentIdentity from '../../hooks/useCurrentIdentity.js';

const initialFormState = {
  displayName: '',
  email: '',
  password: '',
  passwordConfirmation: '',
};

const schoolAccountDisclaimer =
  'School accounts should use your real name or a name your trainer can recognise.';

export default function AuthPanel({
  onAuthenticated,
  showSignedInMessage = true,
  title = 'Account',
} = {}) {
  const {
    user,
    loading,
    isAuthenticated,
    isSupabaseConfigured,
    authUnavailableReason,
    profile,
    refreshIdentity,
  } = useCurrentIdentity();
  const [mode, setMode] = useState(getInitialAuthMode);
  const [formState, setFormState] = useState(initialFormState);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [message, setMessage] = useState('');
  const [authActionError, setAuthActionError] = useState('');
  const isSignIn = mode === 'sign-in';
  const isSignUp = mode === 'sign-up';
  const isResetRequest = mode === 'reset-request';
  const isPasswordRecovery = mode === 'password-recovery';

  if (!isSupabaseConfigured) {
    return (
      <section className="auth-panel standalone" aria-label="Account status">
        <p className="auth-panel-title">Frontend-only mode</p>
        <p className="auth-panel-note">
          Account features are prepared for Supabase, but this environment is
          currently running without protected certification exam access.
        </p>
        {authUnavailableReason ? (
          <p className="auth-panel-muted">{authUnavailableReason}</p>
        ) : null}
      </section>
    );
  }

  if (loading && !isAuthenticated) {
    return (
      <section className="auth-panel standalone" aria-label="Account status">
        <p className="auth-panel-title">Account</p>
        <p className="auth-panel-note">Checking account session...</p>
      </section>
    );
  }

  if (isAuthenticated && showSignedInMessage && !isPasswordRecovery) {
    const displayName = profile?.display_name || profile?.full_name || '';

    return (
      <section className="auth-panel standalone" aria-label="Account status">
        <p className="auth-panel-title">Signed in</p>
        {displayName ? (
          <p className="auth-panel-name">{displayName}</p>
        ) : (
          <p className="auth-panel-muted">
            Add a display name on the Account page so trainers can recognise
            this account.
          </p>
        )}
        <p className="auth-panel-email">{user?.email ?? 'Signed-in account'}</p>
      </section>
    );
  }

  return (
    <section className="auth-panel standalone" aria-label="Account access">
      <div className="auth-panel-header">
        <div>
          <p className="auth-panel-title">
            {isPasswordRecovery
              ? 'Choose a new password'
              : isResetRequest
                ? 'Reset password'
                : title}
          </p>
          <p className="auth-panel-note">
            Sign in to access protected certification exams, saved results,
            progress, and Weak Area Practice.
          </p>
        </div>
        <button
          className="auth-panel-toggle"
          type="button"
          onClick={() => {
            setMode(isSignIn ? 'sign-up' : 'sign-in');
            setMessage('');
            setAuthActionError('');
          }}
        >
          {isSignIn ? 'Create account' : 'Sign in'}
        </button>
      </div>

      <form className="auth-panel-form" onSubmit={handleSubmit}>
        {isSignUp ? (
          <label>
            <span>Display name / username</span>
            <input
              type="text"
              value={formState.displayName}
              onChange={(event) =>
                updateFormState('displayName', event.target.value)
              }
              placeholder="Name your trainer can recognise"
              autoComplete="name"
              required
            />
          </label>
        ) : null}
        {isSignUp ? (
          <p className="auth-panel-note">
            {schoolAccountDisclaimer} Individual accounts may use a username.
          </p>
        ) : null}
        {!isPasswordRecovery && (
          <label>
            <span>Email</span>
            <input
              type="email"
              value={formState.email}
              onChange={(event) => updateFormState('email', event.target.value)}
              placeholder="name@example.com"
              autoComplete="email"
              required
            />
          </label>
        )}
        {!isResetRequest && (
          <label>
            <span>{isPasswordRecovery ? 'New password' : 'Password'}</span>
            <input
              type="password"
              value={formState.password}
              onChange={(event) => updateFormState('password', event.target.value)}
              placeholder={isPasswordRecovery ? 'New password' : 'Password'}
              autoComplete={isSignIn ? 'current-password' : 'new-password'}
              minLength={6}
              required
            />
          </label>
        )}
        {isPasswordRecovery && (
          <label>
            <span>Confirm new password</span>
            <input
              type="password"
              value={formState.passwordConfirmation}
              onChange={(event) => updateFormState('passwordConfirmation', event.target.value)}
              placeholder="Confirm new password"
              autoComplete="new-password"
              minLength={6}
              required
            />
          </label>
        )}
        {isSignIn && (
          <button
            className="auth-panel-forgot-button"
            type="button"
            onClick={() => changeMode('reset-request')}
          >
            Forgot password?
          </button>
        )}
        {(isResetRequest || isPasswordRecovery) && (
          <p className="auth-panel-note">
            {isResetRequest
              ? 'Enter your email and we will send password reset instructions.'
              : 'Choose a new password for your account.'}
          </p>
        )}
        {message ? <p className="auth-panel-success">{message}</p> : null}
        {authActionError ? (
          <p className="auth-panel-error">{authActionError}</p>
        ) : null}
        <button
          className="primary-button auth-panel-button"
          type="submit"
          disabled={isSubmitting}
        >
          {isSubmitting
            ? 'Working...'
            : isSignIn
              ? 'Sign in'
              : isSignUp
                ? 'Create account'
                : isResetRequest
                  ? 'Send reset email'
                  : 'Update password'}
        </button>
        {(isResetRequest || isPasswordRecovery) && (
          <button
            className="auth-panel-forgot-button"
            type="button"
            onClick={() => changeMode('sign-in')}
          >
            Back to sign in
          </button>
        )}
      </form>
    </section>
  );

  function updateFormState(field, value) {
    setFormState((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function changeMode(nextMode) {
    setMode(nextMode);
    setMessage('');
    setAuthActionError('');
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage('');
    setAuthActionError('');

    const normalizedDisplayName = formState.displayName.trim();

    if (isPasswordRecovery && formState.password !== formState.passwordConfirmation) {
      setAuthActionError('The new passwords do not match.');
      setIsSubmitting(false);
      return;
    }

    const authResult = isSignIn
      ? await signInWithEmailPassword(formState.email.trim(), formState.password)
      : isSignUp
        ? await signUpWithEmailPassword(
            formState.email.trim(),
            formState.password,
            normalizedDisplayName,
          )
        : isResetRequest
          ? await requestPasswordReset(formState.email.trim())
          : await updatePassword(formState.password);

    if (authResult.error) {
      setAuthActionError(authResult.error.message);
      setIsSubmitting(false);
      return;
    }

    if (isSignUp && normalizedDisplayName && authResult.data?.session) {
      await updateOwnProfileDisplayName({
        displayName: normalizedDisplayName,
        fullName: normalizedDisplayName,
      });
    }

    if (isResetRequest) {
      setMessage('If an account matches that email, reset instructions will be sent. Check your inbox and spam folder.');
      setIsSubmitting(false);
      return;
    }

    await refreshIdentity?.();
    setFormState(initialFormState);
    setMessage(
      isSignIn
        ? 'Signed in successfully.'
        : isSignUp
          ? 'Account created. Check email confirmation settings if required.'
          : 'Password updated successfully.',
    );
    if (isPasswordRecovery) {
      window.history.replaceState({}, '', '/account');
    }
    setIsSubmitting(false);
    onAuthenticated?.();
  }
}

function getInitialAuthMode() {
  if (typeof window === 'undefined') {
    return 'sign-in';
  }

  return new URLSearchParams(window.location.search).get('password_reset') === '1'
    ? 'password-recovery'
    : 'sign-in';
}
