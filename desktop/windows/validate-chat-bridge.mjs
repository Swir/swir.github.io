import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'../..');
const chat=fs.readFileSync(path.join(root,'swir-chat.html'),'utf8');
const api=fs.readFileSync(path.join(root,'swir-chat-api.php'),'utf8');
const host=fs.readFileSync(path.join(root,'swir-app-bridge-host.js'),'utf8');
const client=fs.readFileSync(path.join(root,'swir-app-bridge.js'),'utf8');
const failures=[];
function requireText(source,text,label){if(!source.includes(text))failures.push(label)}
requireText(chat,'data-swir-package="swir.chat"','Chat package identity missing');
requireText(chat,'bridge.network.request','Chat does not use App Bridge network transport');
requireText(chat,'bridge.storage','Chat does not use App Bridge storage');
if(/\bfetch\s*\(/.test(chat))failures.push('Chat still contains direct fetch()');
requireText(api,"SWIR_CHAT_WEB_ORIGIN = 'https://swir.github.io'",'Chat API Web origin missing');
requireText(api,"SWIR_CHAT_DESKTOP_ORIGIN = 'https://swir.local'",'Chat API Desktop origin missing');
requireText(api,'configured_origins','Chat API compatibility origin resolver missing');
requireText(host,"case 'network.request'",'Host network.request dispatch missing');
requireText(host,'NETWORK_PRIVATE_TARGET_BLOCKED','Private-network protection missing');
requireText(host,"url.protocol !== 'https:'",'HTTPS-only network rule missing');
requireText(client,"request: options => call('network.request'",'Package network API missing');
if(failures.length){console.error('Chat/App Bridge validation failed:');for(const f of failures)console.error(' - '+f);process.exit(1)}
console.log('SWIR Chat portable storage/network bridge contract validated.');
