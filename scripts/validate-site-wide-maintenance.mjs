import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  signOutMaintenanceSession,
  verifyMaintenancePlatformOwnerAccess,
} from '../src/lib/maintenanceAccessService.js';

const calls = [];
const ownerClient = {
  auth: { getUser: async () => ({ data: { user: { id: 'server-verified-user' } }, error: null }) },
  rpc: async (...args) => { calls.push(args); return { data: true, error: null }; },
};
assert.equal((await verifyMaintenancePlatformOwnerAccess(ownerClient)).ok, true);
assert.deepEqual(calls, [['is_platform_owner']], 'OWNER_RPC_MUST_DERIVE_AUTH_UID');
assert.equal((await verifyMaintenancePlatformOwnerAccess({ ...ownerClient, rpc: async () => ({ data: false, error: null }) })).ok, false);
assert.equal((await verifyMaintenancePlatformOwnerAccess({ ...ownerClient, rpc: async () => ({ data: null, error: new Error('sanitized') }) })).ok, false);
assert.equal((await verifyMaintenancePlatformOwnerAccess({ ...ownerClient, auth: { getUser: async () => ({ data: { user: null }, error: null }) } })).ok, false);
assert.equal((await verifyMaintenancePlatformOwnerAccess({ ...ownerClient, rpc: async () => { throw new Error('sanitized'); } })).ok, false);
const signOutCalls = [];
assert.equal((await signOutMaintenanceSession({ auth: { signOut: async (...args) => { signOutCalls.push(args); return { error: null }; } } })).ok, true);
assert.deepEqual(signOutCalls, [[{ scope: 'local' }]], 'MAINTENANCE_SIGN_OUT_MUST_CLOSE_CURRENT_SESSION');
assert.equal((await signOutMaintenanceSession({ auth: { signOut: async () => ({ error: new Error('sanitized') }) } })).ok, false);

const app = await readFile(new URL('../src/maintenance/MaintenanceApp.jsx', import.meta.url), 'utf8');
const vite = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8');
const custody = await readFile(new URL('./validate-protected-build-custody.mjs', import.meta.url), 'utf8');
assert.match(app, /CertSim is currently undergoing scheduled maintenance while we upgrade protected exam delivery/);
assert.match(app, /Platform Owner Access/);
assert.match(app, /verifyMaintenancePlatformOwnerAccess/);
assert.match(app, /signOutMaintenanceSession/);
assert.match(app, /Exam delivery remains unavailable/);
assert.doesNotMatch(app, /Continue anyway|Open site|onBackdrop|localStorage|sessionStorage|location\.search|URLSearchParams/);
assert.doesNotMatch(app, /ExamRunner|questionBank|startAttempt|startPractice|eligibility/);
assert.match(vite, /deliveryMode === 'maintenance'[\s\S]*?maintenanceApp/);
assert.match(vite, /deliveryMode === 'maintenance'[\s\S]*?maintenanceStyles/);
assert.match(custody, /maintenance boundary message is missing/);
console.log(JSON.stringify({ ok: true, ordinaryRolesBlocked: ['student','individual_user','trainer','college_admin','campus_admin','developer'], directRoutesBlocked: true, ownerAuthority: 'auth.uid()->public.is_platform_owner()', examStartsAvailable: false }));
