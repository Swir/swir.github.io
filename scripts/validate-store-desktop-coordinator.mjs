import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../swir-store-desktop.js',import.meta.url),'utf8');
const storeHtml=fs.readFileSync(new URL('../swir-store.html',import.meta.url),'utf8');
for(const script of [...storeHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).filter(x=>x.trim())) new Function(script);

function runtimeFixture({trustMode='SIGNED_CATALOG_REQUIRED',failNative=false,nativeInstalled=true,nativeVersion='1.0.0'}={}){
  const calls=[],revoked=[];
  const runtime={
    info:()=>({nativeHost:true}),
    filesystem:{
      async pickFile(){calls.push(['pickFile']);return{token:'cap-1',kind:'file',name:'demo.swirapp'}},
      async revokeCapability(token){revoked.push(token);return true}
    },
    packages:{
      async info(){return{provider:'desktop-native',trustMode,signedCatalogAuthorization:trustMode==='SIGNED_CATALOG_REQUIRED',signedReleaseArtifactRouting:true,legacySha256Fallback:trustMode!=='SIGNED_CATALOG_REQUIRED'}},
      async installAuthorizedReleaseArtifact(id,version,catalog,envelope){calls.push(['signed-release',id,version,catalog,envelope]);if(failNative)throw Object.assign(new Error('native failed'),{code:'NATIVE_FAIL'});return{installed:true,version}},
      async installAuthorizedFromCapability(token,id,version,catalog,envelope){calls.push(['signed-capability',token,id,version,catalog,envelope]);if(failNative)throw Object.assign(new Error('native failed'),{code:'NATIVE_FAIL'});return{installed:true,version}},
      async installFromCapability(token,sha){calls.push(['legacy',token,sha]);if(failNative)throw Object.assign(new Error('native failed'),{code:'NATIVE_FAIL'});return{installed:true}},
      async status(id){calls.push(['status',id]);return{installed:nativeInstalled,packageId:id,version:nativeInstalled?nativeVersion:null}},
      async rollback(id){return{rolledBack:true,packageId:id}}
    }
  };
  return{runtime,calls,revoked};
}
function load(fixture,release=true,sharedStorage=null,pipeline=null,releaseUrl='packages/swir.demo-1.0.0.swirapp'){
  const memory=sharedStorage||new Map(),storage={async get(k,f){return memory.has(k)?JSON.parse(JSON.stringify(memory.get(k))):f},async set(k,v){memory.set(k,JSON.parse(JSON.stringify(v)));return true}};
  const parent={SwirRuntime:fixture.runtime,SwirPlatform:{storage}};if(pipeline)parent.SwirInstallPipeline=pipeline;
  if(release)parent.SWIR_SIGNED_CATALOG_RELEASE={schema:'swir.signed-catalog-release/1.0',catalog:[{id:'demo',packageId:'swir.demo',version:'1.0.0',artifacts:{desktop:{sha256:'a'.repeat(64),url:releaseUrl}}}],envelope:{schema:'swir.catalog-signature/1.0',catalogId:'official',sequence:7,keyId:'release-root',signature:'TEST'}};
  const context={console,structuredClone,window:null};context.window={parent};context.window.window=context.window;vm.createContext(context);vm.runInContext(source,context,{filename:'swir-store-desktop.js'});return{svc:context.window.SwirStoreDesktop,memory,parent,window:context.window};
}

