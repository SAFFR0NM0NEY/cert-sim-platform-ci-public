import { useMemo, useState } from 'react';
import { ExamProgressSummary } from '../results/SavedResultsPage.jsx';
import StudentGuide from './StudentGuide.jsx';
import {
  EXAM_LIFECYCLES,
  getExamLifecycle,
  getLifecycleStatusDescription,
  getLifecycleStatusLabel,
  isDraftLifecycle,
  isStartableLifecycle,
} from '../../exams/examLifecycle.js';
import {
  deriveExamLibraryOptions,
  EXAM_LIBRARY_DEFAULTS,
  filterAndSortExamLibrary,
  isDefaultExamLibraryState,
} from './examLibraryHelpers.js';

export default function Home({
  exam,
  examOptions = [],
  isDraftAccessEnabled,
  lastSelectedExam,
  modes = [],
  view = 'home',
  onBrowseExams,
  onConfigureWeakAreaPractice,
  onContinueLastSelectedExam,
  onOpenDashboard,
  onOpenDraftStudySandbox,
  onOpenDraftTargetedPractice,
  onOpenCaseStudyPreview,
  onOpenItDirectionAssessment,
  onOpenStudySandbox,
  onOpenTargetedPractice,
  onOpenPBQPreview,
  onOpenSavedResults,
  onReturnHome,
  onSelectExam,
  onStartDraftStrictBeta,
  onStartExam,
}) {
  const selectedExamCanOpenSandbox = Boolean(
    exam?.supportedFeatures?.studySandbox,
  );

  if (view === 'browse') {
    return (
      <BrowseExamsView
        examOptions={examOptions}
        isDraftAccessEnabled={isDraftAccessEnabled}
        onOpenItDirectionAssessment={onOpenItDirectionAssessment}
        onReturnHome={onReturnHome}
        onSelectExam={onSelectExam}
        selectedExamId={exam?.id ?? ''}
      />
    );
  }

  if (view === 'dashboard') {
    if (!exam) {
      return (
        <ChooseExamFirst
          onBrowseExams={onBrowseExams}
          onReturnHome={onReturnHome}
        />
      );
    }

    return (
      <SelectedExamDashboard
        exam={exam}
        modes={modes}
        onBrowseExams={onBrowseExams}
        onConfigureWeakAreaPractice={onConfigureWeakAreaPractice}
        onOpenDraftStudySandbox={onOpenDraftStudySandbox}
        onOpenDraftTargetedPractice={onOpenDraftTargetedPractice}
        onOpenCaseStudyPreview={onOpenCaseStudyPreview}
        onOpenPBQPreview={onOpenPBQPreview}
        onOpenSavedResults={onOpenSavedResults}
        onOpenStudySandbox={onOpenStudySandbox}
        onOpenTargetedPractice={onOpenTargetedPractice}
        onReturnHome={onReturnHome}
        onStartDraftStrictBeta={onStartDraftStrictBeta}
        onStartExam={onStartExam}
      />
    );
  }

  return (
    <CompactHome
      exam={exam}
      lastSelectedExam={lastSelectedExam}
      onBrowseExams={onBrowseExams}
      onContinueLastSelectedExam={onContinueLastSelectedExam}
      onOpenDashboard={onOpenDashboard}
      onOpenDraftStudySandbox={onOpenDraftStudySandbox}
      onOpenItDirectionAssessment={onOpenItDirectionAssessment}
      onOpenStudySandbox={onOpenStudySandbox}
      selectedExamCanOpenSandbox={selectedExamCanOpenSandbox}
    />
  );
}

