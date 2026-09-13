/* SWIR Catalog Integrity 1.1 — signed official catalog metadata verification */
(() => {
  'use strict';

  const SCHEMA='swir.catalog-signature/1.0';
  const VERSION='1.1.0';
  const CATALOG_ID='official';
  const DEFAULT_MAX_CLOCK_SKEW_MS=5*60*1000;

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
  function validIsoInstant(value){const text=String(value||'');const ms=Date.parse(text);return !!text&&Number.isFinite(ms)&&/Z$/i.test(text)?ms:null}
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
      if(!Number.isSafeInteger(envelope.sequence)||envelope.sequence<1)errors.push('positive integer sequence required');
      const generatedAt=validIsoInstant(envelope.generatedAt);
      const expiresAt=validIsoInstant(envelope.expiresAt);
      if(generatedAt===null)errors.push('generatedAt must be an ISO UTC instant');
      if(expiresAt===null)errors.push('expiresAt must be an ISO UTC instant');
      if(generatedAt!==null&&expiresAt!==null&&expiresAt<=generatedAt)errors.push('expiresAt must be after generatedAt');
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
      sequence:Number(envelope.sequence),
      catalogSha256:normalizeDigest(envelope.catalogSha256),
      generatedAt:String(envelope.generatedAt||''),
      expiresAt:String(envelope.expiresAt||'')
    });
  }
  function verifyPolicy(envelope,policy={}){
    const now=Number.isFinite(policy.now)?Number(policy.now):Date.now();
    const skew=Number.isFinite(policy.maxClockSkewMs)?Math.max(0,Number(policy.maxClockSkewMs)):DEFAULT_MAX_CLOCK_SKEW_MS;
    const generatedAt=validIsoInstant(envelope?.generatedAt);
    const expiresAt=validIsoInstant(envelope?.expiresAt);
    const sequence=Number(envelope?.sequence);
    if(generatedAt===null||expiresAt===null||!Number.isSafeInteger(sequence)||sequence<1)return {ok:false,state:'INVALID_POLICY_METADATA',error:'Catalog policy metadata is invalid'};
    if(generatedAt>now+skew)return {ok:false,state:'FUTURE_METADATA',generatedAt,now,error:'Catalog metadata is dated too far in the future'};
    if(expiresAt<now-skew)return {ok:false,state:'EXPIRED',expiresAt,now,error:'Catalog metadata has expired'};
    const minimumSequence=Number.isSafeInteger(policy.minimumSequence)?Number(policy.minimumSequence):0;
    if(sequence<minimumSequence)return {ok:false,state:'ROLLBACK_DETECTED',sequence,minimumSequence,error:'Catalog sequence is older than the trusted high-water mark'};
    const minimumDigest=normalizeDigest(policy.minimumDigestAtSequence||'');
    const actualDigest=normalizeDigest(envelope?.catalogSha256||'');
    if(sequence===minimumSequence&&minimumSequence>0&&minimumDigest&&minimumDigest!==actualDigest){
      return {ok:false,state:'EQUIVOCATION_DETECTED',sequence,expectedDigest:minimumDigest,actualDigest,error:'Catalog sequence was reused with different signed content'};
    }
    return {ok:true,state:'FRESH',sequence,minimumSequence,generatedAt,expiresAt,now,maxClockSkewMs:skew};
  }
  async function importEd25519Key(record){
    if(!globalThis.crypto?.subtle)throw new Error('Web Crypto unavailable');
    if(record.format==='jwk')return crypto.subtle.importKey('jwk',record.publicKey,{name:'Ed25519'},false,['verify']);
    const bytes=base64Bytes(record.publicKey);
    return crypto.subtle.importKey(record.format==='spki'?'spki':'raw',bytes,{name:'Ed25519'},false,['verify']);
  }
  async function verify(envelope,catalog=globalThis.SWIR_PACKAGE_CATALOG,trustStore=globalThis.SwirTrustedKeys,policy={}){
    const descriptor=validateEnvelope(envelope);
    if(!descriptor.ok)return {ok:false,state:'INVALID_DESCRIPTOR',errors:descriptor.errors};
    if(String(envelope.catalogId)!==CATALOG_ID)return {ok:false,state:'CATALOG_ID_MISMATCH',error:'Unsupported catalog id'};
    const policyResult=verifyPolicy(envelope,policy);
    if(!policyResult.ok)return policyResult;
    const actual=await fingerprintCatalog(catalog);
    const expected=normalizeDigest(envelope.catalogSha256);
    if(actual!==expected)return {ok:false,state:'CATALOG_MISMATCH',expected,actual,error:'Signed catalog digest mismatch'};
    if(!trustStore?.trustedFor)return {ok:false,state:'TRUST_STORE_UNAVAILABLE',expected,actual,error:'Trusted Key Store unavailable'};
    const trust=trustStore.trustedFor(envelope.keyId,`catalog:${envelope.catalogId}`);
    if(!trust.ok)return {ok:false,state:trust.state,keyId:envelope.keyId,expected,actual,error:trust.error};
    try{
      const key=await importEd25519Key(trust.key);
      const ok=await crypto.subtle.verify({name:'Ed25519'},key,base64Bytes(envelope.signature),toBytes(signedPayload(envelope)));
      return {ok,state:ok?'VERIFIED':'BAD_SIGNATURE',algorithm:'Ed25519',keyId:envelope.keyId,publisher:trust.key.name,expected,actual,policy:policyResult,sequence:envelope.sequence,catalogVersion:String(envelope.catalogVersion),expiresAt:String(envelope.expiresAt),error:ok?null:'Cryptographic catalog signature verification failed'};
    }catch(error){
      return {ok:false,state:'CRYPTO_UNAVAILABLE',algorithm:'Ed25519',keyId:envelope.keyId,expected,actual,error:error?.message||String(error)};
    }
  }
  async function describe(catalog=globalThis.SWIR_PACKAGE_CATALOG){
    const items=catalogView(catalog);
    return {schema:SCHEMA,version:VERSION,catalogId:CATALOG_ID,packages:items.length,catalogSha256:await fingerprintCatalog(items),algorithm:'Ed25519',trustScope:`catalog:${CATALOG_ID}`,freshnessRequired:true,antiRollback:true};
  }

  globalThis.SwirCatalogIntegrity=Object.freeze({
    meta:Object.freeze({name:'SWIR Catalog Integrity',version:VERSION,schema:SCHEMA,algorithm:'Ed25519',catalogId:CATALOG_ID,failClosed:true,freshnessRequired:true,antiRollback:true}),
    canonicalize,catalogView,fingerprintCatalog,validateEnvelope,signedPayload,verifyPolicy,verify,describe
  });
})();
