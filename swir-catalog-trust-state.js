/* SWIR Catalog Trust State 1.0 — persistent anti-rollback admission state */
(() => {
  'use strict';

  const SCHEMA='swir.catalog-trust-state/1.0';
  const VERSION='1.0.0';
  const STORAGE_KEY='security.catalog.official.v1';

  const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
  const normalizeDigest=value=>String(value||'').trim().toLowerCase().replace(/^sha256[-:]/,'');

  async function storageGet(){
    const api=globalThis.SwirPlatform?.storage;
    if(api?.get)return api.get(STORAGE_KEY,null);
    try{return JSON.parse(localStorage.getItem(STORAGE_KEY)||'null')}catch{return null}
  }

  async function storageSet(value){
    const api=globalThis.SwirPlatform?.storage;
    if(api?.set){await api.set(STORAGE_KEY,value);return value}
    localStorage.setItem(STORAGE_KEY,JSON.stringify(value));
    return value;
  }

  function normalize(value){
    if(!value||typeof value!=='object')return null;
    const sequence=Number(value.sequence);
    const catalogSha256=normalizeDigest(value.catalogSha256);
    if(value.schema!==SCHEMA||value.catalogId!=='official'||!Number.isSafeInteger(sequence)||sequence<1||!/^[a-f0-9]{64}$/.test(catalogSha256))return null;
    return {
      schema:SCHEMA,
      catalogId:'official',
      catalogVersion:String(value.catalogVersion||''),
      sequence,
      catalogSha256,
      keyId:String(value.keyId||''),
      generatedAt:String(value.generatedAt||''),
      expiresAt:String(value.expiresAt||''),
      acceptedAt:Number(value.acceptedAt||0)
    };
  }

  async function state(){return clone(normalize(await storageGet()))}

  async function verifyAndAccept(envelope,catalog=globalThis.SWIR_PACKAGE_CATALOG,trustStore=globalThis.SwirTrustedKeys,options={}){
    const verifier=globalThis.SwirCatalogIntegrity;
    if(!verifier?.verify)throw new Error('Catalog Integrity service unavailable');
    const previous=normalize(await storageGet());
    const policy={...options};
    if(previous){
      policy.minimumSequence=previous.sequence;
      policy.minimumDigestAtSequence=previous.catalogSha256;
    }
    const result=await verifier.verify(envelope,catalog,trustStore,policy);
    if(!result.ok)return Object.freeze({...result,accepted:false,previous:clone(previous)});
    const next=normalize({
      schema:SCHEMA,
      catalogId:'official',
      catalogVersion:envelope.catalogVersion,
      sequence:envelope.sequence,
      catalogSha256:envelope.catalogSha256,
      keyId:envelope.keyId,
      generatedAt:envelope.generatedAt,
      expiresAt:envelope.expiresAt,
      acceptedAt:Date.now()
    });
    if(!next)throw new Error('Verified catalog produced invalid trust state');
    await storageSet(next);
    return Object.freeze({...result,accepted:true,previous:clone(previous),trustState:clone(next)});
  }

  async function describe(){
    const current=await state();
    return {schema:SCHEMA,version:VERSION,storageKey:STORAGE_KEY,catalogId:'official',persisted:!!current,current};
  }

  globalThis.SwirCatalogTrustState=Object.freeze({
    meta:Object.freeze({name:'SWIR Catalog Trust State',version:VERSION,schema:SCHEMA,catalogId:'official',antiRollback:true}),
    state,verifyAndAccept,describe
  });
})();
