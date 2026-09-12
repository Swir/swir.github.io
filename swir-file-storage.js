/* SWIR OS File Explorer Storage Adapter 1.0 — IndexedDB Web + native Desktop */
(() => {
  'use strict';
  const SCHEMA='swir.file-explorer-state/1.0';
  const NATIVE_MANIFEST='.swir-file-explorer-v1.json';
  const DB_NAME='swir-file-explorer';
  const DB_VERSION=1;
  const STORE='state';
  const RECORD_KEY='explorer';
  let dbPromise=null;
  let provider='initializing';
  let revision=0;

  function normalize(items){
    if(!Array.isArray(items))return[];
    return items.filter(item=>item&&typeof item==='object').map(item=>item.type==='text'?{...item,type:'file',mime:'text/plain',encoding:'text',size:String(item.content||'').length}:item);
  }

  function parseState(value){
    if(!value)return null;
    const parsed=typeof value==='string'?JSON.parse(value):value;
    if(parsed.schema!==SCHEMA||!Array.isArray(parsed.items))throw new Error('Unsupported File Explorer storage schema');
    revision=Math.max(revision,Number.isSafeInteger(parsed.revision)?parsed.revision:0);
    return {schema:SCHEMA,version:1,revision:Number.isSafeInteger(parsed.revision)?parsed.revision:0,updatedAt:parsed.updatedAt||null,items:normalize(parsed.items)};
  }

  function makeState(items,nextRevision){
    return {schema:SCHEMA,version:1,revision:nextRevision,updatedAt:new Date().toISOString(),items:normalize(items)};
  }

  async function waitForRuntime(timeoutMs=5000){
    const started=Date.now();
    while(!window.SwirRuntime?.filesystem&&Date.now()-started<timeoutMs)await new Promise(resolve=>setTimeout(resolve,25));
    return window.SwirRuntime?.filesystem||null;
  }

  async function nativeFilesystem(){
    const fs=await waitForRuntime();
    if(!fs?.info)return null;
    try{const info=await fs.info();return info?.native===true||info?.provider==='native-sandbox'?fs:null}catch{return null}
  }

  function openDb(){
    if(dbPromise)return dbPromise;
    dbPromise=new Promise((resolve,reject)=>{
      if(!('indexedDB' in window))return reject(new Error('IndexedDB unavailable'));
      const request=indexedDB.open(DB_NAME,DB_VERSION);
      request.onupgradeneeded=()=>{const db=request.result;if(!db.objectStoreNames.contains(STORE))db.createObjectStore(STORE)};
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error||new Error('IndexedDB open failed'));
    });
    return dbPromise;
  }

  async function idbGet(){
    const db=await openDb();
    return new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readonly');const req=tx.objectStore(STORE).get(RECORD_KEY);req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error||new Error('IndexedDB read failed'))});
  }

  async function idbPut(state){
    const db=await openDb();
    await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).put(state,RECORD_KEY);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error||new Error('IndexedDB write failed'));tx.onabort=()=>reject(tx.error||new Error('IndexedDB write aborted'))});
  }

  async function load({legacyItems=[]}={}){
    const fs=await nativeFilesystem();
    if(fs){
      provider='desktop-native-manifest';
      const record=await fs.get(NATIVE_MANIFEST);
      if(record?.content)return parseState(record.content);
      const state=makeState(legacyItems,revision+1);
      await fs.save({id:NATIVE_MANIFEST,name:NATIVE_MANIFEST,content:JSON.stringify(state)});
      revision=state.revision;
      return state;
    }
    provider='web-indexeddb';
    let existing=null;
    try{existing=parseState(await idbGet())}catch(err){if(String(err?.message||err).includes('schema'))throw err;provider='web-memory-fallback'}
    if(existing)return existing;
    const state=makeState(legacyItems,revision+1);
    if(provider==='web-indexeddb')await idbPut(state);
    revision=state.revision;
    return state;
  }

  async function save(items){
    const fs=await nativeFilesystem();
    if(fs){
      provider='desktop-native-manifest';
      let current=null;
      try{const record=await fs.get(NATIVE_MANIFEST);if(record?.content)current=parseState(record.content)}catch{}
      const state=makeState(items,Math.max(revision,current?.revision||0)+1);
      await fs.save({id:NATIVE_MANIFEST,name:NATIVE_MANIFEST,content:JSON.stringify(state)});
      revision=state.revision;
      return state;
    }
    provider='web-indexeddb';
    let current=null;
    try{current=parseState(await idbGet())}catch{}
    const state=makeState(items,Math.max(revision,current?.revision||0)+1);
    await idbPut(state);
    revision=state.revision;
    return state;
  }

  window.SwirFileStorage={
    schema:SCHEMA,
    nativeManifest:NATIVE_MANIFEST,
    load,
    save,
    normalize,
    info:()=>({provider,schema:SCHEMA,nativeManifest:provider==='desktop-native-manifest'?NATIVE_MANIFEST:null,revision,database:provider==='web-indexeddb'?DB_NAME:null})
  };
})();
