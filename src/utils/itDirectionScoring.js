const confidenceBands = {
  high: {
    label: 'High confidence',
    description:
      'Your top pathway is clearly ahead of the other options in this assessment.',
  },
  medium: {
    label: 'Medium confidence',
    description:
      'Your top pathway is ahead, but your secondary pathway is also worth discussing.',
  },
  exploratory: {
    label: 'Exploratory fit',
    description:
      'Your answers show a broad mix of interests. Use this result as a conversation starter.',
  },
};

export function calculateItDirectionResult(assessment, answers) {
  const pathwayMap = new Map(
    assessment.pathways.map((pathway) => [pathway.id, pathway]),
  );
  const pathwayScores = assessment.pathways.map((pathway) => ({
    ...pathway,
    interest: 0,
    knowledge: 0,
    total: 0,
  }));
  const pathwayScoreMap = new Map(
    pathwayScores.map((pathwayScore) => [pathwayScore.id, pathwayScore]),
  );
  let answeredCount = 0;

  assessment.items.forEach((item) => {
    const selectedOptionId = answers[item.id];
    const selectedOption = item.options.find(
      (option) => option.id === selectedOptionId,
    );

    if (!selectedOption) {
      return;
    }

    answeredCount += 1;

    Object.entries(selectedOption.scores).forEach(([pathwayId, score]) => {
      const pathwayScore = pathwayScoreMap.get(pathwayId);

      if (!pathwayScore || typeof score !== 'number') {
        return;
      }

      if (item.dimension === 'knowledge') {
        pathwayScore.knowledge += score;
      } else {
        pathwayScore.interest += score;
      }

      pathwayScore.total += score;
    });
  });

  const rankedPathways = [...pathwayScores].sort((a, b) => {
    if (b.total !== a.total) {
      return b.total - a.total;
    }

    if (b.interest !== a.interest) {
      return b.interest - a.interest;
    }

    return a.name.localeCompare(b.name);
  });

  const primary = rankedPathways[0];
  const secondary = rankedPathways[1];
  const third = shouldIncludeThirdPathway(primary, rankedPathways[2])
    ? rankedPathways[2]
    : null;
  const confidence = getConfidence(primary, secondary, answeredCount, assessment.items.length);
  const topKnowledgeScore = primary?.knowledge ?? 0;

  return {
    assessmentId: assessment.id,
    assessmentTitle: assessment.title,
    completedAt: new Date().toISOString(),
    answeredCount,
    totalItems: assessment.items.length,
    primary,
    secondary,
    third,
    recommendations: [primary, secondary, third].filter(Boolean),
    confidence,
    pathwayScores: rankedPathways,
    readinessMessage: getReadinessMessage(topKnowledgeScore),
    explanation: getResultExplanation(primary, secondary),
    interestReadinessSummary: getInterestReadinessSummary(primary, secondary),
    discussionNotes: getDiscussionNotes(primary, secondary, third),
    guidanceNote: assessment.guidanceNote,
    receptionNote:
      assessment.receptionNote ??
      'Reception can use this result as a conversation starter before advising on study options.',
    resultDisclaimer:
      assessment.resultDisclaimer ??
      'This assessment is guidance only. It is not a final career decision, certification result, or guarantee.',
    pathwayMap,
  };
}

