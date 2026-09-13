/* SWIR Catalog Integrity 1.0 — signed official catalog metadata verification */
(() => {
  'use strict';

  const SCHEMA='swir.catalog-signature/1.0';
  const VERSION='1.0.0';
  const CATALOG_ID='official';

  function stable(value){
    if(Array.isArray(value))return value.map(stable);
    if(value&&typeof value==='object')return Object.keys(value).sort().reduce((out,key)=>{if(value[key]!==undefined)out[key]=stable(value[key]);return out},{});
    return value;
  }
  function canonicalize(value){return JSON.stringify(stable(value))}
  function toBytes(value){
    if(value instanceof Uint8Array)return value;
    if(value instanceof ArrayBuffer)return new Uint8Array(value);
    if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
    return new TextEncoder().encode(typeof value==='string'?value:canonicalize(value));
  }
  function hex(buffer){return Array.from(new Uint8Array(buffer),b=>b.toString(16).padStart(2,'0')).join('')}
  function base64Bytes(value){
    const raw=atob(String(value||'').replace(/^base64:/i,'').replace(/\s+/g,''));
    const out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out;
  }
  function normalizeDigest(value){return String(value||'').trim().toLowerCase().replace(/^sha256[-:]/,'')}
  function catalogView(catalog=globalThis.SWIR_PACKAGE_CATALOG){
    if(!Array.isArray(catalog))throw new Error('Package catalog must be an array');
    return catalog.map(pkg=>stable(pkg)).sort((a,b)=>String(a.packageId||a.id||'').localeCompare(String(b.packageId||b.id||''))||String(a.version||'').localeCompare(String(b.version||'')));
  }
  async function sha256(value){
    if(!globalThis.crypto?.subtle)throw new Error('Web Crypto unavailable');
    return hex(await crypto.subtle.digest('SHA-256',toBytes(value)));
  }
  async function fingerprintCatalog(catalog=globalThis.SWIR_PACKAGE_CATALOG){return sha256(canonicalize(catalogView(catalog)))}
  function validateEnvelope(envelope){
    const errors=[];
    if(!envelope||typeof envelope!=='object')errors.push('catalog signature envelope required');
    else{
      if(envelope.schema!==SCHEMA)errors.push(`schema must be ${SCHEMA}`);
      if(!envelope.catalogId)errors.push('catalogId required');
      if(!envelope.catalogVersion)errors.push('catalogVersion required');
      if(envelope.algorithm!=='Ed25519')errors.push('algorithm must be Ed25519');
      if(!envelope.keyId)errors.push('keyId required');
      if(!/^[a-f0-9]{64}$/i.test(normalizeDigest(envelope.catalogSha256)))errors.push('valid catalogSha256 required');
      if(!envelope.signature)errors.push('signature required');
    }
    return {ok:errors.length===0,errors,schema:SCHEMA};
  }
  function signedPayload(envelope){
    return canonicalize({
      schema:SCHEMA,
      catalogId:String(envelope.catalogId),
      catalogVersion:String(envelope.catalogVersion),
      catalogSha256:normalizeDigest(envelope.catalogSha256),
      generatedAt:String(envelope.generatedAt||'')
    });
  }
  async function importEd25519Key(record){
    if(!globalThis.crypto?.subtle)throw new Error('Web Crypto unavailable');
    if(record.format==='jwk')return crypto.subtle.importKey('jwk',record.publicKey,{name:'Ed25519'},false,['verify']);
    const bytes=base64Bytes(record.publicKey);
    return crypto.subtle.importKey(record.format==='spki'?'spki':'raw',bytes,{name:'Ed25519'},false,['verify']);
  }
  async function verify(envelope,catalog=globalThis.SWIR_PACKAGE_CATALOG,trustStore=globalThis.SwirTrustedKeys){
    const descriptor=validateEnvelope(envelope);
    if(!descriptor.ok)return {ok:false,state:'INVALID_DESCRIPTOR',errors:descriptor.errors};
    if(String(envelope.catalogId)!==CATALOG_ID)return {ok:false,state:'CATALOG_ID_MISMATCH',error:'Unsupported catalog id'};
    const actual=await fingerprintCatalog(catalog);
    const expected=normalizeDigest(envelope.catalogSha256);
    if(actual!==expected)return {ok:false,state:'CATALOG_MISMATCH',expected,actual,error:'Signed catalog digest mismatch'};
    if(!trustStore?.trustedFor)return {ok:false,state:'TRUST_STORE_UNAVAILABLE',expected,actual,error:'Trusted Key Store unavailable'};
    const trust=trustStore.trustedFor(envelope.keyId,`catalog:${envelope.catalogId}`);
    if(!trust.ok)return {ok:false,state:trust.state,keyId:envelope.keyId,expected,actual,error:trust.error};
    try{
      const key=await importEd25519Key(trust.key);
      const ok=await crypto.subtle.verify({name:'Ed25519'},key,base64Bytes(envelope.signature),toBytes(signedPayload(envelope)));
      return {ok,state:ok?'VERIFIED':'BAD_SIGNATURE',algorithm:'Ed25519',keyId:envelope.keyId,publisher:trust.key.name,expected,actual,error:ok?null:'Cryptographic catalog signature verification failed'};
    }catch(error){
      return {ok:false,state:'CRYPTO_UNAVAILABLE',algorithm:'Ed25519',keyId:envelope.keyId,expected,actual,error:error?.message||String(error)};
    }
  }
  async function describe(catalog=globalThis.SWIR_PACKAGE_CATALOG){
    const items=catalogView(catalog);
    return {schema:SCHEMA,version:VERSION,catalogId:CATALOG_ID,packages:items.length,catalogSha256:await fingerprintCatalog(items),algorithm:'Ed25519',trustScope:`catalog:${CATALOG_ID}`};
  }

  globalThis.SwirCatalogIntegrity=Object.freeze({
    meta:Object.freeze({name:'SWIR Catalog Integrity',version:VERSION,schema:SCHEMA,algorithm:'Ed25519',catalogId:CATALOG_ID,failClosed:true}),
    canonicalize,catalogView,fingerprintCatalog,validateEnvelope,signedPayload,verify,describe
  });
})();
