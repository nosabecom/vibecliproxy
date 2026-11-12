import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Reviews, openAIClassifier } from '../src/reviews.ts';
import { taskEvidence } from '../src/task-evidence.ts';
import type { ClassifierResult, ReviewRule, TaskClassifier } from '../src/review-types.ts';

function member(store: Store) {
  return store.create({ name:'Nosa',sharePercent:20,paused:false,allowedModels:[],accountIds:[],expiresAt:null,rpm:20,fallbackOnly:true }).member;
}

function jobLike(text: string) {
  return /internship|employment|apply for (?:a )?job|tailor.{0,20}cv|cover letter|recruiter/i.test(text);
}

function deterministicClassifier(calls?: string[]): TaskClassifier {
  return async (text, rules) => {
    calls?.push(text);
    const jobs = jobLike(text);
    return {
      contextProbability: .99,
      inputTokens: 12,
      probabilities: Object.fromEntries(rules.map(rule => [rule.id, rule.action === 'record' && /archive this activity/i.test(text) ? .99 : jobs ? .95 : .05])),
    };
  };
}

function setup(t: Parameters<typeof test>[1] extends (t: infer T, ...args: any[]) => any ? T : never, options: ConstructorParameters<typeof Reviews>[1] = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const reviews = new Reviews(store, options);
  reviews.saveRule({action:'review'}, 'jobs-internships');
  const person = member(store);
  reviews.configure({ enabled:true, mode:'enforce' });
  return { store, reviews, member:person };
}

function evidence(text: string) {
  return taskEvidence({ input:[{ role:'user', content:[{ type:'input_text', text }] }] });
}

async function addRecordRule(reviews: Reviews) {
  return reviews.saveRule({ name:'Record archive activity', description:'Record archive activity without review.', exceptions:'', pauseExamples:[], allowExamples:[], memberIds:[], action:'record', enabled:true });
}

test('deterministic screening holds employment tasks and allows unrelated coding tasks', async t => {
  const calls: string[] = [];
  const { reviews, member } = setup(t, { classifier:deterministicClassifier(calls) });
  const jobs = await reviews.screen(member, evidence('Please apply to this internship.'), 'request-jobs');
  const coding = await reviews.screen(member, evidence('Fix the background job queue.'), 'request-code');
  assert.equal(jobs.blocked, true);
  assert.equal(jobs.source, 'review');
  assert.equal(coding.blocked, false);
  assert.equal(coding.source, 'classifier');
  assert.equal(calls.length, 2);
  assert.deepEqual(reviews.get(jobs.reviewId!).ruleIds, ['jobs-internships']);
});

test('tool observations do not change the full evidence cache key', async t => {
  let calls = 0;
  const classifier: TaskClassifier = async (_text, rules) => {
    calls++;
    return { contextProbability:.99,inputTokens:5,probabilities:Object.fromEntries(rules.map(rule => [rule.id,.05])) };
  };
  const { reviews, member } = setup(t, { classifier });
  const request = (output: string) => taskEvidence({ input:[{ role:'user', content:[{type:'input_text',text:'Fix the parser error.'},{type:'tool_result',tool_call_id:'call_1',content:output}] }] });
  const firstEvidence = request('diagnostic A');
  const secondEvidence = request('diagnostic B');
  assert.equal(firstEvidence.fingerprint, secondEvidence.fingerprint);
  assert.equal(firstEvidence.latestPreview, secondEvidence.latestPreview);
  const first = await reviews.screen(member, firstEvidence, 'tool-a');
  const second = await reviews.screen(member, secondEvidence, 'tool-b');
  assert.equal(first.blocked, false); assert.equal(second.blocked, false);
  assert.equal(second.source, 'cache');
  assert.equal(calls, 1);
  assert.equal(reviews.state().usage.cacheHits, 1);
});

test('changed instructions after the same 600-character preview prefix are reclassified', async t => {
  const calls: string[] = [];
  const { reviews, member } = setup(t, { classifier:deterministicClassifier(calls) });
  const prefix = 'x'.repeat(720);
  const jobEvidence = evidence(`${prefix} Please apply to this internship.`);
  const codingEvidence = evidence(`${prefix} Please fix the parser.`);
  assert.equal(jobEvidence.objectivePreview, codingEvidence.objectivePreview);
  assert.equal(jobEvidence.objectivePreview.length, 600);
  assert.notEqual(jobEvidence.fingerprint, codingEvidence.fingerprint);
  const jobs = await reviews.screen(member, jobEvidence, 'long-jobs');
  const coding = await reviews.screen(member, codingEvidence, 'long-code');
  assert.equal(jobs.blocked, true); assert.equal(coding.blocked, false);
  assert.equal(calls.length, 2);
});

