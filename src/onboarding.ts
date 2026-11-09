import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { CliProxy } from './cliproxy.ts';
import type { Store } from './store.ts';
import { HttpError, type Member, type Provider } from './types.ts';

// Each login gets an empty, isolated CLIProxy instance. A provider's filename may
// already exist in the main pool: logging in must never overwrite or claim it.
export interface LoginSession {
  management(path: string, body?: unknown): Promise<any>;
  dispose(): Promise<void>;
}
export type LoginFactory = () => Promise<LoginSession>;
export function isolatedLoginFactory(binary: string, root: string): LoginFactory {
  root = resolve(root);
  return async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(join(root, 'login-'));
    let child: ChildProcess | undefined;
    let disposing: Promise<void> | undefined;
    const dispose = () => disposing ??= (async () => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const process = child;
        await new Promise<void>(done => {
          const timer = setTimeout(() => process.kill('SIGKILL'), 2000);
          process.once('exit', () => { clearTimeout(timer); done(); });
          process.kill('SIGTERM');
        });
      }
      await rm(directory, { recursive: true, force: true });
    })();
    try {
      const reservation = createServer();
      await new Promise<void>((ok, fail) => { reservation.once('error', fail); reservation.listen(0, '127.0.0.1', ok); });
      const port = (reservation.address() as { port: number }).port;
      await new Promise<void>((ok, fail) => reservation.close(error => error ? fail(error) : ok()));
      const key = randomBytes(32).toString('base64url');
      await mkdir(join(directory, 'auths'), { mode: 0o700 });
      await writeFile(join(directory, 'config.json'), JSON.stringify({ host: '127.0.0.1', port,
        'auth-dir': join(directory, 'auths'), 'api-keys': [randomBytes(32).toString('base64url')],
        'remote-management': { 'allow-remote': false, 'secret-key': key, 'disable-control-panel': true },
        debug: false, 'logging-to-file': false, 'request-retry': 0 }), { mode: 0o600 });
      child = spawn(resolve(binary), ['--config', join(directory, 'config.json'), '--local-model'], { stdio: 'ignore' });
      let failed = false; child.once('error', () => { failed = true; });
      const request = async (path: string, body?: unknown, timeout = 15000) => {
        const response = await fetch(`http://127.0.0.1:${port}/v0/management/${path}`, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'error',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeout),
        });
        if (!response.ok) throw new Error('Login service request failed');
        return response.json();
      };
      // Short, bounded startup readiness check; no provider requests are made here.
      for (let i = 0; i < 40; i++) {
        if (failed || child.exitCode !== null || child.signalCode !== null) throw new Error('Login service exited');
        try { await request('auth-files', undefined, 500); return { management: request, dispose }; } catch { await new Promise(ok => setTimeout(ok, 100)); }
      }
      throw new Error('Login service startup timed out');
    } catch { await dispose(); throw new HttpError(503, 'Account sign-in is unavailable. Try again shortly.'); }
  };
}
interface Job {
  id: string; memberId: string; keyHash: string; provider: Provider; state: string; redirect: URL;
  expires: number; login: LoginSession; timer: ReturnType<typeof setTimeout>;
  result?: 'ok' | 'error'; finishing?: Promise<'wait' | 'ok' | 'error'>;
}
export class Onboarding {
  private jobs = new Map<string, Job>();
  private starting = new Set<string>();
  private store: Store; private proxy: CliProxy; private factory: LoginFactory;
  constructor(store: Store, proxy: CliProxy, factory: LoginFactory) { this.store = store; this.proxy = proxy; this.factory = factory; }
  private authorized(member: Member) {
    const current = this.store.member(member.id);
    if (current.keyHash !== member.keyHash || current.paused || (current.expiresAt && current.expiresAt <= Date.now())) throw new HttpError(403, 'Account connection is not allowed for this key');
  }
  private job(member: Member, id: string): Job {
    this.authorized(member);
    const job = this.jobs.get(id);
    if (!job || job.memberId !== member.id || job.keyHash !== member.keyHash || job.expires <= Date.now()) throw new HttpError(404, 'Sign-in expired. Start again.');
    return job;
  }
  async start(member: Member, provider: Provider) {
    this.authorized(member);
    if (this.starting.has(member.id) || [...this.jobs.values()].some(j => j.memberId === member.id && !j.result)) throw new HttpError(409, 'Finish or cancel your current sign-in first');
    if (this.jobs.size + this.starting.size >= 8) throw new HttpError(429, 'Too many account sign-ins. Try again shortly.');
    this.starting.add(member.id);
    let login: LoginSession | undefined;
    try {
      login = await this.factory(); this.authorized(member);
      const result = await login.management(provider === 'codex' ? 'codex-auth-url' : 'anthropic-auth-url');
      const url = new URL(result.url);
      const expected = provider === 'codex' ? 'auth.openai.com' : 'claude.ai';
      if (url.protocol !== 'https:' || url.hostname !== expected || !result.state || url.searchParams.get('state') !== result.state) throw new Error('Invalid provider sign-in');
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
      if (redirect.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(redirect.hostname)) throw new Error('Invalid provider redirect');
      const id = randomUUID();
      const timer = setTimeout(() => void this.cancelInternal(id).catch(() => {}), 5 * 60_000); timer.unref();
      this.jobs.set(id, { id, memberId: member.id, keyHash: member.keyHash, provider, state: result.state, redirect, expires: Date.now() + 5 * 60_000, login, timer });
      return { url: url.href, state: id };
    } catch (error) {
      await login?.dispose();
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, 'Could not start provider sign-in');
    } finally { this.starting.delete(member.id); }
  }
  async callback(member: Member, id: string, redirectUrl: string) {
    const job = this.job(member, id);
    if (job.result || job.finishing) throw new HttpError(409, 'This sign-in is already being completed');
    let redirect: URL;
    try { redirect = new URL(redirectUrl); } catch { throw new HttpError(400, 'Paste the complete localhost callback URL'); }
    if (redirect.origin !== job.redirect.origin || redirect.pathname !== job.redirect.pathname || redirect.searchParams.get('state') !== job.state || !redirect.searchParams.get('code') || redirect.searchParams.has('error')) throw new HttpError(400, 'The callback does not match this sign-in');
    try { await job.login.management('oauth-callback', { provider: job.provider, redirect_url: redirect.href }); }
    catch { throw new HttpError(502, 'Provider callback was not accepted. Start sign-in again.'); }
  }
  async status(member: Member, id: string): Promise<'wait' | 'ok' | 'error'> {
    const job = this.job(member, id);
    if (job.result) return job.result;
    if (job.finishing) return job.finishing;
    job.finishing = this.finish(member, job).finally(() => { job.finishing = undefined; });
    return job.finishing;
  }
  private async finish(member: Member, job: Job): Promise<'wait' | 'ok' | 'error'> {
    try {
      const result = await job.login.management(`get-auth-status?state=${encodeURIComponent(job.state)}`);
      if (result.status === 'wait') return 'wait';
      if (result.status !== 'ok') throw new Error('Provider rejected sign-in');
      const inventory = await job.login.management('auth-files');
      const files = (inventory.files ?? []).filter((a: any) => a.provider === job.provider);
      if (files.length !== 1 || typeof files[0].name !== 'string') throw new Error('Missing completed sign-in');
      const credential = await job.login.management(`auth-files/download?name=${encodeURIComponent(files[0].name)}`);
      if (credential.type !== job.provider || typeof credential.access_token !== 'string' || !credential.access_token) throw new Error('Invalid credential');
      this.job(member, job.id); // Re-check key, expiry and pause after async work.
      const name = `member-${job.provider}-${randomUUID()}.json`;
      const fields = ['type', 'access_token', 'refresh_token', 'id_token', 'account_id', 'email', 'expired', 'expire', 'last_refresh', 'plan_type', 'account_uuid', 'organization_uuid', 'organization_name', 'claude_device_ids'];
      const safe = Object.fromEntries(fields.filter(k => credential[k] !== undefined).map(k => [k, credential[k]]));
      // Keep credentials disabled until the actual ID is assigned to this member.
      this.store.setOwner(name, member.id);
      await this.proxy.management(`auth-files?name=${encodeURIComponent(name)}`, { ...safe, disabled: true });
      const registered = await this.proxy.management('auth-files');
      const account = registered.files?.find((a: any) => a.name === name);
      if (!account || typeof account.id !== 'string') throw new Error('Registration not confirmed');
      this.store.setOwner(account.id, member.id);
      this.job(member, job.id);
      await this.proxy.management('auth-files/status', { name, disabled: false }, 'PATCH');
      await this.proxy.sync();
      job.result = 'ok';
    } catch { job.result = 'error'; }
    await job.login.dispose();
    return job.result;
  }
  async cancel(member: Member, id: string) { const job = this.job(member, id); if (job.finishing) throw new HttpError(409, 'Sign-in is finishing'); await this.cancelInternal(id); }
  private async cancelInternal(id: string) { const job = this.jobs.get(id); if (!job) return; this.jobs.delete(id); clearTimeout(job.timer); await job.login.dispose(); }
  async close() { await Promise.allSettled([...this.jobs.keys()].map(id => this.cancelInternal(id))); }
}
