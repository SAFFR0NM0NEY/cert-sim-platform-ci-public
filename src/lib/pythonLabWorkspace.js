import { assertPresentationSafe } from './protectedExamContract.js';

export const PYTHON_LAB_INTERACTION_VERSION = 'executable-python-lab-v1';

const MAX_FILES = 16;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_WORKSPACE_BYTES = 256 * 1024;
const MAX_PATH_BYTES = 240;
const PYTHON_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.py$/;
const RUN_STATES = new Set([
  'authorized', 'queued', 'running', 'cancel_requested',
  'completed', 'failed', 'cancelled',
]);
const TERMINAL_OUTCOMES = new Set(['completed', 'timeout', 'resource_limit', 'failed', 'cancelled']);
const DISPOSAL_STATES = new Set(['not_requested', 'pending', 'confirmed', 'failed']);
const CANCELLABLE_RUN_STATES = new Set(['authorized', 'queued', 'running']);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const GENERIC_PYTHON_TASK_HEADING = 'Python coding task';
const MAX_RUN_REQUEST_ATTEMPTS = 2;
const RUN_OUTCOME_UNCONFIRMED_MESSAGE = 'The Run outcome could not be confirmed. Your code is saved. Retry Run to reconcile the same request.';

export function isExecutablePythonLab(question) {
  return question?.interactionVersion === PYTHON_LAB_INTERACTION_VERSION;
}

export function normalizePythonLabPresentation(value) {
  assertPlainObject(value, 'invalid_python_lab_presentation');
  assertPresentationSafe(value);
  if (!isExecutablePythonLab(value)) throw contractError('invalid_python_lab_interaction');

  const instructions = normalizeInstructions(value.instructions);
  const task = firstBoundedText([value.task, value.question, value.prompt, value.title], 16_000)
    || (instructions.length > 0 ? GENERIC_PYTHON_TASK_HEADING : '');
  if (!task) throw contractError('invalid_python_lab_task');
  const starterCandidate = starterWorkspaceCandidate(value);
  const starterWorkspace = normalizePythonWorkspace(starterCandidate);
  const allowedFilenames = normalizeAllowedFilenames(
    value.allowedFilenames ?? value.editableFiles ?? starterWorkspace.files.map((file) => file.path),
  );
  if (starterWorkspace.files.some((file) => !allowedFilenames.includes(file.path))) {
    throw contractError('invalid_python_lab_allowed_files');
  }

  return Object.freeze({
    interactionVersion: PYTHON_LAB_INTERACTION_VERSION,
    task,
    instructions: Object.freeze(instructions),
    starterWorkspace,
    allowedFilenames: Object.freeze(allowedFilenames),
  });
}

function starterWorkspaceCandidate(value) {
  if (value.starterWorkspace !== undefined && value.starterWorkspace !== null) {
    return value.starterWorkspace;
  }
  if (Array.isArray(value.files)) {
    return { entryPoint: value.entryPoint, files: value.files };
  }

  const hasStarterCode = Object.hasOwn(value, 'starterCode');
  const hasEditableFiles = Object.hasOwn(value, 'editableFiles');
  if (!hasStarterCode && !hasEditableFiles) return null;
  if (
    typeof value.starterCode !== 'string' ||
    !Array.isArray(value.editableFiles) ||
    value.editableFiles.length !== 1
  ) throw contractError('invalid_python_lab_starter_workspace');

  const [entryPoint] = normalizeAllowedFilenames(value.editableFiles);
  return {
    entryPoint,
    files: [{ path: entryPoint, content: value.starterCode }],
  };
}

export function normalizePythonWorkspace(value, allowedFilenames = null) {
  assertPlainObject(value, 'invalid_python_workspace');
  assertOnlyKeys(value, ['entryPoint', 'files'], 'invalid_python_workspace');
  if (!isSafePythonPath(value.entryPoint) || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > MAX_FILES) {
    throw contractError('invalid_python_workspace');
  }
  const allowed = allowedFilenames ? new Set(normalizeAllowedFilenames(allowedFilenames)) : null;
  const seen = new Set();
  let totalBytes = 0;
  const files = value.files.map((file) => {
    assertPlainObject(file, 'invalid_python_workspace');
    assertOnlyKeys(file, ['path', 'content'], 'invalid_python_workspace');
    if (!isSafePythonPath(file.path) || typeof file.content !== 'string') {
      throw contractError('invalid_python_workspace');
    }
    const portablePath = file.path.toLowerCase();
    if (seen.has(portablePath) || (allowed && !allowed.has(file.path))) {
      throw contractError('invalid_python_workspace');
    }
    seen.add(portablePath);
    const contentBytes = utf8Length(file.content);
    if (contentBytes > MAX_FILE_BYTES) throw contractError('invalid_python_workspace');
    totalBytes += contentBytes;
    return Object.freeze({ path: file.path, content: file.content });
  });
  if (totalBytes > MAX_WORKSPACE_BYTES || !files.some((file) => file.path === value.entryPoint)) {
    throw contractError('invalid_python_workspace');
  }
  return Object.freeze({ entryPoint: value.entryPoint, files: Object.freeze(files) });
}

