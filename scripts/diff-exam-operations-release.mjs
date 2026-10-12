import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stderr, stdout } from 'node:process';

import { loadExternalProtectedCandidate } from './backend-exam-publication/external-content-package.mjs';
import { validateExamOperationsCandidate } from './backend-exam-publication/exam-operations-candidate.mjs';
import { buildExamOperationsCurrentState } from './backend-exam-publication/exam-operations-current-state.mjs';
import {
  RELEASE_CHANGE_CLASSIFICATIONS,
  createExamOperationsReleaseDiff,
  formatExamOperationsReleaseDiffReport,
} from './backend-exam-publication/exam-operations-release-diff.mjs';
import { assertSanitizedExamOperationsOutput } from './backend-exam-publication/exam-operations-output-safety.mjs';
import { readProductionExamOperationsState } from './exam-operations/read-production-state.mjs';

try {
  const args = parseArgs(process.argv.slice(2));
  const rawState = await readProductionExamOperationsState(args.examKey);
  const currentBuild = buildExamOperationsCurrentState(rawState, args.examKey);
  const loaded = await loadExternalProtectedCandidate(args.contentRoot, {
    examKey: args.examKey,
    ...(args.packageVersion ? { packageVersion: args.packageVersion } : {}),
  });
  const candidate = validateExamOperationsCandidate(loaded.contract, {
    currentPackageVersion: currentBuild.snapshot.resolution.currentPackageVersion,
    predecessorPackageVersion:
      currentBuild.snapshot.currentPackage?.relationship.predecessorPackageVersion,
  });
  const diff = createExamOperationsReleaseDiff({
    currentState: currentBuild.snapshot,
    candidateValidation: candidate,
    currentFingerprintIndex: currentBuild.privateComparisonIndex,
    candidateContract: loaded.contract,
  });
  const document = {
    mode: 'read-only-release-diff',
    currentState: currentBuild.snapshot,
    diff,
    productionMutations: 0,
  };
  assertSanitizedExamOperationsOutput(document);
  if (args.output) {
    await writeFile(args.output, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'w',
    });
  }
  stdout.write(args.json
    ? `${JSON.stringify(document)}\n`
    : `${formatExamOperationsReleaseDiffReport(diff)}\n`);
  process.exitCode = candidate.validation?.verdict === 'invalid'
    || diff.overallChangeClassification === RELEASE_CHANGE_CLASSIFICATIONS.currentUnavailable
    ? 1
    : 0;
} catch (error) {
  stderr.write(`${safeCliError(error)}\n`);
  process.exitCode = 1;
}

function parseArgs(values) {
  const flags = new Set(values.filter((value) => value === '--json'));
  const allowedPrefixes = new Set([
    '--content-root=',
    '--exam-key=',
    '--package-version=',
    '--output=',
  ]);
  if (values.some((value) => value !== '--json'
      && ![...allowedPrefixes].some((prefix) => value.startsWith(prefix)))) {
    throw new Error('EXAMOPS_ARGUMENT_INVALID');
  }
  const contentRoot = singleValue(values, '--content-root=')
    ?? process.env.CERTSIM_PROTECTED_CONTENT_ROOT
    ?? null;
  const examKey = singleValue(values, '--exam-key=', true);
  const packageVersion = singleValue(values, '--package-version=');
  const outputValue = singleValue(values, '--output=');
  if (!contentRoot) throw new Error('PROTECTED_CONTENT_ROOT_REQUIRED');
  if (packageVersion && !/^[a-z0-9][a-z0-9._-]*$/.test(packageVersion)) {
    throw new Error('EXAMOPS_VERSION_INVALID');
  }
  return {
    contentRoot,
    examKey,
    packageVersion,
    output: outputValue ? path.resolve(outputValue) : null,
    json: flags.has('--json'),
  };
}

function singleValue(values, prefix, required = false) {
  const matches = values.filter((value) => value.startsWith(prefix));
  if (matches.length > 1 || (required && matches.length !== 1)) {
    throw new Error('EXAMOPS_ARGUMENT_INVALID');
  }
  const value = matches[0]?.slice(prefix.length).trim() ?? '';
  if (required && !value) throw new Error('EXAMOPS_ARGUMENT_INVALID');
  return value || null;
}

function safeCliError(error) {
  const code = typeof error?.message === 'string'
    ? error.message.match(/^[A-Z][A-Z0-9_]+/)?.[0]
    : null;
  return /^[A-Z][A-Z0-9_]{2,79}$/.test(code ?? '')
    ? code
    : 'EXAMOPS_RELEASE_DIFF_FAILED';
}
