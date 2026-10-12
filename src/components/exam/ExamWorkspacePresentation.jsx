import ExamTimer from './ExamTimer.jsx';
import PythonLabWorkspace from './PythonLabWorkspace.jsx';
import QuestionCard from './QuestionCard.jsx';
import QuestionNavigator from './QuestionNavigator.jsx';
import { isExecutablePythonLab } from '../../lib/pythonLabWorkspace.js';

export default function ExamWorkspacePresentation({
  actionControls,
  answers,
  caseStudyBlocks,
  currentIndex,
  currentSection,
  exam,
  exitDescription,
  exitDisabled = false,
  exitLabel,
  flaggedQuestionIds,
  fullscreenMessage,
  fullscreenSupported,
  isFullscreen,
  interactionDisabled = false,
  isQuestionMapOpen,
  isSectionedExam,
  navigatorQuestions,
  normalQuestions,
  onAnswerChange,
  onCloseQuestionMap,
  onExit,
  onNavigate,
  onOpenQuestionMap,
  onTimeExpired,
  onTimerTick,
  onToggleFullscreen,
  overlays,
  pbqQuestions,
  progressLabel,
  pythonLab,
  questionStateById,
  secondaryExitAction = null,
  scoredAnswerSummary,
  studentName,
  timerExpiresAt,
  timed = true,
  workspaceRef,
}) {
  const currentQuestion = navigatorQuestions[currentIndex];
  const rendersPythonLab = isExecutablePythonLab(currentQuestion);
  return <section className="exam-workspace protected-exam-workspace" aria-label={`${exam.code} exam workspace`} ref={workspaceRef}>
    <div className="exam-header"><div><p className="eyebrow">{exam.code}</p><h2>{exam.name}</h2>{studentName && <p>{studentName}</p>}{exam.profile && <p className="profile-header-note">{exam.mode?.name ?? 'Exam mode'}: {exam.profile.name} - {exam.profile.totalScoredQuestions ?? navigatorQuestions.length} scored questions{timed ? ` - ${exam.profile.timeLimitMinutes ?? exam.durationMinutes} min` : ' - Untimed'}</p>}</div><div className="exam-header-actions">{timed && <ExamTimer durationMinutes={exam.durationMinutes} expiresAt={timerExpiresAt} onTick={onTimerTick} onTimeExpired={onTimeExpired} />}<button className="secondary-button fullscreen-button" type="button" disabled={!fullscreenSupported} onClick={onToggleFullscreen} aria-pressed={isFullscreen}>{isFullscreen ? 'Exit fullscreen' : 'Fullscreen mode'}</button>{fullscreenMessage && <p className="fullscreen-message" role="status">{fullscreenMessage}</p>}</div></div>
    <div className="exam-grid"><div className="mobile-exam-tools" aria-label="Mobile exam tools"><button className="secondary-button question-map-toggle" disabled={interactionDisabled} type="button" onClick={onOpenQuestionMap}>Question Map</button><span>Item {currentIndex + 1} of {navigatorQuestions.length}</span></div>
      {isQuestionMapOpen && <button className="question-map-backdrop" type="button" aria-label="Close question map" onClick={onCloseQuestionMap} />}
      <div className={isQuestionMapOpen ? 'question-map-drawer open' : 'question-map-drawer'}><div className="question-map-drawer-header"><h3>Question Map</h3><button className="text-button" type="button" onClick={onCloseQuestionMap}>Close</button></div><fieldset className="protected-interaction-fieldset" disabled={interactionDisabled}><QuestionNavigator exam={exam} questions={navigatorQuestions} normalQuestions={normalQuestions} caseStudyBlocks={caseStudyBlocks} pbqQuestions={pbqQuestions} isSectionedExam={isSectionedExam} answers={answers} flaggedQuestionIds={flaggedQuestionIds} currentIndex={currentIndex} questionStateById={questionStateById} section={currentSection} onNavigate={onNavigate} /></fieldset></div>
      <div className="question-area"><div className="progress-strip"><span>{progressLabel}</span><span>{scoredAnswerSummary}</span></div>{rendersPythonLab
        ? <PythonLabWorkspace
            attemptId={pythonLab.attemptId}
            client={pythonLab.client}
            disabled={interactionDisabled}
            itemId={currentQuestion.id}
            onBusyChange={pythonLab.onBusyChange}
            onRegisterSave={pythonLab.onRegisterSave}
            onWorkspaceStateChange={pythonLab.onWorkspaceStateChange}
            presentation={currentQuestion}
          />
        : <fieldset className="protected-interaction-fieldset" disabled={interactionDisabled}><QuestionCard question={currentQuestion} answer={answers[currentQuestion.id]} hideTrainingLabels={exam.isDraftBeta || exam.deliveryMode === 'protected'} onAnswerChange={onAnswerChange} /></fieldset>}{actionControls}</div>
    </div>
    <section className={secondaryExitAction ? 'protected-lifecycle-exit has-destructive-action' : 'protected-lifecycle-exit'} aria-label="Attempt exit actions">
      <div>
        <button className={secondaryExitAction ? 'primary-button exit-button' : 'text-button exit-button'} disabled={exitDisabled} type="button" onClick={onExit}>{exitLabel}</button>
        {exitDescription ? <p>{exitDescription}</p> : null}
      </div>
      {secondaryExitAction ? <div className="protected-destructive-exit"><p><strong>Permanent reset</strong></p><button className="secondary-button danger-lite" disabled={secondaryExitAction.disabled} type="button" onClick={secondaryExitAction.onClick}>{secondaryExitAction.label}</button></div> : null}
    </section>
    {overlays}
  </section>;
}
