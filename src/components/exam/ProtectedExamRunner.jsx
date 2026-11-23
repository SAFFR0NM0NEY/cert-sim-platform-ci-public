import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ExamWorkspacePresentation from './ExamWorkspacePresentation.jsx';
import ProtectedCompletionStatus from './ProtectedCompletionStatus.jsx';
import { createRunnerInitializationScope } from '../../lib/runnerInitializationScope.js';
import { createProtectedAnswerDraft, ownsProtectedAnswerDraft, reconcileProtectedAnswerDraft, editProtectedAnswerDraft, acknowledgeProtectedAnswerDraft } from '../../lib/protectedAnswerDraft.js';
import { createManagedCompletionAuthority } from '../../lib/managedCompletionAuthority.js';
import { isExplicitCompletionContractUnsupported, requireMatchingCompletionResult } from '../../lib/protectedCompletionStatus.js';
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
import { getDisplayDomainItems, getDomainDisplayLabel } from '../../lib/domainLabelPresentation.js';
import { resolvePracticeRequest } from '../../lib/protectedPracticeRequest.js';
import ReleasedReviewWorkspace from './ReleasedReviewWorkspace.jsx';
import { downloadProtectedResultSummaryPdf } from '../../lib/savedResultReportExport.js';
import { getStructuredResponseState } from '../../lib/structuredResponse.js';
import { getProfilePresentation, projectProfilePresentation } from '../../lib/examProfilePresentation.js';
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
  }, [Boolean(session?.access_token), authenticatedUserId]);
  const [state, setState] = useState('eligibility-loading');
  const [message, setMessage] = useState('Checking protected-exam eligibility...');
  const [attempt, setAttempt] = useState(null);
  const [items, setItems] = useState([]);
  const [itemPage, setItemPage] = useState({ returnedThrough: 0, totalCount: 0, hasMore: false });
  const [answerDraft, setAnswerDraft] = useState(createProtectedAnswerDraft);
  const answerDraftRef = useRef(answerDraft);
  const { answers, revisions, dirtyIds } = answerDraft;
  const [saveErrors, setSaveErrors] = useState({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [result, setResult] = useState(null);
  const resultRef = useRef(null);
  const completionAuthority = useRef(createManagedCompletionAuthority());
  const expiryEntered = useRef(false);
  const loadedAccountId = useRef('');
  const visibilityChecks = useRef(0);
  const pendingLaunchCursor = useRef(null);
  const pendingLaunchScope = useRef('');
  const managedRecheck = useRef(null);
  const managedRecheckController = useRef(null);
  const completionReadBusyRef = useRef(false);
  const [completionReadBusy, setCompletionReadBusy] = useState(false);
  const [managedStatusError, setManagedStatusError] = useState('');
  const [, setAuthorityRevision] = useState(0);
  const [review, setReview] = useState(null);
  const [reviewMessage, setReviewMessage] = useState('');
  const [pdfState, setPdfState] = useState({ preparing: false, message: '', error: '' });
  const [availability, setAvailability] = useState(null);
  const requestedLanguage = examConfig?.id === 'az204' ? (practiceRequest?.language ?? codingLanguagePreference ?? 'csharp') : null;
  const languageInputKey = JSON.stringify([examKey, requestedLanguage]);
  const languageInputScope = useRef({ key: languageInputKey });
  if (languageInputScope.current.key !== languageInputKey) languageInputScope.current = { key: languageInputKey };
  const languageScope = languageInputScope.current;
  const [languageSelection, setLanguageSelection] = useState({ scope: languageScope, value: requestedLanguage });
  const configuredLanguage = languageSelection.scope === languageScope ? languageSelection.value : requestedLanguage;
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
  const initializationScope = useRef(createRunnerInitializationScope());
  const loadedInitialization = useRef(null);
  const setupPresentation = useRef(null);
  const loadedWork = useRef(null);
  loadedWork.current = { dirtyIds, answers, revisions, pythonWorkspaceProgress };
  const configuredLanguageRef = useRef(configuredLanguage);
  configuredLanguageRef.current = configuredLanguage;
  const availabilityRef = useRef(null);
  const practiceRequestRef = useRef(effectivePracticeRequest);
  practiceRequestRef.current = effectivePracticeRequest;
  const submissionId = useRef('');
  const submissionBinding = useRef({ attemptId: '', userId: '', submissionId: '', dispatched: false, resolved: false, submitRetryAllowed: false });
  const submissionOperation = useRef({ controller: null, generation: 0 });
  const submissionPreparationGeneration = useRef(0);
  const submissionPreparationContext = useRef(null);
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

  const initializationView = initializationScope.current.update(JSON.stringify([
    authenticatedUserId, Boolean(session?.access_token), examKey, profileKey,
    practiceInitializationKey, assignmentId, configuredLanguage, codingLanguagePreference ?? null,
  ]));
  function isCurrentInitialization(context) {
    return initializationScope.current.isCurrent(context) &&
      context.accountId === getCurrentAuthenticatedUserId() && !operationController.current.signal.aborted;
  }
  const loadedContext = loadedInitialization.current;
  function isLoadedContextCurrent(context = loadedContext) {
    return isCurrentInitialization(context) && context === loadedInitialization.current &&
      context.attemptId === attemptRef.current?.attemptId;
  }
  function hasUnsavedLoadedWork() {
    return Boolean(answerDraftRef.current.dirtyIds.size ||
      Object.values(loadedWork.current?.pythonWorkspaceProgress ?? {}).some((progress) => progress.dirty));
  }
  function commitAnswerDraft(update) {
    const next = update(answerDraftRef.current);
    answerDraftRef.current = next;
    setAnswerDraft(next);
    return next;
  }
  function answerOwner(context = loadedContext) {
    return { accountId: context?.accountId, attemptId: context?.attemptId };
  }
  function reconcileAnswerItems(rawItems, presentationItems, context, replace = false) {
    if (!isCurrentInitialization(context)) return;
    const incoming = rawItems.map((item, index) => ({ itemId: item.itemId,
      answer: deserializeProtectedResponse(presentationItems[index], item.response), revision: item.revision ?? 0 }));
    commitAnswerDraft((current) => reconcileProtectedAnswerDraft(current, answerOwner(context), incoming, { replace }));
  }
  function hasUnloadedDirtyAnswers() {
    return [...answerDraftRef.current.dirtyIds].some((id) => !items.some((item) => item.id === id));
  }
  function requireSettledOrdinaryAnswers() {
    if (!answerDraftRef.current.dirtyIds.size) return true;
    setMessage('Unsaved answers on another item are retained locally. Revisit those items before leaving or submitting.');
    return false;
  }
  function setInitializationState(context, value) {
    if (!isCurrentInitialization(context)) return;
    setupPresentation.current = { context, state: value };
    setState(value);
  }
  function exitSelectedSetup() {
    if (hasUnsavedLoadedWork() || hasUnresolvedSubmission() || navigationSave.current) {
      setMessage('Unsaved work is retained in the original attempt. Return to its configuration before leaving or starting another attempt.');
      return;
    }
    onExit?.();
  }
  function beginInitialization(attemptId = '') {
    const context = initializationScope.current.begin({ view: initializationView,
      accountId: getCurrentAuthenticatedUserId(), attemptId, signal: operationController.current.signal });
    if (!context) return null;
    setupPresentation.current = { context, state: 'eligibility-loading' };
    // Supersede only initialization-owned flags, never manual submission state.
    if (starting.current && starting.current !== true) starting.current = false;
    if (lifecycleLock.current && lifecycleLock.current !== true) {
      lifecycleLock.current = false;
      setLifecycleOperation('');
    }
    return context;
  }

  useEffect(() => {
    operationController.current = new AbortController();
    return () => {
      operationController.current.abort();
      initializationScope.current.dispose();
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

  useEffect(() => {
    if (!isLoadedContextCurrent() || !attempt?.attemptId || !completionAuthority.current.isManaged() || completionAuthority.current.isExpired()) return undefined;
    let interval;
    const account = authenticatedUserId, id = attempt.attemptId;
    const tick = () => {
      if (!isLoadedContextCurrent(loadedContext) || !completionAuthority.current.matches(id, account) || resultRef.current) return;
      if (completionAuthority.current.isExpired()) { window.clearInterval(interval); enterManagedExpiry(loadedContext); }
    };
    const visibility = () => {
      if (!isLoadedContextCurrent(loadedContext) || !completionAuthority.current.matches(id, account) || resultRef.current) return;
      completionAuthority.current.suspend();
      setAuthorityRevision((n) => n + 1);
      tick();
      if (document.visibilityState !== 'hidden' && navigator.onLine !== false && !completionAuthority.current.isExpired() && visibilityChecks.current < 6) {
        visibilityChecks.current += 1;
        recheckManagedAuthority();
      }
    };
    interval = window.setInterval(tick, 250);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('offline', visibility);
    window.addEventListener('online', visibility);
    tick();
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('offline', visibility);
      window.removeEventListener('online', visibility);
      managedRecheckController.current?.abort();
      managedRecheck.current = null;
      managedRecheckController.current = null;
    };
  }, [attempt?.attemptId, authenticatedUserId, initializationView, loadedContext, setupPresentation.current?.context]);

  const getManagedRemainingSeconds = useCallback(() => isLoadedContextCurrent(loadedContext) ? completionAuthority.current.remainingSeconds() ?? 0 : 0, [loadedContext]);
  const updateCompletionReadBusy = useCallback((busy) => {
    if (!isLoadedContextCurrent(loadedContext) && !hasUnresolvedSubmission()) return;
    completionReadBusyRef.current = busy;
    setCompletionReadBusy(busy);
  }, [loadedContext]);

  const loadAttempt = useCallback(async (payload, context) => {
    if (!isCurrentInitialization(context)) return;
    const nextAttempt = payload?.attempt;
    if (!initializationScope.current.bindAttempt(context, nextAttempt?.attemptId)) return;
    const account = context.accountId;
    if (hasUnresolvedSubmission()) {
      if (submissionBinding.current.attemptId !== nextAttempt?.attemptId || submissionBinding.current.userId !== account) failClosedForSubmissionIdentity(submissionBinding.current);
      return;
    }
    if (resultRef.current?.attemptId === nextAttempt?.attemptId && loadedAccountId.current === account) return;
    if (hasUnsavedLoadedWork() && (!ownsProtectedAnswerDraft(answerDraftRef.current, { accountId: account, attemptId: nextAttempt?.attemptId }) ||
        Object.values(loadedWork.current?.pythonWorkspaceProgress ?? {}).some((progress) => progress.dirty))) {
      throw Object.assign(new Error('Unsaved work is retained in the original attempt. Return to its configuration before continuing.'), { code: 'unsaved_attempt' });
    }
    const observation = payload.completionObservation ?? await inspectCompletion(nextAttempt.attemptId, context.signal);
    if (!isCurrentInitialization(context) || hasUnresolvedSubmission()) return;
    if (hasUnsavedLoadedWork() && (!ownsProtectedAnswerDraft(answerDraftRef.current, answerOwner(context)) ||
        Object.values(loadedWork.current?.pythonWorkspaceProgress ?? {}).some((progress) => progress.dirty))) {
      throw Object.assign(new Error('Unsaved work is retained in the original attempt.'), { code: 'unsaved_attempt' });
    }
    if (resultRef.current?.attemptId === nextAttempt.attemptId && loadedAccountId.current === account) return;
    if (!completionAuthority.current.matches(nextAttempt.attemptId, account)) {
      completionAuthority.current.reset(nextAttempt.attemptId, account);
      expiryEntered.current = false;
      visibilityChecks.current = 0;
      resultRef.current = null;
      completionReadBusyRef.current = false;
      setCompletionReadBusy(false);
      setResult(null);
    }
    if (observation.status) completionAuthority.current.observe(observation.status, observation.startedAt);
    loadedAccountId.current = account;
    loadedInitialization.current = context;
    loadingPage.current = false;
    setManagedStatusError('');
    resetSubmissionBinding();
    submissionPreparationContext.current = null;
    if (completionAuthority.current.isManaged() && completionAuthority.current.isExpired()) {
      attemptRef.current = nextAttempt;
      setAttempt(nextAttempt);
      setItems([]);
      pythonWorkspaceSave.current = null;
      enterManagedExpiry(context);
      return;
    }
    const nextItems = (payload?.items ?? []).map(toPresentationQuestion);
    const authoritativeComposition = normalizeProfileComposition(availabilityRef.current?.profileComposition);
    if (nextAttempt?.countContract != null || availabilityRef.current?.countPolicy != null) {
      assertProtectedAttemptInventory({ countPolicy: availabilityRef.current?.countPolicy }, nextItems, nextAttempt);
    } else if (availabilityRef.current?.fixedProfileSize && authoritativeComposition) {
      assertProtectedAttemptInventory({
        ...profile,
        ...authoritativeComposition,
        totalScoredQuestions: availabilityRef.current.selectedCount,
      }, nextItems);
    }
    const rawItems = payload?.items ?? [];
    attemptRef.current = payload?.attempt ?? null;
    setAttempt(payload?.attempt ?? null);
    setItems(nextItems);
    setItemPage(payload?.page ?? { returnedThrough: nextItems.length, totalCount: nextItems.length, hasMore: false });
    reconcileAnswerItems(rawItems, nextItems, context, true);
    setPythonWorkspaceProgress({});
    setPythonLabBusy(false);
    pythonWorkspaceSave.current = null;
    setRecoverableSandboxes([]);
    setRecoveryRetryAttemptId('');
    recoveryRequest.current = { attemptId: '', requestId: '' };
    setCurrentIndex(0);
    setRemainingSeconds(completionAuthority.current.remainingSeconds() ?? getServerRemainingSeconds(payload?.attempt));
    if (completionAuthority.current.isManaged() && completionAuthority.current.isExpired()) {
      enterManagedExpiry(context);
      return;
    }
    setState('active');
    setMessage('');
  }, [profile, client, authenticatedUserId]);

  useEffect(() => {
    if (!client || !isLoadedContextCurrent() || !attempt?.attemptId || completionAuthority.current.isExpired()) return;
    const controller = new AbortController();
    client.listFlags(attempt.attemptId, { signal: AbortSignal.any([controller.signal, loadedContext.signal]) })
      .then((payload) => { if (isLoadedContextCurrent(loadedContext) && !controller.signal.aborted) setFlaggedQuestionIds(payload.itemIds ?? []); })
      .catch((error) => { if (isLoadedContextCurrent(loadedContext) && !controller.signal.aborted) setMessage(error.message); });
    return () => controller.abort();
  }, [attempt?.attemptId, client, loadedContext, initializationView]);

  useEffect(() => {
    const context = beginInitialization();
    if (!context) return;
    const controller = { signal: context.signal };
    const stale = () => !isCurrentInitialization(context);
    async function initialize() {
      if (examConfig.sourcePreviewOnly) {
        setInitializationState(context, 'safe-fatal-error');
        setMessage('Unpublished source preview. New starts are unavailable.');
        return;
      }
      if (!client || !examKey || !profileKey) {
        setInitializationState(context, 'safe-fatal-error');
        setMessage(!client ? 'Sign in again to use protected delivery.' : 'This exam profile is not available for protected delivery.');
        return;
      }
      try {
        if (practiceBindingError) throw practiceBindingError;
        if (loadedAccountId.current && loadedAccountId.current !== getCurrentAuthenticatedUserId() && !hasUnresolvedSubmission()) {
          setInitializationState(context, 'session-expired');
          setMessage(submissionPreparationContext.current && submissionPreparationContext.current.userId !== getCurrentAuthenticatedUserId()
            ? 'The signed-in account changed before final submission was sent. Sign in again before continuing.'
            : 'The signed-in account changed. Sign in with the authorised account before checking this attempt.');
          return;
        }
        if (hasUnresolvedSubmission()) {
          // A configuration/account change cannot discard the mounted original
          // binding or apply an in-flight read from the previous view context.
          submissionOperation.current.controller?.abort();
          submissionOperation.current.generation += 1;
          submitting.current = false;
          if (submissionBinding.current.userId === getCurrentAuthenticatedUserId()) {
            setInitializationState(context, submissionBinding.current.submitRetryAllowed ? 'submission-recoverable' : 'submission-result-check-recoverable');
            setMessage('The view configuration changed. The original submission identity is retained; check its result before changing attempts.');
          }
          return;
        }
        if (submitting.current) return;
        if (practiceRequestRef.current) {
          const configuredRequest = buildPracticeRequest(practiceRequestRef.current, configuredLanguageRef.current, examKey);
          setRecoverableSandboxes([]);
          setInitializationState(context, 'resuming');
          setMessage('Looking for an existing protected practice attempt...');
          const launchScope = JSON.stringify([getCurrentAuthenticatedUserId(), examKey, profileKey, configuredRequest.purpose, configuredRequest.assignmentId ?? null]);
          if (pendingLaunchScope.current !== launchScope) { pendingLaunchScope.current = launchScope; pendingLaunchCursor.current = null; }
          if (['assigned_assessment', 'self_directed_exam'].includes(configuredRequest.purpose)) {
            const startedAt = performance.now();
            let pending;
            try {
              pending = await client.listPendingCompletions({
                examKey, profileId: profileKey, purpose: configuredRequest.purpose,
                assignmentId: configuredRequest.assignmentId || undefined,
                cursor: pendingLaunchCursor.current || undefined, pageSize: 20,
              }, { signal: controller.signal });
            } catch (error) {
              if (!isExplicitCompletionContractUnsupported(error) || completionAuthority.current.isManaged()) throw error;
            }
            if (stale()) return;
            if (pending?.items.length) {
              const status = pending.items[0];
              pendingLaunchCursor.current = null;
              await loadAttempt({ attempt: { ...status, expiresAt: status.deadline, timed: true }, items: [],
                completionObservation: { status, startedAt } }, context);
              return;
            }
            if (pending?.nextCursor) {
              pendingLaunchCursor.current = pending.nextCursor;
              setInitializationState(context, 'pending-discovery');
              setMessage('More saved attempt records need to be checked before opening this exam. Checking another page does not resume or change an attempt.');
              return;
            }
            pendingLaunchCursor.current = null;
          }
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
            setInitializationState(context, 'resuming');
            setMessage('Recovering your protected attempt...');
            let current;
            try {
              current = await readResumeCandidate(candidates[0], context);
            } catch (resumeError) {
              if (stale()) return;
              if (['attempt_not_found', 'attempt_expired'].includes(resumeError.code)) {
                setActiveAttemptConfiguration(null);
                setResumeCandidates([]);
                setInitializationState(context, 'eligibility-loading');
                setMessage('That attempt is no longer resumable. Refreshing available actions...');
                setRefreshNonce((value) => value + 1);
                return;
              }
              throw resumeError;
            }
            if (stale()) return;
            setResumeCandidates([]);
            await loadAttempt(current, context);
          } else if (candidates.length === 1) {
            setRecoverableSandboxes([]);
            availabilityRef.current = candidates[0];
            setAvailability(candidates[0]);
            setActiveAttemptConfiguration(candidates[0]);
            setInitializationState(context, 'ready-active');
            setMessage('An unfinished attempt uses a different language. Resume it, or explicitly start a new attempt if permitted.');
          } else if (candidates.length > 1) {
            setRecoverableSandboxes([]);
            setActiveAttemptConfiguration(null);
            setInitializationState(context, 'resume-choice');
            setMessage('Choose the existing protected attempt you want to resume. No new attempt will be started.');
          } else if (profileCandidates.length > 0) {
            setRecoverableSandboxes([]);
            setResumeCandidates(profileCandidates);
            setActiveAttemptConfiguration(null);
            setInitializationState(context, 'resume-choice');
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
            setInitializationState(context, 'ready');
            setMessage(preview.countPolicy
              ? 'The server assigns an authorised form of ' + preview.countPolicy.allowedCounts.join(' or ') + ' questions at Start.'
              : (historical.candidates ?? []).length
              ? 'Choose a saved Study Sandbox to recover, or start new. No historical sandbox is changed by this screen.'
              : `Ready to start ${preview.selectedCount} protected practice items${preview.adjustedCount ? ' (adjusted to the available pool)' : ''}.`);
          }
          return;
        }
      } catch (error) {
        if (stale()) return;
        setInitializationState(context, error.code === 'unauthenticated' ? 'session-expired' : 'safe-fatal-error');
        setMessage(error.message);
      }
    }
    initialize();
    return () => initializationScope.current.cancel(context);
  }, [client, examKey, loadAttempt, practiceBindingError, practiceInitializationKey, profileKey, refreshNonce, initializationView]);

  async function readResumeCandidate(candidate, context) {
    if (!isCurrentInitialization(context)) return null;
    if (!initializationScope.current.bindAttempt(context, candidate.attemptId)) return null;
    const signal = context.signal;
    const observation = await inspectCompletion(candidate.attemptId, signal);
    if (!isCurrentInitialization(context)) return null;
    if (observation.status?.expiryManaged && !observation.status.answeringAllowed) {
      return { attempt: { ...observation.status, expiresAt: observation.status.deadline, timed: true }, items: [], completionObservation: observation };
    }
    const current = await client.resumeAttempt(candidate.attemptId, { signal });
    if (!isCurrentInitialization(context)) return null;
    assertAttemptBinding(current.attempt, candidate);
    assertAttemptAssignment(current.attempt, candidate.assignmentId);
    if (current.attempt?.purpose !== candidate.purpose || current.attempt?.languagePreference !== candidate.languagePreference) {
      throw Object.assign(new Error('Protected attempt binding could not be verified.'), { code: 'binding_mismatch' });
    }
    return { ...current, completionObservation: observation };
  }

  async function resumeCandidate(candidate, context) {
    if (!isCurrentInitialization(context)) return;
    setInitializationState(context, 'resuming');
    setMessage('Resuming the selected protected attempt...');
    const current = await readResumeCandidate(candidate, context);
    if (!isCurrentInitialization(context)) return;
    setResumeCandidates([]);
    setRecoverableSandboxes([]);
    await loadAttempt(current, context);
  }

  async function chooseResumeCandidate(candidate) {
    if (lifecycleLock.current || starting.current) return;
    const context = beginInitialization(candidate.attemptId);
    if (!context) return;
    try {
      await resumeCandidate(candidate, context);
    } catch (error) {
      if (!isCurrentInitialization(context)) return;
      if (['attempt_not_found', 'attempt_expired'].includes(error.code)) {
        setActiveAttemptConfiguration(null);
        setResumeCandidates([]);
        setInitializationState(context, 'eligibility-loading');
        setMessage('That attempt is no longer resumable. Refreshing available actions...');
        setRefreshNonce((value) => value + 1);
      } else {
        setInitializationState(context, error.code === 'unauthenticated' ? 'session-expired' : 'safe-fatal-error');
        setMessage(error.message);
      }
    }
  }

  async function recoverSavedSandbox(candidate) {
    if (lifecycleLock.current || starting.current || hasUnsavedLoadedWork()) return;
    const context = beginInitialization(candidate.attemptId);
    if (!context) return;
    lifecycleLock.current = context;
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
        { signal: context.signal },
      );
      if (!isCurrentInitialization(context)) return;
      if (recovered.attemptId !== candidate.attemptId || recovered.status !== 'in_progress') {
        throw Object.assign(new Error('The recovered Study Sandbox identity could not be verified.'), { code: 'binding_mismatch' });
      }
      recoveryCommitted = true;
      availabilityRef.current = candidate;
      setAvailability(candidate);
      const current = await readResumeCandidate(candidate, context);
      if (!isCurrentInitialization(context)) return;
      setResumeCandidates([]);
      setRecoverableSandboxes([]);
      setRecoveryRetryAttemptId('');
      recoveryRequest.current = { attemptId: '', requestId: '' };
      await loadAttempt(current, context);
    } catch (error) {
      if (!isCurrentInitialization(context)) return;
      if (isAmbiguousProtectedMutation(error)) {
        setRecoveryRetryAttemptId(candidate.attemptId);
        setInitializationState(context, 'ready');
        setMessage('The recovery outcome could not be confirmed. Retry recovery to reuse the same protected request.');
      } else if (recoveryCommitted || ['active_sandbox_exists', 'attempt_conflict'].includes(error.code)) {
        setRecoveryRetryAttemptId('');
        recoveryRequest.current = { attemptId: '', requestId: '' };
        setRecoverableSandboxes([]);
        setInitializationState(context, 'eligibility-loading');
        setMessage('Study Sandbox availability changed. Refreshing active attempts...');
        setRefreshNonce((value) => value + 1);
      } else {
        setRecoveryRetryAttemptId('');
        recoveryRequest.current = { attemptId: '', requestId: '' };
        if (['attempt_not_found', 'sandbox_discarded', 'sandbox_not_recoverable', 'practice_unavailable', 'invalid_lifecycle_transition'].includes(error.code)) {
          setRecoverableSandboxes((current) => current.filter((entry) => entry.attemptId !== candidate.attemptId));
        }
        setInitializationState(context, error.code === 'unauthenticated' ? 'session-expired' : 'ready');
        setMessage(error.message);
      }
    } finally {
      if (isCurrentInitialization(context) && lifecycleLock.current === context) {
        lifecycleLock.current = false;
        setLifecycleOperation('');
      }
    }
  }

  async function startAttempt() {
    if (examConfig.sourcePreviewOnly) return;
    if (starting.current || lifecycleLock.current || hasUnsavedLoadedWork()) return;
    const context = beginInitialization();
    if (!context) return;
    starting.current = context;
    setInitializationState(context, 'starting');
    setMessage('Starting protected attempt...');
    try {
      const options = { signal: context.signal };
      if (effectivePracticeRequest) {
        const clientRequestId = crypto.randomUUID();
        const configuredRequest = buildPracticeRequest(effectivePracticeRequest, configuredLanguage, examKey);
        if (availability?.countPolicy) delete configuredRequest.count;
        try {
          const started = await client.startPractice({ examKey, profileId: profileKey, ...configuredRequest, clientRequestId }, options);
          if (!isCurrentInitialization(context)) return;
          assertAttemptBinding(started.attempt, availability);
          assertAttemptAssignment(started.attempt, configuredRequest.assignmentId);
          if (started.attempt?.purpose !== effectivePracticeRequest.purpose) throw Object.assign(new Error('Protected practice purpose could not be verified.'), { code: 'binding_mismatch' });
          await loadAttempt(started, context); return;
        } catch (error) {
          if (!isCurrentInitialization(context)) return;
          if (!isAmbiguousProtectedMutation(error)) throw error;
          const recovered = await client.getCurrentAttempt(examKey, profileKey, {
            purpose: configuredRequest.purpose,
            language: configuredRequest.language,
            ...(configuredRequest.assignmentId ? { assignmentId: configuredRequest.assignmentId } : {}),
          }, options);
          if (!isCurrentInitialization(context)) return;
          assertAttemptBinding(recovered.attempt, availability);
          assertAttemptAssignment(recovered.attempt, configuredRequest.assignmentId);
          if (recovered.attempt?.purpose !== effectivePracticeRequest.purpose) throw Object.assign(new Error('Protected practice recovery found a conflicting session.'), { code: 'start_state_conflict' });
          await loadAttempt(recovered, context); return;
        }
      }
      throw Object.assign(new Error('Protected practice configuration was not available.'), { code: 'practice_unavailable' });
    } catch (error) {
      if (!isCurrentInitialization(context)) return;
      if (effectivePracticeRequest?.purpose === 'study_sandbox' && ['active_sandbox_exists', 'attempt_conflict'].includes(error.code)) {
        setRecoverableSandboxes([]);
        setInitializationState(context, 'eligibility-loading');
        setMessage('An active Study Sandbox was found. Refreshing its protected binding...');
        setRefreshNonce((value) => value + 1);
      } else {
        setInitializationState(context, error.code === 'unauthenticated' ? 'session-expired' : 'safe-fatal-error');
        setMessage(error.message);
      }
    } finally {
      if (isCurrentInitialization(context) && starting.current === context) starting.current = false;
    }
  }

  async function startNewAttempt() {
    if (!activeAttemptConfiguration?.replacementPermitted || starting.current || lifecycleLock.current || hasUnsavedLoadedWork()) return;
    const languageConfigured = examKey === 'az204';
    const confirmation = languageConfigured
      ? `Start a new attempt using ${formatReason(configuredLanguage)}? Your unfinished ${formatReason(activeAttemptConfiguration.languagePreference)} attempt will be discarded and retained only for audit.`
      : `Start a new ${activeAttemptConfiguration.profileName} attempt? Your unfinished ${activeAttemptConfiguration.profileName} attempt will be discarded and retained only for audit.`;
    if (!window.confirm(confirmation)) return;
    const context = beginInitialization();
    if (!context) return;
    starting.current = context;
    setInitializationState(context, 'starting');
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
        if (availability?.countPolicy) delete configuredRequest.count;
        const started = await client.replacePractice(configuredRequest, { signal: context.signal });
        if (!isCurrentInitialization(context)) return;
        assertAttemptBinding(started.attempt, availability);
        assertAttemptAssignment(started.attempt, configuredRequest.assignmentId);
        if ((started.attempt?.languagePreference ?? null) !== configuredLanguage) throw Object.assign(new Error('Protected attempt language could not be verified.'), { code: 'binding_mismatch' });
        await loadAttempt(started, context);
      } catch (error) {
        if (!isCurrentInitialization(context)) return;
        if (!isAmbiguousProtectedMutation(error)) throw error;
        const recovered = await client.getCurrentAttempt(examKey, profileKey, {
          purpose: configuredRequest.purpose,
          language: configuredRequest.language,
          ...(configuredRequest.assignmentId ? { assignmentId: configuredRequest.assignmentId } : {}),
        }, { signal: context.signal });
        if (!isCurrentInitialization(context)) return;
        assertAttemptBinding(recovered.attempt, availability);
        assertAttemptAssignment(recovered.attempt, configuredRequest.assignmentId);
        if ((recovered.attempt?.languagePreference ?? null) !== configuredLanguage) throw Object.assign(new Error('Protected replacement state could not be verified.'), { code: 'start_state_conflict' });
        await loadAttempt(recovered, context);
      }
    } catch (error) {
      if (!isCurrentInitialization(context)) return;
      if (['attempt_conflict', 'attempt_not_found', 'attempt_expired'].includes(error.code)) {
        setActiveAttemptConfiguration(null);
        setResumeCandidates([]);
        setInitializationState(context, 'eligibility-loading');
        setMessage('Attempt availability changed. Refreshing available actions...');
        setRefreshNonce((value) => value + 1);
      } else {
        setInitializationState(context, error.code === 'unauthenticated' ? 'session-expired' : 'ready-active');
        setMessage(error.message);
      }
    } finally {
      if (isCurrentInitialization(context) && starting.current === context) starting.current = false;
    }
  }

  async function resumePendingAttempt() {
    if (!activeAttemptConfiguration) return;
    const context = beginInitialization(activeAttemptConfiguration.attemptId);
    if (!context) return;
    try {
      await resumeCandidate(activeAttemptConfiguration, context);
    } catch (error) {
      if (!isCurrentInitialization(context)) return;
      if (error.code === 'attempt_not_found') {
        try {
          const configuredRequest = buildPracticeRequest(effectivePracticeRequest, configuredLanguage, examKey);
          const refreshedAvailability = await client.getPracticeAvailability(
            { examKey, profileId: profileKey, ...configuredRequest },
            { signal: context.signal },
          );
          if (!isCurrentInitialization(context)) return;
          availabilityRef.current = refreshedAvailability;
          setAvailability(refreshedAvailability);
          setActiveAttemptConfiguration(null);
          setInitializationState(context, 'ready');
          setMessage('The prior attempt is complete. You can start a new attempt.');
        } catch (reconciliationError) {
          if (!isCurrentInitialization(context)) return;
          setInitializationState(context, reconciliationError.code === 'unauthenticated' ? 'session-expired' : 'safe-fatal-error');
          setMessage(reconciliationError.message);
        }
        return;
      }
      setInitializationState(context, error.code === 'unauthenticated' ? 'session-expired' : 'safe-fatal-error');
      setMessage(error.message);
    }
  }

  function enterManagedExpiry(context = loadedContext) {
    if (!isLoadedContextCurrent(context)) return;
    if (!completionAuthority.current.isManaged() || resultRef.current) return;
    if (!expiryEntered.current) {
      expiryEntered.current = true;
      submissionPreparationGeneration.current += 1;
      setShowFinalSubmitReview(false);
      setIssueOpen(false);
    }
    setState('expiry-status');
    setMessage('Time expired. Checking the status of your saved work.');
  }

  function managedInteractionAllowed() {
    if (loadedInitialization.current && !isLoadedContextCurrent()) return false;
    if (attempt?.attemptId && (attempt.attemptId !== attemptRef.current?.attemptId || loadedAccountId.current !== getCurrentAuthenticatedUserId())) return false;
    const authority = completionAuthority.current;
    if (!authority.isManaged()) return true;
    if (!authority.matches(attemptRef.current?.attemptId, getCurrentAuthenticatedUserId())) return false;
    if (!authority.isLocked()) return true;
    if (authority.isExpired()) enterManagedExpiry();
    return false;
  }

  async function inspectCompletion(attemptId, signal) {
    const startedAt = performance.now();
    try {
      return { status: await client.getCompletionStatus(attemptId, { signal }), startedAt };
    } catch (error) {
      const known = completionAuthority.current;
      if (isExplicitCompletionContractUnsupported(error) && !(known.matches(attemptId, getCurrentAuthenticatedUserId()) && known.isManaged())) return { status: null, startedAt };
      throw error;
    }
  }

  async function recheckManagedAuthority() {
    if (managedRecheck.current) return managedRecheck.current;
    if (!isLoadedContextCurrent() || !completionAuthority.current.isManaged()) return;
    const context = loadedContext;
    const id = attemptRef.current?.attemptId, account = getCurrentAuthenticatedUserId();
    const controller = new AbortController();
    managedRecheckController.current = controller;
    managedRecheck.current = (async () => {
      try {
        const observation = await inspectCompletion(id, AbortSignal.any([controller.signal, context.signal]));
        if (!isLoadedContextCurrent(context) || controller.signal.aborted || id !== attemptRef.current?.attemptId || account !== getCurrentAuthenticatedUserId() || resultRef.current) return;
        if (!observation.status) throw new Error('Managed completion status is unavailable.');
        completionAuthority.current.observe(observation.status, observation.startedAt);
        setManagedStatusError('');
        setAuthorityRevision((n) => n + 1);
        if (completionAuthority.current.isExpired()) enterManagedExpiry(context);
        else if (!submitting.current && !hasUnresolvedSubmission()) setState((current) => current === 'saving' ? 'active' : current);
      } catch (error) {
        if (isLoadedContextCurrent(context) && !controller.signal.aborted && id === attemptRef.current?.attemptId && account === getCurrentAuthenticatedUserId() && !resultRef.current) {
          setManagedStatusError('Status is unavailable. Answering remains paused until the server status can be checked.');
          setAuthorityRevision((n) => n + 1);
        }
      } finally {
        if (managedRecheckController.current === controller) {
          managedRecheckController.current = null;
          managedRecheck.current = null;
        }
      }
    })();
    return managedRecheck.current;
  }

  function completeManagedResult(candidate) {
    if (!isLoadedContextCurrent() && !(hasUnresolvedSubmission() && submissionBinding.current.attemptId === candidate?.attemptId && submissionBinding.current.userId === getCurrentAuthenticatedUserId())) return;
    const confirmed = requireMatchingCompletionResult(candidate, attemptRef.current?.attemptId);
    if (loadedAccountId.current !== getCurrentAuthenticatedUserId() || resultRef.current) return;
    const binding = submissionBinding.current;
    if (binding.attemptId === confirmed.attemptId && binding.userId === getCurrentAuthenticatedUserId()) binding.resolved = true;
    resultRef.current = confirmed;
    setResult(confirmed);
    setMessage('');
    setState('result-available');
  }

  function changeConfiguredLanguage(nextLanguage) {
    configuredLanguageRef.current = nextLanguage;
    setLanguageSelection({ scope: languageScope, value: nextLanguage });
    onCodingLanguagePreferenceChange?.(nextLanguage);
  }

  function changeAnswer(itemId, value) {
    if (!managedInteractionAllowed() || resultRef.current) return;
    if (lifecycleLock.current || discardSummary || submitting.current || hasUnresolvedSubmission()) return;
    commitAnswerDraft((current) => editProtectedAnswerDraft(current, answerOwner(), itemId, value));
    setSaveErrors((current) => ({ ...current, [itemId]: '' }));
  }

  const registerPythonWorkspaceSave = useCallback((itemId, save, context) => {
    if (typeof save === 'function') {
      if (!isLoadedContextCurrent(context)) return;
      pythonWorkspaceSave.current = { itemId, save, context };
    } else if (pythonWorkspaceSave.current?.itemId === itemId && pythonWorkspaceSave.current.context === context) {
      pythonWorkspaceSave.current = null;
    }
  }, []);

  const updatePythonWorkspaceProgress = useCallback((itemId, progress, context) => {
    if (!isLoadedContextCurrent(context)) return;
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

  const loadedWorkspaceHandlers = useMemo(() => ({
    onBusyChange: (busy) => { if (isLoadedContextCurrent(loadedContext)) setPythonLabBusy(busy); },
    onRegisterSave: (itemId, save) => registerPythonWorkspaceSave(itemId, save, loadedContext),
    onWorkspaceStateChange: (itemId, progress) => updatePythonWorkspaceProgress(itemId, progress, loadedContext),
  }), [loadedContext, registerPythonWorkspaceSave, updatePythonWorkspaceProgress]);

  async function saveItem(itemId, { submissionPreparation = false, preparationContext = null } = {}) {
    if (!managedInteractionAllowed() || resultRef.current) return false;
    const saveContext = loadedContext;
    const savedAttemptId = attempt.attemptId, savedAccountId = getCurrentAuthenticatedUserId();
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
      const saved = await registered.save({ signal: AbortSignal.any([operationController.current.signal, saveContext.signal]) });
      if (!isLoadedContextCurrent(saveContext)) return false;
      if (preparationContext && !isCurrentSubmissionPreparation(preparationContext)) return false;
      if (saved) setSaveErrors((current) => ({ ...current, [itemId]: '' }));
      return saved;
    }
    const draft = answerDraftRef.current;
    if (!ownsProtectedAnswerDraft(draft, answerOwner(saveContext))) return false;
    if (!draft.dirtyIds.has(itemId)) return true;
    if (!question) {
      setMessage('This unsaved answer is on another page. Revisit its item before saving or submitting.');
      setState('save-failed');
      return false;
    }
    const sent = { revision: draft.revisions[itemId] ?? 0, edit: draft.edits[itemId], answer: draft.answers[itemId] };
    const epoch = ++requestEpoch.current;
    setState('saving');
    try {
      const saved = await client.saveResponse(
        attempt.attemptId,
        itemId,
        serializeProtectedResponse(question, sent.answer),
        sent.revision,
        crypto.randomUUID(),
        { signal: AbortSignal.any([operationController.current.signal, saveContext.signal]) },
      );
      if (!isLoadedContextCurrent(saveContext)) return false;
      if (preparationContext && !isCurrentSubmissionPreparation(preparationContext)) return false;
      if (epoch !== requestEpoch.current || savedAttemptId !== attemptRef.current?.attemptId || savedAccountId !== getCurrentAuthenticatedUserId() || resultRef.current) return false;
      const acknowledged = commitAnswerDraft((current) => acknowledgeProtectedAnswerDraft(current, answerOwner(saveContext), itemId, sent, saved));
      if (acknowledged.dirtyIds.has(itemId)) {
        setState('save-failed');
        setMessage('The answer changed while saving. Save its current draft before continuing.');
        return false;
      }
      if (!managedInteractionAllowed()) return false;
      if (!submissionPreparation) setState('active');
      return true;
    } catch (error) {
      if (operationController.current.signal.aborted) return false;
      if (!isLoadedContextCurrent(saveContext)) return false;
      if (preparationContext && !isCurrentSubmissionPreparation(preparationContext)) return false;
      if (epoch !== requestEpoch.current || savedAttemptId !== attemptRef.current?.attemptId || savedAccountId !== getCurrentAuthenticatedUserId() || resultRef.current) return false;
      if (!managedInteractionAllowed()) return false;
      setState(error.code === 'unauthenticated' ? 'session-expired' : 'save-failed');
      setSaveErrors((current) => ({ ...current, [itemId]: error.message }));
      return false;
    }
  }

  async function navigate(nextIndex) {
    if (!managedInteractionAllowed() || resultRef.current) return;
    if (lifecycleLock.current || discardSummary || submitting.current || hasUnresolvedSubmission()) return;
    const context = loadedContext;
    if (!(await saveItem(items[currentIndex].id)) || !isLoadedContextCurrent(context)) return;
    if (nextIndex >= items.length && itemPage.hasMore) {
      if (loadingPage.current) return;
      loadingPage.current = context;
      setState('saving');
      try {
        const payload = await client.getAttemptItemPage(attempt.attemptId, itemPage.returnedThrough, 20, {
          signal: AbortSignal.any([operationController.current.signal, context.signal]),
        });
        if (!isLoadedContextCurrent(context) || resultRef.current || !managedInteractionAllowed()) return;
        const rawItems = payload.items ?? [];
        const nextItems = rawItems.map(toPresentationQuestion);
        if (!nextItems.length || payload.afterPosition !== itemPage.returnedThrough) {
          throw Object.assign(new Error('The next protected practice page was not valid.'), { code: 'binding_mismatch' });
        }
        reconcileAnswerItems(rawItems, nextItems, context);
        setItems((currentItems) => [...currentItems, ...nextItems]);
        setItemPage(payload);
        setCurrentIndex(items.length);
        setState('active');
      } catch (error) {
        if (isLoadedContextCurrent(context) && !operationController.current.signal.aborted) {
          setState(error.code === 'unauthenticated' ? 'session-expired' : 'save-failed');
          setMessage(error.message);
        }
      } finally {
        if (loadingPage.current === context) loadingPage.current = false;
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
      if (!requireSettledOrdinaryAnswers()) return;
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
    if (!managedInteractionAllowed() || resultRef.current) return;
    if (attempt?.purpose === 'study_sandbox' || lifecycleLock.current || starting.current || submitting.current || hasUnresolvedSubmission()) return;
    if (!window.confirm('End this attempt? It cannot be resumed. Your progress will be retained for audit, but no completed result will be created.')) return;
    lifecycleLock.current = true;
    setLifecycleOperation('ending');
    const currentItemId = items[currentIndex]?.id;
    try {
      if (currentItemId && !(await saveItem(currentItemId))) return;
      if (!requireSettledOrdinaryAnswers()) return;
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
    if (loadedInitialization.current && !isLoadedContextCurrent()) {
      return !hasUnsavedLoadedWork() && !hasUnresolvedSubmission() && !navigationSave.current && !submitting.current;
    }
    if (completionAuthority.current.isManaged() && completionAuthority.current.isExpired()) return true;
    if (!managedInteractionAllowed()) return false;
    if (navigationSave.current) return navigationSave.current;
    if (state === 'saving' || state === 'submission-preparing' || state === 'submitting' || lifecycleLock.current || discardSummary || submitting.current || hasUnresolvedSubmission()) return false;
    navigationSave.current = (async () => {
      const currentItemId = items[currentIndex]?.id;
      if (currentItemId && !(await saveItem(currentItemId))) return false;
      return requireSettledOrdinaryAnswers();
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
    if (!managedInteractionAllowed() || resultRef.current) return;
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
    if (!managedInteractionAllowed() || resultRef.current) return;
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
    if (!managedInteractionAllowed() || resultRef.current) return;
    if (submitting.current || navigationSave.current || state === 'saving' || pythonLabBusy || hasUnresolvedSubmission()) return;
    if (hasUnloadedDirtyAnswers()) { requireSettledOrdinaryAnswers(); return; }
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
    submissionPreparationContext.current = null;
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
    if (submitting.current || completionReadBusyRef.current) return;
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
    if (submitting.current || completionReadBusyRef.current) return;
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
    const context = {
      attemptId: attempt?.attemptId ?? '',
      userId: getCurrentAuthenticatedUserId(),
      generation: submissionPreparationGeneration.current,
      initialization: loadedContext,
    };
    submissionPreparationContext.current = context;
    return context;
  }

  function isCurrentSubmissionPreparation(context) {
    return isLoadedContextCurrent(context.initialization) && !operationController.current.signal.aborted &&
      context.generation === submissionPreparationGeneration.current &&
      context.attemptId === attemptRef.current?.attemptId &&
      context.userId === getCurrentAuthenticatedUserId() &&
      !hasUnresolvedSubmission() && !resultRef.current && !completionAuthority.current.isLocked();
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
    resultRef.current = authoritativeResult;
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
    if (context.userId !== getCurrentAuthenticatedUserId()) {
      submissionPreparationGeneration.current += 1;
      submitting.current = false;
      setState('session-expired');
      setMessage('The signed-in account changed before final submission was sent. Sign in again before continuing.');
      return;
    }
    if (!isLoadedContextCurrent(context.initialization)) { submitting.current = false; return; }
    if (completionAuthority.current.isManaged() && completionAuthority.current.isExpired() && loadedAccountId.current === getCurrentAuthenticatedUserId()) { submitting.current = false; enterManagedExpiry(); return; }
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

  if (attempt?.attemptId && loadedAccountId.current && loadedAccountId.current !== authenticatedUserId) {
    return <section className="exam-workspace protected-status"><h2>Account changed</h2><p role="alert">{state === 'session-expired' && /signed-in account changed/i.test(message) ? message : 'The signed-in account changed. Sign in with the authorised account before checking this attempt.'}</p><button className="primary-button" type="button" onClick={onExit}>Return to exam dashboard</button></section>;
  }

  const showingSelectedSetup = Boolean(attempt?.attemptId && loadedContext && !isLoadedContextCurrent() &&
    !hasUnresolvedSubmission() && !resultRef.current);
  const currentSetup = isCurrentInitialization(setupPresentation.current?.context) ? setupPresentation.current : null;
  const presentationState = showingSelectedSetup ? currentSetup?.state ?? 'eligibility-loading' : state;
  if (showingSelectedSetup && !['ready', 'ready-active', 'resume-choice', 'pending-discovery', 'safe-fatal-error', 'session-expired'].includes(presentationState)) {
    return <section className="exam-workspace protected-status"><h2>Checking selected exam</h2><p role="status">{message}</p></section>;
  }

  if (presentationState === 'result-available' || (resultRef.current && result?.attemptId === attempt?.attemptId)) {
    if (review) return <ReleasedReviewWorkspace review={review} onReturn={() => setReview(null)} />;
    const reviewWithheld = result?.reviewStatus === 'withheld';
    const reviewReleased = result?.reviewStatus === 'released';
    const domainRows = getDisplayDomainItems(result?.domainBreakdown ?? {}, { examKey, packageVersion: attempt?.packageVersion ?? result?.packageVersion });
    const percentage = result?.rawPercentage == null ? null : Number(result.rawPercentage);
    return (
      <section className="exam-workspace protected-result" aria-labelledby="protected-result-heading">
        <p className="eyebrow">Server-authoritative result</p>
        <h2 id="protected-result-heading">{examConfig.shortName} protected attempt complete</h2>
        <p>{getProfilePresentation({ examKey, profileKey: attempt?.profileKey ?? profileKey, purpose: attempt?.purpose, packageVersion: attempt?.packageVersion, name: attempt?.profileName ?? profile?.name }).name}</p>
        <p>{getProfilePresentation({ examKey, profileKey: attempt?.profileKey ?? profileKey, purpose: attempt?.purpose, packageVersion: attempt?.packageVersion }).note}</p>
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
        {examKey === 'serverplussk0005' && <p>CertSim's 700/1000 practice indicator is not CompTIA's official scaled passing score of 750 and does not predict certification success.</p>}
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

  if ((isLoadedContextCurrent() || hasUnresolvedSubmission()) && attempt?.attemptId && completionAuthority.current.isManaged() && completionAuthority.current.isExpired() && !resultRef.current) {
    const binding = submissionBinding.current;
    const manualRecovery = hasUnresolvedSubmission() ? <section aria-label="Original manual submission recovery">
      <p>The original manual submission binding is retained on this page. Status checking never sends another Submit or saves answers.</p>
      <div className="exam-actions">
        {binding.submitRetryAllowed ? <button className="secondary-button" disabled={submitting.current || completionReadBusy} type="button" onClick={continueSubmission}>Continue submission</button> : null}
        <button className="secondary-button" disabled={submitting.current || completionReadBusy} type="button" onClick={checkSubmissionResult}>Check result</button>
      </div>
    </section> : null;
    return <ProtectedCompletionStatus key={authenticatedUserId + '|' + attempt.attemptId}
      client={client} accountId={authenticatedUserId} attemptId={attempt.attemptId}
      initialStatus={completionAuthority.current.getStatus()} onResult={completeManagedResult}
      onExit={onExit} canRead={() => !submitting.current && !managedRecheck.current}
      onBusyChange={updateCompletionReadBusy} manualRecovery={manualRecovery} />;
  }

  if (presentationState === 'pending-discovery') return <section className="exam-workspace protected-status">
    <h2>Checking pending work</h2><p role="status">{message}</p>
    <button className="secondary-button" type="button" onClick={() => setRefreshNonce((n) => n + 1)}>Check next pending page</button>
    <button className="primary-button" type="button" onClick={showingSelectedSetup ? exitSelectedSetup : onExit}>Return home</button>
  </section>;

  if (['submitting', 'submission-recoverable', 'submission-result-check-recoverable', 'submission-checking'].includes(presentationState) && hasUnresolvedSubmission()) {
    const operationActive = presentationState === 'submitting' || presentationState === 'submission-checking' || submitting.current;
    const submitRetryAllowed = submissionBinding.current.submitRetryAllowed;
    return (
      <section className="exam-workspace protected-status" aria-live="polite" aria-labelledby="protected-submission-heading">
        <p className="eyebrow">Protected final submission</p>
        <h2 id="protected-submission-heading">
          {['submission-recoverable', 'submission-result-check-recoverable'].includes(presentationState) ? 'Final submission needs confirmation' : 'Final submission in progress'}
        </h2>
        <p>{message}</p>
        <p>Your answers and Python workspace are locked. Any available continuation uses the same attempt and submission identity without saving them again.</p>
        <p>Keep this page open. Leaving or reloading is not a supported recovery method.</p>
        <div className="exam-actions">
          {submitRetryAllowed && (
            <button className="primary-button" disabled={operationActive} type="button" onClick={continueSubmission}>
              {presentationState === 'submitting' ? 'Continuing submission...' : 'Continue submission'}
            </button>
          )}
          <button className="secondary-button" disabled={operationActive} type="button" onClick={checkSubmissionResult}>
            {presentationState === 'submission-checking' ? 'Checking result...' : 'Check result'}
          </button>
        </div>
      </section>
    );
  }

  if (!['active', 'saving', 'save-failed', 'submission-preparing'].includes(presentationState)) {
    if (!['safe-fatal-error', 'session-expired'].includes(presentationState)) {
      const selectedLanguage = configuredLanguage || codingLanguagePreference;
      const baseDisplayProfile = activeAttemptConfiguration?.profileKey
        ? examConfig.strictBetaProfiles?.find((entry) => entry.id === activeAttemptConfiguration.profileKey) ?? profile
        : profile;
      const authoritativeQuestionCount = activeAttemptConfiguration?.itemCount ?? availability?.selectedCount;
      const countPolicy = availability?.countPolicy;
      const selectedComposition = activeAttemptConfiguration && countPolicy
        ? { standardQuestionCount: authoritativeQuestionCount, caseStudyCount: 0, caseStudyQuestionCount: 0, pbqCount: 0 }
        : normalizeProfileComposition(availability?.profileComposition);
      const countDisplayProfile = authoritativeQuestionCount
        ? { ...baseDisplayProfile, ...selectedComposition, totalScoredQuestions: authoritativeQuestionCount, countPolicy: activeAttemptConfiguration ? null : countPolicy }
        : { ...baseDisplayProfile, countPolicy };
      const displayProfile = projectProfilePresentation(countDisplayProfile,
        { ...availability, examKey, profileKey: availability?.profileKey ?? profileKey }, activeAttemptConfiguration);
      const canStart = presentationState === 'ready' || presentationState === 'ready-active';
      const isPracticeSession = Boolean(practiceRequest && practiceRequest.purpose !== 'self_directed_exam');
      const hasRecoverableSandboxes = recoverableSandboxes.length > 0;
      const actionLabel = presentationState === 'ready-active'
          ? isPracticeSession ? 'Start new practice' : 'Start new attempt'
        : presentationState === 'ready'
          ? hasRecoverableSandboxes && practiceRequest?.purpose === 'study_sandbox'
            ? 'Start new'
            : isPracticeSession ? 'Start practice' : 'Start exam'
          : presentationState === 'starting'
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
                disabled={hasUnsavedLoadedWork() && candidate.attemptId !== attemptRef.current?.attemptId}
                onClick={() => chooseResumeCandidate(candidate)}
              >
                Resume attempt · {getProfilePresentation({ ...candidate, name: candidate.profileName }).name}
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
                  disabled={hasUnsavedLoadedWork() || Boolean(lifecycleOperation) || (
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
          actionDisabled={!canStart || hasUnsavedLoadedWork() || Boolean(lifecycleOperation) || Boolean(recoveryRetryAttemptId)}
          actionLabel={actionLabel}
          codingLanguagePreference={examConfig.id === 'az204' ? selectedLanguage : null}
          exam={{ ...examConfig, name: examConfig.title ?? examConfig.name }}
          languageLocked={false}
          onBack={showingSelectedSetup ? exitSelectedSetup : onExit}
          onCodingLanguagePreferenceChange={changeConfiguredLanguage}
          onStartExam={presentationState === 'ready-active' ? startNewAttempt : startAttempt}
          protectedDelivery
          practiceSession={isPracticeSession ? {
            purpose: practiceRequest.purpose,
            timed: availability?.timed === true,
            timeLimitMinutes: availability?.timeLimitMinutes ?? null,
            selectedCount: availability?.selectedCount ?? authoritativeQuestionCount,
            countPolicy: availability?.countPolicy ?? null,
            domain: practiceRequest.domain,
            domainLabel: getDomainDisplayLabel({ domainId: practiceRequest.domain, domainLabel: practiceRequest.domain }, { examKey, packageVersion: attempt?.packageVersion ?? availability?.packageVersion }),
            objective: practiceRequest.objective,
            objectiveLabel: examConfig.objectiveGroups?.flatMap((group) => group.objectives)
              .find((objective) => normalizeDomainKey(objective) === practiceRequest.objective) ?? practiceRequest.objective,
            contentKind: practiceRequest.contentKind,
            domains: examConfig.domainNames ?? [],
            onDomainChange: practiceRequest.purpose === 'targeted_domain' && !practiceRequest.objective && onPracticeRequestChange
              ? (domain) => onPracticeRequestChange({ ...practiceRequest, domain: normalizeDomainKey(domain) })
              : null,
          } : null}
          showPrimaryAction={presentationState !== 'ready-active' || Boolean(activeAttemptConfiguration?.replacementPermitted)}
          selectedMode={isPracticeSession
            ? { id: practiceRequest.purpose, name: getPracticeModeName(practiceRequest) }
            : selectedMode ?? { id: 'protected', name: 'Protected exam' }}
          selectedProfile={displayProfile}
          statusMessage={message}
          supplementalContent={<>{showingSelectedSetup && hasUnsavedLoadedWork() ? <p role="alert">Unsaved work is retained in the original attempt. Return to its configuration before starting another attempt.</p> : null}{resumeChoices}{recoveryChoices}</>}
        />
      );
    }
    return (
      <section className="exam-workspace protected-status" aria-live="polite">
        <p className="eyebrow">{practiceRequest ? 'Protected practice' : 'Protected delivery'}</p>
        <h2>{examConfig.shortName}</h2>
        <p>{message}</p>
        <button className="secondary-button" type="button" onClick={showingSelectedSetup ? exitSelectedSetup : onExit}>Return to exam dashboard</button>
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
  const interactionLocked = completionAuthority.current.isLocked() || Boolean(lifecycleOperation) || Boolean(discardSummary) || pythonLabBusy || submitting.current || hasUnresolvedSubmission() || presentationState === 'saving' || presentationState === 'submission-preparing';
  const approvedExam = {
    ...examConfig,
    packageVersion: attempt?.packageVersion,
    code: examConfig.code ?? examConfig.shortName,
    name: examConfig.title ?? examConfig.name ?? examConfig.shortName,
    questions: items,
    normalQuestions,
    pbqQuestions,
    caseStudyBlocks,
    hasSectionedFlow: isSectionedExam,
    profile: profile ? {
      ...projectProfilePresentation(profile, availability, attempt),
      ...attempt?.countContract?.composition,
      totalScoredQuestions: attempt?.countContract?.exactCount ?? items.filter((item) => item.type !== 'case-study-info').length,
    } : null,
    mode: selectedMode,
  };
  const actionControls = <>
    {message && <p className="status-note" role="alert">{message}</p>}
    {managedStatusError ? <p className="error-note" role="alert">{managedStatusError}</p> : null}
    {completionAuthority.current.isManaged() && completionAuthority.current.isLocked() && !completionAuthority.current.isExpired() ? <button className="secondary-button" type="button" onClick={recheckManagedAuthority}>Check answering status</button> : null}
    {saveErrors[current.id] && <p className="incomplete-warning" role="alert">Not saved: {saveErrors[current.id]}</p>}
    {issueStatus && <p className="status-note" role="status">{issueStatus}</p>}
    {itemFeedback[current.id] && <p className="status-note" role="status">{itemFeedback[current.id].status} · {itemFeedback[current.id].earnedPoints} of {itemFeedback[current.id].maxPoints} points</p>}
    <div className="exam-actions">
      <button className={flaggedQuestionIds.includes(current.id) ? 'flag-button active' : 'flag-button'} type="button" disabled={interactionLocked} onClick={() => toggleFlag(current.id)}>{flaggedQuestionIds.includes(current.id) ? 'Remove flag' : 'Flag for review'}</button>
      <button className="secondary-button" disabled={interactionLocked} type="button" onClick={() => { setIssueStatus(''); setIssueOpen(true); }}>Report question issue</button>
      {attempt?.purpose === 'study_sandbox' && !isExecutablePythonLab(current) && <button className="secondary-button" type="button" disabled={interactionLocked} onClick={() => checkPracticeItem(current.id)}>Check saved answer</button>}
      <button className="secondary-button" type="button" disabled={currentIndex === 0 || interactionLocked} onClick={() => navigate(currentIndex - 1)}>Previous</button>
      {currentIndex < items.length - 1 || itemPage.hasMore
        ? <button className="secondary-button" type="button" disabled={interactionLocked} onClick={() => navigate(currentIndex + 1)}>{presentationState === 'saving' ? 'Saving...' : 'Next'}</button>
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
      onTimeExpired={() => { if (completionAuthority.current.isManaged()) { if (completionAuthority.current.isExpired()) enterManagedExpiry(); } else submitAttempt(); }}
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
        canInteract: managedInteractionAllowed,
        ...loadedWorkspaceHandlers,
      }}
      questionStateById={pythonQuestionStateById}
      scoredAnswerSummary={attempt.timed === false
        ? `${answeredCount} answered · ${itemPage.totalCount || items.length} practice items total${itemPage.hasMore ? ' · more load as you continue' : ''}`
        : `${answeredCount} of ${items.filter((item) => item.type !== 'case-study-info').length} scored questions answered`}
      studentName={student?.name}
      timerExpiresAt={attempt.expiresAt}
      timerRemainingSecondsSource={completionAuthority.current.isManaged() ? getManagedRemainingSeconds : undefined}
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
