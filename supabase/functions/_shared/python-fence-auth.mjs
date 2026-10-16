// Shared server-only WebCrypto framing; no Node dependency and no learner DTO.
export const FENCE_PROTOCOL = 'certsim.python-expiry.fence.v1';
const encoder = new TextEncoder();
function canonical(value) {
 if(value===null || typeof value==='boolean' || typeof value==='string') return JSON.stringify(value);
 if(typeof value==='number' && Number.isSafeInteger(value)) return JSON.stringify(value);
 if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
 if(value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
 throw Error('fence_auth_contract');
}
async function key(secret,usage) {
 if(typeof secret!=='string'||encoder.encode(secret).length<32) throw Error('fence_config');
 return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,[usage]);
}
function frame(value,purpose) {
 if(!['grade','recover'].includes(purpose))throw Error('fence_auth_contract');
 const text=canonical(value);
 if(encoder.encode(text).length>8192)throw Error('fence_auth_contract');
 return encoder.encode([FENCE_PROTOCOL,purpose,String(encoder.encode(text).length),text].join('\n'));
}
export async function signFenceAuthority(value,purpose,secret) {
 const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',await key(secret,'sign'),frame(value,purpose)));
 return {protocol:FENCE_PROTOCOL,purpose,signature:[...bytes].map(x=>x.toString(16).padStart(2,'0')).join('')};
}
export async function verifyFenceAuthority(value,purpose,auth,secret) {
 if(!auth||Object.keys(auth).sort().join(',')!=='protocol,purpose,signature'||auth.protocol!==FENCE_PROTOCOL||auth.purpose!==purpose||!/^[0-9a-f]{64}$/.test(auth.signature))return false;
 return crypto.subtle.verify('HMAC',await key(secret,'verify'),Uint8Array.from(auth.signature.match(/../g),x=>parseInt(x,16)),frame(value,purpose));
}
export function readFenceSecret(get) {
 const secret=get('CERTSIM_EXPIRY_V1_SIGNING_SECRET');
 if(get('CERTSIM_PYTHON_FENCE_PROTOCOL')!==FENCE_PROTOCOL||typeof secret!=='string'||encoder.encode(secret).length<32
  ||['CERTSIM_EXECUTION_SIGNING_SECRET','CERTSIM_GRADING_SIGNING_SECRET','CERTSIM_MODAL_PROXY_KEY','CERTSIM_MODAL_PROXY_SECRET'].some(n=>get(n)===secret))throw Error('fence_config');
 return secret;
}
