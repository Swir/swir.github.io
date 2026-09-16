/* SWIR OS 1.7 — portable application notification service */
(() => {
  'use strict';

  const HISTORY_KEY='swir-app-notifications-v1';
  const PLATFORM_HISTORY_KEY='notifications.history.v1';
  const MAX_HISTORY=50;
  const MAX_ACTIONS=3;
  const ACTION_ID=/^[A-Za-z0-9._-]{1,48}$/;

  const catalog=()=>Array.isArray(window.SWIR_PACKAGE_CATALOG)?window.SWIR_PACKAGE_CATALOG:[];
  const manifest=id=>catalog().find(x=>x.id===id||x.packageId===id)||null;
  const installed=id=>{try{const v=JSON.parse(localStorage.getItem('swir-installed-apps')||'[]');return Array.isArray(v)&&v.includes(id)}catch{return false}};
  const legacyRead=()=>{try{const v=JSON.parse(localStorage.getItem(HISTORY_KEY)||'[]');return Array.isArray(v)?v:[]}catch{return[]}};
  const legacyWrite=value=>{try{localStorage.setItem(HISTORY_KEY,JSON.stringify(value.slice(0,MAX_HISTORY)))}catch{}};

  let history=legacyRead().slice(0,MAX_HISTORY);
  let customAdapter=null;
  let hydrationPromise=null;
  let persistenceProvider='legacy-localStorage';

  async function allowed(appId){
    if(appId==='system'||appId==='swir.system')return true;
    const pkg=manifest(appId);if(!pkg||!installed(pkg.id))return false;
    if(!(pkg.permissions||[]).includes('notifications'))return false;
    try{return (await window.SwirPlatform?.permissions?.get?.(pkg.id,'notifications'))?.value===true}catch{return false}
  }

  function sanitizeHistory(value){
    if(!Array.isArray(value))return[];
    return value.filter(item=>item&&typeof item==='object'&&typeof item.id==='string').slice(0,MAX_HISTORY);
  }

  function localAdapter(){
    return Object.freeze({
      id:'legacy-localStorage',
      async read(){return legacyRead()},
      async write(value){legacyWrite(value);return true},
      async clear(){try{localStorage.removeItem(HISTORY_KEY)}catch{}return true}
    });
  }

  function platformAdapter(){
    const storage=window.SwirPlatform?.storage;
    if(!storage||typeof storage.get!=='function'||typeof storage.set!=='function')return null;
    return Object.freeze({
      id:'swir-platform-storage',
      async read(){
        try{await window.SwirPlatform?.ready}catch{}
        return storage.get(PLATFORM_HISTORY_KEY,[]);
      },
      async write(value){
        try{await window.SwirPlatform?.ready}catch{}
        await storage.set(PLATFORM_HISTORY_KEY,value.slice(0,MAX_HISTORY));
        return true;
      },
      async clear(){
        try{await window.SwirPlatform?.ready}catch{}
        if(typeof storage.remove==='function')await storage.remove(PLATFORM_HISTORY_KEY);
        else await storage.set(PLATFORM_HISTORY_KEY,[]);
        return true;
      }
    });
  }

  function resolveAdapter(){return customAdapter||platformAdapter()||localAdapter()}

  async function hydrate(){
    const adapter=resolveAdapter();
    persistenceProvider=String(adapter.id||'custom');
    const legacy=sanitizeHistory(legacyRead());
    let persisted=[];
    try{persisted=sanitizeHistory(await adapter.read())}catch{persisted=[]}
    history=(persisted.length?persisted:legacy).slice(0,MAX_HISTORY);
    legacyWrite(history);
    if(!persisted.length&&legacy.length&&adapter.id!=='legacy-localStorage'){
      try{await adapter.write(history)}catch{}
    }
    return history.slice();
  }

  function ready(){
    if(!hydrationPromise)hydrationPromise=hydrate().catch(()=>{persistenceProvider='legacy-localStorage';history=sanitizeHistory(legacyRead());return history.slice()});
    return hydrationPromise;
  }

  async function persist(){
    history=sanitizeHistory(history).slice(0,MAX_HISTORY);
    legacyWrite(history);
    const adapter=resolveAdapter();
    persistenceProvider=String(adapter.id||'custom');
    try{await adapter.write(history)}catch{
      persistenceProvider='legacy-localStorage';
      legacyWrite(history);
    }
  }

  function normalizeAction(action,index,appId){
    if(!action||typeof action!=='object')return null;
    const fallbackId=`action-${index+1}`;
    const rawId=String(action.id||fallbackId).trim();
    if(!ACTION_ID.test(rawId))return null;
    const kind=['open','dismiss'].includes(action.kind)?action.kind:'open';
    const label=String(action.label||action.title||(kind==='dismiss'?'Dismiss':'Open')).trim().slice(0,40);
    if(!label)return null;
    const isSystem=appId==='system'||appId==='swir.system';
    const requestedTarget=String(action.target||appId||'').trim().slice(0,128);
    const target=kind==='open'?(isSystem?requestedTarget:appId):'';
    return Object.freeze({id:rawId,label,kind,target});
  }

  function normalize(options={},appId=''){
    if(typeof options==='string')options={message:options};
    const actions=Array.isArray(options.actions)
      ?options.actions.slice(0,MAX_ACTIONS).map((action,index)=>normalizeAction(action,index,appId)).filter(Boolean)
      :[];
    const isSystem=appId==='system'||appId==='swir.system';
    const requestedOpenApp=options.openApp?String(options.openApp).trim().slice(0,128):'';
    return {
      title:String(options.title||'SWIR App').slice(0,80),
      message:String(options.message||'Application event').slice(0,300),
      tag:String(options.tag||'').slice(0,64),
      priority:['low','normal','high'].includes(options.priority)?options.priority:'normal',
      silent:options.silent===true,
      openApp:requestedOpenApp?(isSystem?requestedOpenApp:appId):'',
      actions
    };
  }

  async function deliverNative(item){
    const notifications=window.SWIR_NATIVE_HOST?.notifications;
    const showRich=notifications?.showRich;
    if(typeof showRich==='function'){
      return showRich({
        id:item.id,
        title:item.title,
        message:item.message,
        appId:item.packageId,
        silent:item.silent,
        priority:item.priority,
        tag:item.tag,
        actions:item.actions.map(action=>({...action}))
      });
    }
    const show=notifications?.show;
    if(typeof show!=='function')return null;
    return show(item.title,item.message,item.packageId,item.silent);
  }

  async function send(appId,options={}){
    const pkg=manifest(appId),id=pkg?.id||String(appId||'');
    if(!(await allowed(id)))throw new Error('Notification permission denied');
    await ready();
    const n=normalize(options,id),item={
      id:`ntf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,7)}`,
      appId:id,
      packageId:pkg?.packageId||'swir.system',
      appName:pkg?.name||'SWIR OS',
      ...n,
      time:new Date().toISOString()
    };
    const nativeDelivery=await deliverNative(item);
    if(item.tag){const i=history.findIndex(x=>x.appId===item.appId&&x.tag===item.tag);if(i>=0)history.splice(i,1)}
    history.unshift(item);
    await persist();
    window.dispatchEvent(new CustomEvent('swir:notification',{detail:{...item,nativeDelivery}}));
    if(!nativeDelivery)window.SwirOS?.toast?.(item.title,item.message);
    return {...item,nativeDelivery};
  }

  function list(appId=null){
    const snapshot=history.slice();
    return appId?snapshot.filter(x=>x.appId===appId):snapshot;
  }

  async function dismiss(notificationId){
    await ready();
    const before=history.length;
    history=history.filter(item=>item.id!==notificationId);
    if(history.length===before)return false;
    await persist();
    window.dispatchEvent(new CustomEvent('swir:notification-dismissed',{detail:{id:notificationId}}));
    return true;
  }

  async function activate(notificationId,actionId){
    await ready();
    const item=history.find(entry=>entry.id===notificationId);
    if(!item)return false;
    const action=Array.isArray(item.actions)?item.actions.find(entry=>entry.id===actionId):null;
    if(!action)return false;
    const detail={notificationId:item.id,appId:item.appId,packageId:item.packageId,action:{...action}};
    window.dispatchEvent(new CustomEvent('swir:notification-action',{detail}));
    if(action.kind==='dismiss')return dismiss(item.id);
    if(action.kind==='open'){
      const target=action.target||item.openApp||item.appId;
      if(target)window.SwirOS?.open?.(target);
      return true;
    }
    return false;
  }

  async function clear(appId=null){
    await ready();
    if(appId)history=history.filter(x=>x.appId!==appId);else history=[];
    await persist();
    window.dispatchEvent(new CustomEvent('swir:notifications-clear',{detail:{appId}}));
    return true;
  }

  async function usePersistenceAdapter(adapter){
    if(!adapter||typeof adapter.read!=='function'||typeof adapter.write!=='function')throw new TypeError('Notification persistence adapter requires async read() and write(history) methods.');
    await ready();
    const current=history.slice();
    customAdapter=adapter;
    hydrationPromise=null;
    let loaded=[];
    try{loaded=sanitizeHistory(await adapter.read())}catch{loaded=[]}
    history=(loaded.length?loaded:current).slice(0,MAX_HISTORY);
    legacyWrite(history);
    if(!loaded.length&&current.length)await adapter.write(history);
    hydrationPromise=Promise.resolve(history.slice());
    persistenceProvider=String(adapter.id||'custom');
    window.dispatchEvent(new CustomEvent('swir:notification-persistence',{detail:{provider:persistenceProvider}}));
    return persistenceInfo();
  }

  function persistenceInfo(){return Object.freeze({provider:persistenceProvider,key:PLATFORM_HISTORY_KEY,legacyKey:HISTORY_KEY,maxHistory:MAX_HISTORY,custom:!!customAdapter})}

  if(typeof window.addEventListener==='function'){
    window.addEventListener('swir:native-notification-action',event=>{
      const detail=event?.detail||{};
      if(detail.notificationId&&detail.actionId)activate(String(detail.notificationId),String(detail.actionId)).catch(()=>{});
    });
  }

  const persistence=Object.freeze({ready,info:persistenceInfo,use:usePersistenceAdapter});
  window.SwirNotifications=Object.freeze({
    send,
    list,
    clear,
    dismiss,
    activate,
    allowed,
    persistence,
    historyKey:HISTORY_KEY,
    platformHistoryKey:PLATFORM_HISTORY_KEY,
    maxActions:MAX_ACTIONS
  });
  ready().catch(()=>{});
})();
