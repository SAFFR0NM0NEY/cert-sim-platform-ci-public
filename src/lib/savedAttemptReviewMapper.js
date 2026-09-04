import {
  getFormattedAnswerText,
  getQuestionResultStatus,
} from '../utils/feedbackHelpers.js';
import { getAnswerComparison } from '../utils/answerComparison.js';
import { getCorrectAnswers, isScoredQuestion } from '../utils/scoring.js';
import { isPBQQuestion } from '../utils/pbqScoring.js';

export function createSavedAttemptReview(result = {}) {
  const resultSnapshotReview = createReviewFromResultSnapshot(result);

  if (resultSnapshotReview.items.length > 0) {
    return resultSnapshotReview;
  }

  const responseSnapshotReview = createReviewFromResponseSnapshots(result);

  if (responseSnapshotReview.items.length > 0) {
    return responseSnapshotReview;
  }

  return {
    available: false,
    source: '',
    message: 'Full answer review is not available for this saved result yet.',
    items: [],
  };
}

function createReviewFromResultSnapshot(result) {
  const snapshot = getSnapshotResult(result);
  const questions = asArray(snapshot.exam?.questions).filter(isScoredQuestion);
  const answers = toObject(snapshot.answers);

  if (questions.length === 0 || Object.keys(answers).length === 0) {
    return {
      available: false,
      source: '',
      message: '',
      items: [],
    };
  }

  return {
    available: true,
    source: 'result_snapshot',
    message: 'Saved answer review reconstructed from the result snapshot.',
    items: questions.map((question, index) =>
      createReviewItem(question, answers[question.id], index, {
        flagged: answers[question.id]?.flagged === true ||
          asArray(snapshot.flaggedQuestionIds).includes(question.id),
      }),
    ),
  };
}

function createReviewFromResponseSnapshots(result) {
  const responses = asArray(result.responses);
  const orderById = new Map(
    asArray(result.selectedQuestionIds).map((questionId, index) => [questionId, index]),
  );
  const reviewableResponses = responses.filter((response) => {
    const question = toObject(response.presentedSnapshot);

    return question.id && isScoredQuestion(question);
  }).sort((left, right) =>
    (orderById.get(left.questionId) ?? Number.MAX_SAFE_INTEGER) -
    (orderById.get(right.questionId) ?? Number.MAX_SAFE_INTEGER),
  );

  if (reviewableResponses.length === 0) {
    return {
      available: false,
      source: '',
      message: '',
      items: [],
    };
  }

  return {
    available: true,
    source: 'response_snapshots',
    message: 'Saved answer review reconstructed from response snapshots.',
    items: reviewableResponses.map((response, index) =>
      createReviewItem(
        response.presentedSnapshot,
        response.responseSnapshot?.answer,
        index,
        response,
      ),
    ),
  };
}

function createReviewItem(question, answer, index, response = {}) {
  const safeQuestion = toObject(question);
  const safeAnswer = answer ?? null;
  const correctAnswer = getSafeCorrectAnswerText(safeQuestion);

  return {
    id: safeQuestion.id ?? response.questionId ?? `saved-item-${index + 1}`,
    number: index + 1,
    type: safeQuestion.type ?? response.questionType ?? 'Not recorded',
    isPBQ: isPBQQuestion(safeQuestion) || isPBQQuestion({ type: response.questionType }),
    isFlagged: response.flagged === true || response.responseSnapshot?.flagged === true,
    domain: safeQuestion.domain ?? 'Not recorded',
    difficulty: safeQuestion.difficulty ?? 'Not recorded',
    prompt:
      safeQuestion.question ??
      safeQuestion.title ??
      safeQuestion.tasks?.prompt ??
      'Question text was not stored for this saved result.',
    status: getSafeResultStatus(safeQuestion, safeAnswer, response),
    studentAnswer: getSafeAnswerText(safeQuestion, safeAnswer),
    correctAnswer,
    answerComparison: getSafeAnswerComparison(safeQuestion, safeAnswer),
    explanation: safeQuestion.explanation ?? '',
    remediation: safeQuestion.remediation ?? '',
  };
}

function getSafeResultStatus(question, answer, response) {
  if (response?.responseSnapshot?.completionState === 'unanswered') {
    return 'Unanswered';
  }

  if (response?.responseSnapshot?.completionState === 'incomplete') {
    return 'Incomplete';
  }

  try {
    return getQuestionResultStatus(question, answer);
  } catch {
    return 'Status not available';
  }
}

function getSafeAnswerText(question, answer) {
  try {
    return getFormattedAnswerText(question, answer);
  } catch {
    return answer === null || answer === undefined
      ? 'Unanswered'
      : JSON.stringify(answer);
  }
}

function getSafeCorrectAnswerText(question) {
  try {
    return getFormattedAnswerText(question, getCorrectAnswers(question));
  } catch {
    return 'Correct answer was not stored in a review-safe format.';
  }
}

function getSafeAnswerComparison(question, answer) {
  try {
    return getAnswerComparison(question, answer);
  } catch {
    return null;
  }
}

function getSnapshotResult(result) {
  if (result.resultSnapshot?.exam || result.resultSnapshot?.answers) {
    return result.resultSnapshot;
  }

  if (result.reportSnapshot?.result?.exam || result.reportSnapshot?.result?.answers) {
    return result.reportSnapshot.result;
  }

  return {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function toObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}
