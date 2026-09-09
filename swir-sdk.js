/* SWIR App SDK 1.6 — Web Edition bridge */
(() => {
  'use strict';
  const catalog = () => Array.isArray(window.SWIR_PACKAGE_CATALOG) ? window.SWIR_PACKAGE_CATALOG : [];
  const platform = () => window.SwirPlatform;

  function manifest(id) { return catalog().find(x => x.id === id || x.packageId === id) || null; }
  function installedSync(id) {
    try { const list = JSON.parse(localStorage.getItem('swir-installed-apps') || '[]'); return Array.isArray(list) && list.includes(id); }
    catch { return false; }
  }
  async function installed(id) {
    const p = platform();
    if (p?.packages?.list) return (await p.packages.list()).some(x => x.id === id && x.installed !== false);
    return installedSync(id);
  }
  async function hasPermission(appId, permission) {
    const record = await platform()?.permissions?.get?.(appId, permission);
    return record?.value === true;
  }
  function namespace(appId) {
    const prefix = `app.${appId}.`;
    return Object.freeze({
      path: `SWIR://APPDATA/${String(appId||'APP').toUpperCase()}`,
      async get(key, fallback = null) { return platform()?.storage?.get?.(prefix + key, fallback) ?? fallback; },
      async set(key, value) { return platform()?.storage?.set?.(prefix + key, value); },
      async remove(key) { return platform()?.storage?.remove?.(prefix + key); }
    });
  }
  async function activeIdentity() {
    const user = await platform()?.identity?.active?.();
    if (!user) return null;
    return { id: user.id, name: user.name, role: user.role, avatar: user.avatar, accent: user.accent };
  }
  function notify(title, message) { window.SwirOS?.toast?.(String(title || 'SWIR App'), String(message || '')); }
  function open(appId) { window.SwirOS?.open?.(appId); }
  function systemInfo() { const info=platform()?.system?.info?.()||{}; return {...info,version:'1.7.0'}; }
  function associationService(){return window.SwirAssociations||null}
  async function openFile(file,appId=null){const svc=associationService();if(!svc)throw new Error('File association service unavailable');return svc.openFile(file,appId)}
  async function consumeOpen(appId){const svc=associationService();return svc?svc.consume(appId):null}
  function handlersFor(name){return associationService()?.handlersFor?.(name)||[]}
  function defaultFor(name){return associationService()?.defaultFor?.(name)||null}
  function setDefault(extension,appId){return associationService()?.setDefault?.(extension,appId)}
  function extension(name){return associationService()?.extension?.(name)||''}
  function appData(appId){return namespace(appId)}
  function notificationService(){return window.SwirNotifications||null}
  async function sendNotification(appId,options){const svc=notificationService();if(!svc)throw new Error('Notification service unavailable');return svc.send(appId,options)}
  function notificationHistory(appId=null){return notificationService()?.list?.(appId)||[]}
  function clearNotifications(appId=null){return notificationService()?.clear?.(appId)}
  function packageResolver(){return window.SwirPackageResolver||null}
  async function checkPackage(id){const svc=packageResolver();if(!svc)throw new Error('Package resolver unavailable');return svc.checkCompatibility(id)}
  async function planInstall(id){const svc=packageResolver();if(!svc)throw new Error('Package resolver unavailable');return svc.planInstall(id)}
  async function planRemove(id){const svc=packageResolver();if(!svc)throw new Error('Package resolver unavailable');return svc.planRemove(id)}
  async function packageAudit(){const svc=packageResolver();if(!svc)throw new Error('Package resolver unavailable');return svc.audit()}
  function packageRuntime(){return packageResolver()?.runtime?.()||null}
  function compareVersions(a,b){const svc=packageResolver();return svc?svc.compareVersions(a,b):0}
  function integrityService(){return window.SwirPackageIntegrity||null}
  async function packageFingerprint(value){const svc=integrityService();if(!svc)throw new Error('Package integrity service unavailable');const m=typeof value==='string'?manifest(value):value;if(!m)throw new Error('Package manifest not found');return svc.fingerprintManifest(m)}
  async function verifyManifest(value,expected=null){const svc=integrityService();if(!svc)throw new Error('Package integrity service unavailable');const m=typeof value==='string'?manifest(value):value;if(!m)throw new Error('Package manifest not found');return svc.verifyManifest(m,expected)}
  async function verifyEntry(value){const svc=integrityService();if(!svc)throw new Error('Package integrity service unavailable');const m=typeof value==='string'?manifest(value):value;if(!m)throw new Error('Package manifest not found');return svc.verifyEntry(m)}
  async function verifySignature(value,signature=null){const svc=integrityService();if(!svc)throw new Error('Package integrity service unavailable');const m=typeof value==='string'?manifest(value):value;if(!m)throw new Error('Package manifest not found');return svc.verifySignature(m,signature||m.signature)}
  async function integrityPlan(value,options={}){const svc=integrityService();if(!svc)throw new Error('Package integrity service unavailable');const m=typeof value==='string'?manifest(value):value;if(!m)throw new Error('Package manifest not found');return svc.plan(m,options)}
  function validateSignatureDescriptor(signature){const svc=integrityService();if(!svc)throw new Error('Package integrity service unavailable');return svc.validateSignatureDescriptor(signature)}
  function trustService(){return window.SwirTrustedKeys||null}
  function trustInfo(){const svc=trustService();if(!svc)throw new Error('Trusted Key Store unavailable');return svc.info()}
  function trustedKeys(){const svc=trustService();if(!svc)throw new Error('Trusted Key Store unavailable');return svc.all()}
  function trustedKey(keyId){const svc=trustService();if(!svc)throw new Error('Trusted Key Store unavailable');return svc.get(keyId)}
  function trustFor(keyId,packageId){const svc=trustService();if(!svc)throw new Error('Trusted Key Store unavailable');return svc.trustedFor(keyId,packageId)}
  function installPipeline(){return window.SwirInstallPipeline||null}
  function resolveManifest(value){const m=typeof value==='string'?manifest(value):value;if(!m)throw new Error('Package manifest not found');return m}
  async function prepareInstall(value,options={}){const svc=installPipeline();if(!svc)throw new Error('Install Pipeline unavailable');return svc.prepare(resolveManifest(value),options)}
  async function secureInstall(value,options={}){const svc=installPipeline();if(!svc)throw new Error('Install Pipeline unavailable');return svc.install(resolveManifest(value),options)}
  async function secureRemove(value,options={}){const svc=installPipeline();if(!svc)throw new Error('Install Pipeline unavailable');return svc.remove(resolveManifest(value),options)}
  function installPipelineInfo(){const svc=installPipeline();if(!svc)throw new Error('Install Pipeline unavailable');return svc.info()}

  window.SwirAppSDK = Object.freeze({
    meta: Object.freeze({ name: 'SWIR App SDK', version: '1.6.0', schema: 'swir.app/1.0', os: 'SWIR OS 1.7', edition: 'WEB' }),
    catalog,
    manifest,
    installed,
    installedSync,
    permissions: Object.freeze({ has: hasPermission }),
    storage: Object.freeze({ namespace }),
    identity: Object.freeze({ active: activeIdentity }),
    files: Object.freeze({ open:openFile, consumeOpen, handlersFor, defaultFor, setDefault, extension, appData }),
    notifications: Object.freeze({ send:sendNotification, history:notificationHistory, clear:clearNotifications }),
    packages: Object.freeze({ check:checkPackage, planInstall, planRemove, audit:packageAudit, runtime:packageRuntime, compareVersions, fingerprint:packageFingerprint, verifyManifest, verifyEntry, verifySignature, integrityPlan, validateSignatureDescriptor, trustInfo, trustedKeys, trustedKey, trustFor, prepareInstall, secureInstall, secureRemove, installPipelineInfo }),
    system: Object.freeze({ info: systemInfo }),
    shell: Object.freeze({ open, notify })
  });
})();
