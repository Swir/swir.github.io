import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=fs.readFileSync('swir-notifications.js','utf8');
for(const needle of [
  "window.SWIR_NATIVE_HOST?.notifications",
  "const showRich=notifications?.showRich",
  "if(typeof show!=='function')return null",
  "const nativeDelivery=await deliverNative(item)",
  "if(!nativeDelivery)window.SwirOS?.toast?.(item.title,item.message)",
  "PLATFORM_HISTORY_KEY='notifications.history.v1'",
  "swir:native-notification-action",
  "window.SwirNotifications=Object.freeze"
]){
  assert.ok(source.includes(needle),`Missing native notification bridge invariant: ${needle}`);
}

const storage=new Map([['swir-installed-apps',JSON.stringify(['chat'])]]);
const platformStorage=new Map();
const events=[];
const nativeCalls=[];
const richCalls=[];
const toasts=[];
const opened=[];
const listeners=new Map();
class CustomEvent{constructor(type,init={}){this.type=type;this.detail=init.detail}}
const window={
  SWIR_PACKAGE_CATALOG:[{id:'chat',packageId:'swir.chat',name:'Chat',permissions:['notifications']}],
  SwirPlatform:{
    ready:Promise.resolve(true),
    permissions:{get:async()=>({value:true})},
    storage:{
      get:async(key,fallback=null)=>platformStorage.has(key)?platformStorage.get(key):fallback,
      set:async(key,value)=>{platformStorage.set(key,value);return value},
      remove:async key=>{platformStorage.delete(key);return true}
    }
  },
  SWIR_NATIVE_HOST:{notifications:{show:async(...args)=>{nativeCalls.push(args);return {delivered:true,provider:'test-native'}}}},
  SwirOS:{toast:(...args)=>toasts.push(args),open:id=>opened.push(id)},
  dispatchEvent:event=>{events.push(event);for(const fn of listeners.get(event.type)||[])fn(event)},
  addEventListener:(type,fn)=>{if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push(fn)}
};
const localStorage={
  getItem:key=>storage.get(key)??null,
  setItem:(key,value)=>storage.set(key,value),
  removeItem:key=>storage.delete(key)
};
const context={window,localStorage,CustomEvent,Date,Math,JSON,String,Array,Object,Error,TypeError,Promise,Set,Map};
vm.createContext(context);
vm.runInContext(source,context);

const notifications=window.SwirNotifications;
await notifications.persistence.ready();
assert.equal(notifications.persistence.info().provider,'swir-platform-storage','platform storage must be the preferred portable history adapter');

const result=await notifications.send('chat',{title:'Hello',message:'Desktop',silent:true});
assert.equal(nativeCalls.length,1,'native notification provider must be called exactly once');
assert.deepEqual(nativeCalls[0],['Hello','Desktop','swir.chat',true]);
assert.equal(result.nativeDelivery.delivered,true);
assert.equal(toasts.length,0,'shell toast must not duplicate a delivered native notification');
assert.equal(events.at(-1)?.detail?.nativeDelivery?.provider,'test-native');
assert.equal(platformStorage.get('notifications.history.v1')?.length,1,'notification history must persist through SwirPlatform storage');
assert.equal(JSON.parse(storage.get('swir-app-notifications-v1')).length,1,'legacy mirror must remain available during migration');

window.SWIR_NATIVE_HOST={notifications:{showRich:async payload=>{richCalls.push(payload);return {delivered:true,provider:'test-rich',actionsSupported:true}}}};
const actionable=await notifications.send('chat',{
  title:'Action ready',
  message:'Open or dismiss',
  openApp:'settings',
  actions:[
    {id:'open-chat',label:'Open Chat',kind:'open',target:'settings'},
    {id:'dismiss',label:'Dismiss',kind:'dismiss'},
    {id:'ignored-fourth',label:'Ignored',kind:'open'},
    {id:'never-seen',label:'Never',kind:'open'}
  ]
});
assert.equal(richCalls.length,1,'rich native provider must be preferred when available');
assert.equal(richCalls[0].appId,'swir.chat','rich native payload must use package identity');
assert.equal(richCalls[0].actions.length,3,'action list must be bounded');
assert.equal(actionable.openApp,'chat','untrusted app must not redirect notification activation to another app');
assert.equal(actionable.actions[0].target,'chat','untrusted action target must be owner-bound');
assert.equal(await notifications.activate(actionable.id,'open-chat'),true,'open action must activate');
assert.deepEqual(opened,['chat'],'open action must only open the owner app');
assert.equal(events.some(event=>event.type==='swir:notification-action'&&event.detail?.notificationId===actionable.id),true,'action activation event must be emitted');
assert.equal(await notifications.activate(actionable.id,'dismiss'),true,'dismiss action must activate');
assert.equal(notifications.list().some(item=>item.id===actionable.id),false,'dismiss action must remove notification from history');

window.SWIR_NATIVE_HOST={};
const fallback=await notifications.send('chat',{title:'Fallback',message:'Web'});
assert.equal(fallback.nativeDelivery,null);
assert.equal(toasts.length,1,'web fallback toast must remain available when no native provider exists');

let customValue=[];
let customWrites=0;
const customAdapter={
  id:'contract-memory',
  async read(){return customValue},
  async write(value){customValue=JSON.parse(JSON.stringify(value));customWrites++;return true},
  async clear(){customValue=[];return true}
};
const persistence=await notifications.persistence.use(customAdapter);
assert.equal(persistence.provider,'contract-memory');
assert.equal(persistence.custom,true);
assert.ok(customWrites>=1,'switching to an empty custom adapter must migrate current notification history');
assert.equal(customValue.length,notifications.list().length,'custom adapter must receive the current history snapshot');

await notifications.send('chat',{title:'Custom',message:'Persisted'});
assert.equal(customValue[0].title,'Custom','new history must persist through the configured adapter');
await notifications.clear('chat');
assert.equal(notifications.list('chat').length,0,'per-app clear must clear in-memory history');
assert.equal(customValue.length,0,'per-app clear must persist through the configured adapter');

const nativeActionItem=await notifications.send('chat',{title:'Native action',message:'Event route',actions:[{id:'open',label:'Open',kind:'open'}]});
window.dispatchEvent(new CustomEvent('swir:native-notification-action',{detail:{notificationId:nativeActionItem.id,actionId:'open'}}));
await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(opened.at(-1),'chat','native action events must route through the same owner-bound activation contract');

console.log('SWIR native notification web bridge + action/persistence contract: PASS');
