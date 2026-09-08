import {
  EXAM_LIFECYCLES,
  getExamLifecycle,
  getLifecycleStatusDescription,
  getLifecycleStatusLabel,
  isDraftLifecycle,
  isLiveVisibleLifecycle,
} from './examLifecycle.js';
import { getProtectedDashboardMetadata, getProtectedProfileMetadata } from './protectedProfileMetadata.js';
import { getExamDisplayMetadata } from './examDisplayMetadata.js';

const mode = (id, name) => Object.freeze({ id, name, label: name });
const profile = (id, name, totalScoredQuestions, timeLimitMinutes, details = {}) => Object.freeze({
  id, name, displayName: name, totalScoredQuestions, totalItems: totalScoredQuestions,
  timeLimitMinutes, description: 'Protected practice.', availabilityStatus: 'available',
  standardQuestionCount: totalScoredQuestions, ...details,
});

const definitions = [
  {
    id: 'inf303', lifecycle: EXAM_LIFECYCLES.productionReady,
    statusLabel: 'Protected practice', statusNote: 'Entitlement required.',
    domainCount: 6, pbqCount: 0, caseStudyCount: 0, passingScore: 700,
    domainNames: ['Python fundamentals', 'Data types and operators', 'Flow control', 'Data collections', 'Functions and exceptions', 'Modules and tools'],
    modes: [mode('inf303-protected-practice', 'Python Standard Practice')],
    profiles: withRouteActions('inf303', ['full', 'compact']),
  },
  {
    id:'sc200', lifecycle:EXAM_LIFECYCLES.productionReady, statusLabel:'Protected practice', statusNote:'Protected practice.',
    domainCount:3, pbqCount:0, caseStudyCount:0, passingScore:700,
    domainNames:['Manage a security operations environment','Respond to security incidents','Perform threat hunting'],
    domainSummary:'3 domains · 9 objective groups',
    objectiveGroups:[
      {domain:'Manage a security operations environment',objectives:['Configure automation for Microsoft Defender XDR and Microsoft Sentinel','Configure the Microsoft Sentinel SIEM and platform','Ingest data into the Microsoft Sentinel SIEM and platform','Configure detections']},
      {domain:'Respond to security incidents',objectives:['Respond to alerts and incidents in Microsoft Defender XDR','Respond to alerts and incidents in Microsoft Defender for Endpoint','Investigate Microsoft 365 activities to identify threats']},
      {domain:'Perform threat hunting',objectives:['Detect threats by using Microsoft Defender XDR','Detect threats by using the Microsoft Sentinel platform']},
    ],
    modes:[mode('sc200-protected-practice','SC-200 Practice')], profiles:withRouteActions('sc200',['full','compact']),
  },
  {
    id: 'az204', lifecycle: EXAM_LIFECYCLES.nearRetirement,
    statusLabel: 'Near-retirement support', statusNote: 'AZ-204 retires July 31, 2026.',
    domainCount: 5, pbqCount: 0, caseStudyCount: 8, passingScore: 700,
    domainNames: ['Develop Azure compute solutions', 'Develop for Azure storage', 'Implement Azure security', 'Monitor, troubleshoot, and optimize Azure solutions', 'Connect to and consume Azure services and third-party services'],
    modes: [mode('full-mock', 'Full Mock Exam'), mode('realistic-random', 'Realistic Random Exam')],
    profiles: withRouteActions('az204', ['standard', 'compact', 'full', 'case-heavy']),
  },
  {
    id: 'security-plus-sy0-701', lifecycle: EXAM_LIFECYCLES.productionReady,
    statusLabel: 'Protected practice', statusNote: 'Protected practice.',
    domainCount: 5, pbqCount: 20, caseStudyCount: 0, passingScore: 750,
    domainNames: ['General Security Concepts', 'Threats, Vulnerabilities, and Mitigations', 'Security Architecture', 'Security Operations', 'Security Program Management and Oversight'],
    modes: [mode('security-plus-protected-practice', 'Security+ Practice')],
    profiles: withRouteActions('security-plus-sy0-701', ['compact', 'full']),
  },
  {
    id: 'az400', lifecycle: EXAM_LIFECYCLES.controlledBeta,
    statusLabel: 'Protected practice', statusNote: 'Protected practice.',
    domainCount: 5, pbqCount: 12, caseStudyCount: 52, passingScore: 700,
    domainNames: ['Configure processes and communications', 'Design and implement source control', 'Design and implement build and release pipelines', 'Develop a security and compliance plan', 'Implement an instrumentation strategy'],
    modes: [mode('az400-protected-practice', 'AZ-400 Practice')],
    profiles: withRouteActions('az400', ['compact', 'full', 'sectioned']),
  },
  {
    id: 'ai901', lifecycle: EXAM_LIFECYCLES.controlledBeta,
    statusLabel: 'Protected practice', statusNote: 'Protected practice.',
    domainCount: 5, pbqCount: 0, caseStudyCount: 0, passingScore: 700,
    domainNames: ['AI workloads and considerations', 'Machine learning on Azure', 'Computer vision workloads', 'Natural Language Processing workloads', 'Generative AI workloads'],
    modes: [mode('ai901-protected-practice', 'AI-901 Practice')],
    profiles: withRouteActions('ai901', ['compact', 'full']),
  },
].map(createContentFreeDefinition);

function withRouteActions(examId, actions) {
  return getProtectedProfileMetadata(examId).profiles.map((metadata, index) =>
    profile(metadata.id, metadata.name, metadata.totalScoredQuestions, metadata.timeLimitMinutes, {
      ...metadata,
      routeAction: actions[index],
    }));
}

