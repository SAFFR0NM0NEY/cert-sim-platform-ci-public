import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  EXECUTION_RESULT_VERSION,
  normalizeExecutionRequest,
  normalizeExecutionResult,
} from '../../python-executor/src/contract.mjs';
import {
  PythonExecutionProvider,
  PythonExecutionProviderError,
} from '../../python-executor/src/provider.mjs';
import { assertExecutionRequestWithinDeclaredCapabilities } from '../../python-executor/src/isolation.mjs';
import { MODAL_ISOLATION_CAPABILITIES, MODAL_PROVIDER_LIMITS } from './isolation.mjs';
import { collectBoundedProcessOutput } from './output.mjs';

export const MODAL_SDK_VERSION = '0.10.1';
export const MODAL_EXECUTOR_APP = 'certsim-python-executor';
export const MODAL_EXECUTOR_IMAGE = 'python:3.13-slim';

const TRUSTED_LAUNCHER_SOURCE = readFileSync(new URL('./launcher.py', import.meta.url), 'utf8');
const LAUNCHER_PREFIX = 'CERTSIM_MODAL_LAUNCHER=';
const LAUNCHER_SETUP_PREFIX = 'CERTSIM_MODAL_SETUP_ERROR=';
const LAUNCHER_MAPPING_PREFIX = 'CERTSIM_MODAL_MAPPING_ERROR=';
const LAUNCHER_RESERVED_EXIT_CODE = 125;
const EXECUTION_ID_PATTERN = /^execution\.[0-9a-f-]{36}$/;
const REQUEST_UUID_PATTERN = /^request\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const SAFE_OPERATION_CODE_PATTERN = /^(?:[a-z][a-z_]{1,39}:(?:E[A-Z0-9]{1,30}|OTHER|POLICY|IMPORT)|unsupported_architecture)$/;
const SAFE_TERMINAL_CATEGORIES = new Set([
  'cancelled',
  'completed',
  'completion_exception',
  'disposal_unconfirmed',
  'launcher_attestation_failed',
  'launcher_mapping_failed',
  'launcher_setup_failed',
  'learner_nonzero_exit',
  'output_limit',
  'provider_setup_failed',
  'provider_wait_rejected',
  'timeout',
]);
const decoder = new TextDecoder();

function providerError(code = 'PROVIDER_OPERATION_FAILED') {
  return new PythonExecutionProviderError(code);
}

function assertExecutionId(value) {
  if (typeof value !== 'string' || !EXECUTION_ID_PATTERN.test(value)) {
    throw providerError('PROVIDER_EXECUTION_NOT_FOUND');
  }
  return value;
}

function resultFor(executionId, values = {}) {
  return normalizeExecutionResult({
    contractVersion: EXECUTION_RESULT_VERSION,
    executionId,
    status: values.status ?? 'failed',
    stdout: values.stdout ?? '',
    stderr: values.stderr ?? '',
    exitCode: values.exitCode ?? null,
    outcome: values.outcome ?? 'failed',
    diagnostics: [],
  }, { outputByteLimit: values.outputByteLimit });
}

function activeResult(executionId, status, outputByteLimit) {
  return normalizeExecutionResult({
    contractVersion: EXECUTION_RESULT_VERSION,
    executionId,
    status,
    stdout: '',
    stderr: '',
    exitCode: null,
    outcome: null,
    diagnostics: [],
  }, { outputByteLimit });
}

export function buildModalSandboxCreateParams(executionId, request) {
  const memoryMiB = Math.floor(request.limits.memoryBytes / (1024 * 1024));
  return Object.freeze({
    cpu: MODAL_PROVIDER_LIMITS.cpuRequest,
    cpuLimit: MODAL_PROVIDER_LIMITS.cpuLimit,
    memoryMiB,
    memoryLimitMiB: memoryMiB,
    timeoutMs: MODAL_PROVIDER_LIMITS.wallTimeMs,
    idleTimeoutMs: 10_000,
    workdir: '/tmp',
    env: {},
    secrets: [],
    volumes: {},
    cloudBucketMounts: {},
    pty: false,
    encryptedPorts: [],
    h2Ports: [],
    unencryptedPorts: [],
    blockNetwork: true,
    includeOidcIdentityToken: false,
    name: sandboxNameForExecution(executionId),
    tags: {
      purpose: MODAL_EXECUTOR_APP,
      lifecycle: 'one-disposable-execution',
      execution: executionId,
    },
  });
}

export function executionIdForRequest(requestId) {
  const matched = REQUEST_UUID_PATTERN.exec(requestId);
  return `execution.${matched?.[1] ?? randomUUID()}`;
}