test('standalone continuation warns without blocking; included jobs objectives still match', async t => {
  let calls = 0;
  const classifier: TaskClassifier = async (text, rules) => {
    calls++;
    return { contextProbability:.99,inputTokens:10,probabilities:Object.fromEntries(rules.map(rule => [rule.id,jobLike(text)?.95:.05])) };
  };
  const { reviews, member } = setup(t, { classifier });
  const unknownEvidence = evidence('Go on.');
  assert.equal(unknownEvidence.contextKnown, false);
  const unknown = await reviews.screen(member, unknownEvidence, 'alone');
  assert.equal(unknown.blocked, false); assert.equal(calls, 0);
  assert.equal(unknown.reviewId,undefined);
  assert.doesNotThrow(()=>reviews.claim(member,unknownEvidence,unknown));

  const continuation = taskEvidence({ input:[
    { role:'user', content:'Please apply to this internship.' },
    { role:'assistant', content:[{type:'tool_result',tool_call_id:'call_1',content:'A build step completed.'}] },
    { role:'user', content:'Go on.' },
  ] });
  const held = await reviews.screen(member, continuation, 'continued-job');
  assert.equal(held.blocked, true);
  assert.equal(reviews.get(held.reviewId!).contextKnown, true);
  assert.equal(reviews.get(held.reviewId!).objectivePreview, 'Please apply to this internship.');
  assert.equal(reviews.get(held.reviewId!).latestPreview, 'Go on.');
  assert.equal(calls, 1);
});

test('screening state and decisions survive a Store restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'vibe-reviews-'));
  const path = join(directory, 'reviews.db');
  let store = new Store(path); let reopened: Store | undefined;
  t.after(() => { try { store.close(); } catch {} try { reopened?.close(); } catch {} rmSync(directory,{recursive:true,force:true}); });
  let person = member(store);
  let reviews = new Reviews(store, { classifier:deterministicClassifier() });
  reviews.saveRule({action:'review'}, 'jobs-internships');
  reviews.configure({ enabled:true, mode:'enforce' });
  const rule = reviews.saveRule({ name:'Custom job rule',description:'Employment applications.',exceptions:'',pauseExamples:['Apply now.'],allowExamples:['Fix code.'],memberIds:[],action:'review',enabled:true });
  const held = await reviews.screen(person, evidence('Please apply to this internship.'), 'persisted-review');
  assert.ok(held.reviewId);
  const oldPolicy = reviews.policy(person.id).version;
  store.close();
  reopened = new Store(path); person = reopened.member(person.id); reviews = new Reviews(reopened, { classifier:deterministicClassifier() });
  const state = reviews.state();
  assert.equal(state.settings.enabled, true);
  assert.ok(state.rules.some(item => item.id === rule.id));
  assert.equal(state.items.find(item => item.id === held.reviewId)?.status, 'pending');
  assert.equal(reviews.policy(person.id).version, oldPolicy);
});

test('singleflight shares an in-progress classification for identical evidence', async t => {
  let calls = 0, release!: (result: ClassifierResult) => void;
  const gate = new Promise<ClassifierResult>(resolve => { release = resolve; });
  const classifier: TaskClassifier = async (_text, rules) => {
    calls++;
    return gate.then(result => ({ ...result, probabilities:Object.fromEntries(rules.map(rule => [rule.id,.95])) }));
  };
  const { reviews, member } = setup(t, { classifier });
  const task = evidence('Please apply for a summer internship.');
  const first = reviews.screen(member, task, 'single-a');
  const second = reviews.screen(member, task, 'single-b');
  assert.equal(calls, 1);
  release({ contextProbability:.99,inputTokens:12,probabilities:{} });
  const [a,b] = await Promise.all([first,second]);
  assert.equal(a.reviewId,b.reviewId);
  assert.equal(reviews.state().usage.checks,1);
});

