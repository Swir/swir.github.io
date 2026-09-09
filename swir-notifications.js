/* SWIR OS 1.7 — portable application notification service */
(() => {
  'use strict';
  const HISTORY_KEY='swir-app-notifications-v1';
  const MAX_HISTORY=50;
  const read=()=>{try{const v=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');return Array.isArray(v)?v:[]}catch{return[]}};
  const write=v=>localStorage.setItem(HISTORY_KEY,JSON.stringify(v.slice(0,MAX_HISTORY)));
  const catalog=()=>Array.isArray(window.SWIR_PACKAGE_CATALOG)?window.SWIR_PACKAGE_CATALOG:[];
  const manifest=id=>catalog().find(x=>x.id===id||x.packageId===id)||null;
  const installed=id=>{try{const v=JSON.parse(localStorage.getItem('swir-installed-apps')||'[]');return Array.isArray(v)&&v.includes(id)}catch{return false}};
  async function allowed(appId){
    if(appId==='system'||appId==='swir.system')return true;
    const pkg=manifest(appId);if(!pkg||!installed(pkg.id))return false;
    if(!(pkg.permissions||[]).includes('notifications'))return false;
    try{return (await window.SwirPlatform?.permissions?.get?.(pkg.id,'notifications'))?.value===true}catch{return false}
  }
  function normalize(options={}){
    if(typeof options==='string')options={message:options};
    return {
      title:String(options.title||'SWIR App').slice(0,80),
      message:String(options.message||'Application event').slice(0,300),
      tag:String(options.tag||'').slice(0,64),
      priority:['low','normal','high'].includes(options.priority)?options.priority:'normal',
      silent:options.silent===true,
      openApp:options.openApp?String(options.openApp):''
    };
  }
  async function send(appId,options={}){
    const pkg=manifest(appId),id=pkg?.id||String(appId||'');
    if(!(await allowed(id)))throw new Error('Notification permission denied');
    const n=normalize(options),item={id:`ntf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`,appId:id,packageId:pkg?.packageId||'swir.system',appName:pkg?.name||'SWIR OS',...n,time:new Date().toISOString()};
    const history=read();
    if(item.tag){const i=history.findIndex(x=>x.appId===item.appId&&x.tag===item.tag);if(i>=0)history.splice(i,1)}
    history.unshift(item);write(history);
    window.dispatchEvent(new CustomEvent('swir:notification',{detail:item}));
    window.SwirOS?.toast?.(item.title,item.message);
    return item;
  }
  function list(appId=null){const h=read();return appId?h.filter(x=>x.appId===appId):h}
  function clear(appId=null){if(appId)write(read().filter(x=>x.appId!==appId));else write([]);window.dispatchEvent(new CustomEvent('swir:notifications-clear',{detail:{appId}}));}
  window.SwirNotifications=Object.freeze({send,list,clear,allowed,historyKey:HISTORY_KEY});
})();
