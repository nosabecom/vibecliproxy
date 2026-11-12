import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHub } from '../src/server.ts';
import { Store } from '../src/store.ts';
import { CliProxy } from '../src/cliproxy.ts';
import { hashPassword } from '../src/auth.ts';
import type { Account } from '../src/types.ts';
import type { TaskClassifier } from '../src/review-types.ts';

const password = 'review integration test password';
const passwordHash = await hashPassword(password);
async function setup(t: any, hanging = false, override?: TaskClassifier) {
  const calls: any[] = []; let checks=0;
  const openResponses = new Set<import('node:http').ServerResponse>();
  const upstream=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;calls.push(JSON.parse(text));res.writeHead(200,{'Content-Type':'text/event-stream'});if(hanging){openResponses.add(res);res.write('data: {"type":"response.created"}\n\n');}else res.end('data: {"type":"response.completed"}\n\n');});
  upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
  const proxyUrl=`http://127.0.0.1:${(upstream.address() as any).port}`;
  const store=new Store(':memory:');
  const proxy=new CliProxy({url:proxyUrl,apiKey:'test',managementKey:'test'},store);
  const account:Account={id:'owner',name:'owner',email:'owner@example.invalid',provider:'codex',prefix:'owner',enabled:true,available:true,checkedAt:Date.now(),windows:[{id:'weekly',label:'Weekly',usedPercent:1,resetsAt:Date.now()+86400000}],models:['test-model'],ownerMemberId:null};
  proxy.accounts=[account];proxy.lastSync=Date.now();
  const classifier:TaskClassifier=async(text,rules,signal)=>{checks++;if(override)return override(text,rules,signal);return {inputTokens:100,contextProbability:1,probabilities:Object.fromEntries(rules.map(r=>[r.id,/internship|apply for jobs/i.test(text)? .99:.01]))};};
  const config={host:'127.0.0.1',port:0,dataPath:':memory:',publicOrigin:'http://localhost',basePath:'/cliproxy',adminPasswordHash:passwordHash,proxyUrl,proxyKey:'test',managementKey:'test'};
  const hub=createHub(config,{store,proxy,classifier});
  hub.server.listen(0,'127.0.0.1');await once(hub.server,'listening');
  const origin=`http://127.0.0.1:${(hub.server.address() as any).port}`;config.publicOrigin=origin;const base=`${origin}/cliproxy`;
  const login=await fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
  const session=await login.json();const cookie=login.headers.get('set-cookie')!.split(';')[0]!;
  const admin=(path:string,method='GET',body?:unknown)=>fetch(`${base}/api${path}`,{method,headers:{Cookie:cookie,'X-CSRF-Token':session.csrf,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const created=await(await admin('/members','POST',{name:'Sam',fallbackOnly:false,sharePercent:20,rpm:6000})).json();
  const infer=(body:any,path='/v1/responses')=>fetch(`${base}${path}`,{method:'POST',headers:{Authorization:`Bearer ${created.key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'test-model',...body})});
  await admin('/review-rules/jobs-internships','PATCH',{action:'review'});
  await admin('/review-settings','PATCH',{enabled:true,mode:'enforce'});
  t.after(async()=>{hub.stopRequests();await hub.close();hub.server.closeAllConnections();await new Promise<void>(resolve=>hub.server.close(()=>resolve()));upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));store.close();});
  return {hub,store,proxy,base,admin,created,infer,calls,checks:()=>checks,finish:()=>{for(const res of openResponses)res.end('data: {"type":"response.completed"}\n\n');openResponses.clear();}};
}

test('screening holds before forwarding, groups continuations, and consumes scoped approval once',async t=>{
 const s=await setup(t);const objective='Apply for internships using my CV';
 const blocked=await s.infer({input:objective});assert.equal(blocked.status,403);assert.equal(s.calls.length,0);
 const id=blocked.headers.get('x-request-id');assert.ok(id);
 let state=await(await s.admin('/state')).json();const review=state.reviews.items[0];
 assert.equal(review.status,'pending');assert.equal(state.history[0].details.reviewId,review.id);
 assert.equal((await s.admin(`/reviews/${review.id}/decision`,'POST',{decision:'approve',minutes:30,maxRequests:1})).status,200);
 const continuation={input:[{role:'user',content:objective},{role:'user',content:'go on'}]};
 const allowed=await s.infer(continuation);assert.equal(allowed.status,200);await allowed.text();assert.equal(s.calls.length,1);
 const exhausted=await s.infer(continuation);assert.equal(exhausted.status,403);assert.equal(s.calls.length,1);
 state=await(await s.admin('/state')).json();assert.equal(state.reviews.items.length,1);assert.equal(state.reviews.items[0].status,'pending');assert.equal(state.reviews.decisions[0].status,'approved');
 assert.equal(s.checks(),1);
});

test('a benign alternate field cannot hide a prohibited Messages request and all endpoints are guarded',async t=>{
 const s=await setup(t);
 for(const path of ['/v1/responses','/v1/responses/compact','/v1/chat/completions','/v1/messages','/v1/messages/count_tokens']){
  const response=await s.infer({input:'Fix my code',messages:[{role:'user',content:'Apply for jobs and internships'}]},path);
  assert.equal(response.status,403,path);
 }
 assert.equal(s.calls.length,0);
});

test('personal routes remain usable while owner review and per-person backup pause prevent fallback',async t=>{
 const s=await setup(t);s.proxy.accounts.push({...s.proxy.accounts[0]!,id:'personal',prefix:'personal',ownerMemberId:s.created.member.id});
 const personal=await s.infer({input:'Apply for internships'});assert.equal(personal.status,200);await personal.text();assert.equal(s.calls[0].model,'personal/test-model');assert.equal(s.checks(),0);
 await s.admin(`/members/${s.created.member.id}`,'PATCH',{backupPaused:true,personalSwitchPercent:5});
 s.proxy.accounts[1]!.windows=[{id:'weekly',label:'Weekly',usedPercent:80,resetsAt:Date.now()+86400000}];
 const stillPersonal=await s.infer({input:'Fix a background job queue'});assert.equal(stillPersonal.status,200);await stillPersonal.text();
 s.proxy.accounts[1]!.windows[0]!.usedPercent=100;
 assert.equal((await s.infer({input:'Fix a background job queue'})).status,403);
});

test('only owner sessions can manage review rules, approvals, settings and push subscriptions',async t=>{
 const s=await setup(t);
 for(const path of ['/reviews','/review-settings','/review-rules','/notifications','/notifications/subscriptions','/notifications/test']){
  const response=await fetch(`${s.base}/api${path}`,{method:'POST',headers:{Authorization:`Bearer ${s.created.key}`,'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,401,path);
 }
 await s.infer({input:'Apply for internships'});
 const memberResponse=await fetch(`${s.base}/api/member/state`,{headers:{Authorization:`Bearer ${s.created.key}`}});
 const raw=await memberResponse.text();assert.ok(!raw.includes('objectivePreview'));assert.ok(!raw.includes('fingerprint'));assert.ok(!raw.includes('ruleNames'));
 const member=JSON.parse(raw);assert.equal(member.reviewStatus.pendingCount,1);
 assert.equal((await s.admin('/notifications/test','POST',{})).status,400);
 const sw=await fetch(`${s.base}/sw.js`);assert.equal(sw.status,200);assert.equal(sw.headers.get('service-worker-allowed'),'/cliproxy/');
});

test('parallel continuations cannot exceed approval count or corrupt account slots',async t=>{
 const s=await setup(t);await s.admin('/settings','PATCH',{concurrentRequestsPerAccount:8});
 await s.infer({input:'Apply for internships'});const review=s.hub.reviews.state().items[0]!;
 await s.admin(`/reviews/${review.id}/decision`,'POST',{decision:'approve',minutes:30,maxRequests:2});
 const responses=await Promise.all(Array.from({length:6},()=>s.infer({input:'Apply for internships'})));
 assert.equal(responses.filter(r=>r.status===200).length,2);assert.equal(responses.filter(r=>r.status===403).length,4);for(const r of responses)await r.text();assert.equal(s.calls.length,2);
 const next=await s.infer({input:'Write a hello world program'});assert.equal(next.status,200);await next.text();
});

test('editing rules and deciding Observe reviews preserves live shared responses',async t=>{
 for(const enabled of [false,true]){
  const s=await setup(t,true);
  await s.admin('/review-settings','PATCH',{enabled,mode:'observe'});
  const response=await s.infer({input:'Apply for internships'});
  const completion=response.text();
  await s.admin('/review-rules/jobs-internships','PATCH',{name:'Employment review'});
  if(enabled){
   const review=s.hub.reviews.state().items[0]!;
   await s.admin(`/reviews/${review.id}/decision`,'POST',{decision:'deny'});
   await s.admin(`/reviews/${review.id}/decision`,'POST',{decision:'reopen'});
  }
  s.finish();assert.match(await completion,/response.completed/);
 }
});

test('pausing backup does not interrupt an active personal-account response',async t=>{
 const s=await setup(t,true);s.proxy.accounts.push({...s.proxy.accounts[0]!,id:'personal',prefix:'personal',ownerMemberId:s.created.member.id});
 const response=await s.infer({input:'Apply for internships'});const completion=response.text();
 await s.admin(`/members/${s.created.member.id}`,'PATCH',{backupPaused:true});
 s.finish();assert.match(await completion,/response.completed/);assert.equal(s.calls[0].model,'personal/test-model');
});

test('hard-blocked applications return a final denial while career advice can use shared backup',async t=>{
 const s=await setup(t);
 await s.admin('/review-rules/jobs-internships','PATCH',{action:'block'});
 const blocked=await s.infer({input:'Apply for internships on my behalf'});
 assert.equal(blocked.status,403);const error=await blocked.json();assert.equal(error.error.type,'task_blocked');assert.ok(!error.error.message.includes('until the owner decides'));assert.equal(s.calls.length,0);
 const review=s.hub.reviews.state().items[0]!;assert.equal(review.status,'denied');assert.equal(review.hardBlocked,true);
 for(const decision of ['approve','reopen'])assert.equal((await s.admin(`/reviews/${review.id}/decision`,'POST',{decision})).status,409);
 const advice=await s.infer({input:'What career path should I choose?'});assert.equal(advice.status,200);await advice.text();assert.equal(s.calls.length,1);
});

test('large desktop instructions do not block quote drafts or title generation before classification',async t=>{
 const s=await setup(t);await s.admin('/review-rules/jobs-internships','PATCH',{action:'block'});
 const instructions='General coding and computer guidance. '.repeat(5000);
 for(const input of ['Draft a free quote request. Do not send it.','Generate a short task title for a coding bug fix.']){
  const response=await s.infer({instructions,input});assert.equal(response.status,200);await response.text();
  assert.equal(s.calls.at(-1).instructions,instructions);
 }
 assert.equal(s.checks(),2);assert.equal(s.hub.reviews.pendingCount(),0);
 const blocked=await s.infer({instructions,input:'Apply for internships for me'});assert.equal(blocked.status,403);assert.equal((await blocked.json()).error.type,'task_blocked');assert.equal(s.calls.length,2);
});

test('photo tasks, plumbing replies, and continue pass through shared routing while application continuations stop',async t=>{
 const s=await setup(t);await s.admin('/review-rules/jobs-internships','PATCH',{action:'block'});
 const photo={role:'user',content:[{type:'input_text',text:'Draft a plumbing repair quote request. Do not send it.'},{type:'input_image',image_url:'data:image/jpeg;base64,test'}]};
 const reply={role:'user',content:'<send_user_message_question_reply>[{"question":"Which job?","answer":"plumbing"}]</send_user_message_question_reply>'};
 for(const input of [[photo],[photo,reply],[photo,reply,{role:'user',content:'continue'}]]){
  const r=await s.infer({input});assert.equal(r.status,200);await r.text();
 }
 assert.equal(s.calls.length,3);assert.equal(s.hub.reviews.pendingCount(),0);
 const blocked=await s.infer({input:[{role:'user',content:[{type:'input_text',text:'Apply for internships for me.'},{type:'input_image',image_url:'image'}]},{role:'user',content:'continue'}]});
 assert.equal(blocked.status,403);assert.equal((await blocked.json()).error.type,'task_blocked');assert.equal(s.calls.length,3);
});

test('classifier errors, ambiguity, and exhausted screening budgets cannot stop inference without a match',async t=>{
 for(const scenario of ['error','invalid','uncertain','budget']){
  const s=await setup(t,false,async(_text,rules)=>{if(scenario==='error')throw new Error('Provider offline');return{inputTokens:10,contextProbability:.01,probabilities:scenario==='invalid'?{}:Object.fromEntries(rules.map(r=>[r.id,.01]))};});
  if(scenario==='budget')await s.admin('/review-settings','PATCH',{dailyBudgetUsd:0});
  const response=await s.infer({input:'Draft a plumbing quote request.'});assert.equal(response.status,200,scenario);await response.text();
  assert.equal(s.calls.length,1);assert.equal(s.hub.reviews.state().items.length,0);
  assert.equal(s.store.history()[0]!.status,200);assert.match(s.store.history()[0]!.details!.screening??'',/observed/);
 }
});

test('personal routes skip even a broken classifier; disabling backup preserves personal access and prevents fallback',async t=>{
 const s=await setup(t,false,async()=>{throw new Error('Must not classify a personal route');});
 s.proxy.accounts.push({...s.proxy.accounts[0]!,id:'personal',prefix:'personal',ownerMemberId:s.created.member.id});
 await s.admin(`/members/${s.created.member.id}`,'PATCH',{backupPaused:true});
 const r=await s.infer({input:'Apply for internships for me.'});assert.equal(r.status,200);await r.text();assert.equal(s.checks(),0);assert.equal(s.calls[0].model,'personal/test-model');
});
