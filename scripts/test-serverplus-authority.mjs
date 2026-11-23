import test from 'node:test';
import assert from 'node:assert/strict';
import { createServerPlusOwnerClient } from './serverplus-publication/serverplus-owner-client.mjs';
import { preflightServerPlusPublication, issueServerPlusPublicationIntent } from './serverplus-publication/serverplus-authority.mjs';

const identity = { inventoryIdentityHash: '428277cdd850122c6d1e69d000a82566c1e9977602565614a1ecc84ffc084108', projectRef: 'qngnoctsdhzcpagesvxz', examKey: 'serverplussk0005', packageVersion: '1.0.0', packageHash: '26e2caf5a3a838ea274f09938076a734aa734e14cb5535ff11a4203c05fdfefe', validationHash: '6f0dfbf16d620b1fee9b9d30a16f9283902bbf88a6e26bbf94d945895cbb36cf', sourceHash: 'b2d0ea7681ab8b40ba54060cf081b514c2096d82c6b2bb7a9dd1de6932b5cb92', exerciseHash: 'bd0ae42ecca21dd8e2ae8f5490fdc3bce6ee65ce4ffe70c0e5aaee7e987c10ed', reviewedSourceCommit: '8f717cfa8e4d17cee0a580a6e5ea7b0c9df1e206', manifestHash: '87f25694f695b6d1839f17268c8fb3bce1c08cdf2138644a04a6a3aabf4da6d9' };

test('scoped existing-owner bridge defaults to read-only and never logs out', async () => {
  const calls = [];
  const client = await createServerPlusOwnerClient({ request: async request => { calls.push(request); return { data: { user: { id: 'synthetic' } }, error: null }; } });
  assert.equal((await client.rpc('certsim_serverplus_publish_with_intent', {})).error.code, 'SERVERPLUS_WRITE_NOT_AUTHORIZED_BY_EXECUTION');
  assert.equal((await client.rpc('certsim_protected_publish_package', {})).error.code, 'SERVERPLUS_RPC_NOT_SUPPORTED');
  await client.rpc('certsim_serverplus_get_publication_intent', { p_intent_id: 'synthetic' });
  await client.close();
  assert.equal((await client.auth.getUser()).error.code, 'SERVERPLUS_CLIENT_CLOSED');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.project === 'qngnoctsdhzcpagesvxz' && !['Session', 'Logout'].includes(call.action)));
});

test('explicit execution mode permits only fixed scoped RPC transport, not general publication', async () => {
  const calls = [];
  const client = await createServerPlusOwnerClient({ executionMode: 'source-approved-publication-execution', request: async request => { calls.push(request); return { data: { user: { id: 'synthetic' } }, error: null }; } });
  await client.rpc('certsim_serverplus_issue_publication_intent', {});
  assert.equal((await client.rpc('certsim_examops_activate_exam_release', {})).error.code, 'SERVERPLUS_RPC_NOT_SUPPORTED');
  assert.equal(calls.length, 2);
  await client.close();
});

test('readiness is strict and malformed identity never becomes permission', async () => {

  for (const ready of [null, false, 'true', undefined]) {
    const client = { auth: { getUser: async () => ({ data: { user: { id: 'synthetic' } } }) }, rpc: async () => ({ data: { ready, identity } }) };
    await assert.rejects(() => preflightServerPlusPublication(client), /SERVERPLUS_PREFLIGHT_BLOCKED/);
  }
  await assert.rejects(() => issueServerPlusPublicationIntent({ client: {}, preflight: { identity: {} }, approvalReference: 'true' }), /SERVERPLUS_IDENTITY_INVALID/);
});


test('lost issuance response reconciles once by reference and never issues twice', async () => {
  const calls=[];
  const client={auth:{getUser:async()=>({data:{user:{id:'synthetic'}}})},rpc:async(name,args)=>{calls.push({name,args});if(name==='certsim_serverplus_issue_publication_intent')throw Error('synthetic transport loss');return {data:{status:'issued'}};}};
  const approvalReference='https://github.com/SAFFR0NM0NEY/cert-sim-platform/issues/222#issuecomment-12345';
  await assert.rejects(()=>issueServerPlusPublicationIntent({client,preflight:{identity,ready:true},approvalReference,confirmation:'ISSUE_SERVERPLUS_1_0_0_ONCE',applicationSourceSha:'a'.repeat(40),protectedSourceSha:'b'.repeat(40)}),/ISSUE_FAILED_STOP_RECONCILE/);
  assert.deepEqual(calls.map(v=>v.name),['certsim_serverplus_issue_publication_intent','certsim_serverplus_get_publication_intent']);
  assert.deepEqual(calls[1].args,{p_approval_reference:approvalReference});
});
