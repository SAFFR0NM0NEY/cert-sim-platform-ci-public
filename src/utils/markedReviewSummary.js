import { getQuestionResultStatus } from './feedbackHelpers.js';
import { isPBQQuestion } from './pbqScoring.js';
import { isScoredQuestion } from './scoring.js';

export function getMarkedForReviewItems(result) {
  const scoredQuestions = (result.exam?.questions ?? []).filter(isScoredQuestion);
  const scoredQuestionNumberById = getScoredQuestionNumberById(result.exam?.questions);
  const flaggedIds = new Set(result.flaggedQuestionIds ?? []);
  const caseStudySectionByQuestionId = new Map(
    (result.exam?.caseStudyBlocks ?? []).flatMap((block) =>
      (block.questions ?? []).map((question) => [question.id, block.title ?? block.id]),
    ),
  );

  return scoredQuestions
    .map((question) => ({
      question,
      questionNumber: scoredQuestionNumberById.get(question.id),
    }))
    .filter(({ question }) => flaggedIds.has(question.id))
    .map(({ question, questionNumber }) => ({
      questionId: question.id,
      questionNumber,
      domain: question.domain ?? null,
      section:
        question.sectionLabel ??
        question.section ??
        caseStudySectionByQuestionId.get(question.id) ??
        (result.exam?.hasSectionedFlow && isPBQQuestion(question)
          ? 'Lab/PBQ Section'
          : null),
      status: getQuestionResultStatus(question, result.answers?.[question.id]),
    }));
}

export function getScoredQuestionNumberById(questions) {
  return new Map(
    (questions ?? [])
      .filter(isScoredQuestion)
      .map((question, index) => [question.id, index + 1]),
  );
}

export function formatMarkedForReviewReference(item) {
  return `Question ${item.questionNumber} — ${item.questionId}`;
}
