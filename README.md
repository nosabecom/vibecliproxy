# Vibe Hub

A private CLIProxyAPI gateway for T3 Code. Friends use their own accounts first; your accounts provide a limited backup when their personal usage reaches a configurable switchover threshold.

- **Admin:** `/cliproxy` — accounts, ownership, personal switchover thresholds, backup percentage ceilings, models, key rotation, expiry, rate limits, pause controls, activity.
- **Friend:** `/cliproxy/me` — connect personal accounts, personal limits, shared backup headroom, endpoint, and their own activity.
- **Models:** `/cliproxy/v1/models`; inference supports HTTP/SSE Responses, Chat Completions, and Claude Messages. WebSocket upgrades are blocked.

## Percentage rules

A 20% ceiling stops backup requests when **total reported account usage** reaches 20% in any reported reset window. Your usage counts too. It does not create a separate 20% token wallet. People share the same pool; their percentages do not add together.

The default 2-point safety margin stops admission at 18% for a 20% ceiling. Provider readings can lag and running requests can cross the threshold; this is a reserve guard, not an exact billing cap. Quota is polled at most once a minute, with provider backoff. Failed readings, readings older than two minutes, or windows awaiting reset confirmation block access. Each account defaults to one in-flight request. Settings exposes queue wait (180 seconds), queue capacity (8 requests), parallel requests per account (1), provider timeout (600 seconds), inference/compaction body limit (64 MiB), and requested output ceiling (8,192 tokens), with descriptions and defaults. Higher parallelism can increase quota overshoot. CLIProxy's Codex SIWC path uses provider-controlled generation limits.

Personal accounts are exempt from the owner's backup ceiling. In **People → Manage → Switch to backup at personal usage (%)**, choose any percentage from 1 to 100 (including decimals), such as 20, 30, 40, or 50. Choose **Switchover quota window → Hourly (session), Weekly, or Both (either window)**. Hourly uses the provider’s session quota, such as its five-hour window. Both switches as soon as either window reaches the percentage. A confirmed 100% limit in any window still triggers backup, even outside the chosen period. The default is 100% with both windows, preserving the existing behavior. The friend dashboard displays this percentage and selected window in a **Switch to backup** card marked **Set by hub owner**, and refreshes saved changes automatically (normally within 30 seconds while the page is active). **All personal accounts supporting the requested model must have fresh, confirmed usage at or above this threshold in a selected window before backup is allowed**. This personal threshold is separate from the shared backup ceiling and has no early-stop margin. Busy accounts, disabled accounts, missing models, authentication failures, and network failures do not unlock backup. When fresh personal usage drops below the threshold (for example after a confirmed quota reset), routing returns to it. The threshold is checked for new requests using the latest reading; running requests finish, and provider readings may lag. Unchecking the requirement also allows backup without a usable personal account; the threshold still stops personal routing. Pausing backup bypasses the configured switchover threshold and uses personal accounts until a confirmed provider limit reaches 100%; sharing resumes its configured threshold when unpaused. Pausing backup leaves personal accounts available; pausing or revoking a person's key stops all their access.

The friend dashboard also has **Use mine**. Open it, read the warning, and hold **Hold to use mine** for two seconds (mouse, touch, Space, or Enter). This bypasses the personal switchover percentage and uses only that member’s accounts up to the provider’s actual limits. It stops their running shared backup requests and never falls back to the owner’s accounts, including when personal quota is exhausted or unavailable. Access pauses, expiry, model restrictions, request limits, and fresh quota checks still apply. The mode persists across sign-ins, restarts, and quota resets until the member chooses **Restore automatic routing**. Other people’s routing and the configured thresholds stay unchanged.

## Run locally

Requires Node.js 24+ and pnpm. Runtime uses Node's HTTP server and SQLite, plus `web-push` for encrypted browser notifications.

```sh
pnpm install
cp .env.example .env
# Set private CLIProxy keys in .env; set the admin password below.
node scripts/set-admin-password.ts /path/to/private-password-file
pnpm dev
# Open http://127.0.0.1:8320/cliproxy
```

