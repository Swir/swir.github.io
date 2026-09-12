/* SWIR OS 1.7 — legacy Web app compatibility + edition-neutral storage bridge */
(() => {
  'use strict';
  const VFS_KEY='swir-vfs-v12';
  const NOTES_KEY='swir-notes-v12';
  let fileSyncInFlight=null;
  let fileSyncQueued=false;
  let hydrateQueued=false;
  let fileProvider='initializing';
  let lastRevision=0;

  function parse(key,fallback=[]){try{const v=JSON.parse(localStorage.getItem(key)||'null');return v??fallback}catch{return fallback}}
  function normalizeFiles(value){
    const storage=window.SwirFileStorage;
    if(storage?.normalize)return storage.normalize(value);
    if(!Array.isArray(value))return[];
    return value.filter(item=>item&&typeof item==='object').map(item=>item.type==='text'?{...item,type:'file',mime:'text/plain',encoding:'text',size:String(item.content||'').length}:item);
  }

  async function waitForStorage(timeoutMs=5000){
    const started=Date.now();
    while(!window.SwirFileStorage&&Date.now()-started<timeoutMs)await new Promise(resolve=>setTimeout(resolve,25));
    if(!window.SwirFileStorage)throw new Error('SWIR File Storage adapter unavailable');
    return window.SwirFileStorage;
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

  async function performFileSync({hydrate=false}={}){
    const api=window.SwirPlatform;if(!api)return;
    await api.ready;
    const storage=await waitForStorage();
    let items=normalizeFiles(parse(VFS_KEY,[]));
    let state;
    if(hydrate){
      state=await storage.load({legacyItems:items});
      items=normalizeFiles(state?.items||items);
      localStorage.setItem(VFS_KEY,JSON.stringify(items));
    }else{
      state=await storage.save(items);
      items=normalizeFiles(state?.items||items);
    }
    const info=storage.info();
    fileProvider=info.provider;
    lastRevision=state?.revision??info.revision??lastRevision;
    await syncPlatformFiles(items);
    await api.storage.set('compat.vfs.lastSync',Date.now());
    await api.storage.set('compat.vfs.provider',fileProvider);
    await api.storage.set('compat.vfs.revision',lastRevision);
    return {provider:fileProvider,count:items.length,nativeManifest:info.nativeManifest||null,database:info.database||null,revision:lastRevision};
  }

  async function drainFileSyncQueue(){
    let result=null;
    do{
      const hydrate=hydrateQueued;
      fileSyncQueued=false;
      hydrateQueued=false;
      result=await performFileSync({hydrate});
    }while(fileSyncQueued||hydrateQueued);
    return result;
  }

  function syncFiles(options={}){
    fileSyncQueued=true;
    if(options.hydrateNative||options.hydrate)hydrateQueued=true;
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
    await syncFiles({hydrate:true});
    await syncNotes();
  }

  window.addEventListener('storage',event=>{
    if(event.key===VFS_KEY)syncFiles().catch(()=>{});
    if(event.key===NOTES_KEY||event.key==='swir-notes-open')syncNotes().catch(()=>{});
  });

  window.SwirPlatformBridge={
    syncFiles,
    syncNotes,
    storageInfo:()=>({...(window.SwirFileStorage?.info?.()||{}),provider:fileProvider,revision:lastRevision,syncing:!!fileSyncInFlight,queued:fileSyncQueued||hydrateQueued})
  };
  initial();
})();
