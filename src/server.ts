import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import type { Config } from './config.ts';
import { Store, publicMember, hash } from './store.ts';
import { CliProxy } from './cliproxy.ts';
import { eligibility, routePool, exhausted, personalSwitchReached } from './quota.ts';
import { HttpError, type Account, type Member, type RequestDetails } from './types.ts';
import { verifyPassword } from './auth.ts';
import { Onboarding, isolatedLoginFactory, type LoginFactory } from './onboarding.ts';
import { usageInventory, usageCall } from './usage-hub.ts';
import { promptPreview, redactLogText } from './request-log.ts';
import { REQUEST_LIMITS } from './settings.ts';
import { activityQuery } from './activity.ts';
import type { RequestLimits } from './types.ts';
import { Reviews } from './reviews.ts';
import { taskEvidence } from './task-evidence.ts';
import { Notifications } from './notifications.ts';
import type { TaskClassifier, ScreeningResult, TaskEvidence } from './review-types.ts';

const MAX_BODY = 4 * 1024 * 1024;
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
function json(res: ServerResponse, status: number, data: unknown) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); }
async function readJson(req: IncomingMessage, limit = MAX_BODY, details?: RequestDetails): Promise<Record<string, any>> {
  const declaredSize = Number(req.headers['content-length']);
  if (declaredSize > limit) throw new HttpError(413, 'Request body is too large');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (details) details.requestBytes = size; if (size > limit) throw new HttpError(413, 'Request body is too large'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value; }
  catch { throw new HttpError(400, 'A JSON object is required'); }
}
function string(value: unknown, name: string, max = 100) { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `Invalid ${name}`); return value.trim(); }
function number(value: unknown, name: string, min: number, max: number) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`); return value; }
function strings(value: unknown, name: string): string[] { if (!Array.isArray(value) || value.length > 200 || value.some(v => typeof v !== 'string' || !v || v.length > 300)) throw new HttpError(400, `Invalid ${name}`); return [...new Set(value)]; }
function boolean(value: unknown) { if (typeof value !== 'boolean') throw new HttpError(400, 'Expected true or false'); return value; }
function memberInput(body: Record<string, any>, previous?: Member) {
  const b = { name: '', sharePercent: 20, paused: false, backupPaused: false, allowedModels: [], accountIds: [], expiresAt: null, rpm: 20, fallbackOnly: true, personalSwitchPercent: 100, personalSwitchWindow: 'both', ...previous, ...body };
  const expiresAt = b.expiresAt === null ? null : number(b.expiresAt, 'Expiry', 1, 9e15);
  if (!['hourly', 'weekly', 'both'].includes(b.personalSwitchWindow)) throw new HttpError(400, 'Choose hourly, weekly, or both for personal switchover');
  return { name: string(b.name, 'name', 60), sharePercent: number(b.sharePercent, 'Percentage', 0, 100), paused: boolean(b.paused), backupPaused: boolean(b.backupPaused),
    allowedModels: strings(b.allowedModels, 'models'), accountIds: strings(b.accountIds, 'accounts'), expiresAt, rpm: Math.floor(number(b.rpm, 'Requests per minute', 1, 6000)), fallbackOnly: boolean(b.fallbackOnly),
    personalSwitchPercent: number(b.personalSwitchPercent, 'Personal switchover percentage', 1, 100), personalSwitchWindow: b.personalSwitchWindow as NonNullable<Member['personalSwitchWindow']> };
}

export function createHub(config: Config, options: { store?: Store; proxy?: CliProxy; loginFactory?: LoginFactory; classifier?: TaskClassifier } = {}) {
  const basePath = config.basePath ?? '';
  const publicBaseUrl = () => `${config.publicOrigin}${basePath}`;
  const cookiePath = basePath || '/';
  const store = options.store ?? new Store(config.dataPath);
  const proxy = options.proxy ?? new CliProxy({ url: config.proxyUrl, apiKey: config.proxyKey, managementKey: config.managementKey }, store);
  const onboarding = new Onboarding(store, proxy, options.loginFactory ?? isolatedLoginFactory(config.oauthBinary ?? './bin/cli-proxy-api', config.oauthDirectory ?? '.data/onboarding'));
  const csrf = randomBytes(24).toString('base64url');
  const sessions = new Map<string, number>();
  const memberSessions = new Map<string, { id: string; keyHash: string; expires: number }>();
  const attempts = new Map<string, { count: number; since: number }>();
  const rates = new Map<string, number[]>();
  const busy = new Map<string, number>();
  const active = new Map<string, { memberId: string; accountId: string; controller: AbortController; shared: boolean; fingerprint?: string; approved?: boolean }>();
  const waiting = new Set<{ wake(): void; cancel(error: HttpError): void }>();
  let lastPruned = 0;
  let passwordChecks = 0;
  function isAdmin(req: IncomingMessage) {
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('vcp_session='))?.slice(12);
    return cookie !== undefined && (sessions.get(hash(cookie)) ?? 0) > Date.now();
  }
  function currentMember(req: IncomingMessage): Member | undefined {
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    if (token) return store.authenticate(token);
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('vcp_member='))?.slice(11);
    const session = cookie ? memberSessions.get(hash(cookie)) : undefined;
    if (!session || session.expires <= Date.now()) return undefined;
    return store.members().find(m => m.id === session.id && m.keyHash === session.keyHash);
  }
  function requireUsageMember(key: string): Member {
    const member = key ? store.authenticate(key) : undefined;
    if (!member) throw new HttpError(401, 'Use your personal access key as the usage hub key');
    if (member.paused || (member.expiresAt && member.expiresAt <= Date.now())) {
      throw new HttpError(403, 'This access key is inactive');
    }
    return member;
  }
  function mutate(req: IncomingMessage) {
    if (req.headers.origin && req.headers.origin !== config.publicOrigin) throw new HttpError(403, 'Cross-origin requests are not allowed');
    if (req.headers['x-csrf-token'] !== csrf) throw new HttpError(403, 'Reload the dashboard before saving');
  }
  function wakeWaitingRequests() {
    for (const request of waiting) request.wake();
  }
  function waitForAccount(signal: AbortSignal, timeout: number): Promise<void> {
    if (signal.aborted) throw new HttpError(499, 'Client disconnected', 'client_disconnected');
    if (waiting.size >= store.settings().maxQueuedRequests) throw new HttpError(429, 'The account request queue is full. Try again shortly.', 'account_busy');
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        waiting.delete(request);
      };
      const request = {
        wake() { cleanup(); resolve(); },
        cancel(error: HttpError) { cleanup(); reject(error); },
      };
      const onAbort = () => request.cancel(new HttpError(499, 'Client disconnected', 'client_disconnected'));
      const timer = setTimeout(request.wake, timeout);
      waiting.add(request);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  const stopRequests = (memberId?: string, sharedOnly = false) => {
    const cancellation = memberId || sharedOnly
      ? new HttpError(403, 'Access changed while this request was running', 'access_changed')
      : new HttpError(503, 'The hub is restarting. Try again shortly.', 'hub_restarting');
    for (const request of active.values()) {
      if ((!memberId || request.memberId === memberId) && (!sharedOnly || request.shared)) request.controller.abort(cancellation);
    }
    if (memberId || sharedOnly) wakeWaitingRequests();
    else for (const request of waiting) request.cancel(cancellation);
  };
  const notifications = new Notifications(store, { baseUrl: publicBaseUrl(), ...(config.pushSubject ? { subject: config.pushSubject } : {}),
    isReviewEligible(id) { const settings = reviews.settings(); if (!settings.enabled || settings.mode !== 'enforce') return false; try { const review = reviews.get(id); return review.status === 'pending' && review.policyVersion === reviews.policy(review.memberId).version; } catch { return false; } },
  });
  const reviews = new Reviews(store, {
    apiKey: config.decisionsApiKey, classifier: options.classifier,
    onReview(review) { if (reviews.settings().enabled && reviews.settings().mode === 'enforce') notifications.enqueueReview({ id: review.id, memberName: review.memberName, ruleName: review.ruleNames[0], generation: review.generation }); },
    onResolve(id) { notifications.resolveReview(id); },
    onHold(memberId, fingerprint, includeApproved) {
      for (const request of active.values()) if (request.shared && request.memberId === memberId && request.fingerprint === fingerprint && (!request.approved || includeApproved)) request.controller.abort(new HttpError(403, 'This task was paused for owner review', 'task_review_required'));
      wakeWaitingRequests();
    },
  });
  async function removeAccount(id: string, authorize: (account: Account) => void) {
    await proxy.removeAccount(id, authorize);
    for (const request of active.values()) {
      if (request.accountId === id) request.controller.abort(new HttpError(403, 'The connected account was removed', 'access_changed'));
    }
    wakeWaitingRequests();
  }

  async function inference(req: IncomingMessage, res: ServerResponse, path: string) {
    const key = req.headers.authorization?.replace(/^Bearer /, '') ?? (typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'] : '');
    const member = key ? store.authenticate(key) : undefined;
    if (!member) throw new HttpError(401, 'A valid sharing key is required', 'invalid_api_key');
    let model = ''; let account: Account | undefined; const started = Date.now();
    let upstreamSignal: AbortSignal | undefined;
    let claimed = false;
    let approvalTimer: NodeJS.Timeout | undefined;
    let queuedAt: number | undefined;
    const requestId = randomUUID();
    const declaredBytes = Number(req.headers['content-length']);
    const details: RequestDetails = {
      method: req.method ?? 'GET', path, state: 'receiving', startedAt: started,
      requestBytes: 0, responseBytes: 0, queueMs: 0,
      ...(Number.isFinite(declaredBytes) ? { declaredBytes } : {}),
      client: redactLogText(req.headers['user-agent'] ?? '', 200),
    };
    res.setHeader('X-Request-Id', requestId);
    store.event(member, model, null, 102, 0, null, details, requestId);
    try {
      if (member.paused) throw new HttpError(403, 'Access is paused', 'access_paused');
      if (member.expiresAt && member.expiresAt <= Date.now()) throw new HttpError(403, 'This sharing key has expired', 'key_expired');
      if (path === '/v1/models' && req.method === 'GET') {
        if (proxy.lastSync < Date.now() - 60_000) await proxy.sync();
        if (proxy.error) throw new HttpError(503, proxy.error);
        const current = requireUsageMember(key);
        const ids = [...new Set(proxy.accounts.filter(a => a.enabled && (a.ownerMemberId === current.id || (a.ownerMemberId === null && (!current.accountIds.length || current.accountIds.includes(a.id))))).flatMap(a => a.models))].filter(id => !current.allowedModels.length || current.allowedModels.includes(id));
        details.state = 'finished'; details.finishedAt = Date.now();
        store.event(member, model, null, 200, Date.now() - started, null, details, requestId);
        return json(res, 200, { object: 'list', data: ids.map(id => ({ id, object: 'model', created: 0, owned_by: 'vibecliproxy' })) });
      }
      if (req.method !== 'POST' || !['/v1/responses', '/v1/responses/compact', '/v1/chat/completions', '/v1/messages', '/v1/messages/count_tokens'].includes(path)) throw new HttpError(404, 'This endpoint is not available');
      const body = await readJson(req, store.settings().maxInputMiB * 1024 * 1024, details); model = string(body.model, 'model', 200);
      let evidence: TaskEvidence | undefined;
      let screening: ScreeningResult | undefined;
      details.stream = body.stream === true;
      details.inputItems = Array.isArray(body.input) ? body.input.length : Array.isArray(body.messages) ? body.messages.length : typeof body.input === 'string' ? 1 : 0;
      details.tools = Array.isArray(body.tools) ? body.tools.length : 0;
      if (store.settings().promptPreviews) details.promptPreview = promptPreview(body);
      store.progress(requestId, model, null, details);
      if (model.includes('/') || !/^[a-zA-Z0-9_.:()\-]+$/.test(model)) throw new HttpError(400, 'Use an unprefixed model from /v1/models');
      if (member.allowedModels.length && !member.allowedModels.includes(model)) throw new HttpError(403, 'This model is not allowed for your key', 'model_not_allowed');
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort(new HttpError(499, 'Client disconnected', 'client_disconnected'));
      });
      const waitDeadline = Date.now() + store.settings().queueWaitSeconds * 1000;
      while (true) {
        if (controller.signal.aborted) throw new HttpError(499, 'Client disconnected', 'client_disconnected');
        if (proxy.lastSync < Date.now() - 60_000) await proxy.sync();
        if (controller.signal.aborted) throw controller.signal.reason;
        if (proxy.error) throw new HttpError(503, proxy.error, 'quota_unavailable');
        // A queued request must pass the current access and quota checks before admission.
        const current = store.authenticate(key);
        if (!current || current.paused || (current.expiresAt && current.expiresAt <= Date.now())) throw new HttpError(403, 'Access is no longer active');
        if (current.allowedModels.length && !current.allowedModels.includes(model)) throw new HttpError(403, 'This model is not allowed');
        const recent = (rates.get(current.id) ?? []).filter(at => at > Date.now() - 60_000);
        if (recent.length >= current.rpm) {
          res.setHeader('Retry-After', '60');
          throw new HttpError(429, 'Requests per minute limit reached', 'rate_limit_exceeded');
        }
        const settings = store.settings();
        const pool = routePool(proxy.accounts, current, model, settings.safetyMargin, Date.now(), settings.paused);
        if (pool.shared && (settings.paused || current.backupPaused)) throw new HttpError(403, 'Shared backup access is paused', 'access_paused');
        if (pool.shared && pool.accounts.length) {
          evidence ??= taskEvidence(body);
          if (!screening || screening.policyVersion !== reviews.policy(current.id).version) {
            screening = await reviews.screen(current, evidence, requestId);
            details.screening = `${screening.source}${screening.recordedRules?.length ? ` · Recorded: ${screening.recordedRules.join(', ')}` : ''}${!screening.blocked && screening.reason ? ` · ${screening.reason}` : ''}`;
            details.reviewId = screening.reviewId;
            store.progress(requestId, model, null, details);
            if (screening.blocked) throw new HttpError(403, screening.hardBlocked ? `${screening.reason}. This task is not allowed on shared backup; do not retry.` : `${screening.reason}. This task is paused for hub owner review; do not retry until the owner decides.`, screening.hardBlocked ? 'task_blocked' : 'task_review_required');
            // Re-read identity, quotas, routing and slot availability after the
            // asynchronous classifier. No provider slot is held while screening.
            continue;
          }
        }
        account = pool.accounts.filter(candidate => (busy.get(candidate.id) ?? 0) < settings.concurrentRequestsPerAccount).sort((a, b) => Math.max(...a.windows.map(w => w.usedPercent)) - Math.max(...b.windows.map(w => w.usedPercent)))[0];
        if (account) {
          // There is no await between checking availability and claiming the account.
          if (pool.shared && evidence && screening) reviews.claim(current, evidence, screening);
          busy.set(account.id, (busy.get(account.id) ?? 0) + 1);
          claimed = true;
          recent.push(Date.now());
          rates.set(current.id, recent);
          active.set(requestId, { memberId: current.id, accountId: account.id, controller, shared: pool.shared, fingerprint: evidence?.fingerprint, approved: screening?.source === 'approval' });
          details.state = 'running';
          details.queueMs = queuedAt === undefined ? 0 : Date.now() - queuedAt;
          details.provider = account.provider;
          details.route = pool.shared ? 'shared' : 'personal';
          details.accountLabel = redactLogText(account.email, 200);
          store.progress(requestId, model, account.id, details);
          break;
        }
        if (!pool.accounts.length) {
          res.setHeader('Retry-After', '60');
          throw new HttpError(429, pool.shared ? `No shared account is available below your ${current.sharePercent}% backup ceiling (${Math.max(0, current.sharePercent - settings.safetyMargin)}% after the safety margin) with fresh quota and permission for this model. Your reserve is protected.` : pool.reason, 'reserve_protected');
        }
        res.setHeader('Retry-After', '1');
        const remaining = waitDeadline - Date.now();
        if (remaining <= 0) throw new HttpError(429, 'The account is still handling another request. Try again shortly.', 'account_busy');
        if (queuedAt === undefined) {
          queuedAt = Date.now(); details.state = 'queued';
          store.progress(requestId, model, null, details);
        }
        await waitForAccount(controller.signal, remaining);
        screening = undefined;
        details.queueMs = Date.now() - queuedAt;
        res.removeHeader('Retry-After');
      }
      body.model = `${account.prefix}/${model}`;
      // Request a bounded generation where the upstream provider supports it.
      const outputLimit = store.settings().maxOutputTokens;
      if (path === '/v1/messages') body.max_tokens = Math.min(outputLimit, typeof body.max_tokens === 'number' && body.max_tokens > 0 ? body.max_tokens : outputLimit);
      else if (path === '/v1/chat/completions') {
        const max = body.max_completion_tokens ?? body.max_tokens;
        delete body.max_tokens; body.max_completion_tokens = Math.min(outputLimit, typeof max === 'number' && max > 0 ? max : outputLimit);
      } else if (path === '/v1/responses') body.max_output_tokens = Math.min(outputLimit, typeof body.max_output_tokens === 'number' && body.max_output_tokens > 0 ? body.max_output_tokens : outputLimit);
      const headers: Record<string, string> = { Authorization: `Bearer ${config.proxyKey}`, 'Content-Type': 'application/json', 'X-Request-Id': requestId };
      // Never forward caller routing/identity headers. Account choice belongs to the gateway.
      for (const name of ['anthropic-version', 'anthropic-beta']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      upstreamSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(store.settings().providerTimeoutSeconds * 1000)]);
      if (active.get(requestId)?.shared && reviews.settings().enabled && reviews.settings().mode === 'enforce' && screening?.source === 'approval' && screening.reviewId) {
        const expires = reviews.get(screening.reviewId).approvalExpiresAt ?? 0;
        approvalTimer = setTimeout(() => { if (reviews.settings().enabled && reviews.settings().mode === 'enforce') controller.abort(new HttpError(403, 'This task approval expired', 'task_review_required')); }, Math.max(1, expires - Date.now()));
        approvalTimer.unref();
      }
      const upstream = await fetch(`${config.proxyUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: upstreamSignal });
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      let errorBody = '';
      if (upstream.body) for await (const chunk of upstream.body) {
        if (res.destroyed) break;
        details.responseBytes += chunk.byteLength;
        if (details.firstByteMs === undefined) {
          details.firstByteMs = Date.now() - started;
          store.progress(requestId, model, account.id, details);
        }
        if (!upstream.ok && errorBody.length < 16_384) errorBody += Buffer.from(chunk).toString('utf8').slice(0, 16_384 - errorBody.length);
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      }
      if (!upstream.ok) {
        details.errorPhase = 'provider';
        details.errorMessage = `Provider returned HTTP ${upstream.status}`;
        try {
          const message = JSON.parse(errorBody).error?.message;
          if (typeof message === 'string') details.errorMessage = redactLogText(message, 800);
        } catch { /* Preserve the HTTP summary when the error body is not JSON. */ }
      }
      details.state = 'finished'; details.finishedAt = Date.now();
      store.event(member, model, account.id, upstream.status, Date.now() - started, upstream.status >= 500 ? 'upstream_http_error' : null, details, requestId);
      res.end();
    } catch (error) {
      let failure: HttpError;
      if (error instanceof HttpError) {
        failure = error;
      } else if (upstreamSignal?.aborted && upstreamSignal.reason instanceof HttpError) {
        failure = upstreamSignal.reason;
      } else if (req.aborted || (res.destroyed && !res.writableEnded)) {
        failure = new HttpError(499, 'Client disconnected', 'client_disconnected');
      } else if (upstreamSignal?.reason?.name === 'TimeoutError' || (error instanceof Error && error.name === 'TimeoutError')) {
        failure = new HttpError(504, 'The provider request timed out', 'upstream_timeout');
      } else {
        failure = new HttpError(502, 'The provider connection was interrupted', res.headersSent ? 'upstream_stream_error' : 'upstream_connection_error');
      }
      if (queuedAt !== undefined && details.state === 'queued') details.queueMs = Date.now() - queuedAt;
      details.errorPhase = details.state;
      details.state = 'finished'; details.finishedAt = Date.now(); details.errorMessage = redactLogText(failure.message, 800);
      store.event(member, model, account?.id ?? null, failure.status, Date.now() - started, failure.code, details, requestId);
      throw failure;
    } finally {
      clearTimeout(approvalTimer);
      if (account && claimed) {
        const remaining = (busy.get(account.id) ?? 1) - 1;
        if (remaining > 0) busy.set(account.id, remaining); else busy.delete(account.id);
        active.delete(requestId);
        wakeWaitingRequests();
      }
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const url = new URL(req.url ?? '/', 'http://localhost');
    // Serve accepts a mount and strips it. Also accept the full path for direct access and tests.
    const path = basePath && (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))
      ? url.pathname.slice(basePath.length) || '/' : url.pathname;
    if (path === '/healthz') return json(res, 200, { status: 'ok' });
    if (path.startsWith('/v1/')) return inference(req, res, path);
    if (path.startsWith('/v0/management/')) {
      const key = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
      requireUsageMember(key);
      if (path === '/v0/management/auth-files' && req.method === 'GET') {
        if (proxy.lastSync < Date.now() - 60_000) await proxy.sync();
        if (proxy.error) throw new HttpError(503, 'Account quota is unavailable');
        return json(res, 200, usageInventory(proxy, requireUsageMember(key)));
      }
      if (path === '/v0/management/api-call' && req.method === 'POST') {
        const body = await readJson(req);
        return json(res, 200, usageCall(proxy, store, requireUsageMember(key), body));
      }
      throw new HttpError(403, 'This usage connection is read-only');
    }
    if (path === '/api/member/session' && req.method === 'GET') return json(res, 200, { authenticated: !!currentMember(req), csrf: currentMember(req) ? csrf : null });
    if (path === '/api/member/login' && req.method === 'POST') {
      if (req.headers.origin && req.headers.origin !== config.publicOrigin) throw new HttpError(403, 'Cross-origin login rejected');
      const address = `member:${req.socket.remoteAddress ?? 'unknown'}`; const now = Date.now();
      let attempt = attempts.get(address); if (!attempt || now - attempt.since > 900_000) { attempt = { count: 0, since: now }; attempts.set(address, attempt); }
      if (++attempt.count > 8) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
      const body = await readJson(req); const member = typeof body.token === 'string' ? store.authenticate(body.token) : undefined;
      if (!member) throw new HttpError(401, 'Incorrect access key');
      const token = randomBytes(32).toString('base64url'); memberSessions.set(hash(token), { id: member.id, keyHash: member.keyHash, expires: now + 12 * 3600_000 }); attempts.delete(address);
      res.setHeader('Set-Cookie', `vcp_member=${token}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=43200${config.publicOrigin.startsWith('https:') ? '; Secure' : ''}`);
      return json(res, 200, { ok: true, csrf });
    }
    if (path.startsWith('/api/member/')) {
      const member = currentMember(req); if (!member) throw new HttpError(401, 'Sign in with your access key');
      if (!['GET', 'HEAD'].includes(req.method ?? '')) mutate(req);
      if (path === '/api/member/routing' && req.method === 'PATCH') {
        const body = await readJson(req);
        const personalOnly = boolean(body.personalOnly);
        if (personalOnly && body.confirmed !== true) throw new HttpError(400, 'Confirm that you may use up your personal quota and shared backup will be off');
        // Re-read after the upload so a concurrent admin edit or key change is respected.
        const current = currentMember(req);
        if (!current || current.id !== member.id || current.keyHash !== member.keyHash) throw new HttpError(401, 'Sign in with your access key');
        if (current.paused || (current.expiresAt && current.expiresAt <= Date.now())) throw new HttpError(403, 'This access key is inactive');
        current.personalOnly = personalOnly;
        store.save(current);
        if (personalOnly) stopRequests(current.id, true);
        else wakeWaitingRequests();
        return json(res, 200, { personalOnly });
      }
      if (path === '/api/member/accounts' && req.method === 'DELETE') {
        const body = await readJson(req); const id = string(body.accountId, 'account ID', 500);
        const account = proxy.accounts.find(a => a.ownerMemberId === member.id && hash(a.id).slice(0, 16) === id);
        if (!account) throw new HttpError(404, 'Account not found');
        await removeAccount(account.id, current => {
          const owner = currentMember(req);
          if (!owner || owner.id !== member.id || owner.keyHash !== member.keyHash) throw new HttpError(401, 'Sign in with your access key');
          if (current.ownerMemberId !== owner.id) throw new HttpError(404, 'Account not found');
        });
        return json(res, 200, { ok: true });
      }
      if (path === '/api/member/oauth/start' && req.method === 'POST') {
        const body = await readJson(req);
        if (!['codex', 'claude'].includes(body.provider)) throw new HttpError(400, 'Choose Codex or Claude');
        return json(res, 200, await onboarding.start(member, body.provider));
      }
      if (path === '/api/member/oauth/callback' && req.method === 'POST') {
        const body = await readJson(req);
        await onboarding.callback(member, string(body.state, 'sign-in ID'), string(body.redirectUrl, 'callback URL', 8000));
        return json(res, 200, { ok: true });
      }
      if (path === '/api/member/oauth/status' && req.method === 'GET') {
        const status = await onboarding.status(member, string(url.searchParams.get('state'), 'sign-in ID'));
        return json(res, 200, { status, ...(status === 'error' ? { error: 'Sign-in could not be completed. Start again.' } : {}) });
      }
      if (path === '/api/member/oauth/cancel' && req.method === 'POST') {
        const body = await readJson(req); await onboarding.cancel(member, string(body.state, 'sign-in ID'));
        return json(res, 200, { ok: true });
      }
      if (path === '/api/member/logout' && req.method === 'POST') {
        mutate(req);
        const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('vcp_member='))?.slice(11);
        if (cookie) memberSessions.delete(hash(cookie));
        res.setHeader('Set-Cookie', `vcp_member=; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=0`); return json(res, 200, { ok: true });
      }
      if (path === '/api/member/state' && req.method === 'GET') {
        const settings = store.settings();
        const visible = proxy.accounts.filter(a => a.ownerMemberId === member.id || (a.ownerMemberId === null && (!member.accountIds.length || member.accountIds.includes(a.id))));
        const accounts = visible.map((a, index) => ({ id: hash(a.id).slice(0, 16), email: a.ownerMemberId === member.id ? a.email : `Backup ${index + 1}`, provider: a.provider,
          personal: a.ownerMemberId === member.id, enabled: a.enabled, available: a.available, windows: a.windows, checkedAt: a.checkedAt, models: a.models.filter(m => !member.allowedModels.length || member.allowedModels.includes(m)),
          error: a.error ? 'Quota unavailable' : undefined, exhausted: exhausted(a), switchReached: personalSwitchReached(a, settings.paused || member.backupPaused || member.personalOnly ? { ...member, personalSwitchPercent: 100 } : member), headroom: a.ownerMemberId === member.id ? null : member.backupPaused ? 0 : eligibility(a, member, settings.safetyMargin).headroom }));
        const { keyHash: _, accountIds: __, ...safeMember } = member;
        return json(res, 200, { member: safeMember, accounts, settings: { paused: settings.paused, safetyMargin: settings.safetyMargin, promptPreviews: !!settings.promptPreviews }, summary: store.memberSummary(member.id),
          reviewStatus: { enabled: reviews.settings().enabled, pendingCount: reviews.settings().enabled && reviews.settings().mode === 'enforce' ? reviews.pendingCount(member.id) : 0, backupPaused: !!member.backupPaused },
          history: store.memberHistory(member.id).map((event: any) => ({ at: event.at, model: event.model, status: event.status, duration: event.duration, reason: event.reason })),
          currentRoute: [...active.values()].some(r => r.memberId === member.id && r.shared) ? 'backup' : [...active.values()].some(r => r.memberId === member.id) ? 'personal' : 'idle',
          publicOrigin: config.publicOrigin, publicBaseUrl: publicBaseUrl(), csrf, proxy: { error: proxy.error ? 'Hub connection unavailable' : null, lastSync: proxy.lastSync } });
      }
      throw new HttpError(404, 'Endpoint not found');
    }
    if (path === '/api/session' && req.method === 'GET') return json(res, 200, { authenticated: isAdmin(req), csrf: isAdmin(req) ? csrf : null, host: new URL(config.publicOrigin).hostname });
    if (path === '/api/login' && req.method === 'POST') {
      if (req.headers.origin && req.headers.origin !== config.publicOrigin) throw new HttpError(403, 'Cross-origin login rejected');
      const address = req.socket.remoteAddress ?? 'unknown'; const now = Date.now();
      let a = attempts.get(address); if (!a || now - a.since > 900_000) { a = { count: 0, since: now }; attempts.set(address, a); }
      if (++a.count > 8) throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
      const body = await readJson(req);
      if (passwordChecks >= 2) throw new HttpError(429, 'Sign-in is busy. Try again shortly.');
      passwordChecks++;
      let valid = false;
      try { valid = await verifyPassword(body.password, config.adminPasswordHash); } finally { passwordChecks--; }
      if (!valid) throw new HttpError(401, 'Incorrect password');
      const session = randomBytes(32).toString('base64url'); sessions.set(hash(session), now + 12 * 3600_000); attempts.delete(address);
      res.setHeader('Set-Cookie', `vcp_session=${session}; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=43200${config.publicOrigin.startsWith('https:') ? '; Secure' : ''}`);
      return json(res, 200, { ok: true, csrf });
    }
    if (path.startsWith('/api/')) {
      if (!isAdmin(req)) throw new HttpError(401, 'Sign in to manage this hub');
      if (!['GET', 'HEAD'].includes(req.method ?? '')) mutate(req);
      if (path === '/api/logout' && req.method === 'POST') {
        const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('vcp_session='))?.slice(12);
        if (cookie) sessions.delete(hash(cookie));
        res.setHeader('Set-Cookie', `vcp_session=; HttpOnly; SameSite=Strict; Path=${cookiePath}; Max-Age=0`); return json(res, 200, { ok: true });
      }
      if (path === '/api/state' && req.method === 'GET') {
        const members = store.members(); const settings = store.settings();
        return json(res, 200, { settings, requestLimits: REQUEST_LIMITS, accounts: proxy.accounts, members: members.map(m => ({ ...publicMember(m), access: proxy.accounts.map(a => ({ accountId: a.id, ...eligibility(a, a.ownerMemberId === m.id ? { ...m, sharePercent: 100, accountIds: [] } : m, a.ownerMemberId === m.id ? 0 : settings.safetyMargin) })) })),
          history: store.history(), reviews: reviews.state(), summary: store.summary(), proxy: { error: proxy.error, lastSync: proxy.lastSync }, publicOrigin: config.publicOrigin, publicBaseUrl: publicBaseUrl(), csrf });
      }
      if (path === '/api/reviews' && req.method === 'GET') return json(res, 200, reviews.state());
      if (path === '/api/review-settings' && req.method === 'PATCH') {
        const settings = reviews.configure(await readJson(req)); wakeWaitingRequests();
        if (settings.enabled && settings.mode === 'enforce') {
          stopRequests(undefined, true);
          for (const review of reviews.state().items) if (review.status === 'pending') notifications.enqueueReview({ id: review.id, memberName: review.memberName, ruleName: review.ruleNames[0], generation: review.generation });
        } else notifications.cancelReviewAlerts();
        return json(res, 200, settings);
      }
      if (path === '/api/review-rules' && req.method === 'POST') { const rule = reviews.saveRule(await readJson(req)); if (reviews.settings().enabled && reviews.settings().mode === 'enforce') stopRequests(undefined, true); return json(res, 201, rule); }
      const ruleMatch = path.match(/^\/api\/review-rules\/([a-zA-Z0-9-]+)$/);
      if (ruleMatch && req.method === 'PATCH') { const rule = reviews.saveRule(await readJson(req), ruleMatch[1]!); if (reviews.settings().enabled && reviews.settings().mode === 'enforce') stopRequests(undefined, true); return json(res, 200, rule); }
      if (ruleMatch && req.method === 'DELETE') { reviews.deleteRule(ruleMatch[1]!); if (reviews.settings().enabled && reviews.settings().mode === 'enforce') stopRequests(undefined, true); return json(res, 200, { ok: true }); }
      const decisionMatch = path.match(/^\/api\/reviews\/([a-f0-9-]+)\/decision$/);
      if (decisionMatch && req.method === 'POST') { const review = reviews.decide(decisionMatch[1]!, await readJson(req)); wakeWaitingRequests(); return json(res, 200, review); }
      if (path === '/api/notifications' && req.method === 'GET') return json(res, 200, notifications.state());
      if (path === '/api/notifications' && req.method === 'PATCH') return json(res, 200, notifications.configure(await readJson(req)));
      if (path === '/api/notifications/subscriptions' && req.method === 'POST') {
        const input = await readJson(req);
        try { return json(res, 201, { id: notifications.subscribe(input as any) }); }
        catch (error) { throw error instanceof HttpError ? error : new HttpError(400, error instanceof Error ? error.message : 'Invalid browser subscription'); }
      }
      const notificationMatch = path.match(/^\/api\/notifications\/subscriptions\/([a-f0-9-]+)$/);
      if (notificationMatch && req.method === 'DELETE') { notifications.unsubscribe(notificationMatch[1]!); return json(res, 200, { ok: true }); }
      if (path === '/api/notifications/test' && req.method === 'POST') return json(res, 202, notifications.test());
      if (path === '/api/activity' && req.method === 'GET') return json(res, 200, store.activity(activityQuery(url.searchParams)));
      if (path === '/api/refresh' && req.method === 'POST') { await proxy.sync(); return json(res, 200, { ok: !proxy.error }); }
      if (path === '/api/settings' && req.method === 'PATCH') {
        const body = await readJson(req); const settings = store.settings();
        if ('paused' in body) settings.paused = boolean(body.paused);
        if ('safetyMargin' in body) settings.safetyMargin = number(body.safetyMargin, 'Safety margin', 0, 20);
        if ('promptPreviews' in body) settings.promptPreviews = boolean(body.promptPreviews);
        for (const key of Object.keys(REQUEST_LIMITS) as (keyof RequestLimits)[]) {
          if (!(key in body)) continue;
          const limit = REQUEST_LIMITS[key];
          const value = number(body[key], limit.label, limit.min, limit.max);
          if (!Number.isInteger(value)) throw new HttpError(400, `${limit.label} must be a whole number`);
          settings[key] = value;
        }
        store.setSettings(settings); if (settings.paused) stopRequests(undefined, true);
        wakeWaitingRequests(); return json(res, 200, settings);
      }
      if (path === '/api/members' && req.method === 'POST') {
        const { member, key } = store.create(memberInput(await readJson(req))); return json(res, 201, { member: publicMember(member), key });
      }
      const match = path.match(/^\/api\/members\/([a-f0-9-]+)(\/rotate)?$/);
      if (match) {
        const id = match[1]!;
        if (match[2] && req.method === 'POST') { const key = store.rotate(id); stopRequests(id); return json(res, 200, { key }); }
        if (!match[2] && req.method === 'PATCH') { const body = await readJson(req); const member = store.member(id); Object.assign(member, memberInput(body, member)); store.save(member); stopRequests(id, Object.keys(body).every(key => key === 'backupPaused')); return json(res, 200, publicMember(member)); }
        if (!match[2] && req.method === 'DELETE') { store.remove(id); stopRequests(id); return json(res, 200, { ok: true }); }
      }
      if (path === '/api/oauth/start' && req.method === 'POST') {
        const body = await readJson(req); if (!['codex', 'claude'].includes(body.provider)) throw new HttpError(400, 'Choose Codex or Claude');
        const result = await proxy.management(body.provider === 'codex' ? 'codex-auth-url' : 'anthropic-auth-url');
        return json(res, 200, { url: result.url, state: result.state });
      }
      if (path === '/api/oauth/callback' && req.method === 'POST') {
        const body = await readJson(req); if (!['codex', 'claude'].includes(body.provider)) throw new HttpError(400, 'Invalid provider');
        const redirect = string(body.redirectUrl, 'callback URL', 8000);
        const u = new URL(redirect); if (!['localhost', '127.0.0.1'].includes(u.hostname) || !['http:', 'https:'].includes(u.protocol)) throw new HttpError(400, 'Paste the localhost callback URL from provider sign-in');
        await proxy.management('oauth-callback', { provider: body.provider, redirect_url: redirect }); return json(res, 200, { ok: true });
      }
      if (path === '/api/oauth/status' && req.method === 'GET') {
        const state = string(url.searchParams.get('state'), 'OAuth state', 300);
        const result = await proxy.management(`get-auth-status?state=${encodeURIComponent(state)}`);
        if (result.status === 'ok') await proxy.sync();
        return json(res, 200, { status: result.status, ...(result.status === 'error' ? { error: 'Provider sign-in failed. Start again.' } : {}) });
      }
      if (path === '/api/accounts/import' && req.method === 'POST') {
        const body = await readJson(req); const data = body.auth;
        if (!data || typeof data !== 'object' || !['codex', 'claude'].includes(data.type) || typeof data.access_token !== 'string' || !data.access_token) throw new HttpError(400, 'Upload a CLIProxy Codex or Claude auth JSON file');
        const name = `${data.type}-${randomBytes(8).toString('hex')}.json`;
        await proxy.management(`auth-files?name=${encodeURIComponent(name)}`, data); await proxy.sync(); return json(res, 201, { ok: true });
      }
      if (path === '/api/accounts' && req.method === 'DELETE') {
        const body = await readJson(req); const id = string(body.accountId, 'account ID', 500);
        await removeAccount(id, () => { if (!isAdmin(req)) throw new HttpError(401, 'Sign in to manage this hub'); });
        return json(res, 200, { ok: true });
      }
      if (path === '/api/accounts/owner' && req.method === 'PATCH') {
        const body = await readJson(req); const id = string(body.accountId, 'account ID', 500);
        const account = proxy.accounts.find(a => a.id === id); if (!account) throw new HttpError(404, 'Account not found');
        const owner = body.memberId === null ? null : store.member(string(body.memberId, 'person ID')).id;
        store.setOwner(id, owner); account.ownerMemberId = owner;
        // A changed account assignment takes effect immediately for active requests too.
        active.get(id)?.controller.abort(new HttpError(403, 'Account ownership changed', 'access_changed')); return json(res, 200, { ok: true });
      }
      throw new HttpError(404, 'Endpoint not found');
    }
    const files: Record<string, [string, string]> = { '/': ['index.html', 'text/html; charset=utf-8'], '/me': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
    if (req.method !== 'GET' || !files[path]) throw new HttpError(404, 'Not found');
    const [file, type] = files[path];
    const raw = await readFile(`${publicDir}${file}`);
    const content = file === 'index.html' ? raw.toString().replace(/(href|src)="\/(favicon\.svg|style\.css|app\.js)"/g, `$1="${basePath}/$2"`) : raw;
    res.writeHead(200, { 'Content-Type': type, ...(file === 'sw.js' ? { 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': `${basePath}/` } : {}) }); res.end(content);
  }
  const server = createServer((req, res) => {
    if (Date.now() - lastPruned > 3600_000) {
      lastPruned = Date.now(); store.prune(); reviews.prune();
      for (const [id, expires] of sessions) if (expires < Date.now()) sessions.delete(id);
      for (const [id, value] of memberSessions) if (value.expires < Date.now()) memberSessions.delete(id);
      for (const [id, value] of attempts) if (Date.now() - value.since > 900_000) attempts.delete(id);
    }
    handle(req, res).catch(error => {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      const status = error instanceof HttpError ? error.status : 502;
      json(res, status, { error: { message: error instanceof HttpError ? error.message : 'The upstream request could not be completed', type: error instanceof HttpError ? error.code : 'upstream_error' } });
    });
  });
  server.requestTimeout = 30_000; server.headersTimeout = 15_000;
  server.on('upgrade', (_req, socket) => { socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\n\r\nUse HTTP/SSE so sharing controls apply.'); });
  let closing: Promise<void> | undefined;
  const close = () => { reviews.close(); notifications.close(); return closing ??= onboarding.close(); };
  server.on('close', () => void close());
  return { server, store, proxy, reviews, notifications, stopRequests, close };
}
