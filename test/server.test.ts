import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHub } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { CliProxy } from '../src/cliproxy.ts';
import { hashPassword } from '../src/auth.ts';
const adminPassword = 'test admin passphrase only';
const adminPasswordHash = await hashPassword(adminPassword);
import type { Account } from '../src/types.ts';
const account = (id:string,used:number):Account=>({id,ownerMemberId:null,name:id,email:`${id}@test.invalid`,provider:'codex',prefix:`vcp-${id}`,enabled:true,available:true,checkedAt:Date.now(),models:['test-model'],windows:[{id:'weekly',label:'Weekly',usedPercent:used,resetsAt:Date.now()+86400000}]});
async function setup(t:any, basePath = ''){
 const calls:any[]=[];
 const releases:Array<()=>void>=[];
 const control={hold:false,release:()=>{for(const release of releases.splice(0))release();},status:200,disconnect:false};
 const upstream=createServer(async(req,res)=>{
  let raw='';
  for await(const chunk of req)raw+=chunk;
  calls.push({body:JSON.parse(raw),headers:req.headers});
  if(control.disconnect){res.destroy();return;}
  if(control.status>=400){
   res.writeHead(control.status,{'Content-Type':'application/json'});
   res.end(JSON.stringify({error:{type:'provider_failure',message:'Provider request failed'}}));
   return;
  }
  res.writeHead(200,{'Content-Type':'text/event-stream'});
  res.write('data: {"type":"response.created"}\n\n');
  if(control.hold)await new Promise<void>(resolve=>{releases.push(resolve);});
  res.end('data: {"type":"response.completed","response":{"output":[]}}\n\n');
 });
 upstream.listen(0,'127.0.0.1');await once(upstream,'listening');const upstreamUrl=`http://127.0.0.1:${(upstream.address() as any).port}`;
 const store=new Store(':memory:');const proxy=new CliProxy({url:upstreamUrl,apiKey:'upstream-private',managementKey:'management-private'},store);proxy.accounts=[account('protected',30),account('eligible',10)];proxy.lastSync=Date.now();
 const hub=createHub({host:'127.0.0.1',port:0,dataPath:':memory:',publicOrigin:'http://localhost',basePath,adminPasswordHash,proxyUrl:upstreamUrl,proxyKey:'upstream-private',managementKey:'management-private'},{store,proxy});
 hub.server.listen(0,'127.0.0.1');await once(hub.server,'listening');const origin=`http://127.0.0.1:${(hub.server.address() as any).port}`;const base=`${origin}${basePath}`;
 t.after(()=>{hub.stopRequests();hub.server.closeAllConnections();hub.server.close();upstream.closeAllConnections();upstream.close();store.close();});
 const login=await fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:adminPassword})});
 assert.equal(login.status,200);const session=await login.json();const adminCookie=login.headers.get('set-cookie')!.split(';')[0]!;
 const adminHeaders={Cookie:adminCookie,'Tailscale-User-Login':'owner@test.invalid','Content-Type':'application/json'};
 const admin=async(path:string,method='GET',body?:unknown)=>fetch(`${base}/api${path}`,{method,headers:{...adminHeaders,'X-CSRF-Token':session.csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const created=await(await admin('/members','POST',{name:'Friend',sharePercent:20,fallbackOnly:false})).json();
 const infer=(key=created.key,body:unknown={model:'test-model',stream:true},extraHeaders={})=>fetch(`${base}/v1/responses`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json',...extraHeaders},body:JSON.stringify(body)});
 return {hub,base,origin,store,proxy,calls,created,admin,infer,control,adminCookie,csrf:session.csrf};
}
test('routes only to an eligible account, replaces credentials, strips hostile routing headers, and streams unbuffered SSE',async t=>{
 const s=await setup(t);const res=await s.infer(undefined,{model:'test-model',stream:true,max_output_tokens:999999},{'X-CLIProxy-Auth-Index':'protected','Session_id':'hostile'});
 assert.equal(res.status,200);assert.match(await res.text(),/response.completed/);
 assert.equal(s.calls.length,1);assert.equal(s.calls[0].body.model,'vcp-eligible/test-model');assert.equal(s.calls[0].body.max_output_tokens,8192);
 assert.equal(s.calls[0].headers.authorization,'Bearer upstream-private');assert.equal(s.calls[0].headers['x-cliproxy-auth-index'],undefined);assert.equal(s.calls[0].headers.session_id,undefined);
});
test('admin activity queries reach older shared accounts while member keys cannot access history',async t=>{
 const s=await setup(t), member=s.store.member(s.created.member.id);
 for(let i=0;i<105;i++)s.store.event(member,'test-model','personal',200,100,null,{method:'POST',path:'/v1/responses',state:'finished',startedAt:Date.now(),requestBytes:0,responseBytes:0,queueMs:0,provider:'codex',route:'personal'},`recent-${i}`);
 s.store.event(member,'historic-model','old-backup',200,100,null,{method:'POST',path:'/v1/responses',state:'finished',startedAt:Date.now(),requestBytes:0,responseBytes:0,queueMs:0,provider:'codex',route:'shared',accountLabel:'old@test.invalid'},'historic-shared');
 s.store.db.prepare('UPDATE events SET at=? WHERE id=?').run(Date.now()-6*86400000,'historic-shared');
 const response=await s.admin('/activity?route=shared&account=old-backup&time=604800000');
 assert.equal(response.status,200);
 const result=await response.json();assert.equal(result.total,1);assert.equal(result.events[0].id,'historic-shared');
 const first=await(await s.admin('/activity?limit=25')).json();assert.equal(first.events.length,25);assert.equal(first.total,106);
 const older=await(await s.admin(`/activity?limit=25&offset=100&snapshot=${first.snapshot}`)).json();assert.equal(older.events.length,6);assert.ok(older.events.some((event:any)=>event.id==='historic-shared'));
 assert.equal((await s.admin('/activity?limit=101')).status,400);
 assert.equal((await fetch(`${s.base}/api/activity`)).status,401);
 assert.equal((await fetch(`${s.base}/api/activity`,{headers:{Authorization:`Bearer ${s.created.key}`}})).status,401);
});
test('reserve, stale quota, malformed model, missing key and expired key block without contacting upstream',async t=>{
 const s=await setup(t);
 s.proxy.accounts[1]!.windows[0]!.usedPercent=20;assert.equal((await s.infer()).status,429);
 s.proxy.accounts[1]!.windows[0]!.usedPercent=10;s.proxy.accounts[1]!.checkedAt=Date.now()-130000;assert.equal((await s.infer()).status,429);
 assert.equal((await s.infer('invalid')).status,401);
 assert.equal((await s.infer(undefined,{model:'vcp-protected/test-model'})).status,400);
 const m=s.store.member(s.created.member.id);m.expiresAt=Date.now()-1;s.store.save(m);assert.equal((await s.infer()).status,403);
 assert.equal(s.calls.length,0);
});
test('friend key can read scoped usage but cannot read admin state or unrestricted management',async t=>{
 const s=await setup(t);assert.equal((await fetch(`${s.base}/api/state`,{headers:{Authorization:`Bearer ${s.created.key}`}})).status,401);
 assert.equal((await fetch(`${s.base}/v0/management/auth-files`,{headers:{Authorization:`Bearer ${s.created.key}`}})).status,200);
 assert.equal((await fetch(`${s.base}/v0/management/config`,{headers:{Authorization:`Bearer ${s.created.key}`}})).status,403);
});
test('pausing, model permissions, account restrictions and rotation are enforced',async t=>{
 const s=await setup(t);const id=s.created.member.id;
 await s.admin(`/members/${id}`,'PATCH',{paused:true});assert.equal((await s.infer()).status,403);
 await s.admin(`/members/${id}`,'PATCH',{paused:false,allowedModels:['other']});assert.equal((await s.infer()).status,403);
 await s.admin(`/members/${id}`,'PATCH',{allowedModels:[],accountIds:['protected']});assert.equal((await s.infer()).status,429);
 await s.admin(`/members/${id}`,'PATCH',{accountIds:[]});const rotated=await(await s.admin(`/members/${id}/rotate`,'POST')).json();
 assert.equal((await s.infer()).status,401);assert.equal((await s.infer(rotated.key)).status,200);
 await s.admin('/settings','PATCH',{paused:true});assert.equal((await s.infer(rotated.key)).status,403);
});
test('CSRF and cross-origin writes are blocked; secrets never appear in state',async t=>{
 const s=await setup(t);
 assert.equal((await fetch(`${s.base}/api/members`,{method:'POST',headers:{Cookie:s.adminCookie,'Content-Type':'application/json'},body:'{"name":"hacker"}'})).status,403);
 assert.equal((await fetch(`${s.base}/api/login`,{method:'POST',headers:{Origin:'https://evil.invalid','Content-Type':'application/json'},body:JSON.stringify({password:adminPassword})})).status,403);
 const text=await(await s.admin('/state')).text();for(const secret of [s.created.key,'keyHash','management-private','upstream-private'])assert.equal(text.includes(secret),false);
});
test('per-person request rate limits are enforced',async t=>{
 const s=await setup(t);await s.admin(`/members/${s.created.member.id}`,'PATCH',{rpm:1});
 assert.equal((await s.infer()).status,200);assert.equal((await s.infer()).status,429);assert.equal(s.calls.length,1);
});
test('personal first, shared only after exhaustion; pausing sharing leaves the personal pool available',async t=>{
 const s=await setup(t);const id=s.created.member.id;
 await s.admin(`/members/${id}`,'PATCH',{fallbackOnly:true});
 assert.equal((await s.infer()).status,429);
 await s.admin('/accounts/owner','PATCH',{accountId:'eligible',memberId:id});
 s.proxy.accounts[1]!.windows[0]!.usedPercent=85;
 await s.admin('/settings','PATCH',{paused:true});
 assert.equal((await s.infer()).status,200);assert.equal(s.calls[0].body.model,'vcp-eligible/test-model');
 s.proxy.accounts[1]!.windows[0]!.usedPercent=100;s.proxy.accounts[0]!.windows[0]!.usedPercent=5;
 assert.equal((await s.infer()).status,403);
 await s.admin('/settings','PATCH',{paused:false});
 assert.equal((await s.infer()).status,200);assert.equal(s.calls[1].body.model,'vcp-protected/test-model');
 s.proxy.accounts[1]!.windows[0]!.usedPercent=2;
 assert.equal((await s.infer()).status,200);assert.equal(s.calls[2].body.model,'vcp-eligible/test-model');
});
test('friend dashboard isolates records, hides owner identity, and sessions are revoked on key rotation',async t=>{
 const s=await setup(t);const id=s.created.member.id;
 await s.admin('/members','POST',{name:'Private Person',sharePercent:75});
 await s.infer();
 const login=await fetch(`${s.base}/api/member/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:s.created.key})});
 assert.equal(login.status,200);const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
 const view=await fetch(`${s.base}/api/member/state`,{headers:{Cookie:cookie}});assert.equal(view.status,200);const text=await view.text();
 for(const secret of ['Private Person','protected@test.invalid','eligible@test.invalid','keyHash',s.created.key,'accountIds'])assert.equal(text.includes(secret),false);
 const state=JSON.parse(text);assert.equal(state.history.length,1);assert.equal(state.member.name,'Friend');
 assert.equal((await fetch(`${s.base}/api/state`,{headers:{Cookie:cookie}})).status,401);
 await s.admin(`/members/${id}/rotate`,'POST');assert.equal((await fetch(`${s.base}/api/member/state`,{headers:{Cookie:cookie}})).status,401);
});

test('admin can customize personal switchover independently of the backup ceiling',async t=>{
 const s=await setup(t),id=s.created.member.id;
 assert.equal(s.created.member.personalSwitchPercent,100);
 const created=await(await s.admin('/members','POST',{name:'Custom',personalSwitchPercent:37.5})).json();
 assert.equal(created.member.personalSwitchPercent,37.5);
 for(const value of [0,-1,100.1,'40',null]) {
  assert.equal((await s.admin(`/members/${id}`,'PATCH',{personalSwitchPercent:value})).status,400);
  assert.equal((await s.admin('/members','POST',{name:'Invalid',personalSwitchPercent:value})).status,400);
 }
 assert.equal((await s.admin(`/members/${id}`,'PATCH',{fallbackOnly:true,personalSwitchPercent:40})).status,200);
 await s.admin('/accounts/owner','PATCH',{accountId:'eligible',memberId:id});
 s.proxy.accounts[0]!.windows[0]!.usedPercent=5;
 s.proxy.accounts[1]!.windows[0]!.usedPercent=39.9;
 assert.equal((await s.infer()).status,200);assert.equal(s.calls.at(-1).body.model,'vcp-eligible/test-model');
 s.proxy.accounts[1]!.windows[0]!.usedPercent=40;
 assert.equal((await s.infer()).status,200);assert.equal(s.calls.at(-1).body.model,'vcp-protected/test-model');
 await s.admin(`/members/${id}`,'PATCH',{personalSwitchPercent:50});
 assert.equal((await s.infer()).status,200);assert.equal(s.calls.at(-1).body.model,'vcp-eligible/test-model');
 await s.admin(`/members/${id}`,'PATCH',{name:'Renamed'});
 assert.equal(s.store.member(id).personalSwitchPercent,50);
 assert.equal(s.store.member(id).sharePercent,20);
 const state=await(await s.admin('/state')).json();assert.equal(state.members.find((m:any)=>m.id===id).personalSwitchPercent,50);
 // Existing saved members retain the previous 100% switchover without a migration.
 const legacy=s.store.member(id);delete legacy.personalSwitchPercent;s.store.save(legacy);
 assert.equal(s.store.member(id).personalSwitchPercent,100);
 assert.equal(s.store.members().find(m=>m.id===id)!.personalSwitchPercent,100);
});

test('admin can save hourly, weekly, or both and raise the per-minute request limit above 120',async t=>{
 const s=await setup(t),id=s.created.member.id;
 assert.equal(s.created.member.personalSwitchWindow,'both');
 for(const personalSwitchWindow of ['hourly','weekly','both']) {
  const res=await s.admin(`/members/${id}`,'PATCH',{personalSwitchWindow,rpm:6000});
  assert.equal(res.status,200);
  const saved=await res.json();assert.equal(saved.personalSwitchWindow,personalSwitchWindow);assert.equal(saved.rpm,6000);
 }
 for(const personalSwitchWindow of ['daily','',null,[],7]) {
  assert.equal((await s.admin(`/members/${id}`,'PATCH',{personalSwitchWindow})).status,400);
  assert.equal((await s.admin('/members','POST',{name:'Invalid',personalSwitchWindow})).status,400);
 }
 assert.equal((await s.admin(`/members/${id}`,'PATCH',{rpm:6001})).status,400);
 await s.admin(`/members/${id}`,'PATCH',{fallbackOnly:true,personalSwitchWindow:'weekly',personalSwitchPercent:40});
 await s.admin('/accounts/owner','PATCH',{accountId:'eligible',memberId:id});
 const personal=s.proxy.accounts[1]!;
 personal.windows=[{id:'primary_window',label:'5 hour',usedPercent:45,resetsAt:Date.now()+3600000},
  {id:'secondary_window',label:'Weekly',usedPercent:10,resetsAt:Date.now()+86400000}];
 s.proxy.accounts[0]!.windows[0]!.usedPercent=1;
 assert.equal((await s.infer()).status,200);assert.equal(s.calls.at(-1).body.model,'vcp-eligible/test-model');
 await s.admin(`/members/${id}`,'PATCH',{personalSwitchWindow:'hourly'});
 assert.equal((await s.infer()).status,200);assert.equal(s.calls.at(-1).body.model,'vcp-protected/test-model');
 const legacy=s.store.member(id);delete legacy.personalSwitchWindow;s.store.save(legacy);
 assert.equal(s.store.member(id).personalSwitchWindow,'both');
 assert.equal(s.store.members()[0]!.personalSwitchWindow,'both');
});

test('admin account removal uses the inventory filename and preserves restricted pools and history',async t=>{
 const s=await setup(t);const management:any[]=[];
 s.proxy.management=async(path,body,method)=>{management.push({path,body,method});return {status:'ok'};};
 s.proxy.accounts[1]!.name='credential with & spaces.json';
 await s.admin(`/members/${s.created.member.id}`,'PATCH',{accountIds:['eligible']});
 const response=await s.infer();assert.equal(response.status,200);await response.text();
 assert.equal((await s.admin('/accounts','DELETE',{accountId:'eligible'})).status,200);
 assert.deepEqual(management,[{path:'auth-files?name=credential%20with%20%26%20spaces.json',body:undefined,method:'DELETE'}]);
 assert.deepEqual(s.proxy.accounts.map(a=>a.id),['protected']);
 assert.deepEqual(s.store.member(s.created.member.id).accountIds,['eligible']);
 assert.ok(s.store.history().some(row=>row.account_id==='eligible'&&row.status===200));
 assert.equal((await s.infer()).status,429); // An explicit pool must never become unrestricted.
 assert.equal((await s.admin('/accounts','DELETE',{accountId:'eligible'})).status,404);
});

test('account removal cancels only requests using that account',async t=>{
 const s=await setup(t);s.control.hold=true;t.after(()=>s.control.release());
 s.proxy.management=async()=>({status:'ok'});
 s.proxy.accounts[0]!.windows[0]!.usedPercent=5;
 const first=await s.infer();const firstDone=first.text().catch(()=>{});
 const second=await s.infer();
 assert.equal(s.calls.length,2);
 assert.equal((await s.admin('/accounts','DELETE',{accountId:'protected'})).status,200);
 await firstDone;
 assert.ok(s.store.history().some(row=>row.account_id==='protected'&&row.reason==='access_changed'));
 assert.ok(s.store.history().some(row=>row.account_id==='eligible'&&row.status===102));
 s.control.hold=false;s.control.release();await second.text();
 assert.ok(s.store.history().some(row=>row.account_id==='eligible'&&row.status===200));
});

test('paused sharing overrides the personal switchover threshold and resumes normal routing when enabled',async t=>{
 const s=await setup(t),id=s.created.member.id;
 await s.admin(`/members/${id}`,'PATCH',{fallbackOnly:true,personalSwitchPercent:20});
 await s.admin('/accounts/owner','PATCH',{accountId:'eligible',memberId:id});
 s.proxy.accounts[0]!.windows[0]!.usedPercent=5;
 s.proxy.accounts[1]!.windows[0]!.usedPercent=75;
 let response=await s.infer();assert.equal(response.status,200);await response.text();assert.equal(s.calls.at(-1).body.model,'vcp-protected/test-model');
 await s.admin('/settings','PATCH',{paused:true});
 response=await s.infer();assert.equal(response.status,200);await response.text();assert.equal(s.calls.at(-1).body.model,'vcp-eligible/test-model');
 const login=await fetch(`${s.base}/api/member/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:s.created.key})});
 const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
 const view=await(await fetch(`${s.base}/api/member/state`,{headers:{Cookie:cookie}})).json();
 assert.equal(view.settings.paused,true);assert.equal(view.accounts.find((a:any)=>a.personal).switchReached,false);
 s.proxy.accounts[1]!.windows[0]!.usedPercent=100;
 assert.equal((await s.infer()).status,403);
 await s.admin('/settings','PATCH',{paused:false});
 response=await s.infer();assert.equal(response.status,200);await response.text();assert.equal(s.calls.at(-1).body.model,'vcp-protected/test-model');
});

