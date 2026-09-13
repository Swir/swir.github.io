import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../swir-store-desktop.js', import.meta.url), 'utf8');
const storeHtml = fs.readFileSync(new URL('../swir-store.html', import.meta.url), 'utf8');

const inlineScripts=[...storeHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).filter(x=>x.trim());
for(const script of inlineScripts) new Function(script);

function runtimeFixture({ trustMode='SIGNED_CATALOG_REQUIRED', failNative=false, nativeInstalled=true, nativeVersion='1.0.0' }={}) {
  const calls=[];
  const revoked=[];
  const runtime={
    info:()=>({ nativeHost:true }),
    filesystem:{
      async pickFile(){ calls.push(['pickFile']); return { token:'cap-1', kind:'file', name:'demo.swirapp' }; },
      async revokeCapability(token){ revoked.push(token); return true; }
    },
    packages:{
      async info(){ return { provider:'desktop-native', trustMode, signedCatalogAuthorization:trustMode==='SIGNED_CATALOG_REQUIRED', legacySha256Fallback:trustMode!=='SIGNED_CATALOG_REQUIRED' }; },
      async installAuthorizedFromCapability(token,id,version,catalog,envelope){ calls.push(['signed',token,id,version,catalog,envelope]); if(failNative) throw Object.assign(new Error('native failed'),{code:'NATIVE_FAIL'}); return {installed:true,version}; },
      async installFromCapability(token,sha){ calls.push(['legacy',token,sha]); if(failNative) throw Object.assign(new Error('native failed'),{code:'NATIVE_FAIL'}); return {installed:true}; },
      async status(id){ calls.push(['status',id]); return {installed:nativeInstalled,packageId:id,version:nativeInstalled?nativeVersion:null}; },
      async rollback(id){ return {rolledBack:true,packageId:id}; }
    }
  };
  return {runtime,calls,revoked};
}

function load(fixture, release=true, sharedStorage=null, pipeline=null) {
  const memory=sharedStorage || new Map();
  const storage={
    async get(key,fallback){ return memory.has(key) ? JSON.parse(JSON.stringify(memory.get(key))) : fallback; },
    async set(key,value){ memory.set(key,JSON.parse(JSON.stringify(value))); return true; }
  };
  const parent={ SwirRuntime:fixture.runtime, SwirPlatform:{storage} };
  if(pipeline) parent.SwirInstallPipeline=pipeline;
  if(release) parent.SWIR_SIGNED_CATALOG_RELEASE={ schema:'swir.signed-catalog-release/1.0', catalog:[{id:'demo',packageId:'swir.demo',version:'1.0.0',artifacts:{desktop:{sha256:'a'.repeat(64)}}}], envelope:{schema:'swir.catalog-signature/1.0',catalogId:'official',sequence:7,keyId:'release-root',signature:'TEST'} };
  const context={ console, structuredClone, window:null };
  context.window={ parent };
  context.window.window=context.window;
  vm.createContext(context);
  vm.runInContext(source, context, {filename:'swir-store-desktop.js'});
  return {svc:context.window.SwirStoreDesktop,memory,parent,window:context.window};
}

{
  const fx=runtimeFixture();
  const {svc,memory}=load(fx);
  if(svc.meta.schema!=='swir.store-desktop/1.0'||svc.meta.version!=='1.1.0') throw new Error('Unexpected coordinator contract/version');
  const plan=await svc.plan({id:'demo',packageId:'swir.demo',version:'1.0.0'});
  if(!plan.ok||plan.mode!=='SIGNED_CATALOG') throw new Error('Signed Desktop plan was not selected');
  let committed=0, rolledBack=0;
  const result=await svc.installTransactional({id:'demo',packageId:'swir.demo',version:'1.0.0'}, {
    async webCommit(){ committed++; return {transaction:{id:'tx-1'}}; },
    async webRollback(){ rolledBack++; }
  });
  if(!result.ok||result.mode!=='SIGNED_CATALOG'||committed!==1||rolledBack!==0||result.recovery!=='CLEAN') throw new Error('Signed transactional install failed');
  const signed=fx.calls.find(x=>x[0]==='signed');
  if(!signed||signed[1]!=='cap-1'||signed[2]!=='swir.demo'||signed[3]!=='1.0.0') throw new Error('Signed authorization identity/capability transport failed');
  if((memory.get('store.desktop.pending.v1')||[]).length!==0) throw new Error('Successful native commit left stale recovery intent');
}

{
  const fx=runtimeFixture({failNative:true});
  const {svc,memory}=load(fx);
  let rollbackReason='';
  let failed=false;
  try {
    await svc.installTransactional({id:'demo',packageId:'swir.demo',version:'1.0.0'}, {
      async webCommit(){ return {transaction:{id:'tx-rollback'}}; },
      async webRollback(id,reason){ if(id!=='tx-rollback') throw new Error('Wrong rollback transaction'); rollbackReason=reason; }
    });
  } catch (error) { failed=error.code==='NATIVE_FAIL'; }
  if(!failed||!rollbackReason.includes('NATIVE_DESKTOP_INSTALL_FAILED')) throw new Error('Native failure did not roll back committed Web transaction');
  if((memory.get('store.desktop.pending.v1')||[]).length!==0) throw new Error('Completed rollback left stale recovery intent');
}

{
  const fx=runtimeFixture({trustMode:'SIGNED_CATALOG_REQUIRED'});
  const {svc}=load(fx,false);
  const plan=await svc.plan({packageId:'swir.demo',version:'1.0.0'});
  if(plan.ok||plan.reason!=='SIGNED_CATALOG_RELEASE_UNAVAILABLE') throw new Error('Signed mode must fail closed without published catalog+envelope');
}

