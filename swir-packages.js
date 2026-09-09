/* SWIR OS 1.7 — official package catalog */
window.SWIR_PACKAGE_CATALOG = Object.freeze([
  {
    schema:"swir.app/1.0", id:"code", packageId:"swir.code", name:"SWIR Code", version:"1.1.0", author:"SWIR",
    description:"Code and text editor with local projects, file import/export and HTML preview.",
    category:"Developer", icon:"</>", accent:"#48a8ff", type:"iframe", entry:"./swir-code.html", desktop:true,
    permissions:["files.read","files.write","clipboard","downloads"],
    associations:[".txt",".html",".htm",".css",".js",".json",".md",".log"],
    appData:"SWIR://APPDATA/CODE", tags:["code","editor","html","javascript","text"],
    compatibility:{minOS:"1.7.0",minSDK:"1.2.0",platformApi:2,editions:["WEB","DESKTOP","SYSTEM"]},
    dependencies:[], optionalDependencies:[]
  },
  {
    schema:"swir.app/1.0", id:"image", packageId:"swir.image-studio", name:"Image Studio", version:"1.1.0", author:"SWIR",
    description:"Local image editor with rotate, mirror, grayscale, brightness and PNG/JPEG export.",
    category:"Creative", icon:"IMG", accent:"#ff8fd8", type:"iframe", entry:"./swir-image.html", desktop:true,
    permissions:["files.read","files.write","downloads"],
    associations:[".png",".jpg",".jpeg",".webp",".gif"],
    appData:"SWIR://APPDATA/IMAGE", tags:["image","photo","canvas","editor"],
    compatibility:{minOS:"1.7.0",minSDK:"1.2.0",platformApi:2,editions:["WEB","DESKTOP","SYSTEM"]},
    dependencies:[], optionalDependencies:[]
  },
  {
    schema:"swir.app/1.0", id:"archive", packageId:"swir.archive", name:"Archive Manager", version:"1.1.0", author:"SWIR",
    description:"Create ZIP archives locally and inspect/extract compatible ZIP files without uploading data.",
    category:"Utilities", icon:"ZIP", accent:"#ffca72", type:"iframe", entry:"./swir-archive.html", desktop:true,
    permissions:["files.read","files.write","downloads"], associations:[".zip"],
    appData:"SWIR://APPDATA/ARCHIVE", tags:["zip","archive","files","compress"],
    compatibility:{minOS:"1.7.0",minSDK:"1.2.0",platformApi:2,editions:["WEB","DESKTOP","SYSTEM"]},
    dependencies:[], optionalDependencies:[]
  },
  {
    schema:"swir.app/1.0", id:"pdf", packageId:"swir.pdf-viewer", name:"PDF Viewer", version:"1.1.0", author:"SWIR",
    description:"Open local PDF documents in a dedicated SWIR OS window.",
    category:"Productivity", icon:"PDF", accent:"#ff718c", type:"iframe", entry:"./swir-pdf.html", desktop:true,
    permissions:["files.read"], associations:[".pdf"],
    appData:"SWIR://APPDATA/PDF", tags:["pdf","documents","viewer"],
    compatibility:{minOS:"1.7.0",minSDK:"1.2.0",platformApi:2,editions:["WEB","DESKTOP","SYSTEM"]},
    dependencies:[], optionalDependencies:[]
  },
  {
    schema:"swir.app/1.0", id:"chat", packageId:"swir.chat", name:"SWIR Chat", version:"1.0.0", author:"SWIR",
    description:"Live multi-user chat connected to a self-hosted SWIR Chat API.",
    category:"Communication", icon:"CH", accent:"#35e6ff", type:"iframe", entry:"./swir-chat.html", desktop:true,
    permissions:["network","storage","identity.basic","notifications"], associations:[],
    appData:"SWIR://APPDATA/CHAT", tags:["chat","social","server","live"],
    compatibility:{minOS:"1.7.0",minSDK:"1.2.0",platformApi:2,editions:["WEB","DESKTOP","SYSTEM"]},
    dependencies:[], optionalDependencies:[]
  }
]);

window.SWIR_PERMISSION_INFO = Object.freeze({
  "files.read":"Read files selected by the user or opened through SWIR File Explorer",
  "files.write":"Save data/files through supported SWIR or browser APIs",
  "clipboard":"Use clipboard features when the browser allows it",
  "downloads":"Create files for download/export",
  "network":"Connect to network/API endpoints",
  "storage":"Store application data locally",
  "identity.basic":"Read the active SWIR profile display name/basic identity",
  "notifications":"Create SWIR OS notifications"
});
