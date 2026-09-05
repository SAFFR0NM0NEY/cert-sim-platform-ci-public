import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ITDirectionAssessmentIntro,
  ITDirectionAssessmentResults,
  ITDirectionAssessmentRunner,
} from './components/assessment/ITDirectionAssessment.jsx';
import AccountPage from './components/account/AccountPage.jsx';
import MyAssignmentsPage from './components/account/MyAssignmentsPage.jsx';
import MyReportsPage from './components/account/MyReportsPage.jsx';
import StudentProgressPage from './components/account/StudentProgressPage.jsx';
import CampusDetailPage from './components/admin/CampusDetailPage.jsx';
import GroupDetailPage from './components/admin/GroupDetailPage.jsx';
import OrganisationManagementPage from './components/admin/OrganisationManagementPage.jsx';
import OrganisationDetailPage from './components/admin/OrganisationDetailPage.jsx';
import DeveloperDashboardPage from './components/developer/DeveloperDashboardPage.jsx';
import DeveloperReportDetailPage from './components/developer/DeveloperReportDetailPage.jsx';
import ErrorBoundary from './components/layout/ErrorBoundary.jsx';
import Header from './components/layout/Header.jsx';
import { PrivacyPage, TermsPage } from './components/legal/LegalPage.jsx';
import Home from './components/exam/Home.jsx';
import CaseStudyPractice from './components/exam/CaseStudyPractice.jsx';
import JoinPage from './components/onboarding/JoinPage.jsx';
import ReceptionPlacementDashboardPage from './components/reception/ReceptionPlacementDashboardPage.jsx';
import TrainerDashboardPage from './components/trainer/TrainerDashboardPage.jsx';
import TrainerAssignmentDetailPage from './components/trainer/TrainerAssignmentDetailPage.jsx';
import TrainerStudentDetailPage from './components/trainer/TrainerStudentDetailPage.jsx';
import StudentDetails from './components/exam/StudentDetails.jsx';
import ExamRunner from './components/exam/ExamRunner.jsx';
import ProtectedExamRunner from './components/exam/ProtectedExamRunner.jsx';
import ProtectedTargetedDomainSetup from './components/exam/ProtectedTargetedDomainSetup.jsx';
import ExamResults from './components/exam/ExamResults.jsx';
import ExamReview from './components/exam/ExamReview.jsx';
import StudySandbox from './components/exam/StudySandbox.jsx';
import SavedResultsPage from './components/results/SavedResultsPage.jsx';
import {
  getActiveHeaderDestination,
  isFocusedAttemptScreen,
} from './lib/navigationRules.js';
import { createWeakAreaPracticeAttempt } from './utils/weakAreaPractice.js';
import {
  defaultExamConfig,
  examRegistry,
  getExamConfigById,
  isDraftExamConfig,
  isLiveVisibleExamConfig,
  liveVisibleExamConfigs,
} from './exams/examRegistry.js';
import {
  EXAM_LIFECYCLES,
  getExamLifecycle,
  isStartableLifecycle,
} from './exams/examLifecycle.js';
import {
  clearAttemptHistory,
  createAttemptHistoryRecord,
  getAttemptHistory,
  saveAttemptHistoryRecord,
} from './utils/attemptHistory.js';
import {
  DEFAULT_CODING_LANGUAGE_PREFERENCE,
  normalizeCodingLanguagePreference,
} from './utils/codingLanguage.js';
import { generateExamAttempt } from './utils/generateExamAttempt.js';
import { generateAz400SectionedAttempt } from './utils/generateAz400SectionedAttempt.js';
import { generateSecurityPlusStrictBetaAttempt } from './utils/generateSecurityPlusStrictBetaAttempt.js';
import { itDirectionAssessment } from './assessments/itDirection/itDirectionAssessment.js';
import useCurrentIdentity from './hooks/useCurrentIdentity.js';
import { validateItDirectionAssessment } from './utils/itDirectionScoring.js';
import { validateExamRegistry } from './utils/validateExamRegistry.js';
import { validateQuestionBank } from './utils/validateQuestionBank.js';
import {
  canUseSignedInStudentIdentity,
  createStudentDetailsFromIdentity,
  shouldWaitForSignedInStudentIdentity,
} from './lib/studentAttemptIdentity.js';
import { savePlacementAssessmentResult } from './lib/placementResultService.js';
import {
  DELIVERY_MODES,
  protectedDeliveryMode,
} from './lib/protectedDeliveryMode.js';
import {
  getProtectedExamKey,
  getProtectedProfileKey,
} from './lib/protectedExamContract.js';
import { requestProtectedNavigation } from './lib/protectedNavigationGuard.js';

const showDraftExamAccess =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_DRAFT_EXAMS === 'true';
const visibleExamConfigs = showDraftExamAccess ? examRegistry : liveVisibleExamConfigs;
const selectedExamStorageKey = 'certsim.selectedExam.v1';
const az204CodingLanguageStorageKey = 'certsim.az204.codingLanguage.v1';
const examRouteSlugs = Object.fromEntries(
  examRegistry
    .filter((examConfig) => examConfig.slug)
    .map((examConfig) => [examConfig.id, examConfig.slug]),
);
const initialLastSelectedExamConfig = getInitialLastSelectedExamConfig();
const validationExamConfig = initialLastSelectedExamConfig ?? defaultExamConfig;

if (import.meta.env.DEV) {
  const validationIssues = validateQuestionBank(
    validationExamConfig.questionBank,
    validationExamConfig.generationConfig,
  );

  if (validationIssues.length === 0) {
    console.info(
      `[CertSim] ${validationExamConfig.code} question bank validation passed with ${validationExamConfig.questionBank.length} items.`,
    );
  } else {
    validationIssues.forEach((issue) => {
      const message = `[CertSim] ${issue.questionId}: ${issue.message}`;

      if (issue.level === 'error') {
        console.error(message);
      } else {
        console.warn(message);
      }
    });
  }

  const assessmentIssues = validateItDirectionAssessment(itDirectionAssessment);

  if (assessmentIssues.length === 0) {
    console.info(
      `[CertSim] ${itDirectionAssessment.title} validation passed with ${itDirectionAssessment.items.length} items.`,
    );
  } else {
    assessmentIssues.forEach((issue) => console.warn(`[CertSim] ${issue}`));
  }

  const registryIssues = validateExamRegistry(examRegistry);

  if (registryIssues.length === 0) {
    console.info(
      `[CertSim] exam registry validation passed with ${examRegistry.length} exams.`,
    );
  } else {
    registryIssues.forEach((issue) => {
      const message = `[CertSim] ${issue.examId}: ${issue.message}`;

      if (issue.level === 'error') {
        console.error(message);
      } else {
        console.warn(message);
      }
    });
  }
}

