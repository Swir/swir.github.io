import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = fs.readFileSync(new URL('../swir-catalog-integrity.js', import.meta.url), 'utf8');
const catalogSource = fs.readFileSync(new URL('../swir-packages.js', import.meta.url), 'utf8');
const swSource = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
const v17Source = fs.readFileSync(new URL('../swir-v17.js', import.meta.url), 'utf8');

const sandbox = {
  console,
  crypto:webcrypto,
  TextEncoder,
  Uint8Array,
  ArrayBuffer,
  atob:value=>Buffer.from(String(value),'base64').toString('binary'),
  btoa:value=>Buffer.from(String(value),'binary').toString('base64')
};
sandbox.globalThis=sandbox;
sandbox.window=sandbox;
vm.createContext(sandbox);
vm.runInContext(catalogSource, sandbox, { filename:'swir-packages.js', timeout:1000 });
vm.runInContext(source, sandbox, { filename:'swir-catalog-integrity.js', timeout:1000 });

const svc=sandbox.SwirCatalogIntegrity;
if(!svc) throw new Error('SwirCatalogIntegrity was not registered');
if(svc.meta.schema!=='swir.catalog-signature/1.0') throw new Error('Unexpected catalog signature schema');
if(svc.meta.algorithm!=='Ed25519'||svc.meta.failClosed!==true) throw new Error('Catalog verifier must be Ed25519 and fail-closed');

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

const envelope={
  schema:'swir.catalog-signature/1.0',
  catalogId:'official',
  catalogVersion:'ci-fixture-1',
  generatedAt:'2026-09-13T00:00:00Z',
  algorithm:'Ed25519',
  keyId,
  catalogSha256:await svc.fingerprintCatalog(catalog),
  signature:''
};
const signature=await webcrypto.subtle.sign({name:'Ed25519'},pair.privateKey,new TextEncoder().encode(svc.signedPayload(envelope)));
envelope.signature=Buffer.from(signature).toString('base64');

const valid=await svc.verify(envelope,catalog,trustStore);
if(!valid.ok||valid.state!=='VERIFIED') throw new Error(`Valid catalog signature rejected: ${JSON.stringify(valid)}`);

const tampered=JSON.parse(JSON.stringify(catalog));
tampered[0]={...tampered[0],version:'9999.0.0'};
const tamperResult=await svc.verify(envelope,tampered,trustStore);
if(tamperResult.ok||tamperResult.state!=='CATALOG_MISMATCH') throw new Error('Tampered catalog was not rejected');

const unknownResult=await svc.verify({...envelope,keyId:'unknown-key'},catalog,trustStore);
if(unknownResult.ok||unknownResult.state!=='UNKNOWN_KEY') throw new Error('Unknown catalog signing key was not rejected');

const badSignature={...envelope,signature:Buffer.alloc(64,7).toString('base64')};
const badSignatureResult=await svc.verify(badSignature,catalog,trustStore);
if(badSignatureResult.ok||badSignatureResult.state!=='BAD_SIGNATURE') throw new Error('Bad catalog signature was not rejected');

if(!swSource.includes("'./swir-catalog-integrity.js'")) throw new Error('Catalog integrity core is missing from service-worker cache');
if(!swSource.includes("'./SWIR-SIGNED-CATALOG-1.0.md'")) throw new Error('Signed catalog contract is missing from service-worker cache');
if(!v17Source.includes("load('./swir-catalog-integrity.js')")) throw new Error('SWIR 1.7 security core does not load catalog integrity service');
if(!v17Source.includes("cmd==='catalog'")) throw new Error('Catalog diagnostics command is missing');

console.log(`Signed catalog contract OK: ${catalog.length} packages, digest ${envelope.catalogSha256}`);
