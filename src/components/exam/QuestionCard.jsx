import { useEffect, useState } from 'react';
import DragDropMatchQuestion from './DragDropMatchQuestion.jsx';
import DropdownCodeQuestion from './DropdownCodeQuestion.jsx';
import DropdownCommandQuestion from './DropdownCommandQuestion.jsx';
import ReorderQuestion from './ReorderQuestion.jsx';
import PBQExamQuestion from '../pbq/PBQExamQuestion.jsx';
import { getQuestionCodingLanguageMeta } from '../../utils/codingLanguage.js';
import { isPBQQuestion } from '../../lib/questionType.js';

export default function QuestionCard({
  question,
  answer,
  hideTrainingLabels = false,
  onAnswerChange,
}) {
  if (isPBQQuestion(question)) {
    return (
      <PBQExamQuestion
        answer={answer}
        hideTrainingLabels={hideTrainingLabels}
        lab={question}
        onAnswerChange={onAnswerChange}
      />
    );
  }

  if (question.type === 'case-study-info') {
    const facts = question.facts ?? [];

    return (
      <article
        className="question-card info-card case-study-scenario-card"
        aria-labelledby={`${question.id}-title`}
      >
        <p className="question-type">Case Study Scenario</p>
        <h3 id={`${question.id}-title`}>{question.title}</h3>
        <p className="scenario-reference-note">
          Use this reference page while answering the case study questions.
        </p>
        <p>{question.content}</p>
        <ScenarioSections sections={question.sections} />
        <ScenarioExhibits exhibits={question.exhibits} />
        {facts.length > 0 && (
          <section className="scenario-details" aria-label="Case study requirements and constraints">
            <h4>Requirements, environment, and constraints</h4>
            <ul>
              {facts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          </section>
        )}
      </article>
    );
  }

  if (question.type === 'drag-drop-match') {
    return (
      <QuestionShell
        hideTrainingLabels={hideTrainingLabels}
        question={question}
        typeLabel="Drag-drop match"
      >
        <DragDropMatchQuestion
          answer={answer}
          onAnswerChange={onAnswerChange}
          question={question}
        />
      </QuestionShell>
    );
  }

  if (question.type === 'reorder') {
    return (
      <QuestionShell
        hideTrainingLabels={hideTrainingLabels}
        question={question}
        typeLabel="Reorder"
      >
        <ReorderQuestion
          answer={answer}
          onAnswerChange={onAnswerChange}
          question={question}
        />
      </QuestionShell>
    );
  }

  if (question.type === 'dropdown-code') {
    return (
      <QuestionShell
        hideTrainingLabels={hideTrainingLabels}
        question={question}
        typeLabel="Dropdown code"
      >
        <DropdownCodeQuestion
          answer={answer}
          onAnswerChange={onAnswerChange}
          question={question}
        />
      </QuestionShell>
    );
  }

  if (question.type === 'dropdown-command') {
    return (
      <QuestionShell
        hideTrainingLabels={hideTrainingLabels}
        question={question}
        typeLabel="Dropdown command"
      >
        <DropdownCommandQuestion
          answer={answer}
          onAnswerChange={onAnswerChange}
          question={question}
        />
      </QuestionShell>
    );
  }

  return (
    <QuestionShell
      hideTrainingLabels={hideTrainingLabels}
      question={question}
      typeLabel={question.type === 'multi-select' ? 'Multi-select' : 'Single-choice'}
    >
      <OptionQuestion
        answer={answer}
        onAnswerChange={onAnswerChange}
        question={question}
      />
    </QuestionShell>
  );
}

function OptionQuestion({ question, answer, onAnswerChange }) {
  const [showLimitWarning, setShowLimitWarning] = useState(false);
  const isMultiSelect = question.type === 'multi-select';
  const selectedAnswers = Array.isArray(answer) ? answer : answer ? [answer] : [];
  const requiredCount = question.selectionLimit ?? question.correctAnswers?.length ?? null;

  useEffect(() => {
    setShowLimitWarning(false);
  }, [question.id]);

  function handleOptionChange(optionId) {
    if (!isMultiSelect) {
      onAnswerChange(question.id, optionId);
      return;
    }

    if (selectedAnswers.includes(optionId)) {
      setShowLimitWarning(false);
      onAnswerChange(
        question.id,
        selectedAnswers.filter((selectedId) => selectedId !== optionId),
      );
      return;
    }

    if (requiredCount !== null && selectedAnswers.length >= requiredCount) {
      setShowLimitWarning(true);
      return;
    }

    setShowLimitWarning(false);
    onAnswerChange(question.id, [...selectedAnswers, optionId]);
  }

  return (
    <>
      {isMultiSelect && (
        <div className="answer-helper" aria-live="polite">
          <p>{requiredCount === null ? 'Select all that apply.' : `Select ${requiredCount} answers.`}</p>
          {requiredCount !== null && selectedAnswers.length < requiredCount && (
            <p className="incomplete-warning">
              You have selected {selectedAnswers.length} of {requiredCount} required
              answers.
            </p>
          )}
          {showLimitWarning && (
            <p className="limit-warning">
              You can only select {requiredCount} answers.
            </p>
          )}
        </div>
      )}

      <div className="option-list">
        {question.options.map((option) => (
          <label className="option-row" key={option.id}>
            <input
              type={isMultiSelect ? 'checkbox' : 'radio'}
              name={question.id}
              value={option.id}
              checked={selectedAnswers.includes(option.id)}
              onChange={() => handleOptionChange(option.id)}
            />
            <span>{option.text}</span>
          </label>
        ))}
      </div>
    </>
  );
}

function QuestionShell({ question, typeLabel, hideTrainingLabels, children }) {
  const codingLanguageMeta = getQuestionCodingLanguageMeta(question);

  return (
    <article className="question-card">
      {!hideTrainingLabels && (
        <>
          <div className="question-meta">
            <span>{typeLabel}</span>
            <span>{question.difficulty}</span>
            {codingLanguageMeta && (
              <span className="coding-language-badge">
                {codingLanguageMeta.badgeText}
              </span>
            )}
          </div>
          <p className="domain-label">{question.domain}</p>
        </>
      )}
      <h3>{question.question}</h3>
      {children}
    </article>
  );
}

function ScenarioSections({ sections = [] }) {
  if (!sections.length) {
    return null;
  }

  return (
    <section className="scenario-section-grid" aria-label="Case study sections">
      {sections.map((section) => (
        <article className="scenario-section-card" key={section.title}>
          <h4>{section.title}</h4>
          {section.body && <p>{section.body}</p>}
          {section.items?.length > 0 && (
            <ul>
              {section.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </section>
  );
}

function ScenarioExhibits({ exhibits = [] }) {
  if (!exhibits.length) {
    return null;
  }

  return (
    <section className="scenario-exhibit-grid" aria-label="Case study exhibits">
      {exhibits.map((exhibit) => (
        <article className="scenario-exhibit-card" key={exhibit.title}>
          <h4>{exhibit.title}</h4>
          {exhibit.description && <p>{exhibit.description}</p>}
          {exhibit.type === 'flow' && <ScenarioFlow nodes={exhibit.nodes} />}
          {exhibit.type === 'table' && (
            <ScenarioTable headers={exhibit.headers} rows={exhibit.rows} />
          )}
          {exhibit.type === 'list' && exhibit.items?.length > 0 && (
            <ul>
              {exhibit.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </section>
  );
}

function ScenarioFlow({ nodes = [] }) {
  if (!nodes.length) {
    return null;
  }

  return (
    <div className="scenario-flow">
      {nodes.map((node, index) => (
        <span className="scenario-flow-step" key={node}>
          {node}
          {index < nodes.length - 1 && (
            <span className="scenario-flow-arrow" aria-hidden="true">
              -&gt;
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

function ScenarioTable({ headers = [], rows = [] }) {
  if (!headers.length || !rows.length) {
    return null;
  }

  return (
    <div
      className="scenario-table"
      role="table"
      style={{ '--scenario-table-columns': headers.length }}
    >
      <div role="row">
        {headers.map((header) => (
          <strong key={header} role="columnheader">
            {header}
          </strong>
        ))}
      </div>
      {rows.map((row) => (
        <div key={row.join('|')} role="row">
          {row.map((cell) => (
            <span key={cell} role="cell">
              {cell}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}