Use a **dedicated CLIProxy instance**. The hub assigns a unique model prefix to each connected account. Configure CLIProxy with `force-model-prefix: true`, disable model/project fallback, and keep its listener on loopback. This prevents a request from falling through into another account's reserve. The installer pins and verifies CLIProxyAPI v8.0.46.

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm test:ui  # Playwright Chromium must be installed: pnpm exec playwright install chromium
```

## Ewaste hosting

Installed at `/home/nosa/vibecliproxy`. User services `vibe-cliproxy` and `vibe-hub` restart after failures and boot (the user has lingering enabled). CLIProxy listens on `127.0.0.1:8317`, and the hub on `127.0.0.1:8320`.

Tailscale Serve mounts the hub at **https://ewaste.tail3123d8.ts.net/cliproxy** on standard HTTPS port 443. The friend view is `/cliproxy/me` and the API endpoint is `/cliproxy/v1`. Existing root and `/qb` services are preserved. `PUBLIC_ORIGIN` is the HTTPS origin; `BASE_PATH=/cliproxy` scopes dashboard assets, requests, links, and cookies. Share the **ewaste machine** with your friend through Tailscale; they do not need to join your tailnet. Their access key works for inference and `/cliproxy/me`, never for admin APIs. The admin view requires a password-authenticated session. Tailscale identity headers, friend keys, and legacy admin bearer tokens never grant admin access.

```sh
# One-time host bootstrap (creates proxy keys; never overwrites existing .env):
ssh ewaste bash -s < scripts/bootstrap-host.sh
# Set ADMIN_PASSWORD_HASH before starting vibe-hub; a missing hash prevents startup.

# Prepare production dependencies locally; e-waste does not need pnpm:
pnpm build
mkdir -p .data/runtime/scripts .data/runtime/src
cp package.json pnpm-lock.yaml .data/runtime/
pnpm --dir .data/runtime install --prod --frozen-lockfile --ignore-scripts
cp -a dist public .data/runtime/
cp scripts/set-admin-password.ts .data/runtime/scripts/
cp src/auth.ts .data/runtime/src/
tar -czf /tmp/vibe-hub-runtime.tar.gz -C .data/runtime .
scp /tmp/vibe-hub-runtime.tar.gz ewaste:/tmp/vibe-hub-runtime.tar.gz
ssh ewaste 'tar -xzf /tmp/vibe-hub-runtime.tar.gz -C /home/nosa/vibecliproxy && systemctl --user enable --now vibe-hub && systemctl --user restart vibe-hub'
ssh ewaste 'sudo -n tailscale serve --bg --https=443 --set-path=/cliproxy http://127.0.0.1:8320'
```

Private configuration and data live in `.env` and `.data/`, outside version control, with restrictive permissions. The admin password is stored only as a salted scrypt hash in `ADMIN_PASSWORD_HASH`. To replace it, run `node scripts/set-admin-password.ts /path/to/private-password-file` in the install checkout (or supply its `.env` as the second argument), then restart `vibe-hub`. Use a password or passphrase of at least 12 characters; never send it in a chat or shell argument. Changing it and restarting invalidates all admin sessions. The friend dashboard has separate HttpOnly sessions invalidated immediately by key rotation or revocation. Request details are retained for 90 days. Optional prompt previews store up to 600 characters from the latest visible user message for seven days, with common credential patterns redacted. Detailed records are protected by the admin login. The friend view shows a notice when preview capture is enabled.

## Connect accounts and a friend

1. Open the admin dashboard over Tailscale. Add a person (backup-only mode is enabled by default); save their new key.
2. Connect your accounts from **Accounts** using OAuth or CLIProxy auth JSON import. Leave them as **You · shared backup**.
3. The friend signs into `/cliproxy/me` with their key, clicks **Connect an account**, and chooses Codex or Claude. After signing in, they paste the complete localhost callback URL, then check status. The new account is assigned to them automatically. Admins can also import and assign accounts manually.
4. Set the percentage ceiling, model restrictions, expiry, and requests per minute.
5. Share ewaste through Tailscale and give the friend the `/cliproxy/me` URL, API endpoint, and their key. **Connection** provides Codex and Claude configuration examples. Configure the environment/profile on the machine running the T3 Code server/CLI; exact T3 settings vary by version.

Provider sign-in requires the account holder. No existing CLI credentials are copied automatically. Live provider quotas and real model inference must be checked after connecting actual subscriptions.

Each member sign-in uses an isolated, temporary CLIProxy process with an empty credential directory and a private loopback listener. The completed credential is imported with a unique filename, disabled until ownership is recorded. Members cannot overwrite an existing connection or assign themselves another person's account. Pending sign-ins expire after five minutes; closing the dialog cancels them. Key rotation, expiry, revocation, and pausing also prevent completion. `CLIPROXY_BINARY` points to the installed CLIProxy binary; `OAUTH_DIRECTORY` holds temporary private files.

## T3 Code usage hub

Add a CLIProxy usage hub in T3 Code's provider settings:

- **URL:** `https://ewaste.tail3123d8.ts.net/cliproxy` (without `/v1` or `/me`).
- **Management key:** the friend's `vcp_…` access key.