test('concurrent distinct checks reserve budget before awaiting classification', async t => {
  let calls = 0, release!: (result: ClassifierResult) => void;
  const gate = new Promise<ClassifierResult>(resolve => { release = resolve; });
  const classifier: TaskClassifier = async (_text, rules) => {
    calls++;
    return gate.then(result => ({ ...result, probabilities:Object.fromEntries(rules.map(rule => [rule.id,.05])) }));
  };
  const { reviews, member } = setup(t, { classifier });
  reviews.configure({ dailyBudgetUsd:.001 });
  const first = reviews.screen(member, evidence('Fix the small parser issue.'), 'budget-a');
  const second = reviews.screen(member, evidence('Fix the small queue issue.'), 'budget-b');
  assert.equal(calls, 1, 'only one concurrent request should fit the reserved daily budget');
  release({ contextProbability:.99,inputTokens:1,probabilities:{} });
  const results = await Promise.all([first,second]);
  assert.ok(results.some(result => result.reason?.includes('budget is exhausted')));
  assert.equal(reviews.state().usage.checks,1);
});

test('invalid classifier answers warn and allow without inventing a rule violation', async t => {
  const classifier: TaskClassifier = async () => ({ contextProbability:.99,inputTokens:10,probabilities:{} });
  const { reviews, member } = setup(t, { classifier });
  const result = await reviews.screen(member, evidence('Please apply to this internship.'), 'invalid-answers');
  assert.equal(result.blocked,false);
  assert.match(result.reason ?? '',/unavailable|invalid/i);
  assert.equal(result.reviewId,undefined);assert.equal(reviews.state().items.length,0);
  assert.doesNotThrow(()=>reviews.claim(member,evidence('Please apply to this internship.'),result));
});

test('custom rule revisions invalidate old approvals', async t => {
  const { reviews, member } = setup(t, { classifier:deterministicClassifier() });
  const custom = await addRecordRule(reviews);
  const revised = reviews.saveRule({ ...custom, action:'review', description:'Archive or apply to employment tasks.' }, custom.id);
  const oldEvidence = evidence('Please apply to this internship.');
  const prior = await reviews.screen(member, oldEvidence, 'before-revision');
  reviews.decide(prior.reviewId!, { decision:'approve', minutes:30, maxRequests:3 });
  const beforePolicy = prior.policyVersion;
  reviews.saveRule({ ...revised, description:'Updated employment safety rule.' }, revised.id);
  assert.throws(() => reviews.claim(member, oldEvidence, prior), { status:409 });
  const current = await reviews.screen(member, oldEvidence, 'after-revision');
  assert.notEqual(current.policyVersion,beforePolicy);
  assert.equal(current.blocked,true);
  assert.notEqual(current.reviewId,prior.reviewId);
});

test('approval TTL expires and remaining request count is consumed through claim', async t => {
  const { store, reviews, member } = setup(t, { classifier:deterministicClassifier() });
  const firstEvidence = evidence('Please apply to this summer internship.');
  const first = await reviews.screen(member, firstEvidence, 'approval-count');
  reviews.decide(first.reviewId!, { decision:'approve', minutes:30, maxRequests:2 });
  reviews.claim(member,firstEvidence,first);
  reviews.claim(member,firstEvidence,first);
  assert.equal(reviews.get(first.reviewId!).approvalRemaining,0);
  assert.throws(() => reviews.claim(member,firstEvidence,first), { status:403 });

  const expiringEvidence = evidence('Please apply to this different internship.');
  const expiring = await reviews.screen(member,expiringEvidence,'approval-expiry');
  reviews.decide(expiring.reviewId!, { decision:'approve', minutes:30, maxRequests:5 });
  const row = store.db.prepare('SELECT data FROM task_reviews WHERE id=?').get(expiring.reviewId!) as any;
  const review = JSON.parse(row.data); review.approvalExpiresAt = Date.now()-1;
  store.db.prepare('UPDATE task_reviews SET data=? WHERE id=?').run(JSON.stringify(review),expiring.reviewId!);
  assert.throws(() => reviews.claim(member,expiringEvidence,expiring), { status:403 });
  const afterExpiry = await reviews.screen(member,expiringEvidence,'after-expiry');
  assert.equal(afterExpiry.blocked,true);
  assert.equal(reviews.get(expiring.reviewId!).status,'pending');
});

test('observe mode reports matching work without blocking or placing a hold', async t => {
  let holds = 0;
  const { reviews, member } = setup(t, { classifier:deterministicClassifier(), onHold:() => { holds++; } });
  reviews.configure({ mode:'observe' });
  const result = await reviews.screen(member,evidence('Please apply to this internship.'),'observe-job');
  assert.equal(result.blocked,false);
  assert.equal(result.source,'observed');
  assert.equal(holds,0);
  assert.equal(reviews.get(result.reviewId!).status,'pending');
  reviews.decide(result.reviewId!, { decision:'deny' });
  reviews.decide(result.reviewId!, { decision:'reopen' });
  assert.equal(holds,0, 'owner decisions in Observe cannot interrupt inference');
});

