/* SWIR OS 1.7 — legacy Web app compatibility + Desktop persistence bridge */
(() => {
  'use strict';
  const VFS_KEY='swir-vfs-v12';
  const NOTES_KEY='swir-notes-v12';
  const NATIVE_VFS_MANIFEST='.swir-file-explorer-v1.json';
  const NATIVE_VFS_SCHEMA='swir.file-explorer-state/1.0';
  let fileSyncInFlight=null;
  let fileSyncQueued=false;
  let hydrateNativeQueued=false;
  let fileProvider='web-platform';
  let lastNativeRevision=0;

  function parse(key,fallback=[]){try{const v=JSON.parse(localStorage.getItem(key)||'null');return v??fallback}catch{return fallback}}
  function normalizeFiles(value){
    if(!Array.isArray(value))return[];
    return value.filter(item=>item&&typeof item==='object').map(item=>item.type==='text'?{...item,type:'file',mime:'text/plain',encoding:'text',size:String(item.content||'').length}:item);
  }

  async function waitForRuntime(timeoutMs=5000){
    const started=Date.now();
    while(!window.SwirRuntime?.filesystem&&Date.now()-started<timeoutMs)await new Promise(resolve=>setTimeout(resolve,25));
    return window.SwirRuntime?.filesystem||null;
  }

  async function nativeFilesystem(){
    const filesystem=await waitForRuntime();
    if(!filesystem?.info)return null;
    try{
      const info=await filesystem.info();
      return info?.native===true||info?.provider==='native-sandbox'?filesystem:null;
    }catch{return null}
  }

  function parseNativeExplorerState(record){
    if(!record?.content)return null;
    let parsed;
    try{parsed=JSON.parse(record.content)}catch{throw new Error('Native File Explorer state is not valid JSON')}
    if(parsed?.schema!==NATIVE_VFS_SCHEMA||!Array.isArray(parsed.items))throw new Error('Native File Explorer state has an unsupported schema');
    const revision=Number.isSafeInteger(parsed.revision)&&parsed.revision>=0?parsed.revision:0;
    lastNativeRevision=Math.max(lastNativeRevision,revision);
    return {items:normalizeFiles(parsed.items),revision,updatedAt:parsed.updatedAt||null};
  }

  async function loadNativeExplorerState(filesystem){
    return parseNativeExplorerState(await filesystem.get(NATIVE_VFS_MANIFEST));
  }

  async function saveNativeExplorerState(filesystem,items){
    const normalized=normalizeFiles(items);
    let persistedRevision=lastNativeRevision;
    try{
      const current=parseNativeExplorerState(await filesystem.get(NATIVE_VFS_MANIFEST));
      if(current)persistedRevision=Math.max(persistedRevision,current.revision);
    }catch{
      // Existing malformed state is surfaced by hydrate. During a later save we still
      // replace it atomically through the hardened native filesystem broker.
    }
    const revision=persistedRevision+1;
    const content=JSON.stringify({schema:NATIVE_VFS_SCHEMA,version:1,revision,updatedAt:new Date().toISOString(),items:normalized});
    await filesystem.save({id:NATIVE_VFS_MANIFEST,name:NATIVE_VFS_MANIFEST,content});
    lastNativeRevision=revision;
    return {items:normalized,revision};
  }

  async function syncPlatformFiles(items){
    const api=window.SwirPlatform;if(!api?.files)return;
    const current=await api.files.list();
    const legacyIds=new Set(items.map(x=>x.id).filter(Boolean));
    for(const item of items)await api.files.save({...item,adapterSource:'legacy-v12'});
    for(const item of current){
      if(item?.id&&item.adapterSource==='legacy-v12'&&!legacyIds.has(item.id))await api.files.remove(item.id);
    }
  }

  async function performFileSync({hydrateNative=false}={}){
    const api=window.SwirPlatform;if(!api)return;
    await api.ready;
    let legacy=normalizeFiles(parse(VFS_KEY,[]));
    const filesystem=await nativeFilesystem();

    if(filesystem){
      fileProvider='desktop-native-manifest';
      if(hydrateNative){
        const nativeState=await loadNativeExplorerState(filesystem);
        if(nativeState!==null){
          legacy=nativeState.items;
          localStorage.setItem(VFS_KEY,JSON.stringify(nativeState.items));
        }else{
          await saveNativeExplorerState(filesystem,legacy);
        }
      }else{
        await saveNativeExplorerState(filesystem,legacy);
      }
    }else{
      fileProvider='web-platform';
    }

    await syncPlatformFiles(legacy);
    await api.storage.set('compat.vfs.lastSync',Date.now());
    await api.storage.set('compat.vfs.provider',fileProvider);
    await api.storage.set('compat.vfs.nativeRevision',lastNativeRevision);
    return {provider:fileProvider,count:legacy.length,nativeManifest:filesystem?NATIVE_VFS_MANIFEST:null,revision:lastNativeRevision};
  }

  async function drainFileSyncQueue(){
    let result=null;
    do{
      const hydrateNative=hydrateNativeQueued;
      fileSyncQueued=false;
      hydrateNativeQueued=false;
      result=await performFileSync({hydrateNative});
    }while(fileSyncQueued||hydrateNativeQueued);
    return result;
  }

  function syncFiles(options={}){
    fileSyncQueued=true;
    if(options.hydrateNative)hydrateNativeQueued=true;
    if(fileSyncInFlight)return fileSyncInFlight;
    fileSyncInFlight=drainFileSyncQueue().finally(()=>{fileSyncInFlight=null});
    return fileSyncInFlight;
  }

  async function syncNotes(){
    const api=window.SwirPlatform;if(!api)return;
    const notes=parse(NOTES_KEY,[]);if(!Array.isArray(notes))return;
    await api.storage.set('notes.list',notes.map(note=>({...note,adapterSource:'legacy-v12'})));
    await api.storage.set('notes.active',localStorage.getItem('swir-notes-open')||null);
    await api.storage.set('compat.notes.lastSync',Date.now());
  }

  async function initial(){
    if(!window.SwirPlatform){setTimeout(initial,50);return}
    await window.SwirPlatform.ready;
    await syncFiles({hydrateNative:true});
    await syncNotes();
  }

  window.addEventListener('storage',event=>{
    if(event.key===VFS_KEY)syncFiles().catch(()=>{});
    if(event.key===NOTES_KEY||event.key==='swir-notes-open')syncNotes().catch(()=>{});
  });

  window.SwirPlatformBridge={
    syncFiles,
    syncNotes,
    storageInfo:()=>({provider:fileProvider,nativeManifest:fileProvider==='desktop-native-manifest'?NATIVE_VFS_MANIFEST:null,schema:NATIVE_VFS_SCHEMA,revision:lastNativeRevision,syncing:!!fileSyncInFlight,queued:fileSyncQueued||hydrateNativeQueued})
  };
  initial();
})();
