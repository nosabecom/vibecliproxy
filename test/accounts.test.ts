import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CliProxy } from '../src/cliproxy.ts';
import { Store } from '../src/store.ts';
import { HttpError, type Account } from '../src/types.ts';

function setup(t:any) {
 const store=new Store(':memory:');t.after(()=>store.close());
 const proxy=new CliProxy({url:'http://127.0.0.1:9',apiKey:'test',managementKey:'test'},store);
 const account:Account={id:'personal',name:'personal.json',ownerMemberId:'sam',email:'sam@test.invalid',provider:'codex',prefix:'vcp-test',enabled:true,available:true,checkedAt:Date.now(),models:['model'],windows:[{id:'weekly',label:'Weekly',usedPercent:5,resetsAt:Date.now()+86400000}]};
 store.setOwner(account.id,'sam');proxy.accounts=[account];
 return {store,proxy,account};
}

test('a failed provider deletion restores the account and keeps its ownership',async t=>{
 const {store,proxy,account}=setup(t);
 proxy.management=async()=>{throw new HttpError(503,'Provider unavailable');};
 await assert.rejects(proxy.removeAccount(account.id,()=>{}),/Provider unavailable/);
 assert.equal(proxy.accounts.length,1);assert.equal(proxy.accounts[0]!.ownerMemberId,'sam');
 assert.equal(store.owner(account.id),'sam');
});

test('inventory refreshes cannot resurrect an account during or after removal',async t=>{
 const {proxy,account}=setup(t);
 let deleting!:()=>void,finish!:()=>void;
 const started=new Promise<void>(resolve=>{deleting=resolve;}),pending=new Promise<void>(resolve=>{finish=resolve;});
 proxy.management=async(path,body,method)=>{
  if(method==='DELETE'){deleting();await pending;return {status:'ok'};}
  assert.equal(path,'auth-files');
  return {files:[{id:account.id,name:account.name,provider:'codex',auth_index:'test'}]};
 };
 const removal=proxy.removeAccount(account.id,()=>{});await started;
 assert.equal(proxy.accounts.length,0);
 await proxy.sync();assert.equal(proxy.accounts.length,0);
 finish();await removal;
 await proxy.sync();assert.equal(proxy.accounts.length,0);
});

test('ownership is checked again after an inventory refresh finishes',async t=>{
 const {store,proxy,account}=setup(t);
 let finish!:()=>void,reading!:()=>void;
 const entered=new Promise<void>(resolve=>{reading=resolve;}),pending=new Promise<void>(resolve=>{finish=resolve;});
 const mutations:string[]=[];
 proxy.management=async(path,body,method)=>{
  if(path==='auth-files'){reading();await pending;return {files:[{id:account.id,name:account.name,provider:'codex',auth_index:'test',disabled:true}]};}
  mutations.push(method??'GET');return {status:'ok'};
 };
 const refresh=proxy.sync();await entered;
 const removal=proxy.removeAccount(account.id,current=>{if(current.ownerMemberId!=='sam')throw new HttpError(404,'Account not found');});
 store.setOwner(account.id,'someone-else');finish();await refresh;
 await assert.rejects(removal,/Account not found/);
 assert.equal(proxy.accounts.length,1);assert.deepEqual(mutations,[]);
});
