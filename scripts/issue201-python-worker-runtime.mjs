import http from 'node:http';
import { createHandler } from '../supabase/functions/certsim-python-expiry-worker/worker.ts';

// Disposable Node24 HTTP adapter for the actual production handler. No RPC,
// verification or orchestration mocks. The deployed index uses Deno.serve.
const allowed = new Set(['127.0.0.1', 'localhost', '[::1]']);
let faultUsed = false;
let clockOffset = 0;
const guardedFetch = async (input, init) => {
  if (!allowed.has(new URL(String(input)).hostname)) throw Error('OUTBOUND_DENIED');
  const target = String(input), fault = process.env.SYNTHETIC_WORKER_FAULT;
  if (fault === 'renew_fail' && target.endsWith('certsim_service_python_worker_renew') && faultUsed) throw Error('SYNTHETIC_HEARTBEAT_FAILURE');
  if (fault === 'renew_fail' && target.endsWith('certsim_service_python_worker_renew')) faultUsed = true;
  const response = await fetch(input, init);
  if (target.includes('/rest/v1/rpc/')) {
    const value = await response.clone().json().catch(() => ({}));
    if (!response.ok || value.ok === false) {
      const identifier = String(value.message).match(/(?:column|record|relation|function) [a-zA-Z_\.\"()]+/g) ?? [];
      const safeCode = /^[A-Za-z0-9_]+$/.test(value.code) ? value.code : 'unknown';
      console.error('TEST_RPC_TRACE:' + JSON.stringify({ operation: target.split('/').at(-1), status: response.status, code: safeCode, identifier }));
    }
  }
  if (fault === 'stale_before_dispatch' && target.endsWith('certsim_service_python_worker_transport')) clockOffset = 31_000;
  if (!faultUsed && ((fault === 'receipt_ack_lost' && target.endsWith('certsim_service_python_worker_receipt'))
    || (fault === 'complete_ack_lost' && target.endsWith('certsim_service_complete_python_expiry')))) {
    await response.arrayBuffer(); faultUsed = true; throw Error('SYNTHETIC_ACK_LOST');
  }
  return response;
};
const handler = createHandler(name => process.env[name], guardedFetch, () => performance.now() + clockOffset);
http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const response = await handler(new Request(`http://127.0.0.1${req.url}`, {
      method: req.method, headers: req.headers,
      ...(body.length ? { body } : {}),
    }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch { res.writeHead(500); res.end('{}'); }
}).listen(0, '127.0.0.1', function () {
  process.send?.({ port: this.address().port });
});
