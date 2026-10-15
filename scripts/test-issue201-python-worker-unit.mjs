import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHandler, hasDispatchBudget, INVOCATION_MS, DISPATCH_RESERVE_MS, HEARTBEAT_MS } from '../supabase/functions/certsim-python-expiry-worker/worker.ts';
import { pythonGradingContract, pythonGradingContractForTests } from '../supabase/functions/certsim-protected-exam/python-grading.ts';
import { pythonExecutionContract } from '../supabase/functions/certsim-protected-exam/python-execution.ts';
import { createSignedGradingEvidenceEnvelope, createExecutionResultDigest } from '../services/python-grading/src/contract.mjs';
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
const request=pythonExecutionContract.createRequest({entryPoint:'main.py',files:[{path:'main.py',content:'pass'}]},'20100000-0000-4000-8000-000000000001');
const binding={bindingVersion:'certsim.python-grading.binding.v1',gradingSessionId:'20100000-0000-4000-8000-000000000002',requestId:request.requestId,
 requestDigest:await pythonExecutionContract.sha256(pythonExecutionContract.canonicalJson(request)),materializationId:'20100000-0000-4000-8000-000000000003',materialDigest:'a'.repeat(64),gradingContractVersion:'certsim-python-trusted-grading-v1',maximumRawPoints:5};
const result={contractVersion:'certsim.python-execution.result.v1',executionId:'execution.20100000-0000-4000-8000-000000000001',status:'finished',outcome:'completed',stdout:'',stderr:'',exitCode:0,diagnostics:[]};
const evidence={...Object.fromEntries(Object.entries(binding).filter(([k])=>k!=='bindingVersion')),evidenceVersion:'certsim.python-grading.evidence.v1',evidenceId:binding.gradingSessionId,
 executionId:result.executionId,executionResultDigest:createExecutionResultDigest(result),earnedRawPoints:4,rules:[{ruleId:'synthetic.rule',earnedRawPoints:4,maximumRawPoints:5}]};
const secret='unit-grading-secret-000000000000000000000000';
eq(await pythonGradingContract.verifyEvidence(evidence,createSignedGradingEvidenceEnvelope(evidence,secret),binding,request,result,secret),evidence);
console.log(JSON.stringify({suite:'python-worker-controlled-clock-and-helper-parity',assertions,networkCalls:calls}));
