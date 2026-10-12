import { examDisplayMetadata } from '../exams/examDisplayMetadata.js';
import { getProtectedExamKey } from './protectedExamContract.js';
import { isSupabaseConfigured, supabase } from './supabaseClient.js';

const TELEMETRY_CODES = Object.freeze([
  'SAVE_FAILURE_TELEMETRY',
  'SUBMIT_FAILURE_TELEMETRY',
  'DEPLOYMENT_CORRELATION',
  'POST_RELEASE_HEALTH_EVENT',
]);

export const EXAM_OPERATIONS_EXAMS = Object.freeze(
  examDisplayMetadata
    .map((exam) => Object.freeze({
      code: exam.code,
      examKey: getProtectedExamKey(exam.canonicalId),
      title: exam.fullTitle,
    }))
    .filter((exam) => exam.examKey)
    .sort((left, right) => left.code.localeCompare(right.code)),
);

export async function loadExamOperationsOverview({ client = supabase } = {}) {
  if (!client || (client === supabase && !isSupabaseConfigured)) {
    return failure('not_configured');
  }

  const results = await Promise.all(
    EXAM_OPERATIONS_EXAMS.map(async (exam) => {
      const result = await loadExamOperationsHealth(exam.examKey, { client });
      return { exam, result };
    }),
  );
  const failed = results.find(({ result }) => !result.ok);

  if (failed) {
    return failed.result;
  }

  return success(results.map(({ exam, result }) => ({
    ...exam,
    health: result.data,
  })));
}

export async function loadExamOperationsHealth(examKey, { client = supabase } = {}) {
  const normalizedExamKey = normalizeExamKey(examKey);

  if (!normalizedExamKey) {
    return failure('exam_not_found');
  }
  if (!client || (client === supabase && !isSupabaseConfigured)) {
    return failure('not_configured');
  }

  const { data, error } = await client.rpc('certsim_examops_get_health', {
    p_exam_key: normalizedExamKey,
  });

  if (error) {
    return failure(classifyRpcError(error));
  }
  if (!data?.ok) {
    return failure(data?.code === 'EXAM_NOT_FOUND' ? 'exam_not_found' : 'backend_unavailable');
  }

  return success(normalizeHealth(data));
}

export async function loadExamOperationsHistory(
  examKey,
  { client = supabase, limit = 25 } = {},
) {
  const normalizedExamKey = normalizeExamKey(examKey);

  if (!normalizedExamKey) {
    return failure('exam_not_found');
  }
  if (!client || (client === supabase && !isSupabaseConfigured)) {
    return failure('not_configured');
  }

  const boundedLimit = Math.min(Math.max(Number.parseInt(limit, 10) || 25, 1), 50);
  const { data, error } = await client.rpc(
    'certsim_examops_list_release_operations',
    {
      p_cursor: null,
      p_exam_key: normalizedExamKey,
      p_limit: boundedLimit,
    },
  );

  if (error) {
    return failure(classifyRpcError(error));
  }
  if (!data?.ok) {
    return failure('backend_unavailable');
  }

  return success((Array.isArray(data.operations) ? data.operations : [])
    .map(normalizeOperation));
}