test('pausing sharing stops active backup but lets subsequent personal streams continue above the switch threshold',async t=>{
 const s=await setup(t),id=s.created.member.id;
 s.control.hold=true;t.after(()=>s.control.release());
 await s.admin(`/members/${id}`,'PATCH',{fallbackOnly:true,personalSwitchPercent:20});
 await s.admin('/accounts/owner','PATCH',{accountId:'eligible',memberId:id});
 s.proxy.accounts[0]!.windows[0]!.usedPercent=5;s.proxy.accounts[1]!.windows[0]!.usedPercent=75;
 const backup=await s.infer();const stopped=backup.text().catch(()=>{});
 await s.admin('/settings','PATCH',{paused:true});await stopped;
 assert.ok(s.store.history().some(row=>row.account_id==='protected'&&row.reason==='access_changed'));
 const personal=await s.infer();assert.equal(personal.status,200);assert.equal(s.calls.at(-1).body.model,'vcp-eligible/test-model');
 await s.admin('/settings','PATCH',{paused:true});
 assert.ok(s.store.history().some(row=>row.account_id==='eligible'&&row.status===102));
 s.control.hold=false;s.control.release();await personal.text();
 assert.ok(s.store.history().some(row=>row.account_id==='eligible'&&row.status===200));
});

test('overlapping personal requests can wait past 30 seconds without using shared backup',{timeout:45000},async t=>{
 const s=await setup(t);s.control.hold=true;
 t.after(()=>s.control.release());
 await s.admin(`/members/${s.created.member.id}`,'PATCH',{fallbackOnly:true});
 await s.admin('/accounts/owner','PATCH',{accountId:'eligible',memberId:s.created.member.id});
 s.proxy.accounts[0]!.windows[0]!.usedPercent=1;
 const first=await s.infer();assert.equal(first.status,200);
 const second=s.infer();
 await new Promise(resolve=>setTimeout(resolve,31000));
 assert.equal(s.calls.length,1);
 s.control.hold=false;s.control.release();await first.text();
 const response=await second;assert.equal(response.status,200);await response.text();
 assert.equal(s.calls.length,2);assert.equal(s.calls[1].body.model,'vcp-eligible/test-model');
 assert.ok(s.store.history().some(row=>row.details.queueMs>=30000));
});

