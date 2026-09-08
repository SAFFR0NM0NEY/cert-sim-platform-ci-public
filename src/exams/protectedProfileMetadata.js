// Content-free projection of the currently published protected package profile
// metadata. This module is safe for the browser: it contains composition and
// timing facts only, never question identities, presentation, or scoring data.
export const protectedProfileMetadata = Object.freeze({
  inf303: Object.freeze({
    packageVersion: '1.1.0',
    inventoryCount: 276,
    profiles: Object.freeze([
      profile('inf303-standard', 'Full Simulation', 40, 120, { standardQuestionCount: 40, canonicalFormCount: 6 }),
      profile('inf303-compact', 'Compact Simulation', 20, 60, { standardQuestionCount: 20, canonicalFormCount: 6 }),
    ]),
  }),
  sc200: Object.freeze({packageVersion:'1.1.0',inventoryCount:300,profiles:Object.freeze([
    profile('sc200-full','Full',50,100,{canonicalFormCount:6}),
    profile('sc200-compact','Compact',25,50,{canonicalFormCount:6}),
  ])}),
  az204: Object.freeze({
    packageVersion: '1.1.0',
    inventoryCount: 287,
    profiles: Object.freeze([
      profile('standard-profile', 'Standard', 50, 120, { standardQuestionCount: 43, caseStudyCount: 1, caseStudyQuestionCount: 7, longCaseStudyCount: 1, shortCaseStudyCount: 0 }),
      profile('compact-profile', 'Compact', 40, 100, { standardQuestionCount: 37, caseStudyCount: 1, caseStudyQuestionCount: 3, longCaseStudyCount: 0, shortCaseStudyCount: 1 }),
      profile('full-profile', 'Full', 60, 150, { standardQuestionCount: 50, caseStudyCount: 2, caseStudyQuestionCount: 10, longCaseStudyCount: 1, shortCaseStudyCount: 1 }),
      profile('case-heavy-profile', 'Case-heavy', 50, 130, { standardQuestionCount: 40, caseStudyCount: 2, caseStudyQuestionCount: 10, longCaseStudyCount: 1, shortCaseStudyCount: 1 }),
    ]),
  }),
  'security-plus-sy0-701': Object.freeze({
    packageVersion: '1.0.0',
    inventoryCount: 370,
    profiles: Object.freeze([
      profile('strict-beta-compact', 'Compact', 45, 60, { standardQuestionCount: 42, pbqCount: 3, pbqPlacement: 'front-loaded' }),
      profile('strict-beta-full', 'Full', 90, 90, { standardQuestionCount: 86, pbqCount: 4, pbqPlacement: 'front-loaded' }),
    ]),
  }),
  az400: Object.freeze({
    packageVersion: '1.0.0',
    inventoryCount: 433,
    profiles: Object.freeze([
      profile('az400-mvp-compact-profile', 'Compact', 60, 90, { standardQuestionCount: 60, sectionOrder: 'standard' }),
      profile('az400-mvp-full-profile', 'Full', 80, 120, { standardQuestionCount: 80, sectionOrder: 'standard' }),
      profile('az400-sectioned-full-exam-profile', 'Sectioned', 80, 120, { standardQuestionCount: 66, caseStudyCount: 2, caseStudyQuestionCount: 12, pbqCount: 2, sectionOrder: 'case-standard-pbq' }),
    ]),
  }),
  ai901: Object.freeze({
    packageVersion: '3.0.0',
    inventoryCount: 334,
    profiles: Object.freeze([
      profile('ai901-controlled-beta-compact', 'Compact', 25, 25, { standardQuestionCount: 25 }),
      profile('ai901-controlled-beta-full', 'Full', 50, 45, { standardQuestionCount: 50 }),
    ]),
  }),
});

export function getProtectedProfileMetadata(examId) {
  return protectedProfileMetadata[examId] ?? null;
}

export function getProtectedDashboardMetadata(examId, source = protectedProfileMetadata) {
  const metadata = source[examId];
  if (!metadata || !/^\d+\.\d+\.\d+$/.test(metadata.packageVersion) || !Number.isInteger(metadata.inventoryCount) || metadata.inventoryCount < 1) {
    return null;
  }
  return Object.freeze({
    packageVersion: metadata.packageVersion,
    questionCount: metadata.inventoryCount,
  });
}

function profile(id, name, totalScoredQuestions, timeLimitMinutes, details = {}) {
  return Object.freeze({
    id,
    name,
    totalScoredQuestions,
    timeLimitMinutes,
    standardQuestionCount: totalScoredQuestions,
    caseStudyCount: 0,
    caseStudyQuestionCount: 0,
    pbqCount: 0,
    ...details,
  });
}
