import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { activityQuery } from '../src/activity.ts';
import type { RequestDetails } from '../src/types.ts';

test('activity filters the retained history before pagination and keeps pages stable as requests arrive', t => {
 const store = new Store(':memory:');t.after(()=>store.close());
 const member = store.create({name:'Friend',sharePercent:20,paused:false,allowedModels:[],accountIds:[],expiresAt:null,rpm:20,fallbackOnly:true}).member;
 const details: RequestDetails = {method:'POST',path:'/v1/responses',state:'finished',startedAt:Date.now(),requestBytes:10,responseBytes:20,queueMs:0,route:'personal',provider:'codex',accountLabel:'personal@test.invalid'};
 for(let i=0;i<130;i++)store.event(member,'recent-model','personal-account',200,100,null,details,`recent-${String(i).padStart(3,'0')}`);
 store.event(member,'old-model','removed-account',200,100,null,{...details,route:'shared',provider:'claude',path:'/v1/messages',accountLabel:'backup@test.invalid',promptPreview:'Find this historical request'},'six-days-old');
 store.event(member,'legacy-model','legacy-account',200,100,null,undefined,'eight-days-old');
 store.event(member,'expired-model',null,200,100,null,undefined,'expired');
 for(const [id,days] of [['six-days-old',6],['eight-days-old',8],['expired',91]] as const)store.db.prepare('UPDATE events SET at=? WHERE id=?').run(Date.now()-days*86400000,id);
 assert.equal(store.history().some(event=>event.id==='six-days-old'),false);
 const shared=store.activity({route:'shared',time:604800000});
 assert.equal(shared.total,1);assert.equal(shared.events[0].id,'six-days-old');
 assert.equal(store.activity({time:604800000}).total,131);
 assert.equal(store.activity({time:86400000}).total,130);
 assert.equal(store.activity().total,132);
 assert.deepEqual(store.activity({account:'removed-account'}).events.map(event=>event.id),['six-days-old']);
 assert.equal(store.activity({person:member.id,account:'removed-account',model:'old-model',provider:'claude',route:'shared',endpoint:'/v1/messages',result:'completed',search:'HISTORICAL',time:604800000}).total,1);
 assert.equal(store.activity({search:'backup@test.invalid'}).total,1);
 assert.equal(store.activity({search:"%' OR 1=1 --"}).total,0);
 assert.equal(store.activity({route:'unknown'}).events[0].id,'eight-days-old');
 assert.ok(shared.options.models.includes('legacy-model'));
 assert.ok(shared.options.accounts.some(account=>account.id==='removed-account'&&account.label==='backup@test.invalid'));
 const first=store.activity({limit:25});
 store.event(member,'new-model','personal-account',200,100,null,details,'new-arrival');
 const second=store.activity({limit:25,offset:25,snapshot:first.snapshot});
 assert.equal(second.total,132);
 assert.equal(second.events.some(event=>first.events.some(previous=>previous.id===event.id)),false);
 assert.equal(second.events.some(event=>event.id==='new-arrival'),false);
 assert.equal(store.activity({limit:25,snapshot:first.snapshot}).events[0].id,first.events[0].id);
 const last=store.activity({limit:25,offset:99999,snapshot:first.snapshot});
 assert.equal(last.offset,125);assert.equal(last.events.length,7);
 assert.ok(last.events.some(event=>event.id==='six-days-old'));
 assert.ok(last.events.some(event=>event.id==='eight-days-old'));
});

test('activity time ranges distinguish minutes, hours, days and a week', t => {
 const store=new Store(':memory:');t.after(()=>store.close());
 const member=store.create({name:'Friend',sharePercent:20,paused:false,allowedModels:[],accountIds:[],expiresAt:null,rpm:20,fallbackOnly:true}).member;
 for(const [id,age] of [['now',0],['half-hour',1800000],['three-hours',10800000],['two-days',172800000],['eight-days',691200000]] as const){
  store.event(member,'model',null,200,100,null,undefined,id);
  store.db.prepare('UPDATE events SET at=? WHERE id=?').run(Date.now()-age,id);
 }
 for(const [time,total] of [[900000,1],[3600000,2],[86400000,3],[604800000,4]])assert.equal(store.activity({time}).total,total);
});

test('activity query validates filters and bounds paging parameters', () => {
 assert.deepEqual(activityQuery(new URLSearchParams('account=old-id&route=shared&time=604800000&limit=50&offset=100&snapshot=200')), {account:'old-id',route:'shared',time:604800000,limit:50,offset:100,snapshot:200});
 for(const query of ['limit=0','limit=101','limit=-1','limit=1.5','offset=-1','offset=NaN','snapshot=9007199254740992','snapshot=','time=1','provider=unknown','route=backup','result=bogus',`search=${'x'.repeat(501)}`]){
  assert.throws(()=>activityQuery(new URLSearchParams(query)),{status:400},query);
 }
});
