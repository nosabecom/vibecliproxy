import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eligibility, parseQuota, routePool, personalSwitchReached } from '../src/quota.ts';
import type { Account, Member } from '../src/types.ts';
const now = Date.now();
const member: Member = { id:'friend',name:'Friend',keyHash:'',keyHint:'',sharePercent:20,paused:false,allowedModels:[],accountIds:[],expiresAt:null,rpm:20,createdAt:now,fallbackOnly:false };
function account(used=10): Account { return {id:'a',ownerMemberId:null,name:'a',email:'a@test.invalid',provider:'codex',prefix:'vcp-a',enabled:true,available:true,models:['test-model'],checkedAt:now,windows:[{id:'five-hour',label:'5 hour',usedPercent:used,resetsAt:now+3600000},{id:'weekly',label:'Weekly',usedPercent:12,resetsAt:now+86400000}]}; }
test('20% protects reserve in every window, with a configurable early-stop margin',()=>{
 assert.equal(eligibility(account(17),member,2,now).allowed,true);
 assert.equal(eligibility(account(18),member,2,now).allowed,false);
 assert.equal(eligibility(account(20),member,0,now).allowed,false);
 const a=account();a.windows[1]!.usedPercent=25;assert.equal(eligibility(a,member,0,now).allowed,false);
});
test('missing, stale, failed and expired quota readings never grant shared access',()=>{
 for(const change of [{windows:[]},{checkedAt:now-120001},{error:'Quota unavailable'},{available:false},{enabled:false}])assert.equal(eligibility({...account(),...change},member,0,now).allowed,false);
 const a=account();a.windows[0]!.resetsAt=now;assert.equal(eligibility(a,member,0,now).allowed,false);
});
test('account allowlist applies before routing',()=>{
 assert.equal(eligibility(account(),{...member,accountIds:['b']},0,now).allowed,false);
});
test('Codex classifies a lone weekly primary window by duration',()=>{
 const w=parseQuota('codex',{rate_limit:{primary_window:{used_percent:15,reset_at:(now+3600000)/1000,limit_window_seconds:604800},secondary_window:null}});
 assert.equal(w[0]!.label,'Weekly');assert.equal(w[0]!.usedPercent,15);
});
test('Claude includes scoped constraints and rejects unusable readings',()=>{
 const w=parseQuota('claude',{five_hour:{utilization:8,resets_at:new Date(now+3600000).toISOString()},seven_day_sonnet:{utilization:50,resets_at:new Date(now+86400000).toISOString()}});
 assert.equal(w.length,2);assert.equal(w[1]!.usedPercent,50);
 for(const data of [{},{five_hour:{utilization:20,resets_at:null}},{five_hour:{utilization:-1,resets_at:new Date().toISOString()}}])assert.throws(()=>parseQuota('claude',data));
 assert.throws(()=>parseQuota('codex',{rate_limit:{primary_window:{used_percent:NaN,reset_at:now/1000}}}));
});

test('personal account is preferred even above the owner sharing ceiling; fallback requires confirmed exhaustion', async()=>{
 const {routePool}=await import('../src/quota.ts');
 const m={...member,fallbackOnly:true};const personal={...account(75),id:'personal',ownerMemberId:member.id};personal.windows[1]!.usedPercent=90;
 const shared={...account(5),id:'shared',ownerMemberId:null};
 let pool=routePool([personal,shared],m,'test-model',2,now);assert.equal(pool.shared,false);assert.equal(pool.accounts[0]!.id,'personal');
 personal.windows[0]!.usedPercent=100;pool=routePool([personal,shared],m,'test-model',2,now);assert.equal(pool.shared,true);assert.equal(pool.accounts[0]!.id,'shared');
 personal.error='quota unavailable';assert.equal(routePool([personal,shared],m,'test-model',2,now).accounts.length,0);
 personal.error=undefined;personal.checkedAt=now-130000;assert.equal(routePool([personal,shared],m,'test-model',2,now).accounts.length,0);
 assert.equal(routePool([shared],m,'test-model',2,now).accounts.length,0);
});
test('unavailable or disabled personal accounts do not trigger backup; another person’s account is never shared',async()=>{
 const {routePool}=await import('../src/quota.ts');const m={...member,fallbackOnly:true};
 const personal={...account(20),id:'personal',ownerMemberId:member.id,available:false};
 const other={...account(1),id:'other',ownerMemberId:'someone-else'};
 assert.equal(routePool([personal,other,account()],m,'test-model',2,now).accounts.length,0);
 assert.equal(routePool([other],{...m,fallbackOnly:false},'test-model',2,now).accounts.length,0);
});

