import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../swir-store-desktop.js', import.meta.url), 'utf8');
const storeHtml = fs.readFileSync(new URL('../swir-store.html', import.meta.url), 'utf8');

const inlineScripts=[...storeHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(m=>m[1]).filter(x=>x.trim());
for(const script of inlineScripts) new Function(script);

function runtimeFixture({ trustMode='SIGNED_CATALOG_REQUIRED', failNative=false }={}) {
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
      async status(id){ return {installed:true,packageId:id,version:'1.0.0'}; },
      async rollback(id){ return {rolledBack:true,packageId:id}; }
    }
  };
  return {runtime,calls,revoked};
}

function load(fixture, release=true) {
  const parent={ SwirRuntime:fixture.runtime };
  if(release) parent.SWIR_SIGNED_CATALOG_RELEASE={ schema:'swir.signed-catalog-release/1.0', catalog:[{id:'demo',packageId:'swir.demo',version:'1.0.0',artifacts:{desktop:{sha256:'a'.repeat(64)}}}], envelope:{schema:'swir.catalog-signature/1.0',catalogId:'official',sequence:7,keyId:'release-root',signature:'TEST'} };
  const context={ console, structuredClone, window:null };
  context.window={ parent };
  context.window.window=context.window;
  vm.createContext(context);
  vm.runInContext(source, context, {filename:'swir-store-desktop.js'});
  return context.window.SwirStoreDesktop;
}

{
  const fx=runtimeFixture();
  const svc=load(fx);
  if(svc.meta.schema!=='swir.store-desktop/1.0') throw new Error('Unexpected coordinator schema');
  const plan=await svc.plan({packageId:'swir.demo',version:'1.0.0'});
  if(!plan.ok||plan.mode!=='SIGNED_CATALOG') throw new Error('Signed Desktop plan was not selected');
  let committed=0, rolledBack=0;
  const result=await svc.installTransactional({packageId:'swir.demo',version:'1.0.0'}, {
    async webCommit(){ committed++; return {transaction:{id:'tx-1'}}; },
    async webRollback(){ rolledBack++; }
  });
  if(!result.ok||result.mode!=='SIGNED_CATALOG'||committed!==1||rolledBack!==0) throw new Error('Signed transactional install failed');
  const signed=fx.calls.find(x=>x[0]==='signed');
  if(!signed||signed[1]!=='cap-1'||signed[2]!=='swir.demo'||signed[3]!=='1.0.0') throw new Error('Signed authorization identity/capability transport failed');
}

{
  const fx=runtimeFixture({failNative:true});
  const svc=load(fx);
  let rollbackReason='';
  let failed=false;
  try {
    await svc.installTransactional({packageId:'swir.demo',version:'1.0.0'}, {
      async webCommit(){ return {transaction:{id:'tx-rollback'}}; },
      async webRollback(id,reason){ if(id!=='tx-rollback') throw new Error('Wrong rollback transaction'); rollbackReason=reason; }
    });
  } catch (error) { failed=error.code==='NATIVE_FAIL'; }
  if(!failed||!rollbackReason.includes('NATIVE_DESKTOP_INSTALL_FAILED')) throw new Error('Native failure did not roll back committed Web transaction');
}

{
  const fx=runtimeFixture({trustMode:'SIGNED_CATALOG_REQUIRED'});
  const svc=load(fx,false);
  const plan=await svc.plan({packageId:'swir.demo',version:'1.0.0'});
  if(plan.ok||plan.reason!=='SIGNED_CATALOG_RELEASE_UNAVAILABLE') throw new Error('Signed mode must fail closed without published catalog+envelope');
}

{
  const fx=runtimeFixture({trustMode:'LEGACY_SHA_UNTIL_ROOT_PROVISIONED'});
  const svc=load(fx,false);
  const pkg={packageId:'swir.demo',version:'1.0.0',artifacts:{desktop:{sha256:'b'.repeat(64)}}};
  const plan=await svc.plan(pkg);
  if(!plan.ok||plan.mode!=='LEGACY_SHA_PREVIEW') throw new Error('Preview legacy SHA plan unavailable');
  await svc.installNative(pkg,{plan,capability:{token:'cap-legacy',kind:'file',name:'demo.swirapp'}});
  const legacy=fx.calls.find(x=>x[0]==='legacy');
  if(!legacy||legacy[1]!=='cap-legacy'||legacy[2]!=='b'.repeat(64)) throw new Error('Legacy preview SHA transport failed');
}

if(!storeHtml.includes('swir-store-desktop.js')) throw new Error('SWIR Store does not load Desktop coordinator');
if(!storeHtml.includes('desktopStore.installTransactional')) throw new Error('SWIR Store does not use transactional Desktop coordinator');
if(!storeHtml.includes('pipeline.rollback')) throw new Error('SWIR Store does not wire Web rollback after native failure');

console.log('SWIR Store Desktop coordinator validation passed.');
