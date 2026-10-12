const bridgeUrl = Deno.env.get('CERTSIM_MODAL_BRIDGE_URL');
const proxyKey = Deno.env.get('CERTSIM_MODAL_PROXY_KEY');
const proxySecret = Deno.env.get('CERTSIM_MODAL_PROXY_SECRET');

if (!bridgeUrl || !proxyKey || !proxySecret) throw new Error('LIVE_CLIENT_CONFIGURATION_REQUIRED');

const body = await new Response(Deno.stdin.readable).text();
const response = await fetch(`${bridgeUrl.replace(/\/$/, '')}/v1/execute`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'Modal-Key': proxyKey,
    'Modal-Secret': proxySecret,
  },
  body,
});

const responseBody = await response.text();
if (!response.ok) throw new Error(`LIVE_CLIENT_HTTP_${response.status}`);
JSON.parse(responseBody);
await Deno.stdout.write(new TextEncoder().encode(responseBody));
