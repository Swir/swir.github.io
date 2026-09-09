/* SWIR OS v1.5 — application registry
   Active environment contains only current SWIR modules. Legacy/retro folders are not used. */

window.SWIR_APPS = [
  { id:"apps", title:"App Center", subtitle:"All SWIR OS applications", icon:"◫", category:"System", type:"internal", accent:"#00c8ff", desktop:true },
  { id:"store", title:"SWIR Store", subtitle:"Install SWIR packages and shortcuts", icon:"S+", category:"System", type:"iframe", url:"./swir-store.html", accent:"#00d8ff", desktop:true },
  { id:"files", title:"File Explorer", subtitle:"Virtual files, system apps and Trash", icon:"▤", category:"System", type:"iframe", url:"./swir-files.html", accent:"#53c7ff", desktop:true },
  { id:"chat", title:"SWIR Chat", subtitle:"Live chat through your own API server", icon:"CH", category:"Communication", type:"iframe", url:"./swir-chat.html", accent:"#35e6ff", desktop:true },
  { id:"chatkit", title:"Chat Server Kit", subtitle:"Download API backend and install guide", icon:"API", category:"Communication", type:"iframe", url:"./swir-chat-kit.html", accent:"#66f0ff", desktop:false },
  { id:"notes", title:"Notes", subtitle:"Autosaving local notes", icon:"N", category:"Productivity", type:"iframe", url:"./swir-notes.html", accent:"#55e6c1", desktop:true },
  { id:"calc", title:"Calculator", subtitle:"Scientific-style quick calculator", icon:"±", category:"Productivity", type:"iframe", url:"./swir-calc.html", accent:"#74b9ff", desktop:true },
  { id:"player", title:"SWIR Player", subtitle:"Local audio and system sounds", icon:"▶", category:"Media", type:"iframe", url:"./swir-player.html", accent:"#ff8fd8", desktop:true },
  { id:"matrix", title:"SWIR Matrix", subtitle:"Native digital-rain renderer", icon:"01", category:"Visual", type:"iframe", url:"./swir-matrix.html", accent:"#39ff88", desktop:true },
  { id:"monitor", title:"System Monitor", subtitle:"Browser, storage and network telemetry", icon:"▥", category:"System", type:"iframe", url:"./swir-monitor.html", accent:"#7dffb3", desktop:true },

  { id:"device", title:"Device Manager", subtitle:"Hostname, hardware and runtime information", icon:"DV", category:"System", type:"iframe", url:"./swir-device.html", accent:"#35e6ff", desktop:false },
  { id:"network", title:"Network Center", subtitle:"Connection status and portable network profiles", icon:"NET", category:"System", type:"iframe", url:"./swir-network.html", accent:"#50e3a4", desktop:false },
  { id:"users", title:"User Manager", subtitle:"Profiles, roles, PIN and active session", icon:"US", category:"System", type:"iframe", url:"./swir-users.html", accent:"#35e6ff", desktop:false },
  { id:"taskmgr", title:"Task Manager", subtitle:"Running SWIR OS application processes", icon:"▧", category:"System", type:"iframe", url:"./swir-taskmgr.html", accent:"#7df0ff", desktop:false },
  { id:"services", title:"SWIR Services", subtitle:"System service and adapter status", icon:"SV", category:"System", type:"iframe", url:"./swir-services.html", accent:"#35e6ff", desktop:false },
  { id:"updates", title:"Update Center", subtitle:"GitHub, cache and runtime updates", icon:"↻", category:"System", type:"iframe", url:"./swir-updates.html", accent:"#50e3a4", desktop:false },
  { id:"control", title:"Platform Control", subtitle:"Permissions, packages and clipboard", icon:"◇", category:"System", type:"iframe", url:"./swir-control.html", accent:"#b58cff", desktop:false },

  { id:"terminal", title:"Terminal", subtitle:"SWIR command console", icon:">_", category:"System", type:"internal", accent:"#00e5ff", desktop:true },
  { id:"projects", title:"GitHub Projects", subtitle:"Live repository dashboard", icon:"</>", category:"Developer", type:"internal", accent:"#48a8ff", desktop:true },
  { id:"browser", title:"SWIR Browser", subtitle:"Quick web launcher", icon:"◎", category:"Internet", type:"internal", accent:"#00d4ff" },
  { id:"github", title:"GitHub", subtitle:"github.com/Swir", icon:"GH", category:"Internet", type:"external", url:"https://github.com/Swir", accent:"#ffffff", desktop:true },
  { id:"settings", title:"System Settings", subtitle:"Device, appearance, session and storage settings", icon:"⚙", category:"System", type:"iframe", url:"./swir-settings.html", accent:"#7cc7ff", desktop:true },
  { id:"about", title:"About SWIR OS", subtitle:"NEON CORE build information", icon:"i", category:"System", type:"internal", accent:"#00a6ff" }
];
