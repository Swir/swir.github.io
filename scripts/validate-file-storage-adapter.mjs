import fs from 'node:fs';

function read(path){return fs.readFileSync(path,'utf8')}
function assert(ok,message){if(!ok)throw new Error(message)}

const adapter=read('swir-file-storage.js');
const bridge=read('swir-platform-bridge.js');
const shell=read('swir-desktop.html');
const publicIndex=read('index.html');
const worker=read('sw.js');
const stage=read('desktop/windows/stage-desktop-runtime.ps1');

assert(adapter.includes("const SCHEMA='swir.file-explorer-state/1.0'"),'storage schema missing');
assert(adapter.includes("indexedDB.open(DB_NAME,DB_VERSION)"),'IndexedDB provider missing');
assert(adapter.includes("provider='web-indexeddb'"),'Web IndexedDB provider state missing');
assert(adapter.includes("provider='desktop-native-manifest'"),'Desktop native provider missing');
assert(adapter.includes("await fs.save({id:NATIVE_MANIFEST"),'native persistence path missing');
assert(adapter.includes('async function load({legacyItems=[]}={}'), 'legacy migration load contract missing');
assert(adapter.includes('async function save(items)'), 'storage save contract missing');
assert(adapter.includes('revision'), 'monotonic revision metadata missing');

const storagePos=shell.indexOf('./swir-file-storage.js');
const bridgePos=shell.indexOf('./swir-platform-bridge.js');
assert(storagePos>=0&&bridgePos>storagePos,'storage adapter must load before platform bridge in the dedicated OS shell');
assert(shell.includes('id="os-shell"'),'dedicated OS shell marker missing');
assert(publicIndex.includes('swir-preview.css'),'public showcase must remain separate from the File Explorer runtime shell');
assert(worker.includes("'./swir-file-storage.js'"),'storage adapter missing from offline cache');
assert(worker.includes("'./swir-desktop.html'"),'dedicated OS shell missing from offline cache');
assert(stage.includes("$desktopEntryRelative = 'swir-desktop.html'"),'Desktop staging must use the dedicated OS shell');
assert(stage.includes("'swir-file-storage.js'"),'storage adapter missing from Desktop required runtime');
assert(bridge.includes('window.SwirFileStorage'),'platform bridge is not using storage adapter');
assert(bridge.includes('await storage.load({legacyItems:items})'),'bridge hydration does not use storage adapter');
assert(bridge.includes('await storage.save(items)'),'bridge persistence does not use storage adapter');

console.log('SWIR File Explorer storage adapter contract OK: dedicated OS shell, offline cache and Desktop staging are wired');
