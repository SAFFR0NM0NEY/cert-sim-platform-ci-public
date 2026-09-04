export default function QuestionNavigator({
  exam,
  questions,
  normalQuestions,
  caseStudyBlocks,
  pbqQuestions = [],
  isSectionedExam = false,
  answers,
  flaggedQuestionIds,
  currentIndex,
  section,
  onNavigate,
}) {
  if (isSectionedExam) {
    return (
      <aside className="question-navigator" aria-label="Question navigation">
        <h3>Question navigation</h3>
        <CaseStudyNavigationSection
          answers={answers}
          caseStudyBlocks={caseStudyBlocks}
          currentIndex={currentIndex}
          flaggedQuestionIds={flaggedQuestionIds}
          onNavigate={onNavigate}
          questions={questions}
        />

        <NavigationSection title="Standard Questions">
          <div className="nav-grid">
            {normalQuestions.map((question) => {
              const index = questions.findIndex((item) => item.id === question.id);

              return (
                <NavigationButton
                  answers={answers}
                  currentIndex={currentIndex}
                  flaggedQuestionIds={flaggedQuestionIds}
                  index={index}
                  key={question.id}
                  onClick={() => onNavigate(index)}
                  question={question}
                />
              );
            })}
          </div>
        </NavigationSection>

        {pbqQuestions.length > 0 && (
          <NavigationSection title="Lab/PBQ Section">
            <div className="nav-grid">
              {pbqQuestions.map((question, questionIndex) => {
                const index = questions.findIndex((item) => item.id === question.id);

                return (
                  <NavigationButton
                    answers={answers}
                    ariaLabel={`Go to lab ${questionIndex + 1}`}
                    currentIndex={currentIndex}
                    flaggedQuestionIds={flaggedQuestionIds}
                    index={index}
                    key={question.id}
                    label={`Lab ${questionIndex + 1}`}
                    onClick={() => onNavigate(index)}
                    question={question}
                  />
                );
              })}
            </div>
          </NavigationSection>
        )}

        <NavigatorLegend />
      </aside>
    );
  }

  return (
    <aside className="question-navigator" aria-label="Question navigation">
      <h3>Question navigation</h3>
      <NavigationSection title={exam?.hasFrontLoadedPbqs ? 'Exam Items' : 'Normal Questions'}>
        <div className="nav-grid">
          {normalQuestions.map((question) => {
            const index = questions.findIndex((item) => item.id === question.id);

            return (
              <NavigationButton
                answers={answers}
                currentIndex={currentIndex}
                disabled={section === 'case-study'}
                flaggedQuestionIds={flaggedQuestionIds}
                index={index}
                key={question.id}
                onClick={() => onNavigate(index)}
                question={question}
              />
            );
          })}
        </div>
      </NavigationSection>

      {caseStudyBlocks.length > 0 && (
        <NavigationSection
          className={section === 'normal' ? 'locked-section' : ''}
          title="Case Study Section"
        >
          <CaseStudyNavigationBlocks
            answers={answers}
            caseStudyBlocks={caseStudyBlocks}
            currentIndex={currentIndex}
            disabled={section === 'normal'}
            flaggedQuestionIds={flaggedQuestionIds}
            locked={section === 'normal'}
            onNavigate={onNavigate}
            questions={questions}
          />
          {section === 'normal' && (
            <p className="section-lock-note">Locked until you enter the case study section.</p>
          )}
        </NavigationSection>
      )}

      <NavigatorLegend />
    </aside>
  );
}

function getQuestionState(question, answers) {
  if (question.type === 'case-study-info' || question.type === 'informational') return 'info';
  const answer = answers[question.id];
  if (answer == null || answer === '') return 'unanswered';
  if (Array.isArray(answer)) {
    if (answer.length === 0) return 'unanswered';
    const expected = Number(question.maxSelections ?? question.requiredSelections);
    return Number.isFinite(expected) && answer.length < expected ? 'incomplete' : 'answered';
  }
  if (typeof answer === 'object') {
    const values = Object.values(answer).filter((value) => value != null && value !== '' && (!Array.isArray(value) || value.length > 0));
    if (values.length === 0) return 'unanswered';
    const expected = question.prompts?.length ?? question.blanks?.length ?? question.items?.length;
    return Number.isFinite(expected) && values.length < expected ? 'incomplete' : 'answered';
  }
  return 'answered';
}

