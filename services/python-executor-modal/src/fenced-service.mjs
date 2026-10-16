import { ModalBridgeRequestError } from './service.mjs';
import { createConfiguredPythonExecutionProvider,createConfiguredModalClient } from './config.mjs';
import { terminateModalSandboxById } from './provider.mjs';
import { createFenceStore,createProviderFence,FenceError } from './fencing.mjs';
import { executeTrustedPythonGradingRequest } from './trusted-grading-flow.mjs';
import { verifySignedExecutionEnvelope,normalizeExecutionRequest } from '../../python-executor/src/contract.mjs';
import { createExecutionRequestDigest,normalizeGradingBinding,assertAuthenticatedGradingEvidenceForExecution,
 verifySignedGradingEvidenceEnvelope,createExecutionResultDigest } from '../../python-grading/src/contract.mjs';
import { createTrustedGradingMaterialDigest } from '../../python-grading/src/trusted-grading-contract.mjs';
import { FENCE_PROTOCOL,readFenceSecret,verifyFenceAuthority } from '../../../supabase/functions/_shared/python-fence-auth.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function exact(value,keys){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!==keys.sort().join(','))throw new FenceError('invalid_request',400);
 return value;
}
function binding(value) {
 const f=exact(value,['protocol','dispatchId','epoch','attemptId','submissionId','itemId','generation','requestDigest','materialDigest','primaryId','probeId','materializationId','gradingContractVersion','maximumRawPoints','operation']);
 if(f.protocol!==FENCE_PROTOCOL||f.operation!=='grade'||!(/^[1-9][0-9]{0,15}$/).test(f.epoch)
  ||!Number.isSafeInteger(f.generation)||f.generation<1||!Number.isSafeInteger(f.maximumRawPoints)||f.maximumRawPoints<1||f.maximumRawPoints>1000000
  ||!['requestDigest','materialDigest'].every(n=>/^[0-9a-f]{64}$/.test(f[n]))
  ||!['dispatchId','attemptId','submissionId','itemId','primaryId','probeId','materializationId'].every(n=>UUID.test(f[n])))throw new FenceError('fence_binding',400);
 return f;
}
function requireConfig(env,mode) {
 if(mode==='grade' && (env.CERTSIM_PYTHON_EXECUTION_ENABLED!=='YES'||env.CERTSIM_PYTHON_GRADING_ENABLED!=='YES'))throw new FenceError();
 if(env[mode==='grade'?'CERTSIM_PYTHON_EXPIRY_FENCING_ENABLED':'CERTSIM_PYTHON_EXPIRY_RECOVERY_ENABLED']!=='true')throw new FenceError();
 const secret=readFenceSecret(n=>env[n]);
 if(typeof env.CERTSIM_GRADING_SIGNING_SECRET!=='string'||env.CERTSIM_GRADING_SIGNING_SECRET.length<32)throw new FenceError();
 return secret;
}
function safe(error) {
 if(error instanceof FenceError)return new ModalBridgeRequestError(error.code,error.status);
 return new ModalBridgeRequestError('fence_unavailable',503);
}
export async function gradeFencedModalBridgePayload(payload,{
 env=process.env,providerFactory=createConfiguredPythonExecutionProvider,fetcher=fetch,signal
}={}) {
 try {
  const body=exact(payload,['request','envelope','binding','gradingMaterial','fence','auth']);
  const secret=requireConfig(env,'grade'),f=binding(body.fence),request=normalizeExecutionRequest(body.request),b=normalizeGradingBinding(body.binding);
  if(!await verifyFenceAuthority({fence:f},'grade',body.auth,secret)||!verifySignedExecutionEnvelope(request,body.envelope,secret)
   ||request.requestId!=='request.'+f.primaryId||createExecutionRequestDigest(request)!==f.requestDigest
   ||createTrustedGradingMaterialDigest(body.gradingMaterial)!==f.materialDigest
   ||b.requestDigest!==f.requestDigest||b.materialDigest!==f.materialDigest||b.requestId!==request.requestId
   ||b.gradingSessionId!==f.probeId||b.materializationId!==f.materializationId||b.maximumRawPoints!==f.maximumRawPoints
   ||b.gradingContractVersion!==f.gradingContractVersion)throw new FenceError('fence_authentication_failed',401);
  const store=createFenceStore({env,fetcher,signal}),admitted=await store.step(f,'admit');
  const provider=await providerFactory({env,fence:createProviderFence(store,f,admitted.token)});
  const result=await executeTrustedPythonGradingRequest({
   provider,request,binding:b,material:body.gradingMaterial,executionEnvelope:body.envelope,
   executionSigningSecret:secret,gradingSecret:env.CERTSIM_GRADING_SIGNING_SECRET,signal
  });
  assertAuthenticatedGradingEvidenceForExecution({request,executionResult:result.executionResult,binding:b,
   evidence:result.evidence,envelope:result.envelope,secret:env.CERTSIM_GRADING_SIGNING_SECRET});
  // A caller acknowledgment is recoverable only AFTER this durable hand-off.
  await store.step(f,'receipt',{p_token:admitted.token,p_body:result});
  await store.step(f,'seal',{p_token:admitted.token});
  return result;
 }catch(error){throw safe(error);}
}
export async function recoverFencedModalBridgePayload(payload,{
 env=process.env,clientFactory=createConfiguredModalClient,fetcher=fetch
}={}) {
 const deadline=AbortSignal.timeout(20000);
 try {
  const body=exact(payload,['recovery','auth']),r=exact(body.recovery,['fence','token']);
  const secret=requireConfig(env,'recover'),f=binding(r.fence);
  // Authenticate only immutable authority/token, never caller completion flags.
  if(!UUID.test(r.token)||!await verifyFenceAuthority({fence:f,token:r.token},'recover',body.auth,secret))throw new FenceError('fence_authentication_failed',401);
  const store=createFenceStore({env,fetcher,signal:deadline});
  // State is re-read from SQL under its own serialization, not trusted from body.
  // Inspection itself is a fixed authenticated operation; old tokens cannot act.
  const snapshot=await store.step(f,'inspect',{p_token:r.token});
  if(snapshot.receipt) {
   const saved=snapshot.receipt;
   if(!verifySignedGradingEvidenceEnvelope(saved.evidence,saved.envelope,env.CERTSIM_GRADING_SIGNING_SECRET)
    ||createExecutionResultDigest(saved.executionResult)!==saved.evidence.executionResultDigest
    ||saved.evidence.requestDigest!==f.requestDigest||saved.evidence.materialDigest!==f.materialDigest
    ||saved.evidence.gradingSessionId!==f.probeId)throw new FenceError('fence_receipt_authentication',409);
   await store.step(f,'replay',{p_token:r.token});
  }
  const created=snapshot.legs.filter(l=>l.phase==='created');
  if(created.length) {
   const client=await clientFactory({env});
   try {
    await Promise.all(created.map(async leg=>{
     await Promise.race([terminateModalSandboxById(client,leg.sandboxId),new Promise((_,reject)=>deadline.addEventListener('abort',()=>reject(new FenceError()),{once:true}))]);
     deadline.throwIfAborted();
     await store.step(f,'disposed',{p_token:r.token,p_leg:leg.leg,p_sandbox_id:leg.sandboxId});
    }));
   } finally {client.close?.();}
  }
  deadline.throwIfAborted();
  await store.step(f,'release',{p_token:r.token});
  return {state:'capacity_recovered'};
 }catch(error){throw safe(error);}
}
