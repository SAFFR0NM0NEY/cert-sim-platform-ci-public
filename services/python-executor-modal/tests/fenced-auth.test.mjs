import test from 'node:test';
import assert from 'node:assert/strict';
import {signFenceAuthority,verifyFenceAuthority,readFenceSecret,FENCE_PROTOCOL} from '../../../supabase/functions/_shared/python-fence-auth.mjs';
import {createSignedExecutionEnvelope,verifySignedExecutionEnvelope} from '../../python-executor/src/contract.mjs';
import {gradeFencedModalBridgePayload,recoverFencedModalBridgePayload} from '../src/fenced-service.mjs';
const secret='test-only-expiry-secret-00000000000000000000000',legacy='test-only-legacy-secret-11111111111111111111111';
test('expiry authority authenticates protocol, purpose, binding and epoch',async()=>{
 const value={fence:{protocol:FENCE_PROTOCOL,dispatchId:'opaque',epoch:'1',requestDigest:'a'.repeat(64)}};
 const auth=await signFenceAuthority(value,'grade',secret);
 assert.equal(await verifyFenceAuthority(value,'grade',auth,secret),true);
 for(const changed of [{...value,fence:{...value.fence,epoch:'2'}},{...value,fence:{...value.fence,requestDigest:'b'.repeat(64)}}])
  assert.equal(await verifyFenceAuthority(changed,'grade',auth,secret),false);
 assert.equal(await verifyFenceAuthority(value,'recover',auth,secret),false);
 assert.equal(await verifyFenceAuthority(value,'grade',auth,legacy),false);
});
test('stripping fenced routing cannot authenticate with the legacy execution key',()=>{
 const request={contractVersion:'certsim.python-execution.request.v1',requestId:'request.20100000-0000-4000-8000-000000000001',runtime:{language:'python',contract:'python-source-v1'},workspace:{entryPoint:'main.py',files:[{path:'main.py',content:'pass'}]},limits:{wallTimeMs:20000,memoryBytes:134217728,outputBytes:1048576}};
 const envelope=createSignedExecutionEnvelope(request,secret);
 assert.equal(verifySignedExecutionEnvelope(request,envelope,legacy),false);
 assert.equal(verifySignedExecutionEnvelope(request,envelope,secret),true);
});
test('missing version, key reuse and default-disabled routes fail before network/provider',async()=>{
 for(const config of [{},{CERTSIM_EXPIRY_V1_SIGNING_SECRET:secret},{CERTSIM_EXPIRY_V1_SIGNING_SECRET:secret,CERTSIM_PYTHON_FENCE_PROTOCOL:FENCE_PROTOCOL,CERTSIM_EXECUTION_SIGNING_SECRET:secret}])
  assert.throws(()=>readFenceSecret(n=>config[n]));
 let calls=0;const blocked=()=>{calls++;throw Error('NO_NETWORK');};
 await assert.rejects(()=>gradeFencedModalBridgePayload({},{env:{},providerFactory:blocked,fetcher:blocked}));
 await assert.rejects(()=>recoverFencedModalBridgePayload({},{env:{},clientFactory:blocked,fetcher:blocked}));
 assert.equal(calls,0);
});

import {confirmModalSandboxTermination} from '../src/provider.mjs';
test('fenced disposal requires terminal poll, not a termination acknowledgment',async()=>{
 let polls=0;
 await confirmModalSandboxTermination({async terminate(){},async poll(){polls++;return 0;}});
 assert.equal(polls,1);
 await assert.rejects(()=>confirmModalSandboxTermination({async terminate(){},async poll(){return null;}}));
});
test('fenced SDK cleanup is bounded and cannot poll after its termination wait times out',async()=>{
 let polls=0;
 // A stalled SDK HTTP call keeps a real host alive; this synthetic promise
 // has no handle. Model that liveness under Node 22's unref abort timers.
 const active=setInterval(()=>{},1000);
 try{
  await assert.rejects(()=>confirmModalSandboxTermination({async terminate(){await new Promise(()=>{});},async poll(){polls++;return 0;}},20));
  assert.equal(polls,0);
 }finally{clearInterval(active);}
});

import {createProviderFence} from '../src/fencing.mjs';
test('cancelled SDK creation only settles its immutable ID and disposal',async()=>{
 const controller=new AbortController(),calls=[];
 const store={async step(f,operation){calls.push(operation);return {ok:true,allowed:false};}};
 const fence=createProviderFence(store,{primaryId:'one',probeId:'two'},'runner',{signal:controller.signal,cleanupSignal:AbortSignal.timeout(5000)});
 let settle;const pending=fence.wait(()=>new Promise(resolve=>settle=resolve),s=>fence.lateCreated({leg:'primary'},s));
 await new Promise(resolve=>setImmediate(resolve));controller.abort();
 await assert.rejects(()=>pending);
 settle({sandboxId:'sb-late',async terminate(){calls.push('terminate');},async poll(){calls.push('poll');return 0;},detach(){}});
 for(let n=0;n<10&&!calls.includes('disposed');n++)await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(calls,['created','terminate','poll','disposed']);
});

import {mkdtempSync,cpSync,writeFileSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
test('existing bridge package starts without v2 shared authority and keeps v2 unavailable',()=>{
 const parent=resolve(import.meta.dirname,'../node_modules'),directory=mkdtempSync(join(parent,'certsim-legacy-'));
 try{
  for(const name of ['python-executor','python-grading','python-executor-modal']){
   cpSync(resolve(import.meta.dirname,'../../'+name+'/src'),join(directory,'services',name,'src'),{recursive:true});
   if(name==='python-executor-modal')cpSync(resolve(import.meta.dirname,'../../'+name+'/package.json'),join(directory,'services',name,'package.json'));
  }
  const script="import assert from 'node:assert/strict';import{createModalBridgeServer}from'./services/python-executor-modal/src/server.mjs';const s=createModalBridgeServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));try{const u='http://127.0.0.1:'+s.address().port;assert.equal((await fetch(u+'/health')).status,200);assert.equal((await fetch(u+'/v1/grade',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,400);assert.equal((await fetch(u+'/v2/expiry-grade',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,503);}finally{s.closeAllConnections();await new Promise(r=>s.close(r));}";
  writeFileSync(join(directory,'smoke.mjs'),script);
  execFileSync(process.execPath,[join(directory,'smoke.mjs')],{cwd:directory,env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot},timeout:15000,windowsHide:true,stdio:'pipe'});
 }finally{
  assert.equal(directory.startsWith(join(parent,'certsim-legacy-')),true);
  rmSync(directory,{recursive:true,force:true});
 }
});

test('immutable-ID NotFound alone is still not terminal disposal proof',async()=>{
 const missing=()=>{const error=Error('synthetic');error.name='NotFoundError';throw error;};
 await assert.rejects(()=>confirmModalSandboxTermination({terminate:missing,poll:missing}));
 await confirmModalSandboxTermination({terminate:missing,async poll(){return 0;}});
});
