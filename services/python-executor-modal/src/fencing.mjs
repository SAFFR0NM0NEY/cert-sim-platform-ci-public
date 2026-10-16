import {confirmModalSandboxTermination} from './provider.mjs';
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
export function createProviderFence(store,fence,token,{cleanupStore=store,signal,cleanupSignal}={}) {
 const legFor=request=>{
  if(request.requestId==='request.'+fence.primaryId)return 'primary';
  if(request.requestId==='request.'+fence.probeId)return 'probe';
  throw new FenceError('fence_binding',409);
 };
 const never=handle=>cleanupStore.step(fence,'never',{p_token:token,p_leg:handle.leg});
 const api={
 cleanupSignal,
 assertActive(){signal?.throwIfAborted();},
 async wait(operation,onLate){
  signal?.throwIfAborted();
  let aborted;
  const pending=Promise.resolve().then(()=>{signal?.throwIfAborted();return operation();});
  if(!signal)return pending;
  const halted=new Promise((_,reject)=>{aborted=()=>reject(new FenceError());signal.addEventListener('abort',aborted,{once:true});});
  try{return await Promise.race([pending,halted]);}
  catch(error){
   if(signal.aborted&&onLate)void pending.then(value=>{if(!cleanupSignal?.aborted)return onLate(value);}).catch(()=>{});
   throw error;
  }finally{signal.removeEventListener('abort',aborted);}
 },
 async beforeCreate(request){
  const handle={leg:legFor(request)};
  try{
   signal?.throwIfAborted();
   await store.step(fence,'intent',{p_token:token,p_leg:handle.leg,p_body:{requestDigest:createExecutionRequestDigest(request)}});
   signal?.throwIfAborted();
   return handle;
  }catch(error){await never(handle).catch(()=>{});throw error;}
 },
 never,
 async created(handle,sandboxId){
  const result=await cleanupStore.step(fence,'created',{p_token:token,p_leg:handle.leg,p_sandbox_id:sandboxId});
  return result.allowed===true&&!signal?.aborted;
 },
 async disposed(handle,sandboxId){
  await cleanupStore.step(fence,'disposed',{p_token:token,p_leg:handle.leg,p_sandbox_id:sandboxId});
 },
 async lateCreated(handle,sandbox){
  if(cleanupSignal?.aborted)return;
  try{await api.created(handle,sandbox.sandboxId);}catch{}
  try{
   await confirmModalSandboxTermination(sandbox,4000,cleanupSignal);
   await api.disposed(handle,sandbox.sandboxId);
  }catch{}finally{sandbox.detach?.();}
 }
 };
 return api;
}
