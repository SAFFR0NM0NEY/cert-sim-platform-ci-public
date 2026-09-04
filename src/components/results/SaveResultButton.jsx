import { useMemo } from 'react';

import { getResultSaveEligibility } from '../../lib/resultSaveEligibility.js';

export default function SaveResultButton({ autoSave, result }) {
  const fallbackEligibility = useMemo(() => getResultSaveEligibility(result), [result]);
  const eligibility = autoSave?.eligibility ?? fallbackEligibility;
  const autoSaveStatus = autoSave?.autoSaveStatus ?? 'idle';
  const isSupabaseConfigured = autoSave?.isSupabaseConfigured ?? false;
  const isAuthenticated = autoSave?.isAuthenticated ?? false;
  const isLoading = autoSave?.loading ?? false;
  const isSaving = autoSaveStatus === 'saving' || Boolean(autoSave?.storageLoading);
  const isSaved = Boolean(autoSave?.hasSaved);
  const message = getStatusMessage(autoSaveStatus, autoSave?.errorMessage);
  const panelStatusClass = isSaved
    ? 'saved'
    : autoSaveStatus === 'failed'
      ? 'error'
      : autoSaveStatus;
  const messageStatusClass = isSaved
    ? 'saved'
    : autoSaveStatus === 'failed'
      ? 'error'
      : autoSaveStatus;

  if (!eligibility.eligible) {
    return null;
  }

  if (!isSupabaseConfigured) {
    return (
      <section className="save-result-panel unavailable" aria-label="Online result storage">
        <div>
          <h3>Save result to account</h3>
          <p>
            Account result storage is not configured in this environment yet.
            Your result, review, print, and PDF options still work locally.
          </p>
        </div>
      </section>
    );
  }

  if (isLoading && !isSaving) {
    return (
      <section className="save-result-panel" aria-label="Online result storage">
        <div>
          <h3>Save result to account</h3>
          <p>Checking account status...</p>
        </div>
      </section>
    );
  }

  if (!isAuthenticated) {
    return (
      <section className="save-result-panel signed-out" aria-label="Online result storage">
        <div>
          <h3>Save result to account</h3>
          <p>
            Sign in from the Account page to save this completed result online.
            Taking exams and viewing results does not require an account.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section
      className={`save-result-panel ${panelStatusClass}`}
      aria-label="Online result storage"
      aria-live="polite"
    >
      <div>
        <h3>Save result to account</h3>
        <p>
          Eligible signed-in exam results save automatically. If the automatic
          save fails, retry from here without retaking the exam.
        </p>
        {message && (
          <p className={`save-result-message ${messageStatusClass}`}>
            {message}
          </p>
        )}
        {autoSave?.savedAttemptId && (
          <p className="save-result-reference">
            Saved attempt ID: {autoSave.savedAttemptId}
          </p>
        )}
      </div>
      <button
        className="secondary-button"
        disabled={isSaving || isSaved || !autoSave?.retrySave}
        type="button"
        onClick={autoSave?.retrySave}
      >
        {isSaved
          ? 'Result saved'
          : isSaving
            ? 'Saving result...'
            : autoSaveStatus === 'failed'
              ? 'Retry save to my account'
              : 'Save result to my account'}
      </button>
    </section>
  );
}

function getStatusMessage(status, errorMessage) {
  if (status === 'saving') {
    return 'Saving result to your account...';
  }

  if (status === 'saved') {
    return 'Result saved to your account.';
  }

  if (status === 'failed') {
    return errorMessage || 'Automatic save failed. You can retry manually.';
  }

  return 'Result is ready for account saving.';
}