test('mounted paths serve assets, scope sessions, advertise correct endpoints and preserve the upstream inference path',async t=>{
 const s=await setup(t,'/cliproxy');
 const html=await (await fetch(s.base)).text();
 assert.ok(html.includes('src="/cliproxy/app.js"'));assert.ok(html.includes('href="/cliproxy/style.css"'));
 assert.equal((await fetch(`${s.base}/app.js`)).status,200);
 assert.equal((await fetch(`${s.base}/me`)).status,200);
 const state=await(await s.admin('/state')).json();assert.equal(state.publicBaseUrl,'http://localhost/cliproxy');
 assert.equal((await s.infer()).status,200);assert.equal(s.calls.length,1);
 const login=await fetch(`${s.base}/api/member/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:s.created.key})});
 assert.match(login.headers.get('set-cookie')!,/Path=\/cliproxy;/);
 const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
 const session=await(await fetch(`${s.base}/api/member/session`,{headers:{Cookie:cookie}})).json();
 const logout=await fetch(`${s.base}/api/member/logout`,{method:'POST',headers:{Cookie:cookie,'X-CSRF-Token':session.csrf}});
 assert.match(logout.headers.get('set-cookie')!,/Path=\/cliproxy; Max-Age=0/);
 // Tailscale Serve removes its mount prefix before proxying; these requests must work too.
 assert.equal((await fetch(`${s.origin}/api/session`,{headers:{'Tailscale-User-Login':'owner@test.invalid'}})).status,200);
});
test('Tailscale owner headers and bearer keys cannot bypass the password; logout invalidates admin sessions',async t=>{
 const s=await setup(t,'/cliproxy');
 for(const headers of [{},{'Tailscale-User-Login':'owner@test.invalid'},{Authorization:`Bearer ${s.created.key}`},{Authorization:`Bearer ${adminPassword}`}]) {
  const session=await(await fetch(`${s.base}/api/session`,{headers})).json();assert.equal(session.authenticated,false);assert.equal(session.csrf,null);
  assert.equal((await fetch(`${s.base}/api/state`,{headers})).status,401);
  assert.equal((await fetch(`${s.base}/api/settings`,{method:'PATCH',headers:{...headers,'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:'{"paused":true}'})).status,401);
 }
 const wrong=await fetch(`${s.base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"password":"incorrect password"}'});
 assert.equal(wrong.status,401);assert.equal(wrong.headers.get('set-cookie'),null);
 const data=await(await s.admin('/state')).text();assert.ok(!data.includes(adminPassword));assert.ok(!data.includes(adminPasswordHash));
 assert.equal((await s.admin('/logout','POST')).status,200);
 assert.equal((await s.admin('/state')).status,401);
});
test('password sign-in is rate limited',async t=>{
 const s=await setup(t);
 for(let i=0;i<8;i++)assert.equal((await fetch(`${s.base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"password":"wrong"}'})).status,401);
 assert.equal((await fetch(`${s.base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:adminPassword})})).status,429);
});

