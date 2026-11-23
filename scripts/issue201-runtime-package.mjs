import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,lstatSync} from 'node:fs';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export const layoutPath='services/python-executor-modal/runtime-profile.json';
const hash=b=>createHash('sha256').update(b).digest('hex');
const git=args=>execFileSync('git',['-c','safe.directory='+repository,'-C',repository,...args],{windowsHide:true,maxBuffer:32*1024*1024});
const blob=(sha,path)=>git(['cat-file','blob',sha+':'+path]);
export function validateLayout(layout) {
 const b=layout.budgets;
 if(!Object.values(b).every(Number.isSafeInteger))throw Error('FINITE_RUNTIME_BUDGET_REQUIRED');
 if(layout.schema!=='certsim.expiry-runtime-package.v1'||layout.profile!=='fenced-v1'
  ||layout.root!=='/opt/certsim'||layout.nodeMajor!==22||layout.nodeImage!=='node:22-bookworm-slim'
  ||layout.modalJavaScriptSdk!=='0.10.1'||layout.modalPythonDeploymentSdk!=='1.1.4'
  ||b.gradeMs!==90000||b.proofMs!==125000||b.workerMs!==145000
  ||b.cleanupReserveMs!==35000||b.recoveryBridgeMs!==20000||b.recoveryHttpMs!==25000
  ||b.dbHttpMs!==4000||b.dbStatementMs!==3000
  ||b.hostSeconds!==180||b.hostSeconds<b.proofMs/1000+b.startupSeconds+b.hostOverheadSeconds
  ||b.nodeConnectionsCheckMs!==1000||b.hostOverheadSeconds<25||b.startupSeconds!==30||b.nodeSocketMs<b.proofMs+b.nodeRequestMs
  ||Object.values(layout.gateDefaults).some(v=>v!=='false'))throw Error('RUNTIME_LAYOUT_CONTRACT');
 if(new Set(layout.files).size!==layout.files.length||!layout.files.includes(layoutPath))throw Error('RUNTIME_INVENTORY_CONTRACT');
 for(const path of layout.files)if(path.includes('..')||path.startsWith('/')||path.includes('\\')
  ||!/^(services\/python-(executor|grading|executor-modal)\/(src\/[\w.-]+\.(mjs|py)|package(-lock)?\.json|runtime-profile\.json|worker-functions\.toml)|supabase\/(config\.toml|functions\/(_shared\/python-fence-auth\.mjs|certsim-(python-expiry-worker|expiry-worker)\/(index|worker)\.ts|certsim-protected-exam\/(python-execution|python-grading|errors)\.ts)))$/.test(path))throw Error('UNSAFE_RUNTIME_PATH');
 return layout;
}
export function stagePackage(sha,target,profile) {
 if(!/^[0-9a-f]{40}$/.test(sha)||!['fenced-v1','legacy'].includes(profile))throw Error('EXACT_SOURCE_PROFILE_REQUIRED');
 git(['merge-base','--is-ancestor','92a94c49010da880dad234b6c2967e8d305a5009',sha]);
 const output=resolve(target),rel=relative(repository,output);
 if(!isAbsolute(target)||!rel.startsWith('..')||existsSync(output))throw Error('FRESH_EXTERNAL_PACKAGE_ROOT_REQUIRED');
 const layout=validateLayout(JSON.parse(blob(sha,layoutPath)));
 const paths=profile==='fenced-v1'?layout.files:layout.files.filter(p=>p.startsWith('services/')&&!p.endsWith('/fenced-start.mjs'));
 const files=paths.map(path=>{const bytes=blob(sha,path);return {path,size:bytes.length,sha256:hash(bytes)};});
 const pkg=JSON.parse(blob(sha,'services/python-executor-modal/package.json'));
 const lock=JSON.parse(blob(sha,'services/python-executor-modal/package-lock.json'));
 if(pkg.dependencies.modal!=='0.10.1'||lock.packages['node_modules/modal'].version!=='0.10.1')throw Error('SDK_PIN_MISMATCH');
 mkdirSync(output,{recursive:true});
 for(const file of files){const dest=resolve(output,file.path);mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,blob(sha,file.path),{flag:'wx'});}
 const inventory={schema:layout.schema,profile,privateSourceSha:sha,runtime:{nodeMajor:layout.nodeMajor,nodeImage:layout.nodeImage,pythonRuntime:layout.pythonRuntime,modalJavaScriptSdk:layout.modalJavaScriptSdk,modalPythonDeploymentSdk:profile==='fenced-v1'?layout.modalPythonDeploymentSdk:null},budgets:profile==='fenced-v1'?layout.budgets:{hostSeconds:60,nodeRequestMs:300000,nodeHeadersMs:60000,nodeSocketMs:0,nodeKeepAliveMs:5000,nodeConnectionsCheckMs:30000},lockfiles:['services/python-executor-modal/package-lock.json'],files};
 const bytes=Buffer.from(JSON.stringify(inventory,null,2)+'\n');writeFileSync(resolve(output,'RUNTIME_INVENTORY.json'),bytes,{flag:'wx'});
 return {privateSourceSha:sha,profile,root:output,runtimeFiles:files.length,inventorySha256:hash(bytes)};
}
export function verifyPackage(target,expectedHash) {
 if(!/^[0-9a-f]{64}$/.test(expectedHash??''))throw Error('EXPECTED_INVENTORY_HASH_REQUIRED');
 const root=resolve(target),raw=readFileSync(resolve(root,'RUNTIME_INVENTORY.json'));
 if(hash(raw)!==expectedHash)throw Error('INVENTORY_HASH_MISMATCH');
 const inventory=JSON.parse(raw),layout=validateLayout(JSON.parse(readFileSync(resolve(root,layoutPath))));
 const paths=inventory.profile==='fenced-v1'?layout.files:layout.files.filter(p=>p.startsWith('services/')&&!p.endsWith('/fenced-start.mjs'));
 if(JSON.stringify(inventory.files.map(f=>f.path).sort())!==JSON.stringify([...paths].sort()))throw Error('PACKAGE_FILE_SET_MISMATCH');
 for(const file of inventory.files) {
  const full=resolve(root,file.path);
  if(!lstatSync(full).isFile()||lstatSync(full).isSymbolicLink())throw Error('PACKAGE_REGULAR_FILE_REQUIRED');
  const bytes=readFileSync(full);
  if(bytes.length!==file.size||hash(bytes)!==file.sha256)throw Error('PACKAGE_BYTES_MISMATCH '+file.path);
 }
 function walk(path,prefix='') {return readdirSync(path,{withFileTypes:true}).flatMap(e=>{
  const name=prefix+e.name;
  if(name==='services/python-executor-modal/node_modules')return [];
  if(e.isSymbolicLink())throw Error('PACKAGE_SYMLINK_DENIED');
  return e.isDirectory()?walk(resolve(path,e.name),name+'/'):[name];
 });}
 if(JSON.stringify(walk(root).sort())!==JSON.stringify([...paths,'RUNTIME_INVENTORY.json'].sort()))throw Error('UNINVENTORIED_PACKAGE_FILE');
 return {verified:true,privateSourceSha:inventory.privateSourceSha,profile:inventory.profile,runtimeFiles:inventory.files.length,inventorySha256:expectedHash};
}
export function workerConfig(target,expectedHash) {
 verifyPackage(target,expectedHash);
 const source=readFileSync(resolve(target,'supabase/config.toml'),'utf8');
 if(!source.includes('[functions.certsim-protected-exam]\nverify_jwt = true'))throw Error('LEARNER_JWT_SOURCE_MISMATCH');
 const workers=readFileSync(resolve(target,'services/python-executor-modal/worker-functions.toml'),'utf8');
 return source.replace(/\n\[functions\.[^\]]+\]\n[\s\S]*?(?=\n\[|$)/g,'')+'\n'+workers;
}
export function dockerfile(target,expectedHash) {
 verifyPackage(target,expectedHash);
 const inventory=JSON.parse(readFileSync(resolve(target,'RUNTIME_INVENTORY.json')));
 const layout=JSON.parse(readFileSync(resolve(target,layoutPath)));
 const lines=[
  'FROM '+layout.nodeImage+' AS node',
  'FROM python:'+layout.pythonRuntime+'-slim-bookworm',
  'RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libstdc++6 libatomic1 && rm -rf /var/lib/apt/lists/*',
  'COPY --from=node /usr/local/bin/node /usr/local/bin/node',
  'COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules',
  'RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm',
  ...[...inventory.files.map(f=>f.path),'RUNTIME_INVENTORY.json'].map(p=>'COPY '+JSON.stringify([p,'/opt/certsim/'+p])),
  'RUN cd /opt/certsim/services/python-executor-modal && npm ci --omit=dev --ignore-scripts',
  'WORKDIR /opt/certsim/services/python-executor-modal',
  'CMD ["node", "src/'+(inventory.profile==='fenced-v1'?'fenced-start.mjs':'server.mjs')+'"]'
 ];
 return lines.join('\n')+'\n';
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [mode,a,b,c]=process.argv.slice(2);
 if(mode==='worker-config'){process.stdout.write(workerConfig(a,b));process.exit(0);}
 if(mode==='dockerfile'){process.stdout.write(dockerfile(a,b));process.exit(0);}
 console.log(JSON.stringify(mode==='stage'?stagePackage(a,b,c):mode==='verify'?verifyPackage(a,b):(()=>{throw Error('USE_stage_SHA_absoluteRoot_profile_OR_verify_root_manifestHash');})()));
}
