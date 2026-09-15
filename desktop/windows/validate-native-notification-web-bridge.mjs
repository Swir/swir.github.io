import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const source=fs.readFileSync('swir-notifications.js','utf8');
for(const needle of ["window.SWIR_NATIVE_HOST?.notifications?.show","if(typeof show!=='function')return null","const nativeDelivery=await deliverNative(item)","if(!nativeDelivery)window.SwirOS?.toast?.(item.title,item.message)"]){
  assert.ok(source.includes(needle),`Missing native notification bridge invariant: ${needle}`);
}

const storage=new Map([['swir-installed-apps',JSON.stringify(['chat'])]]);
const events=[];const nativeCalls=[];const toasts=[];
class CustomEvent{constructor(type,init={}){this.type=type;this.detail=init.detail}}
const window={
  SWIR_PACKAGE_CATALOG:[{id:'chat',packageId:'swir.chat',name:'Chat',permissions:['notifications']}],
  SwirPlatform:{permissions:{get:async()=>({value:true})}},
  SWIR_NATIVE_HOST:{notifications:{show:async(...args)=>{nativeCalls.push(args);return {delivered:true,provider:'test-native'}}}},
  SwirOS:{toast:(...args)=>toasts.push(args)},
  dispatchEvent:event=>events.push(event)
};
const context={window,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},CustomEvent,Date,Math,JSON,String,Array,Object,Error};
vm.createContext(context);vm.runInContext(source,context);
const result=await window.SwirNotifications.send('chat',{title:'Hello',message:'Desktop',silent:true});
assert.equal(nativeCalls.length,1,'native notification provider must be called exactly once');
assert.deepEqual(nativeCalls[0],['Hello','Desktop','swir.chat',true]);
assert.equal(result.nativeDelivery.delivered,true);
assert.equal(toasts.length,0,'shell toast must not duplicate a delivered native notification');
assert.equal(events.at(-1)?.detail?.nativeDelivery?.provider,'test-native');

window.SWIR_NATIVE_HOST={};
const fallback=await window.SwirNotifications.send('chat',{title:'Fallback',message:'Web'});
assert.equal(fallback.nativeDelivery,null);
assert.equal(toasts.length,1,'web fallback toast must remain available when no native provider exists');

console.log('SWIR native notification web bridge contract: PASS');
