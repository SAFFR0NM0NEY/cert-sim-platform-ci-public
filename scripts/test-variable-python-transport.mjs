import assert from 'node:assert/strict';
import test from 'node:test';
import { handleProtectedExam } from '../supabase/functions/certsim-protected-exam/handler.ts';
const actor='21400000-0000-4000-8000-000000000001', requestId='21400000-0000-4000-8000-000000000002';
const fixed={attempt:{attemptId:requestId,itemCount:1},items:[{itemId:requestId,questionId:'synthetic',questionType:'single-choice',presentation:{prompt:'Synthetic',options:[{id:'a',text:'Synthetic'}]}}]};
async function run(responses,header='certsim-authorised-form-count-v1',extra={}) {
  const calls=[];
  const request=new Request('http://localhost/functions/v1/certsim-protected-exam/attempts',{method:'POST',headers:{authorization:'Bearer synthetic','content-type':'application/json',...(header?{'x-client-info':header}:{})},
    body:JSON.stringify({examKey:'inf303',profileId:'inf303-standard',clientRequestId:requestId,...extra})});
  const response=await handleProtectedExam(request,{userClient:{auth:{getUser:async()=>({data:{user:{id:actor}},error:null})}},
    createAdmin:()=>({rpc:async(name,args)=>{calls.push({name,args});return responses.shift();}}),log:()=>{}});
  return {status:response.status,body:await response.json(),calls};
}
test('explicit missing capability RPC retains old fixed delivery',async()=>{
  const r=await run([{data:null,error:{code:'PGRST202'}},{data:fixed,error:null}]);
  assert.equal(r.status,201); assert.deepEqual(r.calls.map(c=>c.name),['certsim_protected_count_contract','certsim_protected_start_attempt']);
});
test('old fixed clients keep the existing RPC',async()=>{
  const r=await run([{data:fixed,error:null}],null);
  assert.equal(r.status,201);assert.deepEqual(r.calls.map(c=>c.name),['certsim_protected_start_attempt']);
});
test('transport and authorization errors never trigger fixed fallback',async()=>{
  const r=await run([{data:null,error:{code:'42501'}}]);assert.equal(r.status,500);assert.equal(r.calls.length,1);
});
for(const field of ['formId','questionCount','exactCount'])test(`Edge rejects client ${field} before any trusted Start`,async()=>{
  const r=await run([],undefined,{[field]:3});assert.equal(r.status,400);assert.equal(r.calls.length,0);
});
test('unsupported variable client is a bounded 409 without retrying Start',async()=>{
  const r=await run([{data:null,error:{message:'count_contract_required'}}]);assert.equal(r.status,409);assert.equal(r.body.error.code,'unsupported_count_contract');assert.equal(r.calls.length,1);
});
