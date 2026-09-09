/* =============================================================
   SWIR OS v1.1 — NEON CORE extension
   Lock screen, notification center, quick settings, wallpapers,
   movable desktop icons, Store bridge and PWA install support.
   ============================================================= */

(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const v11 = {
    wallpaper: localStorage.getItem("swir-wallpaper") || "grid",
    unread: 0,
    installPrompt: null,
    notificationHistory: readJSON("swir-notifications", []),
    iconPositions: readJSON("swir-icon-positions", {}),
    installed: readJSON("swir-installed-apps", []),
    panelsOpen: null,
    pendingApp: new URLSearchParams(location.search).get("app") || ""
  };

  function readJSON(key, fallback) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      return value ?? fallback;
    } catch (_) {
      return fallback;
    }
  }

  function escapeHTML(value = "") {
    return String(value).replace(/[&<>'"]/g, ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;"
    })[ch]);
  }

  function appById(id) {
    return window.SwirOS?.apps?.find(app => app.id === id) || null;
  }

  function playChime() {
    if (localStorage.getItem("swir-sound") === "off") return;
    try {
      const audio = new Audio("./ding.mp3");
      audio.volume = .22;
      audio.play().catch(() => {});
    } catch (_) {}
  }

  function notify(title, message) {
    if (window.SwirOS?.toast) window.SwirOS.toast(title, message);
    else recordNotification(title, message);
  }

  /* -------------------- Wallpaper -------------------- */
  function applyWallpaper(name, announce = false) {
    const allowed = ["grid", "aurora", "void"];
    const next = allowed.includes(name) ? name : "grid";
    v11.wallpaper = next;
    localStorage.setItem("swir-wallpaper", next);
    const shell = $("#os-shell");
    if (shell) shell.dataset.wallpaper = next;
    $$(".wallpaper-pill").forEach(btn => btn.classList.toggle("active", btn.dataset.wallpaper === next));
    if (announce) notify("Wallpaper", `${next.toUpperCase()} wallpaper activated.`);
  }

  /* -------------------- Lock screen -------------------- */
  function updateLockClock() {
    const now = new Date();
    const clock = $("#lock-clock");
    const date = $("#lock-date");
    if (clock) clock.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (date) date.textContent = now.toLocaleDateString([], {
      weekday: "long", day: "2-digit", month: "long", year: "numeric"
    });
  }

  function showLock() {
    closePanels();
    const lock = $("#lock-screen");
    if (!lock) return;
    updateLockClock();
    lock.classList.add("visible");
    lock.setAttribute("aria-hidden", "false");
    setTimeout(() => $("#unlock-os")?.focus(), 140);
  }

  function unlock() {
    const lock = $("#lock-screen");
    if (!lock) return;
    playChime();
    lock.classList.remove("visible");
    lock.setAttribute("aria-hidden", "true");
    localStorage.setItem("swir-last-unlock", Date.now().toString());
    notify("Session unlocked", "SWIR // CREATOR access granted.");

    if (v11.pendingApp && appById(v11.pendingApp)) {
      const id = v11.pendingApp;
      v11.pendingApp = "";
      setTimeout(() => window.SwirOS?.open?.(id), 320);
      try { history.replaceState({}, "", location.pathname); } catch (_) {}
    }
  }

  function initLockFlow() {
    $("#unlock-os")?.addEventListener("click", unlock);
    const boot = $("#boot-screen");
    if (!boot) {
      showLock();
      return;
    }

    const watch = new MutationObserver(() => {
      if (boot.classList.contains("boot-hidden")) {
        setTimeout(showLock, 260);
      }
    });
    watch.observe(boot, { attributes: true, attributeFilter: ["class"] });
    if (boot.classList.contains("boot-hidden")) showLock();
  }

  /* -------------------- Notifications -------------------- */
  function persistNotifications() {
    localStorage.setItem("swir-notifications", JSON.stringify(v11.notificationHistory.slice(0, 20)));
  }

  function recordNotification(title, message) {
    const item = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title: String(title || "SWIR OS"),
      message: String(message || "System event"),
      time: new Date().toISOString()
    };
    v11.notificationHistory.unshift(item);
    v11.notificationHistory = v11.notificationHistory.slice(0, 20);
    v11.unread += 1;
    persistNotifications();
    renderNotifications();
    updateNotificationBadge();
  }

  function renderNotifications() {
    const host = $("#notification-list");
    if (!host) return;
    if (!v11.notificationHistory.length) {
      host.innerHTML = `<div class="notification-empty">NO NEW SIGNALS<br>Notification history is empty.</div>`;
      return;
    }
    host.innerHTML = v11.notificationHistory.map(item => {
      const date = new Date(item.time);
      const time = Number.isNaN(date.getTime()) ? "SYSTEM" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return `<article class="notification-item"><strong>${escapeHTML(item.title)}</strong><p>${escapeHTML(item.message)}</p><time>${escapeHTML(time)}</time></article>`;
    }).join("");
  }

  function updateNotificationBadge() {
    const badge = $("#notification-badge");
    if (!badge) return;
    badge.textContent = v11.unread > 9 ? "9+" : (v11.unread ? String(v11.unread) : "");
  }

  function observeToasts() {
    const stack = $("#toast-stack");
    if (!stack) return;
    const observer = new MutationObserver(records => {
      records.forEach(record => {
        record.addedNodes.forEach(node => {
          if (!(node instanceof HTMLElement) || !node.classList.contains("toast")) return;
          const title = $("strong", node)?.textContent?.trim() || "SWIR OS";
          const message = $("span", node)?.textContent?.trim() || "System event";
          recordNotification(title, message);
        });
      });
    });
    observer.observe(stack, { childList: true });
  }

  /* -------------------- Side panels -------------------- */
  function closePanels() {
    v11.panelsOpen = null;
    $("#notification-center")?.classList.remove("open");
    $("#quick-center")?.classList.remove("open");
    $("#v11-panel-backdrop")?.classList.remove("open");
    $("#notification-button")?.classList.remove("active");
    $("#quick-button")?.classList.remove("active");
  }

  function togglePanel(name) {
    if (v11.panelsOpen === name) {
      closePanels();
      return;
    }
    closePanels();
    v11.panelsOpen = name;
    $("#v11-panel-backdrop")?.classList.add("open");
    if (name === "notifications") {
      $("#notification-center")?.classList.add("open");
      $("#notification-button")?.classList.add("active");
      v11.unread = 0;
      updateNotificationBadge();
      renderNotifications();
    }
    if (name === "quick") {
      $("#quick-center")?.classList.add("open");
      $("#quick-button")?.classList.add("active");
      refreshQuickState();
    }
  }

  function refreshQuickState() {
    const currentTheme = document.documentElement.dataset.theme || "blue";
    $$(".v11-theme-pill").forEach(btn => btn.classList.toggle("active", btn.dataset.v11Theme === currentTheme));
    $$(".wallpaper-pill").forEach(btn => btn.classList.toggle("active", btn.dataset.wallpaper === v11.wallpaper));
  }

  function wirePanels() {
    $("#notification-button")?.addEventListener("click", () => togglePanel("notifications"));
    $("#quick-button")?.addEventListener("click", () => togglePanel("quick"));
    $("#v11-panel-backdrop")?.addEventListener("click", closePanels);
    $("#clear-notifications")?.addEventListener("click", () => {
      v11.notificationHistory = [];
      v11.unread = 0;
      persistNotifications();
      renderNotifications();
      updateNotificationBadge();
    });

    $$(".v11-theme-pill").forEach(btn => btn.addEventListener("click", () => {
      const theme = btn.dataset.v11Theme;
      window.SwirOS?.setTheme?.(theme);
      refreshQuickState();
      playChime();
      notify("Color core", `${theme.toUpperCase()} core activated.`);
    }));

    $$(".wallpaper-pill").forEach(btn => btn.addEventListener("click", () => applyWallpaper(btn.dataset.wallpaper, true)));

    $("#quick-settings-open")?.addEventListener("click", () => {
      closePanels();
      window.SwirOS?.open?.("settings");
    });
    $("#quick-store-open")?.addEventListener("click", () => {
      closePanels();
      window.SwirOS?.open?.("store");
    });
    $("#quick-lock")?.addEventListener("click", showLock);
    $("#quick-reset-icons")?.addEventListener("click", () => {
      v11.iconPositions = {};
      localStorage.removeItem("swir-icon-positions");
      layoutDesktopIcons(true);
      notify("Desktop", "Icon positions restored to the default grid.");
    });
    $("#quick-install")?.addEventListener("click", async () => {
      if (!v11.installPrompt) {
        notify("Install SWIR OS", "Browser install prompt is not available right now. Use your browser menu → Add to Home screen / Install app.");
        return;
      }
      v11.installPrompt.prompt();
      try { await v11.installPrompt.userChoice; } catch (_) {}
      v11.installPrompt = null;
      updateInstallTile();
    });
  }

  /* -------------------- Desktop icons -------------------- */
  function installedApps() {
    const value = readJSON("swir-installed-apps", []);
    v11.installed = Array.isArray(value) ? value : [];
    return v11.installed;
  }

  function iconMarkup(app) {
    const accent = escapeHTML(app.accent || "#00c8ff");
    return `<span class="app-glyph" style="--glyph-color:${accent}">${escapeHTML(app.icon || "◆")}</span><span class="desktop-icon-label">${escapeHTML(app.title)}</span>`;
  }

  function syncInstalledDesktopIcons() {
    const host = $("#desktop-icons");
    if (!host || !window.SwirOS?.apps) return;
    const installed = installedApps();

    $$(".desktop-icon[data-installed-shortcut='1']", host).forEach(btn => {
      if (!installed.includes(btn.dataset.open)) btn.remove();
    });

    installed.forEach(id => {
      const app = appById(id);
      if (!app) return;
      const exists = $$(".desktop-icon", host).some(btn => btn.dataset.open === id);
      if (exists) return;
      const button = document.createElement("button");
      button.className = "desktop-icon";
      button.dataset.open = id;
      button.dataset.installedShortcut = "1";
      button.title = app.subtitle || app.title;
      button.innerHTML = iconMarkup(app);
      host.appendChild(button);
    });

    layoutDesktopIcons();
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(value, max));
  }

  function defaultIconPosition(index) {
    const rows = 6;
    return { x: Math.floor(index / rows) * 98, y: (index % rows) * 92 };
  }

  function layoutDesktopIcons(forceDefault = false) {
    const host = $("#desktop-icons");
    if (!host) return;
    const mobile = matchMedia("(max-width: 760px)").matches;
    host.classList.toggle("swir-free-layout", !mobile);
    const buttons = $$(".desktop-icon", host);

    if (mobile) return;
    const maxX = Math.max(0, host.clientWidth - 90);
    const maxY = Math.max(0, host.clientHeight - 92);

    buttons.forEach((button, index) => {
      const id = button.dataset.open;
      const fallback = defaultIconPosition(index);
      const saved = !forceDefault && v11.iconPositions[id] ? v11.iconPositions[id] : fallback;
      const x = clamp(Number(saved.x) || 0, 0, maxX);
      const y = clamp(Number(saved.y) || 0, 0, maxY);
      button.style.left = `${x}px`;
      button.style.top = `${y}px`;
      prepareIconDrag(button);
    });
  }

  function saveIconPosition(button) {
    const id = button.dataset.open;
    if (!id) return;
    v11.iconPositions[id] = {
      x: parseFloat(button.style.left) || 0,
      y: parseFloat(button.style.top) || 0
    };
    localStorage.setItem("swir-icon-positions", JSON.stringify(v11.iconPositions));
  }

  function prepareIconDrag(button) {
    if (button.dataset.swirDragReady === "1") return;
    button.dataset.swirDragReady = "1";
    let drag = null;

    button.addEventListener("pointerdown", event => {
      if (matchMedia("(max-width: 760px)").matches || event.button !== 0) return;
      const host = $("#desktop-icons");
      const rect = button.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        dx: event.clientX - rect.left,
        dy: event.clientY - rect.top,
        hostRect,
        moved: false
      };
      button.setPointerCapture?.(event.pointerId);
    });

    button.addEventListener("pointermove", event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (distance > 5) drag.moved = true;
      if (!drag.moved) return;
      event.preventDefault();
      button.classList.add("dragging");
      const host = $("#desktop-icons");
      const maxX = Math.max(0, host.clientWidth - button.offsetWidth);
      const maxY = Math.max(0, host.clientHeight - button.offsetHeight);
      const x = clamp(event.clientX - drag.hostRect.left - drag.dx, 0, maxX);
      const y = clamp(event.clientY - drag.hostRect.top - drag.dy, 0, maxY);
      button.style.left = `${x}px`;
      button.style.top = `${y}px`;
    });

    const finish = event => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const moved = drag.moved;
      drag = null;
      button.classList.remove("dragging");
      if (moved) {
        button.dataset.justDragged = "1";
        saveIconPosition(button);
        setTimeout(() => delete button.dataset.justDragged, 250);
      }
    };
    button.addEventListener("pointerup", finish);
    button.addEventListener("pointercancel", finish);
  }

  function installClickGuard() {
    document.addEventListener("click", event => {
      const button = event.target.closest(".desktop-icon[data-just-dragged='1']");
      if (!button) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }

  /* -------------------- Store bridge -------------------- */
  function wireStoreBridge() {
    window.addEventListener("message", event => {
      if (event.origin !== location.origin || !event.data) return;
      const { type, id } = event.data;
      if (!id || !appById(id)) return;

      if (type === "SWIR_STORE_OPEN") {
        window.SwirOS?.open?.(id);
        return;
      }

      if (type === "SWIR_STORE_INSTALL") {
        v11.installed = installedApps();
        syncInstalledDesktopIcons();
        notify("SWIR Store", `${appById(id).title} shortcut installed on the desktop.`);
      }

      if (type === "SWIR_STORE_REMOVE") {
        v11.installed = installedApps();
        const app = appById(id);
        if (!app.desktop) {
          const btn = $$("#desktop-icons .desktop-icon").find(item => item.dataset.open === id && item.dataset.installedShortcut === "1");
          btn?.remove();
        }
        delete v11.iconPositions[id];
        localStorage.setItem("swir-icon-positions", JSON.stringify(v11.iconPositions));
        layoutDesktopIcons();
        notify("SWIR Store", `${app.title} shortcut removed from the desktop.`);
      }
    });
  }

  /* -------------------- PWA -------------------- */
  function updateInstallTile() {
    const tile = $("#quick-install");
    if (!tile) return;
    const label = $("span", tile);
    if (label) label.textContent = v11.installPrompt ? "Install as an app" : "Browser menu also works";
  }

  function initPWA() {
    window.addEventListener("beforeinstallprompt", event => {
      event.preventDefault();
      v11.installPrompt = event;
      updateInstallTile();
      notify("SWIR OS", "App installation is available on this device.");
    });

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch(() => {});
      });
    }
  }

  /* -------------------- Keyboard / global events -------------------- */
  function wireGlobalEvents() {
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && v11.panelsOpen) closePanels();
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        togglePanel("notifications");
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "q") {
        event.preventDefault();
        togglePanel("quick");
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        showLock();
      }
    });

    window.addEventListener("resize", () => {
      clearTimeout(wireGlobalEvents.resizeTimer);
      wireGlobalEvents.resizeTimer = setTimeout(layoutDesktopIcons, 120);
    });
  }

  function upgradeVisibleVersionLabels() {
    document.title = "SWIR OS 1.1 — Neon Core";
    const subtitle = $(".boot-subtitle");
    if (subtitle) subtitle.textContent = "NEON CORE // v1.1";

    const layer = $("#window-layer");
    if (layer) {
      const observer = new MutationObserver(() => {
        $$(".window-body", layer).forEach(body => {
          body.querySelectorAll("*").forEach(node => {
            if (node.childNodes.length === 1 && node.firstChild?.nodeType === Node.TEXT_NODE) {
              node.textContent = node.textContent
                .replace("SWIR OS Terminal v1.0", "SWIR OS Terminal v1.1")
                .replace("SWIR OS v1.0", "SWIR OS v1.1")
                .replace("Version 1.0", "Version 1.1");
            }
          });
        });
      });
      observer.observe(layer, { childList: true, subtree: true });
    }
  }

  function init() {
    if (!window.SwirOS) {
      setTimeout(init, 40);
      return;
    }

    applyWallpaper(v11.wallpaper);
    upgradeVisibleVersionLabels();
    renderNotifications();
    updateNotificationBadge();
    observeToasts();
    wirePanels();
    initLockFlow();
    syncInstalledDesktopIcons();
    installClickGuard();
    wireStoreBridge();
    wireGlobalEvents();
    initPWA();
    updateLockClock();
    setInterval(updateLockClock, 1000);

    setTimeout(() => {
      recordNotification("SWIR OS 1.1", "NEON CORE extension loaded: lock screen, notifications, wallpapers, movable icons and SWIR Store are online.");
    }, 900);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(init, 0));
  } else {
    setTimeout(init, 0);
  }
})();
