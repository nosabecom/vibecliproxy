import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Notifications } from '../src/notifications.ts';

function subscription(endpoint = 'https://fcm.googleapis.com/fcm/send/private-token') {
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const p256dh = key.subarray(-65).toString('base64url');
  return { endpoint, keys: { p256dh, auth: randomBytes(16).toString('base64url') }, label: 'Nosa’s phone' };
}

test('stores VAPID keys and subscriptions privately and returns no endpoint or private key', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const notifications = new Notifications(store, { baseUrl: 'https://hub.example/cliproxy' }); t.after(() => notifications.close());
  const before = notifications.state();
  assert.equal(typeof before.publicKey, 'string');
  assert.equal('privateKey' in before, false);
  const input = subscription();
  const id = notifications.subscribe(input);
  assert.equal(notifications.subscribe({ ...input, label: 'Updated label' }), id);
  notifications.configure({ enabled: true, reminderMinutes: 0 });
  assert.deepEqual(notifications.state().subscriptions, [{ id, label: 'Updated label', createdAt: notifications.state().subscriptions[0]?.createdAt }]);
  assert.equal(JSON.stringify(notifications.state()).includes('private-token'), false);
  assert.equal(JSON.stringify(notifications.state()).includes('private_key'), false);
});

test('rejects arbitrary hosts, insecure URLs, malformed keys, and subscriptions above the cap', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const notifications = new Notifications(store, { baseUrl: 'https://hub.example/cliproxy' }); t.after(() => notifications.close());
  for (const endpoint of ['http://fcm.googleapis.com/fcm/send/x','https://localhost/fcm/send/x','https://127.0.0.1/x','https://evil.example/fcm/send/x','https://user:pass@fcm.googleapis.com/fcm/send/x','https://fcm.googleapis.com:444/x']) {
    assert.throws(() => notifications.subscribe(subscription(endpoint)), /endpoint/i, endpoint);
  }
  const bad = subscription(); bad.keys.auth = 'abcd';
  assert.throws(() => notifications.subscribe(bad), /auth/i);
  for (let i=0;i<20;i++) notifications.subscribe(subscription(`https://fcm.googleapis.com/fcm/send/token-${i}`));
  assert.throws(() => notifications.subscribe(subscription('https://fcm.googleapis.com/fcm/send/overflow')), /20/);
});

test('persists enabled reviews in a durable outbox and records accepted only after sender acceptance', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'vibe-notifications-'));
  const dbPath = join(dir, 'notifications.db'); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sent: string[] = [];
  let store = new Store(dbPath);
  let notifications = new Notifications(store, { baseUrl: 'https://hub.example/cliproxy', send: async (_subscription, payload) => { sent.push(payload); return { statusCode: 201 }; } });
  const id = notifications.subscribe(subscription());
  notifications.configure({ enabled: true, reminderMinutes: 0 });
  notifications.enqueueReview({ id: 'review-1', memberName: 'Sam' });
  await notifications.flush();
  const state = notifications.state();
  assert.equal(state.history[0]?.status, 'accepted');
  assert.equal(sent.length, 1);
  const payload = JSON.parse(sent[0]!);
  assert.equal(payload.title, 'Vibe Hub · Review needed');
  assert.equal(payload.body, 'Sam has a task waiting for review. Shared backup is paused.');
  assert.equal(payload.url, 'https://hub.example/cliproxy/#reviews?review=review-1');
  assert.equal(payload.tag, 'review-1');
  assert.equal(state.subscriptions[0]?.id, id);
  notifications.close(); store.close();
  store = new Store(dbPath); t.after(() => store.close());
  notifications = new Notifications(store, { baseUrl: 'https://hub.example/cliproxy' }); t.after(() => notifications.close());
  assert.equal(notifications.state().history[0]?.status, 'accepted');
  assert.equal(notifications.state().subscriptions[0]?.id, id);
});

test('retries transient failures with bounded attempts and honors Retry-After', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let attempts = 0;
  const notifications = new Notifications(store, { baseUrl: 'https://hub.example/cliproxy', send: async () => { attempts++; throw Object.assign(new Error('temporary'), { statusCode: 503, headers: { 'retry-after': '120' } }); } }); t.after(() => notifications.close());
  notifications.subscribe(subscription()); notifications.configure({ enabled: true, reminderMinutes: 0 }); notifications.enqueueReview({ id: 'retry-me', memberName: 'Sam' });
  await notifications.flush();
  assert.equal(attempts, 1);
  let row = store.db.prepare('SELECT attempts,next_at,status FROM notification_outbox').get() as any;
  assert.equal(row.attempts, 1); assert.equal(row.status, 'queued'); assert.ok(row.next_at >= Date.now()+119_000);
  store.db.prepare('UPDATE notification_outbox SET next_at=?,attempts=4').run(Date.now()-1);
  await notifications.flush();
  row = store.db.prepare('SELECT attempts,status FROM notification_outbox').get() as any;
  assert.equal(row.attempts, 5); assert.equal(row.status, 'failed');
});