test('personal switchover uses the exact configured percentage in any window and returns after reset',()=>{
 for (const threshold of [1,20,30,40,50,37.5,100]) {
  const m={...member,fallbackOnly:true,personalSwitchPercent:threshold};
  const personal={...account(threshold-0.1),id:'personal',ownerMemberId:m.id};
  personal.windows[1]!.usedPercent=0;
  const shared=account(0);shared.windows[1]!.usedPercent=0;
  assert.equal(routePool([personal,shared],m,'test-model',2,now).shared,false);
  personal.windows[1]!.usedPercent=threshold;
  assert.equal(personalSwitchReached(personal,m,now),true);
  const pool=routePool([personal,shared],m,'test-model',2,now);
  assert.equal(pool.shared,true);assert.deepEqual(pool.accounts,[shared]);
  personal.windows[1]!.usedPercent=0;
  assert.equal(routePool([personal,shared],m,'test-model',2,now).shared,false);
 }
});

test('custom switchover requires every model-compatible personal account to have fresh confirmed usage',()=>{
 const m={...member,fallbackOnly:true,personalSwitchPercent:40};
 const first={...account(40),id:'first',ownerMemberId:m.id};
 const second={...account(39),id:'second',ownerMemberId:m.id};
 const shared=account(0);
 const pool=routePool([first,second,shared],m,'test-model',2,now);
 assert.equal(pool.shared,false);assert.deepEqual(pool.accounts,[second]);
 second.windows[0]!.usedPercent=40;
 assert.equal(routePool([first,second,shared],m,'test-model',2,now).shared,true);
 for(const change of [{windows:[]},{checkedAt:now-120001},{error:'Failed'},{enabled:false},{windows:[{...second.windows[0]!,resetsAt:now}]}]) {
  assert.equal(routePool([first,{...second,...change},shared],m,'test-model',2,now).accounts.length,0);
 }
 assert.equal(routePool([first,{...second,available:false},shared],m,'test-model',2,now).shared,true);
 assert.equal(routePool([first,{...second,windows:[],models:['other-model']},shared],m,'test-model',2,now).shared,true);
 assert.equal(routePool([shared],m,'test-model',2,now).accounts.length,0);
 shared.windows[0]!.usedPercent=18;
 assert.equal(routePool([first,second,shared],m,'test-model',2,now).accounts.length,0);
 assert.equal(routePool([first],{...m,fallbackOnly:false},'test-model',2,now).accounts.length,0);
});

test('hourly, weekly, and both select the requested windows; full exhaustion still requires backup',()=>{
 const personal={...account(45),id:'personal',ownerMemberId:member.id};
 const m={...member,fallbackOnly:true,personalSwitchPercent:40};
 for (const [hourly,weekly,expected] of [[45,12,[true,false,true]],[12,45,[false,true,true]],[40,40,[true,true,true]],[39,39,[false,false,false]]] as const) {
  personal.windows[0]!.usedPercent=hourly;personal.windows[1]!.usedPercent=weekly;
  for(const [index,mode] of (['hourly','weekly','both'] as const).entries()) {
   const configured={...m,personalSwitchWindow:mode};
   assert.equal(personalSwitchReached(personal,configured,now),expected[index]);
   assert.equal(routePool([personal,account(0)],configured,'test-model',2,now).shared,expected[index]);
  }
 }
 personal.windows[0]!.usedPercent=100;personal.windows[1]!.usedPercent=0;
 assert.equal(personalSwitchReached(personal,{...m,personalSwitchWindow:'weekly'},now),true);
 personal.windows[0]!.usedPercent=0;personal.windows[1]!.usedPercent=100;
 assert.equal(personalSwitchReached(personal,{...m,personalSwitchWindow:'hourly'},now),true);
 personal.checkedAt=now-120001;
 assert.equal(personalSwitchReached(personal,{...m,personalSwitchWindow:'hourly'},now),false);
});

