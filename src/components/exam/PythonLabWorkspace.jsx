import { useEffect, useMemo, useState } from 'react';
import {
  createPythonLabWorkspaceController,
  isPythonRunCancellable,
} from '../../lib/pythonLabWorkspace.js';

const BUSY_PHASES = new Set([
  'loading', 'saving', 'requesting-run', 'loading-run', 'cancelling-run',
]);

export default function PythonLabWorkspace({
  attemptId,
  client,
  disabled = false,
  itemId,
  onBusyChange,
  onRegisterSave,
  onWorkspaceStateChange,
  presentation,
}) {
  const [snapshot, setSnapshot] = useState(null);
  const controller = useMemo(() => createPythonLabWorkspaceController({
    attemptId,
    client,
    itemId,
    onChange: setSnapshot,
    presentation,
  }), [attemptId, client, itemId, presentation]);
  const safePresentation = controller.getPresentation();
  const current = snapshot ?? controller.getSnapshot();
  const [activePath, setActivePath] = useState(current.workspace.files[0]?.path ?? '');
  const activeFile = current.workspace.files.find((file) => file.path === activePath)
    ?? current.workspace.files[0];
  const busy = BUSY_PHASES.has(current.phase);

  useEffect(() => {
    const abortController = new AbortController();
    controller.load({ signal: abortController.signal });
    return () => abortController.abort();
  }, [controller]);

  useEffect(() => {
    if (!current.workspace.files.some((file) => file.path === activePath)) {
      setActivePath(current.workspace.files[0]?.path ?? '');
    }
  }, [activePath, current.workspace]);

  useEffect(() => {
    onRegisterSave?.(itemId, controller.flush);
    return () => onRegisterSave?.(itemId, null);
  }, [controller, itemId, onRegisterSave]);

  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  useEffect(() => {
    onWorkspaceStateChange?.(itemId, {
      dirty: current.dirty,
      persisted: current.persisted,
      revision: current.serverRevision,
    });
  }, [current.dirty, current.persisted, current.serverRevision, itemId, onWorkspaceStateChange]);

  const controlsDisabled = disabled || busy || current.phase === 'auth-error';

  return (
    <article className="question-card python-lab-workspace" aria-labelledby={`${itemId}-python-task`}>
      <div className="python-lab-heading">
        <div>
          <p className="eyebrow">Executable Python lab</p>
          <h3 id={`${itemId}-python-task`}>{safePresentation.task}</h3>
        </div>
        <span className={current.dirty ? 'python-save-state unsaved' : 'python-save-state'} role="status">
          {current.persisted ? `Revision ${current.serverRevision}` : 'Not yet saved'}
          {current.dirty ? ' · Unsaved changes' : ''}
        </span>
      </div>

      {safePresentation.instructions.length > 0 && (
        <section className="python-lab-instructions" aria-label="Lab instructions">
          <h4>Instructions</h4>
          <ol>{safePresentation.instructions.map((instruction, index) => <li key={`${index}-${instruction}`}>{instruction}</li>)}</ol>
        </section>
      )}

      <div className="python-editor-layout">
        <nav className="python-file-list" aria-label="Python workspace files">
          <p><strong>Files</strong></p>
          {current.workspace.files.map((file) => (
            <button
              aria-pressed={file.path === activeFile?.path}
              className={file.path === activeFile?.path ? 'python-file active' : 'python-file'}
              disabled={controlsDisabled}
              key={file.path}
              onClick={() => setActivePath(file.path)}
              type="button"
            >
              {file.path}{file.path === current.workspace.entryPoint ? ' · entry' : ''}
            </button>
          ))}
        </nav>
        <div className="python-editor-pane">
          <label htmlFor={`${itemId}-python-editor`}>
            Python source · {activeFile?.path ?? current.workspace.entryPoint}
          </label>
          <textarea
            aria-describedby={`${itemId}-python-editor-help`}
            autoCapitalize="off"
            autoCorrect="off"
            disabled={controlsDisabled || Boolean(current.conflict)}
            id={`${itemId}-python-editor`}
            maxLength={64 * 1024}
            onChange={(event) => controller.updateFile(activeFile.path, event.target.value)}
            rows={20}
            spellCheck="false"
            value={activeFile?.content ?? ''}
          />
          <p className="answer-helper" id={`${itemId}-python-editor-help`}>
            Source is saved separately from ordinary question responses. Run always uses the saved revision.
          </p>
        </div>
      </div>

      {current.conflict && (
        <section className="python-revision-conflict" role="alert" aria-labelledby={`${itemId}-conflict-heading`}>
          <h4 id={`${itemId}-conflict-heading`}>A newer saved revision is available</h4>
          <p>Your local edits have not been overwritten. Choose the server copy, or keep your edits and save them against the latest revision.</p>
          <div className="exam-actions">
            <button className="secondary-button" type="button" onClick={() => controller.resolveConflict('use-server')}>Use server version</button>
            <button className="primary-button" type="button" onClick={() => controller.resolveConflict('keep-local')}>Keep my edits</button>
          </div>
        </section>
      )}

      <div className="exam-actions python-lab-actions">
        <button
          className="secondary-button"
          disabled={controlsDisabled || Boolean(current.conflict)}
          onClick={() => controller.save()}
          type="button"
        >
          {current.phase === 'saving' ? 'Saving...' : 'Save code'}
        </button>
        <button
          className="primary-button"
          disabled={controlsDisabled || Boolean(current.conflict) || isPythonRunCancellable(current.run)}
          onClick={() => controller.requestRun()}
          type="button"
        >
          {current.phase === 'requesting-run' ? 'Running...' : 'Run'}
        </button>
        {current.run && (
          <button className="secondary-button" disabled={controlsDisabled} onClick={() => controller.refreshRun()} type="button">
            Refresh status
          </button>
        )}
        {isPythonRunCancellable(current.run) && (
          <button className="secondary-button danger-lite" disabled={controlsDisabled} onClick={() => controller.cancelRun()} type="button">
            {current.phase === 'cancelling-run' ? 'Cancelling...' : 'Cancel run'}
          </button>
        )}
      </div>

      <section className="python-run-status" aria-label="Execution status and result" aria-live="polite">
        <h4>Execution status</h4>
        <p className={current.phase === 'error' || current.phase === 'auth-error' ? 'error-note' : 'status-note'}>
          {current.message}
        </p>
        {current.run ? (
          <>
            <dl className="profile-facts compact">
              <div><dt>State</dt><dd>{formatRunValue(current.run.state)}</dd></div>
              <div><dt>Outcome</dt><dd>{current.run.terminalOutcome ? formatRunValue(current.run.terminalOutcome) : 'Pending'}</dd></div>
              <div><dt>Exit code</dt><dd>{current.run.exitCode ?? 'Not available'}</dd></div>
              <div><dt>Disposal</dt><dd>{formatRunValue(current.run.disposalState)}</dd></div>
            </dl>
            <div className="python-console" aria-label="Program output">
              <h5>Program output</h5>
              <p className="python-console-label">stdout</p>
              <pre>{current.run.stdout || '(no output)'}</pre>
              {current.run.stderr && (
                <>
                  <p className="python-console-label">stderr</p>
                  <pre className="python-console-stderr">{current.run.stderr}</pre>
                </>
              )}
            </div>
          </>
        ) : (
          <p>No execution result is available.</p>
        )}
      </section>
    </article>
  );
}

function formatRunValue(value) {
  return String(value ?? '').replaceAll('_', ' ');
}
