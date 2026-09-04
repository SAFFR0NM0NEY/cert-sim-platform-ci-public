import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  canonicalizeMultiExamContract,
  createSanitizedMultiExamSummary,
  validateMultiExamPackageContract,
} from './multi-exam-contract.mjs';
import { sha256Canonical } from './canonical-json.mjs';

const PRIVATE_OUTPUT_PATTERN = /(?:^|[\\/])(?:private|protected|vault)(?:[\\/]|$)/i;

export async function loadExternalProtectedPackage(contentRoot, options = {}) {
  if (typeof contentRoot !== 'string' || !contentRoot.trim()) {
    throw new Error('PROTECTED_CONTENT_ROOT_REQUIRED');
  }
  const resolvedRoot = path.resolve(contentRoot);
  const sourceUrl = pathToFileURL(path.join(resolvedRoot, 'package-source.mjs')).href;
  const source = await import(sourceUrl);
  if (typeof source.buildProtectedPackage !== 'function') {
    throw new Error('PROTECTED_PACKAGE_BUILDER_REQUIRED');
  }
  const contract = await source.buildProtectedPackage({ examKey: options.examKey, ...(options.packageVersion ? { packageVersion: options.packageVersion } : {}) });
  if (options.packageVersion && contract.exam?.packageVersion !== options.packageVersion) {
    throw new Error('PROTECTED_PACKAGE_VERSION_MISMATCH');
  }
  const validation = validateMultiExamPackageContract(contract);
  return Object.freeze({ contract, validation, contentRoot: resolvedRoot });
}

export function createExternalPackageSummary(loaded) {
  const summary = createSanitizedMultiExamSummary(loaded.contract);
  return Object.freeze({
    ...summary,
    packageHash: sha256Canonical(loaded.contract),
    sourceHash: loaded.contract.source.sourceHash,
    validationHash: loaded.contract.source.validationHash,
  });
}

export function buildPublicationRequestInMemory(loaded) {
  return Object.freeze({
    examKey: loaded.validation.examKey,
    packageVersion: loaded.validation.packageVersion,
    packagePayload: JSON.parse(canonicalizeMultiExamContract(loaded.contract)),
    packageHash: sha256Canonical(loaded.contract),
  });
}

export function assertApprovedPrivateOutputPath(outputPath, applicationRoot = process.cwd()) {
  const resolved = path.resolve(outputPath);
  const relative = path.relative(path.resolve(applicationRoot), resolved);
  if (!relative.startsWith('..') || !PRIVATE_OUTPUT_PATTERN.test(resolved)) {
    throw new Error('PRIVATE_OUTPUT_PATH_REQUIRED');
  }
  return resolved;
}