test('concurrent requests share the rate limit after an asynchronous quota refresh', { timeout: 5000 }, async t => {
 const s = await setup(t);
 await s.admin(`/members/${s.created.member.id}`, 'PATCH', { rpm: 1 });
 s.proxy.accounts[0]!.windows[0]!.usedPercent = 5;
 s.proxy.lastSync = 0;
 let releaseRefresh!: () => void;
 const refresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
 t.after(() => releaseRefresh());
 let refreshCalls = 0;
 let bothWaiting!: () => void;
 const waiting = new Promise<void>(resolve => { bothWaiting = resolve; });
 s.proxy.sync = async () => {
  refreshCalls++;
  if (refreshCalls === 2) bothWaiting();
  await refresh;
 };
 const pending = Promise.all([s.infer(), s.infer()]);
 await waiting;
 releaseRefresh();
 const responses = await pending;
 await Promise.all(responses.map(response => response.text()));
 assert.deepEqual(responses.map(response => response.status).sort(), [200, 429]);
 assert.equal(s.calls.length, 1);
});

test('large Responses and compaction payloads pass through while dashboard writes keep their smaller limit', async t => {
 const s = await setup(t);
 const input = 'x'.repeat(5 * 1024 * 1024);
 for (const path of ['/v1/responses', '/v1/responses/compact']) {
  const response = await fetch(`${s.base}${path}`, {
   method: 'POST',
   headers: { Authorization: `Bearer ${s.created.key}`, 'Content-Type': 'application/json' },
   body: JSON.stringify({ model: 'test-model', input }),
  });
  assert.equal(response.status, 200);
  await response.text();
 }
 assert.equal(s.calls.length, 2);
 assert.equal(s.calls[0].body.input.length, input.length);
 assert.equal(s.calls[1].body.input.length, input.length);
 const dashboard = await s.admin('/members', 'POST', { name: input });
 assert.equal(dashboard.status, 413);
});