test('window selection classifies Codex by duration, including a weekly primary and scoped limits',()=>{
 const reset_at=(now+3600000)/1000;
 const windows=parseQuota('codex',{rate_limit:{primary_window:{used_percent:45,reset_at,limit_window_seconds:604800}},
  additional_rate_limits:[{limit_name:'Scoped',rate_limit:{primary_window:{used_percent:10,reset_at,limit_window_seconds:18000}}}]});
 assert.equal(windows[0]!.period,'weekly');assert.equal(windows[1]!.period,'hourly');
 const personal={...account(),windows};
 const m={...member,personalSwitchPercent:40};
 assert.equal(personalSwitchReached(personal,{...m,personalSwitchWindow:'weekly'},now),true);
 assert.equal(personalSwitchReached(personal,{...m,personalSwitchWindow:'hourly'},now),false);
 windows[1]!.usedPercent=45;windows[0]!.usedPercent=10;
 assert.equal(personalSwitchReached(personal,{...m,personalSwitchWindow:'hourly'},now),true);
});

test('Claude scoped weekly limits and unknown or missing windows respect the selected period',()=>{
 const resets_at=new Date(now+3600000).toISOString();
 const windows=parseQuota('claude',{five_hour:{utilization:10,resets_at},seven_day_sonnet:{utilization:20,resets_at},
  limits:[{kind:'weekly_scoped',percent:50,resets_at,scope:{model:{display_name:'Opus'}}}]});
 const m={...member,personalSwitchPercent:40};
 const personal={...account(),windows};
 assert.equal(personalSwitchReached(personal,{...m,personalSwitchWindow:'weekly'},now),true);
 assert.equal(personalSwitchReached(personal,{...m,personalSwitchWindow:'hourly'},now),false);
 personal.windows=[{id:'unknown',label:'Additional limit',usedPercent:90,resetsAt:now+3600000}];
 assert.equal(personalSwitchReached(personal,{...m,personalSwitchWindow:'both'},now),true);
 assert.equal(personalSwitchReached(personal,{...m,personalSwitchWindow:'weekly'},now),false);
 personal.windows=[];
 assert.equal(personalSwitchReached(personal,{...m,personalSwitchWindow:'both'},now),false);
});

test('pausing sharing uses personal quota beyond the switch threshold and never admits backup',()=>{
 const m={...member,fallbackOnly:true,personalSwitchPercent:20,personalSwitchWindow:'weekly' as const};
 const personal={...account(75),id:'personal',ownerMemberId:m.id};personal.windows[1]!.usedPercent=80;
 const shared=account(0);
 assert.equal(routePool([personal,shared],m,'test-model',2,now).shared,true);
 const paused=routePool([personal,shared],m,'test-model',2,now,true);
 assert.equal(paused.shared,false);assert.deepEqual(paused.accounts,[personal]);
 for(const change of [{checkedAt:now-120001},{available:false},{enabled:false},{error:'Quota unavailable'},{windows:[]}]) {
  assert.deepEqual(routePool([{...personal,...change},shared],m,'test-model',2,now,true).accounts,[]);
 }
 personal.windows[0]!.usedPercent=100;
 assert.deepEqual(routePool([personal,shared],m,'test-model',2,now,true).accounts,[]);
 assert.deepEqual(routePool([shared],{...m,fallbackOnly:false},'test-model',2,now,true).accounts,[]);
});

test('Use mine bypasses switchover but never borrows shared or another member’s quota',()=>{
 const m={...member,personalOnly:true,personalSwitchPercent:40};
 const personal={...account(82),id:'personal',ownerMemberId:m.id};
 const shared=account(77), availableBackup=account(0);
 const other={...account(0),id:'other',ownerMemberId:'someone-else'};
 for(const fallbackOnly of [true,false])for(const paused of [true,false]) {
  const configured={...m,fallbackOnly};
  assert.deepEqual(routePool([personal,shared,other],configured,'test-model',2,now,paused).accounts,[personal]);
  for(const change of [{checkedAt:now-120001},{available:false},{enabled:false},{error:'Failed'},{windows:[]},
   {models:['other-model']},{windows:[{...personal.windows[0]!,resetsAt:now}]},
   {windows:[{...personal.windows[0]!,usedPercent:100}]}]) {
   const pool=routePool([{...personal,...change},availableBackup,other],configured,'test-model',2,now,paused);
   assert.deepEqual(pool.accounts,[]);assert.equal(pool.shared,false);
  }
  assert.deepEqual(routePool([availableBackup,other],configured,'test-model',2,now,paused).accounts,[]);
 }
 assert.deepEqual(routePool([personal,availableBackup],{...m,personalOnly:false},'test-model',2,now).accounts,[availableBackup]);
 personal.windows[0]!.usedPercent=0;
 assert.deepEqual(routePool([personal,availableBackup],m,'test-model',2,now).accounts,[personal]);
});
