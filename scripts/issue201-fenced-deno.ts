import {createHandler} from '../supabase/functions/certsim-python-expiry-worker/worker.ts';
Deno.serve({hostname:'127.0.0.1',port:0,onListen:({port})=>console.log(JSON.stringify({type:'ready',port}))},
 createHandler(n=>Deno.env.get(n)));
