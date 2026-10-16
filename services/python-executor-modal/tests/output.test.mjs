import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBoundedProcessOutput } from '../src/output.mjs';

const encoder = new TextEncoder();

function readable(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test('combined stdout and stderr are bounded while streaming', async () => {
  const reasons = [];
  const result = await collectBoundedProcessOutput({
    stdout: readable(['abcd', 'efgh']),
    stderr: readable(['1234', '5678']),
    maximumBytes: 10,
    collectionTimeoutMs: 1_000,
    onStop: async (reason) => reasons.push(reason),
  });
  assert.equal(result.outputBytes, 10);
  assert.equal(result.truncated, true);
  assert.deepEqual(reasons, ['output-limit']);
});

test('invalid UTF-8 replacement cannot expand normalized output past the byte ceiling', async () => {
  const result = await collectBoundedProcessOutput({
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff, 0xff, 0xff]));
        controller.close();
      },
    }),
    stderr: readable([]),
    maximumBytes: 3,
    collectionTimeoutMs: 1_000,
    onStop: async () => {},
  });
  assert.ok(new TextEncoder().encode(result.stdout + result.stderr).byteLength <= 3);
  assert.equal(result.truncated, true);
});