The friend key grants only a scoped, read-only quota connection, using `/v0/management/auth-files` and `/v0/management/api-call` beneath that URL. It cannot access CLIProxy configuration, credentials, owner reset credits, or admin controls. Other members' personal accounts and the owner's identity are hidden. Personal quotas retain their provider percentages; shared backup percentages show the usable allowance relative to the effective ceiling, and show exhausted while personal-first routing or reserve protection blocks access. Stale readings return unavailable. The model API URL remains `/cliproxy/v1`.

References: [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), [management API](https://help.router-for.me/management/api), [configuration](https://help.router-for.me/configuration/basic).


## Detailed activity

The admin Activity view shows incoming, queued, running, completed, blocked and cancelled model requests from the retained 90-day history. Combine search with filters for person, account, result (including receiving, queued, running and limited), model, provider, route, endpoint and time range. Filters run against the full history before pagination, so **Last 7 days** and **Shared backup** include matching requests beyond the newest 100. Account choices include previously used accounts that have since been removed. Each row shows the account, route and date; older records whose route was never logged show **Not recorded**, and requests without an account show **Not routed**.

Use **Older →** and **← Newer** to browse results, choose 25, 50 or 100 requests per page, and select **Latest** to return to current requests. Older pages keep a snapshot of the result set so incoming requests do not shift records between pages. Changing filters resets to the first page; **Clear filters** resets all selections. Open **Details** on any page for request diagnostics. The request ID is also returned as `X-Request-Id`.

**Settings → Prompt previews** controls future prompt capture. Previews contain only the latest visible user text. Images, encrypted context, tool output, full request bodies, and authentication headers are excluded. Common key and password patterns are redacted; custom secrets in ordinary prose may still appear. Preview capture starts when enabled, so historical requests have metadata only. On startup, unfinished records are marked as interrupted by a restart.

**People → Manage → Requests per minute** accepts 1–6,000 requests/minute. This controls the hub’s per-person request rate. It does not raise provider limits, queue capacity, or the backup quota ceiling. A `reserve_protected` HTTP 429 means the backup eligibility guard blocked admission; increasing requests/minute does not remove that guard. The backup early-stop point is the backup ceiling minus the safety margin (for example, 60% − 2 points = 58%).

## Removing a connected account

Admins can choose **Accounts → Remove** on any connection. Members can choose **Your accounts → Remove** for their own connections in the friend dashboard. A confirmation identifies the connection before deleting its saved credential from CLIProxy. Ongoing requests using that account stop; other accounts and request history remain available. Members cannot remove shared backup or another member’s connection. Reconnecting requires signing in again. Removed accounts in an explicit backup pool stay selected as unavailable until the admin edits the pool, so removal never silently grants access to every backup.

**Pause sharing** uses each member’s personal accounts up to their provider’s actual quota limits, bypassing the switchover percentage while shared backup is paused. Resuming sharing restores the percentage rule. Pausing sharing stops ongoing backup requests; ongoing personal requests continue.

## Task reviews and browser notifications

**Reviews** has Pending, History and Rules. The default application rule blocks carrying out job or internship applications on someone’s behalf, including preparatory steps within that active application task. Career advice, job research without applying, resume feedback, materials the person will use themselves, and interview preparation remain allowed. Blocked tasks cannot receive scoped approval or be reopened while the rule applies. Add custom rules with descriptions, exceptions, catch/allow examples, selected people, and review, hard-block or record-only actions. Rule edits invalidate cached decisions and previous approvals. **People → Pause backup** stops only that person's shared backup and uses their personal accounts up to their actual provider limits.

Screening starts **disabled**, in Observe mode, until configured and verified. Set `OPENAI_DECISIONS_API_KEY` in the private server `.env`, restart the hub, then enable screening in Reviews → Rules. The key must belong to the API organization holding the intended credits. It is never returned to the browser. OpenAI Decisions uses `gpt-6-luna`; provider-side prompt caching is explicitly disabled and the local cache handles reuse. Observe records potential reviews without stopping requests or sending push notifications. Enforce holds shared requests only after a positive match to an enabled review/block rule. Uncertainty alone never creates a hold. Personal routes do not spend classifier credits. Provider errors, unavailable context, and screening-budget exhaustion are recorded as warnings in Activity and allow requests without a rule match. Existing confirmed rule matches remain enforced. This deliberately favors avoiding unrelated blocks; application intent hidden entirely in unavailable context or arriving while screening is unavailable may be missed.

Task identity is derived from complete visible user/system/developer instructions and the request's `instructions` and Anthropic `system` fields, after line-ending normalization. Exact standalone continuations such as “go on” inherit the included objective. A continuation without visible task context cannot inherit another task's approval. Assistant output, tool observations, previews, model request IDs and conversation IDs do not grant approval. Images/files, stored-response or conversation references, stored prompts, and opaque compaction do not create automatic holds. The classifier evaluates available visible instructions, retaining an included application objective across continuations. Standalone continuations without visible intent are allowed with a warning, rather than inheriting an unrelated task’s decision. Selected evidence has an 8 MiB memory limit (12 MiB including serialized rules and framing). Large requests use the OpenAI input-token counting endpoint with all evidence and questions, plus a framing allowance. Screening admits up to an estimated 1,000,000 input tokens, leaving headroom within Luna’s 1,050,000-token window. Requests beyond that model capacity skip classification with an Activity warning and continue without a rule match; their evidence is never silently truncated. Raising a limit does not pad inputs or increase billing by itself. Token preflight runs only when the byte-based upper bound exceeds the token ceiling; local cache hits skip both counting and classification. See the [token counting guide](https://developers.openai.com/api/docs/guides/token-counting) and [Luna model limits](https://developers.openai.com/api/docs/models/gpt-6-luna). This is an intent guard based on visible instructions; it cannot recover an objective hidden in encrypted or omitted context. New instructions and policy revisions produce new fingerprints. The default fixed cache expiry is one hour.

Approve a known task for **30 minutes or 25 shared requests** by default, with owner-selected limits of 1–60 minutes and 1–500 requests. Counts are claimed atomically before forwarding; expiry stops an active approved stream. The final admitted requests can finish when the request count is exhausted, while further requests pause. New objectives need a fresh check. Existing access restrictions, reserve checks and rate limits still apply. Repeated holds are grouped into one task review and each API request retains its request ID and review link in Activity. Previously blocked HTTP calls are not replayed automatically. Decisions have a separate retained audit history.

Default screening budgets are **$2.50 per UTC day and $80 per UTC calendar month**, independently configurable. The hub reserves a conservative cost before making a classifier call, then reconciles reported input usage, including the 2× input rate above 272,000 tokens; failed calls retain the reservation because billing may be unknown. This budget covers only this hub's screening, not other API usage or subscription quota. It is separate from the API credit grant's billing-cycle expiry. Reviews store only fingerprints, decision metadata, and up to 600 redacted characters each of objective/latest evidence; complete request bodies are never persisted. Review evidence is separate from the optional Activity prompt-preview setting and expires after seven days without an update. Finished reviews and owner decision history are retained for 90 days. Members see their own hold count, without owner evidence or rule details.

**Settings → Notifications** enables browser Web Push. Register each device through **Enable on this device**, grant browser notification permission, enable delivery, then use **Send test notification**. The HTTPS mounted service worker handles notifications without caching admin pages or API responses. VAPID keys are generated in the private database; only the public key is exposed. A new review queues one logical alert per browser, retrying failures through a durable outbox. An optional reminder is sent once for an unresolved review. Reopening a task or exhausting an approval creates a new notification episode. History reports queued/accepted/failed: push-provider acceptance does not prove that an OS displayed the notification. The notification opens the owner review; it never approves a task. Desktop Chrome generally must remain running, and browser/OS permission and Android background behavior must be verified on each device. The reusable Android webhook app is a separate future integration.

```sh
pnpm test
pnpm typecheck
pnpm test:ui
node scripts/test-reviews-ui.ts
pnpm build
node scripts/verify-reviews.ts
# On a machine with Codex installed, also verifies an isolated config.toml:
node scripts/verify-reviews.ts --codex
```

The smoke verifier uses a fresh private database and CODEX_HOME with a fake provider and classifier. It verifies routing without spending real subscription quota. It does not replace an accuracy evaluation against the real Decisions API or an actual device notification test.

Add `--decisions-key-file /private/path/to/key` to use real Decisions classification with the mock inference provider. This spends classifier API credits only. The key is read from the file, never passed to Codex or printed. Keep this optional verification separate from ordinary tests.
