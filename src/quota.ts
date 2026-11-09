import type { Account, Member, QuotaWindow, QuotaPeriod } from './types.ts';

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid quota response');
  return value as Record<string, any>;
}
function window(id: string, label: string, used: unknown, reset: unknown, period?: QuotaPeriod): QuotaWindow {
  const resetsAt = typeof reset === 'number' ? reset * 1000 : typeof reset === 'string' ? Date.parse(reset) : NaN;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100 || !Number.isFinite(resetsAt)) {
    throw new Error('Quota percentage or reset time unavailable');
  }
  return { id, label, usedPercent: used, resetsAt, ...(period ? { period } : {}) };
}
function durationPeriod(seconds: unknown): QuotaPeriod | undefined {
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds >= 172800 ? 'weekly' : 'hourly' : undefined;
}
export function parseQuota(provider: 'codex' | 'claude', raw: unknown): QuotaWindow[] {
  const data = object(raw);
  const windows: QuotaWindow[] = [];
  if (provider === 'codex') {
    const limits = object(data.rate_limit);
    for (const key of ['primary_window', 'secondary_window']) {
      const w = limits[key];
      if (w != null) {
        const duration = w.limit_window_seconds;
        // Classify by duration, not position: some plans report only a weekly primary window.
        const label = typeof duration === 'number' ? duration >= 172800 ? 'Weekly' : `${Math.round(duration / 3600)} hour` : key === 'primary_window' ? 'Primary' : 'Secondary';
        windows.push(window(key, label, w.used_percent, w.reset_at, durationPeriod(duration)));
      }
    }
    // Any extra reported limit can constrain the account, including model-specific windows.
    for (const [i, extra] of (Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits : []).entries()) {
      const rate = extra.rate_limit;
      if (!rate) continue;
      for (const key of ['primary_window', 'secondary_window']) if (rate[key]) {
        windows.push(window(`extra-${i}-${key}`, String(extra.limit_name ?? 'Additional limit'), rate[key].used_percent, rate[key].reset_at, durationPeriod(rate[key].limit_window_seconds)));
      }
    }
  } else {
    for (const key of ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus', 'seven_day_oauth_apps']) {
      const w = data[key];
      if (w != null) windows.push(window(key, key === 'five_hour' ? '5 hour' : key === 'seven_day' ? 'Weekly' : key.replaceAll('_', ' '), w.utilization, w.resets_at, key === 'five_hour' ? 'hourly' : 'weekly'));
    }
    for (const [i, w] of (Array.isArray(data.limits) ? data.limits : []).entries()) {
      if (w.percent != null) windows.push(window(`limit-${i}`, w.scope?.model?.display_name ?? w.kind ?? 'Additional limit', w.percent, w.resets_at,
        typeof w.kind === 'string' && /week/i.test(w.kind) ? 'weekly' : typeof w.kind === 'string' && /hour|session/i.test(w.kind) ? 'hourly' : undefined));
    }
  }
  if (!windows.length) throw new Error('Provider did not report subscription limits');
  return windows;
}

export function eligibility(account: Account, member: Member, safetyMargin: number, now = Date.now()): { allowed: boolean; reason: string; headroom: number } {
  if (account.ownerMemberId && account.ownerMemberId !== member.id) return { allowed: false, reason: 'This personal account belongs to someone else', headroom: 0 };
  if (!account.enabled || !account.available) return { allowed: false, reason: 'Account is unavailable', headroom: 0 };
  if (member.accountIds.length && !member.accountIds.includes(account.id)) return { allowed: false, reason: 'Account is not shared with this person', headroom: 0 };
  if (account.error || !account.windows.length || now - account.checkedAt > 120_000) return { allowed: false, reason: 'A fresh quota reading is required', headroom: 0 };
  if (account.windows.some(w => w.resetsAt <= now)) return { allowed: false, reason: 'Waiting for the provider to confirm a new window', headroom: 0 };
  const headroom = Math.min(...account.windows.map(w => member.sharePercent - safetyMargin - w.usedPercent));
  return { allowed: headroom > 0, reason: headroom > 0 ? 'Within shared ceiling' : 'Protected reserve reached', headroom: Math.max(0, headroom) };
}

export function quotaFresh(account: Account, now = Date.now()): boolean {
  return account.enabled && !account.error && account.windows.length > 0 && now - account.checkedAt <= 120_000 && account.windows.every(w => w.resetsAt > now);
}

// A transport failure, a busy account, or missing quota never proves exhaustion.
export function exhausted(account: Account, now = Date.now()): boolean {
  return quotaFresh(account, now) && account.windows.some(w => w.usedPercent >= 100);
}

export function personalSwitchReached(account: Account, member: Member, now = Date.now()): boolean {
  const selected = member.personalSwitchWindow ?? 'both';
  // Physical exhaustion always requires another account, even outside the selected period.
  return quotaFresh(account, now) && account.windows.some(w => w.usedPercent >= 100 ||
    ((selected === 'both' || quotaPeriod(w) === selected) && w.usedPercent >= (member.personalSwitchPercent ?? 100)));
}

export function quotaPeriod(w: QuotaWindow): QuotaPeriod | undefined {
  if (w.period) return w.period;
  // Compatibility for older readings and accounts whose provider omitted duration.
  if (/week|seven[_ -]day/i.test(`${w.id} ${w.label}`)) return 'weekly';
  if (/hour|session/i.test(`${w.id} ${w.label}`)) return 'hourly';
  return undefined;
}

export function routePool(accounts: Account[], member: Member, model: string, safetyMargin: number, now = Date.now(), sharingPaused = false): { accounts: Account[]; shared: boolean; reason: string } {
  const own = accounts.filter(a => a.ownerMemberId === member.id && a.models.includes(model));
  const personalPolicy = sharingPaused || member.personalOnly ? { ...member, personalSwitchPercent: 100 } : member;
  const ready = own.filter(a => a.available && quotaFresh(a, now) && !personalSwitchReached(a, personalPolicy, now));
  if (ready.length) return { accounts: ready, shared: false, reason: 'Personal account first' };
  if (member.personalOnly) return { accounts: [], shared: false, reason: 'Use mine is on. No personal account has fresh, available quota for this model. Shared backup is off.' };
  if (sharingPaused) return { accounts: [], shared: true, reason: 'Shared backup access is paused' };
  if (member.fallbackOnly && (!own.length || !own.every(a => personalSwitchReached(a, member, now)))) {
    return { accounts: [], shared: false, reason: !own.length ? 'Connect a personal account that supports this model before using shared backup' : `Personal usage has not been confirmed at the ${member.personalSwitchPercent ?? 100}% ${member.personalSwitchWindow ?? 'both'} switchover threshold on every account. Shared backup stays protected.` };
  }
  return { accounts: accounts.filter(a => a.ownerMemberId === null && a.models.includes(model) && eligibility(a, member, safetyMargin, now).allowed), shared: true, reason: 'Shared reserve protected' };
}
