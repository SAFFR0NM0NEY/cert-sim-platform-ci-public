import {
  EXAM_LIFECYCLES,
  getExamLifecycle,
  getLifecycleStatusLabel,
  getLifecycleStatusDescription,
  isProductionReadyLifecycle,
} from '../exams/examLifecycle.js';

const allowedLifecycles = new Set(Object.values(EXAM_LIFECYCLES));
const blockedProductionMetadataPatterns = [
  /\bMVP Beta\b/i,
  /\bProduction Candidate\b/i,
  /\binternalBeta\b/i,
  /\bdraft-beta\b/i,
];

export function validateExamRegistry(examRegistry) {
  const issues = [];
  const seenSlugs = new Map();

  (examRegistry ?? []).forEach((examConfig) => {
    const examId = examConfig?.id ?? 'unknown-exam';
    const lifecycle = getExamLifecycle(examConfig);

    if (!examConfig?.id) {
      issues.push(createIssue(examId, 'error', 'Registered exam is missing id.'));
    }

    if (!examConfig?.slug) {
      issues.push(createIssue(examId, 'error', 'Registered exam is missing slug.'));
    } else if (seenSlugs.has(examConfig.slug)) {
      issues.push(
        createIssue(
          examId,
          'error',
          `Registered exam slug duplicates ${seenSlugs.get(examConfig.slug)}.`,
        ),
      );
    } else {
      seenSlugs.set(examConfig.slug, examId);
    }

    if (!allowedLifecycles.has(lifecycle)) {
      issues.push(
        createIssue(examId, 'error', `Unsupported exam lifecycle "${lifecycle}".`),
      );
    }

    if (!(examConfig.statusLabel ?? examConfig.ui?.statusLabel ?? getLifecycleStatusLabel(lifecycle))) {
      issues.push(createIssue(examId, 'error', 'Registered exam is missing status label.'));
    }

    if (lifecycle === EXAM_LIFECYCLES.nearRetirement) {
      if (!examConfig.retiredDate) {
        issues.push(
          createIssue(
            examId,
            'error',
            'Near-retirement exam is missing retiredDate.',
          ),
        );
      }

      if (!examConfig.lifecycleNotice && !examConfig.statusNote) {
        issues.push(
          createIssue(
            examId,
            'error',
            'Near-retirement exam is missing retirement wording.',
          ),
        );
      }
    }

    if (isProductionReadyLifecycle(lifecycle)) {
      const publicText = getPublicMetadataText(examConfig);
      const blockedPattern = blockedProductionMetadataPatterns.find((pattern) =>
        pattern.test(publicText),
      );

      if (blockedPattern) {
        issues.push(
          createIssue(
            examId,
            'error',
            `Production-ready public metadata contains blocked wording: ${blockedPattern}.`,
          ),
        );
      }
    }
  });

  return issues;
}

function getPublicMetadataText(examConfig) {
  return [
    examConfig.title,
    examConfig.examTitle,
    examConfig.versionLabel,
    examConfig.statusLabel,
    examConfig.statusNote,
    examConfig.shortDescription,
    examConfig.longDescription,
    examConfig.trainerValidationNote,
    examConfig.lifecycleNotice,
    examConfig.ui?.availableExamName,
    examConfig.ui?.statusLabel,
    examConfig.ui?.statusDescription,
    examConfig.ui?.homeDescription,
    examConfig.ui?.timedAttemptsIntro,
    examConfig.statusNote ?? getLifecycleStatusDescription(getExamLifecycle(examConfig)),
  ]
    .filter(Boolean)
    .join('\n');
}

function createIssue(examId, level, message) {
  return {
    examId,
    level,
    message,
  };
}
