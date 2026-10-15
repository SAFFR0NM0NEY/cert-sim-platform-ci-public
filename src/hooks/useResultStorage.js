import { useCallback, useState } from 'react';

import useAuthSession from './useAuthSession.js';
import {
  createExamAttempt,
  createQuestionReport,
  getExamCatalogEntry,
  saveExamReport,
  saveExamResponses,
  saveExamResult,
  submitAttemptStorage,
} from '../lib/resultStorageService.js';

export default function useResultStorage() {
  const authSession = useAuthSession();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const runStorageAction = useCallback(async (action, ...args) => {
    setLoading(true);
    setError('');
    const result = await action(...args);

    if (!result.ok) {
      setError(result.message);
    }

    setLoading(false);
    return result;
  }, []);
  const getExamCatalogEntryAction = useCallback(
    (...args) => runStorageAction(getExamCatalogEntry, ...args),
    [runStorageAction],
  );
  const createExamAttemptAction = useCallback(
    (...args) => runStorageAction(createExamAttempt, ...args),
    [runStorageAction],
  );
  const saveExamResponsesAction = useCallback(
    (...args) => runStorageAction(saveExamResponses, ...args),
    [runStorageAction],
  );
  const saveExamResultAction = useCallback(
    (...args) => runStorageAction(saveExamResult, ...args),
    [runStorageAction],
  );
  const saveExamReportAction = useCallback(
    (...args) => runStorageAction(saveExamReport, ...args),
    [runStorageAction],
  );
  const submitAttemptStorageAction = useCallback(
    (...args) => runStorageAction(submitAttemptStorage, ...args),
    [runStorageAction],
  );
  const createQuestionReportAction = useCallback(
    (...args) => runStorageAction(createQuestionReport, ...args),
    [runStorageAction],
  );

  return {
    ...authSession,
    loading: authSession.loading || loading,
    storageLoading: loading,
    error,
    getExamCatalogEntry: getExamCatalogEntryAction,
    createExamAttempt: createExamAttemptAction,
    saveExamResponses: saveExamResponsesAction,
    saveExamResult: saveExamResultAction,
    saveExamReport: saveExamReportAction,
    submitAttemptStorage: submitAttemptStorageAction,
    createQuestionReport: createQuestionReportAction,
  };
}