{
  const fx=runtimeFixture({trustMode:'LEGACY_SHA_UNTIL_ROOT_PROVISIONED'});
  const {svc}=load(fx,false);
  const pkg={packageId:'swir.demo',version:'1.0.0',artifacts:{desktop:{sha256:'b'.repeat(64)}}};
  const plan=await svc.plan(pkg);
  if(!plan.ok||plan.mode!=='LEGACY_SHA_PREVIEW') throw new Error('Preview legacy SHA plan unavailable');
  await svc.installNative(pkg,{plan,capability:{token:'cap-legacy',kind:'file',name:'demo.swirapp'}});
  const legacy=fx.calls.find(x=>x[0]==='legacy');
  if(!legacy||legacy[1]!=='cap-legacy'||legacy[2]!=='b'.repeat(64)) throw new Error('Legacy preview SHA transport failed');
}

// Hard process stop after Web commit but before native commit -> startup must restore Web state.
{
  const storage=new Map();
  storage.set('store.desktop.pending.v1',[{
    schema:'swir.store-desktop-recovery/1.0',id:'desktop-crash',packageId:'swir.demo',webPackageId:'demo',version:'1.0.0',webTransactionId:'tx-crash',state:'WEB_COMMITTED',createdAt:1000,updatedAt:1001
  }]);
  const fx=runtimeFixture({nativeInstalled:false});
  const rolled=[];
  const pipeline={
    async transactions(){ return [{id:'tx-crash',packageId:'demo',toVersion:'1.0.0',status:'COMMITTED',startedAt:1000,rollback:{performed:false}}]; },
    async rollback(id,options){ rolled.push([id,options]); return {id,status:'ROLLED_BACK'}; }
  };
  const {svc}=load(fx,true,storage);
  const result=await svc.reconcile({pipeline});
  if(!result.ok||result.repaired!==1||rolled.length!==1||rolled[0][0]!=='tx-crash') throw new Error('Restart reconciliation did not roll back WEB_COMMITTED / NATIVE_MISSING state');
  if(!String(rolled[0][1]?.reason||'').includes('DESKTOP_RECONCILE_NATIVE_MISSING')) throw new Error('Restart rollback reason missing native-missing classification');
  if((storage.get('store.desktop.pending.v1')||[]).length!==0) throw new Error('Restart reconciliation left stale recovery intent');
}

// Native commit succeeded before process death -> startup clears only the durable intent, never rolls back good native state.
{
  const storage=new Map();
  storage.set('store.desktop.pending.v1',[{
    schema:'swir.store-desktop-recovery/1.0',id:'desktop-native-ok',packageId:'swir.demo',webPackageId:'demo',version:'1.0.0',webTransactionId:'tx-native-ok',state:'WEB_COMMITTED',createdAt:2000,updatedAt:2001
  }]);
  const fx=runtimeFixture({nativeInstalled:true,nativeVersion:'1.0.0'});
  const {svc}=load(fx,true,storage);
  let rollbackCalled=false;
  const pipeline={
    async transactions(){ return [{id:'tx-native-ok',packageId:'demo',toVersion:'1.0.0',status:'COMMITTED',startedAt:2000,rollback:{performed:false}}]; },
    async rollback(){ rollbackCalled=true; }
  };
  const result=await svc.reconcile({pipeline});
  if(!result.ok||result.consistent!==1||rollbackCalled) throw new Error('Restart reconciliation damaged an already committed native deployment');
  if((storage.get('store.desktop.pending.v1')||[]).length!==0) throw new Error('Consistent restart state left stale recovery intent');
}

// Loading the coordinator in a real Store-like environment automatically executes recovery.
{
  const storage=new Map();
  storage.set('store.desktop.pending.v1',[{
    schema:'swir.store-desktop-recovery/1.0',id:'desktop-auto',packageId:'swir.demo',webPackageId:'demo',version:'1.0.0',webTransactionId:'tx-auto',state:'WEB_COMMITTED',createdAt:3000,updatedAt:3001
  }]);
  const fx=runtimeFixture({nativeInstalled:false});
  let rollbackCalled=false;
  const pipeline={
    async transactions(){ return [{id:'tx-auto',packageId:'demo',toVersion:'1.0.0',status:'COMMITTED',startedAt:3000,rollback:{performed:false}}]; },
    async rollback(){ rollbackCalled=true; return {status:'ROLLED_BACK'}; }
  };
  const loaded=load(fx,true,storage,pipeline);
  if(!loaded.window.SWIR_STORE_DESKTOP_RECONCILIATION) throw new Error('Automatic startup reconciliation promise was not exposed');
  const result=await loaded.window.SWIR_STORE_DESKTOP_RECONCILIATION;
  if(!result.ok||result.repaired!==1||!rollbackCalled) throw new Error('Automatic startup reconciliation did not repair interrupted transaction');
}

if(!storeHtml.includes('swir-store-desktop.js')) throw new Error('SWIR Store does not load Desktop coordinator');
if(!storeHtml.includes('desktopStore.installTransactional')) throw new Error('SWIR Store does not use transactional Desktop coordinator');
if(!storeHtml.includes('pipeline.rollback')) throw new Error('SWIR Store does not wire Web rollback after native failure');
if(!source.includes('SWIR_STORE_DESKTOP_RECONCILIATION')) throw new Error('Desktop coordinator does not schedule startup reconciliation');

console.log('SWIR Store Desktop coordinator + restart reconciliation validation passed.');
