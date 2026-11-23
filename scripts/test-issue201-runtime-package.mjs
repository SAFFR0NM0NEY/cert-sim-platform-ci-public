import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,cpSync,writeFileSync,unlinkSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import net from 'node:net';
import {spawn,execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {validateLayout,verifyPackage} from './issue201-runtime-package.mjs';
const root=resolve(process.env.CERTSIM_TEST_PACKAGE_ROOT);
const report=JSON.parse(readFileSync(process.env.CERTSIM_TEST_PACKAGE_REPORT,'utf8'));
const legacy=JSON.parse(readFileSync(process.env.CERTSIM_TEST_LEGACY_REPORT,'utf8'));
assert.equal(Number(process.versions.node.split('.')[0]),22,'acceptance requires real Node22');
verifyPackage(root,report.inventorySha256);verifyPackage(legacy.root,legacy.inventorySha256);
const legacyMetadata=JSON.parse(readFileSync(join(legacy.root,'RUNTIME_INVENTORY.json')));
assert.equal(legacyMetadata.budgets.hostSeconds,60);
assert.equal(legacyMetadata.runtime.modalPythonDeploymentSdk,null);
const layout=JSON.parse(readFileSync(join(root,'services/python-executor-modal/runtime-profile.json')));
assert.throws(()=>validateLayout({...layout,budgets:{...layout.budgets,hostSeconds:60}}));
assert.throws(()=>validateLayout({...layout,budgets:{...layout.budgets,gradeMs:91000}}));
assert.throws(()=>validateLayout({...layout,gateDefaults:{...layout.gateDefaults,CERTSIM_PYTHON_EXPIRY_RECOVERY_ENABLED:'true'}}));
const secret=()=>randomBytes(32).toString('hex');
const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,
 CERTSIM_PYTHON_EXECUTION_ENABLED:'YES',CERTSIM_PYTHON_GRADING_ENABLED:'YES',
 CERTSIM_EXECUTION_SIGNING_SECRET:secret(),CERTSIM_GRADING_SIGNING_SECRET:secret(),
 CERTSIM_EXPIRY_V1_SIGNING_SECRET:secret(),CERTSIM_PYTHON_FENCE_PROTOCOL:'certsim.python-expiry.fence.v1',
 CERTSIM_FENCE_STORE_URL:'http://127.0.0.1:1',CERTSIM_FENCE_STORE_SERVICE_KEY:secret(),
 MODAL_TOKEN_ID:secret(),MODAL_TOKEN_SECRET:secret(),PORT:'18881'};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function server(packageRoot,file,config,run) {
 const p=spawn(process.execPath,[join(packageRoot,'services/python-executor-modal/src',file)],{env:config,stdio:['ignore','pipe','pipe'],cwd:packageRoot});
 let diagnostic='';p.stderr.on('data',b=>diagnostic+=b);p.stdout.resume();
 try{
  let ready=false;for(let n=0;n<100;n++){if(p.exitCode!==null)throw Error('PACKAGED_START_FAILED');try{const r=await fetch('http://127.0.0.1:'+config.PORT+'/health');if(r.ok){assert.equal((await r.json()).nodeMajor,22);ready=true;break;}}catch{}await pause(50);}
  assert.equal(ready,true,'packaged server ready');await run('http://127.0.0.1:'+config.PORT);
 }finally{p.kill();await new Promise(r=>p.exitCode!==null?r():p.once('exit',r));}
}
const post=(u,b)=>fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b),signal:AbortSignal.timeout(5000)});
await server(legacy.root,'server.mjs',{PATH:env.PATH,PORT:'18881'},async url=>{
 assert.equal((await post(url+'/v1/grade',{})).status,400);
 assert.equal((await post(url+'/v2/expiry-grade',{})).status,503);
});
await server(root,'fenced-start.mjs',env,async url=>{
 assert.equal((await post(url+'/v2/expiry-grade',{request:{},envelope:{},binding:{},gradingMaterial:{},fence:{},auth:{}})).status,503);
 assert.equal((await post(url+'/v2/expiry-recover',{recovery:{fence:{},token:'x'},auth:{}})).status,503);
 // Node22 checks incoming-request deadlines on a timer. The fenced profile uses
 // a1s sweep, so a15s incomplete body cannot inherit Node's default30s sweep.
 const started=performance.now(),socket=net.createConnection({host:'127.0.0.1',port:18881});
 let response='';socket.on('data',b=>response+=b);
 let timer;
 try{
  await new Promise((done,reject)=>{
   timer=setTimeout(()=>reject(Error('PACKAGED_HTTP_BODY_DEADLINE')),19000);
   socket.on('error',reject);socket.on('close',done);
   socket.once('connect',()=>socket.write('POST /v2/expiry-grade HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{'));
  });
  assert.match(response,/408/);assert.ok(performance.now()-started>=14000&&performance.now()-started<19000);
 }finally{clearTimeout(timer);socket.destroy();}

});
for(const change of [
 {CERTSIM_PYTHON_FENCE_PROTOCOL:''},{CERTSIM_PYTHON_FENCE_PROTOCOL:'unknown'},
 {CERTSIM_EXPIRY_V1_SIGNING_SECRET:''},{CERTSIM_FENCE_STORE_SERVICE_KEY:''},
 {CERTSIM_EXPIRY_V1_SIGNING_SECRET:env.CERTSIM_GRADING_SIGNING_SECRET},
 {CERTSIM_EXECUTION_SIGNING_SECRET:env.CERTSIM_GRADING_SIGNING_SECRET}
]){
 assert.throws(()=>execFileSync(process.execPath,[join(root,'services/python-executor-modal/src/fenced-start.mjs')],{env:{...env,...change},timeout:5000,stdio:'pipe'}));
}
for(const name of ['certsim-expiry-worker','certsim-python-expiry-worker']){
 const {createHandler}=await import(pathToFileURL(join(root,'supabase/functions',name,'worker.ts')));
 let calls=0;const key=secret(),handler=createHandler(n=>({SUPABASE_SERVICE_ROLE_KEY:key}[n]),()=>{calls++;throw Error('NO_NETWORK');});
 assert.equal((await handler(new Request('http://127.0.0.1',{method:'POST'}))).status,401);
 const result=await handler(new Request('http://127.0.0.1',{method:'POST',headers:{apikey:key}}));
 assert.equal((await result.json()).state,'disabled');assert.equal(calls,0);
}
const {createRequire}=await import('node:module'),require=createRequire(join(root,'services/python-executor-modal/package.json'));
assert.ok(realpathSync(require.resolve('modal')).startsWith(join(root,'services/python-executor-modal/node_modules')));
const {ModalClient}=await import(pathToFileURL(require.resolve('modal')));
const sdk=new ModalClient({tokenId:secret(),tokenSecret:secret(),logLevel:'error'});assert.equal(sdk.version(),'0.10.1');sdk.close();
const temp=mkdtempSync(join(process.env.RUNNER_TEMP,'package-negative-'));
try{
 const {mkdirSync}=await import('node:fs');
 for(const item of JSON.parse(readFileSync(join(root,'RUNTIME_INVENTORY.json'))).files){const dest=join(temp,item.path);mkdirSync(resolve(dest,'..'),{recursive:true});cpSync(join(root,item.path),dest);}
 cpSync(join(root,'RUNTIME_INVENTORY.json'),join(temp,'RUNTIME_INVENTORY.json'));
 const shared=join(temp,'supabase/functions/_shared/python-fence-auth.mjs'),bytes=readFileSync(shared);
 writeFileSync(shared,Buffer.concat([bytes,Buffer.from('\n// modified\n')]));
 assert.throws(()=>verifyPackage(temp,report.inventorySha256));writeFileSync(shared,bytes);unlinkSync(shared);
 assert.throws(()=>verifyPackage(temp,report.inventorySha256));
 assert.throws(()=>execFileSync(process.execPath,[join(temp,'services/python-executor-modal/src/fenced-start.mjs')],{env,timeout:5000,stdio:'pipe'}));
}finally{assert.ok(temp.startsWith(resolve(process.env.RUNNER_TEMP)+require('node:path').sep));rmSync(temp,{recursive:true,force:true});}
console.log(JSON.stringify({suite:'packaged-node22-config-integrity',node:process.versions.node,legacyStartup:true,defaultDisabled:true,negativeConfiguration:true,missingModifiedFileDenied:true,checkoutFallback:false,realProviderCalls:0,passed:true}));