export function normalizePythonRunDto(value) {
  assertPlainObject(value, 'invalid_python_run');
  assertOnlyKeys(value, [
    'runId', 'state', 'terminalOutcome', 'cancellationRequestedAt',
    'disposalState', 'stdout', 'stderr', 'exitCode', 'createdAt', 'updatedAt',
  ], 'invalid_python_run');
  if (
    !isBoundedText(value.runId, 1, 128) ||
    !RUN_STATES.has(value.state) ||
    (value.terminalOutcome !== null && !TERMINAL_OUTCOMES.has(value.terminalOutcome)) ||
    typeof value.stdout !== 'string' || typeof value.stderr !== 'string' ||
    utf8Length(value.stdout) + utf8Length(value.stderr) > MAX_OUTPUT_BYTES ||
    (value.exitCode !== null && (!Number.isSafeInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 255)) ||
    (value.cancellationRequestedAt !== null && !isBoundedText(value.cancellationRequestedAt, 1, 64)) ||
    !DISPOSAL_STATES.has(value.disposalState) ||
    !isBoundedText(value.createdAt, 1, 64) ||
    !isBoundedText(value.updatedAt, 1, 64)
  ) throw contractError('invalid_python_run');
  return Object.freeze({
    runId: value.runId,
    state: value.state,
    terminalOutcome: value.terminalOutcome,
    stdout: value.stdout,
    stderr: value.stderr,
    exitCode: value.exitCode,
    cancellationRequestedAt: value.cancellationRequestedAt,
    disposalState: value.disposalState,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}

export function normalizeLatestPythonRunDto(value, expectedItemId, expectedRevision) {
  assertPlainObject(value, 'invalid_python_latest_run');
  assertOnlyKeys(value, ['itemId', 'workspaceRevision', 'run'], 'invalid_python_latest_run');
  if (
    value.itemId !== expectedItemId ||
    !Number.isSafeInteger(value.workspaceRevision) ||
    value.workspaceRevision !== expectedRevision ||
    (value.run !== null && (typeof value.run !== 'object' || Array.isArray(value.run)))
  ) throw contractError('invalid_python_latest_run');
  return Object.freeze({
    itemId: value.itemId,
    workspaceRevision: value.workspaceRevision,
    run: value.run === null ? null : normalizePythonRunDto(value.run),
  });
}

export function isPythonRunCancellable(run) {
  return Boolean(run && CANCELLABLE_RUN_STATES.has(run.state));
}

export function createPythonLabWorkspaceController({
  attemptId,
  client,
  createRequestId = () => globalThis.crypto.randomUUID(),
  itemId,
  onChange = () => {},
  presentation,
}) {
  if (!isBoundedText(attemptId, 1, 128) || !isBoundedText(itemId, 1, 128)) {
    throw contractError('invalid_python_lab_identity');
  }
  for (const method of [
    'getPythonWorkspace', 'savePythonWorkspace', 'requestPythonRun',
    'getLatestPythonRun', 'getPythonRun', 'cancelPythonRun',
  ]) {
    if (typeof client?.[method] !== 'function') throw contractError('invalid_python_lab_client');
  }
  const safePresentation = normalizePythonLabPresentation(presentation);
  let pendingSaveRequestId = '';
  let pendingRunRequestId = '';
  let pendingCancelRequestId = '';
  let savePromise = null;
  let runPromise = null;
  let state = Object.freeze({
    phase: 'idle',
    workspace: safePresentation.starterWorkspace,
    serverRevision: 0,
    workspaceHash: null,
    persisted: false,
    dirty: false,
    message: 'Starter workspace is ready and has not been saved.',
    errorCode: '',
    conflict: null,
    run: null,
    runRevision: null,
    availability: null,
  });

  const emit = (patch) => {
    state = Object.freeze({ ...state, ...patch });
    onChange(state);
    return state;
  };

  async function load(options) {
    emit({ phase: 'loading', message: 'Loading your saved Python workspace...', errorCode: '' });
    try {
      const payload = await client.getPythonWorkspace(attemptId, itemId, options);
      const restored = normalizeWorkspaceReadDto(payload, itemId, safePresentation.allowedFilenames);
      if (restored.exists) {
        const latest = normalizeLatestPythonRunDto(
          await client.getLatestPythonRun(attemptId, itemId, options),
          itemId,
          restored.revision,
        );
        emit({
          phase: 'ready', workspace: restored.workspace,
          serverRevision: restored.revision, workspaceHash: restored.workspaceHash,
          persisted: true, dirty: false, conflict: null,
          run: latest.run, runRevision: latest.run ? latest.workspaceRevision : null,
          message: latest.run
            ? `Restored saved workspace revision ${restored.revision} and its latest run result.`
            : `Restored saved workspace revision ${restored.revision}. Current revision has not been run yet.`,
          errorCode: '',
        });
      } else {
        emit({
          phase: 'ready', workspace: safePresentation.starterWorkspace,
          serverRevision: 0, workspaceHash: null, persisted: false,
          dirty: false, conflict: null, run: null, runRevision: null,
          message: 'Starter workspace is ready and has not been saved.', errorCode: '',
        });
      }
      return true;
    } catch (error) {
      if (wasAborted(options, error)) return false;
      emitFailure(error, 'The Python workspace could not be loaded.');
      return false;
    }
  }

  function updateFile(path, content) {
    if (
      state.conflict || typeof content !== 'string' ||
      !state.workspace.files.some((file) => file.path === path)
    ) return false;
    let nextWorkspace;
    try {
      nextWorkspace = normalizePythonWorkspace({
        entryPoint: state.workspace.entryPoint,
        files: state.workspace.files.map((file) => file.path === path ? { ...file, content } : file),
      }, safePresentation.allowedFilenames);
    } catch {
      emit({
        phase: 'error',
        message: 'The edit exceeds the Python workspace size boundary.',
        errorCode: 'invalid_python_workspace',
      });
      return false;
    }
    if (!nextWorkspace.files.some((file) => file.path === path)) return false;
    emit({
      phase: 'ready', workspace: nextWorkspace, dirty: true,
      message: 'Unsaved changes.', errorCode: '', availability: null,
    });
    return true;
  }

  function save(options) {
    if (savePromise) return savePromise;
    savePromise = performSave(options).finally(() => { savePromise = null; });
    return savePromise;
  }

  async function performSave(options) {
    if (state.conflict) return false;
    if (state.persisted && !state.dirty) return true;
    pendingSaveRequestId ||= createRequestId();
    emit({ phase: 'saving', message: 'Saving Python workspace...', errorCode: '' });
    try {
      const payload = await client.savePythonWorkspace(
        attemptId, itemId, state.workspace, state.serverRevision,
        pendingSaveRequestId, options,
      );
      const saved = normalizeWorkspaceSaveDto(payload, itemId, state.serverRevision);
      const revisionChanged = saved.revision !== state.runRevision;
      pendingSaveRequestId = '';
      emit({
        phase: 'ready', serverRevision: saved.revision,
        workspaceHash: saved.workspaceHash, persisted: true, dirty: false,
        run: revisionChanged ? null : state.run,
        runRevision: revisionChanged ? null : state.runRevision,
        message: revisionChanged
          ? `Saved revision ${saved.revision}. Current revision has not been run yet.`
          : `Saved revision ${saved.revision}.`,
        errorCode: '', availability: null,
      });
      return true;
    } catch (error) {
      if (wasAborted(options, error)) return false;
      if (error?.code === 'revision_conflict') {
        pendingSaveRequestId = '';
        return loadRevisionConflict(options);
      }
      if (!isAmbiguousMutation(error)) pendingSaveRequestId = '';
      emitFailure(error, 'The Python workspace could not be saved.');
      return false;
    }
  }

  async function loadRevisionConflict(options) {
    try {
      const current = normalizeWorkspaceReadDto(
        await client.getPythonWorkspace(attemptId, itemId, options),
        itemId,
        safePresentation.allowedFilenames,
      );
      if (!current.exists) throw contractError('invalid_python_workspace_conflict');
      emit({
        phase: 'conflict',
        conflict: Object.freeze({
          workspace: current.workspace,
          revision: current.revision,
          workspaceHash: current.workspaceHash,
        }),
        message: 'A newer workspace revision is saved. Choose which version to continue with.',
        errorCode: 'revision_conflict',
      });
      return false;
    } catch (error) {
      if (wasAborted(options, error)) return false;
      emitFailure(error, 'The newer Python workspace could not be recovered.');
      return false;
    }
  }

  function resolveConflict(choice) {
    if (!state.conflict || !['use-server', 'keep-local'].includes(choice)) return false;
    const conflict = state.conflict;
    if (choice === 'use-server') {
      emit({
        phase: 'ready', workspace: conflict.workspace,
        serverRevision: conflict.revision, workspaceHash: conflict.workspaceHash,
        persisted: true, dirty: false, conflict: null, run: null, runRevision: null,
        message: `Restored server revision ${conflict.revision}. Current revision has not been run yet.`, errorCode: '',
      });
    } else {
      emit({
        phase: 'ready', serverRevision: conflict.revision,
        workspaceHash: conflict.workspaceHash, persisted: true,
        dirty: true, conflict: null, run: null, runRevision: null,
        message: `Kept local edits over server revision ${conflict.revision}. Save when ready.`,
        errorCode: '',
      });
    }
    return true;
  }

  function requestRun(options) {
    if (runPromise) return runPromise;
    runPromise = performRunRequest(options).finally(() => { runPromise = null; });
    return runPromise;
  }

  async function performRunRequest(options) {
    if ((state.dirty || !state.persisted) && !(await save(options))) return false;
    pendingRunRequestId ||= createRequestId();
    const runRequestId = pendingRunRequestId;
    const runRevision = state.serverRevision;
    let requestAttempt = 0;
    emit({ phase: 'requesting-run', message: 'Running...', errorCode: '', availability: null });
    while (requestAttempt < MAX_RUN_REQUEST_ATTEMPTS) {
      try {
        requestAttempt += 1;
        const run = normalizePythonRunDto(await client.requestPythonRun(
          attemptId, itemId, runRevision, runRequestId, options,
        ));
        pendingRunRequestId = '';
        emit({
          phase: 'ready', run, runRevision,
          message: `Execution state: ${formatState(run.state)}.`, errorCode: '',
        });
        return true;
      } catch (error) {
        if (wasAborted(options, error)) return false;
        if (error?.code === 'executor_disabled') {
          pendingRunRequestId = '';
          emit({
            phase: 'executor-disabled', run: null, runRevision: null,
            availability: Object.freeze({ code: 'executor_disabled' }),
            message: 'Python execution is not available yet. Your saved workspace is retained.',
            errorCode: 'executor_disabled',
          });
          return false;
        }
        if (isAmbiguousMutation(error)) {
          if (requestAttempt < MAX_RUN_REQUEST_ATTEMPTS) {
            emit({
              phase: 'requesting-run',
              message: 'Confirming the saved Run outcome...',
              errorCode: '',
            });
            continue;
          }
          emit({
            phase: 'error',
            message: RUN_OUTCOME_UNCONFIRMED_MESSAGE,
            errorCode: 'run_state_ambiguous',
          });
          return false;
        }
        pendingRunRequestId = '';
        emitFailure(error, 'The Python run could not be requested.');
        return false;
      }
    }
    return false;
  }

  async function refreshRun(options) {
    if (!state.run) return false;
    emit({ phase: 'loading-run', message: 'Refreshing execution status...', errorCode: '' });
    try {
      const run = normalizePythonRunDto(await client.getPythonRun(
        attemptId, itemId, state.run.runId, options,
      ));
      emit({ phase: 'ready', run, message: `Execution state: ${formatState(run.state)}.`, errorCode: '' });
      return true;
    } catch (error) {
      if (wasAborted(options, error)) return false;
      emitFailure(error, 'Execution status could not be refreshed.');
      return false;
    }
  }

  async function cancelRun(options) {
    if (!isPythonRunCancellable(state.run)) return false;
    pendingCancelRequestId ||= createRequestId();
    emit({ phase: 'cancelling-run', message: 'Requesting cancellation...', errorCode: '' });
    try {
      const run = normalizePythonRunDto(await client.cancelPythonRun(
        attemptId, itemId, state.run.runId, pendingCancelRequestId, options,
      ));
      pendingCancelRequestId = '';
      emit({ phase: 'ready', run, message: `Execution state: ${formatState(run.state)}.`, errorCode: '' });
      return true;
    } catch (error) {
      if (wasAborted(options, error)) return false;
      if (!isAmbiguousMutation(error)) pendingCancelRequestId = '';
      emitFailure(error, 'The Python run could not be cancelled.');
      return false;
    }
  }

  function emitFailure(error, fallbackMessage) {
    emit({
      phase: error?.code === 'unauthenticated' ? 'auth-error' : 'error',
      message: typeof error?.message === 'string' && error.message ? error.message : fallbackMessage,
      errorCode: typeof error?.code === 'string' ? error.code : 'internal_failure',
    });
  }

  return Object.freeze({
    cancelRun,
    flush: save,
    getPresentation: () => safePresentation,
    getSnapshot: () => state,
    load,
    refreshRun,
    requestRun,
    resolveConflict,
    save,
    updateFile,
  });
}

function normalizeWorkspaceReadDto(value, expectedItemId, allowedFilenames) {
  assertPlainObject(value, 'invalid_python_workspace_response');
  assertOnlyKeys(value, ['itemId', 'exists', 'revision', 'workspaceHash', 'workspace', 'updatedAt'], 'invalid_python_workspace_response');
  if (
    value.itemId !== expectedItemId || typeof value.exists !== 'boolean' ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    (value.workspaceHash !== null && !/^[0-9a-f]{64}$/.test(value.workspaceHash)) ||
    (value.updatedAt !== null && !isBoundedText(value.updatedAt, 1, 64))
  ) throw contractError('invalid_python_workspace_response');
  if (!value.exists) {
    if (value.revision !== 0 || value.workspaceHash !== null || value.workspace !== null) {
      throw contractError('invalid_python_workspace_response');
    }
    return Object.freeze({ ...value, workspace: null });
  }
  if (value.revision < 1 || !value.workspaceHash) throw contractError('invalid_python_workspace_response');
  return Object.freeze({ ...value, workspace: normalizePythonWorkspace(value.workspace, allowedFilenames) });
}

function normalizeWorkspaceSaveDto(value, expectedItemId, priorRevision) {
  assertPlainObject(value, 'invalid_python_workspace_save');
  assertOnlyKeys(value, ['itemId', 'revision', 'workspaceHash', 'updatedAt'], 'invalid_python_workspace_save');
  if (
    value.itemId !== expectedItemId || !Number.isSafeInteger(value.revision) ||
    value.revision <= priorRevision || !/^[0-9a-f]{64}$/.test(value.workspaceHash) ||
    !isBoundedText(value.updatedAt, 1, 64)
  ) throw contractError('invalid_python_workspace_save');
  return Object.freeze({ ...value });
}

function normalizeInstructions(value) {
  if (value === undefined || value === null) return [];
  const entries = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(entries) || entries.length > 20) throw contractError('invalid_python_lab_instructions');
  return entries.map((entry) => {
    if (!isBoundedText(entry, 1, 4_000)) throw contractError('invalid_python_lab_instructions');
    return entry;
  });
}

function normalizeAllowedFilenames(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_FILES) {
    throw contractError('invalid_python_lab_allowed_files');
  }
  const names = value.map((entry) => {
    if (!isSafePythonPath(entry)) throw contractError('invalid_python_lab_allowed_files');
    return entry;
  });
  if (new Set(names.map((entry) => entry.toLowerCase())).size !== names.length) {
    throw contractError('invalid_python_lab_allowed_files');
  }
  return names;
}

function firstBoundedText(values, maximumBytes) {
  return values.find((value) => isBoundedText(value, 1, maximumBytes)) ?? '';
}

function isBoundedText(value, minimumBytes, maximumBytes) {
  if (typeof value !== 'string') return false;
  const bytes = utf8Length(value);
  return bytes >= minimumBytes && bytes <= maximumBytes;
}

function isSafePythonPath(value) {
  if (!isBoundedText(value, 1, MAX_PATH_BYTES) || !PYTHON_PATH.test(value) || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[a-z]:/i.test(value) || value.includes('//') || value.includes('\0')) return false;
  return value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

function assertPlainObject(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw contractError(code);
  }
}

function assertOnlyKeys(value, allowedKeys, code) {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw contractError(code);
}

function contractError(code) {
  return Object.assign(new Error(code), { code });
}

function isAmbiguousMutation(error) {
  return error?.ambiguousTransport === true || Number(error?.httpStatus) >= 500 ||
    ['network_failure', 'request_timeout'].includes(error?.code);
}

function wasAborted(options, error) {
  return options?.signal?.aborted === true || error?.name === 'AbortError';
}

function formatState(value) {
  return String(value).replaceAll('_', ' ');
}
