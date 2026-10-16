const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string') return encoder.encode(value);
  throw new TypeError('Provider output must be text or bytes.');
}

function concatenate(chunks, size) {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function fitUtf8(value, maximumBytes) {
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= maximumBytes) {
    return { value, bytes: encoded.byteLength, truncated: false };
  }
  const accepted = [];
  let bytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maximumBytes) break;
    accepted.push(character);
    bytes += size;
  }
  return { value: accepted.join(''), bytes, truncated: true };
}

async function cancelQuietly(reader) {
  try {
    await reader.cancel('CERTSIM_OUTPUT_BOUND_REACHED');
  } catch {
    // Sandbox termination remains authoritative.
  }
}

export async function collectBoundedProcessOutput({
  stdout,
  stderr,
  maximumBytes,
  collectionTimeoutMs,
  onStop,
}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError('maximumBytes must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(collectionTimeoutMs) || collectionTimeoutMs < 1) {
    throw new TypeError('collectionTimeoutMs must be a positive safe integer.');
  }
  if (typeof onStop !== 'function') throw new TypeError('onStop must be a function.');

  const readers = { stdout: stdout.getReader(), stderr: stderr.getReader() };
  const chunks = { stdout: [], stderr: [] };
  const sizes = { stdout: 0, stderr: 0 };
  let remaining = maximumBytes;
  let stopReason = null;
  let stopPromise;

  function stop(reason) {
    if (stopReason !== null) return;
    stopReason = reason;
    stopPromise = Promise.resolve().then(() => onStop(reason));
    void cancelQuietly(readers.stdout);
    void cancelQuietly(readers.stderr);
  }

  async function consume(channel) {
    const reader = readers[channel];
    try {
      while (stopReason === null) {
        const { done, value } = await reader.read();
        if (done) return;
        const bytes = toBytes(value);
        const accepted = bytes.slice(0, remaining);
        if (accepted.byteLength > 0) {
          chunks[channel].push(accepted);
          sizes[channel] += accepted.byteLength;
          remaining -= accepted.byteLength;
        }
        if (accepted.byteLength !== bytes.byteLength) stop('output-limit');
      }
    } catch (error) {
      if (stopReason === null) throw error;
    }
  }

  const timeout = setTimeout(() => stop('collection-timeout'), collectionTimeoutMs);
  let settled;
  try {
    settled = await Promise.allSettled([consume('stdout'), consume('stderr')]);
    if (stopPromise) await stopPromise;
  } finally {
    clearTimeout(timeout);
  }
  const unexpected = settled.find((entry) => entry.status === 'rejected');
  if (unexpected && stopReason === null) throw unexpected.reason;

  const normalizedStdout = fitUtf8(
    decoder.decode(concatenate(chunks.stdout, sizes.stdout)),
    maximumBytes,
  );
  const normalizedStderr = fitUtf8(
    decoder.decode(concatenate(chunks.stderr, sizes.stderr)),
    maximumBytes - normalizedStdout.bytes,
  );
  return Object.freeze({
    stdout: normalizedStdout.value,
    stderr: normalizedStderr.value,
    outputBytes: normalizedStdout.bytes + normalizedStderr.bytes,
    maximumBytes,
    truncated: stopReason === 'output-limit'
      || normalizedStdout.truncated
      || normalizedStderr.truncated,
    collectionTimedOut: stopReason === 'collection-timeout',
  });
}
