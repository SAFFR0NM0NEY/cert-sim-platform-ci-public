import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertApprovedPrivateOutputPath,
  buildPublicationRequestInMemory,
  createExternalPackageSummary,
} from './backend-exam-publication/external-content-package.mjs';

const applicationRoot = process.cwd();
const fakeLoaded = {
  validation: { examKey: 'fixture', packageVersion: '1.0.0' },
  contract: {
    packageSchemaVersion: 'certsim-protected-package-v2',
    validationContractVersion: 'certsim-protected-multi-exam-validation-v1',
    exam: {
      examKey: 'fixture', packageVersion: '1.0.0', capabilities: ['single-choice'],
      domains: [{ key: 'domain', name: 'Sanitized domain' }],
    },
    source: { sourceHash: 'a'.repeat(64), validationHash: 'b'.repeat(64) },
    runtime: { generatorVersion: 'fixture-generator-v1', scorerVersion: 'fixture-scorer-v1' },
    profiles: [{ profileKey: 'fixture', questionCount: 1, timeLimitMinutes: 1, selection: { mode: 'fixed' } }],
    releasePolicy: { review: 'after_submission', answers: 'after_submission' },
    questions: [{
      id: 'fixture-question', type: 'single-choice', domainKey: 'domain', scored: true,
      presentation: { prompt: 'Sanitized prompt', options: [{ id: 'a', text: 'A' }] },
      privateScoring: { correctOptionIds: ['a'] }, privateReview: { rationale: 'Sanitized rationale' },
    }],
  },
};

const request = buildPublicationRequestInMemory(fakeLoaded);
assert.equal(request.examKey, 'fixture');
assert.equal(Object.hasOwn(request, 'packagePayload'), true);
assert.throws(
  () => assertApprovedPrivateOutputPath(path.join(applicationRoot, 'dist', 'package.json')),
  /PRIVATE_OUTPUT_PATH_REQUIRED/,
);
assert.match(
  assertApprovedPrivateOutputPath(path.resolve(applicationRoot, '..', 'private', 'package.json')),
  /private/i,
);
assert.equal(createExternalPackageSummary(fakeLoaded).questionCount, 1);
const frontendFiles = walk(path.join(applicationRoot, 'src'));
assert.equal(frontendFiles.some((file) => {
  const source = fs.readFileSync(file, 'utf8');
  return source.includes('cert-sim-protected-content') || source.includes('external-content-package');
}), false, 'FRONTEND_IMPORTS_PROTECTED_CONTENT');
console.log('PASS external protected-content package boundary (sanitized fixture only)');

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}
