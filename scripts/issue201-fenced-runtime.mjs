// Disposable adapter: real service/provider/fence and worker code.
// Only the external Modal SDK substrate is simulated over loopback HTTP.
import http from 'node:http';
import {createModalBridgeServer} from '../services/python-executor-modal/src/server.mjs';
import {gradeFencedModalBridgePayload,recoverFencedModalBridgePayload} from '../services/python-executor-modal/src/fenced-service.mjs';
import {ModalPythonExecutionProvider} from '../services/python-executor-modal/src/provider.mjs';
import {gradeModalBridgePayload,executeModalBridgePayload,cancelModalBridgePayload} from '../services/python-executor-modal/src/service.mjs';
import {createHandler} from '../supabase/functions/certsim-python-expiry-worker/worker.ts';
const nativeFetch=fetch;
const allowed=new Set(['127.0.0.1','localhost','[::1]']);
const guarded=async(input,init={})=>{
 if(!allowed.has(new URL(String(input)).hostname))throw Error('OUTBOUND_DENIED');
 return nativeFetch(input,{...init,redirect:'error'});
};
globalThis.fetch=guarded;
const substrate=process.env.SYNTHETIC_MODAL_URL;
async function remote(path,args={}) {
 const r=await guarded(substrate+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args),signal:AbortSignal.timeout(25000)});
 const body=await r.json();
 if(!r.ok){const e=Error('SYNTHETIC_SUBSTRATE');e.name=body.name??'Error';throw e;}
 return body;
}
function bytes(text){return new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(text));c.close();}});}
function sandbox(id){
 return {sandboxId:id,async exec(command,options){
  await remote('/exec',{id,command,options});
  let workspace;
  return {stdin:{async writeText(text){workspace=JSON.parse(text);await remote('/stdin',{id,workspace});},async close(){}},
   get stdout(){return new ReadableStream({async start(c){try{const v=await remote('/output',{id});c.enqueue(new TextEncoder().encode(v.stdout));c.close();}catch(e){c.error(e);}}});},
   get stderr(){return new ReadableStream({async start(c){try{const v=await remote('/output',{id});c.enqueue(new TextEncoder().encode(v.stderr));c.close();}catch(e){c.error(e);}}});},
   async wait(){await remote('/wait',{id});return 0;}};
 },async terminate(options){return (await remote('/terminate',{id,options})).exitCode;},
 async poll(){return (await remote('/poll',{id})).exitCode;},detach(){}};
}
function client(){
 return {apps:{async fromName(){return {appId:'synthetic-app'};}},images:{fromRegistry(){return {imageId:'synthetic-image'};}},
  sandboxes:{async create(app,image,params){return sandbox((await remote('/create',{params})).id);},async fromId(id){return sandbox(id);}},close(){}};
}
const env=process.env;
let faultUsed=false;
async function fenceFetch(input,init) {
 const operation=String(input).includes('python_fence_step')?JSON.parse(init.body).p_operation:'';
 if(env.SYNTHETIC_FAULT==='store_outage')throw Error('SYNTHETIC_STORE_OUTAGE');
 if(env.SYNTHETIC_FAULT==='delay_admission'&&operation==='admit')await remote('/barrier',{name:'admission'});
 if(!faultUsed&&env.SYNTHETIC_FAULT==='pause_receipt'&&operation==='receipt'){faultUsed=true;await remote('/barrier',{name:'receipt'});}
 const response=await guarded(input,init);
 if(!response.ok){const body=await response.clone().json().catch(()=>({}));process.send?.({type:'rpc_error',code:body.code??'unknown'});}
 if(!faultUsed&&((env.SYNTHETIC_FAULT==='pause_intent'&&operation==='intent')||(env.SYNTHETIC_FAULT==='pause_admitted'&&operation==='admit')||(env.SYNTHETIC_FAULT==='pause_seal'&&operation==='seal')||(env.SYNTHETIC_FAULT==='pause_created'&&operation==='created'))) {
  faultUsed=true;await remote('/barrier',{name:operation});
 }
 if(!faultUsed&&((env.SYNTHETIC_FAULT==='receipt_ack_lost'&&operation==='receipt')||(env.SYNTHETIC_FAULT==='release_ack_lost'&&operation==='release'))) {
  faultUsed=true;await response.arrayBuffer();throw Error('SYNTHETIC_ACK_LOST');
 }
 return response;
}
let server;
if(env.SYNTHETIC_MODE==='bridge') {
 server=createModalBridgeServer({
  grade:(payload,options)=>gradeModalBridgePayload(payload,{...options,env,providerFactory:async()=>new ModalPythonExecutionProvider({client:client()})}),
  execute:(payload,options)=>executeModalBridgePayload(payload,{...options,env,providerFactory:async()=>new ModalPythonExecutionProvider({client:client()})}),
  cancel:(payload,options)=>cancelModalBridgePayload(payload,{...options,env,clientFactory:async()=>client()}),
  fencedGrade:async(payload,options)=>{
   process.send?.({type:'grade_payload',payload});
   return gradeFencedModalBridgePayload(payload,{...options,env,fetcher:fenceFetch,
    providerFactory:async({fence})=>new ModalPythonExecutionProvider({client:client(),fence})});
  },
  recover:async(payload,options)=>{process.send?.({type:'recovery_payload',payload});return recoverFencedModalBridgePayload(payload,{...options,env,fetcher:fenceFetch,clientFactory:async()=>client()});}
 });
}else{
 const handler=createHandler(n=>env[n],guarded);
 server=http.createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
  const response=await handler(new Request('http://127.0.0.1'+req.url,{method:req.method,headers:req.headers,...(body.length?{body}: {})}));
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 });
}
server.listen(0,'127.0.0.1',()=>process.send?.({type:'ready',port:server.address().port}));