export function sandboxNameForExecution(executionId) {
  return `certsim-python-${assertExecutionId(executionId).slice('execution.'.length)}`;
}

export async function terminateModalSandboxForRequest(client, requestId) {
  if (!client?.apps?.fromName || !client?.sandboxes?.fromName) throw providerError();
  const executionId = executionIdForRequest(requestId);
  const sandboxName = sandboxNameForExecution(executionId);
  try {
    const sandbox = await client.sandboxes.fromName(MODAL_EXECUTOR_APP, sandboxName);
    try {
      await sandbox.terminate();
    } catch (error) {
      if (error?.name !== 'NotFoundError') {
        try {
          if (!Number.isInteger(await sandbox.poll())) throw error;
        } catch (pollError) {
          if (pollError?.name !== 'NotFoundError') throw providerError('PROVIDER_DISPOSAL_UNCONFIRMED');
        }
      }
    }
    sandbox.detach?.();
  } catch (error) {
    if (error?.name !== 'NotFoundError') throw error;
  }
  return resultFor(executionId, { status: 'cancelled', outcome: 'cancelled' });
}

function validateLauncherReport(report) {
  const learner = report?.learner;
  return report?.namespaceSetup === true
    && report.workspaceBytes === MODAL_PROVIDER_LIMITS.diskBytes
    && Array.isArray(report.workspaceFlags)
    && report.workspaceFlags.join(',') === 'nodev,noexec,nosuid'
    && learner?.uid === 65534
    && learner.euid === 65534
    && learner.gid === 65534
    && learner.egid === 65534
    && learner.pid === 1
    && Array.isArray(learner.groups)
    && learner.groups.length === 0
    && learner.effectiveCapabilities === 0
    && learner.noNewPrivileges === 1
    && learner.seccompMode === 2
    && Array.isArray(learner.nproc)
    && learner.nproc[0] === MODAL_PROVIDER_LIMITS.processCount
    && learner.nproc[1] === MODAL_PROVIDER_LIMITS.processCount
    && Array.isArray(learner.cpuSeconds)
    && learner.cpuSeconds[0] === MODAL_PROVIDER_LIMITS.cpuTimeMs / 1000
    && learner.cpuSeconds[1] === MODAL_PROVIDER_LIMITS.cpuTimeMs / 1000
    && Array.isArray(learner.fileSizeBytes)
    && learner.fileSizeBytes[0] === MODAL_PROVIDER_LIMITS.diskBytes
    && learner.fileSizeBytes[1] === MODAL_PROVIDER_LIMITS.diskBytes
    && Array.isArray(learner.environmentNames)
    && learner.environmentNames.length === 0;
}

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return new TextEncoder().encode(value);
  throw providerError();
}

