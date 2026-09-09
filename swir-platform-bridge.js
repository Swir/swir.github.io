/* SWIR OS 1.3 — legacy Web app compatibility bridge */
(() => {
  'use strict';
  const VFS_KEY='swir-vfs-v12';
  const NOTES_KEY='swir-notes-v12';

  function parse(key,fallback=[]){try{const v=JSON.parse(localStorage.getItem(key)||'null');return v??fallback}catch{return fallback}}

  async function syncFiles(){
    const api=window.SwirPlatform;if(!api)return;
    const legacy=parse(VFS_KEY,[]);if(!Array.isArray(legacy))return;
    const current=await api.files.list();
    const legacyIds=new Set(legacy.map(x=>x.id));
    for(const item of legacy) await api.files.save({...item,adapterSource:'legacy-v12'});
    for(const item of current){
      if(item?.id&&item.adapterSource==='legacy-v12'&&!legacyIds.has(item.id))await api.files.remove(item.id);
    }
    await api.storage.set('compat.vfs.lastSync',Date.now());
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
    await syncFiles();await syncNotes();
  }

  window.addEventListener('storage',event=>{
    if(event.key===VFS_KEY)syncFiles();
    if(event.key===NOTES_KEY||event.key==='swir-notes-open')syncNotes();
  });

  window.SwirPlatformBridge={syncFiles,syncNotes};
  initial();
})();
