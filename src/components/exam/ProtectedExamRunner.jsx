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
  submitProtectedAttemptWithRecovery,
} from '../../lib/protectedExamClient.js';
import { getServerRemainingSeconds } from '../../lib/protectedRunnerState.js';
import { assertProtectedAttemptInventory, getProtectedItemSection } from '../../lib/protectedAttemptInventory.js';
import useFullscreenMode from '../../utils/useFullscreenMode.js';
import { getNormalizedDomainItems } from '../../lib/resultStorageMappers.js';
import { resolvePracticeRequest } from '../../lib/protectedPracticeRequest.js';

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
  const client = useMemo(
    () => session?.access_token
      ? createProtectedExamClient({ accessToken: session.access_token })
      : null,
    [session?.access_token],
  );
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
  const [availability, setAvailability] = useState(null);
  const [configuredLanguage, setConfiguredLanguage] = useState(
    examConfig?.id === 'az204' ? (practiceRequest?.language ?? codingLanguagePreference ?? 'csharp') : null,
  );
  const [activeAttemptConfiguration, setActiveAttemptConfiguration] = useState(null);
  const [resumeCandidates, setResumeCandidates] = useState([]);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [itemFeedback, setItemFeedback] = useState({});
  const [flaggedQuestionIds, setFlaggedQuestionIds] = useState([]);
  const [showFinalSubmitReview, setShowFinalSubmitReview] = useState(false);
  const [showQuestionMap, setShowQuestionMap] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [issueOpen, setIssueOpen] = useState(false);
  const [issueMessage, setIssueMessage] = useState('');
  const [issueStatus, setIssueStatus] = useState('');
  const requestEpoch = useRef(0);
  const initializationEpoch = useRef(0);
  const configuredLanguageRef = useRef(configuredLanguage);
  const availabilityRef = useRef(null);
  const practiceRequestRef = useRef(effectivePracticeRequest);
  practiceRequestRef.current = effectivePracticeRequest;
  const submissionId = useRef('');
  const starting = useRef(false);
  const submitting = useRef(false);
  const loadingPage = useRef(false);
  const operationController = useRef(new AbortController());
  const navigationSave = useRef(null);
  const workspaceRef = useRef(null);
  const { fullscreenMessage, fullscreenSupported, isFullscreen, toggleFullscreen } = useFullscreenMode(workspaceRef);

  useEffect(() => {
    operationController.current = new AbortController();
    return () => operationController.current.abort();
  }, []);

  const loadAttempt = useCallback((payload) => {
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
            availabilityRef.current = candidates[0];
            setAvailability(candidates[0]);
            setActiveAttemptConfiguration(candidates[0]);
            setState('ready-active');
            setMessage('An unfinished attempt uses a different language. Resume it, or explicitly start a new attempt if permitted.');
          } else if (candidates.length > 1) {
            setActiveAttemptConfiguration(null);
            setState('resume-choice');
            setMessage('Choose the existing protected attempt you want to resume. No new attempt will be started.');
          } else if (profileCandidates.length > 0) {
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
            setState('ready');
            setMessage(`Ready to start ${preview.selectedCount} protected practice items${preview.adjustedCount ? ' (adjusted to the available pool)' : ''}.`);
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
    loadAttempt(current);
  }

  async function chooseResumeCandidate(candidate) {
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

  async function startAttempt() {
    if (starting.current) return;
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
      setState(error.code === 'unauthenticated' ? 'session-expired' : 'safe-fatal-error');
      setMessage(error.message);
    } finally {
      starting.current = false;
    }
  }

  async function startNewAttempt() {
    if (!activeAttemptConfiguration?.replacementPermitted || starting.current) return;
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
    setAnswers((current) => ({ ...current, [itemId]: value }));
    setDirtyIds((current) => new Set(current).add(itemId));
    setSaveErrors((current) => ({ ...current, [itemId]: '' }));
  }

  async function saveItem(itemId) {
    if (!dirtyIds.has(itemId)) return true;
    const epoch = ++requestEpoch.current;
    setState('saving');
    try {
      const question = items.find((item) => item.id === itemId);
      const saved = await client.saveResponse(
        attempt.attemptId,
        itemId,
        serializeProtectedResponse(question, answers[itemId]),
        revisions[itemId] ?? 0,
        crypto.randomUUID(),
        { signal: operationController.current.signal },
      );
      if (epoch !== requestEpoch.current) return false;
      setRevisions((current) => ({ ...current, [itemId]: saved.revision }));
      setDirtyIds((current) => {
        const next = new Set(current);
        next.delete(itemId);
        return next;
      });
      setState('active');
      return true;
    } catch (error) {
      if (operationController.current.signal.aborted) return false;
      if (epoch !== requestEpoch.current) return false;
      setState(error.code === 'unauthenticated' ? 'session-expired' : 'save-failed');
      setSaveErrors((current) => ({ ...current, [itemId]: error.message }));
      return false;
    }
  }

  async function navigate(nextIndex) {
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

  async function abandonAndExit() {
    if (state === 'saving' || state === 'submitting') return;
    if (!window.confirm('End this attempt? It cannot be resumed. Your progress will be retained for audit, but no completed result will be created.')) return;
    const currentItemId = items[currentIndex]?.id;
    if (currentItemId && !(await saveItem(currentItemId))) return;
    try {
      await client.abandonAttempt(attempt.attemptId, crypto.randomUUID(), {
        signal: operationController.current.signal,
      });
      onExit?.();
    } catch (error) {
      setMessage(error.message);
      setState(error.code === 'unauthenticated' ? 'session-expired' : 'save-failed');
    }
  }

  const saveCurrentResponseBeforeNavigation = useCallback(async () => {
    if (navigationSave.current) return navigationSave.current;
    if (state === 'saving' || state === 'submitting') return false;
    navigationSave.current = (async () => {
      const currentItemId = items[currentIndex]?.id;
      return currentItemId ? saveItem(currentItemId) : true;
    })();
    try {
      return await navigationSave.current;
    } finally {
      navigationSave.current = null;
    }
  }, [answers, attempt?.attemptId, client, currentIndex, dirtyIds, items, revisions, state]);

  useEffect(() => {
    onRegisterNavigationGuard?.(saveCurrentResponseBeforeNavigation);
    return () => onRegisterNavigationGuard?.(null);
  }, [onRegisterNavigationGuard, saveCurrentResponseBeforeNavigation]);

  async function toggleFlag(itemId) {
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
    if (!issueMessage.trim()) { setIssueStatus('Describe the issue before sending it.'); return; }
    setIssueStatus('Sending issue report...');
    try {
      await client.reportQuestionIssue(attempt.attemptId, items[currentIndex].id, issueMessage.trim(), crypto.randomUUID(), { signal: operationController.current.signal });
      setIssueMessage(''); setIssueOpen(false); setIssueStatus('Issue report received.');
    } catch (error) { setIssueStatus(error.message); }
  }

  async function checkPracticeItem(itemId) {
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
    if (submitting.current) return;
    submitting.current = true;
    setState('submitting');
    for (const itemId of [...dirtyIds]) {
      if (!(await saveItem(itemId))) {
        submitting.current = false;
        return;
      }
    }
    try {
      submissionId.current ||= crypto.randomUUID();
      const options = { signal: operationController.current.signal };
      const { payload: submitted } = await submitProtectedAttemptWithRecovery(
        client,
        attempt.attemptId,
        submissionId.current,
        options,
      );
      setResult(requireProtectedAuthoritativeResult(
        submitted.result ?? (await client.getResult(attempt.attemptId, options)).result,
      ));
      setState('result-available');
    } catch (error) {
      setState(error.code === 'unauthenticated' ? 'session-expired' : 'safe-fatal-error');
      setMessage(error.message);
    } finally {
      submitting.current = false;
    }
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
        : error.message);
    }
  }

  if (state === 'result-available') {
    const reviewWithheld = result?.reviewStatus === 'withheld';
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
        {reviewWithheld && (
          <p className="status-note" role="status">
            Question review and answers are withheld for this attempt.
          </p>
        )}
        <div className="exam-actions">
          {!reviewWithheld && <button className="secondary-button" type="button" onClick={loadReview}>View released review</button>}
          <button className="primary-button" type="button" onClick={onExit}>Return home</button>
        </div>
        {reviewMessage && <p role="status">{reviewMessage}</p>}
        {review && (
          <section className="protected-review-list" aria-labelledby="protected-review-heading">
            <h3 id="protected-review-heading">Released question review</h3>
            <p role="status">{review.items.length} review items released by the server.</p>
            {review.items.map((item) => (
              <article className="selected-profile-panel" key={item.itemId}>
                <p className="eyebrow">Question {item.questionNumber} · {item.questionId}</p>
                <h4>{item.presentation?.stem ?? item.presentation?.prompt ?? item.presentation?.question ?? item.presentation?.title ?? 'Question review'}</h4>
                <dl className="exam-stats compact">
                  <div><dt>Result</dt><dd>{item.status ?? 'Recorded'}</dd></div>
                  <div><dt>Points</dt><dd>{item.earnedPoints != null && item.maxPoints != null ? `${item.earnedPoints} / ${item.maxPoints}` : 'Not recorded'}</dd></div>
                  <div><dt>Your response</dt><dd>{formatReviewValue(item.response)}</dd></div>
                  <div><dt>Correct answer</dt><dd>{formatReviewValue(item.correctAnswer)}</dd></div>
                </dl>
                {item.explanation && <p><strong>Explanation:</strong> {item.explanation}</p>}
                {item.remediation && <p><strong>Next step:</strong> {item.remediation}</p>}
              </article>
            ))}
          </section>
        )}
      </section>
    );
  }

  if (!['active', 'saving', 'save-failed', 'submitting'].includes(state)) {
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
      const actionLabel = state === 'ready-active'
          ? isPracticeSession ? 'Start new practice' : 'Start new attempt'
        : state === 'ready'
          ? isPracticeSession ? 'Start practice' : 'Start exam'
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
      return (
        <StudentDetails
          accountStudent={student}
          actionDisabled={!canStart}
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
            contentKind: practiceRequest.contentKind,
            domains: examConfig.domainNames ?? [],
            onDomainChange: practiceRequest.purpose === 'targeted_domain' && onPracticeRequestChange
              ? (domain) => onPracticeRequestChange({ ...practiceRequest, domain: normalizeDomainKey(domain) })
              : null,
          } : null}
          showPrimaryAction={state !== 'ready-active' || Boolean(activeAttemptConfiguration?.replacementPermitted)}
          selectedMode={isPracticeSession
            ? { id: practiceRequest.purpose, name: getPracticeModeName(practiceRequest) }
            : selectedMode ?? { id: 'protected', name: 'Protected exam' }}
          selectedProfile={displayProfile}
          statusMessage={message}
          supplementalContent={resumeChoices}
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
  const answeredCount = items.filter((item) => getProtectedQuestionState(item, answers) === 'answered').length;
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
    {saveErrors[current.id] && <p className="incomplete-warning" role="alert">Not saved: {saveErrors[current.id]}</p>}
    {issueStatus && <p className="status-note" role="status">{issueStatus}</p>}
    {itemFeedback[current.id] && <p className="status-note" role="status">{itemFeedback[current.id].status} · {itemFeedback[current.id].earnedPoints} of {itemFeedback[current.id].maxPoints} points</p>}
    <div className="exam-actions">
      <button className={flaggedQuestionIds.includes(current.id) ? 'flag-button active' : 'flag-button'} type="button" disabled={state === 'saving'} onClick={() => toggleFlag(current.id)}>{flaggedQuestionIds.includes(current.id) ? 'Remove flag' : 'Flag for review'}</button>
      <button className="secondary-button" type="button" onClick={() => { setIssueStatus(''); setIssueOpen(true); }}>Report question issue</button>
      {practiceRequest?.purpose === 'study_sandbox' && <button className="secondary-button" type="button" disabled={state === 'saving'} onClick={() => checkPracticeItem(current.id)}>Check saved answer</button>}
      <button className="secondary-button" type="button" disabled={currentIndex === 0 || state === 'saving'} onClick={() => navigate(currentIndex - 1)}>Previous</button>
      {currentIndex < items.length - 1 || itemPage.hasMore
        ? <button className="secondary-button" type="button" disabled={state === 'saving'} onClick={() => navigate(currentIndex + 1)}>{state === 'saving' ? 'Saving...' : 'Next'}</button>
        : <button className="primary-button" type="button" disabled={state === 'saving' || state === 'submitting'} onClick={() => setShowFinalSubmitReview(true)}>Submit exam</button>}
    </div>
  </>;
  const overlays = <>
    {showFinalSubmitReview && <ProtectedFinalSubmitReview answers={answers} exam={approvedExam} flaggedQuestionIds={flaggedQuestionIds} onNavigateToItem={(index) => { setShowFinalSubmitReview(false); setCurrentIndex(index); }} onReturnToExam={() => setShowFinalSubmitReview(false)} onSubmitFinal={submitAttempt} questions={items} remainingSeconds={remainingSeconds} />}
    {issueOpen && <div className="modal-backdrop" role="presentation"><form className="modal" role="dialog" aria-modal="true" aria-labelledby="protected-issue-heading" onSubmit={submitIssue}><h2 id="protected-issue-heading">Report a question issue</h2><p>Question {current.questionNumber ?? currentIndex + 1}. Do not include passwords or personal information.</p><label htmlFor="protected-issue-message">What appears to be wrong?</label><textarea id="protected-issue-message" maxLength={2000} required rows={5} value={issueMessage} onChange={(event) => setIssueMessage(event.target.value)} /><div className="modal-actions"><button className="secondary-button" type="button" onClick={() => setIssueOpen(false)}>Cancel</button><button className="primary-button" type="submit">Send report</button></div></form></div>}
  </>;
  return <ExamWorkspacePresentation
      actionControls={actionControls}
      answers={answers}
      caseStudyBlocks={caseStudyBlocks}
      currentIndex={currentIndex}
      currentSection={getProtectedSection(current)}
      exam={approvedExam}
      exitLabel="End attempt"
      flaggedQuestionIds={flaggedQuestionIds}
      fullscreenMessage={fullscreenMessage}
      fullscreenSupported={fullscreenSupported}
      isFullscreen={isFullscreen}
      isQuestionMapOpen={showQuestionMap}
      isSectionedExam={approvedExam.hasSectionedFlow}
      navigatorQuestions={items}
      normalQuestions={normalQuestions}
      onAnswerChange={changeAnswer}
      onCloseQuestionMap={() => setShowQuestionMap(false)}
      onExit={abandonAndExit}
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
      scoredAnswerSummary={attempt.timed === false
        ? `${answeredCount} answered · ${itemPage.totalCount || items.length} practice items total${itemPage.hasMore ? ' · more load as you continue' : ''}`
        : `${answeredCount} of ${items.filter((item) => item.type !== 'case-study-info').length} scored questions answered`}
      studentName={student?.name}
      timerExpiresAt={attempt.expiresAt}
      timed={attempt.timed !== false}
      workspaceRef={workspaceRef}
    />;
}

function formatReviewValue(value) {
  if (value === null || value === undefined || value === '') return 'No response recorded';
  if (Array.isArray(value)) return value.map(formatReviewValue).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, entry]) => `${key}: ${formatReviewValue(entry)}`)
      .join('; ');
  }
  return String(value);
}

function getProtectedQuestionState(question, answers) {
  if (question.type === 'case-study-info') return 'info';
  const value = answers[question.id];
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
