export type Provider = 'codex' | 'claude';
export type QuotaPeriod = 'hourly' | 'weekly';
export interface QuotaWindow { id: string; label: string; usedPercent: number; resetsAt: number; period?: QuotaPeriod }
export interface Account {
  id: string; name: string; email: string; provider: Provider; prefix: string;
  enabled: boolean; available: boolean; windows: QuotaWindow[]; checkedAt: number;
  error?: string; models: string[];
  ownerMemberId: string | null;
}
export interface Member {
  id: string; name: string; keyHash: string; keyHint: string; sharePercent: number;
  paused: boolean; allowedModels: string[]; accountIds: string[]; expiresAt: number | null;
  rpm: number; createdAt: number;
  fallbackOnly: boolean;
  personalSwitchPercent?: number;
  personalSwitchWindow?: QuotaPeriod | 'both';
  personalOnly?: boolean;
  backupPaused?: boolean;
}
export interface RequestLimits {
  queueWaitSeconds: number;
  maxQueuedRequests: number;
  concurrentRequestsPerAccount: number;
  providerTimeoutSeconds: number;
  maxInputMiB: number;
  maxOutputTokens: number;
}
export interface Settings extends Partial<RequestLimits> { paused: boolean; safetyMargin: number; promptPreviews?: boolean }
export interface RequestDetails {
  method: string; path: string; state: 'receiving' | 'queued' | 'running' | 'finished';
  startedAt: number; finishedAt?: number; declaredBytes?: number;
  requestBytes: number; responseBytes: number; queueMs: number; firstByteMs?: number;
  client?: string; stream?: boolean; inputItems?: number; tools?: number;
  provider?: Provider; route?: 'personal' | 'shared'; accountLabel?: string;
  promptPreview?: string; errorMessage?: string; errorPhase?: string;
  reviewId?: string;
  screening?: string;
}
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'request_error') { super(message); this.status = status; this.code = code; }
}
