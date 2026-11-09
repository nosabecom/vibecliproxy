import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createHub } from '../src/server.ts';
import { Store, hash } from '../src/store.ts';
import { CliProxy } from '../src/cliproxy.ts';
import { hashPassword } from '../src/auth.ts';
import type { LoginFactory } from '../src/onboarding.ts';
import type { Account, Provider } from '../src/types.ts';
const adminPasswordHash = await hashPassword('connection test password');
const quotaUrl = 'https://chatgpt.com/backend-api/wham/usage';
const makeAccount = (id: string, ownerMemberId: string | null, usedPercent = 9, provider: Provider = 'codex'): Account => ({
 id, name: `${id}.json`, email: `${id}@private.invalid`, ownerMemberId, provider, prefix: `vcp-${id}`, enabled: true, available: true,
 checkedAt: Date.now(), models: ['test-model'], windows: [{ id: provider === 'codex' ? 'primary_window' : 'five_hour', label: '5 hour', usedPercent, resetsAt: Date.now() + 3600000 }],
});
async function setup(t: any) {
 const store = new Store(':memory:');
 const create = (name: string) => store.create({name, sharePercent: 20, paused: false, allowedModels: [], accountIds: [], expiresAt: null, rpm: 20, fallbackOnly: true});
 const sam = create('Sam'), other = create('Other');
 const proxy = new CliProxy({url: 'http://127.0.0.1:9', apiKey: 'private', managementKey: 'private'}, store);
 proxy.lastSync = Date.now(); proxy.accounts = [makeAccount('owner', null), makeAccount('sam', sam.member.id), makeAccount('other', other.member.id)];
 const central: any[] = [], staged: any[] = [], files: any[] = [{id: 'owner-id', name: 'original.json', provider: 'codex'}];
 let beforeImport: (() => void) | undefined;
 proxy.management = async (path, body?: any, method?: string) => {
  central.push({path, body, method});
  if (path.startsWith('auth-files?name=') && method === 'DELETE') return {status: 'ok'};
  if (path.startsWith('auth-files?name=')) {
   assert.equal(body.disabled, true); const name = decodeURIComponent(path.split('=')[1]!);
   assert.equal(store.owner(name), sam.member.id); beforeImport?.();
   files.push({id: `real-${name}`, name, provider: body.type}); return {status: 'ok'};
  }
  if (path === 'auth-files') return {files};
  if (path === 'auth-files/status') {assert.equal(method, 'PATCH'); assert.equal(store.owner(`real-${body.name}`), sam.member.id); return {status: 'ok'};}
  throw new Error(`Unexpected central request: ${path}`);
 };
 proxy.sync = async () => {};
 const loginFactory: LoginFactory = async () => {
  const session = {provider: 'codex' as Provider, complete: false, disposed: 0, calls: [] as any[], fail: false}; staged.push(session);
  return {
   management: async (path: string, body?: any) => {
    session.calls.push({path, body});
    if (path.endsWith('auth-url')) {
     session.provider = path === 'codex-auth-url' ? 'codex' : 'claude';
     const url = new URL(session.provider === 'codex' ? 'https://auth.openai.com/oauth/authorize' : 'https://claude.ai/oauth/authorize');
     url.searchParams.set('state', 'native-state');url.searchParams.set('redirect_uri', 'http://localhost:1455/auth/callback');
     return {url: url.href, state: 'native-state'};
    }
    if (path === 'oauth-callback') {assert.equal(body.provider, session.provider);session.complete = true;return {status: 'ok'};}
    if (path.startsWith('get-auth-status')) return {status: session.fail ? 'error' : session.complete ? 'ok' : 'wait'};
    if (path === 'auth-files') return {files: [{provider: session.provider, name: 'original.json'}]};
    if (path.startsWith('auth-files/download')) return {type: session.provider, access_token: 'secret-test-token', refresh_token: 'secret-refresh', email: 'sam@private.invalid', prefix: 'hostile', proxy_url: 'http://hostile.invalid', metadata: {owner: 'someone-else'}};
    throw new Error('Unexpected stage request');
   }, dispose: async () => {session.disposed++;},
  };
 };
 const hub = createHub({host: '127.0.0.1', port: 0, dataPath: ':memory:', publicOrigin: 'http://localhost', basePath: '/cliproxy', adminPasswordHash,
  proxyUrl: proxy.config.url, proxyKey: 'private', managementKey: 'private'}, {store, proxy, loginFactory});
 hub.server.listen(0, '127.0.0.1');await once(hub.server, 'listening');
 const origin = `http://127.0.0.1:${(hub.server.address() as any).port}`, base = `${origin}/cliproxy`;
 t.after(async () => {hub.server.closeAllConnections();await new Promise<void>(r => hub.server.close(() => r()));await hub.close();store.close();});
 const session = await (await fetch(`${base}/api/member/session`, {headers: {Authorization: `Bearer ${sam.key}`}})).json();
 const call = (path: string, method = 'GET', body?: unknown, key = sam.key, extra = {}) => fetch(`${base}${path}`, {method,
  headers: {Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf, ...extra}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
 const start = async (provider = 'codex') => {const response = await call('/api/member/oauth/start', 'POST', {provider});assert.equal(response.status, 200);return response.json();};
 const callback = (state: string, redirectUrl = 'http://localhost:1455/auth/callback?code=test-code&state=native-state') => call('/api/member/oauth/callback', 'POST', {state, redirectUrl, provider: 'attacker'});
 return {store, proxy, sam, other, origin, base, call, start, callback, central, staged, files, setBeforeImport: (fn: () => void) => {beforeImport = fn;}};
}
test('member OAuth is isolated, validates callback, imports once under new ownership, and never returns credentials', async t => {
 const s = await setup(t);const started = await s.start();assert.notEqual(started.state, 'native-state');
 assert.equal((await s.call('/api/member/oauth/start', 'POST', {provider: 'codex'})).status, 409);
 assert.equal((await s.call(`/api/member/oauth/status?state=${started.state}`, 'GET', undefined, s.other.key)).status, 404);
 for (const redirect of ['https://evil.invalid/?code=a&state=native-state', 'http://localhost:1455/auth/callback?code=a&state=other', 'http://localhost:1455/wrong?code=a&state=native-state']) assert.equal((await s.callback(started.state, redirect)).status, 400);
 assert.equal(s.central.length, 0);
 assert.deepEqual(await (await s.call(`/api/member/oauth/status?state=${started.state}`)).json(), {status: 'wait'});
 assert.equal((await s.callback(started.state)).status, 200);
 const results = await Promise.all([s.call(`/api/member/oauth/status?state=${started.state}`), s.call(`/api/member/oauth/status?state=${started.state}`)]);
 for (const response of results) assert.deepEqual(await response.json(), {status: 'ok'});
 assert.equal(s.central.filter(c => c.path.startsWith('auth-files?')).length, 1);
 assert.equal(s.files[0].name, 'original.json');assert.equal(s.store.owner('owner-id'), null);
 const upload = s.central.find(c => c.path.startsWith('auth-files?'));assert.match(upload.path, /member-codex-/);
 assert.equal(upload.body.prefix, undefined);assert.equal(upload.body.proxy_url, undefined);assert.equal(upload.body.metadata, undefined);
 assert.equal(s.staged[0].disposed, 1);
 const text = await (await s.call('/api/member/state')).text();assert.ok(!text.includes('secret-test-token'));assert.ok(!text.includes('secret-refresh'));
 assert.equal((await s.call('/api/state')).status, 401);
});

test('members can remove only their own scoped account; credentials and other accounts stay private',async t=>{
 const s=await setup(t);
 const view=await(await s.call('/api/member/state')).json();
 const own=view.accounts.find((a:any)=>a.personal),backup=view.accounts.find((a:any)=>!a.personal);
 const endpoint='/api/member/accounts';
 for(const accountId of [backup.id,hash('other').slice(0,16),'sam','missing']) {
  assert.equal((await s.call(endpoint,'DELETE',{accountId})).status,404);
 }
 assert.equal((await s.call(endpoint,'DELETE',{accountId:own.id},s.sam.key,{'X-CSRF-Token':''})).status,403);
 assert.equal((await s.call('/api/accounts','DELETE',{accountId:'owner'})).status,401);
 assert.equal(s.central.length,0);
 assert.equal((await s.call(endpoint,'DELETE',{accountId:own.id})).status,200);
 assert.deepEqual(s.central,[{path:'auth-files?name=sam.json',body:undefined,method:'DELETE'}]);
 assert.deepEqual(s.proxy.accounts.map(a=>a.id),['owner','other']);
 const after=await(await s.call('/api/member/state')).json();assert.equal(after.accounts.some((a:any)=>a.personal),false);
 assert.equal((await s.call(endpoint,'DELETE',{accountId:own.id})).status,404);
});

test('rotating a member key while a removal body arrives prevents deletion', {timeout:5000},async t=>{
 const s=await setup(t);
 let authenticated!:()=>void;
 const entered=new Promise<void>(resolve=>{authenticated=resolve;});
 const session=await(await s.call('/api/member/session')).json();
 const original=s.store.authenticate.bind(s.store);
 s.store.authenticate=key=>{const member=original(key);if(key===s.sam.key)authenticated();return member;};
 const response=new Promise<number>((resolve,reject)=>{
  const request=httpRequest(`${s.base}/api/member/accounts`,{method:'DELETE',headers:{Authorization:`Bearer ${s.sam.key}`,'Content-Type':'application/json','X-CSRF-Token':session.csrf,'Transfer-Encoding':'chunked'}},result=>{result.resume();result.once('end',()=>resolve(result.statusCode!));});
  request.once('error',reject);t.after(()=>request.destroy());
  request.write('{"accountId":');
  void entered.then(()=>{s.store.rotate(s.sam.member.id);request.end(JSON.stringify(hash('sam').slice(0,16))+'}');});
 });
 assert.equal(await response,401);assert.equal(s.central.length,0);assert.equal(s.proxy.accounts.length,3);
});
test('Claude self-service uses its own session and cancelled sessions cannot finish', async t => {
 const s = await setup(t);const started = await s.start('claude');assert.equal(new URL(started.url).hostname, 'claude.ai');
 assert.equal((await s.callback(started.state)).status, 200);
 assert.deepEqual(await (await s.call(`/api/member/oauth/status?state=${started.state}`)).json(), {status: 'ok'});
 assert.equal(s.files[1].provider, 'claude');assert.match(s.files[1].name, /^member-claude-/);
 const pending = await s.start();assert.equal((await s.call('/api/member/oauth/cancel', 'POST', {state: pending.state})).status, 200);
 assert.equal((await s.callback(pending.state)).status, 404);assert.equal(s.staged[1].disposed, 1);
});
test('member OAuth enforces CSRF, origin, pause, expiry, rotation and revocation', async t => {
 const s = await setup(t);
 assert.equal((await s.call('/api/member/oauth/start', 'POST', {provider: 'codex'}, s.sam.key, {'X-CSRF-Token': ''})).status, 403);
 assert.equal((await s.call('/api/member/oauth/start', 'POST', {provider: 'codex'}, s.sam.key, {Origin: 'https://evil.invalid'})).status, 403);
 assert.equal((await s.call('/api/member/oauth/start', 'POST', {provider: 'unknown'})).status, 400);
 const started = await s.start();let member = s.store.member(s.sam.member.id);member.paused = true;s.store.save(member);
 assert.equal((await s.callback(started.state)).status, 403);
 member.paused = false;member.expiresAt = Date.now() - 1;s.store.save(member);assert.equal((await s.callback(started.state)).status, 403);
 member.expiresAt = null;s.store.save(member);const rotated = s.store.rotate(member.id);
 assert.equal((await s.callback(started.state)).status, 401);
 assert.equal((await s.call(`/api/member/oauth/status?state=${started.state}`, 'GET', undefined, rotated)).status, 404);
 assert.equal(s.central.length, 0);
 s.store.remove(member.id);assert.equal((await s.call('/api/member/oauth/start', 'POST', {provider: 'codex'}, rotated)).status, 401);
});
test('pause during credential registration leaves the imported account disabled', async t => {
 const s = await setup(t);const started = await s.start();await s.callback(started.state);
 s.setBeforeImport(() => {const m = s.store.member(s.sam.member.id);m.paused = true;s.store.save(m);});
 assert.deepEqual(await (await s.call(`/api/member/oauth/status?state=${started.state}`)).json(), {status: 'error', error: 'Sign-in could not be completed. Start again.'});
 assert.equal(s.central.some(c => c.path === 'auth-files/status'), false);assert.equal(s.staged[0].disposed, 1);
});
test('T3 usage contract supports mounted and stripped paths, anonymous backups, and per-member account IDs', async t => {
 const s = await setup(t);const response = await s.call('/v0/management/auth-files');assert.equal(response.status, 200);
 const inventory = await response.json();assert.equal(inventory.files.length, 2);
 assert.equal(inventory.files[0].email.startsWith('Shared backup'), true);assert.equal(inventory.files[1].email, 'sam@private.invalid');
 assert.equal(JSON.stringify(inventory).includes('owner@private.invalid'), false);assert.equal(JSON.stringify(inventory).includes('other@private.invalid'), false);
 assert.ok(inventory.files.every((f: any) => f.auth_index !== 'owner' && f.auth_index !== 'sam'));
 assert.equal((await fetch(`${s.origin}/v0/management/auth-files`, {headers: {Authorization: `Bearer ${s.sam.key}`}})).status, 200);
 const otherInventory = await (await s.call('/v0/management/auth-files', 'GET', undefined, s.other.key)).json();assert.notEqual(inventory.files[0].auth_index, otherInventory.files[0].auth_index);
 assert.equal((await s.call('/v0/management/api-call', 'POST', {auth_index: otherInventory.files[1].auth_index, method: 'GET', url: quotaUrl})).status, 404);
 assert.equal((await fetch(`${s.base}/v0/management/auth-files`)).status, 401);
 for (const path of ['config', 'auth-files/download?name=owner.json', 'codex-auth-url', 'get-auth-status?state=x']) assert.equal((await s.call(`/v0/management/${path}`)).status, 403);
 assert.equal((await s.call('/v0/management/auth-files', 'DELETE')).status, 403);
 assert.equal(s.central.length, 0);
});

test('usage hub and member dashboard follow a custom personal switchover threshold', async t=>{
 const s=await setup(t),member=s.store.member(s.sam.member.id);
 member.personalSwitchPercent=40;s.store.save(member);
 const inventory=await(await s.call('/v0/management/auth-files')).json();
 const read=async(index:number)=>{
  const result=await(await s.call('/v0/management/api-call','POST',{auth_index:inventory.files[index].auth_index,method:'GET',url:quotaUrl})).json();
  return JSON.parse(result.body).rate_limit.primary_window.used_percent;
 };
 const personal=s.proxy.accounts[1]!;
 personal.windows[0]!.usedPercent=39.9;
 assert.equal(await read(0),100);assert.equal(await read(1),39.9);
 personal.windows[0]!.usedPercent=40;
 assert.equal(await read(0),50);assert.equal(await read(1),40);
 const state=await(await s.call('/api/member/state')).json();
 assert.equal(state.member.personalSwitchPercent,40);
 assert.equal(state.member.personalSwitchWindow,'both');
 const account=state.accounts.find((a:any)=>a.personal);
 assert.equal(account.switchReached,true);assert.equal(account.exhausted,false);
 member.personalSwitchWindow='weekly';s.store.save(member);
 assert.equal(await read(0),100);
 personal.windows.push({id:'secondary_window',label:'Weekly',usedPercent:40,resetsAt:Date.now()+86400000});
 assert.equal(await read(0),50);
 member.personalSwitchWindow='hourly';s.store.save(member);
 personal.windows[0]!.usedPercent=1;
 assert.equal(await read(0),100);
 personal.windows[0]!.usedPercent=40;
 personal.checkedAt=Date.now()-120001;
 assert.equal(await read(0),100);
 personal.checkedAt=Date.now();personal.windows[0]!.usedPercent=1;
 assert.equal(await read(0),100);
});
test('usage reports personal quota and only usable backup allowance; errors, ceilings and pauses close access', async t => {
 const s = await setup(t);const inventory = await (await s.call('/v0/management/auth-files')).json();
 const read = async (index: number, url = quotaUrl, extra = {}) => {const r = await s.call('/v0/management/api-call', 'POST', {auth_index: inventory.files[index].auth_index, method: 'GET', url, header: {Authorization: 'Bearer $TOKEN$'}, ...extra});return {status: r.status, value: await r.json()};};
 const used = async (index: number) => JSON.parse((await read(index)).value.body).rate_limit.primary_window.used_percent;
 assert.equal(await used(1), 9);assert.equal(await used(0), 100); // Personal quota must be used first.
 s.proxy.accounts[1]!.windows[0]!.usedPercent = 100;assert.equal(await used(0), 50); // 9 of the effective 18% allowance.
 s.proxy.accounts[0]!.windows[0]!.usedPercent = 18;assert.equal(await used(0), 100);
 s.proxy.accounts[0]!.windows[0]!.usedPercent = 0;s.store.setSettings({paused: true, safetyMargin: 2});assert.equal(await used(0), 100);assert.equal(await used(1), 100);
 s.store.setSettings({paused: false, safetyMargin: 2});s.proxy.accounts[1]!.checkedAt = Date.now() - 121000;assert.equal(await used(0), 100);assert.equal((await read(1)).value.status_code, 503);
 s.proxy.error = 'inventory failure';assert.equal((await read(0)).value.status_code, 503);
 assert.deepEqual(JSON.parse((await read(0, quotaUrl.replace('/usage', '/rate-limit-reset-credits'))).value.body), {credits: []});
 for (const [url, extra] of [['https://evil.invalid', {}], [quotaUrl, {method: 'POST'}], [quotaUrl, {data: 'payload'}], [quotaUrl.replace('/usage', '/rate-limit-reset-credits/consume'), {}]]) assert.equal((await read(0, url as string, extra)).status, 403);
 assert.equal(s.central.length, 0);
});
test('Claude usage keeps scoped limits and inactive keys cannot query the usage hub', async t => {
 const s = await setup(t);s.proxy.accounts = [makeAccount('sam-claude', s.sam.member.id, 37, 'claude')];
 s.proxy.accounts[0]!.windows.push({id: 'limit-0', label: 'Opus', usedPercent: 83, resetsAt: Date.now() + 86400000});
 const inventory = await (await s.call('/v0/management/auth-files')).json();
 const r = await s.call('/v0/management/api-call', 'POST', {auth_index: inventory.files[0].auth_index, method: 'GET', url: 'https://api.anthropic.com/api/oauth/usage'});
 const body = JSON.parse((await r.json()).body);assert.equal(body.five_hour.utilization, 37);assert.equal(body.limits[0].percent, 83);assert.equal(body.limits[0].scope.model.display_name, 'Opus');
 const member = s.store.member(s.sam.member.id);member.paused = true;s.store.save(member);assert.equal((await s.call('/v0/management/auth-files')).status, 403);
 member.paused = false;member.expiresAt = Date.now() - 1;s.store.save(member);assert.equal((await s.call('/v0/management/auth-files')).status, 403);
});


test('revoking a key while its quota request body is arriving blocks the read', {timeout: 5000}, async t => {
 const s = await setup(t);
 const inventory = await (await s.call('/v0/management/auth-files')).json();
 let authenticated!: () => void;
 const entered = new Promise<void>(resolve => { authenticated = resolve; });
 const originalAuthenticate = s.store.authenticate.bind(s.store);
 s.store.authenticate = key => {
  const member = originalAuthenticate(key);
  if (key === s.sam.key) authenticated();
  return member;
 };
 const response = new Promise<number>((resolve, reject) => {
  const request = httpRequest(`${s.base}/v0/management/api-call`, {
   method: 'POST',
   headers: {Authorization: `Bearer ${s.sam.key}`, 'Content-Type': 'application/json'},
  }, result => {
   result.resume();
   result.once('end', () => resolve(result.statusCode!));
  });
  request.once('error', reject);
  t.after(() => request.destroy());
  request.write('{"method":"GET",');
  void entered.then(() => {
   s.store.rotate(s.sam.member.id);
   request.end(JSON.stringify({auth_index: inventory.files[0].auth_index, url: quotaUrl}).slice(1));
  });
 });
 assert.equal(await response, 401);
});