export default function App() {
  const currentIdentity = useCurrentIdentity();
  const initialRouteTargetRef = useRef(null);

  if (!initialRouteTargetRef.current) {
    initialRouteTargetRef.current = getInitialRouteTarget();
  }

  const initialRouteTarget = initialRouteTargetRef.current;
  const [selectedExamConfig, setSelectedExamConfig] = useState(
    initialRouteTarget.examConfig ?? null,
  );
  const [lastSelectedExamConfig, setLastSelectedExamConfig] = useState(
    initialRouteTarget.examConfig ?? initialLastSelectedExamConfig,
  );
  const selectedExam = selectedExamConfig
    ? createSelectedExamSummary(selectedExamConfig)
    : null;
  const lastSelectedExam = lastSelectedExamConfig
    ? createSelectedExamSummary(lastSelectedExamConfig)
    : null;
  const [screen, setScreen] = useState(initialRouteTarget.screen);
  const [activeExam, setActiveExam] = useState(null);
  const [student, setStudent] = useState(null);
  const [result, setResult] = useState(null);
  const [itDirectionResult, setItDirectionResult] = useState(null);
  const [itDirectionClient, setItDirectionClient] = useState(null);
  const [itDirectionSaveStatus, setItDirectionSaveStatus] = useState({
    status: 'idle',
    message: '',
  });
  const [selectedMode, setSelectedMode] = useState(
    initialRouteTarget.selectedMode ?? null,
  );
  const [selectedProfile, setSelectedProfile] = useState(
    initialRouteTarget.selectedProfile ?? null,
  );
  const [az204CodingLanguagePreference, setAz204CodingLanguagePreference] =
    useState(readAz204CodingLanguagePreference);
  const [pbqPreviewComponent, setPbqPreviewComponent] = useState(null);
  const [pbqPreviewLabs, setPbqPreviewLabs] = useState(
    initialRouteTarget.pbqPreviewLabs ?? [],
  );
  const [practiceExamConfig, setPracticeExamConfig] = useState(
    initialRouteTarget.practiceExamConfig ?? null,
  );
  const [protectedPracticeRequest, setProtectedPracticeRequest] = useState(null);
  const [notFoundPath, setNotFoundPath] = useState(
    initialRouteTarget.notFoundPath ?? '',
  );
  const [savedResultAttemptId, setSavedResultAttemptId] = useState(
    initialRouteTarget.savedResultAttemptId ?? '',
  );
  const [weakAreaPracticeExamId, setWeakAreaPracticeExamId] = useState('');
  const [openWeakAreaPractice, setOpenWeakAreaPractice] = useState(false);
  const [savedResultsReturnTarget, setSavedResultsReturnTarget] = useState('');
  const [trainerStudentId, setTrainerStudentId] = useState(
    initialRouteTarget.trainerStudentId ?? '',
  );
  const [trainerAssignmentId, setTrainerAssignmentId] = useState(
    initialRouteTarget.trainerAssignmentId ?? '',
  );
  const [learnerAssignmentId, setLearnerAssignmentId] = useState(
    initialRouteTarget.learnerAssignmentId ?? '',
  );
  const [trainerResultId, setTrainerResultId] = useState(
    initialRouteTarget.trainerResultId ?? '',
  );
  const [developerReportId, setDeveloperReportId] = useState(
    initialRouteTarget.developerReportId ?? '',
  );
  const [adminOrganisationId, setAdminOrganisationId] = useState(
    initialRouteTarget.adminOrganisationId ?? '',
  );
  const [adminCampusId, setAdminCampusId] = useState(
    initialRouteTarget.adminCampusId ?? '',
  );
  const [adminGroupId, setAdminGroupId] = useState(
    initialRouteTarget.adminGroupId ?? '',
  );
  const [joinInviteToken, setJoinInviteToken] = useState(
    initialRouteTarget.joinInviteToken ?? '',
  );
  const [attemptHistoryState, setAttemptHistoryState] =
    useState(() =>
      initialRouteTarget.examConfig
        ? getAttemptHistory(initialRouteTarget.examConfig.id)
        : {
            records: [],
            error: null,
          },
    );
  const PBQPreviewComponent = pbqPreviewComponent;
  const historySyncRef = useRef({
    initialized: false,
    isApplyingPopState: false,
  });
  const protectedNavigationGuardRef = useRef(null);
  const signedInStudentStartRef = useRef('');
  const renderBoundaryKey = [
    screen,
    selectedExamConfig?.id ?? '',
    practiceExamConfig?.id ?? '',
    activeExam?.generatedAt ?? '',
    result?.submittedAt ?? '',
    itDirectionResult?.completedAt ?? '',
    itDirectionClient?.displayName ?? '',
    savedResultAttemptId,
    trainerStudentId,
    trainerAssignmentId,
    developerReportId,
    adminOrganisationId,
    adminCampusId,
    adminGroupId,
    joinInviteToken,
    currentIdentity.isPlatformOwner ? 'owner' : '',
  ].join(':');

  const runProtectedNavigation = useCallback((navigate) => requestProtectedNavigation({
    isProtectedAttempt: screen === 'exam' && activeExam?.deliveryMode === DELIVERY_MODES.protected,
    navigate,
    saveCurrentResponse: protectedNavigationGuardRef.current,
  }), [activeExam?.deliveryMode, screen]);
  const registerProtectedNavigationGuard = useCallback((guard) => {
    protectedNavigationGuardRef.current = guard;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.requestAnimationFrame(() => {
      window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
      const heading = document.querySelector('main h1, main h2');
      if (heading instanceof HTMLElement) {
        heading.dataset.routeFocusTarget = 'true';
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
    });
  }, [screen]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.history) {
      return;
    }

    const nextPath = getPathForCurrentState({
      notFoundPath,
      practiceExamConfig,
      result,
      screen,
      selectedExamConfig,
      selectedMode,
      selectedProfile,
      savedResultAttemptId,
      trainerStudentId,
      trainerAssignmentId,
      trainerResultId,
      developerReportId,
      adminOrganisationId,
      adminCampusId,
      adminGroupId,
      joinInviteToken,
      learnerAssignmentId,
    });
    const nextState = {
      certsim: true,
      routePath: nextPath,
      screen,
      selectedExamId: selectedExamConfig?.id ?? practiceExamConfig?.id ?? null,
      selectedModeId: selectedMode?.id ?? null,
      selectedProfileId: selectedProfile?.id ?? null,
      savedResultAttemptId: savedResultAttemptId || null,
      trainerStudentId: trainerStudentId || null,
      trainerAssignmentId: trainerAssignmentId || null,
      trainerResultId: trainerResultId || null,
      developerReportId: developerReportId || null,
      adminOrganisationId: adminOrganisationId || null,
      adminCampusId: adminCampusId || null,
      adminGroupId: adminGroupId || null,
      joinInviteToken: joinInviteToken || null,
      learnerAssignmentId: learnerAssignmentId || null,
    };

    if (!historySyncRef.current.initialized) {
      window.history.replaceState(nextState, '', nextPath);
      historySyncRef.current.initialized = true;
      return;
    }

    if (historySyncRef.current.isApplyingPopState) {
      historySyncRef.current.isApplyingPopState = false;
      return;
    }

    if (
      !window.history.state?.certsim ||
      window.history.state?.screen !== screen ||
      `${window.location.pathname}${window.location.search}` !== nextPath
    ) {
      window.history.pushState(nextState, '', nextPath);
    }
  }, [
    notFoundPath,
    practiceExamConfig,
    result,
    screen,
    selectedExamConfig,
    selectedMode,
    selectedProfile,
    savedResultAttemptId,
    trainerStudentId,
    trainerAssignmentId,
    trainerResultId,
    developerReportId,
    adminOrganisationId,
    adminCampusId,
    adminGroupId,
    joinInviteToken,
    learnerAssignmentId,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    async function handlePopState(event) {
      const requestedPath = window.location.pathname;
      const requestedState = event.state;
      if (screen === 'exam' && activeExam?.deliveryMode === DELIVERY_MODES.protected) {
        const saved = await runProtectedNavigation(() => {});
        if (!saved) {
          const currentPath = getPathForCurrentState({
            notFoundPath,
            practiceExamConfig,
            result,
            screen,
            selectedExamConfig,
            selectedMode,
            selectedProfile,
            savedResultAttemptId,
            trainerStudentId,
            trainerAssignmentId,
            trainerResultId,
            developerReportId,
            adminOrganisationId,
            adminCampusId,
            adminGroupId,
            joinInviteToken,
            learnerAssignmentId,
          });
          window.history.pushState({
            certsim: true,
            routePath: currentPath,
            screen,
            selectedExamId: selectedExamConfig?.id ?? null,
            selectedModeId: selectedMode?.id ?? null,
            selectedProfileId: selectedProfile?.id ?? null,
          }, '', currentPath);
          return;
        }
      }
      historySyncRef.current.isApplyingPopState = true;
      setLearnerAssignmentId(
        requestedState?.learnerAssignmentId ?? getValidAssignmentId(window.location.search),
      );

      if (requestedState?.screen === 'trainer-assignment-detail') {
        const nextAssignmentId = requestedState.trainerAssignmentId ?? '';

        setTrainerAssignmentId(nextAssignmentId);
        setScreen(nextAssignmentId ? 'trainer-assignment-detail' : 'trainer-dashboard');
        return;
      }

      if (requestedState?.screen === 'developer-report-detail') {
        const nextReportId = requestedState.developerReportId ?? '';

        setDeveloperReportId(nextReportId);
        setScreen(nextReportId ? 'developer-report-detail' : 'developer-dashboard');
        return;
      }

      if (requestedState?.screen === 'admin-organisation-detail') {
        const nextOrganisationId = requestedState.adminOrganisationId ?? '';

        setAdminOrganisationId(nextOrganisationId);
        setScreen(nextOrganisationId ? 'admin-organisation-detail' : 'admin-organisations');
        return;
      }

      if (requestedState?.screen === 'admin-campus-detail') {
        const nextCampusId = requestedState.adminCampusId ?? '';

        setAdminCampusId(nextCampusId);
        setScreen(nextCampusId ? 'admin-campus-detail' : 'admin-organisations');
        return;
      }

      if (requestedState?.screen === 'admin-group-detail') {
        const nextGroupId = requestedState.adminGroupId ?? '';

        setAdminGroupId(nextGroupId);
        setScreen(nextGroupId ? 'admin-group-detail' : 'admin-organisations');
        return;
      }

      if (requestedState?.screen === 'join') {
        setJoinInviteToken(requestedState.joinInviteToken ?? '');
        setScreen('join');
        return;
      }

      if (requestedState?.certsim && isRestorableHistoryScreen(requestedState.screen)) {
        setScreen(getSafeScreenForCurrentState(requestedState.screen));
        return;
      }

      applyRouteTarget(getRouteTargetForPath(requestedPath, window.location.search));
    }

    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [
    activeExam,
    itDirectionResult,
    pbqPreviewComponent,
    practiceExamConfig,
    result,
    savedResultAttemptId,
    trainerAssignmentId,
    trainerStudentId,
    adminOrganisationId,
    adminCampusId,
    adminGroupId,
    selectedExamConfig,
    selectedMode,
    selectedProfile,
    student,
    screen,
    runProtectedNavigation,
    notFoundPath,
    developerReportId,
    joinInviteToken,
    learnerAssignmentId,
  ]);

  useEffect(() => {
    if (learnerAssignmentId && (screen === 'home' || screen === 'browse-exams')) {
      setLearnerAssignmentId('');
    }
  }, [learnerAssignmentId, screen]);

  useEffect(() => {
    if (
      screen !== 'pbq-preview' ||
      !selectedExamConfig ||
      PBQPreviewComponent ||
      !selectedExamConfig.supportedFeatures?.pbqLabs &&
      (selectedExamConfig.demoLabs?.length ?? 0) === 0
    ) {
      return undefined;
    }

    let isCancelled = false;

    async function loadPBQPreviewComponent() {
      const { default: PBQRenderer } = await import('./components/pbq/PBQRenderer.jsx');

      if (isCancelled) {
        return;
      }

      setPbqPreviewComponent(() => PBQRenderer);
      setPbqPreviewLabs(selectedExamConfig.demoLabs ?? []);
    }

    loadPBQPreviewComponent();

    return () => {
      isCancelled = true;
    };
  }, [PBQPreviewComponent, screen, selectedExamConfig]);

  useEffect(() => {
    if (typeof window === 'undefined' || screen !== 'exam' || !activeExam) {
      return undefined;
    }

    function handleBeforeUnload(event) {
      event.preventDefault();
      event.returnValue = '';
      return '';
    }

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [activeExam, screen]);

  useEffect(() => {
    if (
      screen !== 'student' ||
      !selectedExamConfig ||
      !selectedMode ||
      !selectedProfile
    ) {
      signedInStudentStartRef.current = '';
      return;
    }

    if (shouldWaitForSignedInStudentIdentity(currentIdentity)) {
      return;
    }

    if (!canUseSignedInStudentIdentity(currentIdentity)) {
      signedInStudentStartRef.current = '';
      return;
    }

    const startKey = [
      selectedExamConfig.id,
      selectedMode.id,
      selectedProfile.id,
      currentIdentity.user?.id ?? currentIdentity.userEmail ?? currentIdentity.user?.email ?? '',
      currentIdentity.profile?.display_name ?? currentIdentity.profile?.full_name ?? '',
    ].join(':');

    if (signedInStudentStartRef.current === startKey) {
      return;
    }

    signedInStudentStartRef.current = startKey;
    handleStartExam(createStudentDetailsFromIdentity(currentIdentity));
  }, [
    currentIdentity.isAuthenticated,
    currentIdentity.isSupabaseConfigured,
    currentIdentity.loading,
    currentIdentity.profile?.display_name,
    currentIdentity.profile?.email,
    currentIdentity.profile?.full_name,
    currentIdentity.user?.email,
    currentIdentity.user?.id,
    currentIdentity.userEmail,
    screen,
    selectedExamConfig,
    selectedMode,
    selectedProfile,
  ]);

  function getSafeScreenForCurrentState(requestedScreen) {
    if (requestedScreen === 'home' || requestedScreen === 'browse-exams') {
      return requestedScreen;
    }

    if (requestedScreen === 'privacy' || requestedScreen === 'terms') {
      return requestedScreen;
    }

    if (requestedScreen === 'exam-dashboard') {
      return selectedExamConfig ? 'exam-dashboard' : 'browse-exams';
    }

    if (requestedScreen === 'student') {
      return selectedExamConfig && selectedMode && selectedProfile
        ? 'student'
        : selectedExamConfig
          ? 'exam-dashboard'
          : 'browse-exams';
    }

    if (requestedScreen === 'exam') {
      if (student && activeExam) {
        return 'exam';
      }

      if (result) {
        return 'results';
      }

      return selectedExamConfig ? 'exam-dashboard' : 'browse-exams';
    }

    if (requestedScreen === 'results' || requestedScreen === 'review') {
      return result ? requestedScreen : selectedExamConfig ? 'exam-dashboard' : 'home';
    }

    if (requestedScreen === 'sandbox' || requestedScreen === 'targeted-practice') {
      return practiceExamConfig ? requestedScreen : selectedExamConfig ? 'exam-dashboard' : 'browse-exams';
    }

    if (requestedScreen === 'pbq-preview') {
      return pbqPreviewComponent && selectedExamConfig
        ? 'pbq-preview'
        : selectedExamConfig
          ? 'exam-dashboard'
          : 'browse-exams';
    }

    if (requestedScreen === 'case-study-preview') {
      return practiceExamConfig
        ? 'case-study-preview'
        : selectedExamConfig
          ? 'exam-dashboard'
          : 'browse-exams';
    }

    if (
      requestedScreen === 'it-direction-intro' ||
      requestedScreen === 'it-direction-runner'
    ) {
      return requestedScreen;
    }

    if (requestedScreen === 'it-direction-results') {
      return itDirectionResult ? 'it-direction-results' : 'it-direction-intro';
    }

    if (requestedScreen === 'strict-unavailable') {
      return 'strict-unavailable';
    }

    if (requestedScreen === 'not-found') {
      return 'not-found';
    }

    if (requestedScreen === 'join') {
      return 'join';
    }

    if (
      requestedScreen === 'account' ||
      requestedScreen === 'account-assignments' ||
      requestedScreen === 'account-progress' ||
      requestedScreen === 'reception-placement' ||
      requestedScreen === 'developer-dashboard'
    ) {
      return requestedScreen;
    }

    if (requestedScreen === 'developer-report-detail') {
      return developerReportId ? 'developer-report-detail' : 'developer-dashboard';
    }

    if (requestedScreen === 'saved-results') {
      return 'saved-results';
    }

    if (requestedScreen === 'saved-result-detail') {
      return savedResultAttemptId ? 'saved-result-detail' : 'saved-results';
    }

    if (requestedScreen === 'admin-organisations') {
      return 'admin-organisations';
    }

    if (requestedScreen === 'admin-organisation-detail') {
      return adminOrganisationId
        ? 'admin-organisation-detail'
        : 'admin-organisations';
    }

    if (requestedScreen === 'admin-campus-detail') {
      return adminCampusId ? 'admin-campus-detail' : 'admin-organisations';
    }

    if (requestedScreen === 'admin-group-detail') {
      return adminGroupId ? 'admin-group-detail' : 'admin-organisations';
    }

    if (requestedScreen.startsWith('trainer-dashboard')) {
      return requestedScreen;
    }

    if (requestedScreen === 'trainer-student-detail') {
      return trainerStudentId ? 'trainer-student-detail' : 'trainer-dashboard';
    }

    if (requestedScreen === 'trainer-assignment-detail') {
      return trainerAssignmentId
        ? 'trainer-assignment-detail'
        : 'trainer-dashboard';
    }

    return 'home';
  }

  function applyRouteTarget(target) {
    setLearnerAssignmentId(target.learnerAssignmentId ?? '');

    if (target.screen === 'home') {
      setScreen('home');
      setActiveExam(null);
      setStudent(null);
      setResult(null);
      setItDirectionResult(null);
      setItDirectionClient(null);
      setSelectedExamConfig(null);
      setSelectedMode(null);
      setSelectedProfile(null);
      setPracticeExamConfig(null);
      setPbqPreviewLabs([]);
      setSavedResultAttemptId('');
      setTrainerStudentId('');
      setTrainerAssignmentId('');
      setAdminOrganisationId('');
      setAdminCampusId('');
      setAdminGroupId('');
      setJoinInviteToken('');
      setAttemptHistoryState({
        records: [],
        error: null,
      });
      return;
    }

    if (target.screen === 'browse-exams') {
      setScreen('browse-exams');
      setActiveExam(null);
      setStudent(null);
      setResult(null);
      setItDirectionResult(null);
      setItDirectionClient(null);
      setSelectedMode(null);
      setSelectedProfile(null);
      setPracticeExamConfig(null);
      setPbqPreviewLabs([]);
      setSavedResultAttemptId('');
      setTrainerStudentId('');
      setTrainerAssignmentId('');
      setAdminOrganisationId('');
      setAdminCampusId('');
      setAdminGroupId('');
      setJoinInviteToken('');
      return;
    }

    if (target.screen === 'not-found') {
      setNotFoundPath(target.notFoundPath ?? window.location.pathname);
      setScreen('not-found');
      setActiveExam(null);
      setStudent(null);
      setResult(null);
      setItDirectionResult(null);
      setItDirectionClient(null);
      setSavedResultAttemptId('');
      setTrainerStudentId('');
      setTrainerAssignmentId('');
      setAdminOrganisationId('');
      setAdminCampusId('');
      setAdminGroupId('');
      setJoinInviteToken('');
      return;
    }

    if (target.screen === 'join') {
      setScreen('join');
      setJoinInviteToken(target.joinInviteToken ?? '');
      setActiveExam(null);
      setStudent(null);
      setResult(null);
      setItDirectionResult(null);
      setItDirectionClient(null);
      setSelectedExamConfig(null);
      setSelectedMode(null);
      setSelectedProfile(null);
      setPracticeExamConfig(null);
      setPbqPreviewLabs([]);
      setSavedResultAttemptId('');
      setTrainerStudentId('');
      setTrainerAssignmentId('');
      setDeveloperReportId('');
      setAdminOrganisationId('');
      setAdminCampusId('');
      setAdminGroupId('');
      return;
    }

    if (
      target.screen === 'account' ||
      target.screen === 'account-assignments' ||
      target.screen === 'account-progress' ||
      target.screen === 'reception-placement'
    ) {
      setScreen(target.screen);
      setActiveExam(null);
      setStudent(null);
      setResult(null);
      setItDirectionResult(null);
      setItDirectionClient(null);
      setSelectedMode(null);
      setSelectedProfile(null);
      setPracticeExamConfig(null);
      setPbqPreviewLabs([]);
      setSavedResultAttemptId('');
      setTrainerStudentId('');
      setTrainerAssignmentId('');
      setAdminOrganisationId('');
      setAdminCampusId('');
      setAdminGroupId('');
      setJoinInviteToken('');
      return;
    }

    if (target.screen === 'saved-results' || target.screen === 'saved-result-detail') {
      setScreen(target.screen);
      setSavedResultAttemptId(target.savedResultAttemptId ?? '');
      setActiveExam(null);
      setStudent(null);
      setResult(null);
      setItDirectionResult(null);
      setItDirectionClient(null);
      setSelectedMode(null);
      setSelectedProfile(null);
      setPracticeExamConfig(null);
      setPbqPreviewLabs([]);
      setTrainerStudentId('');
      setTrainerAssignmentId('');
      setAdminOrganisationId('');
      setAdminCampusId('');
      setAdminGroupId('');
      setJoinInviteToken('');
      return;
    }

    if (target.screen === 'admin-organisations') {
      setScreen('admin-organisations');
      setActiveExam(null);
      setStudent(null);
      setResult(null);
      setItDirectionResult(null);
      setItDirectionClient(null);
      setSelectedMode(null);
      setSelectedProfile(null);
      setPracticeExamConfig(null);
      setPbqPreviewLabs([]);
      setSavedResultAttemptId('');
      setTrainerStudentId('');
      setTrainerAssignmentId('');
      setAdminOrganisationId('');
      setAdminCampusId('');
      setAdminGroupId('');
      setJoinInviteToken('');
      return;
    }

    if (target.screen === 'admin-organisation-detail') {
      setScreen('admin-organisation-detail');
      setAdminOrganisationId(target.adminOrganisationId ?? '');
      setActiveExam(null);
      setStudent(null);
      setResult(null);
      setItDirectionResult(null);
      setItDirectionClient(null);
      setSelectedMode(null);
      setSelectedProfile(null);
      setPracticeExamConfig(null);
      setPbqPreviewLabs([]);
      setSavedResultAttemptId('');
      setTrainerStudentId('');
      setTrainerAssignmentId('');
      setAdminCampusId('');
      setAdminGroupId('');
      setJoinInviteToken('');
      return;
    }

    if (target.screen === 'admin-campus-detail') {
      setScreen('admin-campus-detail');
      setAdminCampusId(target.adminCampusId ?? '');
      setActiveExam(null);
      setStudent(null);
      setResult(null);
      setItDirectionResult(null);
      setItDirectionClient(null);
      setSelectedMode(null);
      setSelectedProfile(null);
      setPracticeExamConfig(null);
      setPbqPreviewLabs([]);
      setSavedResultAttemptId('');
      setTrainerStudentId('');
      setTrainerAssignmentId('');
      setAdminOrganisationId('');
      setAdminGroupId('');
      setJoinInviteToken('');
      return;
    }

    if (target.screen === 'admin-group-detail') {
      setScreen('admin-group-detail');
      setAdminGroupId(target.adminGroupId ?? '');
      setActiveExam(null);
      setStudent(null);
      setResult(null);
      setItDirectionResult(null);
      setItDirectionClient(null);
      setSelectedMode(null);
      setSelectedProfile(null);
      setPracticeExamConfig(null);
      setPbqPreviewLabs([]);
      setSavedResultAttemptId('');
      setTrainerStudentId('');
      setTrainerAssignmentId('');
      setAdminOrganisationId('');
      setAdminCampusId('');
      setJoinInviteToken('');
      return;
    }

    if (target.screen.startsWith('trainer-dashboard')) {
      setScreen(target.screen);
      setTrainerResultId(target.trainerResultId ?? '');
      setActiveExam(null);
      setStudent(null);
      setResult(null);
      setItDirectionResult(null);
      setItDirectionClient(null);
      setSelectedMode(null);
      setSelectedProfile(null);
      setPracticeExamConfig(null);
      setPbqPreviewLabs([]);
      setSavedResultAttemptId('');
      setTrainerStudentId('');
      setTrainerAssignmentId('');
      setJoinInviteToken('');
      return;
    }

    if (target.screen === 'developer-dashboard') {
      setScreen('developer-dashboard');
      setActiveExam(null);
      setStudent(null);
      setResult(null);
      setItDirectionResult(null);
      setItDirectionClient(null);
      setSelectedMode(null);
      setSelectedProfile(null);
      setPracticeExamConfig(null);
      setPbqPreviewLabs([]);
      setSavedResultAttemptId('');
      setTrainerStudentId('');
      setTrainerAssignmentId('');
      setDeveloperReportId('');
      setAdminOrganisationId('');
      setAdminCampusId('');
      setAdminGroupId('');
      setJoinInviteToken('');
      return;
    }

    if (target.screen === 'developer-report-detail') {
      setScreen('developer-report-detail');
      setDeveloperReportId(target.developerReportId ?? '');
      setActiveExam(null);
      setStudent(null);
      setResult(null);
      setItDirectionResult(null);
      setItDirectionClient(null);
      setSelectedMode(null);
      setSelectedProfile(null);
      setPracticeExamConfig(null);
      setPbqPreviewLabs([]);
      setSavedResultAttemptId('');
      setTrainerStudentId('');
      setTrainerAssignmentId('');
      setAdminOrganisationId('');
      setAdminCampusId('');
      setAdminGroupId('');
      setJoinInviteToken('');
      return;
    }

    if (target.screen === 'trainer-student-detail') {
      setScreen('trainer-student-detail');
      setTrainerStudentId(target.trainerStudentId ?? '');
      setActiveExam(null);
      setStudent(null);
      setResult(null);
      setItDirectionResult(null);
      setItDirectionClient(null);
      setSelectedMode(null);
      setSelectedProfile(null);
      setPracticeExamConfig(null);
      setPbqPreviewLabs([]);
      setSavedResultAttemptId('');
      setTrainerAssignmentId('');
      setJoinInviteToken('');
      return;
    }

    if (target.screen === 'trainer-assignment-detail') {
      setScreen('trainer-assignment-detail');
      setTrainerAssignmentId(target.trainerAssignmentId ?? '');
      setActiveExam(null);
      setStudent(null);
      setResult(null);
      setItDirectionResult(null);
      setItDirectionClient(null);
      setSelectedMode(null);
      setSelectedProfile(null);
      setPracticeExamConfig(null);
      setPbqPreviewLabs([]);
      setSavedResultAttemptId('');
      setTrainerStudentId('');
      setJoinInviteToken('');
      return;
    }

    if (target.screen.startsWith('it-direction')) {
      setScreen(target.screen);
      setActiveExam(null);
      setStudent(null);
      setResult(null);
      setSelectedExamConfig(null);
      setSelectedMode(null);
      setSelectedProfile(null);
      setPracticeExamConfig(null);
      setItDirectionClient(null);
      setSavedResultAttemptId('');
      setTrainerStudentId('');
      setTrainerAssignmentId('');
      setJoinInviteToken('');
      return;
    }

    if (!target.examConfig) {
      setScreen('browse-exams');
      return;
    }

    const nextExamConfig = target.examConfig;

    setSelectedExamConfig(nextExamConfig);
    setLastSelectedExamConfig(nextExamConfig);
    setAttemptHistoryState(getAttemptHistory(nextExamConfig.id));
    saveSelectedExamId(nextExamConfig.id);
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
    setJoinInviteToken('');

    if (target.screen === 'exam-dashboard') {
      setSelectedMode(nextExamConfig.examModeOptions[0] ?? null);
      setSelectedProfile(nextExamConfig.fullMockProfile ?? null);
      setPracticeExamConfig(nextExamConfig);
      setPbqPreviewLabs([]);
      setScreen('exam-dashboard');
      return;
    }

    if (target.screen === 'sandbox' || target.screen === 'targeted-practice') {
      setPracticeExamConfig(nextExamConfig);
      setSelectedMode(nextExamConfig.examModeOptions[0] ?? null);
      setSelectedProfile(nextExamConfig.fullMockProfile ?? null);
      setPbqPreviewLabs([]);
      setScreen(target.screen);
      return;
    }

    if (target.screen === 'pbq-preview') {
      setPracticeExamConfig(nextExamConfig);
      setSelectedMode(nextExamConfig.examModeOptions[0] ?? null);
      setSelectedProfile(nextExamConfig.fullMockProfile ?? null);
      setPbqPreviewLabs(nextExamConfig.demoLabs ?? []);
      setScreen('pbq-preview');
      return;
    }

    if (target.screen === 'case-study-preview') {
      setPracticeExamConfig(nextExamConfig);
      setSelectedMode(nextExamConfig.examModeOptions[0] ?? null);
      setSelectedProfile(nextExamConfig.fullMockProfile ?? null);
      setPbqPreviewLabs([]);
      setScreen('case-study-preview');
      return;
    }

    if (target.screen === 'student') {
      setPracticeExamConfig(nextExamConfig);
      setSelectedMode(target.selectedMode ?? nextExamConfig.examModeOptions[0] ?? null);
      setSelectedProfile(target.selectedProfile ?? nextExamConfig.fullMockProfile ?? null);
      setPbqPreviewLabs([]);
      setScreen('student');
    }
  }

  function handleRenderErrorBackToDashboard() {
    if (screen.startsWith('it-direction')) {
      setScreen('home');
      setItDirectionResult(null);
      return;
    }

    handleBackToExamDashboard();
  }

  function handleSelectHomeExam(examId) {
    const nextExamConfig = getSafeSelectableExamConfig(examId);

    setSelectedExamConfig(nextExamConfig);
    setLastSelectedExamConfig(nextExamConfig);
    setSelectedMode(nextExamConfig.examModeOptions[0] ?? null);
    setSelectedProfile(nextExamConfig.fullMockProfile ?? null);
    setPracticeExamConfig(nextExamConfig);
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setAttemptHistoryState(getAttemptHistory(nextExamConfig.id));
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
    setLearnerAssignmentId('');
    saveSelectedExamId(nextExamConfig.id);
  }

  function handleSelectExamFromBrowse(examId) {
    handleSelectHomeExam(examId);
    setScreen('exam-dashboard');
  }

  function handleOpenOrganisationManagement() {
    setScreen('admin-organisations');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setSelectedMode(null);
    setSelectedProfile(null);
    setPracticeExamConfig(null);
    setPbqPreviewLabs([]);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
    setDeveloperReportId('');
    setAdminOrganisationId('');
    setAdminCampusId('');
    setAdminGroupId('');
  }

  function handleOpenAdminOrganisationDetail(organisationId) {
    if (!organisationId) {
      handleOpenOrganisationManagement();
      return;
    }

    setScreen('admin-organisation-detail');
    setAdminOrganisationId(organisationId);
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setSelectedMode(null);
    setSelectedProfile(null);
    setPracticeExamConfig(null);
    setPbqPreviewLabs([]);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
    setAdminCampusId('');
    setAdminGroupId('');
  }

  function handleOpenAdminCampusDetail(campusId) {
    if (!campusId) {
      handleOpenOrganisationManagement();
      return;
    }

    setScreen('admin-campus-detail');
    setAdminCampusId(campusId);
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setSelectedMode(null);
    setSelectedProfile(null);
    setPracticeExamConfig(null);
    setPbqPreviewLabs([]);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
    setDeveloperReportId('');
    setAdminOrganisationId('');
    setAdminGroupId('');
  }

  function handleOpenAdminGroupDetail(groupId) {
    if (!groupId) {
      handleOpenOrganisationManagement();
      return;
    }

    setScreen('admin-group-detail');
    setAdminGroupId(groupId);
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setSelectedMode(null);
    setSelectedProfile(null);
    setPracticeExamConfig(null);
    setPbqPreviewLabs([]);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
    setAdminOrganisationId('');
    setAdminCampusId('');
  }

  function handleOpenAccount() {
    setScreen('account');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setSelectedMode(null);
    setSelectedProfile(null);
    setPracticeExamConfig(null);
    setPbqPreviewLabs([]);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
  }

  function handleOpenJoin(inviteToken = '') {
    setScreen('join');
    setJoinInviteToken(inviteToken);
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setSelectedExamConfig(null);
    setSelectedMode(null);
    setSelectedProfile(null);
    setPracticeExamConfig(null);
    setPbqPreviewLabs([]);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
    setDeveloperReportId('');
    setAdminOrganisationId('');
    setAdminCampusId('');
    setAdminGroupId('');
  }

  function handleOpenMyAssignments() {
    setScreen('account-assignments');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setSelectedMode(null);
    setSelectedProfile(null);
    setPracticeExamConfig(null);
    setPbqPreviewLabs([]);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
  }

  function handleOpenMyReports() {
    setScreen('account-reports');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setSelectedMode(null);
    setSelectedProfile(null);
    setPracticeExamConfig(null);
    setPbqPreviewLabs([]);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
  }

  function handleOpenStudentProgress() {
    setScreen('account-progress');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setSelectedMode(null);
    setSelectedProfile(null);
    setPracticeExamConfig(null);
    setPbqPreviewLabs([]);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
  }

  function handleContinueLastSelectedExam() {
    if (!lastSelectedExamConfig) {
      setScreen('browse-exams');
      return;
    }

    handleSelectHomeExam(lastSelectedExamConfig.id);
    setScreen('exam-dashboard');
  }

  function handleBackToExamDashboard() {
    setScreen(selectedExamConfig ? 'exam-dashboard' : 'browse-exams');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
  }

  function handleSelectExam(modeId, examConfig = selectedExamConfig) {
    if (!examConfig) {
      setScreen('browse-exams');
      return;
    }

    if (!canStartStandardExamMode(examConfig)) {
      showStrictExamUnavailable();
      return;
    }

    const nextMode = examConfig.getExamModeById(modeId);

    if (!nextMode) {
      showStrictExamUnavailable();
      return;
    }

    const nextProfile =
      nextMode.id === examConfig.modeIds.realisticRandom
        ? examConfig.getRandomRealisticProfile()
        : examConfig.fullMockProfile;

    setSelectedMode(nextMode);
    setSelectedProfile(nextProfile);
    setSelectedExamConfig(examConfig);
    setResult(null);
    setScreen('student');
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
  }

  function handleStartExam(studentDetails) {
    setProtectedPracticeRequest(null);
    if (!selectedExamConfig || !selectedMode || !selectedProfile) {
      setScreen('browse-exams');
      return;
    }

    if (protectedDeliveryMode === DELIVERY_MODES.maintenance) {
      setStudent(studentDetails);
      setActiveExam({ deliveryMode: DELIVERY_MODES.maintenance });
      setResult(null);
      setScreen('exam');
      return;
    }

    if (protectedDeliveryMode === DELIVERY_MODES.protected) {
      const protectedExamKey = getProtectedExamKey(selectedExamConfig.id);
      const protectedProfileKey = getProtectedProfileKey(
        selectedExamConfig.id,
        selectedProfile.id,
      );
      const language = selectedExamConfig.id === 'az204'
        ? ({
            csharp: 'csharp',
            python: 'python',
            mixed: 'mixed',
          }[getCodingLanguagePreferenceForExam(selectedExamConfig)] ?? 'mixed')
        : null;
      setProtectedPracticeRequest({
        purpose: 'self_directed_exam',
        includePbqs: true,
        mixStrategy: 'balanced',
        ...(language ? { language } : {}),
      });
      setStudent(studentDetails);
      setActiveExam({
        deliveryMode: DELIVERY_MODES.protected,
        examKey: protectedExamKey,
        profileKey: protectedProfileKey,
      });
      setResult(null);
      setScreen('exam');
      setSavedResultAttemptId('');
      setTrainerStudentId('');
      setTrainerAssignmentId('');
      return;
    }

    const generatedAttempt = createGeneratedAttempt({
      examConfig: selectedExamConfig,
      mode: selectedMode,
      profile: selectedProfile,
      codingLanguagePreference: getCodingLanguagePreferenceForExam(
        selectedExamConfig,
      ),
    });
    const generatedExam = enrichGeneratedExam(
      generatedAttempt,
      selectedExamConfig,
    );

    setStudent(studentDetails);
    setActiveExam(generatedExam);
    setResult(null);
    setScreen('exam');
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
  }

  function handleExamComplete(examResult) {
    if (examResult.exam.disableAttemptHistory) {
      setResult({
        ...examResult,
        historySaveStatus: {
          type: 'disabled',
          message: getAttemptHistoryDisabledMessage(examResult.exam),
        },
      });
      setScreen('results');
      setSavedResultAttemptId('');
      setTrainerStudentId('');
      setTrainerAssignmentId('');
      return;
    }

    const historyRecord = createAttemptHistoryRecord(examResult);
    const nextHistoryState = saveAttemptHistoryRecord(
      historyRecord,
      selectedExamConfig?.id ?? examResult.exam.registryId ?? examResult.exam.id,
    );
    const historySaveStatus = nextHistoryState.error
      ? {
          type: 'error',
          message: nextHistoryState.error,
        }
      : {
          type: 'saved',
          message: 'Attempt saved locally in this browser.',
          recordId: historyRecord.id,
        };

    setAttemptHistoryState(nextHistoryState);
    setResult({
      ...examResult,
      historySaveStatus,
    });
    setScreen('results');
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
  }

  function handleRestart() {
    setProtectedPracticeRequest(null);
    setScreen('home');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setSelectedExamConfig(null);
    setSelectedMode(null);
    setSelectedProfile(null);
    setPracticeExamConfig(null);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
    setLearnerAssignmentId('');
    setAttemptHistoryState({
      records: [],
      error: null,
    });
  }

  function handleOpenItDirectionAssessment() {
    setScreen('it-direction-intro');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setItDirectionSaveStatus({ status: 'idle', message: '' });
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
  }

  function handleOpenTrainerDashboard() {
    setScreen('trainer-dashboard');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setSelectedMode(null);
    setSelectedProfile(null);
    setPracticeExamConfig(null);
    setPbqPreviewLabs([]);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
  }

  function handleOpenTrainerDashboardSection(section = 'overview', resultId = '') {
    const normalized = ['analytics', 'assignments', 'students', 'results', 'detail'].includes(section) ? section : 'overview';
    setTrainerResultId(resultId);
    setScreen(normalized === 'overview' ? 'trainer-dashboard' : `trainer-dashboard-${normalized}`);
  }

  function handleOpenDeveloperDashboard() {
    setScreen('developer-dashboard');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setSelectedMode(null);
    setSelectedProfile(null);
    setPracticeExamConfig(null);
    setPbqPreviewLabs([]);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
    setDeveloperReportId('');
    setAdminOrganisationId('');
    setAdminCampusId('');
    setAdminGroupId('');
  }

  function handleOpenReceptionPlacement() {
    setScreen('reception-placement');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setItDirectionSaveStatus({ status: 'idle', message: '' });
    setSelectedMode(null);
    setSelectedProfile(null);
    setPracticeExamConfig(null);
    setPbqPreviewLabs([]);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
    setDeveloperReportId('');
    setAdminOrganisationId('');
    setAdminCampusId('');
    setAdminGroupId('');
    setJoinInviteToken('');
  }

  function handleOpenDeveloperReportDetail(reportId) {
    if (!reportId) {
      handleOpenDeveloperDashboard();
      return;
    }

    setScreen('developer-report-detail');
    setDeveloperReportId(reportId);
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setSelectedMode(null);
    setSelectedProfile(null);
    setPracticeExamConfig(null);
    setPbqPreviewLabs([]);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
    setAdminOrganisationId('');
    setAdminCampusId('');
    setAdminGroupId('');
  }

  function handleOpenTrainerStudentReport(studentId) {
    if (!studentId) {
      handleOpenTrainerDashboard();
      return;
    }

    setScreen('trainer-student-detail');
    setTrainerStudentId(studentId);
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setSelectedMode(null);
    setSelectedProfile(null);
    setPracticeExamConfig(null);
    setPbqPreviewLabs([]);
    setSavedResultAttemptId('');
    setTrainerAssignmentId('');
  }

  function handleOpenTrainerAssignment(assignmentId) {
    if (!assignmentId) {
      handleOpenTrainerDashboard();
      return;
    }

    setScreen('trainer-assignment-detail');
    setTrainerAssignmentId(assignmentId);
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setSelectedMode(null);
    setSelectedProfile(null);
    setPracticeExamConfig(null);
    setPbqPreviewLabs([]);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
  }

  function handleOpenSavedResults() {
    openSavedResults('');
  }

  function handleOpenSavedResultsFromExamDashboard() {
    openSavedResults('exam-dashboard');
  }

  function openSavedResults(returnTarget) {
    setScreen('saved-results');
    setSavedResultAttemptId('');
    setWeakAreaPracticeExamId('');
    setOpenWeakAreaPractice(false);
    setTrainerStudentId('');
    setTrainerAssignmentId('');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
    setSelectedMode(null);
    setSelectedProfile(null);
    setPracticeExamConfig(null);
    setPbqPreviewLabs([]);
    setSavedResultsReturnTarget(returnTarget);
  }

  function handleConfigureWeakAreaPractice(examId, returnTarget = '') {
    openSavedResults(returnTarget);
    setWeakAreaPracticeExamId(examId);
    setOpenWeakAreaPractice(true);
  }

  function handleReturnToSavedResultsList() {
    setScreen('saved-results');
    setSavedResultAttemptId('');
  }

  function handleOpenSavedResultDetail(attemptId) {
    setScreen('saved-result-detail');
    setSavedResultAttemptId(attemptId);
    setTrainerStudentId('');
    setTrainerAssignmentId('');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setItDirectionResult(null);
    setItDirectionClient(null);
  }

  function handleStartItDirectionAssessment(clientDetails) {
    setItDirectionClient(normalizeItDirectionClientDetails(clientDetails));
    setScreen('it-direction-runner');
    setItDirectionResult(null);
    setItDirectionSaveStatus({ status: 'idle', message: '' });
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
  }

  async function handleCompleteItDirectionAssessment(assessmentResult) {
    const clientDetails = itDirectionClient ?? normalizeItDirectionClientDetails();
    const completedResult = {
      ...assessmentResult,
      client: clientDetails,
      clientName: clientDetails.displayName || 'Not recorded',
      clientContact: clientDetails.contact || '',
    };

    setItDirectionResult(completedResult);
    setScreen('it-direction-results');
    setItDirectionSaveStatus({
      status: 'saving',
      message: 'Saving placement result for follow-up...',
    });
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');

    const saveResult = await savePlacementAssessmentResult(completedResult);

    if (saveResult.ok) {
      setItDirectionResult((currentResult) =>
        currentResult
          ? {
              ...currentResult,
              placementResultId: saveResult.data?.id ?? '',
            }
          : currentResult,
      );
      setItDirectionSaveStatus({
        status: 'saved',
        message: saveResult.data?.message ?? 'Placement result saved for follow-up.',
      });
      return;
    }

    setItDirectionSaveStatus({
      status: 'error',
      message:
        saveResult.reason === 'supabase_not_configured'
          ? 'Your result was generated locally, but placement follow-up saving is not configured in this environment.'
          : saveResult.message ||
            'Your result was generated, but it could not be saved for follow-up.',
    });
  }

  function handleRetakeItDirectionAssessment() {
    setItDirectionResult(null);
    setItDirectionClient(null);
    setItDirectionSaveStatus({ status: 'idle', message: '' });
    setScreen('it-direction-intro');
  }

  function handleOpenStudySandbox(examConfig = selectedExamConfig) {
    if (!examConfig) {
      setScreen('browse-exams');
      return;
    }
    {
      openProtectedPractice(examConfig, 'study_sandbox');
      return;
    }

    setSelectedExamConfig(examConfig);
    setLastSelectedExamConfig(examConfig);
    setPracticeExamConfig(examConfig);
    setAttemptHistoryState(getAttemptHistory(examConfig.id));
    saveSelectedExamId(examConfig.id);
    setScreen('sandbox');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
  }

  function handleOpenTargetedPractice(examConfig = selectedExamConfig) {
    if (!examConfig) {
      setScreen('browse-exams');
      return;
    }
    setSelectedExamConfig(examConfig);
    setLastSelectedExamConfig(examConfig);
    setPracticeExamConfig(examConfig);
    setProtectedPracticeRequest(null);
    setScreen('targeted-practice');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    saveSelectedExamId(examConfig.id);
    return;

    setSelectedExamConfig(examConfig);
    setLastSelectedExamConfig(examConfig);
    setPracticeExamConfig(examConfig);
    setAttemptHistoryState(getAttemptHistory(examConfig.id));
    saveSelectedExamId(examConfig.id);
    setScreen('targeted-practice');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
  }

  function handleStartWeakAreaPractice(plan) {
    const examConfig = getExamConfigById(plan?.examKey);

    if (!examConfig || !canUseSignedInStudentIdentity(currentIdentity)) {
      handleOpenSavedResults();
      return;
    }
    {
      openProtectedPractice(examConfig, 'weak_area', {
        count: plan?.questionCount,
        includePbqs: plan?.includePbqs,
        mixStrategy: plan?.mixStrategy,
        domain: plan?.domain,
        profileId: plan?.profileId,
      });
      return;
    }

    const generatedAttempt = createWeakAreaPracticeAttempt({
      examConfig,
      plan,
      codingLanguagePreference: getCodingLanguagePreferenceForExam(examConfig),
    });
    const generatedExam = enrichGeneratedExam(generatedAttempt, examConfig);

    setSelectedExamConfig(examConfig);
    setLastSelectedExamConfig(examConfig);
    setSelectedMode(generatedExam.mode);
    setSelectedProfile(generatedExam.profile);
    setPracticeExamConfig(null);
    setStudent(createStudentDetailsFromIdentity(currentIdentity));
    setActiveExam(generatedExam);
    setResult(null);
    setScreen('exam');
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
    saveSelectedExamId(examConfig.id);
  }

  function handleOpenDraftStudySandbox(examId) {
    const examConfig = getExamConfigById(examId);

    if (!canUseExamPracticeActions(examConfig)) {
      showStrictExamUnavailable();
      return;
    }

    handleOpenStudySandbox(examConfig);
  }

  function handleOpenDraftTargetedPractice(examId) {
    const examConfig = getExamConfigById(examId);

    if (!canUseExamPracticeActions(examConfig)) {
      showStrictExamUnavailable();
      return;
    }

    handleOpenTargetedPractice(examConfig);
  }

  function handleStartDraftStrictBeta(examId, profileId) {
    const examConfig = getExamConfigById(examId);

    if (!canUseExamPracticeActions(examConfig)) {
      showStrictExamUnavailable();
      return;
    }

    const nextProfile = examConfig.strictBetaProfiles?.find(
      (profile) => profile.id === profileId,
    );

    if (!nextProfile) {
      showStrictExamUnavailable();
      return;
    }

    setSelectedExamConfig(examConfig);
    setLastSelectedExamConfig(examConfig);
    setSelectedMode(examConfig.strictBetaMode);
    setSelectedProfile(nextProfile);
    setResult(null);
    setScreen('student');
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
    saveSelectedExamId(examConfig.id);
  }

  function showStrictExamUnavailable() {
    setScreen('strict-unavailable');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
  }

  async function handleOpenPBQPreview(examId = selectedExamConfig?.id) {
    if (!examId) {
      setScreen('browse-exams');
      return;
    }

    const examConfig = getExamConfigById(examId);

    {
      openProtectedPractice(examConfig, 'pbq_practice', { contentKind: 'pbq' });
      return;
    }

    if (!canUseExamPracticeActions(examConfig)) {
      return;
    }

    const { default: PBQRenderer } = await import('./components/pbq/PBQRenderer.jsx');

    setSelectedExamConfig(examConfig);
    setLastSelectedExamConfig(examConfig);
    setPbqPreviewComponent(() => PBQRenderer);
    setPbqPreviewLabs(examConfig.demoLabs ?? []);
    setScreen('pbq-preview');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
    saveSelectedExamId(examConfig.id);
  }

  function handleOpenCaseStudyPreview(examId = selectedExamConfig?.id) {
    if (!examId) {
      setScreen('browse-exams');
      return;
    }

    const examConfig = getExamConfigById(examId);

    {
      openProtectedPractice(examConfig, 'pbq_practice', { contentKind: 'case-study' });
      return;
    }

    if (
      (examConfig.caseStudyBlocks?.length ?? 0) === 0 ||
      !canUseExamPracticeActions(examConfig)
    ) {
      showStrictExamUnavailable();
      return;
    }

    setSelectedExamConfig(examConfig);
    setLastSelectedExamConfig(examConfig);
    setPracticeExamConfig(examConfig);
    setScreen('case-study-preview');
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setSavedResultAttemptId('');
    setTrainerStudentId('');
    setTrainerAssignmentId('');
    saveSelectedExamId(examConfig.id);
  }

  function handleClearAttemptHistory() {
    if (!selectedExamConfig) {
      return;
    }

    setAttemptHistoryState(clearAttemptHistory(selectedExamConfig.id));
  }

  function showLegacyPracticeUnavailable(examConfig) {
    setSelectedExamConfig(examConfig ?? null);
    setActiveExam(null);
    setStudent(null);
    setResult(null);
    setScreen('delivery-unavailable');
  }

  function openProtectedPractice(examConfig, purpose, overrides = {}) {
    if (!canUseSignedInStudentIdentity(currentIdentity)) {
      showLegacyPracticeUnavailable(examConfig);
      return;
    }
    const requestedProfile = examConfig.strictBetaProfiles?.find((entry) => entry.id === overrides.profileId);
    const profile = requestedProfile ?? (selectedExamConfig?.id === examConfig.id && selectedProfile
      ? selectedProfile
      : examConfig.fullMockProfile ?? examConfig.strictBetaProfiles?.[0] ?? examConfig.profiles?.fullMock);
    if (!profile) { showLegacyPracticeUnavailable(examConfig); return; }
    const language = examConfig.id === 'az204'
      ? ({ csharp: 'csharp', python: 'python', mixed: 'mixed' }[getCodingLanguagePreferenceForExam(examConfig)] ?? 'mixed')
      : null;
    setSelectedExamConfig(examConfig); setSelectedProfile(profile); setLastSelectedExamConfig(examConfig);
    const count = purpose === 'weak_area' ? (overrides.count ?? 20) : overrides.count;
    setProtectedPracticeRequest({ purpose, ...(count == null ? {} : { count }), includePbqs: overrides.includePbqs ?? true, mixStrategy: overrides.mixStrategy ?? 'balanced', domain: overrides.domain ? String(overrides.domain).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : undefined, contentKind: overrides.contentKind, ...(language ? { language } : {}) });
    setStudent(createStudentDetailsFromIdentity(currentIdentity));
    setActiveExam({ ...createSelectedExamSummary(examConfig), deliveryMode: DELIVERY_MODES.protected });
    setScreen('exam'); setResult(null); saveSelectedExamId(examConfig.id);
  }

  function updateProtectedPracticeRequest(nextRequest) {
    setProtectedPracticeRequest({
      ...nextRequest,
      domain: nextRequest?.domain
        ? String(nextRequest.domain).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
        : undefined,
    });
  }

  function handleAz204CodingLanguageChange(nextPreference) {
    const normalizedPreference =
      normalizeCodingLanguagePreference(nextPreference);

    setAz204CodingLanguagePreference(normalizedPreference);
    saveAz204CodingLanguagePreference(normalizedPreference);
  }

  function getCodingLanguagePreferenceForExam(examConfig) {
    return examConfig?.id === 'az204'
      ? az204CodingLanguagePreference
      : null;
  }

  const isPreparingSignedInStudentDetails =
    screen === 'student' &&
    (shouldWaitForSignedInStudentIdentity(currentIdentity) ||
      canUseSignedInStudentIdentity(currentIdentity));
  const focusedNavigation = isFocusedAttemptScreen(screen) &&
    activeExam?.deliveryMode !== DELIVERY_MODES.protected;
  const activeHeaderDestination = getActiveHeaderDestination(screen);

  return (
    <main className={`app-shell ${screen === 'exam' ? 'exam-active' : ''}`}>
      <Header
        activeDestination={activeHeaderDestination}
        compact={focusedNavigation}
        onOpenAccount={() => runProtectedNavigation(handleOpenAccount)}
        onOpenBrowseExams={() => runProtectedNavigation(() => setScreen('browse-exams'))}
        onOpenHome={() => runProtectedNavigation(handleRestart)}
        onOpenPrivacy={() => runProtectedNavigation(() => setScreen('privacy'))}
        onOpenTerms={() => runProtectedNavigation(() => setScreen('terms'))}
      />

      <ErrorBoundary
        fallback={({ error, resetErrorBoundary }) => (
          <RenderErrorFallback
            error={error}
            onBackToDashboard={() => {
              resetErrorBoundary();
              handleRenderErrorBackToDashboard();
            }}
            onReload={() => window.location.reload()}
          />
        )}
        resetKey={renderBoundaryKey}
      >
      {screen === 'privacy' && <PrivacyPage />}

      {screen === 'terms' && <TermsPage />}

      {['home', 'browse-exams', 'exam-dashboard'].includes(screen) && (
        <Home
          exam={selectedExam}
          examOptions={visibleExamConfigs.map(createSelectedExamSummary)}
          isDraftAccessEnabled={showDraftExamAccess}
          lastSelectedExam={lastSelectedExam}
          modes={selectedExamConfig?.examModeOptions ?? []}
          view={
            screen === 'browse-exams'
              ? 'browse'
              : screen === 'exam-dashboard'
                ? 'dashboard'
                : 'home'
          }
          onBrowseExams={() => setScreen('browse-exams')}
          onContinueLastSelectedExam={handleContinueLastSelectedExam}
          onOpenDashboard={() =>
            selectedExamConfig ? setScreen('exam-dashboard') : setScreen('browse-exams')
          }
          onOpenDraftStudySandbox={handleOpenDraftStudySandbox}
          onOpenDraftTargetedPractice={handleOpenDraftTargetedPractice}
          onOpenItDirectionAssessment={handleOpenItDirectionAssessment}
          onOpenSavedResults={
            screen === 'exam-dashboard'
              ? handleOpenSavedResultsFromExamDashboard
              : handleOpenSavedResults
          }
          onOpenCaseStudyPreview={
            selectedExamConfig &&
            ((selectedExamConfig.caseStudyBlocks?.length ?? 0) > 0 || selectedExamConfig.supportedFeatures?.caseStudies) &&
            canUseExamPracticeActions(selectedExamConfig)
              ? handleOpenCaseStudyPreview
              : null
          }
          onStartDraftStrictBeta={handleStartDraftStrictBeta}
          onReturnHome={handleRestart}
          onSelectExam={handleSelectExamFromBrowse}
          onOpenStudySandbox={() => handleOpenStudySandbox()}
          onOpenTargetedPractice={() => handleOpenTargetedPractice()}
          onOpenPBQPreview={
            selectedExamConfig &&
            canUseExamPracticeActions(selectedExamConfig) &&
            ((selectedExamConfig.demoLabs?.length ?? 0) > 0 || selectedExamConfig.supportedFeatures?.pbqLabs)
              ? handleOpenPBQPreview
              : null
          }
          onStartExam={handleSelectExam}
          onConfigureWeakAreaPractice={(examId) =>
            handleConfigureWeakAreaPractice(
              examId,
              screen === 'exam-dashboard' ? 'exam-dashboard' : '',
            )
          }
        />
      )}

      {screen === 'account' && (
        <AccountPage
          identity={currentIdentity}
          lastSelectedExam={lastSelectedExam}
          onBackHome={handleRestart}
          onBrowseExams={() => setScreen('browse-exams')}
          onConfigureWeakAreaPractice={handleConfigureWeakAreaPractice}
          onContinueLastSelectedExam={handleContinueLastSelectedExam}
          onOpenAssignments={handleOpenMyAssignments}
          onOpenCampusDetail={handleOpenAdminCampusDetail}
          onOpenGroupDetail={handleOpenAdminGroupDetail}
          onOpenOrganisationManagement={handleOpenOrganisationManagement}
          onOpenOrganisationDetail={handleOpenAdminOrganisationDetail}
          onOpenProgress={handleOpenStudentProgress}
          onOpenMyReports={handleOpenMyReports}
          onOpenSavedResults={handleOpenSavedResults}
          onOpenDeveloperDashboard={handleOpenDeveloperDashboard}
          onOpenJoin={handleOpenJoin}
          onOpenReceptionPlacement={handleOpenReceptionPlacement}
          onOpenTrainerDashboard={handleOpenTrainerDashboard}
        />
      )}

      {screen === 'join' && (
        <JoinPage
          inviteToken={joinInviteToken}
          onBackHome={handleRestart}
          onBrowseExams={() => setScreen('browse-exams')}
          onOpenAccount={handleOpenAccount}
          onOpenAssignments={handleOpenMyAssignments}
        />
      )}

      {screen === 'developer-dashboard' && (
        <DeveloperDashboardPage
          onBackHome={handleRestart}
          onBrowseExams={() => setScreen('browse-exams')}
          onOpenReportDetail={handleOpenDeveloperReportDetail}
        />
      )}

      {screen === 'developer-report-detail' && (
        <DeveloperReportDetailPage
          reportId={developerReportId}
          onBackHome={handleRestart}
          onBackToDashboard={handleOpenDeveloperDashboard}
          onBrowseExams={() => setScreen('browse-exams')}
          onOpenSavedResult={handleOpenSavedResultDetail}
        />
      )}

      {screen === 'reception-placement' && (
        <ReceptionPlacementDashboardPage
          onBackHome={handleRestart}
          onBrowseExams={() => setScreen('browse-exams')}
          onOpenAccount={handleOpenAccount}
        />
      )}

      {screen === 'account-progress' && (
        <StudentProgressPage
          onBackHome={handleRestart}
          onBrowseExams={() => setScreen('browse-exams')}
          onOpenAccount={handleOpenAccount}
          onOpenSavedResultDetail={handleOpenSavedResultDetail}
          onOpenSavedResults={handleOpenSavedResults}
          onConfigureWeakAreaPractice={handleConfigureWeakAreaPractice}
        />
      )}

      {screen === 'account-reports' && (
        <MyReportsPage
          onBackHome={handleRestart}
          onBrowseExams={() => setScreen('browse-exams')}
          onOpenAccount={handleOpenAccount}
        />
      )}

      {screen === 'account-assignments' && (
        <MyAssignmentsPage
          onBackHome={handleRestart}
          onBrowseExams={() => setScreen('browse-exams')}
          onOpenAccount={handleOpenAccount}
        />
      )}

      {['saved-results', 'saved-result-detail'].includes(screen) && (
        <SavedResultsPage
          session={currentIdentity.session}
          attemptId={screen === 'saved-result-detail' ? savedResultAttemptId : ''}
          openWeakAreaPractice={openWeakAreaPractice}
          weakAreaPracticeExamId={weakAreaPracticeExamId}
          onBackHome={handleRestart}
          onOpenAccount={handleOpenAccount}
          onBrowseExams={() => setScreen('browse-exams')}
          onOpenDetail={handleOpenSavedResultDetail}
          onReturnToList={handleReturnToSavedResultsList}
          onReturnToSource={
            savedResultsReturnTarget === 'exam-dashboard'
              ? handleBackToExamDashboard
              : null
          }
          returnToSourceLabel={
            savedResultsReturnTarget === 'exam-dashboard'
              ? 'Back to Exam Dashboard'
              : ''
          }
          onStartWeakAreaPractice={handleStartWeakAreaPractice}
        />
      )}

      {screen === 'admin-organisations' && (
        <OrganisationManagementPage
          onBackHome={handleRestart}
          onBrowseExams={() => setScreen('browse-exams')}
          onOpenCampusDetail={handleOpenAdminCampusDetail}
          onOpenGroupDetail={handleOpenAdminGroupDetail}
          onOpenOrganisationDetail={handleOpenAdminOrganisationDetail}
        />
      )}

      {screen === 'admin-organisation-detail' && (
        <OrganisationDetailPage
          organisationId={adminOrganisationId}
          onBackHome={handleRestart}
          onBackToManagement={handleOpenOrganisationManagement}
          onBrowseExams={() => setScreen('browse-exams')}
          onOpenCampusDetail={handleOpenAdminCampusDetail}
          onOpenGroupDetail={handleOpenAdminGroupDetail}
        />
      )}

      {screen === 'admin-campus-detail' && (
        <CampusDetailPage
          campusId={adminCampusId}
          onBackHome={handleRestart}
          onBackToManagement={handleOpenOrganisationManagement}
          onBrowseExams={() => setScreen('browse-exams')}
          onOpenGroupDetail={handleOpenAdminGroupDetail}
        />
      )}

      {screen === 'admin-group-detail' && (
        <GroupDetailPage
          groupId={adminGroupId}
          onBackHome={handleRestart}
          onBackToManagement={handleOpenOrganisationManagement}
          onBrowseExams={() => setScreen('browse-exams')}
          onOpenAssignment={handleOpenTrainerAssignment}
          onOpenSavedResult={handleOpenSavedResultDetail}
          onOpenStudentReport={handleOpenTrainerStudentReport}
        />
      )}

      {screen.startsWith('trainer-dashboard') && (
        <TrainerDashboardPage
          activeSection={screen.replace('trainer-dashboard-', '') === screen ? 'overview' : screen.replace('trainer-dashboard-', '')}
          resultAttemptId={trainerResultId}
          onBackHome={handleRestart}
          onBrowseExams={() => setScreen('browse-exams')}
          onNavigateSection={handleOpenTrainerDashboardSection}
          onOpenAssignment={handleOpenTrainerAssignment}
          onOpenStudentReport={handleOpenTrainerStudentReport}
        />
      )}

      {screen === 'trainer-assignment-detail' && (
        <TrainerAssignmentDetailPage
          assignmentId={trainerAssignmentId}
          onBackHome={handleRestart}
          onBackToDashboard={handleOpenTrainerDashboard}
          onBrowseExams={() => setScreen('browse-exams')}
          onOpenStudentReport={handleOpenTrainerStudentReport}
        />
      )}

      {screen === 'trainer-student-detail' && (
        <TrainerStudentDetailPage
          studentId={trainerStudentId}
          onBackHome={handleRestart}
          onBackToDashboard={handleOpenTrainerDashboard}
          onBrowseExams={() => setScreen('browse-exams')}
        />
      )}

      {screen === 'student' && isPreparingSignedInStudentDetails && (
        <SignedInStudentStartScreen
          exam={selectedExam}
          isLoading={shouldWaitForSignedInStudentIdentity(currentIdentity)}
          onBack={handleBackToExamDashboard}
        />
      )}

      {screen === 'student' && !isPreparingSignedInStudentDetails && (
        <StudentDetails
          codingLanguagePreference={getCodingLanguagePreferenceForExam(
            selectedExamConfig,
          )}
          exam={selectedExam}
          selectedMode={selectedMode}
          selectedProfile={selectedProfile}
          onCodingLanguagePreferenceChange={handleAz204CodingLanguageChange}
          onBack={handleBackToExamDashboard}
          onStartExam={handleStartExam}
        />
      )}

      {screen === 'exam' && student && activeExam?.deliveryMode === DELIVERY_MODES.maintenance && (
        <section className="exam-workspace protected-status" aria-labelledby="exam-maintenance-heading">
          <p className="eyebrow">Scheduled maintenance</p>
          <h2 id="exam-maintenance-heading">New exam starts are temporarily paused</h2>
          <p>CertSim exam delivery is being prepared. Your account and safe navigation remain available.</p>
          <button className="primary-button" type="button" onClick={handleRestart}>Return home</button>
        </section>
      )}

      {screen === 'exam' && student && activeExam?.deliveryMode === DELIVERY_MODES.protected && (
        <ProtectedExamRunner
          assignmentId={learnerAssignmentId}
          codingLanguagePreference={getCodingLanguagePreferenceForExam(selectedExamConfig)}
          examConfig={selectedExamConfig}
          onCodingLanguagePreferenceChange={handleAz204CodingLanguageChange}
          profile={selectedProfile}
          selectedMode={selectedMode}
          session={currentIdentity.session}
          student={student}
          practiceRequest={protectedPracticeRequest}
          onPracticeRequestChange={updateProtectedPracticeRequest}
          onExit={handleBackToExamDashboard}
          onRegisterNavigationGuard={registerProtectedNavigationGuard}
        />
      )}

      {screen === 'exam' && student && activeExam && !activeExam.deliveryMode && (
        <ExamRunner
          exam={activeExam}
          student={student}
          onExit={handleBackToExamDashboard}
          onSubmit={handleExamComplete}
        />
      )}

      {screen === 'results' && result && (
        <ExamResults
          attemptHistoryRecords={
            result.exam.disableAttemptHistory ? [] : attemptHistoryState.records
          }
          historyStorageError={
            result.exam.disableAttemptHistory ? null : attemptHistoryState.error
          }
          result={result}
          onClearAttemptHistory={handleClearAttemptHistory}
          onReview={() => setScreen('review')}
          onRestart={handleRestart}
        />
      )}

      {screen === 'review' && result && (
        <ExamReview
          result={result}
          onBackToResults={() => setScreen('results')}
          onOpenMyReports={handleOpenMyReports}
          onRestart={handleRestart}
        />
      )}

      {screen === 'sandbox' && practiceExamConfig && (
        <StudySandbox
          codingLanguagePreference={getCodingLanguagePreferenceForExam(
            practiceExamConfig,
          )}
          domains={practiceExamConfig.domainNames}
          exam={createSelectedExamSummary(practiceExamConfig)}
          questionBank={practiceExamConfig.questionBank}
          onCodingLanguagePreferenceChange={handleAz204CodingLanguageChange}
          onExit={handleBackToExamDashboard}
        />
      )}

      {screen === 'targeted-practice' && practiceExamConfig && (
        <ProtectedTargetedDomainSetup
          domains={practiceExamConfig.domainNames}
          exam={createSelectedExamSummary(practiceExamConfig)}
          onBack={handleBackToExamDashboard}
          onContinue={(domain) => openProtectedPractice(practiceExamConfig, 'targeted_domain', { domain })}
        />
      )}

      {screen === 'strict-unavailable' && (
        <section className="form-panel" aria-labelledby="strict-unavailable-heading">
          <p className="eyebrow">Draft exam</p>
          <h2 id="strict-unavailable-heading">
            This exam mode is not available here.
          </h2>
          <p>
            Future draft exams stay hidden unless draft access is enabled.
            Security+ PBQ-first practice modes remain available only through
            their labelled Security+ actions.
          </p>
        </section>
      )}

      {screen === 'delivery-unavailable' && (
        <section className="form-panel" aria-labelledby="delivery-unavailable-heading">
          <p className="eyebrow">Protected delivery</p>
          <h2 id="delivery-unavailable-heading">This browser-only practice path is unavailable.</h2>
          <p>
            {protectedDeliveryMode === DELIVERY_MODES.maintenance
              ? 'New exam and practice starts are paused during maintenance.'
              : 'Protected mode does not fall back to browser question banks or client-side scoring.'}
          </p>
          <button className="primary-button" type="button" onClick={handleRestart}>Return home</button>
        </section>
      )}

      {screen === 'not-found' && (
        <NotFoundScreen path={notFoundPath} />
      )}

      {screen === 'pbq-preview' && !PBQPreviewComponent && (
        <section className="form-panel" aria-labelledby="pbq-preview-loading-heading">
          <p className="eyebrow">PBQ preview</p>
          <h2 id="pbq-preview-loading-heading">Loading PBQ preview...</h2>
          <p>Preparing the browser-only lab workspace.</p>
        </section>
      )}

      {screen === 'pbq-preview' && PBQPreviewComponent && (
        <PBQPreviewComponent
          exam={selectedExam}
          labs={pbqPreviewLabs}
          onExit={handleBackToExamDashboard}
        />
      )}

      {screen === 'case-study-preview' && practiceExamConfig && (
        <CaseStudyPractice
          caseStudyBlocks={practiceExamConfig.caseStudyBlocks ?? []}
          exam={createSelectedExamSummary(practiceExamConfig)}
          onExit={handleBackToExamDashboard}
          onOpenMyReports={handleOpenMyReports}
        />
      )}

      {screen === 'it-direction-intro' && (
        <ITDirectionAssessmentIntro
          assessment={itDirectionAssessment}
          onBackHome={handleRestart}
          onStart={handleStartItDirectionAssessment}
        />
      )}

      {screen === 'it-direction-runner' && (
        <ITDirectionAssessmentRunner
          assessment={itDirectionAssessment}
          client={itDirectionClient}
          onBackHome={handleRestart}
          onComplete={handleCompleteItDirectionAssessment}
          onRestart={handleRetakeItDirectionAssessment}
        />
      )}

      {screen === 'it-direction-results' && itDirectionResult && (
        <ITDirectionAssessmentResults
          result={itDirectionResult}
          saveStatus={itDirectionSaveStatus}
          onBackHome={handleRestart}
          onRetake={handleRetakeItDirectionAssessment}
        />
      )}
      </ErrorBoundary>
    </main>
  );
}

function RenderErrorFallback({ error, onBackToDashboard, onReload }) {
  return (
    <section className="form-panel render-error-panel" aria-labelledby="render-error-heading">
      <p className="eyebrow">Exam renderer</p>
      <h2 id="render-error-heading">Something went wrong while rendering this item.</h2>
      <p>
        Your app is still running. Return to the dashboard and start the item
        again, or reload the app if the screen does not recover.
      </p>
      {error?.message && (
        <details className="render-error-details">
          <summary>Technical detail</summary>
          <pre>{error.message}</pre>
        </details>
      )}
      <div className="button-row wrap">
        <button className="primary-button" type="button" onClick={onBackToDashboard}>
          Back to Dashboard
        </button>
        <button className="secondary-button" type="button" onClick={onReload}>
          Reload app
        </button>
      </div>
    </section>
  );
}

function NotFoundScreen({ path }) {
  return (
    <section className="form-panel" aria-labelledby="not-found-heading">
      <p className="eyebrow">Route not found</p>
      <h2 id="not-found-heading">That CertSim page is not available.</h2>
      <p>
        The route {path ? <code>{path}</code> : 'you opened'} does not match a
        visible exam, practice tool, account page, or assessment screen.
      </p>
    </section>
  );
}

function SignedInStudentStartScreen({ exam, isLoading, onBack }) {
  return (
    <section className="details-screen" aria-labelledby="signed-in-start-heading">
      <button className="text-button" type="button" onClick={onBack}>
        Back to dashboard
      </button>
      <section className="form-panel signed-in-start-panel">
        <p className="eyebrow">{exam?.name ?? 'CertSim exam'}</p>
        <h2 id="signed-in-start-heading">
          {isLoading ? 'Checking account details' : 'Starting from your account'}
        </h2>
        <p>
          Signed-in certification attempts use your account email and profile
          name automatically. If no profile name is available, CertSim uses
          your account email for the report.
        </p>
        <p className="auth-panel-muted">
          Protected certification attempts require a signed-in, entitled
          account. Your account identity is used automatically.
        </p>
      </section>
    </section>
  );
}

function createGeneratedAttempt({
  examConfig,
  mode,
  profile,
  codingLanguagePreference,
}) {
  if (
    examConfig.id === 'az400' &&
    profile?.sectionOrder === 'case-standard-pbq'
  ) {
    return generateAz400SectionedAttempt({
      examConfig,
      mode,
      profile,
    });
  }

  if (
    profile?.generationType === 'security-plus-pbq-first' ||
    (examConfig.id === 'security-plus-sy0-701' &&
      profile?.status === 'draft-beta')
  ) {
    return generateSecurityPlusStrictBetaAttempt({
      examConfig,
      mode,
      profile,
    });
  }

  return generateExamAttempt({
    metadata: examConfig.metadata,
    config: examConfig.generationConfig,
    questionBank: examConfig.questionBank,
    mode,
    profile,
    codingLanguagePreference,
  });
}

function createSelectedExamSummary(examConfig) {
  return {
    id: examConfig.id,
    slug: examConfig.slug,
    code: examConfig.code,
    shortName: examConfig.shortName,
    name: examConfig.ui.availableExamName,
    title: examConfig.title,
    vendor: examConfig.vendor,
    description: examConfig.ui.homeDescription,
    durationMinutes: examConfig.timing.defaultMinutes,
    passingScore: examConfig.passingScore,
    passingMicrosoftScore: examConfig.passingScore,
    scoreScale: examConfig.scoreScale,
    scoreLabel: examConfig.scoreLabel,
    questionCount: examConfig.questionCount ?? examConfig.questionBank.length,
    totalQuestionsToSelect: examConfig.generationConfig.totalQuestionsToSelect,
    domains: examConfig.domainNames,
    supportedFeatures: examConfig.supportedFeatures,
    guideNotes: examConfig.guideNotes ?? [],
    timedAttemptsIntro: examConfig.ui?.timedAttemptsIntro ?? '',
    statusNote: examConfig.statusNote,
    trainerValidationNote: examConfig.trainerValidationNote,
    shortDescription: examConfig.shortDescription,
    longDescription: examConfig.longDescription,
    disclaimers: examConfig.disclaimers,
    lifecycleNotice: examConfig.lifecycleNotice,
    lifecycle: examConfig.lifecycle,
    questionBankStatus: examConfig.questionBankStatus,
    status: examConfig.status,
    statusLabel: examConfig.ui.statusLabel,
    statusDescription: examConfig.ui.statusDescription,
    strictBetaMode: examConfig.strictBetaMode,
    strictBetaProfiles: examConfig.strictBetaProfiles ?? [],
    domainCount: examConfig.domainCount ?? examConfig.domainNames?.length ?? 0,
    pbqCount: examConfig.pbqCount ?? examConfig.demoLabs?.length ?? 0,
    caseStudyCount:
      examConfig.caseStudyCount ?? examConfig.caseStudyBlocks?.length ?? 0,
    supportsAttemptHistory: examConfig.supportsAttemptHistory,
    supportsStudySandbox: examConfig.supportsStudySandbox,
    supportsTargetedPractice: examConfig.supportsTargetedPractice,
    supportsPbqPreview: examConfig.supportsPbqPreview,
    supportsCaseStudyPreview: examConfig.supportsCaseStudyPreview,
    supportsSectionedFullExam: examConfig.supportsSectionedFullExam,
    demoLabCount: examConfig.demoLabs?.length ?? 0,
    caseStudyBlockCount: examConfig.caseStudyBlocks?.length ?? 0,
    caseStudyScoredQuestionCount: (examConfig.caseStudyBlocks ?? []).reduce(
      (total, block) => total + (block.questions?.length ?? 0),
      0,
    ),
  };
}

function getInitialRouteTarget() {
  if (typeof window === 'undefined') {
    return {
      screen: 'home',
    };
  }

  return getRouteTargetForPath(window.location.pathname, window.location.search);
}

function getRouteTargetForPath(pathname, search = '') {
  const routePath = normalizeRoutePath(pathname);
  const learnerAssignmentId = getValidAssignmentId(search);

  if (routePath === '/') {
    return {
      screen: 'home',
    };
  }

  if (routePath === '/exams') {
    return {
      screen: 'browse-exams',
    };
  }

  if (routePath === '/privacy' || routePath === '/terms') {
    return { screen: routePath.slice(1) };
  }

  if (routePath === '/assessments/it-direction') {
    return {
      screen: 'it-direction-intro',
    };
  }

  if (routePath === '/join') {
    return {
      screen: 'join',
      joinInviteToken: '',
    };
  }

  if (routePath.startsWith('/join/')) {
    const joinInviteToken = decodeRoutePart(
      routePath.replace('/join/', '').trim(),
    );

    return joinInviteToken
      ? {
          screen: 'join',
          joinInviteToken,
        }
      : createNotFoundRouteTarget(routePath);
  }

  if (routePath === '/account') {
    return {
      screen: 'account',
    };
  }

  if (routePath === '/account/assignments') {
    return {
      screen: 'account-assignments',
    };
  }

  if (routePath === '/account/progress') {
    return {
      screen: 'account-progress',
    };
  }

  if (routePath === '/account/reports') {
    return {
      screen: 'account-reports',
    };
  }

  if (routePath === '/account/results') {
    return {
      screen: 'saved-results',
    };
  }

  if (routePath === '/reception/placement') {
    return {
      screen: 'reception-placement',
    };
  }

  if (routePath === '/developer/dashboard') {
    return {
      screen: 'developer-dashboard',
    };
  }

  if (routePath.startsWith('/developer/reports/')) {
    const developerReportId = decodeRoutePart(
      routePath.replace('/developer/reports/', '').trim(),
    );

    return developerReportId
      ? {
          screen: 'developer-report-detail',
          developerReportId,
        }
      : createNotFoundRouteTarget(routePath);
  }

  if (routePath === '/admin/organisations') {
    return {
      screen: 'admin-organisations',
    };
  }

  if (routePath.startsWith('/admin/organisations/')) {
    const adminOrganisationId = decodeRoutePart(
      routePath.replace('/admin/organisations/', '').trim(),
    );

    return adminOrganisationId
      ? {
          screen: 'admin-organisation-detail',
          adminOrganisationId,
        }
      : createNotFoundRouteTarget(routePath);
  }

  if (routePath.startsWith('/admin/campuses/')) {
    const adminCampusId = decodeRoutePart(
      routePath.replace('/admin/campuses/', '').trim(),
    );

    return adminCampusId
      ? {
          screen: 'admin-campus-detail',
          adminCampusId,
        }
      : createNotFoundRouteTarget(routePath);
  }

  if (routePath.startsWith('/admin/groups/')) {
    const adminGroupId = decodeRoutePart(
      routePath.replace('/admin/groups/', '').trim(),
    );

    return adminGroupId
      ? {
          screen: 'admin-group-detail',
          adminGroupId,
        }
      : createNotFoundRouteTarget(routePath);
  }

  if (routePath === '/trainer/dashboard') {
    return {
      screen: 'trainer-dashboard',
    };
  }

  for (const section of ['analytics', 'assignments', 'students', 'results']) {
    if (routePath === `/trainer/dashboard/${section}`) return { screen: `trainer-dashboard-${section}` };
  }

  if (routePath.startsWith('/trainer/dashboard/results/')) {
    const trainerResultId = decodeRoutePart(routePath.replace('/trainer/dashboard/results/', '').trim());
    return trainerResultId
      ? { screen: 'trainer-dashboard-detail', trainerResultId }
      : createNotFoundRouteTarget(routePath);
  }

  if (routePath.startsWith('/trainer/assignments/')) {
    const trainerAssignmentId = decodeRoutePart(
      routePath.replace('/trainer/assignments/', '').trim(),
    );

    return trainerAssignmentId
      ? {
          screen: 'trainer-assignment-detail',
          trainerAssignmentId,
        }
      : createNotFoundRouteTarget(routePath);
  }

  if (routePath.startsWith('/trainer/students/')) {
    const trainerStudentId = decodeRoutePart(
      routePath.replace('/trainer/students/', '').trim(),
    );

    return trainerStudentId
      ? {
          screen: 'trainer-student-detail',
          trainerStudentId,
        }
      : createNotFoundRouteTarget(routePath);
  }

  if (routePath.startsWith('/account/results/')) {
    const attemptId = decodeRoutePart(
      routePath.replace('/account/results/', '').trim(),
    );

    return attemptId
      ? {
          screen: 'saved-result-detail',
          savedResultAttemptId: attemptId,
        }
      : createNotFoundRouteTarget(routePath);
  }

  const parts = routePath.split('/').filter(Boolean);

  if (parts[0] !== 'exams' || parts.length < 2) {
    return createNotFoundRouteTarget(routePath);
  }

  const examConfig = getExamConfigByRouteSlug(parts[1]);

  if (!examConfig) {
    return createNotFoundRouteTarget(routePath);
  }

  const routeAction = parts[2] ?? '';

  if (!routeAction) {
    return createExamRouteTarget(examConfig, 'exam-dashboard', { learnerAssignmentId });
  }

  if (routeAction === 'study') {
    return createExamRouteTarget(examConfig, 'sandbox', {
      practiceExamConfig: examConfig,
    });
  }

  if (routeAction === 'targeted') {
    return createExamRouteTarget(examConfig, 'targeted-practice', {
      practiceExamConfig: examConfig,
    });
  }

  if (routeAction === 'pbq-preview') {
    if (!canUseExamPracticeActions(examConfig) || (!(examConfig.demoLabs?.length ?? 0) && !examConfig.supportedFeatures?.pbqLabs)) {
      return createNotFoundRouteTarget(routePath);
    }

    return createExamRouteTarget(examConfig, 'pbq-preview', {
      pbqPreviewLabs: examConfig.demoLabs ?? [],
      practiceExamConfig: examConfig,
    });
  }

  if (routeAction === 'case-studies') {
    if ((examConfig.caseStudyBlocks?.length ?? 0) === 0 && !examConfig.supportedFeatures?.caseStudies) {
      return createNotFoundRouteTarget(routePath);
    }

    return createExamRouteTarget(examConfig, 'case-study-preview', {
      practiceExamConfig: examConfig,
    });
  }

  const timedRouteSelection = getTimedRouteSelection(examConfig, routeAction);

  if (!timedRouteSelection) {
    return createNotFoundRouteTarget(routePath);
  }

  return createExamRouteTarget(examConfig, 'student', {
    ...timedRouteSelection,
    learnerAssignmentId,
  });
}

function createExamRouteTarget(examConfig, screen, details = {}) {
  return {
    screen,
    examConfig,
    selectedMode:
      details.selectedMode ?? examConfig.examModeOptions?.[0] ?? null,
    selectedProfile:
      details.selectedProfile ?? examConfig.fullMockProfile ?? null,
    practiceExamConfig:
      details.practiceExamConfig ??
      (screen === 'sandbox' ||
      screen === 'targeted-practice' ||
      screen === 'pbq-preview' ||
      screen === 'case-study-preview'
        ? examConfig
        : null),
    pbqPreviewLabs: details.pbqPreviewLabs ?? [],
    learnerAssignmentId: details.learnerAssignmentId ?? '',
  };
}

function createNotFoundRouteTarget(routePath) {
  return {
    screen: 'not-found',
    notFoundPath: routePath,
  };
}

function getTimedRouteSelection(examConfig, routeAction) {
  if (protectedDeliveryMode === DELIVERY_MODES.protected) {
    const selectedProfile = (examConfig.strictBetaProfiles ?? []).find(
      (profile) => getStrictProfileRouteAction(profile) === routeAction,
    );
    return selectedProfile
      ? { selectedMode: examConfig.strictBetaMode, selectedProfile }
      : null;
  }
  if (examConfig.id === 'az204') {
    if (routeAction === 'full' && canStartStandardExamMode(examConfig)) {
      return {
        selectedMode: examConfig.getExamModeById(examConfig.modeIds.fullMock),
        selectedProfile: examConfig.fullMockProfile,
      };
    }

    if (routeAction === 'realistic' && canStartStandardExamMode(examConfig)) {
      return {
        selectedMode: examConfig.getExamModeById(examConfig.modeIds.realisticRandom),
        selectedProfile: examConfig.getRandomRealisticProfile(),
      };
    }

    return null;
  }

  if (examConfig.id === 'security-plus-sy0-701') {
    const profileId =
      routeAction === 'full'
        ? 'strict-beta-full'
        : routeAction === 'compact'
          ? 'strict-beta-compact'
          : null;
    const selectedProfile = examConfig.strictBetaProfiles?.find(
      (profile) => profile.id === profileId,
    );

    if (!profileId || !selectedProfile || !canUseExamPracticeActions(examConfig)) {
      return null;
    }

    return {
      selectedMode: examConfig.strictBetaMode,
      selectedProfile,
    };
  }

  if (examConfig.id === 'az400') {
    if (routeAction === 'full' && canStartStandardExamMode(examConfig)) {
      return {
        selectedMode: examConfig.getExamModeById(examConfig.modeIds.fullMock),
        selectedProfile: examConfig.fullMockProfile,
      };
    }

    if (
      (routeAction === 'realistic-compact' || routeAction === 'realistic-full') &&
      canStartStandardExamMode(examConfig)
    ) {
      const profileId =
        routeAction === 'realistic-compact'
          ? 'az400-mvp-compact-profile'
          : 'az400-mvp-full-profile';
      const selectedProfile = examConfig.profiles.realisticRandom?.find(
        (profile) => profile.id === profileId,
      );

      if (!selectedProfile) {
        return null;
      }

      return {
        selectedMode: examConfig.getExamModeById(examConfig.modeIds.realisticRandom),
        selectedProfile,
      };
    }

    if (routeAction === 'full-sectioned') {
      const selectedProfile = examConfig.strictBetaProfiles?.find(
        (profile) => profile.id === 'az400-sectioned-full-exam-profile',
      );

      if (!selectedProfile || !canUseExamPracticeActions(examConfig)) {
        return null;
      }

      return {
        selectedMode: examConfig.strictBetaMode,
        selectedProfile,
      };
    }
  }

  const genericStrictProfile = getStrictProfileForRouteAction(
    examConfig,
    routeAction,
  );

  if (genericStrictProfile && canUseExamPracticeActions(examConfig)) {
    return {
      selectedMode: examConfig.strictBetaMode,
      selectedProfile: genericStrictProfile,
    };
  }

  return null;
}

function getPathForCurrentState({
  adminCampusId,
  adminGroupId,
  adminOrganisationId,
  notFoundPath,
  practiceExamConfig,
  result,
  savedResultAttemptId,
  screen,
  selectedExamConfig,
  selectedMode,
  selectedProfile,
  developerReportId,
  joinInviteToken,
  learnerAssignmentId,
  trainerAssignmentId,
  trainerResultId,
  trainerStudentId,
}) {
  if (screen === 'home') {
    return '/';
  }

  if (screen === 'privacy' || screen === 'terms') {
    return `/${screen}`;
  }

  if (screen === 'browse-exams' || screen === 'strict-unavailable' || screen === 'delivery-unavailable') {
    return '/exams';
  }

  if (screen === 'not-found') {
    return normalizeRoutePath(notFoundPath || '/not-found');
  }

  if (screen === 'account') {
    return '/account';
  }

  if (screen === 'join') {
    return joinInviteToken
      ? `/join/${encodeURIComponent(joinInviteToken)}`
      : '/join';
  }

  if (screen === 'account-assignments') {
    return '/account/assignments';
  }

  if (screen === 'account-progress') {
    return '/account/progress';
  }

  if (screen === 'account-reports') {
    return '/account/reports';
  }

  if (screen === 'saved-results') {
    return '/account/results';
  }

  if (screen === 'saved-result-detail') {
    return savedResultAttemptId
      ? `/account/results/${encodeURIComponent(savedResultAttemptId)}`
      : '/account/results';
  }

  if (screen === 'reception-placement') {
    return '/reception/placement';
  }

  if (screen === 'developer-dashboard') {
    return '/developer/dashboard';
  }

  if (screen === 'developer-report-detail') {
    return developerReportId
      ? `/developer/reports/${encodeURIComponent(developerReportId)}`
      : '/developer/dashboard';
  }

  if (screen === 'admin-organisations') {
    return '/admin/organisations';
  }

  if (screen === 'admin-organisation-detail') {
    return adminOrganisationId
      ? `/admin/organisations/${encodeURIComponent(adminOrganisationId)}`
      : '/admin/organisations';
  }

  if (screen === 'admin-campus-detail') {
    return adminCampusId
      ? `/admin/campuses/${encodeURIComponent(adminCampusId)}`
      : '/admin/organisations';
  }

  if (screen === 'admin-group-detail') {
    return adminGroupId
      ? `/admin/groups/${encodeURIComponent(adminGroupId)}`
      : '/admin/organisations';
  }

  if (screen.startsWith('trainer-dashboard')) {
    const section = screen.replace('trainer-dashboard-', '');
    if (section === screen) return '/trainer/dashboard';
    if (section === 'detail') return trainerResultId ? `/trainer/dashboard/results/${encodeURIComponent(trainerResultId)}` : '/trainer/dashboard/results';
    return `/trainer/dashboard/${section}`;
  }

  if (screen === 'trainer-student-detail') {
    return trainerStudentId
      ? `/trainer/students/${encodeURIComponent(trainerStudentId)}`
      : '/trainer/dashboard';
  }

  if (screen === 'trainer-assignment-detail') {
    return trainerAssignmentId
      ? `/trainer/assignments/${encodeURIComponent(trainerAssignmentId)}`
      : '/trainer/dashboard';
  }

  if (screen.startsWith('it-direction')) {
    return '/assessments/it-direction';
  }

  const examConfig =
    selectedExamConfig ??
    practiceExamConfig ??
    getExamConfigFromResult(result);
  const dashboardPath = getExamDashboardPath(examConfig);

  if (!dashboardPath) {
    return '/exams';
  }

  if (screen === 'exam-dashboard') {
    return appendLearnerAssignment(dashboardPath, learnerAssignmentId);
  }

  if (screen === 'sandbox') {
    return `${dashboardPath}/study`;
  }

  if (screen === 'targeted-practice') {
    return `${dashboardPath}/targeted`;
  }

  if (screen === 'pbq-preview') {
    return `${dashboardPath}/pbq-preview`;
  }

  if (screen === 'case-study-preview') {
    return `${dashboardPath}/case-studies`;
  }

  if (
    screen === 'student' ||
    screen === 'exam' ||
    screen === 'results' ||
    screen === 'review'
  ) {
    return appendLearnerAssignment(
      getTimedRoutePath(examConfig, selectedMode, selectedProfile) ?? dashboardPath,
      learnerAssignmentId,
    );
  }

  return dashboardPath;
}

function getValidAssignmentId(search = '') {
  const value = new URLSearchParams(search).get('assignment') ?? '';
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : '';
}

function appendLearnerAssignment(path, assignmentId) {
  return assignmentId
    ? `${path}?assignment=${encodeURIComponent(assignmentId)}`
    : path;
}

function getTimedRoutePath(examConfig, selectedMode, selectedProfile) {
  const dashboardPath = getExamDashboardPath(examConfig);

  if (!dashboardPath) {
    return null;
  }

  if (protectedDeliveryMode === DELIVERY_MODES.protected) {
    const routeAction = getStrictProfileRouteAction(selectedProfile);
    return routeAction ? `${dashboardPath}/${routeAction}` : null;
  }

  if (examConfig.id === 'security-plus-sy0-701') {
    return selectedProfile?.id === 'strict-beta-compact'
      ? `${dashboardPath}/compact`
      : `${dashboardPath}/full`;
  }

  if (examConfig.id === 'az400') {
    if (selectedProfile?.sectionOrder === 'case-standard-pbq') {
      return `${dashboardPath}/full-sectioned`;
    }

    if (selectedMode?.id === examConfig.modeIds.realisticRandom) {
      return selectedProfile?.id === 'az400-mvp-compact-profile'
        ? `${dashboardPath}/realistic-compact`
        : `${dashboardPath}/realistic-full`;
    }

    return `${dashboardPath}/full`;
  }

  if (examConfig.id === 'az204') {
    return selectedMode?.id === examConfig.modeIds.realisticRandom
      ? `${dashboardPath}/realistic`
      : `${dashboardPath}/full`;
  }

  const genericStrictRouteAction = getStrictProfileRouteAction(selectedProfile);

  if (genericStrictRouteAction && selectedMode?.id === examConfig.strictBetaMode?.id) {
    return `${dashboardPath}/${genericStrictRouteAction}`;
  }

  return dashboardPath;
}

function getStrictProfileForRouteAction(examConfig, routeAction) {
  return (examConfig.strictBetaProfiles ?? []).find(
    (profile) => getStrictProfileRouteAction(profile) === routeAction,
  );
}

function getStrictProfileRouteAction(profile) {
  if (!profile) {
    return '';
  }

  if (profile.routeAction) {
    return profile.routeAction;
  }

  const searchable = [
    profile.publicId,
    profile.id,
    profile.displayName,
    profile.name,
    profile.generationType,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (searchable.includes('compact')) {
    return 'compact';
  }

  if (searchable.includes('full') && searchable.includes('section')) {
    return 'full-sectioned';
  }

  if (searchable.includes('full')) {
    return 'full';
  }

  return '';
}

function getExamDashboardPath(examConfig) {
  const slug = getExamRouteSlug(examConfig);

  return slug ? `/exams/${slug}` : null;
}

function getExamRouteSlug(examConfig) {
  return examRouteSlugs[examConfig?.id] ?? null;
}

function getExamConfigByRouteSlug(slug) {
  const examId = Object.entries(examRouteSlugs).find(
    ([, routeSlug]) => routeSlug === slug,
  )?.[0];

  if (!examId) {
    return null;
  }

  const examConfig = examRegistry.find((item) => item.id === examId);

  if (!examConfig) {
    return null;
  }

  if (isLiveVisibleExamConfig(examConfig)) {
    return examConfig;
  }

  return showDraftExamAccess && isDraftExamConfig(examConfig)
    ? examConfig
    : null;
}

function getExamConfigFromResult(result) {
  const examId = result?.exam?.registryId ?? result?.exam?.id;

  return examRegistry.find((examConfig) => examConfig.id === examId) ?? null;
}

function normalizeItDirectionClientDetails(clientDetails = {}) {
  const name = String(clientDetails.name ?? '').trim();
  const surname = String(clientDetails.surname ?? '').trim();
  const contact = String(clientDetails.contact ?? '').trim();
  const displayName = [name, surname].filter(Boolean).join(' ');

  return {
    name,
    surname,
    contact,
    displayName,
  };
}

function normalizeRoutePath(pathname) {
  const rawPath = String(pathname || '/').split(/[?#]/)[0] || '/';
  const collapsedPath = rawPath.replace(/\/{2,}/g, '/');
  const withoutTrailingSlash =
    collapsedPath.length > 1
      ? collapsedPath.replace(/\/+$/g, '')
      : collapsedPath;

  return withoutTrailingSlash || '/';
}

function decodeRoutePart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
}

function isRestorableHistoryScreen(screen) {
  return [
    'exam',
    'results',
    'review',
    'it-direction-runner',
    'it-direction-results',
  ].includes(screen);
}

function getInitialLastSelectedExamConfig() {
  const storedExamId = readSelectedExamId();

  if (!storedExamId) {
    return null;
  }

  const examConfig = examRegistry.find((item) => item.id === storedExamId);

  if (!examConfig) {
    return null;
  }

  if (isLiveVisibleExamConfig(examConfig)) {
    return examConfig;
  }

  return showDraftExamAccess && isDraftExamConfig(examConfig)
    ? examConfig
    : null;
}

function getSafeSelectableExamConfig(examId) {
  const examConfig = getExamConfigById(examId);

  if (isLiveVisibleExamConfig(examConfig)) {
    return examConfig;
  }

  return showDraftExamAccess && isDraftExamConfig(examConfig)
    ? examConfig
    : defaultExamConfig;
}

function canUseExamPracticeActions(examConfig) {
  return (
    isLiveVisibleExamConfig(examConfig) ||
    (showDraftExamAccess && isDraftExamConfig(examConfig))
  );
}

function readSelectedExamId() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return null;
  }

  try {
    return window.localStorage.getItem(selectedExamStorageKey);
  } catch {
    return null;
  }
}

function saveSelectedExamId(examId) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  try {
    const examConfig = examRegistry.find((item) => item.id === examId);
    const canPersistSelection =
      isLiveVisibleExamConfig(examConfig) ||
      (showDraftExamAccess && isDraftExamConfig(examConfig));

    if (!canPersistSelection) {
      window.localStorage.removeItem(selectedExamStorageKey);
      return;
    }

    window.localStorage.setItem(selectedExamStorageKey, examId);
  } catch {
    // Selection persistence is optional; falling back to the default exam is safe.
  }
}

