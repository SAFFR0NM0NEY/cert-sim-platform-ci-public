const isScoredQuestion = (question) => question?.type !== 'case-study-info';

const KNOWN_TYPES = new Set([
  'single-choice',
  'multi-select',
  'case-study-info',
  'drag-drop-match',
  'reorder',
  'dropdown-code',
  'dropdown-command',
]);

export function validateQuestionBank(questionBank, examConfig) {
  const issues = [];
  const seenIds = new Set();
  const caseStudyScenarioIds = new Set(
    questionBank
      .filter((question) => question.type === 'case-study-info' && question.caseStudyId)
      .map((question) => question.caseStudyId),
  );

  questionBank.forEach((question, index) => {
    const reference = question.id || `item at index ${index}`;

    if (!question.id) {
      addIssue(issues, 'error', reference, 'Missing question id.');
    } else if (seenIds.has(question.id)) {
      addIssue(issues, 'error', question.id, 'Duplicate question id.');
    } else {
      seenIds.add(question.id);
    }

    if (!question.type) {
      addIssue(issues, 'error', reference, 'Missing question type.');
      return;
    }

    if (!KNOWN_TYPES.has(question.type)) {
      addIssue(issues, 'error', reference, `Unknown question type: ${question.type}.`);
      return;
    }

    if (
      examConfig?.allowedQuestionTypes &&
      !examConfig.allowedQuestionTypes.includes(question.type)
    ) {
      addIssue(
        issues,
        'warning',
        reference,
        `Question type ${question.type} is not enabled in the exam config.`,
      );
    }

    if (isScoredQuestion(question)) {
      validateScoredFields(question, reference, issues, examConfig);

      if (question.caseStudyId && !caseStudyScenarioIds.has(question.caseStudyId)) {
        addIssue(
          issues,
          'error',
          reference,
          `Case study question references missing scenario: ${question.caseStudyId}.`,
        );
      }
    }

    if (question.type === 'case-study-info' && examConfig?.allowUnscoredItems === false) {
      addIssue(
        issues,
        'error',
        reference,
        'Unscored items are not allowed in this question bank.',
      );
    }

    validateTypeFields(question, reference, issues, examConfig);
  });

  questionBank
    .filter((question) => question.type === 'case-study-info')
    .forEach((scenario) => {
      if (!scenario.caseStudyId) {
        addIssue(
          issues,
          'warning',
          scenario.id || 'case-study-info item',
          'Case study scenario is missing caseStudyId.',
        );
        return;
      }

      const relatedQuestions = questionBank.filter(
        (question) =>
          isScoredQuestion(question) &&
          question.caseStudyId === scenario.caseStudyId,
      );

      if (relatedQuestions.length === 0) {
        addIssue(
          issues,
          'warning',
          scenario.id || scenario.caseStudyId,
          'Case study scenario has no related scored questions.',
        );
      }
    });

  return issues;
}

function validateScoredFields(question, reference, issues, examConfig) {
  if (!question.domain) {
    addIssue(issues, 'error', reference, 'Missing domain on scored question.');
  } else {
    const allowedDomains = getAllowedDomains(examConfig);

    if (allowedDomains.size > 0 && !allowedDomains.has(question.domain)) {
      addIssue(
        issues,
        'error',
        reference,
        `Unknown domain on scored question: ${question.domain}.`,
      );
    }
  }

  if (!question.difficulty) {
    addIssue(issues, 'error', reference, 'Missing difficulty on scored question.');
  }

  if (!question.explanation) {
    addIssue(issues, 'error', reference, 'Missing explanation on scored question.');
  }

  if (!question.remediation) {
    addIssue(issues, 'error', reference, 'Missing remediation on scored question.');
  }
}

