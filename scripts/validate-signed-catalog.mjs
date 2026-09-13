import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = fs.readFileSync(new URL('../swir-catalog-integrity.js', import.meta.url), 'utf8');
const trustStateSource = fs.readFileSync(new URL('../swir-catalog-trust-state.js', import.meta.url), 'utf8');
const catalogSource = fs.readFileSync(new URL('../swir-packages.js', import.meta.url), 'utf8');
const swSource = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const v17Source = fs.readFileSync(new URL('../swir-v17.js', import.meta.url), 'utf8');

const storage=new Map();
const sandbox = {
  console,
  crypto:webcrypto,
  TextEncoder,
  Uint8Array,
  ArrayBuffer,
  atob:value=>Buffer.from(String(value),'base64').toString('binary'),
  btoa:value=>Buffer.from(String(value),'binary').toString('base64'),
  SwirPlatform:{storage:{
    async get(key,fallback=null){return storage.has(key)?structuredClone(storage.get(key)):fallback},
    async set(key,value){storage.set(key,structuredClone(value));return value}
  }}
};
sandbox.globalThis=sandbox;
sandbox.window=sandbox;
vm.createContext(sandbox);
vm.runInContext(catalogSource, sandbox, { filename:'swir-packages.js', timeout:1000 });
vm.runInContext(source, sandbox, { filename:'swir-catalog-integrity.js', timeout:1000 });
vm.runInContext(trustStateSource, sandbox, { filename:'swir-catalog-trust-state.js', timeout:1000 });

const svc=sandbox.SwirCatalogIntegrity;
const trustState=sandbox.SwirCatalogTrustState;
if(!svc) throw new Error('SwirCatalogIntegrity was not registered');
if(!trustState) throw new Error('SwirCatalogTrustState was not registered');
if(svc.meta.schema!=='swir.catalog-signature/1.0') throw new Error('Unexpected catalog signature schema');
if(svc.meta.version!=='1.1.0') throw new Error(`Unexpected catalog verifier version: ${svc.meta.version}`);
if(svc.meta.algorithm!=='Ed25519'||svc.meta.failClosed!==true) throw new Error('Catalog verifier must be Ed25519 and fail-closed');
if(svc.meta.freshnessRequired!==true||svc.meta.antiRollback!==true) throw new Error('Catalog verifier must advertise freshness and anti-rollback policy');
if(trustState.meta.schema!=='swir.catalog-trust-state/1.0'||trustState.meta.antiRollback!==true) throw new Error('Catalog trust-state contract is invalid');

const catalog=JSON.parse(JSON.stringify(sandbox.SWIR_PACKAGE_CATALOG));
if(!Array.isArray(catalog)||!catalog.length) throw new Error('Official package catalog is empty');

const pair=await webcrypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);
const publicRaw=Buffer.from(await webcrypto.subtle.exportKey('raw',pair.publicKey)).toString('base64');
const keyId='ci-ephemeral-catalog-key';
const trustStore={
  trustedFor(id,scope){
    if(id!==keyId) return {ok:false,state:'UNKNOWN_KEY',error:'Signing key is not trusted'};
    if(scope!=='catalog:official') return {ok:false,state:'OUT_OF_SCOPE',error:'Wrong scope'};
    return {ok:true,state:'TRUSTED',key:{keyId,name:'CI Ephemeral Catalog Key',algorithm:'Ed25519',format:'raw',publicKey:publicRaw,scope:['catalog:official']}};
  }
};

const verificationNow=Date.parse('2026-09-13T08:00:00Z');
async function signEnvelope(overrides={}){
  const envelope={
    schema:'swir.catalog-signature/1.0',
    catalogId:'official',
    catalogVersion:'2026.09.13.1',
    sequence:41,
    generatedAt:'2026-09-13T07:55:00Z',
    expiresAt:'2026-09-14T07:55:00Z',
    algorithm:'Ed25519',
    keyId,
    catalogSha256:await svc.fingerprintCatalog(catalog),
    signature:'',
    ...overrides
  };
  const signature=await webcrypto.subtle.sign({name:'Ed25519'},pair.privateKey,new TextEncoder().encode(svc.signedPayload(envelope)));
  envelope.signature=Buffer.from(signature).toString('base64');
  return envelope;
}

const envelope=await signEnvelope();
const valid=await svc.verify(envelope,catalog,trustStore,{now:verificationNow,minimumSequence:40});
if(!valid.ok||valid.state!=='VERIFIED') throw new Error(`Valid catalog signature rejected: ${JSON.stringify(valid)}`);
if(valid.policy?.state!=='FRESH'||valid.sequence!==41) throw new Error('Valid signature did not retain freshness policy metadata');

const tampered=JSON.parse(JSON.stringify(catalog));
tampered[0]={...tampered[0],version:'9999.0.0'};
const tamperResult=await svc.verify(envelope,tampered,trustStore,{now:verificationNow});
if(tamperResult.ok||tamperResult.state!=='CATALOG_MISMATCH') throw new Error('Tampered catalog was not rejected');

