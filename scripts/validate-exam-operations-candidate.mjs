import { writeFile } from 'node:fs/promises';
import { stdout, stderr } from 'node:process';
import path from 'node:path';

import {
  loadExternalProtectedCandidate,
} from './backend-exam-publication/external-content-package.mjs';
import {
  formatExamOperationsValidationReport,
  validateExamOperationsCandidate,
} from './backend-exam-publication/exam-operations-candidate.mjs';

const args = parseArgs(process.argv.slice(2));

try {
  const loaded = await loadExternalProtectedCandidate(args.contentRoot, {
    examKey: args.examKey,
    ...(args.packageVersion ? { packageVersion: args.packageVersion } : {}),
  });
  const result = validateExamOperationsCandidate(loaded.contract, {
    currentPackageVersion: args.currentPackageVersion,
    predecessorPackageVersion: args.predecessorPackageVersion,
  });
  const document = sanitizedDocument(result);

  if (args.output) {
    await writeFile(args.output, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'w',
    });
  }
  stdout.write(args.json
    ? `${JSON.stringify(document)}\n`
    : `${formatExamOperationsValidationReport(result)}\n`);
  process.exitCode = result.ok || result.migrationClassification === 'LEGACY_PACKAGE_PATH'
    ? 0
    : 1;
} catch (error) {
  stderr.write(`${safeCliError(error)}\n`);
  process.exitCode = 1;
}

function sanitizedDocument(result) {
  return Object.freeze({
    ok: result.ok,
    mode: 'validation-only',
    manifest: result.manifest,
    manifestHash: result.manifestHash,
    validation: result.validation,
    compatibility: result.compatibility,
    migrationClassification: result.migrationClassification,
    networkRequests: 0,
    productionMutations: 0,
  });
}

function parseArgs(values) {
  const flags = new Set(values.filter((value) => value === '--json'));
  const allowedPrefixes = new Set([
    '--content-root=',
    '--exam-key=',
    '--package-version=',
    '--current-version=',
    '--predecessor-version=',
    '--output=',
  ]);
  if (values.some((value) => value !== '--json'
      && ![...allowedPrefixes].some((prefix) => value.startsWith(prefix)))) {
    throw new Error('EXAMOPS_ARGUMENT_INVALID');
  }
  const contentRoot = singleValue(values, '--content-root=', true);
  const examKey = singleValue(values, '--exam-key=', true);
  const packageVersion = singleValue(values, '--package-version=');
  const currentPackageVersion = singleValue(values, '--current-version=');
  const predecessorPackageVersion = singleValue(values, '--predecessor-version=');
  const outputValue = singleValue(values, '--output=');
  const output = outputValue ? path.resolve(outputValue) : null;
  for (const value of [packageVersion, currentPackageVersion, predecessorPackageVersion]) {
    if (value && !/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
      throw new Error('EXAMOPS_VERSION_INVALID');
    }
  }
  return {
    contentRoot,
    examKey,
    packageVersion,
    currentPackageVersion,
    predecessorPackageVersion,
    output,
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
  const code = typeof error?.code === 'string'
    ? error.code
    : typeof error?.message === 'string'
      ? error.message.match(/^[A-Z][A-Z0-9_]+/)?.[0]
      : null;
  return /^[A-Z][A-Z0-9_]{2,79}$/.test(code ?? '')
    ? code
    : 'EXAMOPS_CANDIDATE_LOAD_FAILED';
}
