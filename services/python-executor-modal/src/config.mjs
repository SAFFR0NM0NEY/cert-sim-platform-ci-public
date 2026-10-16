import { DisabledPythonExecutionProvider } from '../../python-executor/src/provider.mjs';
import { ModalPythonExecutionProvider } from './provider.mjs';

export const MODAL_FEATURE_FLAG = 'CERTSIM_PYTHON_EXECUTION_ENABLED';
export const MODAL_FEATURE_ENABLED_VALUE = 'YES';
const SAFE_EXECUTION_ID = /^execution\.[0-9a-f-]{36}$/;
const SAFE_DIAGNOSTIC_TOKEN = /^[A-Za-z0-9_.:-]{1,80}$/;

const SAFE_MESSAGES = Object.freeze({
  MODAL_CREDENTIALS_INCOMPLETE: 'The server-side Modal credential pair is incomplete.',
  MODAL_CREDENTIALS_REQUIRED: 'Server-side Modal credentials are required.',
});

export class ModalIntegrationConfigError extends Error {
  constructor(code) {
    super(SAFE_MESSAGES[code] ?? 'The Modal integration configuration is invalid.');
    this.name = 'ModalIntegrationConfigError';
    this.code = code;
  }
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function readServerModalCredentials(env = process.env) {
  const hasId = hasText(env.MODAL_TOKEN_ID);
  const hasSecret = hasText(env.MODAL_TOKEN_SECRET);
  if (hasId !== hasSecret) throw new ModalIntegrationConfigError('MODAL_CREDENTIALS_INCOMPLETE');
  if (!hasId) throw new ModalIntegrationConfigError('MODAL_CREDENTIALS_REQUIRED');
  return Object.freeze({ tokenId: env.MODAL_TOKEN_ID, tokenSecret: env.MODAL_TOKEN_SECRET });
}

export async function defaultClientFactory(credentials) {
  const { ModalClient } = await import('modal');
  return new ModalClient({ ...credentials, logLevel: 'error' });
}

export async function createConfiguredModalClient({
  env = process.env,
  clientFactory = defaultClientFactory,
} = {}) {
  return clientFactory(readServerModalCredentials(env));
}

export function formatSafeModalDiagnostic(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.event === 'python_execution_setup_failed') {
    if (!SAFE_EXECUTION_ID.test(record.executionId)
        || record.category !== 'provider_setup_failed'
        || !['app_lookup', 'sandbox_create', 'sandbox_exec'].includes(record.stage)
        || !SAFE_DIAGNOSTIC_TOKEN.test(record.upstreamCode)) return null;
    return [record.event, record.executionId, record.category, record.stage, record.upstreamCode].join(':');
  }
  if (record.event !== 'python_execution_terminal'
      || !SAFE_EXECUTION_ID.test(record.executionId)
      || !SAFE_DIAGNOSTIC_TOKEN.test(record.category)
      || !['finished', 'failed', 'cancelled'].includes(record.status)
      || !['completed', 'failed', 'cancelled', 'timeout', 'resource_limit'].includes(record.outcome)
      || !Number.isSafeInteger(record.elapsedMs) || record.elapsedMs < 0
      || typeof record.disposed !== 'boolean') return null;
  const values = [
    record.event,
    record.executionId,
    record.category,
    record.status,
    record.outcome,
    String(record.elapsedMs),
    record.disposed ? 'disposed' : 'disposal_unconfirmed',
  ];
  if (Number.isSafeInteger(record.exitCode) && record.exitCode >= 1 && record.exitCode <= 255) {
    values.push(`exit_${record.exitCode}`);
  }
  if (typeof record.operationCode === 'string' && SAFE_DIAGNOSTIC_TOKEN.test(record.operationCode)) {
    values.push(record.operationCode);
  }
  return values.join(':');
}

export async function createConfiguredPythonExecutionProvider({
  env = process.env,
  clientFactory = defaultClientFactory,
  logger,
  fence,
} = {}) {
  if (env[MODAL_FEATURE_FLAG] !== MODAL_FEATURE_ENABLED_VALUE) {
    return new DisabledPythonExecutionProvider();
  }
  const client = await createConfiguredModalClient({ env, clientFactory });
  const safeLogger = logger ?? (env.CERTSIM_MODAL_SAFE_DIAGNOSTICS === 'YES'
    ? (record) => {
        const diagnostic = formatSafeModalDiagnostic(record);
        if (diagnostic) process.emitWarning(diagnostic, { code: 'CERTSIM_MODAL_DIAGNOSTIC' });
      }
    : undefined);
  return new ModalPythonExecutionProvider({ client, logger: fence ? () => {} : safeLogger, fence });
}