const unknownResult=await svc.verify({...envelope,keyId:'unknown-key'},catalog,trustStore,{now:verificationNow});
if(unknownResult.ok||unknownResult.state!=='UNKNOWN_KEY') throw new Error('Unknown catalog signing key was not rejected');

const badSignature={...envelope,signature:Buffer.alloc(64,7).toString('base64')};
const badSignatureResult=await svc.verify(badSignature,catalog,trustStore,{now:verificationNow});
if(badSignatureResult.ok||badSignatureResult.state!=='BAD_SIGNATURE') throw new Error('Bad catalog signature was not rejected');

const expired=await signEnvelope({sequence:42,generatedAt:'2026-09-11T07:00:00Z',expiresAt:'2026-09-12T07:00:00Z'});
const expiredResult=await svc.verify(expired,catalog,trustStore,{now:verificationNow,maxClockSkewMs:0});
if(expiredResult.ok||expiredResult.state!=='EXPIRED') throw new Error(`Expired catalog metadata was not rejected: ${JSON.stringify(expiredResult)}`);

const future=await signEnvelope({sequence:42,generatedAt:'2026-09-13T09:00:00Z',expiresAt:'2026-09-14T09:00:00Z'});
const futureResult=await svc.verify(future,catalog,trustStore,{now:verificationNow,maxClockSkewMs:60_000});
if(futureResult.ok||futureResult.state!=='FUTURE_METADATA') throw new Error('Future-dated catalog metadata was not rejected');

const rollback=await signEnvelope({sequence:39,catalogVersion:'2026.09.12.9'});
const rollbackResult=await svc.verify(rollback,catalog,trustStore,{now:verificationNow,minimumSequence:40});
if(rollbackResult.ok||rollbackResult.state!=='ROLLBACK_DETECTED') throw new Error('Catalog rollback was not rejected');

const equivocationDigest='f'.repeat(64);
const equivocationResult=await svc.verify(envelope,catalog,trustStore,{now:verificationNow,minimumSequence:41,minimumDigestAtSequence:equivocationDigest});
if(equivocationResult.ok||equivocationResult.state!=='EQUIVOCATION_DETECTED') throw new Error('Same-sequence catalog equivocation was not rejected');

const sameHighWaterResult=await svc.verify(envelope,catalog,trustStore,{now:verificationNow,minimumSequence:41,minimumDigestAtSequence:envelope.catalogSha256});
if(!sameHighWaterResult.ok||sameHighWaterResult.state!=='VERIFIED') throw new Error('Matching high-water mark should remain valid');

const malformed={...envelope,sequence:0};
const malformedResult=await svc.verify(malformed,catalog,trustStore,{now:verificationNow});
if(malformedResult.ok||malformedResult.state!=='INVALID_DESCRIPTOR') throw new Error('Non-positive catalog sequence was not rejected');

const accepted41=await trustState.verifyAndAccept(envelope,catalog,trustStore,{now:verificationNow});
if(!accepted41.ok||!accepted41.accepted||accepted41.trustState?.sequence!==41) throw new Error('Verified catalog was not persisted as trust high-water mark');
const persisted41=await trustState.state();
if(persisted41?.sequence!==41||persisted41.catalogSha256!==envelope.catalogSha256) throw new Error('Catalog high-water mark did not persist');

const envelope42=await signEnvelope({sequence:42,catalogVersion:'2026.09.13.2'});
const accepted42=await trustState.verifyAndAccept(envelope42,catalog,trustStore,{now:verificationNow});
if(!accepted42.ok||accepted42.trustState?.sequence!==42||accepted42.previous?.sequence!==41) throw new Error('Catalog high-water mark did not advance monotonically');

const replay41=await trustState.verifyAndAccept(envelope,catalog,trustStore,{now:verificationNow});
if(replay41.ok||replay41.state!=='ROLLBACK_DETECTED'||replay41.accepted!==false) throw new Error('Persisted trust state failed to block replay of older signed catalog');
const afterReplay=await trustState.state();
if(afterReplay?.sequence!==42) throw new Error('Rejected rollback modified persisted trust state');

if(!swSource.includes("'./swir-catalog-integrity.js'")) throw new Error('Catalog integrity core is missing from service-worker cache');
if(!swSource.includes("'./swir-catalog-trust-state.js'")) throw new Error('Catalog trust-state core is missing from service-worker cache');
if(!swSource.includes("'./SWIR-SIGNED-CATALOG-1.0.md'")) throw new Error('Signed catalog contract is missing from service-worker cache');
if(!v17Source.includes("load('./swir-catalog-integrity.js')")) throw new Error('SWIR 1.7 security core does not load catalog integrity service');
if(!v17Source.includes("load('./swir-catalog-trust-state.js')")) throw new Error('SWIR 1.7 security core does not load catalog trust-state service');
if(!v17Source.includes('TRUST HIGH-WATER')) throw new Error('Catalog trust high-water diagnostics are missing');

console.log(`Signed catalog contract OK: ${catalog.length} packages, high-water sequence ${afterReplay.sequence}, digest ${afterReplay.catalogSha256}`);
