const SAFE_PROVIDER_MESSAGES = Object.freeze({
  EXECUTOR_DISABLED: 'Python execution is disabled.',
  PROVIDER_METHOD_NOT_IMPLEMENTED: 'The provider method is not implemented.',
  PROVIDER_SHAPE_INVALID: 'The provider does not implement the required contract.',
});

const REQUIRED_METHODS = ['execute', 'getStatus', 'cancel', 'dispose'];

export class PythonExecutionProviderError extends Error {
  constructor(code) {
    super(SAFE_PROVIDER_MESSAGES[code] ?? 'The Python execution provider rejected the operation.');
    this.name = 'PythonExecutionProviderError';
    this.code = code;
  }
}

function reject(code) {
  throw new PythonExecutionProviderError(code);
}

export class PythonExecutionProvider {
  async execute(_request) {
    reject('PROVIDER_METHOD_NOT_IMPLEMENTED');
  }

  async getStatus(_executionId) {
    reject('PROVIDER_METHOD_NOT_IMPLEMENTED');
  }

  async cancel(_executionId) {
    reject('PROVIDER_METHOD_NOT_IMPLEMENTED');
  }

  async dispose(_executionId) {
    reject('PROVIDER_METHOD_NOT_IMPLEMENTED');
  }
}

export class DisabledPythonExecutionProvider extends PythonExecutionProvider {
  async execute() {
    reject('EXECUTOR_DISABLED');
  }

  async getStatus() {
    reject('EXECUTOR_DISABLED');
  }

  async cancel() {
    reject('EXECUTOR_DISABLED');
  }

  async dispose() {
    reject('EXECUTOR_DISABLED');
  }
}

export function assertPythonExecutionProvider(provider) {
  if (
    provider === null
    || (typeof provider !== 'object' && typeof provider !== 'function')
    || REQUIRED_METHODS.some((method) => typeof provider[method] !== 'function')
  ) {
    reject('PROVIDER_SHAPE_INVALID');
  }
  return provider;
}

export function createDefaultPythonExecutionProvider() {
  return new DisabledPythonExecutionProvider();
}