test('queued requests recheck the reserve before contacting the provider', async t => {
 const s = await setup(t);
 s.control.hold = true;
 t.after(() => s.control.release());
 const first = await s.infer();
 const pending = s.infer();
 await new Promise(resolve => setTimeout(resolve, 50));
 assert.equal(s.calls.length, 1);
 s.proxy.accounts[1]!.windows[0]!.usedPercent = 20;
 s.control.hold = false;
 s.control.release();
 await first.text();
 const response = await pending;
 assert.equal(response.status, 429);
 assert.equal((await response.json()).error.type, 'reserve_protected');
 assert.equal(s.calls.length, 1);
});

test('disconnecting a streaming client records cancellation and releases the account', {timeout: 5000}, async t => {
 const s = await setup(t);
 s.control.hold = true;
 t.after(() => s.control.release());
 let recorded!: () => void;
 const eventRecorded = new Promise<void>(resolve => { recorded = resolve; });
 const originalEvent = s.store.event.bind(s.store);
 s.store.event = (...args) => { originalEvent(...args); if(args[3]!==102)recorded(); };
 const controller = new AbortController();
 const response = await fetch(`${s.base}/v1/responses`, {
  method: 'POST',
  signal: controller.signal,
  headers: {Authorization: `Bearer ${s.created.key}`, 'Content-Type': 'application/json'},
  body: JSON.stringify({model: 'test-model', stream: true}),
 });
 const reader = response.body!.getReader();
 await reader.read();
 controller.abort();
 await assert.rejects(reader.read());
 await eventRecorded;
 const event = s.store.memberHistory(s.created.member.id)[0] as any;
 assert.equal(event.status, 499);
 assert.equal(event.reason, 'client_disconnected');
 s.control.hold = false;
 s.control.release();
 const next = await s.infer();
 assert.equal(next.status, 200);
 await next.text();
});

