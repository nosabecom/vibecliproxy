import type { RequestLimits, Settings } from './types.ts';

export const REQUEST_LIMITS = {
  queueWaitSeconds: {
    label: 'Queue wait', unit: 'seconds', default: 180, min: 0, max: 600,
    description: 'How long a request waits for an account slot. Increase this to let overlapping chats wait longer. At the limit, the hub returns HTTP 429. Zero skips waiting.',
  },
  maxQueuedRequests: {
    label: 'Queue capacity', unit: 'requests', default: 8, min: 0, max: 64,
    description: 'Maximum waiting requests across the hub. Increase this to accept larger bursts. A full queue returns HTTP 429 immediately. Zero disables the queue.',
  },
  concurrentRequestsPerAccount: {
    label: 'Parallel requests per account', unit: 'requests', default: 1, min: 1, max: 8,
    description: 'How many requests can use one account at once. Increase this to run chats together. More parallel requests can overshoot a usage ceiling further before quota updates arrive. Lowering it lets current requests finish.',
  },
  providerTimeoutSeconds: {
    label: 'Provider timeout', unit: 'seconds', default: 600, min: 15, max: 1800,
    description: 'Maximum time for an admitted provider request, including its stream. Increase this for longer generations. At the limit, the hub stops the provider call and records HTTP 504. Queue time is separate.',
  },
  maxInputMiB: {
    label: 'Request body limit', unit: 'MiB', default: 64, min: 1, max: 128,
    description: 'Largest model or compaction request body. Increase this for large histories or images, using more server memory. Larger requests return HTTP 413. Provider context limits still apply.',
  },
  maxOutputTokens: {
    label: 'Output token ceiling', unit: 'tokens', default: 8192, min: 1, max: 131072,
    description: 'Maximum output tokens requested per generation. Smaller client limits are preserved. Increase this for longer responses and potentially more usage. Some subscription routes use provider-controlled generation limits instead.',
  },
} as const satisfies Record<keyof RequestLimits, { label: string; unit: string; default: number; min: number; max: number; description: string }>;

export const DEFAULT_SETTINGS: Required<Settings> = {
  paused: false,
  safetyMargin: 2,
  promptPreviews: false,
  ...Object.fromEntries(Object.entries(REQUEST_LIMITS).map(([key, limit]) => [key, limit.default])) as unknown as RequestLimits,
};
