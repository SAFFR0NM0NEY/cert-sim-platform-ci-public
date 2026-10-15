import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandler, hasDispatchBudget, INVOCATION_MS, DISPATCH_RESERVE_MS, HEARTBEAT_MS } from '../supabase/functions/certsim-python-expiry-worker/worker.ts';
import { pythonGradingContract, pythonGradingContractForTests } from '../supabase/functions/certsim-protected-exam/python-grading.ts';
let assertions=0;
const eq=(a,b)=>{assert.deepEqual(a,b);assertions++;};
eq(pythonGradingContract,pythonGradingContractForTests);
eq([INVOCATION_MS,DISPATCH_RESERVE_MS,HEARTBEAT_MS],[145000,125000,10000]);
for(const [elapsed,expected] of [[0,true],[19999,true],[20000,true],[20001,false],[145000,false],[-1,false],[Infinity,false],[NaN,false]])eq(hasDispatchBudget(100,100+elapsed),expected);
const key='unit-test-only-service-key-000000000000';
let calls=0;
const fetcher=()=>{calls++;throw Error('UNEXPECTED_NETWORK');};
for(const enabled of [undefined,'false','TRUE','invalid']) {
 const handler=createHandler(name=>name==='SUPABASE_SERVICE_ROLE_KEY'?key:name==='CERTSIM_PYTHON_EXPIRY_WORKER_ENABLED'?enabled:undefined,fetcher);
 const r=await handler(new Request('http://localhost',{method:'POST',headers:{apikey:key}}));eq(await r.json(),{state:'disabled',actions:0});
}
eq(calls,0);
const source=readFileSync('supabase/functions/certsim-protected-exam/python-grading.ts','utf8');
for(const name of ['boundExecutionRequest','verifyEvidence','cancelNamedExecution']) {
 eq(typeof pythonGradingContract[name],'function');
 eq(source.includes(`async function ${name}(`),true);
 eq(source.match(new RegExp(`async function ${name}\\(`,'g')).length,1);
}
const worker=readFileSync('supabase/functions/certsim-python-expiry-worker/worker.ts','utf8');
eq(/ForTests|diagnosticSink|console\./.test(worker),false);
eq(readFileSync('supabase/functions/certsim-python-expiry-worker/index.ts','utf8').includes('Deno.serve(createHandler('),true);
console.log(JSON.stringify({suite:'python-worker-controlled-clock-and-helper-parity',assertions,networkCalls:calls}));
