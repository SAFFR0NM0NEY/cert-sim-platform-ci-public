import { isScoredQuestion } from './scoring.js';
import { getPBQAnswerState, isPBQQuestion } from './pbqScoring.js';

export function getScoredQuestions(questions) {
  return questions.filter(isScoredQuestion);
}

export function getQuestionAnswerState(question, answers) {
  if (!isScoredQuestion(question)) {
    return 'info';
  }

  const answer = answers[question.id];

  if (isPBQQuestion(question)) {
    return getPBQAnswerState(question, answer);
  }

  if (question.type === 'single-choice') {
    return answer ? 'answered' : 'unanswered';
  }

  if (question.type === 'multi-select') {
    const selectedCount = Array.isArray(answer) ? answer.length : 0;
    const requiredCount = question.correctAnswers?.length ?? 0;

    if (selectedCount === 0) {
      return 'unanswered';
    }

    return selectedCount === requiredCount ? 'answered' : 'incomplete';
  }

  if (question.type === 'drag-drop-match') {
    const promptIds = question.prompts?.map((prompt) => prompt.id) ?? [];
    const optionIds = new Set(
      question.options?.map((option) => option.id) ?? [],
    );
    const selectedCount = isObjectAnswer(answer)
      ? promptIds.filter((promptId) => optionIds.has(answer[promptId])).length
      : 0;

    if (selectedCount === 0) {
      return 'unanswered';
    }

    return selectedCount === promptIds.length ? 'answered' : 'incomplete';
  }

  if (question.type === 'reorder') {
    const requiredItemIds = new Set(
      question.items?.map((item) => item.id) ?? [],
    );
    const hasCompleteOrder =
      Array.isArray(answer) &&
      answer.length === requiredItemIds.size &&
      new Set(answer).size === requiredItemIds.size &&
      answer.every((itemId) => requiredItemIds.has(itemId));

    if (!Array.isArray(answer) || answer.length === 0) {
      return 'unanswered';
    }

    return hasCompleteOrder ? 'answered' : 'incomplete';
  }

  if (question.type === 'dropdown-code' || question.type === 'dropdown-command') {
    const blankIds = question.blanks?.map((blank) => blank.id) ?? [];
    const selectedCount = isObjectAnswer(answer)
      ? blankIds.filter((blankId) => Boolean(answer[blankId])).length
      : 0;

    if (selectedCount === 0) {
      return 'unanswered';
    }

    return selectedCount === blankIds.length ? 'answered' : 'incomplete';
  }

  return 'unanswered';
}

export function isQuestionAnswered(question, answers) {
  return getQuestionAnswerState(question, answers) === 'answered';
}

export function getQuestionState(question, answers) {
  return getQuestionAnswerState(question, answers);
}

export function getUnansweredScoredQuestions(questions, answers) {
  return questions.filter(
    (question) =>
      isScoredQuestion(question) &&
      getQuestionAnswerState(question, answers) === 'unanswered',
  );
}

export function getIncompleteScoredQuestions(questions, answers) {
  return questions.filter(
    (question) =>
      isScoredQuestion(question) &&
      getQuestionAnswerState(question, answers) === 'incomplete',
  );
}

export function formatSeconds(totalSeconds) {
  const safeSeconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function isObjectAnswer(answer) {
  return answer && typeof answer === 'object' && !Array.isArray(answer);
}
