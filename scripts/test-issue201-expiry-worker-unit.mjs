import assert from 'node:assert/strict';
import { createHandler, runWorker } from '../supabase/functions/certsim-expiry-worker/worker.ts';
let checks=0;
const check=(a,b)=>{assert.deepEqual(a,b);checks++;};
const secret='synthetic-service-credential-'.repeat(3);
let calls=0;
for(const activation of [undefined,'false','TRUE','invalid']) {
 const env=k=>({SUPABASE_SERVICE_ROLE_KEY:secret,CERTSIM_EXPIRY_WORKER_ENABLED:activation})[k];
 const handler=createHandler(env,()=>{calls++;throw Error('SENSITIVE_SENTINEL');});
 check((await handler(new Request('http://fixture/',{method:'POST',headers:{apikey:secret}}))).status,200);
 check(calls,0);
 for(const key of ['', 'learner', 'staff', 'owner', 'forged-role-service'])
  check((await handler(new Request('http://fixture/',{method:'POST',headers:{apikey:key,'x-role':'service_role'}}))).status,401);
 check((await handler(new Request('http://fixture/?limit=100',{method:'POST',headers:{apikey:secret}}))).status,400);
 check((await handler(new Request('http://fixture/',{method:'POST',headers:{apikey:secret},body:'SENSITIVE_SENTINEL'}))).status,400);
}
check((await createHandler(()=>undefined)(new Request('http://fixture/',{method:'POST'}))).status,401);
const names=[];
const result=await runWorker(async(name)=>{names.push(name);return name.includes('claim')?{outcome:'claimed',attemptId:'SENSITIVE_SENTINEL',leaseToken:'LEASE_SENTINEL'}:{outcome:'completed'};});
check(result.claimed,5);check(result.completed,5);check(names.length,10);
assert.ok(!JSON.stringify(result).includes('SENTINEL'));checks++;
let time=0;
check((await runWorker(async()=>{throw Error('must not call');},()=>time+=80_000)).claimed,0);
let claimed=false;
const lost=await runWorker(async(name)=>{
 if(name.includes('claim')){if(claimed)return {outcome:'empty'};claimed=true;return {outcome:'claimed',attemptId:'opaque',leaseToken:'opaque'};}
 if(name.includes('finish'))throw Error('lost response');
 return {outcome:'completed'};
});
check(lost.completed,1);
console.log(JSON.stringify({suite:'issue201-worker-unit',checks,providerCalls:0}));