function createContentFreeDefinition(item) {
  const display = getExamDisplayMetadata(item.id);
  if (!display) throw new Error(`Missing exam display metadata for ${item.id}.`);
  const packageMetadata = getProtectedDashboardMetadata(item.id);
  if (!packageMetadata) throw new Error(`Missing protected package metadata for ${item.id}.`);
  item = {
    ...item,
    questionCount: packageMetadata.questionCount,
    protectedPackageVersion: packageMetadata.packageVersion,
    slug: display.routeSlug,
    code: display.code,
    shortName: display.shortTitle,
    title: display.fullTitle,
    vendor: display.vendor,
    displayMetadata: display,
  };
  const [primaryMode] = item.modes;
  const [primaryProfile, ...alternateProfiles] = item.profiles;
  const strictOnly = true;
  return Object.freeze({
    ...item,
    examTitle: item.title,
    status: item.lifecycle,
    legacyStatus: item.lifecycle,
    versionLabel: 'Protected package selected by server',
    shortDescription: `${item.shortName} protected practice module.`,
    longDescription: `${item.shortName} uses authenticated, server-authoritative protected delivery.`,
    trainerValidationNote: 'Protected practice.',
    supportsAttemptHistory: false,
    supportsStudySandbox: true,
    supportsTargetedPractice: true,
    supportsPbqPreview: item.pbqCount > 0,
    supportsCaseStudyPreview: item.caseStudyCount > 0,
    supportsSectionedFullExam: item.id === 'az400',
    modeIds: strictOnly
      ? {
          fullMock: item.modes[0]?.id,
          realisticRandom: item.modes[1]?.id,
          strictBeta: item.id === 'az400' ? 'az400-sectioned-full-exam-beta' : primaryMode.id,
        }
      : {
          fullMock: item.modes[0]?.id,
          realisticRandom: item.modes[1]?.id,
          ...(item.id === 'az400' ? { strictBeta: item.modes[2]?.id } : {}),
        },
    examModeOptions: strictOnly ? [] : item.modes.slice(0, 2),
    fullMockProfile: strictOnly ? null : primaryProfile,
    strictBetaMode: strictOnly ? primaryMode : item.id === 'az400' ? item.modes[2] : null,
    strictBetaProfiles: item.profiles,
    profiles: { fullMock: primaryProfile, realisticRandom: alternateProfiles },
    getExamModeById: (id) => item.modes.find((entry) => entry.id === id) ?? null,
    getRandomRealisticProfile: () => alternateProfiles[0] ?? primaryProfile,
    questionBank: Object.freeze([]), caseStudyBlocks: Object.freeze([]), shortCaseStudyBlocks: Object.freeze([]), demoLabs: Object.freeze([]),
    generationConfig: Object.freeze({ totalQuestionsToSelect: primaryProfile.totalScoredQuestions, timeLimitMinutes: primaryProfile.timeLimitMinutes }),
    timing: Object.freeze({ defaultMinutes: primaryProfile.timeLimitMinutes }),
    scoreScale: Object.freeze({ min: 0, max: 1000, pass: item.passingScore }),
    scoreLabel: 'Server-authoritative CertSim result',
    supportedFeatures: Object.freeze({ fullMock: !strictOnly, realisticRandom: !strictOnly, studySandbox: true, targetedPractice: true, attemptHistory: true, printableReport: true, feedback: true, caseStudies: item.caseStudyCount > 0, pbqLabs: item.pbqCount > 0 }),
    ui: Object.freeze({ availableExamName: item.title, reportTitle: `${item.shortName} protected result`, statusLabel: item.statusLabel, statusDescription: item.statusNote, homeDescription: `${item.shortName} protected practice with server-authoritative delivery.`, timedAttemptsIntro: 'Choose an available protected profile. Sign-in and server-side entitlement are required.' }),
    metadata: Object.freeze({ id: item.id, code: item.code, title: item.title, vendor: item.vendor, shortName: item.shortName, domains: item.domainNames }),
    guideNotes: Object.freeze(['Protected delivery requires sign-in and an active server-side entitlement.']),
    disclaimers: Object.freeze(['CertSim is an unofficial practice simulator.']),
  });
}

export const [inf303ExamDefinition, sc200ExamDefinition, az204ExamDefinition, securityPlusSy0701ExamDefinition, az400ExamDefinition, ai901ExamDefinition] = definitions;
export const examRegistry = definitions;
export const activeExamConfigs = examRegistry.filter(isLiveVisibleExamConfig);
export const liveVisibleExamConfigs = examRegistry.filter(isLiveVisibleExamConfig);
export const draftExamConfigs = examRegistry.filter(isDraftExamConfig);
export const defaultExamConfig = activeExamConfigs[0];
export function isLiveVisibleExamConfig(config) { return isLiveVisibleLifecycle(getExamLifecycle(config)); }
export function isDraftExamConfig(config) { return isDraftLifecycle(getExamLifecycle(config)); }
export function isInternalBetaExamConfig(config) { return getExamLifecycle(config) === EXAM_LIFECYCLES.controlledBeta; }
export function getExamStatusLabel(config) { return config?.statusLabel ?? getLifecycleStatusLabel(getExamLifecycle(config)); }
export function getExamStatusDescription(config) { return config?.statusNote ?? getLifecycleStatusDescription(getExamLifecycle(config)); }
export function getExamConfigById(id) { return examRegistry.find((config) => config.id === id) ?? defaultExamConfig; }