test('pausing an active member records access cancellation rather than a gateway failure', {timeout: 5000}, async t => {
 const s = await setup(t);
 s.control.hold = true;
 t.after(() => s.control.release());
 let recorded!: () => void;
 const eventRecorded = new Promise<void>(resolve => { recorded = resolve; });
 const originalEvent = s.store.event.bind(s.store);
 s.store.event = (...args) => { originalEvent(...args); if(args[3]!==102)recorded(); };
 const response = await s.infer();
 const reader = response.body!.getReader();
 await reader.read();
 await s.admin(`/members/${s.created.member.id}`, 'PATCH', {paused: true});
 await assert.rejects(reader.read());
 await eventRecorded;
 const event = s.store.memberHistory(s.created.member.id)[0] as any;
 assert.equal(event.status, 403);
 assert.equal(event.reason, 'access_changed');
});


test('a genuine upstream HTTP 502 remains a provider failure', async t => {
 const s = await setup(t);
 s.control.status = 502;
 const response = await s.infer();
 assert.equal(response.status, 502);
 assert.equal((await response.json()).error.type, 'provider_failure');
 const event = s.store.memberHistory(s.created.member.id)[0] as any;
 assert.equal(event.status, 502);
 assert.equal(event.reason, 'upstream_http_error');
 assert.equal(s.calls.length, 1);
});

test('an upstream socket failure remains a connection error and the account can recover', async t => {
 const s = await setup(t);
 s.control.disconnect = true;
 const response = await s.infer();
 assert.equal(response.status, 502);
 assert.equal((await response.json()).error.type, 'upstream_connection_error');
 s.control.disconnect = false;
 const next = await s.infer();
 assert.equal(next.status, 200);
 await next.text();
});

test('provider timeouts return HTTP 504 and release the account', async t => {
 const s = await setup(t);
 const originalFetch = globalThis.fetch;
 const replacement = t.mock.method(globalThis, 'fetch', (input: any, init: any) => {
  if (String(input).startsWith(s.proxy.config.url)) throw new DOMException('Timed out', 'TimeoutError');
  return originalFetch(input, init);
 });
 const response = await s.infer();
 assert.equal(response.status, 504);
 assert.equal((await response.json()).error.type, 'upstream_timeout');
 const event = s.store.memberHistory(s.created.member.id)[0] as any;
 assert.equal(event.status, 504);
 assert.equal(event.reason, 'upstream_timeout');
 replacement.mock.restore();
 const next = await s.infer();
 assert.equal(next.status, 200);
 await next.text();
});

test('admin request details include bounded previews and diagnostics while member views remain scoped', async t => {
 const s = await setup(t);
 await s.admin('/settings','PATCH',{promptPreviews:true});
 const response = await s.infer(undefined,{model:'test-model',stream:true,input:'Draft a cover letter. Bearer hidden-bearer-secret password=supersecret vcp_hidden_access_key123',tools:[]});
 const requestId = response.headers.get('x-request-id');
 await response.text();
 const state = await (await s.admin('/state')).json();
 assert.equal(state.history.length,1);
 const event=state.history[0];assert.equal(event.id,requestId);assert.equal(event.status,200);
 assert.equal(event.details.path,'/v1/responses');assert.equal(event.details.method,'POST');assert.equal(event.details.route,'shared');assert.equal(event.details.state,'finished');
 assert.equal(event.details.accountLabel,'eligible@test.invalid');assert.ok(event.details.requestBytes>0);assert.ok(event.details.responseBytes>0);assert.ok(event.details.firstByteMs>=0);
 assert.match(event.details.promptPreview,/Draft a cover letter/);
 const raw=JSON.stringify(event);for(const secret of ['hidden-bearer-secret','supersecret','vcp_hidden_access_key123',s.created.key])assert.equal(raw.includes(secret),false);
 const member=await(await fetch(`${s.base}/api/member/state`,{headers:{Authorization:`Bearer ${s.created.key}`}})).text();
 for(const privateField of ['"promptPreview":','cover letter','eligible@test.invalid','accountLabel','errorMessage','"details":'])assert.equal(member.includes(privateField),false);
 await s.admin('/settings','PATCH',{promptPreviews:false});
 const next=await s.infer(undefined,{model:'test-model',input:'This text must not be recorded'});await next.text();
 const updated=await(await s.admin('/state')).json();assert.equal(JSON.stringify(updated.history).includes('This text must not be recorded'),false);
});

test('incoming and queued requests stay visible and finish in the same log rows', {timeout:5000}, async t => {
 const s = await setup(t);s.control.hold=true;t.after(()=>s.control.release());
 const first=await s.infer();
 const pending=s.infer();
 await new Promise(resolve=>setTimeout(resolve,50));
 const active=await(await s.admin('/state')).json();
 assert.equal(active.history.length,2);assert.ok(active.history.every((row:any)=>row.status===102));
 assert.ok(active.history.some((row:any)=>row.details.state==='running'));assert.ok(active.history.some((row:any)=>row.details.state==='queued'));
 assert.ok(active.history.some((row:any)=>row.details.state==='running'&&row.details.responseBytes>0));
 s.control.hold=false;s.control.release();await first.text();
 const second=await pending;await second.text();
 const finished=await(await s.admin('/state')).json();
 assert.equal(finished.history.length,2);assert.ok(finished.history.every((row:any)=>row.status===200&&row.details.state==='finished'));
 assert.ok(finished.history.some((row:any)=>row.details.queueMs>0));
});

