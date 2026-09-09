/* =============================================================
   SWIR OS v1.0 — NEON CORE
   Window manager, launcher, terminal and internal applications
   ============================================================= */

(() => {
  "use strict";

  const APPS = Array.isArray(window.SWIR_APPS) ? window.SWIR_APPS : [];
  const appMap = new Map(APPS.map(app => [app.id, app]));

  const state = {
    z: 200,
    cascade: 0,
    active: null,
    windows: new Map(),
    theme: localStorage.getItem("swir-theme") || "blue",
    sound: localStorage.getItem("swir-sound") !== "off",
    launcherOpen: false
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  function escapeHTML(value = "") {
    return String(value).replace(/[&<>'"]/g, ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;"
    })[ch]);
  }

  function glyph(app, className = "app-glyph") {
    return `<span class="${className}" style="--glyph-color:${app.accent || "#00c8ff"}">${escapeHTML(app.icon || "◆")}</span>`;
  }

  function setTheme(theme) {
    const allowed = ["blue", "green", "purple"];
    const next = allowed.includes(theme) ? theme : "blue";
    state.theme = next;
    document.documentElement.dataset.theme = next;
    localStorage.setItem("swir-theme", next);
    $$(".theme-pill").forEach(btn => btn.classList.toggle("active", btn.dataset.theme === next));
  }

  setTheme(state.theme);

  function playSystemSound() {
    if (!state.sound) return;
    try {
      const audio = new Audio("./ding.mp3");
      audio.volume = 0.24;
      audio.play().catch(() => {});
    } catch (_) {}
  }

  function toast(title, message, timeout = 3200) {
    const stack = $("#toast-stack");
    if (!stack) return;
    const el = document.createElement("div");
    el.className = "toast";
    el.innerHTML = `<strong>${escapeHTML(title)}</strong><span>${escapeHTML(message)}</span>`;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = "0";
      el.style.transform = "translateX(12px)";
      setTimeout(() => el.remove(), 220);
    }, timeout);
  }

  /* -------------------- Boot sequence -------------------- */
  function boot() {
    const log = $("#boot-log");
    const progress = $("#boot-progress-bar");
    const button = $("#enter-os");
    const percent = $("#boot-percent");

    const lines = [
      [12, "> NEON CORE kernel ............... OK"],
      [31, "> Loading window manager ......... OK"],
      [52, "> Mounting preserved apps ........ OK"],
      [71, "> Initializing SWIR LAB .......... OK"],
      [88, "> Network interface .............. READY"],
      [100, "> SYSTEM ONLINE .................. READY"]
    ];

    let index = 0;
    const tick = () => {
      if (index >= lines.length) {
        button.disabled = false;
        button.classList.add("ready");
        button.textContent = "> ENTER SWIR OS";
        return;
      }
      const [value, text] = lines[index++];
      progress.style.width = `${value}%`;
      percent.textContent = `${value}%`;
      const row = document.createElement("div");
      row.className = value === 100 ? "ok" : "";
      row.textContent = text;
      log.appendChild(row);
      setTimeout(tick, 210 + Math.random() * 110);
    };

    setTimeout(tick, 220);

    button.addEventListener("click", () => {
      playSystemSound();
      $("#boot-screen").classList.add("boot-hidden");
      localStorage.setItem("swir-last-boot", Date.now().toString());
      setTimeout(() => {
        toast("SWIR OS", "NEON CORE online. Welcome to the SWIR LAB.");
      }, 520);
    });
  }

  /* -------------------- Desktop + launcher -------------------- */
  function renderDesktopIcons() {
    const host = $("#desktop-icons");
    host.innerHTML = APPS.filter(app => app.desktop).map(app => `
      <button class="desktop-icon" data-open="${escapeHTML(app.id)}" title="${escapeHTML(app.subtitle)}">
        ${glyph(app)}
        <span class="desktop-icon-label">${escapeHTML(app.title)}</span>
      </button>
    `).join("");
  }

  function renderLauncher(filter = "") {
    const host = $("#launcher-list");
    const query = filter.trim().toLowerCase();
    const filtered = APPS.filter(app => {
      if (!query) return true;
      return `${app.title} ${app.subtitle} ${app.category} ${app.id}`.toLowerCase().includes(query);
    });

    const categories = [...new Set(filtered.map(app => app.category))];
    host.innerHTML = categories.map(category => {
      const list = filtered.filter(app => app.category === category);
      return `
        <div class="launcher-category">${escapeHTML(category)}</div>
        ${list.map(app => `
          <button class="launcher-app" data-open="${escapeHTML(app.id)}">
            ${glyph(app)}
            <span><strong>${escapeHTML(app.title)}</strong><span>${escapeHTML(app.subtitle)}</span></span>
          </button>
        `).join("")}
      `;
    }).join("") || `<div class="os-card"><strong>No applications found</strong><span>Try a different search phrase.</span></div>`;
  }

  function toggleLauncher(force) {
    const launcher = $("#launcher");
    const backdrop = $("#launcher-backdrop");
    const start = $("#start-button");
    state.launcherOpen = typeof force === "boolean" ? force : !state.launcherOpen;
    launcher.classList.toggle("open", state.launcherOpen);
    backdrop.classList.toggle("open", state.launcherOpen);
    start.classList.toggle("active", state.launcherOpen);
    if (state.launcherOpen) {
      const input = $("#launcher-search");
      input.value = "";
      renderLauncher();
      setTimeout(() => input.focus(), 80);
    }
  }

  /* -------------------- Window manager -------------------- */
  function focusWindow(id) {
    const entry = state.windows.get(id);
    if (!entry) return;
    state.z += 1;
    entry.el.style.zIndex = state.z;
    state.active = id;
    state.windows.forEach((item, key) => {
      item.el.classList.toggle("focused", key === id && !item.el.classList.contains("minimized"));
      item.task.classList.toggle("active", key === id && !item.el.classList.contains("minimized"));
    });
  }

  function taskButton(app) {
    const btn = document.createElement("button");
    btn.className = "task-button";
    btn.dataset.task = app.id;
    btn.innerHTML = `<span class="task-mini-glyph">${escapeHTML(app.icon)}</span><span class="task-label">${escapeHTML(app.title)}</span>`;
    btn.title = app.title;
    btn.addEventListener("click", () => {
      const entry = state.windows.get(app.id);
      if (!entry) return;
      if (entry.el.classList.contains("minimized")) {
        entry.el.classList.remove("minimized");
        focusWindow(app.id);
      } else if (state.active === app.id) {
        entry.el.classList.add("minimized");
        entry.task.classList.remove("active");
        state.active = null;
      } else {
        focusWindow(app.id);
      }
    });
    $("#task-buttons").appendChild(btn);
    return btn;
  }

  function makeDraggable(win, titlebar, id) {
    let drag = null;

    titlebar.addEventListener("pointerdown", event => {
      if (event.target.closest(".window-control")) return;
      if (win.classList.contains("maximized")) return;
      if (window.matchMedia("(max-width: 760px)").matches) return;
      focusWindow(id);
      const rect = win.getBoundingClientRect();
      drag = {
        dx: event.clientX - rect.left,
        dy: event.clientY - rect.top
      };
      titlebar.setPointerCapture?.(event.pointerId);
    });

    titlebar.addEventListener("pointermove", event => {
      if (!drag) return;
      const layer = $("#window-layer").getBoundingClientRect();
      const rect = win.getBoundingClientRect();
      const left = Math.max(0, Math.min(event.clientX - layer.left - drag.dx, layer.width - Math.min(rect.width, 120)));
      const top = Math.max(0, Math.min(event.clientY - layer.top - drag.dy, layer.height - 48));
      win.style.left = `${left}px`;
      win.style.top = `${top}px`;
    });

    const stop = () => { drag = null; };
    titlebar.addEventListener("pointerup", stop);
    titlebar.addEventListener("pointercancel", stop);
  }

  function makeResizable(win, handle, id) {
    let resize = null;
    handle.addEventListener("pointerdown", event => {
      if (win.classList.contains("maximized")) return;
      focusWindow(id);
      const rect = win.getBoundingClientRect();
      resize = { x: event.clientX, y: event.clientY, w: rect.width, h: rect.height };
      handle.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", event => {
      if (!resize) return;
      win.style.width = `${Math.max(350, resize.w + event.clientX - resize.x)}px`;
      win.style.height = `${Math.max(260, resize.h + event.clientY - resize.y)}px`;
    });
    const stop = () => { resize = null; };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  function closeWindow(id) {
    const entry = state.windows.get(id);
    if (!entry) return;
    entry.el.remove();
    entry.task.remove();
    state.windows.delete(id);
    if (state.active === id) state.active = null;
    const remaining = [...state.windows.keys()];
    if (remaining.length) focusWindow(remaining[remaining.length - 1]);
  }

  function createWindow(app) {
    const layer = $("#window-layer");
    const win = document.createElement("section");
    win.className = "os-window";
    win.dataset.window = app.id;

    const viewportW = layer.clientWidth;
    const viewportH = layer.clientHeight;
    const w = Math.min(900, Math.max(560, viewportW * .72));
    const h = Math.min(620, Math.max(380, viewportH * .72));
    const offset = (state.cascade++ % 7) * 24;
    win.style.width = `${Math.min(w, viewportW - 24)}px`;
    win.style.height = `${Math.min(h, viewportH - 24)}px`;
    win.style.left = `${Math.max(8, (viewportW - Math.min(w, viewportW - 24)) / 2 + offset - 72)}px`;
    win.style.top = `${Math.max(8, (viewportH - Math.min(h, viewportH - 24)) / 2 + offset - 40)}px`;

    win.innerHTML = `
      <header class="window-titlebar">
        <div class="window-title">
          ${glyph(app)}
          <div class="window-title-text">
            <strong>${escapeHTML(app.title)}</strong>
            <span>${escapeHTML(app.subtitle)}</span>
          </div>
        </div>
        <div class="window-controls">
          <button class="window-control minimize" title="Minimize">—</button>
          <button class="window-control maximize" title="Maximize">□</button>
          <button class="window-control close" title="Close">×</button>
        </div>
      </header>
      <div class="window-body"></div>
      <div class="resize-handle"></div>
    `;

    layer.appendChild(win);
    const task = taskButton(app);
    state.windows.set(app.id, { el: win, task, app });

    win.addEventListener("pointerdown", () => focusWindow(app.id));
    $(".window-control.close", win).addEventListener("click", () => closeWindow(app.id));
    $(".window-control.minimize", win).addEventListener("click", () => {
      win.classList.add("minimized");
      task.classList.remove("active");
      state.active = null;
    });
    $(".window-control.maximize", win).addEventListener("click", () => {
      win.classList.toggle("maximized");
      focusWindow(app.id);
    });
    $(".window-titlebar", win).addEventListener("dblclick", event => {
      if (!event.target.closest(".window-control")) win.classList.toggle("maximized");
    });

    makeDraggable(win, $(".window-titlebar", win), app.id);
    makeResizable(win, $(".resize-handle", win), app.id);
    focusWindow(app.id);
    return win;
  }

  function openApp(id) {
    const app = appMap.get(id);
    if (!app) {
      toast("SWIR OS", `Application '${id}' not found.`);
      return;
    }

    toggleLauncher(false);

    if (app.type === "external") {
      window.open(app.url, "_blank", "noopener,noreferrer");
      return;
    }

    if (state.windows.has(id)) {
      const entry = state.windows.get(id);
      entry.el.classList.remove("minimized");
      focusWindow(id);
      return;
    }

    const win = createWindow(app);
    const body = $(".window-body", win);

    if (app.type === "iframe") {
      const frame = document.createElement("iframe");
      frame.src = app.url;
      frame.title = app.title;
      frame.loading = "eager";
      frame.allow = "autoplay; fullscreen; clipboard-read; clipboard-write";
      body.appendChild(frame);
      return;
    }

    body.innerHTML = internalAppHTML(app.id);
    hydrateInternalApp(app.id, body);
  }

  /* -------------------- Internal applications -------------------- */
  function internalAppHTML(id) {
    if (id === "terminal") {
      return `
        <div class="terminal-app">
          <div class="terminal-output" id="terminal-output"><span class="term-accent">SWIR OS Terminal v1.0 / NEON CORE</span>\n<span class="term-muted">Type 'help' to list available commands.</span>\n\n</div>
          <div class="terminal-input-row">
            <span class="terminal-prompt">swir@neon-core:~$</span>
            <input class="terminal-input" id="terminal-input" autocomplete="off" spellcheck="false" aria-label="Terminal command">
          </div>
        </div>`;
    }

    if (id === "retro") {
      const retroIds = ["atari", "c64", "mac", "winamp"];
      return `
        <div class="internal-app">
          <div class="app-hero"><div class="eyebrow">SWIR RETRO VAULT</div><h1>Old machines. New shell.</h1><p>Your preserved retro folders launch inside SWIR OS windows. Their original files stay untouched.</p></div>
          <div class="card-grid">
            ${retroIds.map(appId => appCard(appMap.get(appId))).join("")}
          </div>
        </div>`;
    }

    if (id === "apps") {
      const categories = [...new Set(APPS.map(app => app.category))];
      return `
        <div class="internal-app">
          <div class="app-hero"><div class="eyebrow">APPLICATION CENTER</div><h1>SWIR OS Apps</h1><p>Launch system tools, retro zones, experiments and developer utilities from one place.</p></div>
          ${categories.map(category => `
            <div class="section-title">${escapeHTML(category.toUpperCase())}</div>
            <div class="card-grid">${APPS.filter(app => app.category === category).map(appCard).join("")}</div>
          `).join("")}
        </div>`;
    }

    if (id === "filehub") {
      const preserved = ["atari", "c64", "mac", "matrix", "time", "time2", "tomi", "test", "testy", "winamp"];
      return `
        <div class="internal-app">
          <div class="app-hero"><div class="eyebrow">PRESERVED STORAGE</div><h1>File Hub</h1><p>These are the original site folders mounted as SWIR OS applications. Nothing inside them was modified.</p></div>
          <div class="card-grid">${preserved.map(appId => appCard(appMap.get(appId))).join("")}</div>
        </div>`;
    }

    if (id === "projects") {
      return `
        <div class="internal-app">
          <div class="app-hero"><div class="eyebrow">LIVE GITHUB LINK</div><h1>SWIR Projects</h1><p>Public repositories are loaded directly from GitHub. Updated projects appear here automatically.</p></div>
          <div id="repo-status" class="os-card"><strong>Connecting to GitHub...</strong><span>Loading repository data.</span></div>
          <div id="repo-grid" class="repo-grid" style="margin-top:12px"></div>
        </div>`;
    }

    if (id === "settings") {
      return `
        <div class="internal-app">
          <div class="app-hero"><div class="eyebrow">NEON CORE CONTROL</div><h1>Settings</h1><p>Personalization is stored locally in your browser.</p></div>
          <div class="setting-row">
            <div><strong>Color core</strong><span>Change the main SWIR OS accent.</span></div>
            <div class="theme-pills">
              <button class="theme-pill" data-theme="blue">BLUE</button>
              <button class="theme-pill" data-theme="green">GREEN</button>
              <button class="theme-pill" data-theme="purple">PURPLE</button>
            </div>
          </div>
          <div class="setting-row">
            <div><strong>System sound</strong><span>Play the existing ding.mp3 on system actions.</span></div>
            <button id="sound-toggle" class="toggle ${state.sound ? "on" : ""}" aria-label="Toggle sound"></button>
          </div>
          <div class="setting-row">
            <div><strong>Reset preferences</strong><span>Restore the default blue core and sound.</span></div>
            <button id="reset-settings" class="os-button">RESET</button>
          </div>
        </div>`;
    }

    if (id === "browser") {
      return `
        <div class="browser-shell">
          <div class="browser-bar">
            <input id="browser-address" class="browser-address" value="./matrix/" aria-label="Address">
            <button id="browser-go" class="os-button">GO</button>
            <button id="browser-new" class="os-button">NEW TAB</button>
          </div>
          <div class="browser-frame"><iframe id="browser-iframe" src="./matrix/" title="SWIR Browser"></iframe></div>
        </div>`;
    }

    if (id === "about") {
      return `
        <div class="internal-app">
          <div class="app-hero"><div class="eyebrow">SWIR OS v1.0</div><h1>NEON CORE</h1><p>A custom browser operating-system interface built for swir.github.io. It replaces the old Windows-inspired shell while keeping the original site folders intact.</p></div>
          <div class="card-grid">
            <div class="os-card"><strong>Window Manager</strong><span>Move, minimize, maximize, resize and focus applications.</span></div>
            <div class="os-card"><strong>Responsive Core</strong><span>Desktop windows on PC; full-screen application mode on phones.</span></div>
            <div class="os-card"><strong>Terminal</strong><span>Built-in command console with app launcher commands and easter eggs.</span></div>
            <div class="os-card"><strong>Preserved Apps</strong><span>Atari, C64, Mac, Matrix, Winamp and other existing folders are mounted without modification.</span></div>
          </div>
          <div class="section-title">BUILD INFO</div>
          <div class="os-card"><strong>SWIR OS / NEON CORE</strong><span>Version 1.0 • Build 2026.09 • Web platform • Created for Swir</span></div>
        </div>`;
    }

    return `<div class="internal-app"><div class="os-card"><strong>${escapeHTML(id)}</strong><span>Internal module ready.</span></div></div>`;
  }

  function appCard(app) {
    if (!app) return "";
    return `
      <button class="action-card" data-open="${escapeHTML(app.id)}">
        ${glyph(app)}
        <strong>${escapeHTML(app.title)}</strong>
        <span>${escapeHTML(app.subtitle)}</span>
      </button>`;
  }

  function hydrateInternalApp(id, root) {
    if (id === "terminal") hydrateTerminal(root);
    if (id === "projects") loadProjects(root);
    if (id === "settings") hydrateSettings(root);
    if (id === "browser") hydrateBrowser(root);
  }

  function hydrateSettings(root) {
    $$(".theme-pill", root).forEach(btn => {
      btn.classList.toggle("active", btn.dataset.theme === state.theme);
      btn.addEventListener("click", () => {
        setTheme(btn.dataset.theme);
        playSystemSound();
        toast("Settings", `Color core changed to ${btn.dataset.theme.toUpperCase()}.`);
      });
    });

    $("#sound-toggle", root).addEventListener("click", event => {
      state.sound = !state.sound;
      localStorage.setItem("swir-sound", state.sound ? "on" : "off");
      event.currentTarget.classList.toggle("on", state.sound);
      if (state.sound) playSystemSound();
    });

    $("#reset-settings", root).addEventListener("click", () => {
      state.sound = true;
      localStorage.setItem("swir-sound", "on");
      setTheme("blue");
      $("#sound-toggle", root).classList.add("on");
      toast("Settings", "Default SWIR OS preferences restored.");
      playSystemSound();
    });
  }

  function hydrateBrowser(root) {
    const address = $("#browser-address", root);
    const frame = $("#browser-iframe", root);
    const navigate = (newTab = false) => {
      let value = address.value.trim();
      if (!value) return;
      const isExternal = /^https?:\/\//i.test(value);
      if (isExternal) {
        if (newTab || !value.startsWith(location.origin)) {
          window.open(value, "_blank", "noopener,noreferrer");
          toast("SWIR Browser", "External site opened in a new tab for compatibility.");
        } else {
          frame.src = value;
        }
        return;
      }
      if (!value.startsWith(".") && !value.startsWith("/")) value = `./${value}`;
      frame.src = value;
    };
    $("#browser-go", root).addEventListener("click", () => navigate(false));
    $("#browser-new", root).addEventListener("click", () => navigate(true));
    address.addEventListener("keydown", event => {
      if (event.key === "Enter") navigate(false);
    });
  }

  async function loadProjects(root) {
    const status = $("#repo-status", root);
    const grid = $("#repo-grid", root);
    try {
      const response = await fetch("https://api.github.com/users/Swir/repos?sort=updated&direction=desc&per_page=12", {
        headers: { "Accept": "application/vnd.github+json" }
      });
      if (!response.ok) throw new Error(`GitHub ${response.status}`);
      const repos = await response.json();
      status.remove();
      grid.innerHTML = repos.filter(repo => !repo.fork).slice(0, 10).map(repo => `
        <article class="repo-card">
          <a href="${escapeHTML(repo.html_url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(repo.name)}</a>
          <p>${escapeHTML(repo.description || "SWIR project — open the repository to learn more.")}</p>
          <div class="repo-meta"><span>★ ${repo.stargazers_count}</span><span>⑂ ${repo.forks_count}</span><span>${escapeHTML(repo.language || "Code")}</span></div>
        </article>
      `).join("");
      const widgetRepos = $("#widget-repos");
      if (widgetRepos) widgetRepos.textContent = repos.length;
    } catch (error) {
      status.innerHTML = `<strong>GitHub temporarily unavailable</strong><span>${escapeHTML(error.message)}. Use the GitHub icon to open the profile directly.</span>`;
    }
  }

  /* -------------------- Terminal -------------------- */
  function hydrateTerminal(root) {
    const output = $("#terminal-output", root);
    const input = $("#terminal-input", root);
    const history = [];
    let historyIndex = 0;

    const print = (text = "", cls = "") => {
      const line = document.createElement("div");
      if (cls) line.className = cls;
      line.textContent = text;
      output.appendChild(line);
      output.scrollTop = output.scrollHeight;
    };

    const commands = {
      help() {
        print("Available commands:", "term-accent");
        print("  help                 list commands");
        print("  about                system information");
        print("  apps                 list applications");
        print("  open <app>           launch an application");
        print("  projects             open GitHub Projects");
        print("  retro                open Retro Vault");
        print("  matrix               enter Matrix app");
        print("  github               open github.com/Swir");
        print("  theme blue|green|purple");
        print("  whoami               current user");
        print("  ls                    mounted folders");
        print("  date                  local system time");
        print("  clear                 clear terminal");
        print("  coffee / sudo / hack  maybe try them...", "term-muted");
      },
      about() {
        print("SWIR OS v1.0 / NEON CORE", "term-accent");
        print("Browser desktop, window manager and application shell.");
        print("Build: 2026.09 | Status: ONLINE", "term-ok");
      },
      apps() {
        APPS.forEach(app => print(`${app.id.padEnd(12)} ${app.title}`));
      },
      projects() { openApp("projects"); },
      retro() { openApp("retro"); },
      matrix() { openApp("matrix"); },
      github() { openApp("github"); },
      whoami() {
        print("SWIR // Creator // Developer // Experimenter", "term-accent");
      },
      ls() {
        print("Atari/  C64/  Mac/  matrix/  test/  testy/  time/  time2/  tomi/  winamp/", "term-ok");
      },
      date() { print(new Date().toString()); },
      clear() { output.innerHTML = ""; },
      coffee() {
        print("[ BREWING COFFEE ] ████████████████████ 100%", "term-warn");
        print("Coffee module ready. Productivity +42%.");
      },
      sudo() {
        print("SWIR is already the creator of this system.", "term-warn");
        print("ACCESS LEVEL: CREATOR", "term-accent");
      },
      hack() {
        print("Nice try 😎", "term-ok");
        print("NEON CORE security simulation enabled. No actual hacking performed.", "term-muted");
      }
    };

    function execute(raw) {
      const value = raw.trim();
      if (!value) return;
      history.push(value);
      historyIndex = history.length;
      print(`swir@neon-core:~$ ${value}`, "term-ok");
      const [cmdRaw, ...args] = value.split(/\s+/);
      const cmd = cmdRaw.toLowerCase();

      if (cmd === "open") {
        const id = (args[0] || "").toLowerCase();
        if (!id) print("Usage: open <app>", "term-warn");
        else if (!appMap.has(id)) print(`Application not found: ${id}`, "term-warn");
        else openApp(id);
        return;
      }

      if (cmd === "theme") {
        const theme = (args[0] || "").toLowerCase();
        if (!["blue", "green", "purple"].includes(theme)) {
          print("Usage: theme blue|green|purple", "term-warn");
        } else {
          setTheme(theme);
          print(`Theme core switched to ${theme.toUpperCase()}.`, "term-ok");
        }
        return;
      }

      if (cmd === "echo") {
        print(args.join(" "));
        return;
      }

      if (commands[cmd]) commands[cmd]();
      else print(`Command not found: ${cmd}. Type 'help'.`, "term-warn");
    }

    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        execute(input.value);
        input.value = "";
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        if (history.length) {
          historyIndex = Math.max(0, historyIndex - 1);
          input.value = history[historyIndex] || "";
        }
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        historyIndex = Math.min(history.length, historyIndex + 1);
        input.value = history[historyIndex] || "";
      }
    });

    setTimeout(() => input.focus(), 120);
  }

  /* -------------------- Clock / GitHub status -------------------- */
  function updateClock() {
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const date = now.toLocaleDateString([], { day: "2-digit", month: "2-digit" });
    const trayClock = $("#tray-clock");
    const topClock = $("#top-clock");
    if (trayClock) trayClock.textContent = time;
    if (topClock) topClock.textContent = `${date} • ${time}`;
  }

  async function updateProfileWidget() {
    try {
      const [profileRes, reposRes] = await Promise.all([
        fetch("https://api.github.com/users/Swir"),
        fetch("https://api.github.com/users/Swir/repos?per_page=100")
      ]);
      if (profileRes.ok) {
        const profile = await profileRes.json();
        $("#widget-followers").textContent = profile.followers ?? "—";
      }
      if (reposRes.ok) {
        const repos = await reposRes.json();
        $("#widget-repos").textContent = repos.length;
        const stars = repos.reduce((sum, repo) => sum + (repo.stargazers_count || 0), 0);
        $("#widget-stars").textContent = stars;
      }
    } catch (_) {}
  }

  /* -------------------- Global events -------------------- */
  function wireEvents() {
    document.addEventListener("click", event => {
      const open = event.target.closest("[data-open]");
      if (open) {
        openApp(open.dataset.open);
        return;
      }
    });

    $("#start-button").addEventListener("click", () => toggleLauncher());
    $("#launcher-backdrop").addEventListener("click", () => toggleLauncher(false));
    $("#launcher-search").addEventListener("input", event => renderLauncher(event.target.value));

    document.addEventListener("keydown", event => {
      if (event.key === "Escape") toggleLauncher(false);
      if (event.ctrlKey && event.code === "Space") {
        event.preventDefault();
        toggleLauncher();
      }
      if (event.altKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        openApp("terminal");
      }
    });
  }

  function init() {
    renderDesktopIcons();
    renderLauncher();
    wireEvents();
    updateClock();
    setInterval(updateClock, 1000);
    updateProfileWidget();
    boot();

    // Public API for internal experiments or future SWIR OS apps.
    window.SwirOS = {
      open: openApp,
      close: closeWindow,
      toast,
      setTheme,
      apps: APPS
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
