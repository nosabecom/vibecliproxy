import { createHash } from 'node:crypto';
import type { CliProxy } from './cliproxy.ts';
import type { Store } from './store.ts';
import { eligibility, quotaFresh, personalSwitchReached } from './quota.ts';
import { HttpError, type Member, type Account } from './types.ts';

const CODEX = 'https://chatgpt.com/backend-api/wham';
const CLAUDE = 'https://api.anthropic.com/api/oauth/usage';
export function usageId(account: Account, member: Member): string {
  return createHash('sha256').update(`${member.id}:${account.id}`).digest('hex').slice(0, 32);
}
function visible(accounts: Account[], member: Member) {
  return accounts.filter(a => a.ownerMemberId === member.id || (a.ownerMemberId === null && (!member.accountIds.length || member.accountIds.includes(a.id))));
}
export function usageInventory(proxy: CliProxy, member: Member) {
  return { files: visible(proxy.accounts, member).map((account, index) => ({ id: `vibe-${usageId(account, member)}`, auth_index: usageId(account, member),
    provider: account.provider, email: account.ownerMemberId === member.id ? account.email : `Shared backup ${index + 1}`, disabled: !account.enabled })) };
}
// Implements only T3's read-only quota contract. Never forwards caller-supplied
// URLs, headers, methods or tokens to CLIProxy's unrestricted management API.
export function usageCall(proxy: CliProxy, store: Store, member: Member, body: Record<string, any>) {
  if (body.method !== 'GET' || body.data !== undefined) throw new HttpError(403, 'Only quota reads are allowed');
  const account = visible(proxy.accounts, member).find(a => usageId(a, member) === body.auth_index);
  if (!account) throw new HttpError(404, 'Account not found');
  const credits = account.provider === 'codex' && body.url === `${CODEX}/rate-limit-reset-credits`;
  if (!credits && body.url !== (account.provider === 'codex' ? `${CODEX}/usage` : CLAUDE)) throw new HttpError(403, 'Only quota reads are allowed');
  const wrap = (status_code: number, value: unknown) => ({ status_code, header: {}, body: JSON.stringify(value) });
  if (credits) return wrap(200, { credits: [] }); // Members cannot see or spend owner's reset credits.
  if (proxy.error || !quotaFresh(account)) return wrap(503, { error: 'A fresh quota reading is unavailable' });
  const settings = store.settings(), own = account.ownerMemberId === member.id;
  const primary = proxy.accounts.filter(a => a.ownerMemberId === member.id && a.provider === account.provider);
  const backupLocked = !own && (member.personalOnly || member.backupPaused || settings.paused || !account.available ||
    (member.fallbackOnly && (!primary.length || !primary.every(a => personalSwitchReached(a, member)))));
  const ceiling = Math.max(0, member.sharePercent - settings.safetyMargin);
  const used = (percent: number) => own ? percent : backupLocked || ceiling <= 0 ? 100 : Math.min(100, percent / ceiling * 100);
  // Scoped constraints must also stop the shared allowance, even in clients that
  // render only session/weekly totals.
  const closed = !own && !eligibility(account, member, settings.safetyMargin).allowed;
  const toUsed = (percent: number) => closed ? 100 : used(percent);
  if (account.provider === 'codex') {
    const windows = account.windows.filter(w => w.id === 'primary_window' || w.id === 'secondary_window');
    if (!windows.length) return wrap(503, { error: 'Quota window format is unavailable' });
    return wrap(200, { plan_type: 'vibe', rate_limit: Object.fromEntries(windows.map(w => [w.id, { used_percent: toUsed(w.usedPercent),
      reset_at: Math.floor(w.resetsAt / 1000), limit_window_seconds: w.label === 'Weekly' ? 604800 : (parseFloat(w.label) || 5) * 3600 }])) });
  }
  const windows = account.windows.filter(w => w.id === 'five_hour' || w.id === 'seven_day');
  return wrap(200, { ...Object.fromEntries(windows.map(w => [w.id, { utilization: toUsed(w.usedPercent), resets_at: new Date(w.resetsAt).toISOString() }])),
    limits: account.windows.filter(w => !windows.includes(w)).map(w => ({ kind: 'weekly_scoped', percent: toUsed(w.usedPercent), resets_at: new Date(w.resetsAt).toISOString(), scope: { model: { display_name: w.label } } })) });
}
