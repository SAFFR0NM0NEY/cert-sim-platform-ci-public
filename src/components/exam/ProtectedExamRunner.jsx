import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ExamWorkspacePresentation from './ExamWorkspacePresentation.jsx';
import ProtectedFinalSubmitReview from './ProtectedFinalSubmitReview.jsx';
import StudentDetails from './StudentDetails.jsx';
import {
  deserializeProtectedResponse,
  getProtectedExamKey,
  getProtectedProfileKey,
  requireProtectedAuthoritativeResult,
  serializeProtectedResponse,
  toPresentationQuestion,
} from '../../lib/protectedExamContract.js';
import {
  createProtectedExamClient,
  isRetrySafeResultLookupError,
  isRetrySafeSubmissionError,
  submitProtectedAttemptWithRecovery,
} from '../../lib/protectedExamClient.js';
import { createProtectedAccessTokenProvider } from '../../lib/protectedAccessToken.js';
import { refreshCurrentSession } from '../../lib/authService.js';
import { getServerRemainingSeconds } from '../../lib/protectedRunnerState.js';
import { assertProtectedAttemptInventory, getProtectedItemSection } from '../../lib/protectedAttemptInventory.js';
import useFullscreenMode from '../../utils/useFullscreenMode.js';
import { getNormalizedDomainItems } from '../../lib/resultStorageMappers.js';
import { resolvePracticeRequest } from '../../lib/protectedPracticeRequest.js';
import ReleasedReviewWorkspace from './ReleasedReviewWorkspace.jsx';
import { downloadProtectedResultSummaryPdf } from '../../lib/savedResultReportExport.js';
import { getStructuredResponseState } from '../../lib/structuredResponse.js';
import { getProtectedExitContract } from '../../lib/protectedLifecycle.js';
import { isExecutablePythonLab } from '../../lib/pythonLabWorkspace.js';

