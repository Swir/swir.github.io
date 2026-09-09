/* SWIR OS v1.3 — native application registry
   Legacy repository folders are no longer used by the active operating environment. */

window.SWIR_APPS = [
  { id:"apps", title:"App Center", subtitle:"All SWIR OS applications", icon:"◫", category:"System", type:"internal", accent:"#00c8ff", desktop:true },
  { id:"store", title:"SWIR Store", subtitle:"Install SWIR packages and shortcuts", icon:"S+", category:"System", type:"iframe", url:"./swir-store.html", accent:"#00d8ff", desktop:true },
  { id:"files", title:"File Explorer", subtitle:"Virtual files, system apps and Trash", icon:"▤", category:"System", type:"iframe", url:"./swir-files.html", accent:"#53c7ff", desktop:true },
  { id:"notes", title:"Notes", subtitle:"Autosaving local notes", icon:"N", category:"Productivity", type:"iframe", url:"./swir-notes.html", accent:"#55e6c1", desktop:true },
  { id:"calc", title:"Calculator", subtitle:"Scientific-style quick calculator", icon:"±", category:"Productivity", type:"iframe", url:"./swir-calc.html", accent:"#74b9ff", desktop:true },
  { id:"player", title:"SWIR Player", subtitle:"Local audio and system sounds", icon:"▶", category:"Media", type:"iframe", url:"./swir-player.html", accent:"#ff8fd8", desktop:true },
  { id:"monitor", title:"System Monitor", subtitle:"Browser, storage and network telemetry", icon:"▥", category:"System", type:"iframe", url:"./swir-monitor.html", accent:"#7dffb3", desktop:true },

  { id:"taskmgr", title:"Task Manager", subtitle:"Running SWIR OS application processes", icon:"▧", category:"System", type:"iframe", url:"./swir-taskmgr.html", accent:"#7df0ff", desktop:false },
  { id:"updates", title:"Update Center", subtitle:"GitHub, cache and runtime updates", icon:"↻", category:"System", type:"iframe", url:"./swir-updates.html", accent:"#50e3a4", desktop:false },
  { id:"control", title:"Platform Control", subtitle:"Permissions, packages and clipboard", icon:"◇", category:"System", type:"iframe", url:"./swir-control.html", accent:"#b58cff", desktop:false },

  { id:"terminal", title:"Terminal", subtitle:"SWIR command console", icon:">_", category:"System", type:"internal", accent:"#00e5ff", desktop:true },
  { id:"projects", title:"GitHub Projects", subtitle:"Live repository dashboard", icon:"</>", category:"Developer", type:"internal", accent:"#48a8ff", desktop:true },
  { id:"retro", title:"Retro Hub", subtitle:"Native SWIR retro systems", icon:"◆", category:"Retro", type:"iframe", url:"./swir-retro.html", accent:"#9c7cff", desktop:true },

  { id:"atari", title:"SWIR Atari Lab", subtitle:"Native 8-bit arcade console", icon:"A8", category:"Retro", type:"iframe", url:"./swir-atari.html", accent:"#ff725c" },
  { id:"c64", title:"SWIR C64 Lab", subtitle:"Native BASIC-style 8-bit computer", icon:"64", category:"Retro", type:"iframe", url:"./swir-c64.html", accent:"#7c8cff" },
  { id:"mac", title:"SWIR Classic Mac", subtitle:"Native monochrome desktop lab", icon:"M", category:"Retro", type:"iframe", url:"./swir-mac.html", accent:"#d4d4d4" },
  { id:"swiramp", title:"SWIR Amp", subtitle:"Native retro audio player", icon:"♫", category:"Retro", type:"iframe", url:"./swir-amp.html", accent:"#ffb347" },
  { id:"matrix", title:"SWIR Matrix", subtitle:"Native digital-rain renderer", icon:"01", category:"Experiments", type:"iframe", url:"./swir-matrix.html", accent:"#39ff88", desktop:true },

  { id:"browser", title:"SWIR Browser", subtitle:"Quick web launcher", icon:"◎", category:"Internet", type:"internal", accent:"#00d4ff" },
  { id:"github", title:"GitHub", subtitle:"github.com/Swir", icon:"GH", category:"Internet", type:"external", url:"https://github.com/Swir", accent:"#ffffff", desktop:true },
  { id:"settings", title:"Settings", subtitle:"Personalize SWIR OS", icon:"⚙", category:"System", type:"internal", accent:"#7cc7ff", desktop:true },
  { id:"about", title:"About SWIR OS", subtitle:"NEON CORE build information", icon:"i", category:"System", type:"internal", accent:"#00a6ff" }
];