test('does not create a backlog while disabled and cancels queued events after review resolution', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let attempts = 0;
  const notifications = new Notifications(store, { baseUrl: 'https://hub.example/cliproxy', send: async () => { attempts++; return { statusCode: 201 }; } }); t.after(() => notifications.close());
  notifications.subscribe(subscription());
  notifications.enqueueReview({ id: 'disabled-review', memberName: 'Sam' });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM notification_outbox').get() && (store.db.prepare('SELECT COUNT(*) AS count FROM notification_outbox').get() as any).count, 0);
  notifications.configure({ enabled: true, reminderMinutes: 0 });
  assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM notification_outbox').get() as any).count, 0);
  notifications.enqueueReview({ id: 'resolved-review', memberName: 'Sam' }); notifications.resolveReview('resolved-review');
  await notifications.flush();
  assert.equal(attempts, 0);
  assert.equal(notifications.state().history.find(item => item.reviewId === 'resolved-review')?.status, 'failed');
});

test('requires enabled notifications and an active subscription for the explicit test action', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let attempts = 0;
  const notifications = new Notifications(store, { baseUrl: 'https://hub.example/cliproxy', send: async () => { attempts++; return { statusCode: 201 }; } }); t.after(() => notifications.close());
  assert.throws(() => notifications.test(), /subscription/i);
  notifications.subscribe(subscription());
  assert.throws(() => notifications.test(), /enable/i);
  notifications.configure({ enabled: true, reminderMinutes: 0 });
  assert.deepEqual(notifications.test(), { queued: 1 });
  await notifications.flush();
  assert.equal(attempts, 1);
  assert.equal(notifications.state().history[0]?.kind, 'test');
  assert.equal(notifications.state().history[0]?.status, 'accepted');
});

test('queues at most one reminder per unresolved review and removes subscriptions that return gone', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let attempts = 0;
  const notifications = new Notifications(store, { baseUrl: 'https://hub.example/cliproxy', send: async () => { attempts++; return { statusCode: attempts === 1 ? 201 : 410 }; } }); t.after(() => notifications.close());
  notifications.subscribe(subscription()); notifications.configure({ enabled: true, reminderMinutes: 1 });
  notifications.enqueueReview({ id: 'gone-review', memberName: 'Sam' });
  await notifications.flush();
  store.db.prepare('UPDATE notification_reviews SET created_at=? WHERE id=?').run(Date.now()-120_000,'gone-review');
  await notifications.flush(); await notifications.flush();
  assert.equal(attempts, 2);
  const history = store.db.prepare('SELECT kind,status FROM notification_outbox ORDER BY kind').all() as any[];
  assert.deepEqual(history.map(row => [row.kind,row.status]), [['initial','accepted'],['reminder','failed']]);
  assert.equal(notifications.state().subscriptions.length, 0);
});

test('a review eligibility change cancels later subscriber sends using the original target ID', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let eligible = true, attempts = 0, release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const checked: string[] = [];
  const notifications = new Notifications(store, { baseUrl:'https://hub.example/cliproxy', isReviewEligible:id => { checked.push(id); return eligible; }, send:async () => { attempts++; if (attempts === 1) { started(); await gate; } return { statusCode:201 }; } });
  t.after(() => notifications.close());
  notifications.subscribe(subscription('https://fcm.googleapis.com/fcm/send/one'));
  notifications.subscribe(subscription('https://fcm.googleapis.com/fcm/send/two'));
  notifications.configure({ enabled:true, reminderMinutes:0 });
  notifications.enqueueReview({ id:'review-target', generation:7, memberName:'Sam' });
  await firstStarted;
  eligible = false;
  release();
  await notifications.flush();
  assert.deepEqual(checked,['review-target','review-target']);
  assert.equal(attempts,1);
  const rows = store.db.prepare('SELECT status,error FROM notification_outbox ORDER BY rowid').all() as any[];
  assert.equal(rows[0]?.status,'accepted');
  assert.equal(rows[1]?.status,'failed');
  assert.equal(rows[1]?.error,'Review no longer eligible');
});