export default function ProtectedExamRunner({
  assignmentId = '',
  codingLanguagePreference,
  examConfig,
  onCodingLanguagePreferenceChange,
  onExit,
  onPracticeRequestChange,
  onRegisterNavigationGuard,
  practiceRequest = null,
  profile,
  selectedMode,
  session,
  student,
}) {
  const examKey = getProtectedExamKey(examConfig?.id);
  const profileKey = getProtectedProfileKey(examConfig?.id, profile?.id);
  const { request: effectivePracticeRequest, error: practiceBindingError } = resolvePracticeRequest({
    assignmentId,
    practiceRequest: practiceRequest ?? {
      purpose: 'self_directed_exam',
      count: profile?.totalScoredQuestions,
      includePbqs: true,
      mixStrategy: 'balanced',
    },
  });
  const practiceInitializationKey = effectivePracticeRequest
    ? JSON.stringify(effectivePracticeRequest)
    : '';
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const authenticatedUserId = session?.user?.id ?? '';
  const client = useMemo(() => {
    if (!session?.access_token) return null;
    return createProtectedExamClient({
      getAccessToken: createProtectedAccessTokenProvider({
        getCurrentAccessToken: () => sessionRef.current?.access_token,
        refreshSession: refreshCurrentSession,
      }),
    });
  }, [Boolean(session?.access_token)]);
  const [state, setState] = useState('eligibility-loading');
  const [message, setMessage] = useState('Checking protected-exam eligibility...');
  const [attempt, setAttempt] = useState(null);
  const [items, setItems] = useState([]);
  const [itemPage, setItemPage] = useState({ returnedThrough: 0, totalCount: 0, hasMore: false });
  const [answers, setAnswers] = useState({});
  const [revisions, setRevisions] = useState({});
  const [dirtyIds, setDirtyIds] = useState(new Set());
  const [saveErrors, setSaveErrors] = useState({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [result, setResult] = useState(null);
  const [review, setReview] = useState(null);
  const [reviewMessage, setReviewMessage] = useState('');
  const [pdfState, setPdfState] = useState({ preparing: false, message: '', error: '' });
  const [availability, setAvailability] = useState(null);
  const [configuredLanguage, setConfiguredLanguage] = useState(
    examConfig?.id === 'az204' ? (practiceRequest?.language ?? codingLanguagePreference ?? 'csharp') : null,
  );
  const [activeAttemptConfiguration, setActiveAttemptConfiguration] = useState(null);
  const [resumeCandidates, setResumeCandidates] = useState([]);
  const [recoverableSandboxes, setRecoverableSandboxes] = useState([]);
  const [lifecycleOperation, setLifecycleOperation] = useState('');
  const [discardSummary, setDiscardSummary] = useState(null);
  const [discardError, setDiscardError] = useState('');
  const [discardOutcomeAmbiguous, setDiscardOutcomeAmbiguous] = useState(false);
  const [recoveryRetryAttemptId, setRecoveryRetryAttemptId] = useState('');
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [itemFeedback, setItemFeedback] = useState({});
  const [flaggedQuestionIds, setFlaggedQuestionIds] = useState([]);
  const [showFinalSubmitReview, setShowFinalSubmitReview] = useState(false);
  const [showQuestionMap, setShowQuestionMap] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueMessage, setIssueMessage] = useState('');
  const [issueStatus, setIssueStatus] = useState('');
  const [pythonLabBusy, setPythonLabBusy] = useState(false);
  const [pythonWorkspaceProgress, setPythonWorkspaceProgress] = useState({});
  const requestEpoch = useRef(0);
  const initializationEpoch = useRef(0);
  const configuredLanguageRef = useRef(configuredLanguage);
  const availabilityRef = useRef(null);
  const practiceRequestRef = useRef(effectivePracticeRequest);
  practiceRequestRef.current = effectivePracticeRequest;
  const submissionId = useRef('');
  const submissionBinding = useRef({ attemptId: '', userId: '', submissionId: '', dispatched: false, resolved: false, submitRetryAllowed: false });
  const submissionOperation = useRef({ controller: null, generation: 0 });
  const submissionPreparationGeneration = useRef(0);
  const attemptRef = useRef(attempt);
  attemptRef.current = attempt;
  const starting = useRef(false);
  const submitting = useRef(false);
  const loadingPage = useRef(false);
  const operationController = useRef(new AbortController());
  const navigationSave = useRef(null);
  const pythonWorkspaceSave = useRef(null);
  const lifecycleLock = useRef(false);
  const discardRequest = useRef({ attemptId: '', requestId: '' });
  const recoveryRequest = useRef({ attemptId: '', requestId: '' });
  const workspaceRef = useRef(null);
  const { fullscreenMessage, fullscreenSupported, isFullscreen, toggleFullscreen } = useFullscreenMode(workspaceRef);

  useEffect(() => {
    operationController.current = new AbortController();
    return () => {
      operationController.current.abort();
      submissionOperation.current.controller?.abort();
      submissionOperation.current.generation += 1;
    };
  }, []);

  useEffect(() => {
    const binding = submissionBinding.current;
    if (!binding.dispatched || binding.resolved) return;
    if (binding.userId === authenticatedUserId && binding.attemptId === attempt?.attemptId) return;
    submissionOperation.current.controller?.abort();
    submissionOperation.current.generation += 1;
    submissionPreparationGeneration.current += 1;
    submitting.current = false;
    if (binding.userId !== authenticatedUserId) {
      setState('session-expired');
      setMessage('The signed-in account changed while final submission was unresolved. Sign in with the original account before taking any further action.');
    } else {
      setState('safe-fatal-error');
      setMessage('The protected attempt changed while final submission was unresolved. Completion could not be confirmed safely.');
    }
  }, [attempt?.attemptId, authenticatedUserId]);

  const loadAttempt = useCallback((payload) => {
    resetSubmissionBinding();
    const nextItems = (payload?.items ?? []).map(toPresentationQuestion);
    const authoritativeComposition = normalizeProfileComposition(availabilityRef.current?.profileComposition);
    if (availabilityRef.current?.fixedProfileSize && authoritativeComposition) {
      assertProtectedAttemptInventory({
        ...profile,
        ...authoritativeComposition,
        totalScoredQuestions: availabilityRef.current.selectedCount,
      }, nextItems);
    }
    const rawItems = payload?.items ?? [];
    setAttempt(payload?.attempt ?? null);
    setItems(nextItems);
    setItemPage(payload?.page ?? { returnedThrough: nextItems.length, totalCount: nextItems.length, hasMore: false });
    setAnswers(Object.fromEntries(rawItems.map((item, index) => [
      item.itemId,
      deserializeProtectedResponse(nextItems[index], item.response),
    ]).filter(([, value]) => value !== undefined)));
    setRevisions(Object.fromEntries(rawItems.map((item) => [item.itemId, item.revision ?? 0])));
    setDirtyIds(new Set());
    setPythonWorkspaceProgress({});
    pythonWorkspaceSave.current = null;
    setRecoverableSandboxes([]);
    setRecoveryRetryAttemptId('');
    recoveryRequest.current = { attemptId: '', requestId: '' };
    setCurrentIndex(0);
    setRemainingSeconds(getServerRemainingSeconds(payload?.attempt));
    setState('active');
    setMessage('');
  }, [profile]);

  useEffect(() => {
    if (!client || !attempt?.attemptId) return;
    const controller = new AbortController();
    client.listFlags(attempt.attemptId, { signal: controller.signal })
      .then((payload) => setFlaggedQuestionIds(payload.itemIds ?? []))
      .catch((error) => { if (!controller.signal.aborted) setMessage(error.message); });
    return () => controller.abort();
  }, [attempt?.attemptId, client]);

  useEffect(() => {
    const controller = new AbortController();
    const epoch = ++initializationEpoch.current;
    const stale = () => controller.signal.aborted || epoch !== initializationEpoch.current;
    async function initialize() {
      if (!client || !examKey || !profileKey) {
        setState('safe-fatal-error');
        setMessage(!client ? 'Sign in again to use protected delivery.' : 'This exam profile is not available for protected delivery.');
        return;
      }
      try {
        if (practiceBindingError) throw practiceBindingError;
        if (practiceRequestRef.current) {
          const configuredRequest = buildPracticeRequest(practiceRequestRef.current, configuredLanguageRef.current, examKey);
          setRecoverableSandboxes([]);
          setState('resuming');
          setMessage('Looking for an existing protected practice attempt...');
          const reconciliation = await client.listCurrentAttemptBindings(
            examKey,
            configuredRequest.purpose,
            { signal: controller.signal },
          );
          if (stale()) return;
          const profileCandidates = (reconciliation.candidates ?? []).filter((candidate) => candidate.profileKey === profileKey);
          const candidates = profileCandidates.filter((candidate) => (
            configuredRequest.assignmentId
              ? candidate.assignmentId === configuredRequest.assignmentId
              : !candidate.assignmentId
          ));
          setResumeCandidates(candidates);
          const singleCandidateMatchesLanguage = candidates.length === 1 &&
            normalizeAttemptLanguage(candidates[0].languagePreference) === normalizeAttemptLanguage(configuredRequest.language);
          if (singleCandidateMatchesLanguage) {
            setRecoverableSandboxes([]);
            availabilityRef.current = candidates[0];
            setAvailability(candidates[0]);
            setActiveAttemptConfiguration(candidates[0]);
            setState('resuming');
            setMessage('Recovering your protected attempt...');
            let current;
            try {
              current = await readResumeCandidate(candidates[0], controller.signal);
            } catch (resumeError) {
              if (['attempt_not_found', 'attempt_expired'].includes(resumeError.code)) {
                setActiveAttemptConfiguration(null);
                setResumeCandidates([]);
                setState('eligibility-loading');
                setMessage('That attempt is no longer resumable. Refreshing available actions...');
                setRefreshNonce((value) => value + 1);
                return;
              }
              throw resumeError;
            }
            if (stale()) return;
            setResumeCandidates([]);
            loadAttempt(current);
          } else if (candidates.length === 1) {
            setRecoverableSandboxes([]);
            availabilityRef.current = candidates[0];
            setAvailability(candidates[0]);
            setActiveAttemptConfiguration(candidates[0]);
            setState('ready-active');
            setMessage('An unfinished attempt uses a different language. Resume it, or explicitly start a new attempt if permitted.');
          } else if (candidates.length > 1) {
            setRecoverableSandboxes([]);
            setActiveAttemptConfiguration(null);
            setState('resume-choice');
            setMessage('Choose the existing protected attempt you want to resume. No new attempt will be started.');
          } else if (profileCandidates.length > 0) {
            setRecoverableSandboxes([]);
            setResumeCandidates(profileCandidates);
            setActiveAttemptConfiguration(null);
            setState('resume-choice');
            setMessage('An unfinished timed attempt exists in a different assignment context. Resume or end it before starting this exam.');
          } else {
            const preview = await client.getPracticeAvailability({ examKey, profileId: profileKey, ...configuredRequest }, { signal: controller.signal });
            if (stale()) return;
            availabilityRef.current = preview;
            setAvailability(preview);
            setActiveAttemptConfiguration(null);
            const historical = configuredRequest.purpose === 'study_sandbox'
              ? await client.listRecoverableStudySandboxes(examKey, profileKey, { signal: controller.signal })
              : { candidates: [] };
            if (stale()) return;
            setRecoverableSandboxes(historical.candidates ?? []);
            setState('ready');
            setMessage((historical.candidates ?? []).length
              ? 'Choose a saved Study Sandbox to recover, or start new. No historical sandbox is changed by this screen.'
              : `Ready to start ${preview.selectedCount} protected practice items${preview.adjustedCount ? ' (adjusted to the available pool)' : ''}.`);
          }
          return;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setState(error.code === 'unauthenticated' ? 'session-expired' : 'safe-fatal-error');
        setMessage(error.message);
      }
    }
    initialize();
    return () => controller.abort();
  }, [client, examKey, loadAttempt, practiceBindingError, practiceInitializationKey, profileKey, refreshNonce]);

  async function readResumeCandidate(candidate, signal = operationController.current.signal) {
    const current = await client.resumeAttempt(candidate.attemptId, { signal });
    assertAttemptBinding(current.attempt, candidate);
    assertAttemptAssignment(current.attempt, candidate.assignmentId);
    if (current.attempt?.purpose !== candidate.purpose || current.attempt?.languagePreference !== candidate.languagePreference) {
      throw Object.assign(new Error('Protected attempt binding could not be verified.'), { code: 'binding_mismatch' });
    }
    return current;
  }

  async function resumeCandidate(candidate, signal = operationController.current.signal) {
    setState('resuming');
    setMessage('Resuming the selected protected attempt...');
    const current = await readResumeCandidate(candidate, signal);
    setResumeCandidates([]);
    setRecoverableSandboxes([]);
    loadAttempt(current);
  }

  async function chooseResumeCandidate(candidate) {
    if (lifecycleLock.current || starting.current) return;
    try {
      await resumeCandidate(candidate);
    } catch (error) {
      if (operationController.current.signal.aborted) return;
      if (['attempt_not_found', 'attempt_expired'].includes(error.code)) {
        setActiveAttemptConfiguration(null);
        setResumeCandidates([]);
        setState('eligibility-loading');
        setMessage('That attempt is no longer resumable. Refreshing available actions...');
        setRefreshNonce((value) => value + 1);
      } else {
        setState(error.code === 'unauthenticated' ? 'session-expired' : 'safe-fatal-error');
        setMessage(error.message);
      }
    }
  }

  async function recoverSavedSandbox(candidate) {
    if (lifecycleLock.current || starting.current) return;
    lifecycleLock.current = true;
    setLifecycleOperation('recovering');
    setMessage('Recovering the selected saved Study Sandbox...');
    if (recoveryRequest.current.attemptId !== candidate.attemptId || !recoveryRequest.current.requestId) {
      recoveryRequest.current = { attemptId: candidate.attemptId, requestId: crypto.randomUUID() };
    }
    let recoveryCommitted = false;
    try {
      const recovered = await client.recoverStudySandbox(
        candidate.attemptId,
        recoveryRequest.current.requestId,
        { signal: operationController.current.signal },
      );
      if (recovered.attemptId !== candidate.attemptId || recovered.status !== 'in_progress') {
        throw Object.assign(new Error('The recovered Study Sandbox identity could not be verified.'), { code: 'binding_mismatch' });
      }
      recoveryCommitted = true;
      availabilityRef.current = candidate;
      setAvailability(candidate);
      const current = await readResumeCandidate(candidate, operationController.current.signal);
      setResumeCandidates([]);
      setRecoverableSandboxes([]);
      setRecoveryRetryAttemptId('');
      recoveryRequest.current = { attemptId: '', requestId: '' };
      loadAttempt(current);
    } catch (error) {
      if (operationController.current.signal.aborted) return;
      if (isAmbiguousProtectedMutation(error)) {
        setRecoveryRetryAttemptId(candidate.attemptId);
        setState('ready');
        setMessage('The recovery outcome could not be confirmed. Retry recovery to reuse the same protected request.');
      } else if (recoveryCommitted || ['active_sandbox_exists', 'attempt_conflict'].includes(error.code)) {
        setRecoveryRetryAttemptId('');
        recoveryRequest.current = { attemptId: '', requestId: '' };
        setRecoverableSandboxes([]);
        setState('eligibility-loading');
        setMessage('Study Sandbox availability changed. Refreshing active attempts...');
        setRefreshNonce((value) => value + 1);
      } else {
        setRecoveryRetryAttemptId('');
        recoveryRequest.current = { attemptId: '', requestId: '' };
        if (['attempt_not_found', 'sandbox_discarded', 'sandbox_not_recoverable', 'practice_unavailable', 'invalid_lifecycle_transition'].includes(error.code)) {
          setRecoverableSandboxes((current) => current.filter((entry) => entry.attemptId !== candidate.attemptId));
        }
        setState(error.code === 'unauthenticated' ? 'session-expired' : 'ready');
        setMessage(error.message);
      }
    } finally {
      lifecycleLock.current = false;
      setLifecycleOperation('');
    }
  }

  async function startAttempt() {
    if (starting.current || lifecycleLock.current) return;
    starting.current = true;
    setState('starting');
    setMessage('Starting protected attempt...');
    try {
      const options = { signal: operationController.current.signal };
      if (effectivePracticeRequest) {
        const clientRequestId = crypto.randomUUID();
        try {
          const configuredRequest = buildPracticeRequest(effectivePracticeRequest, configuredLanguage, examKey);
          const started = await client.startPractice({ examKey, profileId: profileKey, ...configuredRequest, clientRequestId }, options);
          assertAttemptBinding(started.attempt, availability);
          assertAttemptAssignment(started.attempt, configuredRequest.assignmentId);
          if (started.attempt?.purpose !== effectivePracticeRequest.purpose) throw Object.assign(new Error('Protected practice purpose could not be verified.'), { code: 'binding_mismatch' });
          loadAttempt(started); return;
        } catch (error) {
          if (!isAmbiguousProtectedMutation(error)) throw error;
          const recovered = await client.getCurrentAttempt(examKey, profileKey, {
            purpose: configuredRequest.purpose,
            language: configuredRequest.language,
            ...(configuredRequest.assignmentId ? { assignmentId: configuredRequest.assignmentId } : {}),
          }, options);
          assertAttemptBinding(recovered.attempt, availability);
          assertAttemptAssignment(recovered.attempt, configuredRequest.assignmentId);
          if (recovered.attempt?.purpose !== effectivePracticeRequest.purpose) throw Object.assign(new Error('Protected practice recovery found a conflicting session.'), { code: 'start_state_conflict' });
          loadAttempt(recovered); return;
        }
      }
      throw Object.assign(new Error('Protected practice configuration was not available.'), { code: 'practice_unavailable' });
    } catch (error) {
      if (operationController.current.signal.aborted) return;
      if (effectivePracticeRequest?.purpose === 'study_sandbox' && ['active_sandbox_exists', 'attempt_conflict'].includes(error.code)) {
        setRecoverableSandboxes([]);
        setState('eligibility-loading');
        setMessage('An active Study Sandbox was found. Refreshing its protected binding...');
        setRefreshNonce((value) => value + 1);
      } else {
        setState(error.code === 'unauthenticated' ? 'session-expired' : 'safe-fatal-error');
        setMessage(error.message);
      }
    } finally {
      starting.current = false;
    }
  }

  async function startNewAttempt() {
    if (!activeAttemptConfiguration?.replacementPermitted || starting.current || lifecycleLock.current) return;
    const languageConfigured = examKey === 'az204';
    const confirmation = languageConfigured
      ? `Start a new attempt using ${formatReason(configuredLanguage)}? Your unfinished ${formatReason(activeAttemptConfiguration.languagePreference)} attempt will be discarded and retained only for audit.`
      : `Start a new ${activeAttemptConfiguration.profileName} attempt? Your unfinished ${activeAttemptConfiguration.profileName} attempt will be discarded and retained only for audit.`;
    if (!window.confirm(confirmation)) return;
    starting.current = true;
    setState('starting');
    setMessage('Replacing the unfinished attempt securely...');
    const clientRequestId = crypto.randomUUID();
    const configuredRequest = {
      examKey,
      profileId: profileKey,
      ...buildPracticeRequest(effectivePracticeRequest, configuredLanguage, examKey),
      clientRequestId,
    };
    try {
      try {
        const started = await client.replacePractice(configuredRequest, { signal: operationController.current.signal });
        assertAttemptBinding(started.attempt, availability);
        assertAttemptAssignment(started.attempt, configuredRequest.assignmentId);
        if ((started.attempt?.languagePreference ?? null) !== configuredLanguage) throw Object.assign(new Error('Protected attempt language could not be verified.'), { code: 'binding_mismatch' });
        initializationEpoch.current += 1;
        loadAttempt(started);
      } catch (error) {
        if (!isAmbiguousProtectedMutation(error)) throw error;
        const recovered = await client.getCurrentAttempt(examKey, profileKey, {
          purpose: configuredRequest.purpose,
          language: configuredRequest.language,
          ...(configuredRequest.assignmentId ? { assignmentId: configuredRequest.assignmentId } : {}),
        }, { signal: operationController.current.signal });
        assertAttemptBinding(recovered.attempt, availability);
        assertAttemptAssignment(recovered.attempt, configuredRequest.assignmentId);
        if ((recovered.attempt?.languagePreference ?? null) !== configuredLanguage) throw Object.assign(new Error('Protected replacement state could not be verified.'), { code: 'start_state_conflict' });
        initializationEpoch.current += 1;
        loadAttempt(recovered);
      }
    } catch (error) {
      if (operationController.current.signal.aborted) return;
      if (['attempt_conflict', 'attempt_not_found', 'attempt_expired'].includes(error.code)) {
        setActiveAttemptConfiguration(null);
        setResumeCandidates([]);
        setState('eligibility-loading');
        setMessage('Attempt availability changed. Refreshing available actions...');
        setRefreshNonce((value) => value + 1);
      } else {
        setState(error.code === 'unauthenticated' ? 'session-expired' : 'ready-active');
        setMessage(error.message);
      }
    } finally {
      starting.current = false;
    }
  }

  async function resumePendingAttempt() {
    if (!activeAttemptConfiguration) return;
    try {
      await resumeCandidate(activeAttemptConfiguration);
    } catch (error) {
      if (operationController.current.signal.aborted) return;
      if (error.code === 'attempt_not_found') {
        try {
          const configuredRequest = buildPracticeRequest(effectivePracticeRequest, configuredLanguage, examKey);
          const refreshedAvailability = await client.getPracticeAvailability(
            { examKey, profileId: profileKey, ...configuredRequest },
            { signal: operationController.current.signal },
          );
          availabilityRef.current = refreshedAvailability;
          setAvailability(refreshedAvailability);
          setActiveAttemptConfiguration(null);
          setState('ready');
          setMessage('The prior attempt is complete. You can start a new attempt.');
        } catch (reconciliationError) {
          if (operationController.current.signal.aborted) return;
          setState(reconciliationError.code === 'unauthenticated' ? 'session-expired' : 'safe-fatal-error');
          setMessage(reconciliationError.message);
        }
        return;
      }
      setState(error.code === 'unauthenticated' ? 'session-expired' : 'safe-fatal-error');
      setMessage(error.message);
    }
  }

  function changeConfiguredLanguage(nextLanguage) {
    configuredLanguageRef.current = nextLanguage;
    setConfiguredLanguage(nextLanguage);
    onCodingLanguagePreferenceChange?.(nextLanguage);
  }

  function changeAnswer(itemId, value) {
    if (lifecycleLock.current || discardSummary || submitting.current || hasUnresolvedSubmission()) return;
    setAnswers((current) => ({ ...current, [itemId]: value }));
    setDirtyIds((current) => new Set(current).add(itemId));
    setSaveErrors((current) => ({ ...current, [itemId]: '' }));
  }

  const registerPythonWorkspaceSave = useCallback((itemId, save) => {
    if (typeof save === 'function') {
      pythonWorkspaceSave.current = { itemId, save };
    } else if (pythonWorkspaceSave.current?.itemId === itemId) {
      pythonWorkspaceSave.current = null;
    }
  }, []);

  const updatePythonWorkspaceProgress = useCallback((itemId, progress) => {
    setPythonWorkspaceProgress((current) => {
      const previous = current[itemId];
      if (
        previous?.dirty === progress.dirty &&
        previous?.persisted === progress.persisted &&
        previous?.revision === progress.revision
      ) return current;
      return { ...current, [itemId]: progress };
    });
  }, []);

  async function saveItem(itemId, { submissionPreparation = false, preparationContext = null } = {}) {
    const question = items.find((item) => item.id === itemId);
    if (isExecutablePythonLab(question)) {
      const registered = pythonWorkspaceSave.current;
      if (registered?.itemId !== itemId) {
        setSaveErrors((current) => ({
          ...current,
          [itemId]: 'The Python workspace is not ready. Wait for it to finish loading and try again.',
        }));
        return false;
      }
      const saved = await registered.save({ signal: operationController.current.signal });
      if (preparationContext && !isCurrentSubmissionPreparation(preparationContext)) return false;
      if (saved) setSaveErrors((current) => ({ ...current, [itemId]: '' }));
      return saved;
    }
    if (!dirtyIds.has(itemId)) return true;
    const epoch = ++requestEpoch.current;
    setState('saving');
    try {
      const saved = await client.saveResponse(
        attempt.attemptId,
        itemId,
        serializeProtectedResponse(question, answers[itemId]),
        revisions[itemId] ?? 0,
        crypto.randomUUID(),
        { signal: operationController.current.signal },
      );
      if (preparationContext && !isCurrentSubmissionPreparation(preparationContext)) return false;
      if (epoch !== requestEpoch.current) return false;
      setRevisions((current) => ({ ...current, [itemId]: saved.revision }));
      setDirtyIds((current) => {
        const next = new Set(current);
        next.delete(itemId);
        return next;
      });
      if (!submissionPreparation) setState('active');
      return true;
    } catch (error) {
      if (operationController.current.signal.aborted) return false;
      if (preparationContext && !isCurrentSubmissionPreparation(preparationContext)) return false;
      if (epoch !== requestEpoch.current) return false;
      setState(error.code === 'unauthenticated' ? 'session-expired' : 'save-failed');
      setSaveErrors((current) => ({ ...current, [itemId]: error.message }));
      return false;
    }
  }

  async function navigate(nextIndex) {
    if (lifecycleLock.current || discardSummary || submitting.current || hasUnresolvedSubmission()) return;
    if (!(await saveItem(items[currentIndex].id))) return;
    if (nextIndex >= items.length && itemPage.hasMore) {
      if (loadingPage.current) return;
      loadingPage.current = true;
      setState('saving');
      try {
        const payload = await client.getAttemptItemPage(attempt.attemptId, itemPage.returnedThrough, 20, {
          signal: operationController.current.signal,
        });
        const rawItems = payload.items ?? [];
        const nextItems = rawItems.map(toPresentationQuestion);
        if (!nextItems.length || payload.afterPosition !== itemPage.returnedThrough) {
          throw Object.assign(new Error('The next protected practice page was not valid.'), { code: 'binding_mismatch' });
        }
        setItems((currentItems) => [...currentItems, ...nextItems]);
        setAnswers((currentAnswers) => ({ ...currentAnswers, ...Object.fromEntries(rawItems.map((item, index) => [
          item.itemId, deserializeProtectedResponse(nextItems[index], item.response),
        ]).filter(([, value]) => value !== undefined)) }));
        setRevisions((currentRevisions) => ({ ...currentRevisions, ...Object.fromEntries(rawItems.map((item) => [item.itemId, item.revision ?? 0])) }));
        setItemPage(payload);
        setCurrentIndex(items.length);
        setState('active');
      } catch (error) {
        if (!operationController.current.signal.aborted) {
          setState(error.code === 'unauthenticated' ? 'session-expired' : 'save-failed');
          setMessage(error.message);
        }
      } finally {
        loadingPage.current = false;
      }
      return;
    }
    setCurrentIndex(Math.max(0, Math.min(nextIndex, items.length - 1)));
  }

  async function saveAndExit() {
    if (attempt?.purpose !== 'study_sandbox' || discardSummary || lifecycleLock.current || starting.current || submitting.current || hasUnresolvedSubmission()) return;
    lifecycleLock.current = true;
    setLifecycleOperation('save-exit');
    const currentItemId = items[currentIndex]?.id;
    try {
      if (currentItemId && !(await saveItem(currentItemId))) return;
      onExit?.();
    } finally {
      lifecycleLock.current = false;
      setLifecycleOperation('');
    }
  }

  async function prepareSandboxDiscard() {
    if (attempt?.purpose !== 'study_sandbox' || discardSummary || lifecycleLock.current || starting.current || submitting.current || hasUnresolvedSubmission()) return;
    lifecycleLock.current = true;
    setLifecycleOperation('discard-preflight');
    setDiscardError('');
    setDiscardOutcomeAmbiguous(false);
    const currentItemId = items[currentIndex]?.id;
    try {
      if (currentItemId && !(await saveItem(currentItemId))) return;
      const summary = await client.getAttemptLifecycleSummary(attempt.attemptId, {
        signal: operationController.current.signal,
      });
      if (summary.attemptId !== attempt.attemptId || summary.purpose !== 'study_sandbox' || summary.status !== 'in_progress') {
        throw Object.assign(new Error('The Study Sandbox lifecycle state could not be verified. Refresh before discarding.'), { code: 'binding_mismatch' });
      }
      setDiscardSummary(summary);
    } catch (error) {
      if (operationController.current.signal.aborted) return;
      setMessage(error.message);
      setState(error.code === 'unauthenticated' ? 'session-expired' : 'save-failed');
    } finally {
      lifecycleLock.current = false;
      setLifecycleOperation('');
    }
  }

  async function confirmSandboxDiscard() {
    if (!discardSummary || lifecycleLock.current || attempt?.purpose !== 'study_sandbox') return;
    lifecycleLock.current = true;
    setLifecycleOperation('discarding');
    setDiscardError('');
    setDiscardOutcomeAmbiguous(false);
    if (discardRequest.current.attemptId !== attempt.attemptId || !discardRequest.current.requestId) {
      discardRequest.current = { attemptId: attempt.attemptId, requestId: crypto.randomUUID() };
    }
    try {
      await client.abandonAttempt(attempt.attemptId, discardRequest.current.requestId, {
        signal: operationController.current.signal,
      });
      discardRequest.current = { attemptId: '', requestId: '' };
      setDiscardSummary(null);
      setDiscardOutcomeAmbiguous(false);
      onExit?.();
    } catch (error) {
      if (operationController.current.signal.aborted) return;
      if (isAmbiguousProtectedMutation(error)) {
        setDiscardOutcomeAmbiguous(true);
        setDiscardError('The discard outcome could not be confirmed. Retry discard to reuse the same protected request.');
      } else {
        discardRequest.current = { attemptId: '', requestId: '' };
        setDiscardSummary(null);
        setDiscardOutcomeAmbiguous(false);
        setMessage(error.message);
        setState(error.code === 'unauthenticated' ? 'session-expired' : 'save-failed');
      }
    } finally {
      lifecycleLock.current = false;
      setLifecycleOperation('');
    }
  }

  function cancelSandboxDiscard() {
    if (lifecycleLock.current || discardOutcomeAmbiguous) return;
    setDiscardSummary(null);
    setDiscardError('');
    setDiscardOutcomeAmbiguous(false);
  }

  async function terminalEndAndExit() {
    if (attempt?.purpose === 'study_sandbox' || lifecycleLock.current || starting.current || submitting.current || hasUnresolvedSubmission()) return;
    if (!window.confirm('End this attempt? It cannot be resumed. Your progress will be retained for audit, but no completed result will be created.')) return;
    lifecycleLock.current = true;
    setLifecycleOperation('ending');
    const currentItemId = items[currentIndex]?.id;
    try {
      if (currentItemId && !(await saveItem(currentItemId))) return;
      await client.abandonAttempt(attempt.attemptId, crypto.randomUUID(), {
        signal: operationController.current.signal,
      });
      onExit?.();
    } catch (error) {
      setMessage(error.message);
      setState(error.code === 'unauthenticated' ? 'session-expired' : 'save-failed');
    } finally {
      lifecycleLock.current = false;
      setLifecycleOperation('');
    }
  }

  function handleExit() {
    if (attempt?.purpose === 'study_sandbox') return saveAndExit();
    return terminalEndAndExit();
  }

  const saveCurrentResponseBeforeNavigation = useCallback(async () => {
    if (navigationSave.current) return navigationSave.current;
    if (state === 'saving' || state === 'submission-preparing' || state === 'submitting' || lifecycleLock.current || discardSummary || submitting.current || hasUnresolvedSubmission()) return false;
    navigationSave.current = (async () => {
      const currentItemId = items[currentIndex]?.id;
      return currentItemId ? saveItem(currentItemId) : true;
    })();
    try {
      return await navigationSave.current;
    } finally {
      navigationSave.current = null;
    }
  }, [answers, attempt?.attemptId, client, currentIndex, dirtyIds, discardSummary, items, revisions, state]);

  useEffect(() => {
    onRegisterNavigationGuard?.(saveCurrentResponseBeforeNavigation);
    return () => onRegisterNavigationGuard?.(null);
  }, [onRegisterNavigationGuard, saveCurrentResponseBeforeNavigation]);

  async function toggleFlag(itemId) {
    if (lifecycleLock.current || discardSummary || submitting.current || hasUnresolvedSubmission()) return;
    const flagged = !flaggedQuestionIds.includes(itemId);
    try {
      const payload = await client.setFlag(attempt.attemptId, itemId, flagged, crypto.randomUUID(), { signal: operationController.current.signal });
      setFlaggedQuestionIds((current) => payload.flagged ? [...new Set([...current, itemId])] : current.filter((id) => id !== itemId));
    } catch (error) {
      setSaveErrors((current) => ({ ...current, [itemId]: error.message }));
    }
  }

  async function submitIssue(event) {
    event.preventDefault();
    if (submitting.current || hasUnresolvedSubmission()) return;
    if (!issueMessage.trim()) { setIssueStatus('Describe the issue before sending it.'); return; }
    setIssueStatus('Sending issue report...');
    try {
      await client.reportQuestionIssue(attempt.attemptId, items[currentIndex].id, issueMessage.trim(), crypto.randomUUID(), { signal: operationController.current.signal });
      setIssueMessage(''); setIssueOpen(false); setIssueStatus('Issue report received.');
    } catch (error) { setIssueStatus(error.message); }
  }

  async function checkPracticeItem(itemId) {
    if (submitting.current || hasUnresolvedSubmission()) return;
    const expectedRevision = (revisions[itemId] ?? 0) + (dirtyIds.has(itemId) ? 1 : 0);
    if (!(await saveItem(itemId))) return;
    try {
      const feedback = await client.checkPracticeItem(attempt.attemptId, itemId, expectedRevision, crypto.randomUUID(), { signal: operationController.current.signal });
      setItemFeedback((current) => ({ ...current, [itemId]: feedback }));
      setState('active');
    } catch (error) {
      setSaveErrors((current) => ({ ...current, [itemId]: error.message }));
      setState(error.code === 'unauthenticated' ? 'session-expired' : 'save-failed');
    }
  }

  async function submitAttempt() {
    if (submitting.current || navigationSave.current || state === 'saving' || pythonLabBusy || hasUnresolvedSubmission()) return;
    const preparationContext = beginSubmissionPreparation();
    if (!preparationContext.userId) {
      setState('session-expired');
      setMessage('Your signed-in account could not be verified for final submission. Sign in again before continuing.');
      return;
    }
    submitting.current = true;
    setShowFinalSubmitReview(false);
    setState('submission-preparing');
    setMessage('Saving your latest work before final submission...');
    const currentItemId = items[currentIndex]?.id;
    if (isExecutablePythonLab(items[currentIndex]) && !(await saveItem(currentItemId, {
      submissionPreparation: true,
      preparationContext,
    }))) {
      submitting.current = false;
      if (isCurrentSubmissionPreparation(preparationContext)) setState('save-failed');
      else failClosedForSubmissionPreparation(preparationContext);
      return;
    }
    for (const itemId of [...dirtyIds]) {
      if (!(await saveItem(itemId, { submissionPreparation: true, preparationContext }))) {
        submitting.current = false;
        if (!isCurrentSubmissionPreparation(preparationContext)) {
          failClosedForSubmissionPreparation(preparationContext);
        }
        return;
      }
    }
    if (!isCurrentSubmissionPreparation(preparationContext)) {
      submitting.current = false;
      failClosedForSubmissionPreparation(preparationContext);
      return;
    }
    submissionId.current ||= crypto.randomUUID();
    const binding = {
      attemptId: preparationContext.attemptId,
      userId: preparationContext.userId,
      submissionId: submissionId.current,
      dispatched: true,
      resolved: false,
      submitRetryAllowed: false,
    };
    submissionBinding.current = binding;
    setMessage('Final submission was sent. Completion is not yet confirmed.');
    await dispatchBoundSubmission(binding);
  }

  async function continueSubmission() {
    if (submitting.current) return;
    const binding = submissionBinding.current;
    if (!isCurrentSubmissionBinding(binding) || !binding.submitRetryAllowed) {
      failClosedForSubmissionIdentity(binding);
      return;
    }
    submitting.current = true;
    setMessage('Continuing the same final submission. Completion is not yet confirmed.');
    await dispatchBoundSubmission(binding);
  }

  async function checkSubmissionResult() {
    if (submitting.current) return;
    const binding = submissionBinding.current;
    if (!isCurrentSubmissionBinding(binding)) {
      failClosedForSubmissionIdentity(binding);
      return;
    }
    submitting.current = true;
    setState('submission-checking');
    setMessage('Checking for an authoritative result without submitting again...');
    const operation = beginSubmissionOperation(binding);
    try {
      const submitted = await client.getResult(binding.attemptId, { signal: operation.signal });
      if (!isCurrentSubmissionOperation(binding, operation)) return;
      completeSubmissionWithResult(binding, submitted.result);
    } catch (error) {
      if (!isCurrentSubmissionOperation(binding, operation)) return;
      if (error.code === 'attempt_not_found') {
        preserveUnconfirmedResultLookup(binding, 'No authoritative result is available yet. Completion is not confirmed.');
      } else if (isRetrySafeResultLookupError(error)) {
        preserveUnconfirmedResultLookup(binding, 'Completion could not be checked because the result service is temporarily unavailable.');
      } else {
        setState(error.code === 'unauthenticated' ? 'session-expired' : 'safe-fatal-error');
        setMessage(error.message);
      }
    } finally {
      finishSubmissionOperation(operation);
    }
  }

  async function dispatchBoundSubmission(binding) {
    if (!isCurrentSubmissionBinding(binding)) {
      failClosedForSubmissionIdentity(binding);
      return;
    }
    setState('submitting');
    const operation = beginSubmissionOperation(binding);
    try {
      const options = { signal: operation.signal };
      const { payload: submitted } = await submitProtectedAttemptWithRecovery(
        client,
        binding.attemptId,
        binding.submissionId,
        options,
      );
      if (!isCurrentSubmissionOperation(binding, operation)) return;
      const authoritativeResult = submitted.result ?? (await client.getResult(binding.attemptId, options)).result;
      if (!isCurrentSubmissionOperation(binding, operation)) return;
      completeSubmissionWithResult(binding, authoritativeResult);
    } catch (error) {
      if (!isCurrentSubmissionOperation(binding, operation)) return;
      if (isRetrySafeSubmissionError(error)) {
        binding.submitRetryAllowed = true;
        setState('submission-recoverable');
        setMessage(error.message);
      } else if (isRetrySafeResultLookupError(error)) {
        preserveUnconfirmedResultLookup(binding, 'Completion could not be checked because the result service is temporarily unavailable.');
      } else if (error.code === 'attempt_not_found') {
        preserveUnconfirmedResultLookup(binding, 'No authoritative result is available yet. Completion is not confirmed.');
      } else {
        setState(error.code === 'unauthenticated' ? 'session-expired' : 'safe-fatal-error');
        setMessage(error.message);
      }
    } finally {
      finishSubmissionOperation(operation);
    }
  }

  function beginSubmissionPreparation() {
    submissionPreparationGeneration.current += 1;
    return {
      attemptId: attempt?.attemptId ?? '',
      userId: getCurrentAuthenticatedUserId(),
      generation: submissionPreparationGeneration.current,
    };
  }

  function isCurrentSubmissionPreparation(context) {
    return !operationController.current.signal.aborted &&
      context.generation === submissionPreparationGeneration.current &&
      context.attemptId === attemptRef.current?.attemptId &&
      context.userId === getCurrentAuthenticatedUserId() &&
      !hasUnresolvedSubmission();
  }

  function beginSubmissionOperation(binding) {
    submissionOperation.current.controller?.abort();
    const controller = new AbortController();
    const generation = submissionOperation.current.generation + 1;
    submissionOperation.current = { controller, generation };
    return {
      controller,
      generation,
      signal: AbortSignal.any([operationController.current.signal, controller.signal]),
    };
  }

  function finishSubmissionOperation(operation) {
    if (operation.generation !== submissionOperation.current.generation) return;
    submissionOperation.current.controller = null;
    submitting.current = false;
  }

  function isCurrentSubmissionOperation(binding, operation) {
    return !operation.signal.aborted &&
      operation.generation === submissionOperation.current.generation &&
      isCurrentSubmissionBinding(binding);
  }

  function isCurrentSubmissionBinding(binding) {
    return binding === submissionBinding.current &&
      binding.dispatched &&
      !binding.resolved &&
      Boolean(binding.submissionId) &&
      binding.submissionId === submissionId.current &&
      binding.attemptId === attemptRef.current?.attemptId &&
      binding.userId === getCurrentAuthenticatedUserId();
  }

  function completeSubmissionWithResult(binding, candidateResult) {
    const authoritativeResult = requireProtectedAuthoritativeResult(candidateResult);
    if (authoritativeResult.attemptId !== binding.attemptId) {
      throw Object.assign(new Error('The protected result did not match this attempt.'), { code: 'binding_mismatch' });
    }
    binding.resolved = true;
    setResult(authoritativeResult);
    setMessage('');
    setState('result-available');
  }

  function preserveUnconfirmedResultLookup(binding, reason) {
    setState(binding.submitRetryAllowed ? 'submission-recoverable' : 'submission-result-check-recoverable');
    setMessage(binding.submitRetryAllowed
      ? `${reason} Continue the same submission or check the result again.`
      : `${reason} Keep this page open and check the result again.`);
  }

  function failClosedForSubmissionIdentity(binding) {
    submissionOperation.current.controller?.abort();
    submissionOperation.current.generation += 1;
    submitting.current = false;
    if (binding?.userId && binding.userId !== getCurrentAuthenticatedUserId()) {
      setState('session-expired');
      setMessage('The signed-in account changed while final submission was unresolved. Sign in with the original account before taking any further action.');
    } else {
      setState('safe-fatal-error');
      setMessage('The protected attempt or submission identity changed. Completion could not be confirmed safely.');
    }
  }

  function failClosedForSubmissionPreparation(context) {
    submissionPreparationGeneration.current += 1;
    submitting.current = false;
    if (context.userId !== getCurrentAuthenticatedUserId()) {
      setState('session-expired');
      setMessage('The signed-in account changed before final submission was sent. Sign in again before continuing.');
    } else {
      setState('safe-fatal-error');
      setMessage('The protected attempt changed before final submission was sent. No final submission request was dispatched.');
    }
  }

  function getCurrentAuthenticatedUserId() {
    return sessionRef.current?.user?.id ?? '';
  }

  function hasUnresolvedSubmission() {
    const binding = submissionBinding.current;
    return binding.dispatched && !binding.resolved;
  }

  function resetSubmissionBinding() {
    submissionOperation.current.controller?.abort();
    submissionOperation.current.generation += 1;
    submissionPreparationGeneration.current += 1;
    submissionId.current = '';
    submissionBinding.current = { attemptId: '', userId: '', submissionId: '', dispatched: false, resolved: false, submitRetryAllowed: false };
    submitting.current = false;
  }

  async function loadReview() {
    setReviewMessage('Loading released review...');
    try {
      const payload = await client.getReview(attempt.attemptId, {
        signal: operationController.current.signal,
      });
      setReview(payload.review);
      setReviewMessage('');
    } catch (error) {
      if (operationController.current.signal.aborted) return;
      setReviewMessage(error.code === 'review_unavailable'
        ? 'Question review and answers are withheld for this attempt.'
        : 'Released question review could not be loaded. Return to this result summary and try again.');
    }
  }

  async function downloadResultPdf() {
    setPdfState({ preparing: true, message: '', error: '' });
    try {
      const summary = await client.getPrintableSummary(attempt.attemptId, {
        signal: operationController.current.signal,
      });
      const { filename } = await downloadProtectedResultSummaryPdf(summary);
      setPdfState({ preparing: false, message: `Downloaded ${filename}.`, error: '' });
    } catch {
      setPdfState({ preparing: false, message: '', error: 'PDF download failed. Open this result in Saved Results and use Print as a fallback.' });
    }
  }

  if (state === 'result-available') {
    if (review) return <ReleasedReviewWorkspace review={review} onReturn={() => setReview(null)} />;
    const reviewWithheld = result?.reviewStatus === 'withheld';
    const reviewReleased = result?.reviewStatus === 'released';
    const domainRows = getNormalizedDomainItems(result?.domainBreakdown ?? {});
    const percentage = result?.rawPercentage == null ? null : Number(result.rawPercentage);
    return (
      <section className="exam-workspace protected-result" aria-labelledby="protected-result-heading">
        <p className="eyebrow">Server-authoritative result</p>
        <h2 id="protected-result-heading">{examConfig.shortName} protected attempt complete</h2>
        <p className="status-note" role="status">
          {result?.passed === true ? 'Passed' : result?.passed === false ? 'Not passed' : 'Completion recorded'}
        </p>
        <dl className="result-stats" aria-label="Attempt result summary">
          <div><dt>Percentage</dt><dd>{Number.isFinite(percentage) ? `${Math.round(percentage * 100) / 100}%` : 'Not recorded'}</dd></div>
          <div><dt>Scaled score</dt><dd>{result?.scaledScore ?? 'Not recorded'}</dd></div>
          <div><dt>Raw points</dt><dd>{result?.rawScore != null && result?.maxScore != null ? `${result.rawScore} / ${result.maxScore}` : 'Not recorded'}</dd></div>
          <div><dt>Answered</dt><dd>{result?.answeredCount != null && result?.questionCount != null ? `${result.answeredCount} / ${result.questionCount}` : 'Not recorded'}</dd></div>
          <div><dt>Pass mark</dt><dd>{result?.passMark ?? 'Not recorded'}</dd></div>
          <div><dt>Completed</dt><dd>{result?.completedAt ? new Date(result.completedAt).toLocaleString() : 'Recorded by server'}</dd></div>
        </dl>
        {domainRows.length > 0 && (
          <section className="selected-profile-panel" aria-labelledby="protected-domain-heading">
            <h3 id="protected-domain-heading">Performance by domain</h3>
            <div className="breakdown-list">
              {domainRows.map((domain) => (
                <div className="breakdown-row" key={domain.domainId}>
                  <span>{domain.domainLabel}</span>
                  <strong>{domain.percentage == null ? 'Not recorded' : `${Math.round(Number(domain.percentage) * 100) / 100}%`}</strong>
                </div>
              ))}
            </div>
          </section>
        )}
        <p>The completed attempt is available in your signed-in Saved Results history.</p>
        {pdfState.message ? <p className="status-note" role="status">{pdfState.message}</p> : null}
        {pdfState.error ? <p className="error-note" role="alert">{pdfState.error}</p> : null}
        {reviewWithheld && (
          <p className="status-note" role="status">
            Question review and answers are withheld for this attempt.
          </p>
        )}
        <div className="exam-actions">
          {reviewReleased && <button className="secondary-button" type="button" onClick={loadReview}>View released review</button>}
          <button className="secondary-button" disabled={pdfState.preparing} type="button" onClick={downloadResultPdf}>{pdfState.preparing ? 'Preparing PDF...' : 'Download PDF'}</button>
          <button className="primary-button" type="button" onClick={onExit}>Return home</button>
        </div>
        {reviewMessage && <p role="status">{reviewMessage}</p>}
      </section>
    );
  }

  if (['submitting', 'submission-recoverable', 'submission-result-check-recoverable', 'submission-checking'].includes(state) && hasUnresolvedSubmission()) {
    const operationActive = state === 'submitting' || state === 'submission-checking' || submitting.current;
    const submitRetryAllowed = submissionBinding.current.submitRetryAllowed;
    return (
      <section className="exam-workspace protected-status" aria-live="polite" aria-labelledby="protected-submission-heading">
        <p className="eyebrow">Protected final submission</p>
        <h2 id="protected-submission-heading">
          {['submission-recoverable', 'submission-result-check-recoverable'].includes(state) ? 'Final submission needs confirmation' : 'Final submission in progress'}
        </h2>
        <p>{message}</p>
        <p>Your answers and Python workspace are locked. Any available continuation uses the same attempt and submission identity without saving them again.</p>
        <p>Keep this page open. Leaving or reloading is not a supported recovery method.</p>
        <div className="exam-actions">
          {submitRetryAllowed && (
            <button className="primary-button" disabled={operationActive} type="button" onClick={continueSubmission}>
              {state === 'submitting' ? 'Continuing submission...' : 'Continue submission'}
            </button>
          )}
          <button className="secondary-button" disabled={operationActive} type="button" onClick={checkSubmissionResult}>
            {state === 'submission-checking' ? 'Checking result...' : 'Check result'}
          </button>
        </div>
      </section>
    );
  }

  if (!['active', 'saving', 'save-failed', 'submission-preparing'].includes(state)) {
    if (!['safe-fatal-error', 'session-expired'].includes(state)) {
      const selectedLanguage = configuredLanguage || codingLanguagePreference;
      const baseDisplayProfile = activeAttemptConfiguration?.profileKey
        ? examConfig.strictBetaProfiles?.find((entry) => entry.id === activeAttemptConfiguration.profileKey) ?? profile
        : profile;
      const authoritativeQuestionCount = activeAttemptConfiguration?.itemCount ?? availability?.selectedCount;
      const displayProfile = authoritativeQuestionCount
        ? { ...baseDisplayProfile, ...normalizeProfileComposition(availability?.profileComposition), totalScoredQuestions: authoritativeQuestionCount }
        : baseDisplayProfile;
      const canStart = state === 'ready' || state === 'ready-active';
      const isPracticeSession = Boolean(practiceRequest && practiceRequest.purpose !== 'self_directed_exam');
      const hasRecoverableSandboxes = recoverableSandboxes.length > 0;
      const actionLabel = state === 'ready-active'
          ? isPracticeSession ? 'Start new practice' : 'Start new attempt'
        : state === 'ready'
          ? hasRecoverableSandboxes && practiceRequest?.purpose === 'study_sandbox'
            ? 'Start new'
            : isPracticeSession ? 'Start practice' : 'Start exam'
          : state === 'starting'
            ? isPracticeSession ? 'Starting practice...' : 'Starting exam...'
            : 'Checking availability...';
      const visibleCandidates = activeAttemptConfiguration ? [activeAttemptConfiguration] : resumeCandidates;
      const resumeChoices = visibleCandidates.length > 0 ? (
        <section className="selected-profile-panel" aria-label="Existing protected attempts">
          <h3>Resume an existing attempt</h3>
          <p>No new attempt will be started. Choose the matching locked configuration.</p>
          <div className="exam-actions">
            {visibleCandidates.map((candidate) => (
              <button
                className="primary-button"
                key={`${candidate.profileKey}:${candidate.languagePreference}:${candidate.startedAt}`}
                type="button"
                onClick={() => chooseResumeCandidate(candidate)}
              >
                Resume attempt · {candidate.profileName}
                {examKey === 'az204' && candidate.languagePreference ? ` · ${formatReason(candidate.languagePreference)}` : ''}
              </button>
            ))}
          </div>
        </section>
      ) : null;
      const recoveryChoices = recoverableSandboxes.length > 0 ? (
        <section className="selected-profile-panel" aria-label="Recoverable Study Sandboxes">
          <h3>Recover a saved Study Sandbox</h3>
          <p>Recovery is optional. Choose one saved sandbox, or use Start new below without changing this history.</p>
          <div className="recoverable-sandbox-list">
            {recoverableSandboxes.map((candidate) => (
              <article className="recoverable-sandbox-card" key={candidate.attemptId}>
                <h4>{candidate.profileName}</h4>
                <dl className="profile-facts compact">
                  <div><dt>Package</dt><dd>{candidate.packageVersion}</dd></div>
                  <div><dt>Started</dt><dd>{formatLifecycleDate(candidate.startedAt)}</dd></div>
                  <div><dt>Last activity</dt><dd>{formatLifecycleDate(candidate.lastActivityAt)}</dd></div>
                  <div><dt>Saved responses</dt><dd>{candidate.savedResponseCount}</dd></div>
                  <div><dt>Practice items</dt><dd>{candidate.itemCount}</dd></div>
                  {examKey === 'az204' && candidate.languagePreference
                    ? <div><dt>Language</dt><dd>{formatReason(candidate.languagePreference)}</dd></div>
                    : null}
                </dl>
                <button
                  className="secondary-button"
                  disabled={Boolean(lifecycleOperation) || (
                    Boolean(recoveryRetryAttemptId) && recoveryRetryAttemptId !== candidate.attemptId
                  )}
                  type="button"
                  onClick={() => recoverSavedSandbox(candidate)}
                >
                  {lifecycleOperation === 'recovering' && recoveryRequest.current.attemptId === candidate.attemptId
                    ? 'Recovering...'
                    : recoveryRetryAttemptId === candidate.attemptId
                      ? 'Retry recovery'
                      : 'Recover saved sandbox'}
                </button>
              </article>
            ))}
          </div>
        </section>
      ) : null;
      return (
        <StudentDetails
          accountStudent={student}
          actionDisabled={!canStart || Boolean(lifecycleOperation) || Boolean(recoveryRetryAttemptId)}
          actionLabel={actionLabel}
          codingLanguagePreference={examConfig.id === 'az204' ? selectedLanguage : null}
          exam={{ ...examConfig, name: examConfig.title ?? examConfig.name }}
          languageLocked={false}
          onBack={onExit}
          onCodingLanguagePreferenceChange={changeConfiguredLanguage}
          onStartExam={state === 'ready-active' ? startNewAttempt : startAttempt}
          protectedDelivery
          practiceSession={isPracticeSession ? {
            purpose: practiceRequest.purpose,
            timed: availability?.timed === true,
            timeLimitMinutes: availability?.timeLimitMinutes ?? null,
            selectedCount: availability?.selectedCount ?? authoritativeQuestionCount,
            domain: practiceRequest.domain,
            domainLabel: (examConfig.domainNames ?? []).find((domain) => normalizeDomainKey(domain) === practiceRequest.domain) ?? practiceRequest.domain,
            objective: practiceRequest.objective,
            objectiveLabel: examConfig.objectiveGroups?.flatMap((group) => group.objectives)
              .find((objective) => normalizeDomainKey(objective) === practiceRequest.objective) ?? practiceRequest.objective,
            contentKind: practiceRequest.contentKind,
            domains: examConfig.domainNames ?? [],
            onDomainChange: practiceRequest.purpose === 'targeted_domain' && !practiceRequest.objective && onPracticeRequestChange
              ? (domain) => onPracticeRequestChange({ ...practiceRequest, domain: normalizeDomainKey(domain) })
              : null,
          } : null}
          showPrimaryAction={state !== 'ready-active' || Boolean(activeAttemptConfiguration?.replacementPermitted)}
          selectedMode={isPracticeSession
            ? { id: practiceRequest.purpose, name: getPracticeModeName(practiceRequest) }
            : selectedMode ?? { id: 'protected', name: 'Protected exam' }}
          selectedProfile={displayProfile}
          statusMessage={message}
          supplementalContent={<>{resumeChoices}{recoveryChoices}</>}
        />
      );
    }
    return (
      <section className="exam-workspace protected-status" aria-live="polite">
        <p className="eyebrow">{practiceRequest ? 'Protected practice' : 'Protected delivery'}</p>
        <h2>{examConfig.shortName}</h2>
        <p>{message}</p>
        <button className="secondary-button" type="button" onClick={onExit}>Return to exam dashboard</button>
      </section>
    );
  }

  const current = items[currentIndex];
  const caseStudyBlocks = buildProtectedCaseStudyBlocks(items);
  const isSectionedExam = profile?.id === 'az400-sectioned-full-exam-profile';
  const normalQuestions = caseStudyBlocks.length || isSectionedExam
    ? items.filter((item) => getProtectedSection(item) === 'normal')
    : items.filter((item) => item.type !== 'case-study-info');
  const pbqQuestions = isSectionedExam ? items.filter((item) => String(item.type).startsWith('pbq-')) : [];
  const answeredCount = items.filter((item) => getProtectedQuestionState(item, answers, pythonWorkspaceProgress) === 'answered').length;
  const pythonQuestionStateById = Object.fromEntries(items
    .filter(isExecutablePythonLab)
    .map((item) => [item.id, getProtectedQuestionState(item, answers, pythonWorkspaceProgress)]));
  const exitContract = getProtectedExitContract(attempt?.purpose);
  const interactionLocked = Boolean(lifecycleOperation) || Boolean(discardSummary) || pythonLabBusy || submitting.current || hasUnresolvedSubmission() || state === 'saving' || state === 'submission-preparing';
  const approvedExam = {
    ...examConfig,
    code: examConfig.code ?? examConfig.shortName,
    name: examConfig.title ?? examConfig.name ?? examConfig.shortName,
    questions: items,
    normalQuestions,
    pbqQuestions,
    caseStudyBlocks,
    hasSectionedFlow: isSectionedExam,
    profile: profile ? {
      ...profile,
      totalScoredQuestions: items.filter((item) => item.type !== 'case-study-info').length,
    } : null,
    mode: selectedMode,
  };
  const actionControls = <>
    {message && <p className="status-note" role="alert">{message}</p>}
    {saveErrors[current.id] && <p className="incomplete-warning" role="alert">Not saved: {saveErrors[current.id]}</p>}
    {issueStatus && <p className="status-note" role="status">{issueStatus}</p>}
    {itemFeedback[current.id] && <p className="status-note" role="status">{itemFeedback[current.id].status} · {itemFeedback[current.id].earnedPoints} of {itemFeedback[current.id].maxPoints} points</p>}
    <div className="exam-actions">
      <button className={flaggedQuestionIds.includes(current.id) ? 'flag-button active' : 'flag-button'} type="button" disabled={interactionLocked} onClick={() => toggleFlag(current.id)}>{flaggedQuestionIds.includes(current.id) ? 'Remove flag' : 'Flag for review'}</button>
      <button className="secondary-button" disabled={interactionLocked} type="button" onClick={() => { setIssueStatus(''); setIssueOpen(true); }}>Report question issue</button>
      {attempt?.purpose === 'study_sandbox' && !isExecutablePythonLab(current) && <button className="secondary-button" type="button" disabled={interactionLocked} onClick={() => checkPracticeItem(current.id)}>Check saved answer</button>}
      <button className="secondary-button" type="button" disabled={currentIndex === 0 || interactionLocked} onClick={() => navigate(currentIndex - 1)}>Previous</button>
      {currentIndex < items.length - 1 || itemPage.hasMore
        ? <button className="secondary-button" type="button" disabled={interactionLocked} onClick={() => navigate(currentIndex + 1)}>{state === 'saving' ? 'Saving...' : 'Next'}</button>
        : <button className="primary-button" type="button" disabled={interactionLocked} onClick={() => setShowFinalSubmitReview(true)}>Submit exam</button>}
    </div>
  </>;
  const overlays = <>
    {showFinalSubmitReview && <ProtectedFinalSubmitReview answers={answers} exam={approvedExam} flaggedQuestionIds={flaggedQuestionIds} onNavigateToItem={(index) => { setShowFinalSubmitReview(false); navigate(index); }} onReturnToExam={() => setShowFinalSubmitReview(false)} onSubmitFinal={submitAttempt} questionStateById={pythonQuestionStateById} questions={items} remainingSeconds={remainingSeconds} />}
    {issueOpen && <div className="modal-backdrop" role="presentation"><form className="modal" role="dialog" aria-modal="true" aria-labelledby="protected-issue-heading" onSubmit={submitIssue}><h2 id="protected-issue-heading">Report a question issue</h2><p>Question {current.questionNumber ?? currentIndex + 1}. Do not include passwords or personal information.</p><label htmlFor="protected-issue-message">What appears to be wrong?</label><textarea id="protected-issue-message" maxLength={2000} required rows={5} value={issueMessage} onChange={(event) => setIssueMessage(event.target.value)} /><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setIssueOpen(false)}>Cancel</button><button className="primary-button" type="submit">Send report</button></div></form></div>}
    {discardSummary && <div className="modal-backdrop" role="presentation"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="sandbox-discard-heading" aria-describedby="sandbox-discard-description"><h2 id="sandbox-discard-heading">Permanently discard this Study Sandbox?</h2><p id="sandbox-discard-description">It contains <strong>{discardSummary.savedResponseCount} saved {discardSummary.savedResponseCount === 1 ? 'response' : 'responses'}</strong>.</p><p>The responses will remain retained for audit, but this sandbox will no longer be resumable and no result will be created.</p>{discardError ? <p className="error-note" role="alert">{discardError}</p> : null}<div className="modal-actions"><button className="secondary-button" disabled={lifecycleOperation === 'discarding' || discardOutcomeAmbiguous} type="button" onClick={cancelSandboxDiscard}>Cancel</button><button className="secondary-button danger-lite" disabled={lifecycleOperation === 'discarding'} type="button" onClick={confirmSandboxDiscard}>{lifecycleOperation === 'discarding' ? 'Discarding...' : discardOutcomeAmbiguous ? 'Retry discard' : 'Permanently discard'}</button></div></section></div>}
  </>;
  return <ExamWorkspacePresentation
      actionControls={actionControls}
      answers={answers}
      caseStudyBlocks={caseStudyBlocks}
      currentIndex={currentIndex}
      currentSection={getProtectedSection(current)}
      exam={approvedExam}
      exitDescription={exitContract.description}
      exitDisabled={interactionLocked}
      exitLabel={exitContract.label}
      flaggedQuestionIds={flaggedQuestionIds}
      fullscreenMessage={fullscreenMessage}
      fullscreenSupported={fullscreenSupported}
      isFullscreen={isFullscreen}
      interactionDisabled={interactionLocked}
      isQuestionMapOpen={showQuestionMap}
      isSectionedExam={approvedExam.hasSectionedFlow}
      navigatorQuestions={items}
      normalQuestions={normalQuestions}
      onAnswerChange={changeAnswer}
      onCloseQuestionMap={() => setShowQuestionMap(false)}
      onExit={handleExit}
      onNavigate={(index) => { setShowQuestionMap(false); navigate(index); }}
      onOpenQuestionMap={() => setShowQuestionMap(true)}
      onTimeExpired={submitAttempt}
      onTimerTick={setRemainingSeconds}
      onToggleFullscreen={toggleFullscreen}
      overlays={overlays}
      pbqQuestions={pbqQuestions}
      progressLabel={getProtectedProgressLabel(current, currentIndex, items, {
        timed: attempt.timed !== false,
        totalCount: itemPage.totalCount,
      })}
      pythonLab={{
        attemptId: attempt.attemptId,
        client,
        onBusyChange: setPythonLabBusy,
        onRegisterSave: registerPythonWorkspaceSave,
        onWorkspaceStateChange: updatePythonWorkspaceProgress,
      }}
      questionStateById={pythonQuestionStateById}
      scoredAnswerSummary={attempt.timed === false
        ? `${answeredCount} answered · ${itemPage.totalCount || items.length} practice items total${itemPage.hasMore ? ' · more load as you continue' : ''}`
        : `${answeredCount} of ${items.filter((item) => item.type !== 'case-study-info').length} scored questions answered`}
      studentName={student?.name}
      timerExpiresAt={attempt.expiresAt}
      timed={attempt.timed !== false}
      secondaryExitAction={attempt?.purpose === 'study_sandbox' ? {
        disabled: interactionLocked,
        label: lifecycleOperation === 'discard-preflight' ? 'Checking saved work...' : 'Discard saved sandbox',
        onClick: prepareSandboxDiscard,
      } : null}
      workspaceRef={workspaceRef}
    />;
}

function getProtectedQuestionState(question, answers, pythonWorkspaceProgress = {}) {
  if (question.type === 'case-study-info') return 'info';
  if (isExecutablePythonLab(question)) {
    const progress = pythonWorkspaceProgress[question.id];
    if (progress?.dirty) return 'incomplete';
    return progress?.persisted ? 'answered' : 'unanswered';
  }
  const value = answers[question.id];
  const structuredState = getStructuredResponseState(question, value);
  if (structuredState) return structuredState;
  if (value == null || value === '') return 'unanswered';
  if (Array.isArray(value)) return value.length ? 'answered' : 'unanswered';
  if (typeof value === 'object') return Object.values(value).some((entry) => entry != null && entry !== '' && (!Array.isArray(entry) || entry.length)) ? 'answered' : 'unanswered';
  return 'answered';
}

function getProtectedSection(question) {
  const section = getProtectedItemSection(question);
  return section === 'standard' ? 'normal' : section;
}

function getProtectedProgressLabel(question, index, items, { timed = true, totalCount = items.length } = {}) {
  const section = getProtectedSection(question);
  if (!timed) {
    const globalPosition = index + 1;
    const globalTotal = Math.max(items.length, totalCount);
    if (question.type === 'case-study-info') return `Practice item ${globalPosition} of ${globalTotal} · View Case Study`;
    if (section === 'pbq') return `Lab/PBQ · Practice item ${globalPosition} of ${globalTotal}`;
    if (section === 'case-study') return `Case Study · Practice item ${globalPosition} of ${globalTotal}`;
    return `Practice item ${globalPosition} of ${globalTotal}`;
  }
  if (question.type === 'case-study-info') return 'Case Study Section: View Case Study';
  const sectionItems = items.filter((item) => getProtectedSection(item) === section && item.type !== 'case-study-info');
  const sectionIndex = sectionItems.findIndex((item) => item.id === question.id) + 1;
  if (section === 'pbq') return `Lab/PBQ Section: Lab ${sectionIndex} of ${sectionItems.length}`;
  if (section === 'case-study') return `Case Study Section: Question ${sectionIndex} of ${sectionItems.length}`;
  return `Standard Questions: Question ${question.questionNumber ?? index + 1} of ${sectionItems.length}`;
}

function buildProtectedCaseStudyBlocks(items) {
  const blocks = [];
  let current = null;
  items.forEach((item) => {
    if (item.type === 'case-study-info') {
      current = { id: item.id, title: item.title ?? 'Case Study', scenario: item, questions: [], items: [item] };
      blocks.push(current);
    } else if (current && /case/i.test(item.section)) {
      current.questions.push(item);
      current.items.push(item);
    }
  });
  return blocks;
}

function buildPracticeRequest(practiceRequest, language, examKey) {
  const request = { ...practiceRequest };
  delete request.language;
  if (examKey === 'az204') request.language = language;
  return request;
}

function normalizeDomainKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function getPracticeModeName(request) {
  if (request.purpose === 'study_sandbox') return 'Study Sandbox';
  if (request.purpose === 'targeted_domain') return 'Targeted Domain Practice';
  if (request.purpose === 'weak_area') return 'Weak Area Practice';
  if (request.contentKind === 'case-study') return 'Case Study Practice';
  if (request.contentKind === 'pbq') return 'PBQ Practice';
  return 'Protected Practice';
}

function normalizeAttemptLanguage(language) {
  return language || 'not_applicable';
}

function normalizeProfileComposition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const allowed = [
    'questionCount', 'timeLimitMinutes', 'standardQuestionCount',
    'caseStudyCount', 'caseStudyQuestionCount', 'pbqCount', 'sectionOrder',
  ];
  return Object.fromEntries(allowed
    .filter((key) => value[key] !== null && value[key] !== undefined)
    .map((key) => [key === 'questionCount' ? 'totalScoredQuestions' : key, value[key]]));
}

function isAmbiguousProtectedMutation(error) {
  return error?.ambiguousTransport === true || Number(error?.httpStatus) >= 500;
}

function formatReason(value) {
  return String(value ?? '').replaceAll('_', ' ');
}

function formatLifecycleDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'Unavailable';
}

function assertAttemptBinding(attempt, eligibility) {
  if (
    attempt?.examKey !== eligibility?.examKey ||
    attempt?.packageVersion !== eligibility?.packageVersion ||
    attempt?.profileKey !== eligibility?.profileKey
  ) {
    throw Object.assign(new Error('Protected attempt binding does not match the assignment.'), {
      code: 'binding_mismatch',
    });
  }
}

function assertAttemptAssignment(attempt, expectedAssignmentId) {
  const expected = expectedAssignmentId || null;
  if ((attempt?.assignmentId ?? null) !== expected) {
    throw Object.assign(new Error('Protected attempt attribution does not match the requested assignment.'), {
      code: 'binding_mismatch',
    });
  }
}