function readAz204CodingLanguagePreference() {
  if (typeof window === 'undefined' || !window.localStorage) {
    return DEFAULT_CODING_LANGUAGE_PREFERENCE;
  }

  try {
    return normalizeCodingLanguagePreference(
      window.localStorage.getItem(az204CodingLanguageStorageKey),
    );
  } catch {
    return DEFAULT_CODING_LANGUAGE_PREFERENCE;
  }
}

function saveAz204CodingLanguagePreference(preference) {
  if (typeof window === 'undefined' || !window.localStorage) {
    return;
  }

  try {
    window.localStorage.setItem(
      az204CodingLanguageStorageKey,
      normalizeCodingLanguagePreference(preference),
    );
  } catch {
    // Coding language preference is optional.
  }
}

function enrichGeneratedExam(generatedAttempt, examConfig) {
  return {
    ...generatedAttempt,
    registryId: examConfig.id,
    vendor: examConfig.vendor,
    shortName: examConfig.shortName,
    displayTitle: examConfig.title,
    scoreScale: examConfig.scoreScale,
    scoreLabel: examConfig.scoreLabel,
    reportTitle: examConfig.ui.reportTitle,
    passingScore: examConfig.passingScore,
    passingMicrosoftScore: examConfig.passingScore,
    supportedFeatures: examConfig.supportedFeatures,
    disclaimers: examConfig.disclaimers,
    lifecycleNotice: examConfig.lifecycleNotice,
    statusLabel: examConfig.ui.statusLabel,
    statusDescription: examConfig.ui.statusDescription,
    isDraftBeta:
      generatedAttempt.isDraftBeta ??
      getExamLifecycle(examConfig) === EXAM_LIFECYCLES.controlledBeta,
    hasFrontLoadedPbqs: generatedAttempt.hasFrontLoadedPbqs ?? false,
    disableAttemptHistory:
      generatedAttempt.disableAttemptHistory ??
      (examConfig.supportedFeatures.attemptHistory !== true),
    scoreNotice: generatedAttempt.scoreNotice,
  };
}

function canStartStandardExamMode(examConfig) {
  return (
    isStartableLifecycle(getExamLifecycle(examConfig)) &&
    (examConfig?.examModeOptions?.length ?? 0) > 0
  );
}

function getAttemptHistoryDisabledMessage(exam) {
  if (
    (exam.registryId ?? exam.id) === 'security-plus-sy0-701' &&
    exam.statusLabel === 'Production-ready'
  ) {
    return 'Attempt history is currently disabled for Security+ PBQ-first practice attempts.';
  }

  if (
    (exam.registryId ?? exam.id) === 'az400' &&
    exam.statusLabel === 'Production-ready'
  ) {
    return 'Attempt history is currently disabled for AZ-400 sectioned full exam attempts.';
  }

  return 'Attempt history is disabled for controlled beta or preview attempts.';
}