function CompactHome({
  exam,
  lastSelectedExam,
  onBrowseExams,
  onContinueLastSelectedExam,
  onOpenDashboard,
  onOpenDraftStudySandbox,
  onOpenItDirectionAssessment,
  onOpenStudySandbox,
  selectedExamCanOpenSandbox,
}) {
  const guideActionLabel = exam ? 'Open Dashboard' : 'Browse Exams';
  const handleGuideAction = exam ? onOpenDashboard : onBrowseExams;

  return (
    <section className="home-overview" aria-labelledby="home-heading">
      <div className="hero-panel compact-hero">
        <p className="eyebrow">Certification practice platform</p>
        <h1 id="home-heading">Certification Exam Simulator</h1>
        <p className="hero-copy">
          Strict browser-based practice for certification exams, focused on
          timed attempts, weak-domain review, sandbox study, and original
          question content.
        </p>
      </div>

      <section className="home-action-grid" aria-label="Main actions">
        <article className="home-action-card selected">
          <div className="home-action-card-content">
            <h3>Browse Exams</h3>
            <div className="home-action-card-status">
              <span className="status-badge">Start here</span>
            </div>
            <p>
              Choose an exam module before opening exam actions. Nothing is
              auto-selected on load.
            </p>
          </div>
          <div className="home-action-card-action">
            <button className="primary-button" type="button" onClick={onBrowseExams}>
              Browse Exams
            </button>
          </div>
        </article>

        <article className="home-action-card">
          <div className="home-action-card-content">
            <h3>Continue last selected exam</h3>
            <div className="home-action-card-status" aria-hidden={!lastSelectedExam}>
              {lastSelectedExam && (
                <span className="status-badge">{getExamStatusLabel(lastSelectedExam)}</span>
              )}
            </div>
            {lastSelectedExam ? (
              <p>
                Continue with {lastSelectedExam.name}. This does not open
                automatically.
              </p>
            ) : (
              <p>No previous exam is stored for this browser yet.</p>
            )}
          </div>
          <div className="home-action-card-action">
            {lastSelectedExam ? (
              <button
                className="secondary-button"
                type="button"
                onClick={onContinueLastSelectedExam}
              >
                Continue {lastSelectedExam.shortName}
              </button>
            ) : (
              <button className="secondary-button" type="button" onClick={onBrowseExams}>
                Choose an Exam
              </button>
            )}
          </div>
        </article>

        <article className="home-action-card">
          <div className="home-action-card-content">
            <h3>Study Sandbox</h3>
            <div className="home-action-card-status" aria-hidden="true" />
            <p>Use protected untimed practice without changing formal readiness.</p>
          </div>
          <div className="home-action-card-action">
            {selectedExamCanOpenSandbox ? (
              <button className="secondary-button" type="button" onClick={onOpenStudySandbox}>
                Open Sandbox
              </button>
            ) : (
              <button className="secondary-button" type="button" onClick={onBrowseExams}>
                Choose Exam First
              </button>
            )}
          </div>
        </article>

        <article className="home-action-card">
          <div className="home-action-card-content">
            <h3>Guide and History</h3>
            <div className="home-action-card-status" aria-hidden="true" />
            <p>
              Student guidance and local history live on each selected exam dashboard.
            </p>
          </div>
          <div className="home-action-card-action">
            <button className="secondary-button" type="button" onClick={handleGuideAction}>
              {guideActionLabel}
            </button>
          </div>
        </article>
      </section>

      <GuidanceAssessmentPanel onOpenItDirectionAssessment={onOpenItDirectionAssessment} />
    </section>
  );
}

function ChooseExamFirst({ onBrowseExams }) {
  return (
    <section className="form-panel choose-exam-panel" aria-labelledby="choose-exam-heading">
      <p className="eyebrow">Choose exam first</p>
      <h2 id="choose-exam-heading">No exam is selected yet.</h2>
      <p>
        Browse Exams is the main place to choose a CertSim exam before opening
        dashboards, sandbox modes, or strict attempts.
      </p>
      <button className="primary-button" type="button" onClick={onBrowseExams}>
        Browse Exams
      </button>
    </section>
  );
}

