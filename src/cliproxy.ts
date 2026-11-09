import { createHash } from 'node:crypto';
import { parseQuota } from './quota.ts';
import { HttpError, type Account, type Provider } from './types.ts';
import type { Store } from './store.ts';

export interface ProxyConfig { url: string; apiKey: string; managementKey: string }
export class CliProxy {
  accounts: Account[] = [];
  lastSync = 0;
  error: string | null = null;
  private syncing?: Promise<void>;
  private nextProbe = new Map<string, number>();
  private removed = new Set<string>();
  config: ProxyConfig;
  private store: Store;
  constructor(config: ProxyConfig, store: Store) { this.config = config; this.store = store; }
  async management(path: string, body?: unknown, method?: string): Promise<any> {
    let response: Response;
    try {
      response = await fetch(`${this.config.url}/v0/management/${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'), redirect: 'error',
        headers: { Authorization: `Bearer ${this.config.managementKey}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
      });
    } catch { throw new HttpError(503, 'CLIProxy is unreachable. Check its service on the host.', 'upstream_unavailable'); }
    if (!response.ok) throw new HttpError(503, `CLIProxy management returned HTTP ${response.status}.`, 'management_error');
    return response.json();
  }
  async sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = this.doSync().finally(() => { this.syncing = undefined; });
    return this.syncing;
  }
  async removeAccount(id: string, authorize: (account: Account) => void): Promise<void> {
    // Finish an older inventory read before resolving ownership and the filename.
    await this.syncing;
    const account = this.accounts.find(a => a.id === id);
    if (!account) throw new HttpError(404, 'Account not found');
    authorize(account);
    this.removed.add(id);
    this.accounts = this.accounts.filter(a => a.id !== id);
    try {
      // The filename comes from the trusted inventory, never from the caller.
      await this.management(`auth-files?name=${encodeURIComponent(account.name)}`, undefined, 'DELETE');
      this.nextProbe.delete(id);
    } catch (error) {
      this.removed.delete(id);
      if (!this.accounts.some(a => a.id === id)) this.accounts.push({ ...account, ownerMemberId: this.store.owner(id) });
      throw error;
    }
  }
  private async doSync() {
    try {
      const result = await this.management('auth-files');
      if (!Array.isArray(result.files)) throw new Error('Account inventory unavailable');
      const next: Account[] = [];
      for (const raw of result.files) {
        if (!['codex', 'claude'].includes(raw.provider) || typeof raw.id !== 'string' || typeof raw.auth_index !== 'string' || this.removed.has(raw.id)) continue;
        const previous = this.accounts.find(a => a.id === raw.id);
        const provider = raw.provider as Provider;
        const prefix = `vcp-${createHash('sha256').update(raw.id).digest('hex').slice(0, 16)}`;
        const account: Account = { id: raw.id, name: String(raw.name ?? raw.id), email: String(raw.email ?? raw.label ?? provider), provider, prefix,
          enabled: !raw.disabled, available: !raw.disabled && !raw.unavailable, windows: previous?.windows ?? [], checkedAt: previous?.checkedAt ?? 0,
          ownerMemberId: this.store.owner(raw.id),
          models: previous?.models ?? [], ...(previous?.error ? { error: previous.error } : {}) };
        next.push(account);
        if (!account.enabled) continue;
        try {
          // This is a dedicated hub instance. A unique model prefix prevents routing into a different account's reserve.
          if (this.store.prefix(raw.id) !== prefix) {
            await this.management('auth-files/fields', { name: account.name, prefix }, 'PATCH');
            this.store.savePrefix(raw.id, prefix);
          }
          const catalog = await this.management(`auth-files/models?name=${encodeURIComponent(account.name)}`);
          account.models = (Array.isArray(catalog.models) ? catalog.models : []).map((m: any) => m.id).filter((id: unknown): id is string => typeof id === 'string' && id.startsWith(`${prefix}/`)).map((id: string) => id.slice(prefix.length + 1));
          if (Date.now() < (this.nextProbe.get(account.id) ?? 0)) continue;
          // Pacing applies to failures and manual refresh too, to avoid hammering provider quota endpoints.
          this.nextProbe.set(account.id, Date.now() + 60_000);
          const header: Record<string, string> = { Authorization: 'Bearer $TOKEN$' };
          if (provider === 'codex') {
            header['OpenAI-Beta'] = 'codex-1'; header.Originator = 'Codex Desktop';
            const accountId = raw.id_token?.chatgpt_account_id;
            if (typeof accountId === 'string') header['Chatgpt-Account-Id'] = accountId;
          } else {
            header['anthropic-beta'] = 'oauth-2025-04-20'; header['User-Agent'] = 'claude-code/2.1.273';
          }
          const probe = await this.management('api-call', { auth_index: raw.auth_index, method: 'GET',
            url: provider === 'codex' ? 'https://chatgpt.com/backend-api/wham/usage' : 'https://api.anthropic.com/api/oauth/usage', header });
          if (probe.status_code !== 200) {
            if (probe.status_code === 429) {
              const retryValue = probe.header?.['Retry-After']?.[0] ?? probe.header?.['retry-after']?.[0];
              const seconds = Number(retryValue);
              const retryAt = Number.isFinite(seconds) && seconds > 0 ? Date.now() + seconds * 1000 : Date.parse(retryValue);
              this.nextProbe.set(account.id, Math.max(Date.now() + 300_000, Number.isFinite(retryAt) ? retryAt : 0));
            }
            throw new Error(`Provider quota returned HTTP ${Number(probe.status_code) || 'unknown'}`);
          }
          account.windows = parseQuota(provider, JSON.parse(probe.body));
          account.checkedAt = Date.now(); delete account.error;
        } catch (error) {
          account.error = error instanceof HttpError ? error.message : error instanceof Error && /^(Provider|Quota)/.test(error.message) ? error.message : 'Could not read quota or prepare account routing';
        }
      }
      this.accounts = next.filter(a => !this.removed.has(a.id)).map(a => ({ ...a, ownerMemberId: this.store.owner(a.id) })); this.error = null; this.lastSync = Date.now();
    } catch (error) {
      this.error = error instanceof HttpError ? error.message : 'Could not read account inventory';
      // Never authorize from a cached inventory after a management failure.
      this.accounts = this.accounts.map(a => ({ ...a, error: 'Account inventory is unavailable' }));
    }
  }
}