function CaseStudyNavigationSection({
  answers,
  caseStudyBlocks,
  currentIndex,
  flaggedQuestionIds,
  onNavigate,
  questions,
}) {
  if (caseStudyBlocks.length === 0) {
    return null;
  }

  return (
    <NavigationSection title="Case Study Section">
      <CaseStudyNavigationBlocks
        answers={answers}
        caseStudyBlocks={caseStudyBlocks}
        currentIndex={currentIndex}
        flaggedQuestionIds={flaggedQuestionIds}
        onNavigate={onNavigate}
        questions={questions}
      />
    </NavigationSection>
  );
}

function CaseStudyNavigationBlocks({
  answers,
  caseStudyBlocks,
  currentIndex,
  disabled = false,
  flaggedQuestionIds,
  locked = false,
  onNavigate,
  questions,
}) {
  return caseStudyBlocks.map((block) => (
    <div className="case-study-nav-block" key={block.id}>
      <h4>{block.title}</h4>
      <p className="case-study-reference-note">
        Use the scenario page as a reference while answering these questions.
      </p>
      <div className="case-study-reference-nav">
        <NavigationButton
          answers={answers}
          ariaLabel={`View ${block.title}`}
          currentIndex={currentIndex}
          disabled={disabled}
          flaggedQuestionIds={flaggedQuestionIds}
          index={questions.findIndex((item) => item.id === block.scenario.id)}
          key={block.scenario.id}
          label="View Case Study"
          locked={locked}
          onClick={() =>
            onNavigate(questions.findIndex((item) => item.id === block.scenario.id))
          }
          question={block.scenario}
        />
        {block.questions.map((question, questionIndex) => {
          const index = questions.findIndex((item) => item.id === question.id);

          return (
            <NavigationButton
              answers={answers}
              ariaLabel={`Go to case study question ${questionIndex + 1}`}
              currentIndex={currentIndex}
              disabled={disabled}
              flaggedQuestionIds={flaggedQuestionIds}
              index={index}
              key={question.id}
              label={`Question ${questionIndex + 1}`}
              locked={locked}
              onClick={() => onNavigate(index)}
              question={question}
            />
          );
        })}
      </div>
    </div>
  ));
}

function NavigatorLegend() {
  return (
    <div className="legend">
      <span><i className="dot answered" />Answered</span>
      <span><i className="dot unanswered" />Unanswered</span>
      <span><i className="dot incomplete" />Incomplete</span>
      <span><i className="dot flagged" />Flagged</span>
      <span><i className="dot info" />Info</span>
    </div>
  );
}

function NavigationSection({ title, className = '', children }) {
  return (
    <section className={`navigator-section ${className}`.trim()}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function NavigationButton({
  question,
  answers,
  flaggedQuestionIds,
  currentIndex,
  index,
  onClick,
  disabled = false,
  locked = false,
  label,
  ariaLabel,
}) {
  const state = getQuestionState(question, answers);
  const isInfoItem = question.type === 'case-study-info' || question.type === 'informational';
  const isFlagged = !isInfoItem && flaggedQuestionIds.includes(question.id);
  const visibleQuestionNumber = question.questionNumber ?? index + 1;

  return (
    <button
      className={`nav-item ${label ? 'labeled' : ''} ${state} ${isFlagged ? 'flagged' : ''} ${locked ? 'locked' : ''} ${currentIndex === index ? 'current' : ''}`}
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={
        ariaLabel ??
        (isInfoItem
          ? `Go to scenario information item ${index + 1}`
          : `Go to question ${visibleQuestionNumber}`)
      }
      title={isInfoItem ? 'Scenario information' : undefined}
    >
      {label ?? (isInfoItem ? 'i' : visibleQuestionNumber)}
    </button>
  );
}