function BrowseExamsView({
  examOptions,
  isDraftAccessEnabled,
  onOpenItDirectionAssessment,
  onReturnHome,
  onSelectExam,
  selectedExamId,
}) {
  const [libraryState, setLibraryState] = useState(EXAM_LIBRARY_DEFAULTS);
  const { vendors, lifecycles } = useMemo(
    () => deriveExamLibraryOptions(examOptions),
    [examOptions],
  );
  const filteredExams = useMemo(
    () => filterAndSortExamLibrary(examOptions, libraryState),
    [examOptions, libraryState],
  );
  const isDefaultState = isDefaultExamLibraryState(libraryState);

  function updateLibraryState(field, value) {
    setLibraryState((current) => ({ ...current, [field]: value }));
  }

  function resetLibrary() {
    setLibraryState(EXAM_LIBRARY_DEFAULTS);
  }

  return (
    <section className="browse-exams-view" aria-labelledby="browse-exams-heading">
      <div className="view-toolbar">
        <div>
          <p className="eyebrow">Browse Exams</p>
          <h2 id="browse-exams-heading">Exam Library</h2>
        </div>
      </div>

      <section className="exam-library-controls" aria-label="Search and filter certification exams">
        <div className="exam-library-field exam-library-search">
          <label htmlFor="exam-library-search">Search exams</label>
          <input
            id="exam-library-search"
            type="search"
            value={libraryState.query}
            onChange={(event) => updateLibraryState('query', event.target.value)}
            placeholder="Code, name, vendor, topic, or status"
          />
        </div>
        <div className="exam-library-field">
          <label htmlFor="exam-library-vendor">Vendor</label>
          <select
            id="exam-library-vendor"
            value={libraryState.vendor}
            onChange={(event) => updateLibraryState('vendor', event.target.value)}
          >
            <option value="all">All vendors</option>
            {vendors.map((vendor) => <option key={vendor} value={vendor}>{vendor}</option>)}
          </select>
        </div>
        <div className="exam-library-field">
          <label htmlFor="exam-library-lifecycle">Status</label>
          <select
            id="exam-library-lifecycle"
            value={libraryState.lifecycle}
            onChange={(event) => updateLibraryState('lifecycle', event.target.value)}
          >
            <option value="all">All statuses</option>
            {lifecycles.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
        <div className="exam-library-field">
          <label htmlFor="exam-library-sort">Sort by</label>
          <select
            id="exam-library-sort"
            value={libraryState.sort}
            onChange={(event) => updateLibraryState('sort', event.target.value)}
          >
            <option value="recommended">Recommended</option>
            <option value="name">Name A-Z</option>
            <option value="vendor">Vendor A-Z</option>
            <option value="lifecycle">Status A-Z</option>
          </select>
        </div>
        <button
          className="secondary-button exam-library-reset"
          type="button"
          onClick={resetLibrary}
          disabled={isDefaultState}
        >
          Reset search and filters
        </button>
      </section>

      <p className="exam-library-count" role="status" aria-live="polite">
        Showing {filteredExams.length} of {examOptions.length} certification exams
      </p>

      <GuidanceAssessmentPanel
        compact
        onOpenItDirectionAssessment={onOpenItDirectionAssessment}
      />

      {filteredExams.length > 0 ? (
        <ExamSelector
          exams={filteredExams}
          isDraftAccessEnabled={isDraftAccessEnabled}
          onSelectExam={onSelectExam}
          selectedExamId={selectedExamId}
        />
      ) : (
        <section className="exam-library-empty" aria-labelledby="exam-library-empty-heading">
          <p className="eyebrow">No matches</p>
          <h3 id="exam-library-empty-heading">No certification exams match</h3>
          <p>Change the search or filters, or use the reset action above.</p>
        </section>
      )}
    </section>
  );
}

function GuidanceAssessmentPanel({ compact = false, onOpenItDirectionAssessment }) {
  return (
    <section
      className={compact ? 'guidance-assessment-panel compact' : 'guidance-assessment-panel'}
      aria-labelledby={compact ? 'guidance-assessment-browse-heading' : 'guidance-assessment-heading'}
    >
      <div>
        <p className="eyebrow">Guidance assessments</p>
        <h3 id={compact ? 'guidance-assessment-browse-heading' : 'guidance-assessment-heading'}>
          IT Direction Assessment
        </h3>
        <p>
          A reception-friendly guidance tool for clients and students. It helps
          discuss likely study paths based on interests, basic readiness, and
          problem-solving style.
        </p>
      </div>
      <div className="guidance-assessment-actions">
        <span className="status-badge">Not a certification exam</span>
        <button
          className="primary-button"
          type="button"
          onClick={onOpenItDirectionAssessment}
        >
          Start Assessment
        </button>
      </div>
    </section>
  );
}

function SelectedExamDashboard({
  exam,
  modes,
  onBrowseExams,
  onConfigureWeakAreaPractice,
  onOpenDraftStudySandbox,
  onOpenDraftTargetedPractice,
  onOpenCaseStudyPreview,
  onOpenPBQPreview,
  onOpenSavedResults,
  onOpenStudySandbox,
  onOpenTargetedPractice,
  onStartDraftStrictBeta,
  onStartExam,
}) {
  const selectedExamLifecycle = getExamLifecycle(exam);
  const selectedExamIsAvailable = isStartableLifecycle(selectedExamLifecycle);
  const canStartStandardModes =
    selectedExamIsAvailable && (exam.supportedFeatures?.fullMock || modes.length > 0);
  const standardModes = canStartStandardModes ? modes : [];
  const openStudySandbox = isDraftLifecycle(selectedExamLifecycle)
    ? () => onOpenDraftStudySandbox?.(exam.id)
    : onOpenStudySandbox;
  const openTargetedPractice = isDraftLifecycle(selectedExamLifecycle)
    ? () => onOpenDraftTargetedPractice?.(exam.id)
    : onOpenTargetedPractice;

  return (
    <section className="exam-dashboard-view" aria-labelledby="exam-dashboard-heading">
      <div className="view-toolbar">
        <div>
          <p className="eyebrow">Selected Exam Dashboard</p>
          <h2 id="exam-dashboard-heading">{exam.name}</h2>
        </div>
        <button className="secondary-button" type="button" onClick={onBrowseExams}>
          Back to Exam Library
        </button>
      </div>

      <section className="dashboard-summary-card" aria-label="Selected exam summary">
        <span className="status-badge">{getExamStatusLabel(exam)}</span>
        <div>
          <h3>Practice overview</h3>
          <p>
            {exam.vendor}. {exam.description}
          </p>
          {exam.lifecycleNotice && (
            <p className="lifecycle-notice">{exam.lifecycleNotice}</p>
          )}
        </div>
        <dl className="exam-stats compact">
          {getDashboardSummaryStats(exam).map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      {selectedExamIsAvailable && (
        <>
          <TimedAttemptsSection
            exam={exam}
            modes={standardModes}
            onStartDraftStrictBeta={onStartDraftStrictBeta}
            onStartExam={onStartExam}
          />
          <PracticeToolsSection
            exam={exam}
            onOpenCaseStudyPreview={onOpenCaseStudyPreview}
            onOpenPBQPreview={onOpenPBQPreview}
            onOpenStudySandbox={openStudySandbox}
            onOpenTargetedPractice={openTargetedPractice}
          />
          <StudentGuide exam={exam} />
          <ExamProgressSummary
            exam={exam}
            onConfigureWeakAreaPractice={onConfigureWeakAreaPractice}
            onOpenSavedResults={onOpenSavedResults}
          />
        </>
      )}

      {!selectedExamIsAvailable && (
        <UnavailableExamCard exam={exam} />
      )}
    </section>
  );
}

function ExamSelector({
  exams,
  isDraftAccessEnabled,
  onSelectExam,
  selectedExamId,
}) {
  return (
    <section className="exam-selector-panel" aria-labelledby="exam-selector-heading">
      <div className="exam-selector-header">
        <div>
          <p className="eyebrow">Choose Exam</p>
          <h3 id="exam-selector-heading">Available Exam Modules</h3>
        </div>
        <p>
          {isDraftAccessEnabled
            ? 'Available certification practice modules, production-ready modules, controlled beta modules, and hidden drafts are visible in this environment.'
            : 'Choose a practice exam, production-ready module, or controlled beta module.'}
        </p>
      </div>

      <div className="exam-selector-grid">
        {exams.map((examOption) => (
          <button
            className={
              examOption.id === selectedExamId
                ? 'exam-selector-card active'
                : 'exam-selector-card'
            }
            key={examOption.id}
            type="button"
            onClick={() => onSelectExam(examOption.id)}
            aria-pressed={examOption.id === selectedExamId}
          >
            <span className="exam-selector-status">
              {getExamStatusLabel(examOption)}
            </span>
            <span className="exam-selector-code">{examOption.code}</span>
            <strong className="exam-selector-title">{examOption.shortTitle}</strong>
            <small className="exam-selector-vendor">{examOption.vendor}</small>
            <span className="exam-selector-description">
              {getExamStatusDescription(examOption)}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

function TimedAttemptsSection({
  exam,
  modes,
  onStartDraftStrictBeta,
  onStartExam,
}) {
  const strictProfiles = [...(exam.strictBetaProfiles ?? [])].sort((a, b) =>
    a.totalItems - b.totalItems
  );
  const hasTimedAttempts = modes.length > 0 || strictProfiles.length > 0;

  if (!hasTimedAttempts) {
    return null;
  }

  return (
    <section className="exam-card" aria-label="Timed exam attempts">
      <p className="eyebrow">Timed attempts</p>
      <h3>Timed Attempts</h3>
      <p>{getTimedAttemptsIntro(exam)}</p>

      <div className="exam-mode-grid dashboard-mode-grid">
        {strictProfiles.map((profile) => (
          <article className="exam-mode-card" key={profile.id}>
            <span className="status-badge">{profile.availabilityStatus === 'available' ? 'Available' : 'Unavailable'}</span>
            <h4>{getProfileDisplayName(profile, exam)}</h4>
            <p>{profile.description}</p>
            <dl className="exam-stats compact">
              <div>
                <dt>Scored items</dt>
                <dd>{profile.totalScoredQuestions ?? profile.totalItems}</dd>
              </div>
              <div>
                <dt>Timer</dt>
                <dd>{profile.timeLimitMinutes} minutes</dd>
              </div>
              {profile.pbqCount ? (
                <div>
                  <dt>PBQs</dt>
                  <dd>{formatPbqPlacement(profile)}</dd>
                </div>
              ) : null}
              {profile.caseStudyCount ? (
                <div>
                  <dt>Case studies</dt>
                  <dd>{formatCaseStudySummary(profile)}</dd>
                </div>
              ) : null}
              <div>
                <dt>Standard questions</dt>
                <dd>{formatStandardQuestionSummary(profile)}</dd>
              </div>
            </dl>
            <button
              className="primary-button"
              type="button"
              onClick={() => onStartDraftStrictBeta?.(exam.id, profile.id)}
            >
              Start {getProfileDisplayName(profile, exam)}
            </button>
          </article>
        ))}
        {modes.map((mode) => {
          const specialSectionFact = getModeSpecialSectionFact(exam, mode);

          return (
            <article className="exam-mode-card" key={mode.id}>
              <h4>{mode.name}</h4>
              <p>{mode.description}</p>
              <dl className="exam-stats compact">
                <div>
                  <dt>Scored questions</dt>
                  <dd>{mode.questionSummary}</dd>
                </div>
                <div>
                  <dt>Timer</dt>
                  <dd>{mode.timerSummary}</dd>
                </div>
                <div>
                  <dt>{specialSectionFact.label}</dt>
                  <dd>{specialSectionFact.value}</dd>
                </div>
              </dl>
              <button
                className="primary-button"
                type="button"
                onClick={() => onStartExam(mode.id)}
              >
                Start {mode.name}
              </button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function PracticeToolsSection({
  exam,
  onOpenCaseStudyPreview,
  onOpenPBQPreview,
  onOpenStudySandbox,
  onOpenTargetedPractice,
}) {
  const showPBQPreview = Boolean(
    onOpenPBQPreview && (exam.demoLabCount > 0 || exam.supportedFeatures?.pbqLabs),
  );
  const showCaseStudyPreview = Boolean(
    onOpenCaseStudyPreview &&
      (exam.caseStudyBlockCount > 0 || exam.supportedFeatures?.caseStudies),
  );

  return (
    <section className="exam-card" aria-label="Practice tools">
      <p className="eyebrow">Practice tools</p>
      <h3>Practice Tools</h3>
      <p>
        Use protected untimed practice to work through selected domains and
        supported simulations. Practice appears in Saved Results but does not
        change formal readiness or assessment totals.
      </p>

      <div className="practice-home-grid dashboard-practice-grid">
        <ModeCard
          eyebrow="Learning mode"
          title="Study Sandbox"
          body={`Practise ${exam.shortName} questions without the timer using the protected delivery service.`}
          note="Saved as practice activity; review availability follows the protected release policy."
          buttonLabel="Open Study Sandbox"
          onClick={onOpenStudySandbox}
        />
        <ModeCard
          eyebrow="Focused practice"
          title="Targeted Domain Practice"
          body={`Practise one ${exam.shortName} domain at a time using standalone questions.`}
          note={
            exam.supportedFeatures?.attemptHistory
              ? 'Useful after reviewing weak domains from completed protected assessments.'
              : 'Saved as practice activity and excluded from formal readiness.'
          }
          buttonLabel="Open Targeted Practice"
          onClick={onOpenTargetedPractice}
        />
        {showPBQPreview && (
          <ModeCard
            eyebrow="PBQ labs"
            title="PBQ Lab Preview"
            body={`Open supported ${exam.shortName} PBQ simulations for protected practice.`}
            note="Practice feedback and review follow the protected release policy."
            buttonLabel="Open PBQ Preview"
            onClick={() => onOpenPBQPreview(exam.id)}
          />
        )}
        {showCaseStudyPreview && (
          <ModeCard
            eyebrow="Case studies"
            title="Case Study Preview"
            body={`Open ${exam.shortName} scenario-based case studies with related scored questions.`}
            note="Practice feedback and review follow the protected release policy."
            buttonLabel="Open Case Study Preview"
            onClick={() => onOpenCaseStudyPreview(exam.id)}
          />
        )}
      </div>
    </section>
  );
}

function ModeCard({ eyebrow, title, body, note, buttonLabel, onClick }) {
  return (
    <article className="sandbox-home-panel" aria-labelledby={`${title}-heading`}>
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h3 id={`${title}-heading`}>{title}</h3>
        <p>{body}</p>
        <p className="sandbox-home-note">{note}</p>
      </div>
      <button className="primary-button" type="button" onClick={onClick}>
        {buttonLabel}
      </button>
    </article>
  );
}

function UnavailableExamCard({ exam }) {
  return (
    <section className="exam-card draft-selected-card" aria-label="Unavailable exam">
      <p className="eyebrow">{getExamStatusLabel(exam)}</p>
      <h3>{exam.name}</h3>
      <p>This exam is registered but not available in the current UI.</p>
    </section>
  );
}

function getExamStatusLabel(exam) {
  return exam?.statusLabel ?? formatExamStatus(exam?.status);
}

function getExamStatusDescription(exam) {
  return exam?.statusDescription ?? formatExamStatusDescription(exam?.status);
}

function getDashboardSummaryStats(exam) {
  const stats = [
    {
      label: 'Question bank',
      value: `${exam.questionCount} items`,
    },
  ];

  if (
    exam.caseStudyBlockCount > 0 &&
    exam.supportedFeatures?.caseStudies === 'preview'
  ) {
    stats.push({
      label: 'Case studies',
      value: exam.caseStudyScoredQuestionCount
        ? `${exam.caseStudyBlockCount} blocks / ${exam.caseStudyScoredQuestionCount} questions`
        : `${exam.caseStudyBlockCount} blocks`,
    });
  }

  if (exam.demoLabCount > 0) {
    stats.push({
      label: 'PBQ labs',
      value: exam.demoLabCount,
    });
  }

  stats.push(
    {
      label: 'Domains',
      value: exam.domains.length,
    },
    {
      label: 'Status',
      value: getExamStatusDescription(exam),
    },
  );

  return stats;
}

function getTimedAttemptsIntro(exam) {
  if (exam.timedAttemptsIntro) {
    return exam.timedAttemptsIntro;
  }

  if (exam.id === 'az204') {
    return 'Choose Full Mock Exam for fixed pressure practice, or Realistic Random Exam for varied AZ-204-style practice profiles with different question counts and case-study formats.';
  }

  if (exam.id === 'security-plus-sy0-701') {
    return 'Choose a compact or full Security+ practice attempt. PBQs appear first, followed by standard questions. Scores are strict practice estimates, not official CompTIA score predictions.';
  }

  if (exam.id === 'az400') {
    return 'Choose the sectioned full exam with case studies and labs, or use standard-question timed modes for focused AZ-400 practice. Scores are strict practice estimates, not official Microsoft score predictions.';
  }

  return `Choose a strict timed profile for ${exam.shortName}. These are practice attempts only and do not predict official ${exam.vendor} exam outcomes.`;
}

function getProfileDisplayName(profile, exam) {
  const profileName = profile.displayName ?? profile.name;

  if (exam.id === 'security-plus-sy0-701') {
    return profileName.replace('Security+ ', '');
  }

  if (exam.id === 'az400') {
    return profileName.replace('AZ-400 ', '');
  }

  return profileName;
}

function formatExamStatus(status) {
  return getLifecycleStatusLabel(normalizeStatusAsLifecycle(status));
}

function formatExamStatusDescription(status) {
  return getLifecycleStatusDescription(normalizeStatusAsLifecycle(status));
}

function normalizeStatusAsLifecycle(status) {
  if (status === 'active') {
    return EXAM_LIFECYCLES.productionReady;
  }

  if (status === 'internalBeta') {
    return EXAM_LIFECYCLES.controlledBeta;
  }

  return status;
}

function formatCaseStudySummary(profile) {
  const count = profile.caseStudyCount ?? 0;
  const scored = profile.caseStudyQuestionCount ?? 0;
  return `${count} case ${count === 1 ? 'study' : 'studies'} / ${scored} scored case questions`;
}

function formatPbqPlacement(profile) {
  const count = profile.pbqCount ?? 0;

  if (profile.pbqPlacement === 'end') {
    return `${count} at end`;
  }

  if (profile.pbqPlacement === 'front-loaded') {
    return `${count} front-loaded`;
  }

  return String(count);
}

function formatStandardQuestionSummary(profile) {
  return (
    profile.standardQuestionCount ??
    profile.mcqCount ??
    profile.normalScoredQuestionCount ??
    'Remaining scored items'
  );
}

function getModeSpecialSectionFact(exam, mode) {
  if (exam.id === 'az400') {
    return {
      label: 'Special sections',
      value: 'Case studies/PBQs not included',
    };
  }

  return {
    label: 'Case studies',
    value: mode.caseStudySummary,
  };
}
