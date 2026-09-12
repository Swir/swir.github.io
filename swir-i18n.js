(()=>{
  'use strict';

  const CONTRACT='swir.i18n/1.0';
  const VERSION='1.0.0';
  const STORAGE_KEY='swir.locale';
  const FALLBACK_LOCALE='en';
  const RTL_LANGUAGES=new Set(['ar','arc','ckb','dv','fa','ha','he','khw','ks','ku','ps','sd','ug','ur','yi']);
  const listeners=new Set();
  const messagePacks=new Map();
  const formatterCache=new Map();

  const BASE_MESSAGES=Object.freeze({
    en:Object.freeze({
      'system.language':'Language',
      'system.region':'Region',
      'system.direction':'Text direction',
      'system.settings':'Settings',
      'system.search':'Search applications...',
      'system.notifications':'Notification Center',
      'system.controlCenter':'Control Center',
      'system.clear':'Clear',
      'system.lock':'Lock',
      'system.installApp':'Install app',
      'system.wallpaper':'Wallpaper',
      'system.theme':'Color core',
      'system.online':'Online',
      'system.offline':'Offline',
      'system.loading':'Loading...',
      'system.ready':'Ready',
      'system.cancel':'Cancel',
      'system.apply':'Apply',
      'system.update':'Update',
      'system.restart':'Restart',
      'system.close':'Close'
    }),
    pl:Object.freeze({
      'system.language':'Język',
      'system.region':'Region',
      'system.direction':'Kierunek tekstu',
      'system.settings':'Ustawienia',
      'system.search':'Szukaj aplikacji...',
      'system.notifications':'Centrum powiadomień',
      'system.controlCenter':'Centrum sterowania',
      'system.clear':'Wyczyść',
      'system.lock':'Zablokuj',
      'system.installApp':'Zainstaluj aplikację',
      'system.wallpaper':'Tapeta',
      'system.theme':'Kolor systemu',
      'system.online':'Online',
      'system.offline':'Offline',
      'system.loading':'Ładowanie...',
      'system.ready':'Gotowe',
      'system.cancel':'Anuluj',
      'system.apply':'Zastosuj',
      'system.update':'Aktualizuj',
      'system.restart':'Uruchom ponownie',
      'system.close':'Zamknij'
    }),
    nb:Object.freeze({
      'system.language':'Språk',
      'system.region':'Region',
      'system.direction':'Tekstretning',
      'system.settings':'Innstillinger',
      'system.search':'Søk etter apper...',
      'system.notifications':'Varslingssenter',
      'system.controlCenter':'Kontrollsenter',
      'system.clear':'Tøm',
      'system.lock':'Lås',
      'system.installApp':'Installer app',
      'system.wallpaper':'Bakgrunn',
      'system.theme':'Systemfarge',
      'system.online':'Tilkoblet',
      'system.offline':'Frakoblet',
      'system.loading':'Laster...',
      'system.ready':'Klar',
      'system.cancel':'Avbryt',
      'system.apply':'Bruk',
      'system.update':'Oppdater',
      'system.restart':'Start på nytt',
      'system.close':'Lukk'
    })
  });

  for(const [locale,messages] of Object.entries(BASE_MESSAGES)) messagePacks.set(locale,new Map(Object.entries(messages)));

  function canonicalize(value){
    if(typeof value!=='string'||!value.trim()) return null;
    try{return Intl.getCanonicalLocales(value.trim().replaceAll('_','-'))[0]||null}catch{return null}
  }

  function languageOf(locale){
    try{return new Intl.Locale(locale).language.toLowerCase()}catch{return String(locale||'').split('-')[0].toLowerCase()}
  }

  function directionOf(locale){
    try{
      const info=new Intl.Locale(locale).textInfo;
      if(info?.direction==='rtl'||info?.direction==='ltr') return info.direction;
    }catch{}
    return RTL_LANGUAGES.has(languageOf(locale))?'rtl':'ltr';
  }

  function localeChain(locale){
    const canonical=canonicalize(locale)||FALLBACK_LOCALE;
    const base=languageOf(canonical);
    return [...new Set([canonical,base,FALLBACK_LOCALE])];
  }

  function translate(locale,key){
    for(const candidate of localeChain(locale)){
      const pack=messagePacks.get(candidate);
      if(pack?.has(key)) return pack.get(key);
    }
    return null;
  }

  function interpolate(text,vars){
    if(!vars||typeof vars!=='object') return text;
    return String(text).replace(/\{([A-Za-z0-9_.-]+)\}/g,(match,name)=>Object.prototype.hasOwnProperty.call(vars,name)?String(vars[name]):match);
  }

  function preferredLocale(){
    let stored=null;
    try{stored=localStorage.getItem(STORAGE_KEY)}catch{}
    const candidates=[stored,...(Array.isArray(navigator.languages)?navigator.languages:[]),navigator.language,FALLBACK_LOCALE];
    for(const candidate of candidates){const canonical=canonicalize(candidate);if(canonical)return canonical}
    return FALLBACK_LOCALE;
  }

  let currentLocale=preferredLocale();

  function formatter(type,locale,options={}){
    const canonical=canonicalize(locale)||currentLocale;
    const key=`${type}|${canonical}|${JSON.stringify(options)}`;
    if(formatterCache.has(key)) return formatterCache.get(key);
    let instance;
    if(type==='date') instance=new Intl.DateTimeFormat(canonical,options);
    else if(type==='number') instance=new Intl.NumberFormat(canonical,options);
    else if(type==='relative') instance=new Intl.RelativeTimeFormat(canonical,options);
    else if(type==='list') instance=new Intl.ListFormat(canonical,options);
    else throw new TypeError(`Unsupported formatter type: ${type}`);
    formatterCache.set(key,instance);
    return instance;
  }

  function t(key,vars,options={}){
    const locale=canonicalize(options.locale)||currentLocale;
    const translated=translate(locale,key);
    const fallback=typeof options.fallback==='string'?options.fallback:key;
    return interpolate(translated??fallback,vars);
  }

  function applyDocument(root=document){
    if(!root?.querySelectorAll) return 0;
    let count=0;
    const nodes=root.querySelectorAll('[data-i18n],[data-i18n-placeholder],[data-i18n-title],[data-i18n-aria-label]');
    for(const node of nodes){
      if(node.dataset.i18n){node.textContent=t(node.dataset.i18n);count++}
      if(node.dataset.i18nPlaceholder&&'placeholder' in node){node.placeholder=t(node.dataset.i18nPlaceholder);count++}
      if(node.dataset.i18nTitle){node.title=t(node.dataset.i18nTitle);count++}
      if(node.dataset.i18nAriaLabel){node.setAttribute('aria-label',t(node.dataset.i18nAriaLabel));count++}
    }
    return count;
  }

  function emit(){
    const detail=Object.freeze({locale:currentLocale,language:languageOf(currentLocale),direction:directionOf(currentLocale)});
    for(const listener of [...listeners]){try{listener(detail)}catch(error){console.error('[SWIR i18n] locale listener failed',error)}}
    window.dispatchEvent(new CustomEvent('swir:locale-changed',{detail}));
    return detail;
  }

  function setLocale(locale,options={}){
    const canonical=canonicalize(locale);
    if(!canonical) throw new RangeError(`Invalid BCP-47 locale: ${locale}`);
    currentLocale=canonical;
    document.documentElement.lang=canonical;
    document.documentElement.dir=directionOf(canonical);
    document.documentElement.dataset.locale=canonical;
    if(options.persist!==false){try{localStorage.setItem(STORAGE_KEY,canonical)}catch{}}
    formatterCache.clear();
    applyDocument(document);
    return emit();
  }

  function registerMessages(locale,messages,{replace=false}={}){
    const canonical=canonicalize(locale);
    if(!canonical) throw new RangeError(`Invalid BCP-47 locale: ${locale}`);
    if(!messages||typeof messages!=='object'||Array.isArray(messages)) throw new TypeError('messages must be an object');
    const target=replace?new Map():new Map(messagePacks.get(canonical)||[]);
    for(const [key,value] of Object.entries(messages)){
      if(typeof key!=='string'||!key.trim()||typeof value!=='string') throw new TypeError('Translation keys and values must be strings');
      target.set(key,value);
    }
    messagePacks.set(canonical,target);
    if(localeChain(currentLocale).includes(canonical)) applyDocument(document);
    return target.size;
  }

  function subscribe(listener){
    if(typeof listener!=='function') throw new TypeError('listener must be a function');
    listeners.add(listener);
    return ()=>listeners.delete(listener);
  }

  const api=Object.freeze({
    contract:CONTRACT,
    version:VERSION,
    fallbackLocale:FALLBACK_LOCALE,
    get locale(){return currentLocale},
    get language(){return languageOf(currentLocale)},
    get direction(){return directionOf(currentLocale)},
    canonicalize,
    localeChain,
    directionOf,
    t,
    setLocale,
    registerMessages,
    applyDocument,
    subscribe,
    messageLocales:()=>Object.freeze([...messagePacks.keys()].sort()),
    formatDate:(value,options={},locale=currentLocale)=>formatter('date',locale,options).format(value instanceof Date?value:new Date(value)),
    formatNumber:(value,options={},locale=currentLocale)=>formatter('number',locale,options).format(value),
    formatCurrency:(value,currency,options={},locale=currentLocale)=>formatter('number',locale,{style:'currency',currency,...options}).format(value),
    formatRelativeTime:(value,unit,options={},locale=currentLocale)=>formatter('relative',locale,options).format(value,unit),
    formatList:(items,options={},locale=currentLocale)=>formatter('list',locale,options).format(items)
  });

  Object.defineProperty(window,'SwirI18n',{value:api,writable:false,configurable:false});

  const initialize=()=>setLocale(currentLocale,{persist:false});
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',initialize,{once:true});
  else initialize();
})();
