import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { generateVAPIDKeys, sendNotification } from 'web-push';
import type { Store } from './store.ts';
import { HttpError } from './types.ts';

export interface NotificationSubscriptionInput { endpoint: string; keys: { p256dh: string; auth: string }; label?: string }
export interface NotificationOptions { baseUrl: string; subject?: string; send?: PushSender; isReviewEligible?: (targetId: string) => boolean }
export interface PushResult { statusCode?: number; headers?: Record<string, string | string[] | number | undefined> }
export type PushSender = (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string, options: { vapidDetails: { subject: string; publicKey: string; privateKey: string } }) => Promise<PushResult | void>;

const MAX_SUBSCRIPTIONS = 20;
const MAX_PAYLOAD_BYTES = 10 * 1024;
const MAX_ATTEMPTS = 5;
const exactPushHosts = new Set(['fcm.googleapis.com', 'push.services.mozilla.com', 'web.push.apple.com', 'push.apple.com']);

function validEndpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Invalid push endpoint'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const allowed = exactPushHosts.has(host) || host.endsWith('.push.services.mozilla.com') || host.endsWith('.notify.windows.com');
  if (url.protocol !== 'https:' || !allowed || url.username || url.password || url.port || url.hash || value.length > 4096) throw new Error('Unsupported push endpoint');
  return url;
}
function decodeKey(value: string, bytes: number, name: string): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Invalid ${name} key`);
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== bytes || decoded.toString('base64url') !== value) throw new Error(`Invalid ${name} key`);
  return decoded;
}
function retryDelay(headers: PushResult['headers'], attempt: number): number {
  const raw = headers && Object.entries(headers).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  const value = Array.isArray(raw) ? raw[0] : raw;
  let ms = typeof value === 'number' || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) ? Number(value) * 1000 : typeof value === 'string' ? Date.parse(value) - Date.now() : NaN;
  if (!Number.isFinite(ms) || ms < 0) ms = Math.min(60_000 * 2 ** (attempt - 1), 3_600_000);
  return Math.min(ms, 3_600_000);
}
function localHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && Number(host.split('.')[0]) === 127);
}

export class Notifications {
  private readonly db: Store['db'];
  private readonly baseUrl: string;
  private readonly subject: string;
  private readonly sender: PushSender;
  private readonly isReviewEligible?: (targetId: string) => boolean;
  private readonly timer: NodeJS.Timeout;
  private closed = false;
  private flushing?: Promise<void>;

  constructor(store: Store, options: NotificationOptions) {
    this.db = store.db;
    const base = new URL(options.baseUrl);
    if (!['https:','http:'].includes(base.protocol) || base.username || base.password) throw new HttpError(400, 'Invalid notification base URL');
    this.baseUrl = base.toString().replace(/\/$/, '');
    this.subject = options.subject || new URL(options.baseUrl).origin;
    this.sender = options.send ?? ((subscription, payload, sendOptions) => sendNotification(subscription, payload, {...sendOptions, timeout:10000, TTL:300}));
    this.isReviewEligible = options.isReviewEligible;
    this.db.exec(`CREATE TABLE IF NOT EXISTS notification_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0, reminder_minutes INTEGER NOT NULL DEFAULT 0, public_key TEXT, private_key TEXT);
      INSERT OR IGNORE INTO notification_settings(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS notification_subscriptions (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notification_reviews (id TEXT PRIMARY KEY, member_name TEXT NOT NULL, rule_name TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER, reminder_queued INTEGER NOT NULL DEFAULT 0, target_id TEXT);
      CREATE TABLE IF NOT EXISTS notification_outbox (id TEXT PRIMARY KEY, review_id TEXT, subscription_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, accepted_at INTEGER, error TEXT, UNIQUE(review_id,subscription_id,kind));
      CREATE INDEX IF NOT EXISTS notification_outbox_due ON notification_outbox(status,next_at);`);
    if (!(this.db.prepare('PRAGMA table_info(notification_reviews)').all() as any[]).some(column=>column.name==='target_id')) this.db.exec('ALTER TABLE notification_reviews ADD COLUMN target_id TEXT');
    const stored = this.db.prepare('SELECT public_key,private_key FROM notification_settings WHERE id=1').get() as any;
    if (!stored.public_key || !stored.private_key) {
      const keys = generateVAPIDKeys();
      this.db.prepare('UPDATE notification_settings SET public_key=?,private_key=? WHERE id=1').run(keys.publicKey, keys.privateKey);
    }
    this.timer = setInterval(() => { void this.flush().catch(() => {}); }, 30_000);
    this.timer.unref();
  }

  state() {
    const settings = this.db.prepare('SELECT enabled,reminder_minutes,public_key FROM notification_settings WHERE id=1').get() as any;
    const subscriptions = this.db.prepare('SELECT id,label,created_at FROM notification_subscriptions ORDER BY created_at').all() as any[];
    const history = this.db.prepare(`SELECT id,review_id,kind,status,created_at,accepted_at,error FROM notification_outbox ORDER BY created_at DESC LIMIT 50`).all() as any[];
    return { enabled: !!settings.enabled, publicKey: settings.public_key, subscriptions: subscriptions.map(s => ({ id:s.id,label:s.label,createdAt:s.created_at })), history: history.map(h => ({ id:h.id,reviewId:h.review_id,kind:h.kind,status:h.status,createdAt:h.created_at,acceptedAt:h.accepted_at,error:h.error })), reminderMinutes: settings.reminder_minutes };
  }

  configure(input: { enabled?: boolean; reminderMinutes?: number }) {
    const current = this.state();
    const next = { enabled: input.enabled ?? current.enabled, reminderMinutes: input.reminderMinutes ?? current.reminderMinutes };
    if (typeof next.enabled !== 'boolean' || !Number.isInteger(next.reminderMinutes) || next.reminderMinutes < 0 || next.reminderMinutes > 10080) throw new HttpError(400, 'Invalid notification settings');
    if (next.enabled) this.requireSecureBaseUrl();
    this.db.prepare('UPDATE notification_settings SET enabled=?,reminder_minutes=? WHERE id=1').run(next.enabled ? 1 : 0, next.reminderMinutes);
    if (next.enabled) this.queueReminders();
    return this.state();
  }

  subscribe(input: NotificationSubscriptionInput) {
    this.requireSecureBaseUrl();
    if (!input || typeof input.endpoint !== 'string' || !input.keys) throw new Error('Invalid subscription');
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_PAYLOAD_BYTES) throw new Error('Subscription JSON is too large');
    validEndpoint(input.endpoint);
    decodeKey(input.keys.p256dh, 65, 'p256dh'); decodeKey(input.keys.auth, 16, 'auth');
    const label = typeof input.label === 'string' ? input.label.trim().slice(0, 60) : '';
    const existing = this.db.prepare('SELECT id FROM notification_subscriptions WHERE endpoint=?').get(input.endpoint) as any;
    if (existing) {
      this.db.prepare('UPDATE notification_subscriptions SET p256dh=?,auth=?,label=? WHERE id=?').run(input.keys.p256dh,input.keys.auth,label || 'Browser',existing.id);
      return existing.id as string;
    }
    const id = randomUUID();
    const count = (this.db.prepare('SELECT COUNT(*) AS count FROM notification_subscriptions').get() as any).count;
    if (count >= MAX_SUBSCRIPTIONS) throw new Error('At most 20 browser subscriptions are allowed');
    this.db.prepare('INSERT INTO notification_subscriptions(id,endpoint,p256dh,auth,label,created_at) VALUES(?,?,?,?,?,?)').run(id,input.endpoint,input.keys.p256dh,input.keys.auth,label || 'Browser',Date.now());
    return id;
  }

  unsubscribe(id: string) {
    const deleted = this.db.prepare('DELETE FROM notification_subscriptions WHERE id=?').run(id).changes > 0;
    if (deleted) this.db.prepare("UPDATE notification_outbox SET status='failed',error='Subscription removed' WHERE subscription_id=? AND status='queued'").run(id);
    return deleted;
  }

  enqueueReview(input: { id: string; memberName: string; ruleName?: string; generation?: number }) {
    if (!input || typeof input.id !== 'string' || !input.id || typeof input.memberName !== 'string') throw new Error('Invalid review');
    const now = Date.now();
    const eventId = input.generation ? `${input.id}:${input.generation}` : input.id;
    this.db.prepare('INSERT OR IGNORE INTO notification_reviews(id,member_name,rule_name,created_at,target_id) VALUES(?,?,?,?,?)').run(eventId,input.memberName.slice(0,100),input.ruleName?.slice(0,100) ?? null,now,input.id);
    this.db.prepare('UPDATE notification_reviews SET member_name=?,rule_name=?,created_at=?,target_id=?,resolved_at=NULL,reminder_queued=0 WHERE id=? AND resolved_at IS NOT NULL').run(input.memberName.slice(0,100),input.ruleName?.slice(0,100) ?? null,now,input.id,eventId);
    const review = this.db.prepare('SELECT created_at FROM notification_reviews WHERE id=?').get(eventId) as any;
    this.queue(eventId, 'initial', review.created_at);
    queueMicrotask(() => { void this.flush().catch(() => {}); });
  }

  resolveReview(id: string) {
    const now = Date.now();
    this.db.prepare('UPDATE notification_reviews SET resolved_at=? WHERE (id=? OR target_id=?) AND resolved_at IS NULL').run(now,id,id);
    this.db.prepare("UPDATE notification_outbox SET status='failed',error='Review resolved' WHERE review_id IN (SELECT id FROM notification_reviews WHERE id=? OR target_id=?) AND status='queued'").run(id,id);
  }

  cancelReviewAlerts() {
    const now = Date.now();
    this.db.prepare('UPDATE notification_reviews SET resolved_at=? WHERE resolved_at IS NULL').run(now);
    this.db.prepare("UPDATE notification_outbox SET status='failed',error='Review alerts cancelled' WHERE review_id IS NOT NULL AND status='queued'").run();
  }

  test() {
    const subs = this.db.prepare('SELECT id FROM notification_subscriptions').all() as any[];
    const enabled = (this.db.prepare('SELECT enabled FROM notification_settings WHERE id=1').get() as any).enabled;
    if (!subs.length) throw new HttpError(400, 'Add a browser subscription before sending a test');
    if (!enabled) throw new HttpError(400, 'Enable notifications before sending a test');
    this.requireSecureBaseUrl();
    for (const sub of subs) this.db.prepare("INSERT INTO notification_outbox(id,review_id,subscription_id,kind,status,created_at,due_at,next_at) VALUES(?,NULL,?,'test','queued',?,?,?)").run(randomUUID(),sub.id,Date.now(),Date.now(),Date.now());
    void this.flush().catch(() => {});
    return { queued: subs.length };
  }

  private queue(reviewId: string, kind: string, dueAt: number) {
    const state = this.db.prepare('SELECT enabled FROM notification_settings WHERE id=1').get() as any;
    if (!state.enabled) return;
    const subscriptions = this.db.prepare('SELECT id FROM notification_subscriptions').all() as any[];
    for (const sub of subscriptions) {
      this.db.prepare("INSERT OR IGNORE INTO notification_outbox(id,review_id,subscription_id,kind,status,created_at,due_at,next_at) VALUES(?,?,?,?, 'queued',?,?,?)").run(randomUUID(),reviewId,sub.id,kind,Date.now(),dueAt,dueAt);
      this.db.prepare(`UPDATE notification_outbox SET status='queued',created_at=?,due_at=?,next_at=?,attempts=0,error=NULL
        WHERE review_id=? AND subscription_id=? AND kind=? AND status='failed' AND error IN ('Review alerts cancelled','Review no longer eligible','Review resolved')`).run(Date.now(),dueAt,dueAt,reviewId,sub.id,kind);
    }
  }

  private queueReminders() {
    const {reminder_minutes: minutes,enabled} = this.db.prepare('SELECT reminder_minutes,enabled FROM notification_settings WHERE id=1').get() as any;
    if (!enabled || !minutes) return;
    const reviews = this.db.prepare('SELECT id,target_id,created_at FROM notification_reviews WHERE resolved_at IS NULL AND reminder_queued=0 AND created_at<=?').all(Date.now()-minutes*60_000) as any[];
    for (const review of reviews) {
      if (!this.reviewEligible(review.target_id ?? review.id)) { this.cancelReview(review.id); continue; }
      this.queue(review.id,'reminder',review.created_at+minutes*60_000);
      this.db.prepare('UPDATE notification_reviews SET reminder_queued=1 WHERE id=?').run(review.id);
    }
  }

  private reviewEligible(targetId: string): boolean {
    try { return this.isReviewEligible?.(targetId) ?? true; } catch { return false; }
  }

  private requireSecureBaseUrl() {
    const base = new URL(this.baseUrl);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && localHost(base.hostname))) throw new HttpError(400, 'Browser push requires an HTTPS hub URL');
  }

  private cancelReview(id: string) {
    const now = Date.now();
    this.db.prepare('UPDATE notification_reviews SET resolved_at=? WHERE id=? AND resolved_at IS NULL').run(now,id);
    this.db.prepare("UPDATE notification_outbox SET status='failed',error='Review no longer eligible' WHERE review_id=? AND status='queued'").run(id);
  }

  async flush(): Promise<void> {
    if (this.closed) return;
    if (this.flushing) return this.flushing;
    this.flushing = this.flushDue().finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async flushDue() {
    if (this.closed) return;
    this.queueReminders();
    const rows = this.db.prepare(`SELECT o.id FROM notification_outbox o WHERE o.status='queued' AND o.next_at<=? ORDER BY o.created_at LIMIT 50`).all(Date.now()) as any[];
    for (const row of rows) {
      if (this.closed) return;
      const current = this.db.prepare(`SELECT o.*,s.endpoint,s.p256dh,s.auth,r.member_name,COALESCE(r.target_id,o.review_id) target_id,r.resolved_at
        FROM notification_outbox o LEFT JOIN notification_subscriptions s ON s.id=o.subscription_id LEFT JOIN notification_reviews r ON r.id=o.review_id
        WHERE o.id=? AND o.status='queued'`).get(row.id) as any;
      if (!current) continue;
      const settings = this.db.prepare('SELECT enabled,public_key,private_key FROM notification_settings WHERE id=1').get() as any;
      if (!settings.enabled) return;
      if (!current.endpoint) { this.db.prepare("UPDATE notification_outbox SET status='failed',error='Subscription removed' WHERE id=? AND status='queued'").run(row.id); continue; }
      if (current.review_id && current.resolved_at) { this.db.prepare("UPDATE notification_outbox SET status='failed',error='Review resolved' WHERE id=? AND status='queued'").run(row.id); continue; }
      if (current.review_id && !this.reviewEligible(current.target_id ?? current.review_id)) { this.cancelReview(current.review_id); continue; }
      const { endpoint, p256dh, auth, member_name: memberName, target_id: targetId } = current;
      const body = current.kind === 'test' ? 'This is a Vibe Hub notification test.' : `${memberName} has a task waiting for review. Shared backup is paused.`;
      const payload = JSON.stringify({title:'Vibe Hub · Review needed',body,url:`${this.baseUrl}/#reviews${targetId?`?review=${encodeURIComponent(targetId)}`:''}`,tag:targetId ?? current.id});
      if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) { this.db.prepare("UPDATE notification_outbox SET status='failed',error='Payload too large' WHERE id=?").run(row.id); continue; }
      try {
        const result = await this.sender({endpoint,keys:{p256dh,auth}},payload,{vapidDetails:{subject:this.subject,publicKey:settings.public_key,privateKey:settings.private_key}});
        if (this.closed) return;
        if (!(this.db.prepare("SELECT 1 FROM notification_outbox WHERE id=? AND status='queued'").get(row.id))) continue;
        if (result?.statusCode === 404 || result?.statusCode === 410) {
          this.db.prepare('DELETE FROM notification_subscriptions WHERE id=?').run(current.subscription_id);
          this.db.prepare("UPDATE notification_outbox SET status='failed',error='Subscription expired' WHERE subscription_id=? AND status='queued'").run(current.subscription_id);
          this.db.prepare("UPDATE notification_outbox SET status='failed',error='Subscription expired' WHERE id=?").run(row.id);
        } else if (result?.statusCode && result.statusCode >= 400) throw Object.assign(new Error(`Push service returned ${result.statusCode}`), {statusCode:result.statusCode,headers:result.headers});
        else this.db.prepare("UPDATE notification_outbox SET status='accepted',accepted_at=?,attempts=attempts+1 WHERE id=?").run(Date.now(),row.id);
      } catch (error) {
        if (this.closed) return;
        if (!(this.db.prepare("SELECT 1 FROM notification_outbox WHERE id=? AND status='queued'").get(row.id))) continue;
        const attempt = current.attempts + 1;
        const statusCode = (error as any)?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          this.db.prepare('DELETE FROM notification_subscriptions WHERE id=?').run(current.subscription_id);
          this.db.prepare("UPDATE notification_outbox SET status='failed',attempts=?,error='Subscription expired' WHERE subscription_id=? AND status='queued'").run(attempt,current.subscription_id);
          this.db.prepare("UPDATE notification_outbox SET status='failed',attempts=?,error='Subscription expired' WHERE id=?").run(attempt,row.id);
        } else if (attempt >= MAX_ATTEMPTS) this.db.prepare("UPDATE notification_outbox SET status='failed',attempts=?,error=? WHERE id=?").run(attempt,typeof statusCode === 'number' ? `Push service returned ${statusCode}` : 'Push request failed',row.id);
        else this.db.prepare("UPDATE notification_outbox SET attempts=?,next_at=?,error=? WHERE id=?").run(attempt,Date.now()+retryDelay((error as any)?.headers,attempt),typeof statusCode === 'number' ? `Push service returned ${statusCode}` : 'Push request failed',row.id);
      }
    }
  }

  close() { if (this.closed) return; this.closed = true; clearInterval(this.timer); }
}