test('Anthropic system instructions change identity; hidden context alone never creates a block', async t => {
  const calls: string[] = [];
  const { reviews, member } = setup(t, { classifier:deterministicClassifier(calls) });
  const messages=[{role:'user',content:'Draft the requested document.'}];
  const benign=taskEvidence({system:[{type:'text',text:'Write a project progress summary.'}],messages});
  const jobs=taskEvidence({system:'Write a cover letter for this internship.',messages});
  assert.notEqual(benign.fingerprint,jobs.fingerprint);
  assert.equal((await reviews.screen(member,benign,'system-code')).blocked,false);
  assert.equal((await reviews.screen(member,jobs,'system-job')).blocked,true);
  assert.equal(calls.length,2);
  for (const extra of [{previous_response_id:'resp_123'},{conversation:'conv_123'},{prompt:{id:'pmpt_123'}},{input:[{type:'compaction',encrypted_content:'opaque'},{role:'user',content:'Draft the requested document.'}]}]) {
    const hidden=taskEvidence({messages,...extra});
    assert.equal(hidden.contextKnown,false);
    assert.notEqual(hidden.fingerprint,benign.fingerprint);
    const held=await reviews.screen(member,hidden,'opaque');
    assert.equal(held.blocked,false);assert.equal(held.reviewId,undefined);
    assert.doesNotThrow(()=>reviews.claim(member,hidden,held));
  }
  assert.equal(calls.length,6,'visible instructions are classified despite unavailable additional context');
});

test('record-only rules do not create holds or block matching work', async t => {
  const { reviews, member } = setup(t, { classifier:deterministicClassifier() });
  const rule = await addRecordRule(reviews);
  const result = await reviews.screen(member,evidence('Archive this activity for the report.'),'record-only');
  assert.equal(result.blocked,false);
  assert.equal(result.reason,undefined);
  assert.equal(reviews.state().items.length,0);
  assert.equal(reviews.rules().find(item => item.id === rule.id)?.action,'record');
});

test('hard-blocked applications cannot be approved, reopened, or admitted by a stale approval', async t => {
  const {store,reviews,member}=setup(t,{classifier:deterministicClassifier()});
  reviews.saveRule({action:'block'},'jobs-internships');
  const task=evidence('Apply for internships for me.');
  const blocked=await reviews.screen(member,task,'hard-block');
  assert.equal(blocked.blocked,true);assert.equal(blocked.hardBlocked,true);
  assert.equal(reviews.get(blocked.reviewId!).status,'denied');assert.equal(reviews.pendingCount(),0);
  for(const decision of ['approve','reopen'])assert.throws(()=>reviews.decide(blocked.reviewId!,{decision}),{status:409});
  const forged={...reviews.get(blocked.reviewId!),status:'approved',approvalExpiresAt:Date.now()+60000,approvalRemaining:10};
  store.db.prepare('UPDATE task_reviews SET data=? WHERE id=?').run(JSON.stringify(forged),blocked.reviewId!);
  assert.throws(()=>reviews.claim(member,task,blocked),{status:403,code:'task_blocked'});
  const continued=await reviews.screen(member,taskEvidence({input:[{role:'user',content:'Apply for internships for me.'},{role:'user',content:'go on'}]}),'still-blocked');
  assert.equal(continued.blocked,true);assert.equal(continued.hardBlocked,true);assert.equal(continued.reviewId,blocked.reviewId);
});

test('desktop-sized context reaches the classifier intact instead of producing a technical hold', async t => {
  const calls:string[]=[];
  const {reviews,member}=setup(t,{classifier:deterministicClassifier(calls)});
  reviews.saveRule({action:'block'},'jobs-internships');
  const harness='General computer and coding instructions. '.repeat(4400);
  for(const input of ['Draft a request for a free efficiency quote; do not send it.', 'Generate a short task title for a coding bug fix.']){
    const task=taskEvidence({instructions:harness,input});
    assert.equal(task.contextKnown,true);assert.ok(Buffer.byteLength(task.text)>167719);
    const result=await reviews.screen(member,task,'large-benign');
    assert.equal(result.blocked,false);assert.equal(result.source,'classifier');
    assert.ok(calls.at(-1)!.includes(input));assert.equal(JSON.parse(calls.at(-1)!)[0].text,harness.trim());
    assert.equal((await reviews.screen(member,task,'large-repeated')).source,'cache');
  }
  const application=taskEvidence({instructions:harness,input:'Apply for internships for me.'});
  const blocked=await reviews.screen(member,application,'large-application');
  assert.equal(blocked.blocked,true);assert.equal(blocked.hardBlocked,true);
  assert.equal(calls.length,3);assert.equal(reviews.pendingCount(),0);
});

