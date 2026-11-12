// Isolated deployment smoke test. Uses a fake provider/classifier and a fresh
// private CODEX_HOME; never reads a friend's key or spends subscription quota.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHub } from '../dist/server.js';
import { Store } from '../dist/store.js';
import { CliProxy } from '../dist/cliproxy.js';
import { hashPassword } from '../dist/auth.js';

const keyFlag = process.argv.indexOf('--decisions-key-file');
if (keyFlag >= 0 && !process.argv[keyFlag+1]) throw new Error('A private API key file is required');
const decisionsApiKey = keyFlag < 0 ? undefined : (await readFile(process.argv[keyFlag+1]!, 'utf8')).trim();
if (keyFlag >= 0 && !decisionsApiKey) throw new Error('API key file is empty');
const directory=await mkdtemp(join(tmpdir(),'vibe-review-verification-'));
let forwarded=0,checks=0;
const upstream=createServer(async(req,res)=>{
 for await(const _chunk of req){} forwarded++;
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 const part={type:'output_text',text:'OK',annotations:[]};
 const message={id:'msg_verify',type:'message',status:'completed',role:'assistant',content:[part]};
 const response={id:'resp_verify',object:'response',created_at:Math.floor(Date.now()/1000),status:'completed',model:'test-model',output:[message],usage:{input_tokens:1,output_tokens:1,total_tokens:2}};
 for(const item of [
  {type:'response.created',response:{...response,status:'in_progress',output:[]}},
  {type:'response.output_item.added',output_index:0,item:{...message,status:'in_progress',content:[]}},
  {type:'response.content_part.added',item_id:message.id,output_index:0,content_index:0,part:{...part,text:''}},
  {type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:'OK'},
  {type:'response.output_text.done',item_id:message.id,output_index:0,content_index:0,text:'OK'},
  {type:'response.content_part.done',item_id:message.id,output_index:0,content_index:0,part},
  {type:'response.output_item.done',output_index:0,item:message},
  {type:'response.completed',response}
 ])res.write(`data: ${JSON.stringify(item)}\n\n`);
 res.end();
});
upstream.listen(0,'127.0.0.1');await once(upstream,'listening');
const upstreamUrl=`http://127.0.0.1:${(upstream.address() as any).port}`;
const store=new Store(join(directory,'verification.db'));
const proxy=new CliProxy({url:upstreamUrl,apiKey:'verification',managementKey:'verification'},store);
proxy.lastSync=Date.now();proxy.accounts=[{id:'verification',name:'verification',email:'verification@example.invalid',provider:'codex',prefix:'verification',ownerMemberId:null,enabled:true,available:true,checkedAt:Date.now(),models:['test-model'],windows:[{id:'weekly',label:'Weekly',usedPercent:0,resetsAt:Date.now()+86400000}]}];
const config={host:'127.0.0.1',port:0,dataPath:':memory:',publicOrigin:'http://localhost',basePath:'/cliproxy',adminPasswordHash:await hashPassword('isolated verification password'),proxyUrl:upstreamUrl,proxyKey:'verification',managementKey:'verification'};
const hub=createHub({...config,decisionsApiKey},{store,proxy,...(decisionsApiKey ? {} : {classifier:async(text:string,rules:import('../src/review-types.ts').ReviewRule[])=>{checks++;return {contextProbability:1,inputTokens:50,probabilities:Object.fromEntries(rules.map(rule=>[rule.id,/Find internships|Apply for internships/i.test(text) ? .99 : .01]))};}})});
hub.server.listen(0,'127.0.0.1');await once(hub.server,'listening');
config.publicOrigin=`http://127.0.0.1:${(hub.server.address() as any).port}`;
const base=`${config.publicOrigin}/cliproxy`;
const member=store.create({name:'Isolated verification',sharePercent:20,paused:false,allowedModels:[],accountIds:[],expiresAt:null,rpm:100,fallbackOnly:false});
hub.reviews.configure({enabled:true,mode:'enforce'});
const infer=(input:any)=>fetch(`${base}/v1/responses`,{method:'POST',headers:{Authorization:`Bearer ${member.key}`,'Content-Type':'application/json'},body:JSON.stringify({model:'test-model',input})});
async function codex(prompt:string) {
 const codexHome=join(directory,'codex-home');await mkdir(codexHome,{mode:0o700,recursive:true});
 await writeFile(join(codexHome,'config.toml'),`model = "test-model"\nmodel_provider = "vibe-verification"\n[model_providers.vibe-verification]\nname = "Isolated Vibe verification"\nbase_url = "${base}/v1"\nenv_key = "VIBE_VERIFY_KEY"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n`,{mode:0o600});
 return await new Promise<{code:number|null,output:string}>((resolve,reject)=>{
  const child=spawn('codex',['exec','--skip-git-repo-check','--json','--color','never','-'],{cwd:directory,env:{...process.env,CODEX_HOME:codexHome,VIBE_VERIFY_KEY:member.key},stdio:['pipe','pipe','pipe']});
  let output='';const timer=setTimeout(()=>child.kill('SIGTERM'),45000);
  child.stdout.on('data',chunk=>{if(output.length<100000)output+=chunk;});child.stderr.on('data',chunk=>{if(output.length<100000)output+=chunk;});
  child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);resolve({code,output:output.replaceAll(member.key,'[redacted]')});});child.stdin.end(prompt);
 });
}
try {
 const hard=await infer('Apply for internships');assert.equal(hard.status,403);assert.equal((await hard.json()).error.type,'task_blocked');assert.equal(forwarded,0);
 const denied=hub.reviews.state().items[0]!;assert.equal(denied.hardBlocked,true);assert.equal(denied.status,'denied');assert.throws(()=>hub.reviews.decide(denied.id,{decision:'approve'}),{status:409});
 hub.reviews.saveRule({action:'review'}, 'jobs-internships');
 const first=await infer('Apply for internships');assert.equal(first.status,403);assert.equal(forwarded,0);
 const held=hub.reviews.state().items[0]!;hub.reviews.decide(held.id,{decision:'approve',minutes:1,maxRequests:1});
 const approved=await infer([{role:'user',content:'Apply for internships'},{role:'user',content:'go on'}]);assert.equal(approved.status,200);await approved.text();assert.equal(forwarded,1);
 assert.equal((await infer('Apply for internships')).status,403);assert.equal(forwarded,1);
 const unknown=await infer('go on');assert.equal(unknown.status,200);await unknown.text();assert.equal(forwarded,2);
 const benign=await infer('Reply with OK only');assert.equal(benign.status,200);await benign.text();
 const checksBefore=hub.reviews.state().usage.checks;const cached=await infer('Reply with OK only');assert.equal(cached.status,200);await cached.text();assert.equal(hub.reviews.state().usage.checks,checksBefore);
 const sw=await fetch(`${base}/sw.js`);assert.equal(sw.status,200);
 let codexResult='not requested';
 if(process.argv.includes('--codex')){
  const before=forwarded;const blocked=await codex('Find internships and apply for them.');
  assert.notEqual(blocked.code,0);assert.equal(forwarded,before);assert.ok(store.history().some((event:any)=>event.reason==='task_review_required'));
  const allowed=await codex('Reply with exactly OK. Do not use tools.');
  if(allowed.code!==0)throw new Error(`Benign Codex verification failed: ${allowed.output.slice(-3000)}`);
  assert.ok(forwarded>before);assert.match(allowed.output,/OK/);codexResult='blocked job request before provider, accepted benign request through isolated config.toml';
 }
 console.log(JSON.stringify({verification:'passed',provider:'mock only; no real model quota spent',classifier:decisionsApiKey?'OpenAI Decisions':'mock',checks:hub.reviews.state().usage.checks,estimatedClassifierUsd:hub.reviews.state().usage.monthUsd,forwarded,hardBlock:true,scopedApproval:true,continuation:true,unknownContextAllowedWithWarning:true,cacheReused:true,serviceWorker:true,codex:codexResult}));
}finally{
 hub.stopRequests();await hub.close();hub.server.closeAllConnections();await new Promise<void>(resolve=>hub.server.close(()=>resolve()));upstream.closeAllConnections();await new Promise<void>(resolve=>upstream.close(()=>resolve()));store.close();await rm(directory,{recursive:true,force:true});
}
