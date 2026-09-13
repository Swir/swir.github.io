import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('swir-runtime.js', 'utf8');
const calls = [];
const window = {
  SWIR_NATIVE_HOST: {
    edition: 'DESKTOP',
    sessionId: 'test-session',
    features: { nativePackageBridge: true },
    packages: {
      async info(){ return { trustMode: 'SIGNED_CATALOG_REQUIRED' }; },
      async installFromCapability(...args){ calls.push(args); return { ok: true }; },
      async status(){ return { installed: false }; },
      async rollback(){ return { ok: true }; }
    }
  },
  dispatchEvent(){},
  addEventListener(){},
  removeEventListener(){}
};
const context = {
  window,
  navigator: { onLine: true, connection: null },
  location: { reload(){} },
  CustomEvent: class CustomEvent { constructor(type, init){ this.type=type; this.detail=init?.detail; } },
  console,
  setTimeout,
  clearTimeout,
  JSON,
  Object,
  String,
  Error,
  Array,
  Map,
  Set,
  Promise
};
window.window = window;
vm.runInNewContext(source, context, { filename: 'swir-runtime.js' });

const runtime = window.SwirRuntime;
if (!runtime) throw new Error('SwirRuntime was not registered');
if (runtime.meta.version !== '1.6.0') throw new Error(`Expected Runtime 1.6.0, got ${runtime.meta.version}`);

const catalog = [{ id:'demo', packageId:'swir.demo', version:'2.0.0', artifacts:{ desktop:{ sha256:'a'.repeat(64) } } }];
const envelope = { schema:'swir.catalog-signature/1.0', catalogId:'official', sequence:42, keyId:'release-root', signature:'TEST' };
const authorization = runtime.packages.catalogAuthorization('swir.demo', '2.0.0', catalog, envelope);
if (authorization.schema !== 'swir.desktop-catalog-authorization/1.0') throw new Error('Unexpected authorization schema');
if (authorization.packageId !== 'swir.demo' || authorization.version !== '2.0.0') throw new Error('Authorization identity mismatch');
if (!Array.isArray(authorization.catalog) || authorization.catalog.length !== 1) throw new Error('Catalog was not transported');
if (authorization.envelope.keyId !== 'release-root') throw new Error('Envelope was not transported');

await runtime.packages.installAuthorizedFromCapability('cap-42', 'swir.demo', '2.0.0', catalog, envelope);
if (calls.length !== 1) throw new Error('Expected one native package install call');
const [token, serialized, owner] = calls[0];
if (token !== 'cap-42') throw new Error('Capability token changed in transport');
if (owner !== 'swir.system.shell') throw new Error('Desktop package install was not bound to trusted shell identity');
const nativeAuthorization = JSON.parse(serialized);
if (nativeAuthorization.schema !== 'swir.desktop-catalog-authorization/1.0') throw new Error('Native bridge did not receive structured authorization');
if (nativeAuthorization.packageId !== 'swir.demo' || nativeAuthorization.version !== '2.0.0') throw new Error('Native authorization identity changed');
if (nativeAuthorization.envelope.sequence !== 42) throw new Error('Native authorization envelope changed');

await runtime.packages.installFromCapability('cap-legacy', 'b'.repeat(64));
if (calls.length !== 2 || calls[1][1] !== 'b'.repeat(64)) throw new Error('Legacy raw SHA transport regressed before production root lock is enabled');

await runtime.packages.installFromCapability('cap-object', authorization);
if (calls.length !== 3 || JSON.parse(calls[2][1]).schema !== 'swir.desktop-catalog-authorization/1.0') throw new Error('Object trust input was not serialized for native transport');

let rejected = false;
try { runtime.packages.catalogAuthorization('swir.demo', '2.0.0', {}, envelope); } catch (error) { rejected = error?.code === 'CATALOG_AUTHORIZATION_INVALID'; }
if (!rejected) throw new Error('Non-array catalog authorization input must fail closed');

console.log('Desktop package authorization transport OK (structured signed authorization + legacy compatibility + fail-closed input validation).');
