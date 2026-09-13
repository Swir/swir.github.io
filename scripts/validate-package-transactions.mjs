import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../swir-install-pipeline.js', import.meta.url), 'utf8');
const state = { packages: new Map(), permissions: new Map(), storage: new Map(), failPermission: false };

const platform = {
  storage: {
    async get(key, fallback=null){ return state.storage.has(key) ? structuredClone(state.storage.get(key)) : fallback; },
    async set(key, value){ state.storage.set(key, structuredClone(value)); return value; }
  },
  packages: {
    async list(){ return [...state.packages.values()].map(item => structuredClone(item)); },
    async install(pkg){ state.packages.set(pkg.id, structuredClone(pkg)); return pkg; },
    async remove(id){ state.packages.delete(id); return true; }
  },
  permissions: {
    async get(appId, permission){ return { value: state.permissions.get(`${appId}:${permission}`) === true }; },
    async set(appId, permission, value){
      if (state.failPermission) { state.failPermission = false; throw new Error('synthetic permission failure'); }
      state.permissions.set(`${appId}:${permission}`, value === true);
      return { appId, permission, value:value === true };
    }
  }
};

const sandbox = {
  console,
  structuredClone,
  setTimeout,
  clearTimeout,
  Date,
  Math,
  Uint32Array,
  crypto: globalThis.crypto,
  SwirPlatform: platform,
  SwirTrustedKeys: {},
  SwirPackageIntegrity: {
    async plan(){ return { manifest:{ok:true}, entry:{ok:true}, signature:{ok:true,state:'VERIFIED'} }; }
  },
  SwirPackageResolver: {
    async planInstall(){ return {ok:true, errors:[]}; },
    async planRemove(){ return {ok:true, errors:[]}; }
  },
  SWIR_PACKAGE_CATALOG: []
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename:'swir-install-pipeline.js' });

const svc = sandbox.SwirInstallPipeline;
if (!svc) throw new Error('SwirInstallPipeline was not registered');
if (svc.meta.version !== '1.2.0') throw new Error(`Unexpected pipeline version ${svc.meta.version}`);
if (svc.meta.transactionSchema !== 'swir.package-transaction/1.0') throw new Error('Missing transaction schema');

const manifest = version => ({
  schema:'swir.app/1.0', id:'swir.test', packageId:'swir.test', name:'Transaction Test', version,
  permissions:['storage'], entry:'test.html', signature:{ keyId:'test', value:'ok' }
});

async function setCatalog(m){ sandbox.SWIR_PACKAGE_CATALOG = [structuredClone(m)]; }
function current(){ return state.packages.get('swir.test') || null; }

const v1 = manifest('1.0.0');
await setCatalog(v1);
const first = await svc.install(v1, { approved:true, approvedPermissions:['storage'] });
if (!first.transaction || first.transaction.status !== 'COMMITTED' || first.transaction.action !== 'install') throw new Error('Install transaction was not committed');
if (current()?.version !== '1.0.0') throw new Error('v1 was not installed');
if (state.permissions.get('swir.test:storage') !== true) throw new Error('Permission was not applied');

const v2 = manifest('2.0.0');
await setCatalog(v2);
const upgraded = await svc.update(v2, { approved:true, approvedPermissions:['storage'] });
if (upgraded.transaction.action !== 'update' || upgraded.transaction.fromVersion !== '1.0.0' || upgraded.transaction.toVersion !== '2.0.0') throw new Error('Update transaction metadata is incorrect');
if (current()?.version !== '2.0.0') throw new Error('v2 was not installed');

const manualRollback = await svc.rollback(upgraded.transaction.id, { approved:true, reason:'TEST_MANUAL_ROLLBACK' });
if (manualRollback.status !== 'ROLLED_BACK' || manualRollback.rollback?.performed !== true) throw new Error('Manual rollback did not complete');
if (current()?.version !== '1.0.0') throw new Error('Manual rollback did not restore v1');

await setCatalog(v2);
state.failPermission = true;
let failed = false;
try { await svc.update(v2, { approved:true, approvedPermissions:['storage'] }); }
catch (error) { failed = /changes rolled back/.test(String(error?.message)); }
if (!failed) throw new Error('Synthetic mid-transaction failure was not surfaced as rolled back');
if (current()?.version !== '1.0.0') throw new Error('Automatic rollback did not restore v1');
const afterFailure = await svc.transactions({ packageId:'swir.test' });
const autoRollback = afterFailure.find(x => x.error?.startsWith('AUTO_ROLLBACK:'));
if (!autoRollback || autoRollback.status !== 'ROLLED_BACK' || autoRollback.rollback?.performed !== true) throw new Error('Automatic rollback was not journaled');

await setCatalog(v1);
const removed = await svc.remove(v1, { approved:true });
if (removed.transaction.status !== 'COMMITTED' || removed.transaction.action !== 'remove') throw new Error('Remove transaction was not committed');
if (current()) throw new Error('Package was not removed');
const restored = await svc.rollback(removed.transaction.id, { approved:true, reason:'TEST_REMOVE_ROLLBACK' });
if (restored.status !== 'ROLLED_BACK' || current()?.version !== '1.0.0') throw new Error('Remove rollback did not restore package');
if (state.permissions.get('swir.test:storage') !== true) throw new Error('Remove rollback did not restore permission state');

const history = await svc.transactions();
if (!history.length || history.length > 50) throw new Error('Transaction journal bounds are invalid');
for (const tx of history) {
  if (tx.schema !== 'swir.package-transaction/1.0') throw new Error('Unexpected transaction schema in journal');
  if (!tx.id || !tx.status || !tx.rollback) throw new Error('Incomplete transaction record');
}

console.log(`SWIR package transaction contract OK: ${history.length} journal records; install/update/remove + automatic/manual rollback verified.`);
