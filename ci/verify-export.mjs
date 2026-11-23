import fs from 'node:fs';
import cp from 'node:child_process';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const privateSha='a4efcbe68ae9b45e48bd81482d1efa6432aa2208';
assert.equal(fs.readFileSync('CI_SOURCE_SHA.txt','utf8'),privateSha+'\n');
const lines=fs.readFileSync('CI_EXPORT_MANIFEST.tsv','utf8').trim().split(/\r?\n/);
assert.equal(lines.shift(),'path\tsize\tsha256');
const paths=[];
for(const line of lines) {
 const [p,size,hash]=line.split('\t');
 assert(p&&!p.includes('..')&&!paths.includes(p)); paths.push(p);
 const bytes=fs.readFileSync(p);
 assert.equal(bytes.length,Number(size));
 assert.equal(createHash('sha256').update(bytes).digest('hex'),hash);
 assert(!/(?:^|\/)(?:Pat\.txt|\.env(?:\..*)?|.*\.xlsx|serverplus-owner-(?:bridge|client)\.[^/]+|serverplus-publish-once\.mjs|deploy-protected-production\.mjs|publish-protected-package\.mjs)$/i.test(p));
}
const tracked=cp.execFileSync('git',['ls-files'],{encoding:'utf8'}).trim().split('\n').filter(x=>x!=='CI_EXPORT_MANIFEST.tsv').sort();
assert(paths.sort().join('\n')===tracked.join('\n'),'MANIFEST_TRACKED_INVENTORY_MISMATCH');
for(const key of ['SUPABASE_ACCESS_TOKEN','CERTSIM_MANAGEMENT_TOKEN','CERTSIM_OWNER_ACCESS_TOKEN']) assert(!process.env[key]);
console.log(JSON.stringify({privateSha,privateTree:'a00d536a7181bd73881c61d4e9be3016a74e18a8',publicSha:process.env.GITHUB_SHA??null,files:paths.length,manifestVerified:true,productionActions:0}));