test('request settings expose defaults, validate atomically, and enforce input and output limits', async t => {
 const s=await setup(t);
 const state=await(await s.admin('/state')).json();
 assert.equal(state.settings.queueWaitSeconds,180);
 assert.equal(state.settings.concurrentRequestsPerAccount,1);
 for(const [key,limit] of Object.entries(state.requestLimits) as [string,any][]){
  assert.equal(state.settings[key],limit.default);
  assert.ok(limit.description.length>30);
  for(const invalid of [limit.min-1,limit.max+1,limit.min+0.5,'2',null]){
   const response=await s.admin('/settings','PATCH',{paused:true,[key]:invalid});
   assert.equal(response.status,400,`${key} accepted ${invalid}`);
   assert.equal(s.store.settings().paused,false);
  }
 }
 assert.equal((await s.admin('/settings','PATCH',{maxOutputTokens:1234,maxInputMiB:1})).status,200);
 for(const [path,body,field] of [
  ['/v1/responses',{max_output_tokens:9000},'max_output_tokens'],
  ['/v1/chat/completions',{max_tokens:9000},'max_completion_tokens'],
  ['/v1/messages',{max_tokens:9000},'max_tokens'],
 ] as const){
  const response=await fetch(`${s.base}${path}`,{method:'POST',headers:{Authorization:`Bearer ${s.created.key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'test-model',...body})});
  assert.equal(response.status,200);await response.text();
  assert.equal(s.calls.at(-1).body[field],1234);
 }
 const smaller=await s.infer(undefined,{model:'test-model',max_output_tokens:100});await smaller.text();
 assert.equal(s.calls.at(-1).body.max_output_tokens,100);
 const callsBefore=s.calls.length;
 for(const path of ['/v1/responses','/v1/responses/compact']){
  const response=await fetch(`${s.base}${path}`,{method:'POST',headers:{Authorization:`Bearer ${s.created.key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'test-model',input:'x'.repeat(1024*1024)})});
  assert.equal(response.status,413);await response.text();
 }
 assert.equal(s.calls.length,callsBefore);
});

test('queue controls enforce capacity and wait time, and changing parallelism wakes existing requests',{timeout:5000},async t=>{
 const s=await setup(t);s.control.hold=true;t.after(()=>s.control.release());
 const first=await s.infer();
 await s.admin('/settings','PATCH',{maxQueuedRequests:0});
 const disabled=await s.infer();assert.equal(disabled.status,429);assert.equal((await disabled.json()).error.type,'account_busy');
 await s.admin('/settings','PATCH',{maxQueuedRequests:1,queueWaitSeconds:1});
 const pending=s.infer();
 await new Promise(resolve=>setTimeout(resolve,50));
 const full=await s.infer();assert.equal(full.status,429);assert.match((await full.json()).error.message,/queue is full/);
 const timedOut=await pending;assert.equal(timedOut.status,429);assert.match((await timedOut.json()).error.message,/still handling/);
 await s.admin('/settings','PATCH',{queueWaitSeconds:180});
 const next=s.infer();await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(s.calls.length,1);
 await s.admin('/settings','PATCH',{concurrentRequestsPerAccount:2});
 const second=await next;assert.equal(second.status,200);assert.equal(s.calls.length,2);
 s.control.hold=false;s.control.release();await Promise.all([first.text(),second.text()]);
});

test('parallel requests retain independent cancellation and release only their own account slots',{timeout:5000},async t=>{
 const s=await setup(t);s.control.hold=true;t.after(()=>s.control.release());
 await s.admin('/settings','PATCH',{concurrentRequestsPerAccount:2});
 const other=await(await s.admin('/members','POST',{name:'Other',sharePercent:20,fallbackOnly:false})).json();
 const first=await s.infer();const firstReader=first.body!.getReader();await firstReader.read();
 const second=await s.infer(other.key);const secondReader=second.body!.getReader();await secondReader.read();
 const pending=s.infer();await new Promise(resolve=>setTimeout(resolve,50));assert.equal(s.calls.length,2);
 await s.admin(`/members/${s.created.member.id}`,'PATCH',{paused:true});
 await assert.rejects(firstReader.read());
 const denied=await pending;assert.equal(denied.status,403);await denied.text();
 await s.admin(`/members/${s.created.member.id}`,'PATCH',{paused:false});
 const third=await s.infer();const thirdReader=third.body!.getReader();await thirdReader.read();assert.equal(s.calls.length,3);
 s.hub.stopRequests();
 await Promise.all([assert.rejects(secondReader.read()),assert.rejects(thirdReader.read())]);
 const secondEvent=s.store.history().find(row=>row.id===second.headers.get('x-request-id'));
 const thirdEvent=s.store.history().find(row=>row.id===third.headers.get('x-request-id'));
 assert.equal(secondEvent?.reason,'hub_restarting');assert.equal(thirdEvent?.reason,'hub_restarting');
 s.control.hold=false;s.control.release();
 const recovery=await s.infer();assert.equal(recovery.status,200);await recovery.text();
});

test('provider timeout setting reaches the upstream request signal',async t=>{
 const s=await setup(t);
 await s.admin('/settings','PATCH',{providerTimeoutSeconds:45});
 const timeouts:number[]=[];const original=AbortSignal.timeout;
 const mock=t.mock.method(AbortSignal,'timeout',(milliseconds:number)=>{timeouts.push(milliseconds);return original(milliseconds);});
 const response=await s.infer();assert.equal(response.status,200);await response.text();
 mock.mock.restore();assert.ok(timeouts.includes(45000));
});

