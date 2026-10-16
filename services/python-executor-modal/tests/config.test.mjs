import assert from 'node:assert/strict';
import test from 'node:test';
import { DisabledPythonExecutionProvider } from '../../python-executor/src/provider.mjs';
import {
  ModalIntegrationConfigError,
  ModalPythonExecutionProvider,
  createConfiguredPythonExecutionProvider,
  formatSafeModalDiagnostic,
  readServerModalCredentials,
} from '../src/index.mjs';

test('the integration is hard-disabled unless the exact server flag is present', async () => {
  let clientFactoryCalls = 0;
  for (const value of [undefined, '', 'true', 'yes', 'NO']) {
    const provider = await createConfiguredPythonExecutionProvider({
      env: value === undefined ? {} : { CERTSIM_PYTHON_EXECUTION_ENABLED: value },
      clientFactory: async () => { clientFactoryCalls += 1; },
    });
    assert.ok(provider instanceof DisabledPythonExecutionProvider);
    await assert.rejects(() => provider.execute({}), { code: 'EXECUTOR_DISABLED' });
  }
  assert.equal(clientFactoryCalls, 0);
});

test('enabled configuration passes a complete token pair directly to the client factory', async () => {
  const expected = { tokenId: 'synthetic-token-id', tokenSecret: 'synthetic-token-secret' };
  let received;
  const client = {
    apps: { fromName() {} },
    images: { fromRegistry() {} },
    sandboxes: { create() {} },
  };
  const provider = await createConfiguredPythonExecutionProvider({
    env: { CERTSIM_PYTHON_EXECUTION_ENABLED: 'YES', MODAL_TOKEN_ID: expected.tokenId, MODAL_TOKEN_SECRET: expected.tokenSecret },
    clientFactory: async (credentials) => { received = credentials; return client; },
  });
  assert.ok(provider instanceof ModalPythonExecutionProvider);
  assert.deepEqual(received, expected);
});

test('server credentials fail closed when absent or partial', () => {
  for (const env of [{}, { MODAL_TOKEN_ID: 'only-id' }, { MODAL_TOKEN_SECRET: 'only-secret' }]) {
    assert.throws(() => readServerModalCredentials(env), (error) => (
      error instanceof ModalIntegrationConfigError
      && ['MODAL_CREDENTIALS_REQUIRED', 'MODAL_CREDENTIALS_INCOMPLETE'].includes(error.code)
    ));
  }
});

test('default diagnostic formatting emits only bounded server-side terminal facts', () => {
  const executionId = 'execution.00000000-0000-4000-8000-000000000086';
  assert.equal(formatSafeModalDiagnostic({
    event: 'python_execution_terminal',
    executionId,
    category: 'learner_nonzero_exit',
    status: 'finished',
    outcome: 'failed',
    elapsedMs: 42,
    disposed: true,
    exitCode: 1,
    stdout: 'must not appear',
    stderr: 'must not appear',
    source: 'must not appear',
    secret: 'must not appear',
  }), `python_execution_terminal:${executionId}:learner_nonzero_exit:finished:failed:42:disposed:exit_1`);
  assert.equal(formatSafeModalDiagnostic({
    event: 'python_execution_setup_failed',
    executionId,
    category: 'provider_setup_failed',
    stage: 'sandbox_exec',
    upstreamCode: 'SYNTHETIC_FAILURE',
  }), `python_execution_setup_failed:${executionId}:provider_setup_failed:sandbox_exec:SYNTHETIC_FAILURE`);
  assert.equal(formatSafeModalDiagnostic({
    event: 'python_execution_terminal',
    executionId,
    category: 'learner_nonzero_exit',
    status: 'finished',
    outcome: 'failed',
    elapsedMs: 42,
    disposed: true,
    operationCode: 'unsafe detail with spaces',
  }).includes('unsafe detail'), false);
  assert.equal(formatSafeModalDiagnostic({ event: 'other', secret: 'not-logged' }), null);
});
