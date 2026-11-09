import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { HttpError, type Member, type Settings, type RequestDetails } from './types.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
export const hash = (key: string) => createHash('sha256').update(key).digest('hex');
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, at INTEGER NOT NULL, member_id TEXT NOT NULL, member_name TEXT NOT NULL, model TEXT NOT NULL, account_id TEXT, status INTEGER NOT NULL, duration INTEGER NOT NULL, reason TEXT);
      CREATE INDEX IF NOT EXISTS events_at ON events(at);
      CREATE TABLE IF NOT EXISTS routing (id TEXT PRIMARY KEY, prefix TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_owners (id TEXT PRIMARY KEY, member_id TEXT);
      INSERT OR IGNORE INTO settings VALUES (1, '{"paused":false,"safetyMargin":2}');`);
    const columns = this.db.prepare('PRAGMA table_info(events)').all() as { name: string }[];
    if (!columns.some(column => column.name === 'details')) this.db.exec('ALTER TABLE events ADD COLUMN details TEXT');
  }
  settings(): Required<Settings> { return { ...DEFAULT_SETTINGS, ...JSON.parse((this.db.prepare('SELECT data FROM settings WHERE id=1').get() as any).data) }; }
  setSettings(value: Settings) { this.db.prepare('UPDATE settings SET data=? WHERE id=1').run(JSON.stringify(value)); }
  members(): Member[] { return this.db.prepare('SELECT data FROM members').all().map((r: any) => ({ fallbackOnly: true, personalSwitchPercent: 100, personalSwitchWindow: 'both', ...JSON.parse(r.data) })); }
  member(id: string): Member {
    const r = this.db.prepare('SELECT data FROM members WHERE id=?').get(id) as any;
    if (!r) throw new HttpError(404, 'Person not found');
    return { fallbackOnly: true, personalSwitchPercent: 100, personalSwitchWindow: 'both', ...JSON.parse(r.data) };
  }
  authenticate(key: string) { const keyHash = hash(key); return this.members().find(m => m.keyHash === keyHash); }
  save(member: Member) { this.db.prepare('INSERT OR REPLACE INTO members VALUES (?,?)').run(member.id, JSON.stringify(member)); }
  create(input: Omit<Member, 'id' | 'keyHash' | 'keyHint' | 'createdAt'>) {
    const key = `vcp_${randomBytes(32).toString('base64url')}`;
    const member: Member = { personalSwitchPercent: 100, personalSwitchWindow: 'both', ...input, id: randomUUID(), keyHash: hash(key), keyHint: key.slice(-6), createdAt: Date.now() };
    this.save(member); return { member, key };
  }
  rotate(id: string) {
    const member = this.member(id); const key = `vcp_${randomBytes(32).toString('base64url')}`;
    member.keyHash = hash(key); member.keyHint = key.slice(-6); this.save(member); return key;
  }
  remove(id: string) { this.member(id); this.db.prepare('DELETE FROM members WHERE id=?').run(id); }
  prefix(id: string): string | undefined { return (this.db.prepare('SELECT prefix FROM routing WHERE id=?').get(id) as any)?.prefix; }
  savePrefix(id: string, prefix: string) { this.db.prepare('INSERT OR REPLACE INTO routing VALUES (?,?)').run(id, prefix); }
  owner(id: string): string | null { return (this.db.prepare('SELECT member_id FROM account_owners WHERE id=?').get(id) as any)?.member_id ?? null; }
  setOwner(id: string, memberId: string | null) { this.db.prepare('INSERT OR REPLACE INTO account_owners VALUES (?,?)').run(id, memberId); }
  event(member: Member, model: string, accountId: string | null, status: number, duration: number, reason: string | null = null, details?: RequestDetails, id = randomUUID()) {
    this.db.prepare(`INSERT INTO events (id,at,member_id,member_name,model,account_id,status,duration,reason,details)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      model=excluded.model,account_id=excluded.account_id,status=excluded.status,duration=excluded.duration,reason=excluded.reason,details=excluded.details`)
      .run(id, Date.now(), member.id, member.name, model, accountId, status, duration, reason, details ? JSON.stringify(details) : null);
  }
  progress(id: string, model: string, accountId: string | null, details: RequestDetails) {
    this.db.prepare('UPDATE events SET model=?,account_id=?,duration=?,details=? WHERE id=? AND status=102')
      .run(model, accountId, Date.now() - details.startedAt, JSON.stringify(details), id);
  }
  interruptPending() {
    const now = Date.now();
    this.db.prepare(`UPDATE events SET status=503,reason='hub_restarting',duration=?-at,
      details=CASE WHEN json_valid(details) THEN json_set(details,'$.state','finished','$.finishedAt',?) ELSE NULL END WHERE status=102`).run(now, now);
  }
  private decodeHistory(rows: unknown[]) {
    return rows.map((row: any) => ({ ...row, details: row.details ? JSON.parse(row.details) : null }));
  }
  history(limit = 100) { return this.decodeHistory(this.db.prepare('SELECT * FROM events ORDER BY at DESC LIMIT ?').all(limit)); }
  memberHistory(id: string) { return this.db.prepare('SELECT * FROM events WHERE member_id=? ORDER BY at DESC LIMIT 100').all(id); }
  memberSummary(id: string) {
    const since = Date.now() - 86400_000;
    return { today: this.db.prepare('SELECT COUNT(*) AS requests, SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS successful, SUM(CASE WHEN status=429 THEN 1 ELSE 0 END) AS blocked FROM events WHERE at>? AND member_id=?').get(since, id),
      hourly: this.db.prepare('SELECT CAST(at/3600000 AS INTEGER)*3600000 AS hour, COUNT(*) AS requests FROM events WHERE at>? AND member_id=? GROUP BY hour ORDER BY hour').all(since, id) };
  }
  summary() {
    const since = Date.now() - 86400_000;
    return { today: this.db.prepare('SELECT COUNT(*) AS requests, SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) AS successful, SUM(CASE WHEN status=429 THEN 1 ELSE 0 END) AS blocked FROM events WHERE at>?').get(since),
      hourly: this.db.prepare('SELECT CAST(at/3600000 AS INTEGER)*3600000 AS hour, COUNT(*) AS requests, SUM(CASE WHEN status=429 THEN 1 ELSE 0 END) AS blocked FROM events WHERE at>? GROUP BY hour ORDER BY hour').all(since),
      members: this.db.prepare('SELECT member_id, COUNT(*) AS requests FROM events WHERE at>? GROUP BY member_id').all(since) };
  }
  prune() {
    this.db.prepare('DELETE FROM events WHERE at<?').run(Date.now() - 90 * 86400_000);
    this.db.prepare(`UPDATE events SET details=json_remove(details,'$.promptPreview')
      WHERE at<? AND json_valid(details) AND json_type(details,'$.promptPreview') IS NOT NULL`).run(Date.now() - 7 * 86400_000);
  }
  close() { this.db.close(); }
}
export function publicMember(member: Member) { const { keyHash, ...safe } = member; return safe; }
