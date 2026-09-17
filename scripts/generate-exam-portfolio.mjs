import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { examRegistry } from '../src/exams/examRegistry.protected.js';
import { EXAM_LIFECYCLE_LABELS } from '../src/exams/examLifecycle.js';
import { protectedProfileMetadata } from '../src/exams/protectedProfileMetadata.js';

const outputPath = new URL('../docs/EXAM_PORTFOLIO.md', import.meta.url);
const featureLabels = Object.freeze({
  studySandbox: 'Study Sandbox',
  targetedPractice: 'targeted practice',
  attemptHistory: 'history',
  printableReport: 'printable report',
  feedback: 'feedback',
  caseStudies: 'case studies',
  pbqLabs: 'PBQs',
  fullMock: 'full mock',
  realisticRandom: 'realistic random',
});

function cell(value) {
  return String(value ?? '—').replaceAll('|', '\\|');
}

function profileCharacteristics(profile) {
  const parts = [];
  if (profile.standardQuestionCount) parts.push(`${profile.standardQuestionCount} standard`);
  if (profile.caseStudyCount) {
    const label = profile.caseStudyCount === 1 ? 'case study' : 'case studies';
    parts.push(`${profile.caseStudyCount} ${label} / ${profile.caseStudyQuestionCount} items`);
  }
  if (profile.pbqCount) parts.push(`${profile.pbqCount} PBQs`);
  if (profile.executableCount) parts.push(`${profile.executableCount} executable tasks`);
  if (profile.canonicalFormCount) parts.push(`${profile.canonicalFormCount} canonical forms`);
  if (profile.sectionOrder) parts.push(`order: ${profile.sectionOrder}`);
  if (profile.pbqPlacement) parts.push(`PBQs: ${profile.pbqPlacement}`);
  return parts.join('; ') || 'standard profile';
}

function assertContentFreeRegistry() {
  const registryIds = examRegistry.map((exam) => exam.id);
  const metadataIds = Object.keys(protectedProfileMetadata);
  if (new Set(registryIds).size !== registryIds.length) throw new Error('Exam registry IDs must be unique.');
  if (registryIds.join('\n') !== metadataIds.join('\n')) throw new Error('Registry/profile metadata order or coverage differs.');
  for (const exam of examRegistry) {
    for (const field of ['questionBank', 'caseStudyBlocks', 'shortCaseStudyBlocks', 'demoLabs']) {
      if (!Array.isArray(exam[field]) || exam[field].length !== 0) {
        throw new Error(`Refusing to generate from non-empty protected-content field: ${exam.id}.${field}`);
      }
    }
  }
}

export function renderExamPortfolio() {
  assertContentFreeRegistry();
  const lines = [
    '<!-- GENERATED FILE. DO NOT EDIT. Run: node scripts/generate-exam-portfolio.mjs -->',
    '',
    '# CertSim exam portfolio',
    '',
    'This portfolio is generated deterministically from the browser-safe, content-free',
    '`src/exams/examRegistry.protected.js` and `src/exams/protectedProfileMetadata.js`',
    'authorities. It contains no question, answer, explanation, or scoring material.',
    '',
    '## Exams',
    '',
    '| Exam ID | Display name | Vendor | Category | Lifecycle | Package | Configured inventory | Supported characteristics |',
    '| --- | --- | --- | --- | --- | --- | ---: | --- |',
  ];

  for (const exam of examRegistry) {
    const metadata = protectedProfileMetadata[exam.id];
    const features = Object.entries(exam.supportedFeatures ?? {})
      .filter(([, enabled]) => enabled)
      .map(([name]) => featureLabels[name] ?? name)
      .join(', ');
    lines.push(`| ${cell(exam.id)} | ${cell(exam.title)} | ${cell(exam.vendor)} | ${cell(exam.displayMetadata?.category)} | ${cell(EXAM_LIFECYCLE_LABELS[exam.lifecycle] ?? exam.lifecycle)} | ${cell(metadata.packageVersion)} | ${cell(metadata.inventoryCount)} | ${cell(features)} |`);
  }

  lines.push('', '## Profiles', '', '| Exam ID | Profile | Scored items | Minutes | Characteristics |', '| --- | --- | ---: | ---: | --- |');
  for (const exam of examRegistry) {
    for (const profile of protectedProfileMetadata[exam.id].profiles) {
      lines.push(`| ${cell(exam.id)} | ${cell(profile.name)} | ${cell(profile.totalScoredQuestions)} | ${cell(profile.timeLimitMinutes)} | ${cell(profileCharacteristics(profile))} |`);
    }
  }

  lines.push('', 'Lifecycle, package, inventory, profile, and feature changes must be made in the', 'safe metadata authority and regenerated here; active delivery and entitlement remain', 'server-authoritative.', '');
  return lines.join('\n');
}

async function main() {
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (arg !== '--check') throw new Error(`Unknown argument: ${arg}`);
  }
  const expected = renderExamPortfolio();
  if (args.has('--check')) {
    const actual = await readFile(outputPath, 'utf8').catch(() => '');
    if (actual !== expected) throw new Error('docs/EXAM_PORTFOLIO.md is stale. Regenerate it with node scripts/generate-exam-portfolio.mjs.');
    console.log(JSON.stringify({ ok: true, mode: 'check', exams: examRegistry.length }));
    return;
  }
  await writeFile(outputPath, expected, 'utf8');
  console.log(JSON.stringify({ ok: true, mode: 'write', exams: examRegistry.length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
