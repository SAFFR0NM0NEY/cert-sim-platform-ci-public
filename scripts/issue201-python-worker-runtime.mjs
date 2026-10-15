import http from 'node:http';
import { createHandler } from '../supabase/functions/certsim-python-expiry-worker/worker.ts';

// Disposable Node24 HTTP adapter for the actual production handler. No RPC,
// verification or orchestration mocks. The deployed index uses Deno.serve.
const allowed = new Set(['127.0.0.1', 'localhost', '[::1]']);
const guardedFetch = (input, init) => {
  if (!allowed.has(new URL(String(input)).hostname)) throw Error('OUTBOUND_DENIED');
  return fetch(input, init);
};
const handler = createHandler(name => process.env[name], guardedFetch);
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
