// Test-only loader. Package mode never imports runtime modules from checkout.
const root=Deno.env.get('CERTSIM_TEST_PACKAGE_ROOT');
const worker=root?new URL('file://'+(root.startsWith('/')?'':'/')+root.replaceAll('\\','/')+'/supabase/functions/certsim-python-expiry-worker/worker.ts'):new URL('../supabase/functions/certsim-python-expiry-worker/worker.ts',import.meta.url);
const {createHandler}=await import(worker.href);
Deno.serve({hostname:'127.0.0.1',port:0,onListen:({port})=>console.log(JSON.stringify({type:'ready',port}))},
 createHandler((n:string)=>Deno.env.get(n)));
