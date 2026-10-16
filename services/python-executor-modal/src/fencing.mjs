import { createExecutionRequestDigest } from '../../python-grading/src/contract.mjs';
export class FenceError extends Error {
 constructor(code='fence_unavailable',status=503){super(code);this.code=code;this.status=status;}
}
export function createFenceStore({env=process.env,fetcher=fetch,signal}={}) {
 const url=env.CERTSIM_FENCE_STORE_URL,key=env.CERTSIM_FENCE_STORE_SERVICE_KEY;
 if(typeof url!=='string'||!/^https?:\/\//.test(url)||typeof key!=='string'||key.length<32)throw new FenceError();
 return {
 async step(fence,operation,args={}) {
  const response=await fetcher(url.replace(/\/$/,'')+'/rest/v1/rpc/certsim_service_python_fence_step',{
   method:'POST',headers:{apikey:key,Authorization:'Bearer '+key,'content-type':'application/json'},
   body:JSON.stringify({p_binding:fence,p_operation:operation,...args}),
   signal:AbortSignal.any([AbortSignal.timeout(4000),...(signal?[signal]:[])])
  });
  const result=await response.json();
  if(!response.ok||result?.ok!==true)throw new FenceError('fence_blocked',409);
  return result;
 }
 };
}
export function createProviderFence(store,fence,token) {
 const legFor=request=>{
  if(request.requestId==='request.'+fence.primaryId)return 'primary';
  if(request.requestId==='request.'+fence.probeId)return 'probe';
  throw new FenceError('fence_binding',409);
 };
 return {
 async beforeCreate(request) {
  const leg=legFor(request);
  await store.step(fence,'intent',{p_token:token,p_leg:leg,p_body:{requestDigest:createExecutionRequestDigest(request)}});
  return {leg};
 },
 async created(handle,sandboxId) {
  const result=await store.step(fence,'created',{p_token:token,p_leg:handle.leg,p_sandbox_id:sandboxId});
  return result.allowed===true;
 },
 async disposed(handle,sandboxId) {
  await store.step(fence,'disposed',{p_token:token,p_leg:handle.leg,p_sandbox_id:sandboxId});
 }
 };
}
