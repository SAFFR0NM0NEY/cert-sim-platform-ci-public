import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import useResultStorage from './useResultStorage.js';
import { createSubmittedResultStoragePayload } from '../lib/resultStorageMappers.js';
import {
  createResultSaveFingerprint,
  getResultSaveEligibility,
} from '../lib/resultSaveEligibility.js';

const SAVED_RESULT_SESSION_PREFIX = 'certsim.savedResult.v1';

export default function useAutoSaveResult(result) {
  const {
    error,
    getExamCatalogEntry,
    isAuthenticated,
    isSupabaseConfigured,
    loading,
    storageLoading,
    submitAttemptStorage,
    user,
  } = useResultStorage();
  const eligibility = useMemo(() => getResultSaveEligibility(result), [result]);
  const fingerprint = useMemo(
    () => createResultSaveFingerprint(result, user?.id ?? ''),
    [result, user?.id],
  );
  const [saveState, setSaveState] = useState({
    autoSaveStatus: 'idle',
    savedAttemptId: '',
    errorMessage: '',
  });
  const autoStartedFingerprintRef = useRef('');
  const saveInFlightRef = useRef(false);
  const examKey = useMemo(() => getExamKey(result), [result]);

  const saveResult = useCallback(
    async (trigger = 'auto') => {
      if (!eligibility.eligible) {
        setSaveState({
          autoSaveStatus: 'ineligible',
          savedAttemptId: '',
          errorMessage: eligibility.message,
        });
        return {
          ok: false,
          reason: eligibility.reason,
          message: eligibility.message,
        };
      }

      if (!isSupabaseConfigured) {
        setSaveState({
          autoSaveStatus: 'frontend-only',
          savedAttemptId: '',
          errorMessage: '',
        });
        return {
          ok: false,
          reason: 'supabase_not_configured',
          message: 'Online result storage is not configured for this environment yet.',
        };
      }

      if (loading && !storageLoading) {
        return {
          ok: false,
          reason: 'auth_loading',
          message: 'Checking account status.',
        };
      }

      if (!isAuthenticated) {
        setSaveState({
          autoSaveStatus: 'signed-out',
          savedAttemptId: '',
          errorMessage: '',
        });
        return {
          ok: false,
          reason: 'not_signed_in',
          message: 'Sign in before using online result storage.',
        };
      }

      const existingSessionRecord = readSavedResultSession(fingerprint);

      if (existingSessionRecord) {
        setSaveState({
          autoSaveStatus: 'saved',
          savedAttemptId: existingSessionRecord.savedAttemptId,
          errorMessage: '',
        });
        return {
          ok: true,
          data: {
            attempt: {
              id: existingSessionRecord.savedAttemptId,
            },
          },
        };
      }

      if (saveInFlightRef.current) {
        return {
          ok: false,
          reason: 'save_in_progress',
          message: 'Result save is already in progress.',
        };
      }

      saveInFlightRef.current = true;
      setSaveState({
        autoSaveStatus: 'saving',
        savedAttemptId: '',
        errorMessage: '',
      });

      try {
        const catalogResult = await getExamCatalogEntry(examKey);

        if (!catalogResult.ok) {
          setSaveState({
            autoSaveStatus: 'failed',
            savedAttemptId: '',
            errorMessage: catalogResult.message,
          });
          return catalogResult;
        }

        const storagePayload = createSubmittedResultStoragePayload(result, {
          examCatalogEntry: catalogResult.data,
          clientAppVersion: `autosave-${trigger}`,
        });
        const storageResult = await submitAttemptStorage(storagePayload);

        if (!storageResult.ok) {
          setSaveState({
            autoSaveStatus: 'failed',
            savedAttemptId: '',
            errorMessage: storageResult.message,
          });
          return storageResult;
        }

        const savedAttemptId = storageResult.data?.attempt?.id ?? '';

        writeSavedResultSession(fingerprint, savedAttemptId);
        setSaveState({
          autoSaveStatus: 'saved',
          savedAttemptId,
          errorMessage: '',
        });
        return storageResult;
      } catch {
        const message =
          'Result storage failed. Your local result is still available on this page.';

        setSaveState({
          autoSaveStatus: 'failed',
          savedAttemptId: '',
          errorMessage: message,
        });
        return {
          ok: false,
          reason: 'unexpected_save_error',
          message,
        };
      } finally {
        saveInFlightRef.current = false;
      }
    },
    [
      eligibility.eligible,
      eligibility.message,
      eligibility.reason,
      examKey,
      fingerprint,
      getExamCatalogEntry,
      isAuthenticated,
      isSupabaseConfigured,
      loading,
      result,
      storageLoading,
      submitAttemptStorage,
    ],
  );

  useEffect(() => {
    if (!eligibility.eligible) {
      setSaveState({
        autoSaveStatus: 'ineligible',
        savedAttemptId: '',
        errorMessage: eligibility.message,
      });
      return;
    }

    if (!isSupabaseConfigured) {
      setSaveState({
        autoSaveStatus: 'frontend-only',
        savedAttemptId: '',
        errorMessage: '',
      });
      return;
    }

    if (loading && !storageLoading) {
      return;
    }

    if (!isAuthenticated) {
      setSaveState({
        autoSaveStatus: 'signed-out',
        savedAttemptId: '',
        errorMessage: '',
      });
      return;
    }

    const existingSessionRecord = readSavedResultSession(fingerprint);

    if (existingSessionRecord) {
      setSaveState({
        autoSaveStatus: 'saved',
        savedAttemptId: existingSessionRecord.savedAttemptId,
        errorMessage: '',
      });
      return;
    }

    if (autoStartedFingerprintRef.current === fingerprint) {
      return;
    }

    autoStartedFingerprintRef.current = fingerprint;
    saveResult('auto');
  }, [
    eligibility.eligible,
    eligibility.message,
    fingerprint,
    isAuthenticated,
    isSupabaseConfigured,
    loading,
    saveResult,
    storageLoading,
  ]);

  const retrySave = useCallback(() => saveResult('manual-retry'), [saveResult]);
  const hasSaved = saveState.autoSaveStatus === 'saved';

  return {
    autoSaveEnabled: eligibility.eligible && isSupabaseConfigured && isAuthenticated,
    autoSaveStatus: saveState.autoSaveStatus,
    savedAttemptId: saveState.savedAttemptId,
    errorMessage: saveState.errorMessage || error,
    retrySave,
    hasSaved,
    eligibility,
    fingerprint,
    isAuthenticated,
    isSupabaseConfigured,
    loading,
    storageLoading,
  };
}

function getExamKey(result) {
  const exam = result?.exam ?? {};

  return (
    exam.examKey ??
    exam.registryId ??
    exam.slug ??
    exam.id ??
    result?.examKey ??
    ''
  );
}

function readSavedResultSession(fingerprint) {
  if (!fingerprint || typeof window === 'undefined' || !window.sessionStorage) {
    return null;
  }

  try {
    const text = window.sessionStorage.getItem(getSessionStorageKey(fingerprint));

    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

function writeSavedResultSession(fingerprint, savedAttemptId) {
  if (!fingerprint || typeof window === 'undefined' || !window.sessionStorage) {
    return;
  }

  try {
    window.sessionStorage.setItem(
      getSessionStorageKey(fingerprint),
      JSON.stringify({
        savedAttemptId,
        savedAt: new Date().toISOString(),
      }),
    );
  } catch {
    // Session duplicate prevention is best-effort; the in-page guard still applies.
  }
}

function getSessionStorageKey(fingerprint) {
  return `${SAVED_RESULT_SESSION_PREFIX}:${fingerprint}`;
}
