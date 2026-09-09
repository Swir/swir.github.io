/* SWIR OS v1.2 — application registry
   Existing folders are referenced only; their contents are not modified. */

window.SWIR_APPS = [
  {
    id: "apps",
    title: "App Center",
    subtitle: "All SWIR OS applications",
    icon: "◫",
    category: "System",
    type: "internal",
    accent: "#00c8ff",
    desktop: true
  },
  {
    id: "store",
    title: "SWIR Store",
    subtitle: "Install desktop shortcuts",
    icon: "S+",
    category: "System",
    type: "iframe",
    url: "./swir-store.html",
    accent: "#00d8ff",
    desktop: true
  },
  {
    id: "files",
    title: "File Explorer",
    subtitle: "Virtual files, preserved folders and Trash",
    icon: "▤",
    category: "System",
    type: "iframe",
    url: "./swir-files.html",
    accent: "#53c7ff",
    desktop: true
  },
  {
    id: "notes",
    title: "Notes",
    subtitle: "Autosaving local notes",
    icon: "N",
    category: "Productivity",
    type: "iframe",
    url: "./swir-notes.html",
    accent: "#55e6c1",
    desktop: true
  },
  {
    id: "calc",
    title: "Calculator",
    subtitle: "Scientific-style quick calculator",
    icon: "±",
    category: "Productivity",
    type: "iframe",
    url: "./swir-calc.html",
    accent: "#74b9ff",
    desktop: true
  },
  {
    id: "player",
    title: "SWIR Player",
    subtitle: "Local audio and system sounds",
    icon: "▶",
    category: "Media",
    type: "iframe",
    url: "./swir-player.html",
    accent: "#ff8fd8",
    desktop: true
  },
  {
    id: "monitor",
    title: "System Monitor",
    subtitle: "Browser, storage and network telemetry",
    icon: "▥",
    category: "System",
    type: "iframe",
    url: "./swir-monitor.html",
    accent: "#7dffb3",
    desktop: true
  },
  {
    id: "terminal",
    title: "Terminal",
    subtitle: "SWIR command console",
    icon: ">_",
    category: "System",
    type: "internal",
    accent: "#00e5ff",
    desktop: true
  },
  {
    id: "projects",
    title: "GitHub Projects",
    subtitle: "Live repository dashboard",
    icon: "</>",
    category: "Developer",
    type: "internal",
    accent: "#48a8ff",
    desktop: true
  },
  {
    id: "retro",
    title: "Retro Vault",
    subtitle: "Atari, C64, Mac and Winamp",
    icon: "◆",
    category: "Retro",
    type: "internal",
    accent: "#9c7cff",
    desktop: true
  },
  {
    id: "matrix",
    title: "Matrix",
    subtitle: "Enter the Matrix zone",
    icon: "▦",
    category: "Experiments",
    type: "iframe",
    url: "./matrix/",
    accent: "#39ff88",
    desktop: true
  },
  {
    id: "atari",
    title: "Atari",
    subtitle: "Retro Atari zone",
    icon: "A",
    category: "Retro",
    type: "iframe",
    url: "./Atari/",
    accent: "#ff725c"
  },
  {
    id: "c64",
    title: "Commodore 64",
    subtitle: "C64 retro zone",
    icon: "64",
    category: "Retro",
    type: "iframe",
    url: "./C64/",
    accent: "#7c8cff"
  },
  {
    id: "mac",
    title: "Classic Mac",
    subtitle: "Classic Macintosh zone",
    icon: "M",
    category: "Retro",
    type: "iframe",
    url: "./Mac/",
    accent: "#b8c7d9"
  },
  {
    id: "winamp",
    title: "Winamp",
    subtitle: "Retro music player",
    icon: "♫",
    category: "Retro",
    type: "iframe",
    url: "./winamp/",
    accent: "#ffb347"
  },
  {
    id: "time",
    title: "Time Lab",
    subtitle: "Clock experiment",
    icon: "◷",
    category: "Experiments",
    type: "iframe",
    url: "./time/",
    accent: "#00c8ff"
  },
  {
    id: "time2",
    title: "Time Lab 2",
    subtitle: "Second clock experiment",
    icon: "◴",
    category: "Experiments",
    type: "iframe",
    url: "./time2/",
    accent: "#00a6ff"
  },
  {
    id: "tomi",
    title: "Tomi Lab",
    subtitle: "SWIR experiment",
    icon: "T",
    category: "Experiments",
    type: "iframe",
    url: "./tomi/",
    accent: "#53d6c7"
  },
  {
    id: "test",
    title: "Test Lab",
    subtitle: "Development sandbox",
    icon: "⚗",
    category: "Labs",
    type: "iframe",
    url: "./test/",
    accent: "#ec68ff"
  },
  {
    id: "testy",
    title: "Test Lab 2",
    subtitle: "Development sandbox",
    icon: "✦",
    category: "Labs",
    type: "iframe",
    url: "./testy/",
    accent: "#ca72ff"
  },
  {
    id: "filehub",
    title: "File Hub",
    subtitle: "Launch preserved site folders",
    icon: "▣",
    category: "System",
    type: "internal",
    accent: "#54b8ff",
    desktop: false
  },
  {
    id: "browser",
    title: "SWIR Browser",
    subtitle: "Quick web launcher",
    icon: "◎",
    category: "Internet",
    type: "internal",
    accent: "#00d4ff"
  },
  {
    id: "github",
    title: "GitHub",
    subtitle: "github.com/Swir",
    icon: "GH",
    category: "Internet",
    type: "external",
    url: "https://github.com/Swir",
    accent: "#ffffff",
    desktop: true
  },
  {
    id: "settings",
    title: "Settings",
    subtitle: "Personalize SWIR OS",
    icon: "⚙",
    category: "System",
    type: "internal",
    accent: "#7cc7ff",
    desktop: true
  },
  {
    id: "about",
    title: "About SWIR OS",
    subtitle: "NEON CORE build information",
    icon: "i",
    category: "System",
    type: "internal",
    accent: "#00a6ff"
  }
];
