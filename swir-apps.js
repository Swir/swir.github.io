/* SWIR OS v1.7 — application registry + installable package bridge */
(() => {
  'use strict';
  const installed = (() => {
    try { const v = JSON.parse(localStorage.getItem('swir-installed-apps') || '[]'); return new Set(Array.isArray(v) ? v : []); }
    catch { return new Set(); }
  })();

  const core = [
    { id:"apps", title:"App Center", subtitle:"All SWIR OS applications", icon:"◫", category:"System", type:"internal", accent:"#00c8ff", desktop:true, system:true },
    { id:"store", title:"SWIR Store", subtitle:"Install SWIR App Packages", icon:"S+", category:"System", type:"iframe", url:"./swir-store.html", accent:"#00d8ff", desktop:true, system:true },
    { id:"files", title:"File Explorer", subtitle:"Virtual files, associations, App Data and Trash", icon:"▤", category:"System", type:"iframe", url:"./swir-files.html", accent:"#53c7ff", desktop:true, system:true },
    { id:"defaults", title:"Default Apps", subtitle:"File associations and Open With defaults", icon:"DF", category:"System", type:"iframe", url:"./swir-default-apps.html", accent:"#7df0ff", desktop:false, system:true },
    { id:"chatkit", title:"Chat Server Kit", subtitle:"Download API backend and install guide", icon:"API", category:"Communication", type:"iframe", url:"./swir-chat-kit.html", accent:"#66f0ff", desktop:false, system:true },
    { id:"notes", title:"Notes", subtitle:"Autosaving local notes", icon:"N", category:"Productivity", type:"iframe", url:"./swir-notes.html", accent:"#55e6c1", desktop:true, system:true },
    { id:"calc", title:"Calculator", subtitle:"Scientific-style quick calculator", icon:"±", category:"Productivity", type:"iframe", url:"./swir-calc.html", accent:"#74b9ff", desktop:true, system:true },
    { id:"player", title:"SWIR Player", subtitle:"Local audio and system sounds", icon:"▶", category:"Media", type:"iframe", url:"./swir-player.html", accent:"#ff8fd8", desktop:true, system:true },
    { id:"matrix", title:"SWIR Matrix", subtitle:"Native digital-rain renderer", icon:"01", category:"Visual", type:"iframe", url:"./swir-matrix.html", accent:"#39ff88", desktop:true, system:true },
    { id:"monitor", title:"System Monitor", subtitle:"Browser, storage and network telemetry", icon:"▥", category:"System", type:"iframe", url:"./swir-monitor.html", accent:"#7dffb3", desktop:true, system:true },
    { id:"device", title:"Device Manager", subtitle:"Hostname, hardware and runtime information", icon:"DV", category:"System", type:"iframe", url:"./swir-device.html", accent:"#35e6ff", desktop:false, system:true },
    { id:"network", title:"Network Center", subtitle:"Connection status and portable network profiles", icon:"NET", category:"System", type:"iframe", url:"./swir-network.html", accent:"#50e3a4", desktop:false, system:true },
    { id:"users", title:"User Manager", subtitle:"Profiles, roles, PIN and active session", icon:"US", category:"System", type:"iframe", url:"./swir-users.html", accent:"#35e6ff", desktop:false, system:true },
    { id:"taskmgr", title:"Task Manager", subtitle:"Running SWIR OS application processes", icon:"▧", category:"System", type:"iframe", url:"./swir-taskmgr.html", accent:"#7df0ff", desktop:false, system:true },
    { id:"services", title:"SWIR Services", subtitle:"System service and adapter status", icon:"SV", category:"System", type:"iframe", url:"./swir-services.html", accent:"#35e6ff", desktop:false, system:true },
    { id:"updates", title:"Update Center", subtitle:"GitHub, cache and runtime updates", icon:"↻", category:"System", type:"iframe", url:"./swir-updates.html", accent:"#50e3a4", desktop:false, system:true },
    { id:"control", title:"Platform Control", subtitle:"Permissions, packages and clipboard", icon:"◇", category:"System", type:"iframe", url:"./swir-control.html", accent:"#b58cff", desktop:false, system:true },
    { id:"terminal", title:"Terminal", subtitle:"SWIR command console", icon:">_", category:"System", type:"internal", accent:"#00e5ff", desktop:true, system:true },
    { id:"projects", title:"GitHub Projects", subtitle:"Live repository dashboard", icon:"</>", category:"Developer", type:"internal", accent:"#48a8ff", desktop:true, system:true },
    { id:"browser", title:"SWIR Browser", subtitle:"Quick web launcher", icon:"◎", category:"Internet", type:"internal", accent:"#00d4ff", system:true },
    { id:"github", title:"GitHub", subtitle:"github.com/Swir", icon:"GH", category:"Internet", type:"external", url:"https://github.com/Swir", accent:"#ffffff", desktop:true, system:true },
    { id:"settings", title:"System Settings", subtitle:"Device, appearance, session and storage settings", icon:"⚙", category:"System", type:"iframe", url:"./swir-settings.html", accent:"#7cc7ff", desktop:true, system:true },
    { id:"about", title:"About SWIR OS", subtitle:"NEON CORE build information", icon:"i", category:"System", type:"internal", accent:"#00a6ff", system:true }
  ];

  const packages = (Array.isArray(window.SWIR_PACKAGE_CATALOG) ? window.SWIR_PACKAGE_CATALOG : [])
    .filter(pkg => installed.has(pkg.id))
    .map(pkg => ({
      id: pkg.id, title: pkg.name, subtitle: pkg.description, icon: pkg.icon, category: pkg.category,
      type: pkg.type || 'iframe', url: pkg.entry, accent: pkg.accent || '#00c8ff', desktop: pkg.desktop !== false,
      packageId: pkg.packageId, packageVersion: pkg.version, permissions: pkg.permissions || [], associations:pkg.associations||[], appData:pkg.appData,
      optional: true
    }));

  function desktopIsolationReady() {
    const host = window.SWIR_NATIVE_HOST;
    return !!host && String(host.edition || '').toUpperCase() === 'DESKTOP' && host.features?.appIsolationRouting === true;
  }

  function desktopIsolatedUrl(app) {
    if (!desktopIsolationReady() || !app.packageId || app.type !== 'iframe') return app.url;
    const packageId = String(app.packageId);
    if (!/^[a-zA-Z0-9._-]{1,128}$/.test(packageId)) return app.url;
    const entry = String(app.url || '').replace(/^\.\//, '');
    if (!entry || entry.includes('..') || entry.includes('\\') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(entry)) return app.url;
    const slug = packageId.toLowerCase().replace(/[^a-z0-9]/g, '-');
    return `https://app-${slug}.swir.local/${entry}`;
  }

  packages.forEach(app => {
    const isolated = desktopIsolatedUrl(app);
    if (isolated !== app.url) {
      app.webUrl = app.url;
      app.url = isolated;
      app.executionIsolation = 'desktop-origin';
    } else if (window.SWIR_NATIVE_HOST && app.packageId) {
      app.executionIsolation = 'desktop-origin-pending';
    }
  });

  window.SWIR_APPS = [...core, ...packages];

  let syncTimer = 0;
  async function syncDesktopPackageContexts() {
    if (!window.SWIR_NATIVE_HOST?.features?.packageContextBroker || !window.SwirRuntime?.security?.syncInstalledContexts) return;
    try { await window.SwirRuntime.security.syncInstalledContexts(); }
    catch (error) { console.warn('[SWIR Desktop] package context synchronization failed', error); }
  }
  function scheduleDesktopPackageContextSync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncDesktopPackageContexts, 60);
  }

  queueMicrotask(scheduleDesktopPackageContextSync);
  window.addEventListener('swir:runtime:ready', scheduleDesktopPackageContextSync);
  window.addEventListener('swir:package-change', scheduleDesktopPackageContextSync);
  window.addEventListener('swir:permission-change', scheduleDesktopPackageContextSync);
})();