export function normalizeHealth(value = {}) {
  const telemetry = TELEMETRY_CODES.map((code) => ({
    code,
    status: value.telemetry?.[code] === 'NOT_AVAILABLE'
      ? 'NOT_AVAILABLE'
      : 'NOT_AVAILABLE',
  }));

  return Object.freeze({
    catalogueLifecycle: safeText(value.catalogueLifecycle),
    catalogueStatus: safeText(value.catalogueStatus),
    catalogueVersion: safeText(value.catalogueVersion),
    configurationHash: safeHash(value.configurationHash),
    currentContinuationContracts: safeCount(value.currentContinuationContracts),
    currentContinuableAttempts: safeCount(value.currentContinuableAttempts),
    currentMissingContinuationContracts: safeCount(value.currentMissingContinuationContracts),
    currentPackageVersion: safeText(value.currentPackageVersion),
    currentPracticeAttempts: safeCount(value.currentPracticeAttempts),
    currentStateFindings: safeCodeList(value.currentStateFindings),
    currentStateStatus: safeCode(value.currentStateStatus),
    currentTimedAttempts: safeCount(value.currentTimedAttempts),
    enabledDefaultCount: safeCount(value.enabledDefaultCount),
    enabledProfileCount: safeCount(value.enabledProfileCount),
    examKey: normalizeExamKey(value.examKey),
    frozenSubmitCount: safeCount(value.frozenSubmitCount),
    generatorVersion: safeText(value.generatorVersion),
    healthSchema: safeText(value.healthSchema),
    healthStatus: ['VALID', 'WARNING', 'BLOCKED'].includes(value.healthStatus)
      ? value.healthStatus
      : 'BLOCKED',
    latestOperationErrorCode: safeCode(value.latestOperationErrorCode),
    latestOperationStatus: safeCode(value.latestOperationStatus),
    latestOperationTargetVersion: safeText(value.latestOperationTargetVersion),
    latestOperationTimestamp: safeTimestamp(value.latestOperationTimestamp),
    latestOperationType: safeCode(value.latestOperationType),
    latestPublicationErrorCode: safeCode(value.latestPublicationErrorCode),
    latestPublicationPackageVersion: safeText(value.latestPublicationPackageVersion),
    latestPublicationStatus: safeCode(value.latestPublicationStatus),
    latestPublicationTimestamp: safeTimestamp(value.latestPublicationTimestamp),
    observedAt: safeTimestamp(value.observedAt),
    olderPackageContinuableAttempts: safeCount(value.olderPackageContinuableAttempts),
    packageHash: safeHash(value.packageHash),
    packageSchemaVersion: safeText(value.packageSchemaVersion),
    packageStatus: safeCode(value.packageStatus),
    productionActivationCount: safeCount(value.productionActivationCount),
    releaseEvidencePackageVersion: safeText(value.releaseEvidencePackageVersion),
    releaseEvidenceProfileKey: safeText(value.releaseEvidenceProfileKey),
    releaseEvidenceSource: safeCode(value.releaseEvidenceSource),
    releaseEvidenceStage: safeCode(value.releaseEvidenceStage),
    releaseEvidenceTimestamp: safeTimestamp(value.releaseEvidenceTimestamp),
    scorerVersion: safeText(value.scorerVersion),
    sourceCommitSha: safeHash(value.sourceCommitSha, [40, 64]),
    telemetry,
    usablePracticePolicyCount: safeCount(value.usablePracticePolicyCount),
    validationHash: safeHash(value.validationHash),
  });
}

export function normalizeOperation(value = {}) {
  const preflight = isObject(value.preflight) ? value.preflight : {};
  const postconditions = isObject(value.postconditions) ? value.postconditions : {};

  return Object.freeze({
    completedAt: safeTimestamp(value.completedAt),
    createdAt: safeTimestamp(value.createdAt),
    operationType: safeCode(value.operationType),
    outcome: safeCode(
      value.errorCode || postconditions.outcome || preflight.outcome || value.resultState,
    ),
    resultState: safeCode(value.resultState),
    targetVersion: safeText(
      preflight.targetPackageVersion
        || postconditions.currentPackageVersion
        || postconditions.restoredPackageVersion,
    ),
  });
}

export function getExamOperationsMessage(reason) {
  return {
    backend_unavailable: 'Exam Operations health is temporarily unavailable. Try refreshing shortly.',
    exam_not_found: 'The selected protected exam was not found.',
    forbidden: 'Exam Operations is limited to active Platform Owner accounts.',
    not_configured: 'Exam Operations is not configured in this environment.',
  }[reason] ?? 'Exam Operations could not be loaded safely.';
}

function classifyRpcError(error = {}) {
  return error.code === '42501' || /examops_forbidden|permission denied/i.test(error.message ?? '')
    ? 'forbidden'
    : 'backend_unavailable';
}

function success(data) {
  return { ok: true, data };
}

function failure(reason) {
  return { ok: false, reason, message: getExamOperationsMessage(reason) };
}

function normalizeExamKey(value) {
  const normalized = typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]/g, '')
    : '';
  return /^[a-z0-9]+$/.test(normalized) ? normalized : '';
}

function safeCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function safeCode(value) {
  const text = safeText(value);
  return /^[A-Za-z0-9_-]{1,100}$/.test(text) ? text : '';
}

function safeCodeList(value) {
  return Array.isArray(value) ? value.map(safeCode).filter(Boolean) : [];
}

function safeHash(value, lengths = [64]) {
  const text = safeText(value).toLowerCase();
  return lengths.includes(text.length) && /^[0-9a-f]+$/.test(text) ? text : '';
}

function safeText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 200) : '';
}

function safeTimestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return '';
  return new Date(value).toISOString();
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export const examOperationsService = Object.freeze({
  loadHistory: loadExamOperationsHistory,
  loadOverview: loadExamOperationsOverview,
});