test('rechecks enabled settings between sends when a send is already awaiting the push service', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let attempts = 0, release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const notifications = new Notifications(store, { baseUrl:'https://hub.example/cliproxy', send:async () => { attempts++; if (attempts === 1) { started(); await gate; } return { statusCode:201 }; } });
  t.after(() => notifications.close());
  notifications.subscribe(subscription('https://fcm.googleapis.com/fcm/send/one'));
  notifications.subscribe(subscription('https://fcm.googleapis.com/fcm/send/two'));
  notifications.configure({ enabled:true, reminderMinutes:0 });
  notifications.enqueueReview({ id:'toggle-review', memberName:'Sam' });
  await firstStarted;
  notifications.configure({ enabled:false });
  release();
  await notifications.flush();
  assert.equal(attempts,1);
  assert.equal((store.db.prepare("SELECT COUNT(*) count FROM notification_outbox WHERE status='queued'").get() as any).count,1);
  notifications.configure({ enabled:true });
  await notifications.flush();
  assert.equal(attempts,2);
  assert.equal((store.db.prepare("SELECT COUNT(*) count FROM notification_outbox WHERE status='accepted'").get() as any).count,2);
});

test('eligibility is checked before reminders', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let eligible = true, attempts = 0;
  const notifications = new Notifications(store, { baseUrl:'https://hub.example/cliproxy', isReviewEligible:() => eligible, send:async () => { attempts++; return { statusCode:201 }; } });
  t.after(() => notifications.close());
  notifications.subscribe(subscription());
  notifications.configure({ enabled:true, reminderMinutes:1 });
  notifications.enqueueReview({ id:'reminder-target', memberName:'Sam' });
  await notifications.flush();
  store.db.prepare('UPDATE notification_reviews SET created_at=? WHERE id=?').run(Date.now()-120_000,'reminder-target');
  eligible = false;
  await notifications.flush();
  assert.equal(attempts,1);
  assert.equal((store.db.prepare("SELECT COUNT(*) count FROM notification_outbox WHERE kind='reminder'").get() as any).count,0);
});

test('cancelReviewAlerts cancels in-flight and queued review alerts while leaving test events intact', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let attempts = 0, release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reviewStarted = new Promise<void>(resolve => { started = resolve; });
  const notifications = new Notifications(store, { baseUrl:'https://hub.example/cliproxy', send:async (_subscription,payload) => {
    attempts++;
    if (payload.includes('review=cancel-target')) { started(); await gate; }
    return { statusCode:201 };
  } });
  t.after(() => notifications.close());
  notifications.subscribe(subscription());
  notifications.configure({ enabled:true, reminderMinutes:0 });
  notifications.test();
  await notifications.flush();
  notifications.enqueueReview({ id:'cancel-target', memberName:'Sam' });
  await reviewStarted;
  notifications.cancelReviewAlerts();
  release();
  await notifications.flush();
  assert.equal((store.db.prepare('SELECT COUNT(*) count FROM notification_reviews WHERE resolved_at IS NULL').get() as any).count,0);
  assert.equal((store.db.prepare("SELECT COUNT(*) count FROM notification_outbox WHERE review_id IS NOT NULL AND status='queued'").get() as any).count,0);
  assert.equal((store.db.prepare("SELECT status FROM notification_outbox WHERE kind='test'").get() as any).status,'accepted');
  assert.equal((store.db.prepare("SELECT status FROM notification_outbox WHERE kind='initial'").get() as any).status,'failed');
  assert.equal(attempts,2);
});

test('a cancelled review event can be re-queued with the same target and generation', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let attempts = 0;
  const notifications = new Notifications(store, { baseUrl:'https://hub.example/cliproxy', send:async () => { attempts++; return { statusCode:201 }; } });
  t.after(() => notifications.close());
  notifications.subscribe(subscription());
  notifications.configure({ enabled:true, reminderMinutes:0 });
  notifications.enqueueReview({ id:'same-generation', generation:3, memberName:'Sam' });
  notifications.cancelReviewAlerts();
  notifications.enqueueReview({ id:'same-generation', generation:3, memberName:'Sam' });
  await notifications.flush();
  assert.equal(attempts,1);
  assert.equal((store.db.prepare('SELECT resolved_at FROM notification_reviews WHERE id=?').get('same-generation:3') as any).resolved_at,null);
  assert.equal((store.db.prepare("SELECT status FROM notification_outbox WHERE kind='initial'").get() as any).status,'accepted');
});

test('LAN HTTP base URLs are accepted while disabled and rejected when push is enabled', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const notifications = new Notifications(store, { baseUrl:'http://192.168.1.10/cliproxy' }); t.after(() => notifications.close());
  assert.equal(notifications.state().enabled,false);
  assert.throws(() => notifications.configure({ enabled:true }), /HTTPS/i);
  assert.throws(() => notifications.subscribe(subscription()), /HTTPS/i);
});