test('long-context usage uses the documented higher rate and reserves it before concurrent checks', async t => {
  const {reviews,member}=setup(t,{classifier:async(_text,rules)=>({inputTokens:300000,contextProbability:1,probabilities:Object.fromEntries(rules.map(r=>[r.id,0]))})});
  const task=taskEvidence({instructions:'General guidance. '.repeat(20000),input:'Draft a free quote request.'});
  assert.equal(task.contextKnown,true);
  const result=await reviews.screen(member,task,'long-tier');assert.equal(result.blocked,false);
  assert.ok(Math.abs(reviews.state().usage.todayUsd-.06)<1e-9);
  reviews.configure({dailyBudgetUsd:.07});
  const over=await reviews.screen(member,taskEvidence({instructions:'General guidance. '.repeat(20000),input:'Draft another free quote request.'}),'long-budget');
  assert.equal(over.blocked,false);assert.equal(over.reviewId,undefined);assert.match(over.reason??'',/budget/);
});

test('multi-megabyte instructions use a token estimate, keep the full objective, and reuse the cache', async t => {
  let counts=0,calls=0;
  const classifier:TaskClassifier=async(text,rules)=>{calls++;return{inputTokens:200000,contextProbability:1,probabilities:Object.fromEntries(rules.map(r=>[r.id,text.includes('Apply for internships')?1:0]))};};
  classifier.estimateInputTokens=async(text)=>{counts++;assert.ok(Buffer.byteLength(text)>1_000_000);return 204096;};
  const {reviews,member}=setup(t,{classifier});reviews.saveRule({action:'block'},'jobs-internships');
  const instructions='General coding guidance. '.repeat(70000);
  const benign=taskEvidence({instructions,input:'Draft a free quote request.'});
  assert.equal(benign.contextKnown,true);assert.equal((await reviews.screen(member,benign,'large-count')).blocked,false);
  assert.equal((await reviews.screen(member,benign,'large-cache')).source,'cache');assert.equal(counts,1);assert.equal(calls,1);
  const blocked=await reviews.screen(member,taskEvidence({instructions,input:'Apply for internships for me.'}),'large-new-objective');
  assert.equal(blocked.hardBlocked,true);assert.equal(blocked.blocked,true);assert.equal(counts,2);assert.equal(calls,2);
});

test('requests beyond the model token window never make a paid classification call', async t => {
  let calls=0;const classifier:TaskClassifier=async()=>{calls++;throw new Error('Must not classify');};classifier.estimateInputTokens=async()=>1000001;
  const {reviews,member}=setup(t,{classifier});const result=await reviews.screen(member,taskEvidence({instructions:'Guidance. '.repeat(150000),input:'Draft a quote.'}),'too-many-tokens');
  assert.equal(result.blocked,false);assert.equal(result.reviewId,undefined);assert.match(result.reason??'',/model context window/);assert.equal(calls,0);assert.equal(reviews.state().usage.checks,0);
});

test('concurrent token preflights re-read the budget before reserving paid work', async t => {
  let calls=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  const classifier:TaskClassifier=async(_text,rules)=>{calls++;await gate;return{inputTokens:200000,contextProbability:1,probabilities:Object.fromEntries(rules.map(r=>[r.id,0]))};};
  classifier.estimateInputTokens=async()=>200000;
  const {reviews,member}=setup(t,{classifier});reviews.configure({dailyBudgetUsd:.04});
  const requests=['Draft a quote.','Draft a report.'].map(input=>reviews.screen(member,taskEvidence({instructions:'General guidance. '.repeat(80000),input}),input));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);release();
  const results=await Promise.all(requests);assert.ok(results.some(r=>r.reason?.includes('budget')));assert.equal(reviews.state().usage.checks,1);
});