{
  const fx=runtimeFixture(),{svc,memory}=load(fx);
  if(svc.meta.schema!=='swir.store-desktop/1.0'||svc.meta.version!=='1.2.0')throw new Error('Unexpected coordinator contract/version');
  const plan=await svc.plan({id:'demo',packageId:'swir.demo',version:'1.0.0'});
  if(!plan.ok||plan.mode!=='SIGNED_CATALOG'||plan.artifactUrl!=='packages/swir.demo-1.0.0.swirapp')throw new Error('Signed release plan was not selected');
  let committed=0,rolledBack=0;
  const result=await svc.installTransactional({id:'demo',packageId:'swir.demo',version:'1.0.0'},{async webCommit(){committed++;return{transaction:{id:'tx-1'}}},async webRollback(){rolledBack++}});
  if(!result.ok||result.mode!=='SIGNED_CATALOG'||committed!==1||rolledBack!==0||result.recovery!=='CLEAN')throw new Error('Signed transactional install failed');
  const signed=fx.calls.find(x=>x[0]==='signed-release');
  if(!signed||signed[1]!=='swir.demo'||signed[2]!=='1.0.0')throw new Error('Signed release identity transport failed');
  if(fx.calls.some(x=>x[0]==='pickFile'||x[0]==='signed-capability'))throw new Error('Signed release install must not use an arbitrary file picker/capability');
  if((memory.get('store.desktop.pending.v1')||[]).length!==0)throw new Error('Successful native commit left stale recovery intent');
}
{
  const fx=runtimeFixture(),{svc}=load(fx,true,null,null,'../evil.swirapp');const plan=await svc.plan({packageId:'swir.demo',version:'1.0.0'});if(plan.ok||plan.reason!=='SIGNED_CATALOG_ARTIFACT_URL_INVALID')throw new Error('Unsafe signed artifact URL must fail closed before native install');
}
{
  const fx=runtimeFixture({failNative:true}),{svc,memory}=load(fx);let rollbackReason='',failed=false;
  try{await svc.installTransactional({id:'demo',packageId:'swir.demo',version:'1.0.0'},{async webCommit(){return{transaction:{id:'tx-rollback'}}},async webRollback(id,reason){if(id!=='tx-rollback')throw new Error('Wrong rollback transaction');rollbackReason=reason}})}catch(e){failed=e.code==='NATIVE_FAIL'}
  if(!failed||!rollbackReason.includes('NATIVE_DESKTOP_INSTALL_FAILED'))throw new Error('Native failure did not roll back committed Web transaction');
  if((memory.get('store.desktop.pending.v1')||[]).length!==0)throw new Error('Completed rollback left stale recovery intent');
}
{
  const fx=runtimeFixture({trustMode:'SIGNED_CATALOG_REQUIRED'}),{svc}=load(fx,false),plan=await svc.plan({packageId:'swir.demo',version:'1.0.0'});if(plan.ok||plan.reason!=='SIGNED_CATALOG_RELEASE_UNAVAILABLE')throw new Error('Signed mode must fail closed without published catalog+envelope');
}
{
  const fx=runtimeFixture({trustMode:'LEGACY_SHA_UNTIL_ROOT_PROVISIONED'}),{svc}=load(fx,false),pkg={packageId:'swir.demo',version:'1.0.0',artifacts:{desktop:{sha256:'b'.repeat(64)}}},plan=await svc.plan(pkg);if(!plan.ok||plan.mode!=='LEGACY_SHA_PREVIEW')throw new Error('Preview legacy SHA plan unavailable');await svc.installNative(pkg,{plan,capability:{token:'cap-legacy',kind:'file',name:'demo.swirapp'}});const legacy=fx.calls.find(x=>x[0]==='legacy');if(!legacy||legacy[1]!=='cap-legacy'||legacy[2]!=='b'.repeat(64))throw new Error('Legacy preview SHA transport failed');
}
{
  const storage=new Map();storage.set('store.desktop.pending.v1',[{schema:'swir.store-desktop-recovery/1.0',id:'desktop-crash',packageId:'swir.demo',webPackageId:'demo',version:'1.0.0',webTransactionId:'tx-crash',state:'WEB_COMMITTED',createdAt:1000,updatedAt:1001}]);const fx=runtimeFixture({nativeInstalled:false}),rolled=[];const pipeline={async transactions(){return[{id:'tx-crash',packageId:'demo',toVersion:'1.0.0',status:'COMMITTED',startedAt:1000,rollback:{performed:false}}]},async rollback(id,options){rolled.push([id,options]);return{id,status:'ROLLED_BACK'}}};const{svc}=load(fx,true,storage);const result=await svc.reconcile({pipeline});if(!result.ok||result.repaired!==1||rolled.length!==1||rolled[0][0]!=='tx-crash')throw new Error('Restart reconciliation did not roll back WEB_COMMITTED / NATIVE_MISSING state');if((storage.get('store.desktop.pending.v1')||[]).length!==0)throw new Error('Restart reconciliation left stale recovery intent');
}
{
  const storage=new Map();storage.set('store.desktop.pending.v1',[{schema:'swir.store-desktop-recovery/1.0',id:'desktop-native-ok',packageId:'swir.demo',webPackageId:'demo',version:'1.0.0',webTransactionId:'tx-native-ok',state:'WEB_COMMITTED',createdAt:2000,updatedAt:2001}]);const fx=runtimeFixture({nativeInstalled:true,nativeVersion:'1.0.0'}),{svc}=load(fx,true,storage);let rollbackCalled=false;const pipeline={async transactions(){return[{id:'tx-native-ok',packageId:'demo',toVersion:'1.0.0',status:'COMMITTED',startedAt:2000,rollback:{performed:false}}]},async rollback(){rollbackCalled=true}};const result=await svc.reconcile({pipeline});if(!result.ok||result.consistent!==1||rollbackCalled)throw new Error('Restart reconciliation damaged an already committed native deployment');
}
if(!storeHtml.includes('swir-store-desktop.js'))throw new Error('SWIR Store does not load Desktop coordinator');
if(!storeHtml.includes('desktopStore.installTransactional'))throw new Error('SWIR Store does not use transactional Desktop coordinator');
if(!storeHtml.includes('pipeline.rollback'))throw new Error('SWIR Store does not wire Web rollback after native failure');
if(!source.includes('installAuthorizedReleaseArtifact'))throw new Error('Desktop coordinator does not use native signed release artifact routing');
if(!source.includes('SWIR_STORE_DESKTOP_RECONCILIATION'))throw new Error('Desktop coordinator does not schedule startup reconciliation');
console.log('SWIR Store Desktop signed release routing + restart reconciliation validation passed.');