import http from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cancelModalBridgePayload,
  executeModalBridgePayload,
  gradeModalBridgePayload,
  ModalBridgeRequestError,
} from './service.mjs';

import { gradeFencedModalBridgePayload, recoverFencedModalBridgePayload } from './fenced-service.mjs';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const PORT = Number(process.env.PORT ?? '8000');

function send(response, status, body) {
  if (response.headersSent || response.writableEnded) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

async function readJson(request) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new ModalBridgeRequestError('invalid_request');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new ModalBridgeRequestError('invalid_request', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw new ModalBridgeRequestError('invalid_request');
  }
}

export function createModalBridgeServer({
  cancel = cancelModalBridgePayload,
  execute = executeModalBridgePayload,
  grade = gradeModalBridgePayload,
  fencedGrade = gradeFencedModalBridgePayload,
  recover = recoverFencedModalBridgePayload,
} = {}) {
  return http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      send(response, 200, { ok: true, nodeMajor: Number(process.versions.node.split('.')[0]) });
      return;
    }
    if (request.method !== 'POST' || !['/v1/execute', '/v1/cancel', '/v1/grade', '/v2/expiry-grade', '/v2/expiry-recover'].includes(request.url)) {
      send(response, 404, { ok: false, code: 'not_found' });
      return;
    }
    const abortController = new AbortController();
    const abort = () => {
      if (!response.writableEnded) abortController.abort();
    };
    request.once('aborted', abort);
    response.once('close', abort);
    try {
      const handler = request.url === '/v2/expiry-grade' ? fencedGrade : request.url === '/v2/expiry-recover' ? recover
        : request.url === '/v1/cancel' ? cancel : request.url === '/v1/grade' ? grade : execute;
      const result = await handler(await readJson(request), { signal: abortController.signal });
      send(response, 200, { ok: true, ...result });
    } catch (error) {
      const safe = error instanceof ModalBridgeRequestError
        ? error
        : new ModalBridgeRequestError('execution_failed', 503);
      send(response, safe.status, { ok: false, code: safe.code });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65_535) {
    throw new Error('Invalid bridge port.');
  }
  const server = createModalBridgeServer();
  server.listen(PORT, '0.0.0.0');
  const shutdown = () => server.close();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