test('OpenAI token preflight includes all rules and evidence and validates the returned count', async t => {
  let request:any;let responseCount=200000;
  t.mock.method(globalThis,'fetch',async(url:any,init:any)=>{assert.equal(url,'https://api.openai.com/v1/responses/input_tokens');assert.equal(init.redirect,'error');request=JSON.parse(init.body);return new Response(JSON.stringify({input_tokens:responseCount}));});
  const {reviews}=setup(t);const classifier=openAIClassifier('test-api-key');
  const estimate=await classifier.estimateInputTokens!('Complete visible evidence',reviews.rules(),AbortSignal.timeout(1000));
  assert.equal(estimate,204096);assert.equal(request.model,'gpt-6-luna');assert.equal(request.input[0].content[0].text,'Complete visible evidence');
  for(const rule of reviews.rules())assert.ok(request.instructions.includes(rule.description));
  responseCount=-1;await assert.rejects(()=>classifier.estimateInputTokens!('Evidence',reviews.rules(),AbortSignal.timeout(1000)),/Invalid screening token count/);
});

test('attachments, plumbing replies, and continuations are classified from visible intent without blanket holds', async t => {
  const calls:string[]=[];const {reviews,member}=setup(t,{classifier:deterministicClassifier(calls)});
  reviews.saveRule({action:'block'},'jobs-internships');
  const photo={role:'user',content:[{type:'input_text',text:'We found a leak this morning. Draft a plumbing quote request; do not send.'},{type:'input_image',image_url:'data:image/jpeg;base64,test'}]};
  const reply={role:'user',content:'<send_user_message_question_reply>[{"question":"Which repair job needs a quote?","answer":"plumbing"}]</send_user_message_question_reply>'};
  for(const input of [[photo],[photo,reply],[photo,reply,{role:'user',content:'continue'}]]){
    const task=taskEvidence({input});assert.equal(task.contextKnown,false);assert.equal(task.screenable,true);
    const result=await reviews.screen(member,task,'plumbing');assert.equal(result.blocked,false);assert.equal(result.reviewId,undefined);
    assert.doesNotThrow(()=>reviews.claim(member,task,result));
  }
  assert.equal(reviews.state().items.length,0);assert.ok(calls.length>=2);
  const jobTask=taskEvidence({input:[{role:'user',content:[{type:'input_text',text:'Apply for internships for me.'},{type:'input_image',image_url:'data:image/jpeg;base64,test'}]},{role:'user',content:'continue'}]});
  const blocked=await reviews.screen(member,jobTask,'application-with-photo');assert.equal(blocked.blocked,true);assert.equal(blocked.hardBlocked,true);
});

test('non-matching uncertainty and classifier outages never create holds or cancel active work',async t=>{
  let holds=0;const {reviews,member}=setup(t,{classifier:async(_text,rules)=>({inputTokens:10,contextProbability:.01,probabilities:Object.fromEntries(rules.map(r=>[r.id,.01]))}),onHold:()=>holds++});
  for(const task of [evidence('Look at this.'),taskEvidence({input:[{role:'user',content:[{type:'input_image',image_url:'image'}]}]}),taskEvidence({input:'Draft a quote.',previous_response_id:'hidden'})]){
    const result=await reviews.screen(member,task,'uncertain');assert.equal(result.blocked,false);assert.equal(result.reviewId,undefined);assert.doesNotThrow(()=>reviews.claim(member,task,result));
  }
  reviews.classifier=async()=>{throw new Error('Provider offline');};
  const failed=await reviews.screen(member,evidence('Draft another quote.'),'outage');assert.equal(failed.blocked,false);assert.match(failed.reason??'',/unavailable/);
  reviews.classifier=undefined;
  const missing=await reviews.screen(member,evidence('Draft a third quote.'),'no-key');assert.equal(missing.blocked,false);assert.match(missing.reason??'',/not configured/);
  assert.equal(holds,0);assert.equal(reviews.state().items.length,0);
});

test('memory limits and zero budgets warn without creating policy blocks',async t=>{
  let calls=0;const {reviews,member}=setup(t,{classifier:async()=>{calls++;throw new Error('Must not classify');}});
  reviews.configure({dailyBudgetUsd:0,monthlyBudgetUsd:0});
  for(const task of [evidence('Draft a quote.'),taskEvidence({instructions:'x'.repeat(8*1024*1024+1),input:'Draft a quote.'}),taskEvidence({input:Array.from({length:10001},()=>({role:'user',content:'Draft a quote.'}))})]){
    const result=await reviews.screen(member,task,'technical-limit');assert.equal(result.blocked,false);assert.equal(result.reviewId,undefined);assert.doesNotThrow(()=>reviews.claim(member,task,result));
  }
  assert.equal(calls,0);assert.equal(reviews.state().items.length,0);
});
