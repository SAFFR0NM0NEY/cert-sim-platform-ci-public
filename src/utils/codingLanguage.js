export const CODING_LANGUAGE_PREFERENCES = {
  csharp: 'csharp',
  python: 'python',
  mixed: 'mixed',
};

export const CODING_LANGUAGE_OPTIONS = [
  {
    id: CODING_LANGUAGE_PREFERENCES.csharp,
    label: 'C#',
    description: 'Use C# variants where an AZ-204 code question supports them.',
  },
  {
    id: CODING_LANGUAGE_PREFERENCES.python,
    label: 'Python',
    description: 'Use Python variants where an AZ-204 code question supports them.',
  },
  {
    id: CODING_LANGUAGE_PREFERENCES.mixed,
    label: 'Mixed',
    description:
      'Mixed randomly uses available C# or Python variants per question for this attempt.',
  },
];

export const DEFAULT_CODING_LANGUAGE_PREFERENCE =
  CODING_LANGUAGE_PREFERENCES.csharp;

const codingLanguageOptionIds = new Set(
  CODING_LANGUAGE_OPTIONS.map((option) => option.id),
);

export function normalizeCodingLanguagePreference(preference) {
  return codingLanguageOptionIds.has(preference)
    ? preference
    : DEFAULT_CODING_LANGUAGE_PREFERENCE;
}

export function getCodingLanguageLabel(preference) {
  return (
    CODING_LANGUAGE_OPTIONS.find((option) => option.id === preference)?.label ??
    'C#'
  );
}

export function getQuestionCodingLanguageMeta(question) {
  if (question?.resolvedCodingLanguageLabel) {
    return {
      label: 'Coding language',
      value: question.resolvedCodingLanguageLabel,
      badgeText: `Coding language: ${question.resolvedCodingLanguageLabel}`,
    };
  }

  if (question?.codingLanguageNeutral) {
    const value = question.codingLanguageLabel ?? 'Language neutral';

    return {
      label: 'Code syntax',
      value,
      badgeText: value,
    };
  }

  return null;
}

export function resolveCodingVariant(
  question,
  codingLanguagePreference = DEFAULT_CODING_LANGUAGE_PREFERENCE,
  context = {},
) {
  if (!question?.codingVariants) {
    return question;
  }

  const variants = question.codingVariants;
  const availableVariantIds = Object.keys(variants).filter(
    (variantId) => variants[variantId],
  );

  if (availableVariantIds.length === 0) {
    return question;
  }

  const preference = normalizeCodingLanguagePreference(codingLanguagePreference);
  const selectedVariantId =
    preference === CODING_LANGUAGE_PREFERENCES.mixed
      ? selectMixedVariantId(question, availableVariantIds, context)
      : variants[preference]
        ? preference
        : availableVariantIds[0];
  const selectedVariant = variants[selectedVariantId];

  return {
    ...question,
    ...selectedVariant,
    id: question.id,
    type: question.type,
    domain: question.domain,
    difficulty: question.difficulty,
    caseStudyId: question.caseStudyId,
    caseStudySize: question.caseStudySize,
    codingVariants: question.codingVariants,
    baseQuestionId: question.id,
    selectedCodingLanguage: selectedVariantId,
    resolvedCodingLanguage: selectedVariantId,
    resolvedCodingLanguageLabel:
      selectedVariant.languageLabel ?? getCodingLanguageLabel(selectedVariantId),
    blanks: selectedVariant.blanks?.map(cloneBlank) ?? question.blanks,
  };
}

function selectMixedVariantId(question, availableVariantIds, context) {
  const frozenVariantId = context.variantByQuestionId?.[question.id];

  if (availableVariantIds.includes(frozenVariantId)) {
    return frozenVariantId;
  }

  const random = context.random ?? createSeededRandom(question.id);
  const index = Math.floor(random() * availableVariantIds.length);

  return availableVariantIds[index] ?? availableVariantIds[0];
}

function cloneBlank(blank) {
  return {
    ...blank,
    options: [...(blank.options ?? [])],
  };
}

function createSeededRandom(seedText) {
  let seed = String(seedText).split('').reduce(
    (hash, character) =>
      ((hash << 5) - hash + character.charCodeAt(0)) >>> 0,
    0,
  ) || 1;

  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}
