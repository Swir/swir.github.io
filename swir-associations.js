/* SWIR OS 1.7 — File Associations & Open-With service */
(() => {
  'use strict';
  const KEY='swir-file-associations-v1';
  const catalog=()=>Array.isArray(window.SWIR_PACKAGE_CATALOG)?window.SWIR_PACKAGE_CATALOG:[];
  const installed=()=>{try{const v=JSON.parse(localStorage.getItem('swir-installed-apps')||'[]');return new Set(Array.isArray(v)?v:[])}catch{return new Set()}};
  const ext=name=>{const m=String(name||'').toLowerCase().match(/(\.[a-z0-9]+)$/);return m?m[1]:''};
  const read=()=>{try{const v=JSON.parse(localStorage.getItem(KEY)||'{}');return v&&typeof v==='object'?v:{}}catch{return{}}};
  const write=v=>{localStorage.setItem(KEY,JSON.stringify(v));window.dispatchEvent(new CustomEvent('swir:associations-change',{detail:v}))};
  function handlersFor(nameOrExt){
    const e=String(nameOrExt||'').startsWith('.')?String(nameOrExt).toLowerCase():ext(nameOrExt),on=installed();
    return catalog().filter(p=>on.has(p.id)&&(p.associations||[]).map(x=>String(x).toLowerCase()).includes(e));
  }
  function defaultFor(nameOrExt){
    const e=String(nameOrExt||'').startsWith('.')?String(nameOrExt).toLowerCase():ext(nameOrExt),handlers=handlersFor(e),saved=read()[e];
    return handlers.find(x=>x.id===saved)||handlers[0]||null;
  }
  function setDefault(extension,appId){
    const e=String(extension||'').toLowerCase();
    if(!e.startsWith('.'))throw new Error('Invalid extension');
    const handlers=handlersFor(e);if(!handlers.some(x=>x.id===appId))throw new Error('App does not handle this file type');
    const map=read();map[e]=appId;write(map);return true;
  }
  function clearDefault(extension){const e=String(extension||'').toLowerCase(),map=read();delete map[e];write(map)}
  function pendingKey(id){return `swir-open-file:${id}`}
  async function openFile(file,preferredId=null){
    if(!file||!file.name)throw new Error('Invalid file');
    const handlers=handlersFor(file.name),app=preferredId?handlers.find(x=>x.id===preferredId):defaultFor(file.name);
    if(!app)throw new Error(`No installed application handles ${ext(file.name)||'this file type'}`);
    const payload={...file,openedAt:Date.now(),association:ext(file.name)};
    localStorage.setItem(pendingKey(app.id),JSON.stringify(payload));
    try{await window.SwirPlatform?.storage?.set?.(`open-file.${app.id}`,payload)}catch{}
    window.SwirOS?.open?.(app.id);
    setTimeout(()=>{
      const frame=document.querySelector(`.os-window[data-window="${CSS.escape(app.id)}"] iframe`);
      try{frame?.contentWindow?.postMessage({type:'SWIR_OPEN_FILE',appId:app.id,file:payload},location.origin)}catch{}
    },160);
    return app;
  }
  async function consume(appId){
    let payload=null;try{payload=JSON.parse(localStorage.getItem(pendingKey(appId))||'null')}catch{}
    if(!payload){try{payload=await window.SwirPlatform?.storage?.get?.(`open-file.${appId}`,null)}catch{}}
    localStorage.removeItem(pendingKey(appId));try{await window.SwirPlatform?.storage?.remove?.(`open-file.${appId}`)}catch{}
    return payload;
  }
  const allExtensions=()=>[...new Set(catalog().flatMap(p=>p.associations||[]).map(x=>String(x).toLowerCase()))].sort();
  const appDataPath=appId=>`SWIR://APPDATA/${String(appId||'unknown').toUpperCase()}`;
  window.SwirAssociations=Object.freeze({extension:ext,handlersFor,defaultFor,setDefault,clearDefault,allExtensions,openFile,consume,appDataPath,read});
})();