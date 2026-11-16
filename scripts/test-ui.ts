import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, existsSync } from 'node:fs';
import { createHub } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { CliProxy } from '../src/cliproxy.ts';
import { hashPassword } from '../src/auth.ts';
import type { LoginFactory } from '../src/onboarding.ts';
const adminPassword='ui test admin passphrase';
const adminPasswordHash=await hashPassword(adminPassword);
const store = new Store(':memory:');
const proxy = new CliProxy({url:'http://127.0.0.1:9',apiKey:'test',managementKey:'test'},store);
proxy.lastSync = Date.now();
const config={host:'127.0.0.1',port:0,dataPath:':memory:',publicOrigin:'http://localhost',basePath:'/cliproxy',adminPasswordHash,proxyUrl:'http://127.0.0.1:9',proxyKey:'test',managementKey:'test'};
const connected: any[] = [];
proxy.management = async (path, body?: any, method?: string) => {
 if(path.startsWith('auth-files?name=')&&method==='DELETE'){const name=decodeURIComponent(path.split('=')[1]!);const index=connected.findIndex(a=>a.name===name);if(index>=0)connected.splice(index,1);return {status:'ok'};}
 if(path.startsWith('auth-files?name=')) {const name=decodeURIComponent(path.split('=')[1]!);connected.push({id:name,name,provider:body.type});return {status:'ok'};}
 if(path==='auth-files')return {files:connected};
 if(path==='auth-files/status'){
  proxy.accounts.push({id:body.name,name:body.name,email:'self-service@test.invalid',provider:'codex',prefix:'vcp-self',ownerMemberId:store.owner(body.name),enabled:true,available:true,checkedAt:Date.now(),models:['test-model'],windows:[{id:'primary_window',label:'5 hour',usedPercent:7,resetsAt:Date.now()+3600000}]});
  return {status:'ok'};
 }
 throw new Error('Unexpected test management request');
};
proxy.sync=async()=>{};
const loginFactory: LoginFactory = async()=>{
 let complete=false;
 return {management:async(path,body?:any)=>{
  if(path==='codex-auth-url')return {url:'https://auth.openai.com/oauth/authorize?state=ui-native-state&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',state:'ui-native-state'};
  if(path==='oauth-callback'){assert.equal(body.provider,'codex');complete=true;return {status:'ok'};}
  if(path.startsWith('get-auth-status'))return {status:complete?'ok':'wait'};
  if(path==='auth-files')return {files:[{name:'login.json',provider:'codex'}]};
  if(path.startsWith('auth-files/download'))return {type:'codex',access_token:'ui-test-token',email:'self-service@test.invalid'};
  throw new Error('Unexpected test login request');
 },dispose:async()=>{}};
};
const hub=createHub(config,{store,proxy,loginFactory});
hub.server.listen(0,'127.0.0.1');await once(hub.server,'listening');
const url=`http://127.0.0.1:${(hub.server.address() as any).port}`;
config.publicOrigin=url;
const mountedUrl=`${url}/cliproxy`;
const cached='/home/nosa/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell';
const browser=await chromium.launch({...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:existsSync(cached)?{executablePath:cached}:{}),headless:true});
const errors:string[]=[];mkdirSync('.data/screenshots',{recursive:true});
try{
 const context=await browser.newContext({extraHTTPHeaders:{'Tailscale-User-Login':'owner@test.invalid'},viewport:{width:1440,height:1050},colorScheme:'light'});
 const page=await context.newPage();page.on('pageerror',e=>{errors.push(e.message);console.log('Browser error:',e.message)});page.on('response',async r=>{if(r.status()>=400) console.log('HTTP error',r.status(),new URL(r.url()).pathname,await r.text())});
 await page.goto(mountedUrl);await page.getByRole('heading',{name:'Admin sign-in',exact:true}).waitFor();await page.screenshot({path:'.data/screenshots/sign-in.png',fullPage:true});
 // Follow the system until a user chooses a theme; survive blocked storage.
 const systemContext=await browser.newContext({colorScheme:'dark'}),systemPage=await systemContext.newPage();
 await systemPage.goto(mountedUrl);await systemPage.getByRole('heading',{name:'Admin sign-in',exact:true}).waitFor();
 assert.equal(await systemPage.locator('html').getAttribute('data-theme'),'dark');
 await systemPage.emulateMedia({colorScheme:'light'});await systemPage.waitForFunction(()=>document.documentElement.dataset.theme==='light');
 await systemPage.getByRole('button',{name:'Switch to dark mode',exact:true}).click();
 await systemPage.emulateMedia({colorScheme:'dark'});await systemPage.emulateMedia({colorScheme:'light'});
 await systemPage.reload();assert.equal(await systemPage.locator('html').getAttribute('data-theme'),'dark');
 await systemContext.close();
 const restricted=await browser.newContext({colorScheme:'light'});
 await restricted.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError');}}));
 const restrictedPage=await restricted.newPage();await restrictedPage.goto(mountedUrl);
 await restrictedPage.getByRole('button',{name:'Switch to dark mode',exact:true}).click();
 assert.equal(await restrictedPage.locator('html').getAttribute('data-theme'),'dark');await restricted.close();
 await page.getByRole('button',{name:'Switch to dark mode',exact:true}).click();
 await page.reload();assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
 assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'),'#141a17');
 await page.getByRole('button',{name:'Switch to light mode',exact:true}).click();
 await page.getByLabel('Password',{exact:true}).fill(adminPassword);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
 await page.screenshot({path:'.data/screenshots/admin-empty.png',fullPage:true});
 await page.getByRole('button',{name:'Add a person',exact:true}).first().click();
 await page.getByLabel('Name',{exact:true}).fill('Friend');await page.getByLabel('Protected reserve (%)').fill('80');
 assert.equal(await page.getByLabel('Switch to backup with personal quota left (%)',{exact:true}).inputValue(),'0');
 assert.equal(await page.getByLabel('Switchover quota window',{exact:true}).inputValue(),'both');
 await page.getByLabel('Switchover quota window',{exact:true}).selectOption('weekly');
 await page.getByLabel('Switch to backup with personal quota left (%)',{exact:true}).fill('70');
 await page.getByRole('button',{name:'Create access'}).click();await page.locator('.key-display').waitFor({timeout:5000}).catch(async e=>{console.log('Toast:',await page.locator('#toast').textContent());console.log('Dialogs:',await page.locator('dialog').count(),'Forms:',await page.locator('form').count());await page.screenshot({path:'.data/screenshots/ui-failure.png',fullPage:true});throw e;});
 const key=(await page.locator('.key-display').textContent())!.trim();assert.ok(key.startsWith('vcp_'));
 await page.getByRole('button',{name:'Done',exact:true}).click();
 await page.locator('nav [data-page=people]').click();await page.getByRole('button',{name:'Manage',exact:true}).click();
 assert.equal(await page.getByLabel('Protected reserve (%)',{exact:true}).inputValue(),'80');
 assert.equal(await page.getByRole('checkbox',{name:'Require personal accounts to reach the switchover threshold before backup'}).isChecked(),true);
 assert.equal(await page.getByLabel('Switch to backup with personal quota left (%)',{exact:true}).inputValue(),'70');
 assert.equal(await page.getByLabel('Switchover quota window',{exact:true}).inputValue(),'weekly');
 await page.getByLabel('Switchover quota window',{exact:true}).selectOption('hourly');
 await page.getByLabel('Switch to backup with personal quota left (%)',{exact:true}).fill('60');
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 await page.getByRole('button',{name:'Save changes'}).click();
 const member=store.members()[0]!;assert.equal(member.sharePercent,20);assert.equal(member.personalSwitchPercent,40);assert.equal(member.personalSwitchWindow,'hourly');
 await page.setViewportSize({width:1440,height:1050});
 await page.getByRole('button',{name:'Manage',exact:true}).click();
 assert.equal(await page.getByLabel('Switch to backup with personal quota left (%)',{exact:true}).inputValue(),'60');
 assert.equal(await page.getByLabel('Switchover quota window',{exact:true}).inputValue(),'hourly');
 await page.getByLabel('Protected reserve (%)',{exact:true}).fill('70');
 await page.getByLabel('Switch to backup with personal quota left (%)',{exact:true}).fill('83.3');
 await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.getByText('Sharing controls saved',{exact:true}).waitFor();
 assert.equal(store.member(member.id).sharePercent,30);assert.equal(store.member(member.id).personalSwitchPercent,16.7);
 await page.getByRole('button',{name:'Manage',exact:true}).click();
 assert.equal(await page.getByLabel('Protected reserve (%)',{exact:true}).inputValue(),'70');
 assert.equal(await page.getByLabel('Switch to backup with personal quota left (%)',{exact:true}).inputValue(),'83.3');
 await page.getByLabel('Switch to backup with personal quota left (%)',{exact:true}).fill('60');
 await page.getByLabel('Protected reserve (%)',{exact:true}).fill('80');
 await page.screenshot({path:'.data/screenshots/access-controls.png',fullPage:true});
 await page.getByRole('button',{name:'Save changes',exact:true}).click();
 await page.getByText('Sharing controls saved',{exact:true}).waitFor();
 assert.equal(store.member(member.id).sharePercent,20);
 store.setSettings({...store.settings(),promptPreviews:true});
 store.event(member,'test-model','owner-auth',499,120,'client_disconnected',{
  method:'POST',path:'/v1/responses',state:'finished',startedAt:Date.now()-120,finishedAt:Date.now(),
  requestBytes:2048,responseBytes:128,queueMs:30,firstByteMs:60,provider:'codex',route:'shared',accountLabel:'owner-private@test.invalid',
  promptPreview:'Build an application tracker. <script>window.previewXss=true</script>',errorMessage:'Client disconnected',errorPhase:'running',
 });
 proxy.accounts=[{id:'owner-auth',name:'owner.json',email:'owner-private@test.invalid',provider:'codex',prefix:'vcp-owner',ownerMemberId:null,enabled:true,available:true,checkedAt:Date.now(),windows:[{id:'primary',label:'5 hour',usedPercent:9,resetsAt:Date.now()+7200000},{id:'weekly',label:'Weekly',usedPercent:12,resetsAt:Date.now()+86400000}],models:['test-model']},{id:'friend-auth',name:'friend.json',email:'friend@test.invalid',provider:'codex',prefix:'vcp-friend',ownerMemberId:null,enabled:true,available:true,checkedAt:Date.now(),windows:[{id:'primary',label:'5 hour',usedPercent:73,resetsAt:Date.now()+7200000},{id:'weekly',label:'Weekly',usedPercent:7,resetsAt:Date.now()+86400000}],models:['test-model']}];
 await page.reload();await page.getByRole('button',{name:'Accounts',exact:true}).click();
 // Remaining quota must agree in text and bar width, including limits and decimals.
 const ownerAccount=proxy.accounts[0]!;
 const ownerQuota=page.locator('[data-account-card="owner-auth"] [data-quota-window="primary"]');
 for(const [used,remaining] of [[0,100],[50,50],[100,0],[105,0],[-5,100],[73.5,26.5]]){
  ownerAccount.windows[0]!.usedPercent=used!;
  await page.reload();
  await ownerQuota.getByRole('img',{name:`5 hour: ${remaining}% quota remaining`,exact:true}).waitFor();
  assert.equal((await ownerQuota.locator('strong').textContent())?.trim(),`${remaining}% left`);
  assert.equal(await ownerQuota.locator('.quota-track > div').evaluate(el=>(el as HTMLElement).style.width),`${remaining}%`);
 }
 ownerAccount.windows[0]!.usedPercent=9;
 for(const invalid of ['stale','error','reset','missing']){
  const checkedAt=ownerAccount.checkedAt,windows=ownerAccount.windows,error=ownerAccount.error;
  if(invalid==='stale')ownerAccount.checkedAt=Date.now()-130000;
  if(invalid==='error')ownerAccount.error='Provider unavailable';
  if(invalid==='reset')ownerAccount.windows=windows.map(w=>({...w,resetsAt:Date.now()-1}));
  if(invalid==='missing')ownerAccount.windows=[];
  await page.reload();
  if(invalid==='missing')await page.getByText('Waiting for the provider’s first quota reading.',{exact:true}).waitFor();
  else {
   await ownerQuota.getByRole('img',{name:'5 hour: quota unavailable',exact:true}).waitFor();
   assert.equal(await ownerQuota.locator('.quota-track > div').evaluate(el=>(el as HTMLElement).style.width),'0%');
   assert.equal(await ownerQuota.locator('strong').textContent(),'Unavailable');
  }
  await page.getByRole('button',{name:'Overview',exact:true}).click();
  await page.locator('.capacity-row').filter({hasText:ownerAccount.email}).getByText('Quota unavailable',{exact:true}).waitFor();
  ownerAccount.checkedAt=checkedAt;ownerAccount.windows=windows;ownerAccount.error=error;
  await page.getByRole('button',{name:'Accounts',exact:true}).click();
 }
 await page.reload();
 await page.getByRole('button',{name:'Overview',exact:true}).click();
 await page.locator('.capacity-row').filter({hasText:ownerAccount.email}).getByText('88%',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Accounts',exact:true}).click();
 await page.locator('.skip-link').focus();await page.keyboard.press('Enter');
 assert.equal(new URL(page.url()).hash,'#accounts');assert.equal(await page.evaluate(()=>document.activeElement?.id),'main-content');
 await page.locator('[data-owner="friend-auth"]').selectOption(member.id);
 await page.getByRole('button',{name:'Activity',exact:true}).click();
 await page.locator('#activity-rows').getByText('Cancelled',{exact:true}).waitFor();
 await page.getByLabel('Search requests',{exact:true}).fill('application tracker');
 await page.getByRole('button',{name:'Details',exact:true}).click();
 await page.getByRole('heading',{name:'Request details',exact:true}).waitFor();
 await page.locator('dialog').getByText('POST /v1/responses',{exact:true}).waitFor();
 await page.locator('dialog').getByText('Build an application tracker.',{exact:false}).waitFor();
 assert.equal(await page.evaluate(()=>window.previewXss),undefined);
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 await page.getByLabel('Search requests',{exact:true}).fill('no-match-request');
 await page.getByText('No matching requests',{exact:true}).waitFor();
 await page.getByLabel('Search requests',{exact:true}).fill('');
 await page.getByLabel('Filter requests by result',{exact:true}).selectOption('cancelled');
 await page.locator('#activity-rows').getByText('Cancelled',{exact:true}).waitFor();

 // Filters combine, retain selections on refresh, and tolerate older metadata.
 const filterDetails={method:'POST',path:'/v1/responses',state:'finished' as const,startedAt:Date.now(),requestBytes:10,responseBytes:20,queueMs:0,provider:'codex' as const,route:'shared' as const};
 const otherPerson={...member,id:'filter-other-person',name:'Other person'};
 store.event(otherPerson,'claude-test','removed-auth',200,100,null,{...filterDetails,path:'/v1/messages',provider:'claude',route:'personal',accountLabel:'old-claude@test.invalid',promptPreview:'Filter combination target'},'filter-completed');
 store.event(member,'test-model',null,102,0,null,{...filterDetails,state:'queued'},'filter-queued');
 store.event(member,'test-model','friend-auth',102,0,null,{...filterDetails,state:'running',route:'personal',accountLabel:'friend@test.invalid'},'filter-running');
 store.event(member,'',null,102,0,null,{method:'POST',path:'/v1/responses',state:'receiving',startedAt:Date.now(),requestBytes:0,responseBytes:0,queueMs:0},'filter-receiving');
 store.event(otherPerson,'test-model',null,429,10,'reserve_protected',filterDetails,'filter-limited');
 store.event(otherPerson,'legacy-model',null,200,100,null,undefined,'filter-legacy');
 store.db.prepare('UPDATE events SET at=? WHERE id=?').run(Date.now()-2*86400000,'filter-limited');
 store.db.prepare('UPDATE events SET at=? WHERE id=?').run(Date.now()-8*86400000,'filter-legacy');
 await page.getByRole('button',{name:'Clear filters',exact:true}).click();
 await page.getByRole('button',{name:'Refresh hub',exact:true}).click();
 await page.locator('#activity-count').getByText('7 requests',{exact:true}).waitFor();
 const originalId=store.history().find(event=>event.status===499)!.id;
 const allIds=store.history().map(event=>event.id).sort();
 const visibleIds=async()=> {await page.locator('#activity-results[aria-busy="false"]').waitFor();return (await page.locator('#activity-rows [data-action="request-details"]').evaluateAll(buttons=>buttons.map(button=>(button as HTMLElement).dataset.id))).sort();};
 for(const [label,value,expected] of [
  ['person',otherPerson.id,['filter-completed','filter-limited','filter-legacy']],
  ['account','owner-auth',[originalId]],
  ['account','friend-auth',['filter-running']],
  ['account','removed-auth',['filter-completed']],
  ['model','claude-test',['filter-completed']],
  ['provider','claude',['filter-completed']],
  ['provider','codex',[originalId,'filter-queued','filter-running','filter-limited']],
  ['route','personal',['filter-completed','filter-running']],
  ['route','shared',[originalId,'filter-queued','filter-limited']],
  ['endpoint','/v1/messages',['filter-completed']],
  ['time range','900000',[originalId,'filter-completed','filter-queued','filter-running','filter-receiving']],
  ['time range','3600000',[originalId,'filter-completed','filter-queued','filter-running','filter-receiving']],
  ['time range','86400000',[originalId,'filter-completed','filter-queued','filter-running','filter-receiving']],
  ['time range','604800000',[originalId,'filter-completed','filter-queued','filter-running','filter-receiving','filter-limited']],
  ['result','receiving',['filter-receiving']],
  ['result','queued',['filter-queued']],
  ['result','running',['filter-running']],
  ['result','limited',['filter-limited']],
  ['result','active',['filter-receiving','filter-queued','filter-running']],
  ['model','legacy-model',['filter-legacy']],
 ] as const){
  await page.getByLabel(`Filter requests by ${label}`,{exact:true}).selectOption(value);
  assert.deepEqual(await visibleIds(),[...expected].sort(),`${label}: ${value}`);
  assert.equal(await page.locator('#activity-count').textContent(),`${expected.length} requests`);
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();
  assert.deepEqual(await visibleIds(),allIds);
 }
 await page.getByLabel('Search requests',{exact:true}).fill('combination target');
 for(const [label,value] of [['person',otherPerson.id],['account','removed-auth'],['result','completed'],['model','claude-test'],['provider','claude'],['route','personal'],['endpoint','/v1/messages'],['time range','86400000']]){
  await page.getByLabel(`Filter requests by ${label}`,{exact:true}).selectOption(value!);
 }
 assert.deepEqual(await visibleIds(),['filter-completed']);
 await page.getByRole('button',{name:'Refresh hub',exact:true}).click();
 await page.getByText('Hub refreshed. Provider quota pacing still applies.',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('Filter requests by provider',{exact:true}).inputValue(),'claude');
 assert.deepEqual(await visibleIds(),['filter-completed']);
 await page.getByRole('button',{name:'Overview',exact:true}).click();
 await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
 await page.getByRole('button',{name:'Activity',exact:true}).click();
 await page.getByRole('heading',{name:'Activity',exact:true}).waitFor();
 assert.deepEqual(await visibleIds(),['filter-completed']);
 await page.getByLabel('Filter requests by route',{exact:true}).selectOption('shared');
 await page.getByText('No matching requests',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Clear filters',exact:true}).click();
 assert.equal(await page.getByLabel('Search requests',{exact:true}).inputValue(),'');
 assert.equal(await page.getByRole('button',{name:'Clear filters',exact:true}).isDisabled(),true);
 assert.deepEqual(await visibleIds(),allIds);
 await page.getByLabel('Filter requests by model',{exact:true}).selectOption('legacy-model');
 store.db.prepare('DELETE FROM events WHERE id=?').run('filter-legacy');
 await page.getByRole('button',{name:'Refresh hub',exact:true}).click();
 await page.getByText('No matching requests',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('Filter requests by model',{exact:true}).inputValue(),'legacy-model');
 await page.getByRole('button',{name:'Clear filters',exact:true}).click();
 await visibleIds();
 // Older shared requests remain reachable beyond the newest 100, including Details.
 for(let index=0;index<105;index++)store.event(otherPerson,'paging-model','owner-auth',200,100,null,{...filterDetails,route:'personal'},`paging-${String(index).padStart(3,'0')}`);
 await page.getByRole('button',{name:'Refresh hub',exact:true}).click();
 await page.locator('#activity-count').getByText('111 requests',{exact:true}).waitFor();
 await page.getByLabel('Filter requests by time range',{exact:true}).selectOption('604800000');
 await visibleIds();assert.equal(await page.locator('#activity-count').textContent(),'111 requests');
 await page.getByLabel('Filter requests by route',{exact:true}).selectOption('shared');
 assert.deepEqual(await visibleIds(),[originalId,'filter-queued','filter-limited'].sort());
 await page.getByRole('button',{name:'Clear filters',exact:true}).click();
 await visibleIds();
 await page.getByLabel('Requests per page',{exact:true}).selectOption('25');
 const collected=await visibleIds();assert.equal(collected.length,25);
 assert.equal(await page.getByRole('button',{name:'← Newer',exact:true}).isDisabled(),true);
 store.event(otherPerson,'new-arrival',null,200,10,null,undefined,'paging-new-arrival');
 for(let index=0;index<4;index++){
  await page.getByRole('button',{name:'Older →',exact:true}).click();
  collected.push(...await visibleIds());
 }
 assert.equal(collected.length,111);assert.equal(new Set(collected).size,111);
 assert.equal(collected.includes('paging-new-arrival'),false);
 assert.equal(await page.getByRole('button',{name:'Older →',exact:true}).isDisabled(),true);
 await page.locator(`#activity-rows [data-id="${originalId}"]`).click();
 await page.locator('dialog').getByText('Shared backup',{exact:true}).waitFor();
 await page.locator('dialog').getByText('owner-private@test.invalid',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 await page.getByRole('button',{name:'← Newer',exact:true}).click();
 assert.equal((await visibleIds()).length,25);
 await page.getByLabel('Filter requests by account',{exact:true}).selectOption('removed-auth');
 assert.deepEqual(await visibleIds(),['filter-completed']);
 assert.equal(await page.getByRole('button',{name:'← Newer',exact:true}).isDisabled(),true);
 await page.getByRole('button',{name:'Clear filters',exact:true}).click();
 await visibleIds();
 await page.getByRole('button',{name:'Latest',exact:true}).click();
 await visibleIds();assert.equal(await page.locator('#activity-count').textContent(),'112 requests');
 await page.getByLabel('Requests per page',{exact:true}).selectOption('100');
 assert.equal((await visibleIds()).length,100);
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 await page.setViewportSize({width:1440,height:1050});

 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.getByLabel('Queue wait',{exact:true}).waitFor();
 assert.equal(await page.getByLabel('Queue wait',{exact:true}).inputValue(),'180');
 await page.getByText('Built-in safeguards',{exact:true}).waitFor();
 await page.getByText('More parallel requests can overshoot',{exact:false}).waitFor();
 await page.getByLabel('Queue wait',{exact:true}).fill('240');
 await page.getByLabel('Parallel requests per account',{exact:true}).fill('2');
 await page.getByRole('button',{name:'Switch to dark mode',exact:true}).click();
 assert.equal(await page.getByLabel('Queue wait',{exact:true}).inputValue(),'240');
 await page.getByRole('button',{name:'Switch to light mode',exact:true}).click();
 await page.locator('[data-action=toggle-prompt-previews]').click();
 await page.getByRole('button',{name:'Disabled',exact:true}).waitFor();
 assert.equal(await page.getByLabel('Queue wait',{exact:true}).inputValue(),'240');
 await page.locator('[data-action=toggle-prompt-previews]').click();
 await page.getByRole('button',{name:'Enabled',exact:true}).waitFor();
 assert.equal(await page.getByLabel('Parallel requests per account',{exact:true}).inputValue(),'2');
 const settingsRequest=page.waitForRequest(request=>request.url().endsWith('/api/settings')&&request.method()==='PATCH');
 await page.getByRole('button',{name:'Save request limits',exact:true}).click();
 const savedSettings=(await settingsRequest).postDataJSON();
 assert.equal(savedSettings.queueWaitSeconds,240);assert.equal(savedSettings.concurrentRequestsPerAccount,2);
 await page.getByText('Request limits saved',{exact:true}).waitFor();
 assert.equal(store.settings().queueWaitSeconds,240);assert.equal(store.settings().concurrentRequestsPerAccount,2);
 await page.reload();
 assert.equal(await page.getByLabel('Queue wait',{exact:true}).inputValue(),'240');
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 await page.setViewportSize({width:1440,height:1050});
 await page.getByRole('button',{name:'Connect T3 Code',exact:true}).click();
 await page.getByText('supports_websockets = false',{exact:false}).waitFor();
 await page.getByText('CODEX_HOME shown for each T3 server',{exact:false}).waitFor();
 // Every destination must fit narrow phones, tablets, and desktop widths.
 for(const theme of ['light','dark']){
 if(await page.locator('html').getAttribute('data-theme')!==theme)await page.getByRole('button',{name:`Switch to ${theme} mode`,exact:true}).click();
 for(const width of [1440,1024,768,390,320]){
  await page.setViewportSize({width,height:1000});
  for(const [id,label] of [['overview','Overview'],['people','People'],['accounts','Accounts'],['activity','Activity'],['reviews','Reviews'],['connect','Connect T3 Code'],['settings','Settings']]){
   await page.locator(`nav [data-page="${id}"]`).click();
   await page.getByRole('heading',{name:id==='connect'?'Connection':label,exact:true}).waitFor();
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,`${label} overflows at ${width}px`);
   if(width===1440||width===390)await page.screenshot({path:`.data/screenshots/${id}-${width}-${theme}.png`,fullPage:true});
  }
 }}
 await page.getByRole('button',{name:'Switch to light mode',exact:true}).click();
 await page.setViewportSize({width:1440,height:1050});
 await page.getByRole('button',{name:'Overview',exact:true}).click();await page.screenshot({path:'.data/screenshots/admin-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'.data/screenshots/admin-mobile.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 const friend=await browser.newContext({viewport:{width:1440,height:1000},colorScheme:'light'});const memberPage=await friend.newPage();memberPage.on('pageerror',e=>errors.push(e.message));
 await memberPage.goto(`${mountedUrl}/me`);await memberPage.getByLabel('Access key',{exact:true}).fill(key);await memberPage.getByRole('button',{name:'Sign in',exact:true}).click();
 await memberPage.getByRole('heading',{name:'Friend',exact:true}).waitFor();assert.equal(await memberPage.getByText('owner-private@test.invalid').count(),0);assert.equal(await memberPage.locator('[data-owner]').count(),0);assert.equal(await memberPage.getByText('Build an application tracker.',{exact:false}).count(),0);
 await memberPage.getByRole('button',{name:'Switch to dark mode',exact:true}).click();
 await memberPage.reload();assert.equal(await memberPage.locator('html').getAttribute('data-theme'),'dark');
 assert.equal(await memberPage.locator('.member-metrics').evaluate(el=>el.nextElementSibling?.classList.contains('member-routing')),true);
 assert.equal(await memberPage.getByRole('region',{name:'Use mine',exact:true}).count(),1);
 await memberPage.getByRole('button',{name:'Use mine',exact:true}).click();
 await memberPage.getByRole('button',{name:'Hold to use mine',exact:true}).waitFor();
 await memberPage.getByRole('button',{name:'Cancel',exact:true}).click();
 await memberPage.getByRole('button',{name:'Switch to light mode',exact:true}).click();
 await memberPage.getByText('Backup with 60% left · hourly session',{exact:true}).waitFor();
 await memberPage.getByText('Backup available',{exact:true}).waitFor();
 const policy=memberPage.getByRole('region',{name:'Switch to backup',exact:true});
 await policy.getByText('Set by hub owner',{exact:true}).waitFor();
 await policy.getByText('60% personal quota left',{exact:true}).waitFor();
 await policy.getByText('Hourly session quota',{exact:true}).waitFor();
 await memberPage.getByRole('img',{name:'5 hour: 50% of backup allowance remaining',exact:true}).waitFor();
 await memberPage.getByRole('img',{name:'Weekly: 33.3% of backup allowance remaining',exact:true}).waitFor();
 // Shared bars are relative to the effective ceiling (20 minus the 2-point margin).
 for(const [used,left] of [[0,100],[9,50],[18,0],[20,0]]){
  ownerAccount.windows[0]!.usedPercent=used!;
  await memberPage.reload();
  await memberPage.getByRole('img',{name:`5 hour: ${left}% of backup allowance remaining`,exact:true}).waitFor();
 }
 ownerAccount.windows[0]!.usedPercent=9;
 const storedMember=store.member(member.id);storedMember.sharePercent=2;store.save(storedMember);
 await memberPage.reload();
 await memberPage.getByRole('img',{name:'5 hour: 0% of backup allowance remaining',exact:true}).waitFor();
 storedMember.sharePercent=20;store.save(storedMember);await memberPage.reload();

 assert.equal(await policy.locator('input, select, button').count(),0);
 await page.setViewportSize({width:1440,height:1050});
 await page.locator('nav [data-page=people]').click();
 await page.getByRole('button',{name:'Manage',exact:true}).click();
 await page.getByLabel('Switch to backup with personal quota left (%)',{exact:true}).fill('50');
 await page.getByLabel('Switchover quota window',{exact:true}).selectOption('weekly');
 await page.getByLabel('Requests per minute',{exact:true}).fill('300');
 await page.getByRole('button',{name:'Save changes'}).click();
 await page.getByText('Sharing controls saved',{exact:true}).waitFor();
 await memberPage.reload();
 await policy.getByText('50% personal quota left',{exact:true}).waitFor();
 await policy.getByText('Weekly quota',{exact:true}).waitFor();
 await memberPage.getByText('300 REQUESTS / MIN',{exact:true}).waitFor();
 await memberPage.getByText('Personal account',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Overview',exact:true}).click();
 proxy.accounts.find(a=>a.id==='friend-auth')!.windows.find(w=>w.id==='weekly')!.usedPercent=75;
 await memberPage.reload();await memberPage.getByText('Backup available',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Pause sharing',exact:true}).click();
 await memberPage.reload();
 await policy.getByText('Shared backup is paused.',{exact:false}).waitFor();
 await memberPage.getByText('Backup paused · using personal quota',{exact:true}).waitFor();
 await memberPage.getByText('Personal account',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Resume sharing',exact:true}).click();
 await memberPage.reload();

 // A click or a released hold must not enable the override.
 const routingCalls:any[]=[];
 memberPage.on('request',request=>{if(request.url().endsWith('/api/member/routing'))routingCalls.push(request.postDataJSON());});
 await memberPage.getByRole('button',{name:'Use mine',exact:true}).click();
 await memberPage.getByRole('heading',{name:'Use only your accounts?',exact:true}).waitFor();
 await memberPage.getByText('You could use up all your remaining personal quota',{exact:false}).waitFor();
 const hold=memberPage.getByRole('button',{name:'Hold to use mine',exact:true});
 await hold.click();assert.equal(routingCalls.length,0);
 await hold.hover();await memberPage.mouse.down();await memberPage.waitForTimeout(600);
 const progress=await hold.evaluate(button=>({fill:parseFloat(getComputedStyle(button,'::before').width),width:button.getBoundingClientRect().width,color:getComputedStyle(button,'::before').backgroundColor,remaining:parseFloat(button.querySelector('.hold-timer')!.textContent!)}));
 assert.ok(progress.fill>0&&progress.fill<progress.width);assert.equal(progress.color,'rgb(180, 54, 45)');assert.ok(progress.remaining>0&&progress.remaining<2);
 await memberPage.mouse.up();
 await memberPage.waitForTimeout(2100);assert.equal(routingCalls.length,0);
 assert.equal(await hold.locator('.hold-timer').textContent(),'2.0s');
 assert.equal(await hold.evaluate(button=>parseFloat(getComputedStyle(button,'::before').width)),0);
 await hold.focus();await memberPage.keyboard.down('Space');await memberPage.waitForTimeout(300);await memberPage.keyboard.up('Space');
 await memberPage.waitForTimeout(2100);assert.equal(routingCalls.length,0);
 await memberPage.getByRole('button',{name:'Cancel',exact:true}).click();
 await memberPage.getByRole('button',{name:'Use mine',exact:true}).click();
 await hold.hover();await memberPage.mouse.down();
 await memberPage.getByText('Use mine is on. Shared backup is off.',{exact:true}).waitFor();await memberPage.mouse.up();
 assert.deepEqual(routingCalls,[{personalOnly:true,confirmed:true}]);
 assert.equal(store.member(member.id).personalOnly,true);
 await memberPage.getByText('Off · Use mine',{exact:true}).waitFor();
 await memberPage.getByText('Personal account',{exact:true}).waitFor();
 await memberPage.reload();
 await memberPage.getByText('Use mine · shared backup off',{exact:true}).waitFor();
 await memberPage.getByRole('button',{name:'Restore automatic routing',exact:true}).click();
 await memberPage.getByText('Automatic routing restored',{exact:true}).waitFor();
 await memberPage.getByText('Backup available',{exact:true}).waitFor();
 // Keyboard confirmation also works on a narrow screen.
 await memberPage.setViewportSize({width:390,height:844});
 await memberPage.getByRole('button',{name:'Use mine',exact:true}).click();
 assert.equal(await memberPage.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 await hold.focus();await memberPage.keyboard.down('Enter');
 await memberPage.getByText('Use mine is on. Shared backup is off.',{exact:true}).waitFor();await memberPage.keyboard.up('Enter');
 assert.equal(store.member(member.id).personalOnly,true);
 await memberPage.getByRole('button',{name:'Restore automatic routing',exact:true}).click();
 await memberPage.getByText('Automatic routing restored',{exact:true}).waitFor();
 await memberPage.setViewportSize({width:1440,height:1000});
 // Exercise touch PointerEvents and cancellation on a mobile context.
 const touchContext=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,storageState:await friend.storageState()});
 const touchPage=await touchContext.newPage();touchPage.on('pageerror',e=>errors.push(e.message));
 await touchPage.goto(`${mountedUrl}/me`);
 await touchPage.getByRole('button',{name:'Use mine',exact:true}).tap();
 const touchHold=touchPage.getByRole('button',{name:'Hold to use mine',exact:true});
 const touchEvent={pointerId:1,pointerType:'touch',isPrimary:true,button:0};
 await touchHold.dispatchEvent('pointerdown',touchEvent);
 await touchHold.dispatchEvent('pointercancel',touchEvent);
 await touchPage.waitForTimeout(2100);assert.equal(store.member(member.id).personalOnly,false);
 await touchHold.dispatchEvent('pointerdown',touchEvent);
 await touchPage.getByText('Use mine is on. Shared backup is off.',{exact:true}).waitFor();
 assert.equal(store.member(member.id).personalOnly,true);
 await touchPage.getByRole('button',{name:'Restore automatic routing',exact:true}).tap();
 await touchPage.getByText('Automatic routing restored',{exact:true}).waitFor();
 await touchContext.close();

 await memberPage.getByRole('button',{name:'Connect an account',exact:true}).click();
 assert.equal(await memberPage.getByLabel('Import CLIProxy auth JSON').count(),0);
 await memberPage.getByRole('button',{name:'Connect Codex',exact:true}).click();
 await memberPage.getByRole('link',{name:'Open Codex sign-in'}).waitFor();
 await memberPage.getByLabel('Paste the complete localhost callback URL').fill('http://localhost:1455/auth/callback?code=ui-code&state=ui-native-state');
 await memberPage.getByRole('button',{name:'Finish connecting'}).click();
 await memberPage.getByText('Callback received.',{exact:false}).waitFor();
 await memberPage.getByRole('button',{name:'Check status',exact:true}).click();
 await memberPage.getByText('self-service@test.invalid',{exact:true}).waitFor();
 assert.equal(proxy.accounts.at(-1)!.ownerMemberId,member.id);
 await memberPage.getByText('T3 Code usage hub',{exact:true}).click();
 await memberPage.getByText('Management key: your access key.',{exact:false}).waitFor();
 await memberPage.getByText('Cancelled',{exact:true}).waitFor();
 await memberPage.locator('#toast.show').waitFor({state:'hidden'});
 for(const theme of ['dark','light']){
 await memberPage.getByRole('button',{name:`Switch to ${theme} mode`,exact:true}).click();
 for(const width of [320,390,768,1024,1440]){await memberPage.setViewportSize({width,height:1000});assert.equal(await memberPage.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,`Member view overflows at ${width}px`);}
 await memberPage.screenshot({path:`.data/screenshots/friend-desktop-${theme}.png`,fullPage:true});
 await memberPage.setViewportSize({width:390,height:844});await memberPage.screenshot({path:`.data/screenshots/friend-mobile-${theme}.png`,fullPage:true});
 }
 await memberPage.setViewportSize({width:1440,height:1000});
 await memberPage.screenshot({path:'.data/screenshots/friend-desktop.png',fullPage:true});
 await memberPage.setViewportSize({width:390,height:844});await memberPage.screenshot({path:'.data/screenshots/friend-mobile.png',fullPage:true});assert.equal(await memberPage.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
 assert.equal(await memberPage.locator('[data-action=remove-account]').count(),2);
 await memberPage.getByRole('button',{name:'Remove account self-service@test.invalid',exact:true}).click();
 await memberPage.getByRole('heading',{name:'Remove self-service@test.invalid?',exact:true}).waitFor();
 await memberPage.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(connected.length,1);
 await memberPage.getByRole('button',{name:'Remove account self-service@test.invalid',exact:true}).click();
 await memberPage.getByRole('button',{name:'Remove account',exact:true}).click();
 await memberPage.getByText('Account removed',{exact:true}).waitFor();
 assert.equal(await memberPage.getByText('self-service@test.invalid',{exact:true}).count(),0);
 assert.equal(connected.length,0);assert.ok(proxy.accounts.some(a=>a.id==='friend-auth'));
 await page.locator('nav [data-page=people]').click();
 await page.getByRole('button',{name:'Manage',exact:true}).click();
 await page.locator('input[name=account][value="owner-auth"]').check();
 await page.getByRole('button',{name:'Save changes'}).click();
 await page.getByText('Sharing controls saved',{exact:true}).waitFor();
 await page.getByRole('button',{name:'Accounts',exact:true}).click();
 await page.getByRole('button',{name:'Remove account owner-private@test.invalid',exact:true}).click();
 await page.getByRole('heading',{name:'Remove owner-private@test.invalid?',exact:true}).waitFor();
 await page.getByRole('button',{name:'Remove account',exact:true}).click();
 await page.getByText('Account removed',{exact:true}).waitFor();
 assert.ok(!proxy.accounts.some(a=>a.id==='owner-auth'));assert.ok(proxy.accounts.some(a=>a.id==='friend-auth'));
 await page.locator('nav [data-page=people]').click();
 await page.getByRole('button',{name:'Manage',exact:true}).click();
 assert.equal(await page.getByRole('checkbox',{name:'Removed account · unavailable',exact:true}).isChecked(),true);
 await page.getByRole('button',{name:'Save changes'}).click();
 await page.getByText('Sharing controls saved',{exact:true}).waitFor();
 assert.deepEqual(store.member(member.id).accountIds,['owner-auth']);
 await memberPage.getByRole('button',{name:'Sign out'}).click();await memberPage.getByRole('heading',{name:'Your access',exact:true}).waitFor();
 await page.setViewportSize({width:1440,height:1050});await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.reload();await page.getByRole('heading',{name:'Admin sign-in',exact:true}).waitFor();
 assert.equal((await context.request.get(`${mountedUrl}/api/state`)).status(),401);
 assert.deepEqual(errors,[]);console.log('UI checks passed: create/edit access, account assignment, member self-service sign-in, usage hub instructions, isolated friend login/logout, mouse/keyboard/touch hold confirmation and cancellation, persistent personal-only routing, remaining-quota math and unavailable readings, complementary reserve/switchover controls, all destinations in both themes at 320–1440px, system theme and saved preference, restricted storage, routing control position, keyboard skip navigation, no browser errors.');
}finally{await browser.close();hub.server.closeAllConnections();hub.server.close();store.close();}