export function validateItDirectionAssessment(assessment) {
  const issues = [];
  const pathwayIds = new Set(assessment.pathways.map((pathway) => pathway.id));
  const itemIds = new Set();

  if (!assessment.id) {
    issues.push('Assessment is missing an id.');
  }

  if (!assessment.title) {
    issues.push('Assessment is missing a title.');
  }

  if (pathwayIds.size !== assessment.pathways.length) {
    issues.push('Pathway ids must be unique.');
  }

  assessment.items.forEach((item, itemIndex) => {
    if (!item.id) {
      issues.push(`Item at index ${itemIndex} is missing an id.`);
      return;
    }

    if (itemIds.has(item.id)) {
      issues.push(`Duplicate assessment item id: ${item.id}.`);
    }

    itemIds.add(item.id);

    if (!['interest', 'knowledge'].includes(item.dimension)) {
      issues.push(`${item.id} has an unknown dimension.`);
    }

    if (!item.prompt) {
      issues.push(`${item.id} is missing prompt text.`);
    }

    if (!Array.isArray(item.options) || item.options.length < 2) {
      issues.push(`${item.id} must have at least two options.`);
      return;
    }

    item.options.forEach((option) => {
      if (!option.id) {
        issues.push(`${item.id} has an option without an id.`);
      }

      if (!option.text) {
        issues.push(`${item.id}:${option.id ?? 'unknown'} is missing option text.`);
      }

      if (!option.scores || Object.keys(option.scores).length === 0) {
        issues.push(`${item.id}:${option.id ?? 'unknown'} has no pathway scores.`);
        return;
      }

      Object.entries(option.scores).forEach(([pathwayId, score]) => {
        if (!pathwayIds.has(pathwayId)) {
          issues.push(`${item.id}:${option.id} maps to unknown pathway ${pathwayId}.`);
        }

        if (typeof score !== 'number' || score <= 0) {
          issues.push(`${item.id}:${option.id} has an invalid score for ${pathwayId}.`);
        }
      });
    });
  });

  return issues;
}

function shouldIncludeThirdPathway(primary, thirdPathway) {
  if (!primary || !thirdPathway) {
    return false;
  }

  return primary.total - thirdPathway.total <= 6;
}

function getConfidence(primary, secondary, answeredCount, totalItems) {
  if (!primary || !secondary || answeredCount < totalItems) {
    return confidenceBands.exploratory;
  }

  const gap = primary.total - secondary.total;

  if (gap >= 12) {
    return confidenceBands.high;
  }

  if (gap >= 6) {
    return confidenceBands.medium;
  }

  return confidenceBands.exploratory;
}

function getReadinessMessage(topKnowledgeScore) {
  if (topKnowledgeScore >= 18) {
    return 'Your current knowledge looks solid for an entry-level conversation in this pathway. Keep building fundamentals before specialising.';
  }

  if (topKnowledgeScore >= 10) {
    return 'Your current knowledge is developing. Start with fundamentals, then use practical exercises to test what feels natural.';
  }

  return 'Your current knowledge is still early, which is normal. Start with broad IT fundamentals before choosing a specialist track.';
}

function getResultExplanation(primary, secondary) {
  if (!primary || !secondary) {
    return 'The assessment needs more answered items before a strong recommendation can be made.';
  }

  return `Your answers leaned most strongly toward ${primary.name}, with ${secondary.name} close enough to discuss as a secondary direction.`;
}

function getInterestReadinessSummary(primary, secondary) {
  if (!primary) {
    return 'The result needs more answers before interest and readiness can be summarized.';
  }

  const readinessLevel =
    primary.knowledge >= 18
      ? 'solid early readiness'
      : primary.knowledge >= 10
        ? 'developing readiness'
        : 'early readiness';

  const secondaryText = secondary
    ? ` ${secondary.name} should also be discussed because it was the next strongest pathway.`
    : '';

  return `${primary.name} is the strongest match because it combined ${primary.interest} interest points with ${primary.knowledge} knowledge/readiness points, showing ${readinessLevel}.${secondaryText}`;
}

function getDiscussionNotes(primary, secondary, third) {
  if (!primary) {
    return [
      'Retake the assessment with all items answered before making a study-path recommendation.',
    ];
  }

  return [
    `Ask what felt most appealing about ${primary.name} and whether the daily work sounds motivating.`,
    ...(primary.discussionPrompts ?? []).slice(0, 2),
    secondary
      ? `Compare ${primary.name} with ${secondary.name} before deciding on the first course or workshop.`
      : 'Discuss one practical starter course and one hands-on activity for the recommended path.',
    third
      ? `${third.name} also appeared close enough to keep open as a future option.`
      : 'Keep other pathways open, but choose one clear starting direction for the next step.',
    'Agree on one practical next action: course enquiry, fundamentals revision, or a short introductory activity.',
  ];
}