function validateTypeFields(question, reference, issues, examConfig) {
  if (question.type === 'single-choice') {
    validateOptions(question, reference, issues);

    if (!question.correctAnswer) {
      addIssue(issues, 'error', reference, 'Single-choice question is missing correctAnswer.');
    }
  }

  if (question.type === 'multi-select') {
    validateOptions(question, reference, issues);

    if (!Array.isArray(question.correctAnswers) || question.correctAnswers.length === 0) {
      addIssue(issues, 'error', reference, 'Multi-select question is missing correctAnswers.');
    } else if (examConfig?.requireMultiSelectCountHint) {
      validateMultiSelectCountHint(question, reference, issues);
    }
  }

  if (question.type === 'drag-drop-match') {
    if (!Array.isArray(question.prompts) || question.prompts.length === 0) {
      addIssue(issues, 'error', reference, 'Drag-drop match question is missing prompts.');
    }

    validateOptions(question, reference, issues);

    if (!question.correctPairs || Object.keys(question.correctPairs).length === 0) {
      addIssue(issues, 'error', reference, 'Drag-drop match question is missing correctPairs.');
    }
  }

  if (question.type === 'reorder') {
    if (!Array.isArray(question.items) || question.items.length === 0) {
      addIssue(issues, 'error', reference, 'Reorder question is missing items.');
    }

    if (!Array.isArray(question.correctOrder) || question.correctOrder.length === 0) {
      addIssue(issues, 'error', reference, 'Reorder question is missing correctOrder.');
    }
  }

  if (question.type === 'dropdown-code') {
    if (!question.codeTemplate) {
      addIssue(issues, 'error', reference, 'Dropdown code question is missing codeTemplate.');
    }

    validateBlanks(question, reference, issues);
  }

  if (question.type === 'dropdown-command') {
    if (!question.commandTemplate && !question.codeTemplate) {
      addIssue(
        issues,
        'error',
        reference,
        'Dropdown command question is missing commandTemplate or codeTemplate.',
      );
    }

    validateBlanks(question, reference, issues);
  }
}

function validateOptions(question, reference, issues) {
  if (!Array.isArray(question.options) || question.options.length === 0) {
    addIssue(issues, 'error', reference, `${question.type} question is missing options.`);
  }
}

function validateBlanks(question, reference, issues) {
  if (!Array.isArray(question.blanks) || question.blanks.length === 0) {
    addIssue(issues, 'error', reference, `${question.type} question is missing blanks.`);
    return;
  }

  validateDropdownTemplatePlaceholders(question, reference, issues);

  question.blanks.forEach((blank) => {
    if (!Array.isArray(blank.options) || blank.options.length === 0) {
      addIssue(
        issues,
        'error',
        reference,
        `Blank ${blank.id || '(missing id)'} is missing options.`,
      );
    }

    if (!blank.correctAnswer) {
      addIssue(
        issues,
        'error',
        reference,
        `Blank ${blank.id || '(missing id)'} is missing correctAnswer.`,
      );
    }

    if (
      blank.correctAnswer &&
      Array.isArray(blank.options) &&
      !blank.options.includes(blank.correctAnswer)
    ) {
      addIssue(
        issues,
        'error',
        reference,
        `Blank ${blank.id || '(missing id)'} correctAnswer is not present in its options.`,
      );
    }
  });
}

function validateDropdownTemplatePlaceholders(question, reference, issues) {
  const template = question.codeTemplate ?? question.commandTemplate ?? '';
  const blankIds = new Set(question.blanks.map((blank) => blank.id).filter(Boolean));
  const placeholders = [...template.matchAll(/{{([^}]+)}}/g)].map((match) =>
    match[1].trim(),
  );
  const placeholderIds = new Set(placeholders);

  placeholders.forEach((placeholder) => {
    if (placeholder.includes('{{') || placeholder.includes('}}')) {
      addIssue(
        issues,
        'error',
        reference,
        `Dropdown template has a nested placeholder conflict near {{${placeholder}}}.`,
      );
      return;
    }

    if (!blankIds.has(placeholder)) {
      addIssue(
        issues,
        'error',
        reference,
        `Dropdown template placeholder {{${placeholder}}} does not match a declared blank id.`,
      );
    }
  });

  question.blanks.forEach((blank) => {
    if (blank.id && !placeholderIds.has(blank.id)) {
      addIssue(
        issues,
        'error',
        reference,
        `Blank ${blank.id} is not used in the dropdown template.`,
      );
    }
  });
}

function validateMultiSelectCountHint(question, reference, issues) {
  const expectedCount = question.correctAnswers.length;
  const lowerQuestion = question.question.toLowerCase();
  const countWord = getNumberWord(expectedCount);
  const acceptedHints = [
    `which ${countWord}`,
    `select ${expectedCount}`,
    `choose ${expectedCount}`,
    `${expectedCount} answers`,
    `${countWord} answers`,
  ];

  if (!acceptedHints.some((hint) => lowerQuestion.includes(hint))) {
    addIssue(
      issues,
      'error',
      reference,
      `Multi-select question should clearly indicate ${expectedCount} required answers.`,
    );
  }
}

function getNumberWord(number) {
  return (
    {
      1: 'one',
      2: 'two',
      3: 'three',
      4: 'four',
      5: 'five',
    }[number] ?? String(number)
  );
}

function getAllowedDomains(examConfig) {
  const domainNames = examConfig?.domainNames ?? [];
  const distributionDomains = Object.keys(examConfig?.domainDistribution ?? {});

  return new Set([...domainNames, ...distributionDomains]);
}

function addIssue(issues, level, questionId, message) {
  issues.push({
    level,
    questionId,
    message,
  });
}