function joinBytes(chunks, total) {
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function readTrustedPreamble(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  let newline = -1;
  while (newline < 0) {
    const { done, value } = await reader.read();
    if (done) throw providerError();
    const bytes = asBytes(value);
    chunks.push(bytes);
    total += bytes.byteLength;
    if (total > 4_096) throw providerError();
    newline = joinBytes(chunks, total).indexOf(10);
  }
  const joined = joinBytes(chunks, total);
  const line = decoder.decode(joined.slice(0, newline)).replace(/\r$/, '');
  let report = null;
  let launcherFailure = Object.freeze({ category: 'launcher_attestation_failed', operationCode: null });
  if (line.startsWith(LAUNCHER_PREFIX)) {
    try {
      report = JSON.parse(line.slice(LAUNCHER_PREFIX.length));
    } catch {
      report = null;
    }
    const setupError = report?.learner?.setupError;
    if (typeof setupError === 'string' && SAFE_OPERATION_CODE_PATTERN.test(setupError)) {
      launcherFailure = Object.freeze({ category: 'launcher_setup_failed', operationCode: setupError });
    }
  } else if (line.startsWith(LAUNCHER_SETUP_PREFIX)) {
    const operationCode = line.slice(LAUNCHER_SETUP_PREFIX.length);
    launcherFailure = Object.freeze({
      category: 'launcher_setup_failed',
      operationCode: SAFE_OPERATION_CODE_PATTERN.test(operationCode) ? operationCode : null,
    });
  } else if (line.startsWith(LAUNCHER_MAPPING_PREFIX)) {
    const operationCode = line.slice(LAUNCHER_MAPPING_PREFIX.length);
    launcherFailure = Object.freeze({
      category: 'launcher_mapping_failed',
      operationCode: SAFE_OPERATION_CODE_PATTERN.test(operationCode) ? operationCode : null,
    });
  }
  const remainder = joined.slice(newline + 1);
  let first = true;
  const learnerStream = new ReadableStream({
    async pull(controller) {
      if (first) {
        first = false;
        if (remainder.byteLength > 0) {
          controller.enqueue(remainder);
          return;
        }
      }
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return Object.freeze({
    learnerStream,
    launcherAttested: validateLauncherReport(report),
    launcherFailure,
  });
}

function safeTerminalLog(logger, record, category, { exitCode = null, operationCode = null } = {}) {
  const safeCategory = SAFE_TERMINAL_CATEGORIES.has(category) ? category : 'completion_exception';
  const diagnostic = {
    event: 'python_execution_terminal',
    executionId: record.executionId,
    status: record.result.status,
    outcome: record.result.outcome,
    elapsedMs: Date.now() - record.startedAt,
    category: safeCategory,
    disposed: record.disposed === true,
  };
  if (safeCategory === 'learner_nonzero_exit'
      && Number.isSafeInteger(exitCode) && exitCode >= 1 && exitCode <= 255) {
    diagnostic.exitCode = exitCode;
  }
  if ((safeCategory === 'launcher_setup_failed' || safeCategory === 'launcher_mapping_failed')
      && typeof operationCode === 'string' && SAFE_OPERATION_CODE_PATTERN.test(operationCode)) {
    diagnostic.operationCode = operationCode;
  }
  try {
    logger(Object.freeze(diagnostic));
  } catch {
    // Operational logging must never change execution lifecycle.
  }
}

function safeLifecycleLog(logger, event, record) {
  try {
    logger(Object.freeze({
      event,
      executionId: record.executionId,
      status: record.result.status,
      outcome: record.result.outcome,
      elapsedMs: Date.now() - record.startedAt,
    }));
  } catch {
    // Operational logging must never change execution lifecycle.
  }
}

function safeSetupFailureLog(logger, executionId, stage, error) {
  const upstreamCode = String(error?.code ?? error?.name ?? 'UNKNOWN').toUpperCase();
  try {
    logger(Object.freeze({
      event: 'python_execution_setup_failed',
      executionId,
      category: 'provider_setup_failed',
      stage,
      upstreamCode: /^[A-Z0-9_:-]{1,80}$/.test(upstreamCode) ? upstreamCode : 'UNKNOWN',
    }));
  } catch {
    // Diagnostics must never alter cleanup or the sanitized provider failure.
  }
}

export class ModalPythonExecutionProvider extends PythonExecutionProvider {
  #client;
  #logger;
  #fence;
  #appPromise;
  #records = new Map();

  constructor({ client, logger = () => {}, fence }) {
    super();
    if (!client?.apps?.fromName || !client?.images?.fromRegistry || !client?.sandboxes?.create) {
      throw providerError('PROVIDER_SHAPE_INVALID');
    }
    if (typeof logger !== 'function') throw new TypeError('logger must be a function.');
    this.#client = client;
    this.#logger = logger;
    this.#fence = fence;
  }

  async #app() {
    this.#appPromise ??= this.#client.apps.fromName(MODAL_EXECUTOR_APP, { createIfMissing: true });
    return this.#appPromise;
  }

  async #terminate(record) {
    if (record.disposed) return;
    if (!record.terminationPromise) {
      record.terminationPromise = (async () => {
        let confirmed = false;
        try {
          const stopped = await record.sandbox.terminate(this.#fence ? { wait: true } : undefined);
          confirmed = this.#fence ? Number.isInteger(stopped) || Number.isInteger(await record.sandbox.poll()) : true;
        } catch (terminationError) {
          if (terminationError?.name === 'NotFoundError') confirmed = true;
          if (!confirmed) {
            try {
              confirmed = Number.isInteger(await record.sandbox.poll());
            } catch (pollError) {
              confirmed = pollError?.name === 'NotFoundError';
            }
          }
        }
        if (!confirmed) throw providerError('PROVIDER_DISPOSAL_UNCONFIRMED');
        try {
          record.sandbox.detach();
        } catch {
          // The remote termination confirmation is authoritative.
        }
        if (this.#fence) await this.#fence.disposed(record.fenceHandle, record.sandbox.sandboxId);
        record.disposed = true;
      })();
    }
    return record.terminationPromise;
  }

  async #complete(record) {
    let timedOut = false;
    let timeout;
    try {
      const waitPromise = record.process.wait()
        .then((exitCode) => ({ exitCode, rejected: false }))
        .catch(() => ({ exitCode: null, rejected: true }));
      const preamble = await readTrustedPreamble(record.process.stderr);
      timeout = setTimeout(() => {
        timedOut = true;
        void this.#terminate(record).catch(() => {});
      }, record.request.limits.wallTimeMs);
      timeout.unref?.();
      const output = await collectBoundedProcessOutput({
        stdout: record.process.stdout,
        stderr: preamble.learnerStream,
        maximumBytes: record.request.limits.outputBytes,
        collectionTimeoutMs: record.request.limits.wallTimeMs + 2_000,
        onStop: () => this.#terminate(record),
      });
      const waited = await waitPromise;
      let final;
      let category;
      let diagnostic = {};
      if (record.cancelRequested) {
        final = resultFor(record.executionId, {
          status: 'cancelled', outcome: 'cancelled', outputByteLimit: record.request.limits.outputBytes,
        });
        category = 'cancelled';
      } else if (!preamble.launcherAttested) {
        final = resultFor(record.executionId, {
          status: 'failed', outcome: 'failed', outputByteLimit: record.request.limits.outputBytes,
        });
        category = preamble.launcherFailure.category;
        diagnostic = { operationCode: preamble.launcherFailure.operationCode };
      } else if (timedOut || output.collectionTimedOut) {
        final = resultFor(record.executionId, {
          status: 'finished', outcome: 'timeout', stdout: output.stdout,
          stderr: output.stderr, outputByteLimit: record.request.limits.outputBytes,
        });
        category = 'timeout';
      } else if (output.truncated) {
        final = resultFor(record.executionId, {
          status: 'finished', outcome: 'resource_limit', stdout: output.stdout,
          stderr: output.stderr, outputByteLimit: record.request.limits.outputBytes,
        });
        category = 'output_limit';
      } else if (waited.rejected) {
        final = resultFor(record.executionId, {
          status: 'failed', outcome: 'failed', outputByteLimit: record.request.limits.outputBytes,
        });
        category = 'provider_wait_rejected';
      } else if (waited.exitCode === LAUNCHER_RESERVED_EXIT_CODE) {
        final = resultFor(record.executionId, {
          status: 'failed', outcome: 'failed', outputByteLimit: record.request.limits.outputBytes,
        });
        category = 'launcher_setup_failed';
      } else if (waited.exitCode === 0) {
        final = resultFor(record.executionId, {
          status: 'finished', outcome: 'completed', exitCode: 0, stdout: output.stdout,
          stderr: output.stderr, outputByteLimit: record.request.limits.outputBytes,
        });
        category = 'completed';
      } else {
        const safeExitCode = Number.isSafeInteger(waited.exitCode)
          && waited.exitCode >= 1 && waited.exitCode <= 255 ? waited.exitCode : null;
        final = resultFor(record.executionId, {
          status: 'finished', outcome: 'failed', exitCode: safeExitCode, stdout: output.stdout,
          stderr: output.stderr, outputByteLimit: record.request.limits.outputBytes,
        });
        category = 'learner_nonzero_exit';
        diagnostic = { exitCode: safeExitCode };
      }
      await this.#terminate(record);
      record.result = final;
      safeTerminalLog(this.#logger, record, category, diagnostic);
    } catch (error) {
      let category = error?.code === 'PROVIDER_DISPOSAL_UNCONFIRMED'
        ? 'disposal_unconfirmed'
        : 'completion_exception';
      try {
        await this.#terminate(record);
      } catch (terminationError) {
        if (terminationError?.code === 'PROVIDER_DISPOSAL_UNCONFIRMED') {
          category = 'disposal_unconfirmed';
        }
        // The safe result remains failed; reconciliation is a later deployment concern.
      }
      record.result = record.cancelRequested
        ? resultFor(record.executionId, {
          status: 'cancelled', outcome: 'cancelled', outputByteLimit: record.request.limits.outputBytes,
        })
        : resultFor(record.executionId, {
          status: 'failed', outcome: 'failed', outputByteLimit: record.request.limits.outputBytes,
        });
      safeTerminalLog(this.#logger, record, record.cancelRequested ? 'cancelled' : category);
    } finally {
      clearTimeout(timeout);
    }
  }

  async execute(request) {
    const canonicalRequest = normalizeExecutionRequest(request);
    assertExecutionRequestWithinDeclaredCapabilities(canonicalRequest, MODAL_ISOLATION_CAPABILITIES);
    const executionId = executionIdForRequest(canonicalRequest.requestId);
    const accepted = activeResult(executionId, 'accepted', canonicalRequest.limits.outputBytes);
    let sandbox, fenceHandle;
    let setupStage = 'app_lookup';
    try {
      const app = await this.#app();
      setupStage = 'sandbox_create';
      const image = this.#client.images.fromRegistry(MODAL_EXECUTOR_IMAGE);
      if (this.#fence) fenceHandle = await this.#fence.beforeCreate(canonicalRequest);
      sandbox = await this.#client.sandboxes.create(
        app,
        image,
        buildModalSandboxCreateParams(executionId, canonicalRequest),
      );
      if (this.#fence && !await this.#fence.created(fenceHandle, sandbox.sandboxId)) throw providerError('FENCE_REVOKED');
      setupStage = 'sandbox_exec';
      const processHandle = await sandbox.exec(['python3', '-c', TRUSTED_LAUNCHER_SOURCE], {
        mode: 'binary',
        timeoutMs: Math.min(canonicalRequest.limits.wallTimeMs + 2_000, MODAL_PROVIDER_LIMITS.wallTimeMs),
        env: {},
        secrets: [],
        pty: false,
      });
      await processHandle.stdin.writeText(JSON.stringify(canonicalRequest.workspace));
      await processHandle.stdin.close();
      const record = {
        executionId,
        request: canonicalRequest,
        sandbox,
        process: processHandle,
        fenceHandle,
        startedAt: Date.now(),
        cancelRequested: false,
        disposed: false,
        terminationPromise: null,
        result: activeResult(executionId, 'running', canonicalRequest.limits.outputBytes),
      };
      this.#records.set(executionId, record);
      record.completion = this.#complete(record);
      safeLifecycleLog(this.#logger, 'python_execution_accepted', record);
      return accepted;
    } catch (error) {
      if (sandbox) {
        try {
          const stopped = await sandbox.terminate(this.#fence ? { wait: true } : undefined);
          if (this.#fence && (Number.isInteger(stopped) || Number.isInteger(await sandbox.poll()))) {
            await this.#fence.disposed(fenceHandle, sandbox.sandboxId);
          }
        } catch {
          // Best-effort cleanup before returning a sanitized provider failure.
        }
      }
      safeSetupFailureLog(this.#logger, executionId, setupStage, error);
      throw providerError();
    }
  }

  async getStatus(executionId) {
    const record = this.#records.get(assertExecutionId(executionId));
    if (!record) throw providerError('PROVIDER_EXECUTION_NOT_FOUND');
    return record.result;
  }

  async cancel(executionId) {
    const record = this.#records.get(assertExecutionId(executionId));
    if (!record) throw providerError('PROVIDER_EXECUTION_NOT_FOUND');
    if (!['accepted', 'running'].includes(record.result.status)) return record.result;
    record.cancelRequested = true;
    await this.#terminate(record);
    record.result = resultFor(record.executionId, {
      status: 'cancelled', outcome: 'cancelled', outputByteLimit: record.request.limits.outputBytes,
    });
    safeTerminalLog(this.#logger, record, 'cancelled');
    return record.result;
  }

  async dispose(executionId) {
    const record = this.#records.get(assertExecutionId(executionId));
    if (!record) throw providerError('PROVIDER_EXECUTION_NOT_FOUND');
    if (!record.disposed) {
      if (['accepted', 'running'].includes(record.result.status)) record.cancelRequested = true;
      await this.#terminate(record);
      if (record.cancelRequested) {
        record.result = resultFor(record.executionId, {
          status: 'cancelled', outcome: 'cancelled', outputByteLimit: record.request.limits.outputBytes,
        });
      }
    }
    return record.result;
  }

  async close() {
    await Promise.allSettled([...this.#records.values()].map((record) => this.#terminate(record)));
    this.#client.close?.();
  }
}

/** Fenced recovery uses only a settled immutable ID, never a reusable name. */
export async function terminateModalSandboxById(client, sandboxId) {
 if(!/^sb-[A-Za-z0-9_-]{1,125}$/.test(sandboxId)||!client?.sandboxes?.fromId)throw providerError('PROVIDER_DISPOSAL_UNCONFIRMED');
 let sandbox;
 try {
  sandbox=await client.sandboxes.fromId(sandboxId);
  // SDK 0.10.1 terminate() without wait only acknowledges termination.
  const exit=await sandbox.terminate({wait:true});
  if(!Number.isInteger(exit)&&!Number.isInteger(await sandbox.poll()))throw providerError('PROVIDER_DISPOSAL_UNCONFIRMED');
 }catch(error){if(error?.name!=='NotFoundError')throw providerError('PROVIDER_DISPOSAL_UNCONFIRMED');}
 finally{sandbox?.detach?.();}
}