test('Use mine is scoped, confirmed, persistent, and preserves access controls',async t=>{
 const s=await setup(t),id=s.created.member.id;
 await s.admin(`/members/${id}`,'PATCH',{personalSwitchPercent:40});
 await s.admin('/accounts/owner','PATCH',{accountId:'eligible',memberId:id});
 s.proxy.accounts[0]!.windows[0]!.usedPercent=77;s.proxy.accounts[1]!.windows[0]!.usedPercent=82;
 const login=await fetch(`${s.base}/api/member/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:s.created.key})});
 const {csrf}=await login.json(),cookie=login.headers.get('set-cookie')!.split(';')[0]!;
 const headers={Cookie:cookie,'Content-Type':'application/json','X-CSRF-Token':csrf};
 const routing=(body:unknown,customHeaders=headers)=>fetch(`${s.base}/api/member/routing`,{method:'PATCH',headers:customHeaders,body:JSON.stringify(body)});
 assert.equal((await routing({personalOnly:true,confirmed:true},{...headers,Cookie:''})).status,401);
 assert.equal((await routing({personalOnly:true,confirmed:true},{...headers,'X-CSRF-Token':''})).status,403);
 assert.equal((await routing({personalOnly:true})).status,400);
 assert.equal((await routing({personalOnly:'yes',confirmed:true})).status,400);
 assert.equal((await s.infer()).status,429);
 assert.equal((await routing({personalOnly:true,confirmed:true,sharePercent:100,paused:false})).status,200);
 assert.equal(s.store.member(id).sharePercent,20);
 await s.admin(`/members/${id}`,'PATCH',{rpm:300});
 assert.equal(s.store.member(id).personalOnly,true);
 const view=await(await fetch(`${s.base}/api/member/state`,{headers})).json();
 assert.equal(view.member.personalOnly,true);assert.equal(view.accounts.find((a:any)=>a.personal).switchReached,false);
 let response=await s.infer();assert.equal(response.status,200);await response.text();
 assert.equal(s.calls.at(-1).body.model,'vcp-eligible/test-model');
 // Even available backup cannot be used after a personal provider limit is reached.
 s.proxy.accounts[0]!.windows[0]!.usedPercent=0;s.proxy.accounts[1]!.windows[0]!.usedPercent=100;
 assert.equal((await s.infer()).status,429);assert.equal(s.calls.length,1);
 // The read-only usage integration also reports backup as locked.
 s.proxy.accounts[0]!.windows[0]!.id='primary_window';
 const inventory=await(await fetch(`${s.base}/v0/management/auth-files`,{headers:{Authorization:`Bearer ${s.created.key}`}})).json();
 const quota=await(await fetch(`${s.base}/v0/management/api-call`,{method:'POST',headers:{Authorization:`Bearer ${s.created.key}`,'Content-Type':'application/json'},body:JSON.stringify({method:'GET',url:'https://chatgpt.com/backend-api/wham/usage',auth_index:inventory.files[0].auth_index})})).json();
 assert.equal(JSON.parse(quota.body).rate_limit.primary_window.used_percent,100);
 const other=await(await s.admin('/members','POST',{name:'Other',fallbackOnly:false})).json();
 response=await s.infer(other.key);assert.equal(response.status,200);await response.text();
 assert.equal(s.calls.at(-1).body.model,'vcp-protected/test-model');
 await s.admin(`/members/${id}`,'PATCH',{paused:true});
 assert.equal((await routing({personalOnly:false})).status,403);assert.equal((await s.infer()).status,403);
 await s.admin(`/members/${id}`,'PATCH',{paused:false,allowedModels:['other-model']});
 assert.equal((await s.infer()).status,403);
 await s.admin(`/members/${id}`,'PATCH',{allowedModels:[]});
 assert.equal((await routing({personalOnly:false})).status,200);
 response=await s.infer();assert.equal(response.status,200);await response.text();
 assert.equal(s.calls.at(-1).body.model,'vcp-protected/test-model');
});

test('enabling Use mine stops that member’s shared stream and reroutes queued work to personal quota',{timeout:5000},async t=>{
 const s=await setup(t),id=s.created.member.id;
 s.control.hold=true;t.after(()=>s.control.release());
 await s.admin(`/members/${id}`,'PATCH',{personalSwitchPercent:40});
 await s.admin('/accounts/owner','PATCH',{accountId:'eligible',memberId:id});
 s.proxy.accounts[0]!.windows[0]!.usedPercent=0;s.proxy.accounts[1]!.windows[0]!.usedPercent=82;
 const backup=await s.infer(),stopped=backup.text().catch(()=>{});
 const queued=s.infer();await new Promise(resolve=>setTimeout(resolve,50));
 const response=await fetch(`${s.base}/api/member/routing`,{method:'PATCH',headers:{Authorization:`Bearer ${s.created.key}`,'Content-Type':'application/json','X-CSRF-Token':s.csrf},body:JSON.stringify({personalOnly:true,confirmed:true})});
 assert.equal(response.status,200);await stopped;
 const personal=await queued;assert.equal(personal.status,200);
 assert.equal(s.calls.at(-1).body.model,'vcp-eligible/test-model');
 assert.ok(s.store.history().some(row=>row.account_id==='protected'&&row.reason==='access_changed'));
 s.control.hold=false;s.control.release();await personal.text();
});

test('eight parallel requests share one account and further requests queue',{timeout:5000},async t=>{
 const s=await setup(t);s.control.hold=true;t.after(()=>s.control.release());
 const saved=await s.admin('/settings','PATCH',{concurrentRequestsPerAccount:8,maxOutputTokens:32768});
 assert.equal(saved.status,200);
 const responses=await Promise.all(Array.from({length:8},()=>s.infer(undefined,{model:'test-model',stream:true,max_output_tokens:100000})));
 assert.ok(responses.every(response=>response.status===200));
 assert.equal(s.calls.length,8);
 assert.ok(s.calls.every(call=>call.body.model==='vcp-eligible/test-model'&&call.body.max_output_tokens===32768));
 const pending=s.infer();await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(s.calls.length,8);
 s.control.hold=false;s.control.release();await Promise.all(responses.map(response=>response.text()));
 const ninth=await pending;assert.equal(ninth.status,200);await ninth.text();assert.equal(s.calls.length,9);
});
