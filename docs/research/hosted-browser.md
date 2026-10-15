# Hosted browsing for agents: Cloudflare Browser Run, 1Password, and hosted-browser vendors

Research for wayfinder ticket #112 (map #101). Researched 2026-10-15 against vendor docs. Every claim cites its source URL; things I could not confirm are marked **Unconfirmed**. This file lists options and trade-offs; it makes no product decision.

> Naming: Cloudflare has renamed **Browser Rendering** to **Browser Run** (docs: "Browser Run, formerly known as Browser Rendering"). The old `/browser-rendering/` URLs redirect to `/browser-run/`. https://developers.cloudflare.com/browser-run/

## Answer

**Cloudflare Browser Run**

- It is a Workers binding (`browser: { binding }`) that gives a headless Chrome session. You drive it with Cloudflare's forks of Puppeteer (`@cloudflare/puppeteer`) and Playwright (`@cloudflare/playwright`, needs `nodejs_compat` and compat date 2025-09-15 or later), with raw CDP, or with Stagehand. https://developers.cloudflare.com/browser-run/ , https://developers.cloudflare.com/browser-run/playwright/
- CDP is open to the outside world too. `wss://api.cloudflare.com/client/v4/accounts/{id}/browser-run/devtools/browser` takes a Cloudflare API token (`Authorization: Bearer`) and `keep_alive` of 10 000–1 200 000 ms. `chrome-devtools-mcp` can drive it. https://developers.cloudflare.com/browser-run/cdp/ , https://developers.cloudflare.com/browser-run/cdp/mcp-clients/
- Sessions are reusable and can be kept alive. The default idle timeout is 60 s, extendable to 20 min with `keep_alive`. Cloudflare says there is no fixed maximum lifetime while the session stays active, but sessions also close on Cloudflare releases. https://developers.cloudflare.com/browser-run/limits/ , https://developers.cloudflare.com/browser-run/features/reuse-sessions/
- **There is no persistent profile, cookie jar, or "context" resource.** No docs page offers one. State survives only while a browser session is alive (optionally pinned by a Durable Object) or if you export and re-inject cookies yourself over CDP. The Kitesurf docs say the lightweight browser cannot do "long-running, authenticated session that requires persistent state" and send you to Chromium. https://developers.cloudflare.com/browser-run/kitesurf/ The cookie-export approach is my inference from standard CDP, not a documented Cloudflare feature.
- Live View and human handoff exist and are first-party. The CDP commands `Cloudflare.getLiveView`, `Cloudflare.handoff` and the `Cloudflare.handoffComplete` event let an agent ask a human to log in or solve a CAPTCHA, then resume. Live View URLs are signed (`jwt=`), valid 5 min by default and up to 1 h to start a connection. https://developers.cloudflare.com/browser-run/features/human-in-the-loop/ , https://developers.cloudflare.com/browser-run/features/live-view/
- Pricing (Workers Paid): 10 browser hours/month free, then **$0.09/hour**, plus **$2.00 per concurrent browser** above 10 (monthly average of daily peaks) for Browser Sessions. Quick Actions bill browser hours only. Limits: 200 concurrent browsers, 3 new/s (Paid); Free gets 10 min/day, 3 concurrent, 1 new per 20 s. https://developers.cloudflare.com/browser-run/pricing/ , https://developers.cloudflare.com/browser-run/limits/
- Cloudflare ships a Playwright MCP fork (`@cloudflare/playwright-mcp`) deployed as a Worker plus Durable Object, but it is pinned to upstream Playwright MCP v0.0.30. https://developers.cloudflare.com/browser-run/playwright/playwright-mcp/
- Traffic is self-identifying. Browser Run adds non-removable headers (`cf-brapi-devtools`, `cf-biso-devtools`) and Web Bot Auth signatures. It is not a stealth browser. I found no CAPTCHA solving or residential proxy offering in the docs. https://developers.cloudflare.com/browser-run/reference/automatic-request-headers/

**1Password**

- **Service accounts** are token-based (`OP_SERVICE_ACCOUNT_TOKEN`) and scoped to specific vaults with read/write/share permissions. They cannot reach Personal/Private/Employee vaults. Up to 100 per account. The SDKs (Go, JS, Python) fetch secrets by `op://vault/item/field` reference. https://developer.1password.com/docs/service-accounts/ , https://developer.1password.com/docs/sdks/concepts/
- Rate limits matter for a multi-tenant host. Business: 10 000 reads/h and 1 000 writes/h per token, 50 000 requests/day per 1Password account. Teams: 1 000 reads/h per token, 5 000/day per account. https://developer.1password.com/docs/service-accounts/rate-limits.md
- With a service account **the secret reaches your code, not the page**. Your Worker fetches it with the SDK and then types it into the page. It never reaches the model only if your code keeps it out of the model context. 1Password's own agent tutorial warns "Exposing raw credentials directly to an AI model carries significant risks… It is not our recommended integration approach." https://developer.1password.com/docs/sdks/ai-agent.md
- **Agentic Autofill** (announced 2025-10-08, with Browserbase) is the "secret never touches the model" path. The agent asks, a human approves in the 1Password app, and the 1Password browser extension inside the remote browser fills over an end-to-end encrypted channel (Noise-based). Raw credentials never enter the LLM context. https://blog.1password.com/closing-the-credential-risk-gap-for-browser-use-ai-agents/ , https://1password.com/press/2025/oct/browserbase-ai-security-partnership
  - Caveats: it was Early Access, tied to Browserbase Director (the no-code agent), and each fill needs a human approval prompt on a 1Password desktop/mobile app. A Business admin must enable the policy "Allow AI agents to autofill for users". I could **not** confirm that it is GA or available outside Browserbase. The original docs page (`/docs/agentic-autofill`) now resolves to a generic "Security for AI" page. https://developer.1password.com/docs/agentic-autofill
  - 1Password's own 2026 releases show the same mechanism extended to "1Password for Claude" (Mac, Claude in Chrome, Agentic Mode). It is a per-user, desktop-bound flow, not a server-to-server API. https://support.1password.com/1password-claude/ , https://releases.1password.com/b5x/stable/
- Browserbase's published 1Password guide is the service-account + SDK pattern (credential fetched in your code, filled via Playwright/Stagehand), not Agentic Autofill. https://docs.browserbase.com/integrations/1password/quickstart
- **Unconfirmed:** whether `@1password/sdk` runs on Workers (the docs do not list Workers or WASM requirements; test before relying on it) and any way to load the 1Password extension into a Browser Run session (no Cloudflare docs page mentions extensions). I found no Cloudflare + 1Password agent integration.

**Hosted-browser vendors (how they model sessions, profiles, logins)**

| | Session | Persistent state | Login handling | Human handoff | Pricing (read 2026-10-15) |
|---|---|---|---|---|---|
| Browserbase | session, `keepAlive` (paid only) | **Contexts** (encrypted user-data-dir; cookies, localStorage, IndexedDB; `persist: true`; never expire) | 1Password SDK recipe; Agentic Autofill (EA); Secrets are for Functions only | Live View (iframe-embeddable) | Free: 3 concurrent, 1 h, 15 min/session. Dev $20/mo: 25 concurrent, 100 h then $0.12/h. Startup $99/mo: 100 concurrent, 500 h then $0.10/h |
| Steel | session, release | **Profiles** (user-data-dir snapshot, 300 MB cap, deleted after 30 days idle) | **Credentials API** (beta): injected into the page, fields blurred, TOTP, exact origin, org-wide store | Live session viewer (**Unconfirmed** details) | Free $30 credit, 10 concurrent, 15 min sessions; Scale $250/mo, 100 concurrent, 1 h; $0.10→$0.08/h |
| Hyperbrowser | session | **Profiles** (`persistChanges`) | **Credential fill** (public preview, on request): encrypted client-side, typed in by host, per-secret allowed origins, TOTP | Live View | Free 5 000 credits, 1 concurrent; Startup $30/mo 25 concurrent; Scale $100/mo 100; $0.10/h; 1 000 credits = $1 |
| Anchor | session over CDP/REST | **Profiles** (cookies/storage), **Volumes** (files) | **Applications + Identities**: managed auth with re-login, email OTP, TOTP, 1Password; secret values domain-scoped | HITL with `intervention.requested` webhook and `live_view_url` | Calculator shows $0.09/h browser, $8/GB proxy, $0.01/step AI, $0.01 init (Growth) |

Sources: https://docs.browserbase.com/platform/browser/core-features/contexts.md , https://www.browserbase.com/pricing , https://docs.steel.dev/overview/profiles-api/overview.md , https://docs.steel.dev/overview/credentials-api/overview , https://steel.dev/pricing , https://hyperbrowser.ai/docs/sessions/profiles , https://hyperbrowser.ai/docs/sessions/credentials.md , https://www.hyperbrowser.ai/pricing , https://docs.anchorbrowser.io/essentials/managed-authentication.md , https://docs.anchorbrowser.io/agentic-browser-control/human-in-the-loop.md , https://www.anchorbrowser.io/pricing

**Pattern across vendors:** three separate things, which Cloudflare mostly lacks. (1) *Browser state* persisted as a user-data-dir snapshot (profile/context). (2) A *credential vault* whose values are injected into the page by the platform, never returned by API. (3) *Human takeover* via a live view URL. Cloudflare has (3) and a piece of (1) only if you build it; it has no (2).

## Detail: Cloudflare Browser Run

### Integration methods
- Quick Actions (stateless HTTP/Worker calls: `/content`, `/markdown`, `/screenshot`, `/pdf`, `/snapshot`, `/scrape`, `/json`, `/links`, `/crawl`, `/accessibilityTree`) and Browser Sessions (Puppeteer, Playwright, CDP, Stagehand). Quick Actions can be called from a Worker through `quickAction()` on the binding (compat date 2026-03-24 or later) with no API token. https://developers.cloudflare.com/browser-run/ , https://developers.cloudflare.com/browser-run/changelog/ (2026-05-28)
- Playwright: concurrent connections need `@cloudflare/playwright` v1.3.0+ (2026-04-15), which uses standard CDP internally. https://developers.cloudflare.com/browser-run/changelog/
- Browser binding API (2026-09-21): typed methods to acquire/connect to sessions, create Live View URLs, nested `devtools` binding for targets. https://developers.cloudflare.com/browser-run/reference/browser-binding-api/
- Outbound Workers (`outboundByHost`): send selected hostnames' browser requests through another Worker. This lets a Worker inject auth headers/cookies into browser traffic without the secret entering the page or the model. Doc says it can "add authentication". https://developers.cloudflare.com/browser-run/features/outbound-workers/ (My reading: this is a plausible secret-injection seam for Commissary; it is not documented as a credential feature.)
- Guardrails: per-session hostname allowlist (`allowedDomains` ≤50, `allowedDomainSets` ≤4), fixed for session lifetime; not available for Quick Actions. https://developers.cloudflare.com/browser-run/features/guardrails/
- Session recording (beta): rrweb DOM events, enabled at acquisition (`recording: true`), available after the session ends. https://developers.cloudflare.com/browser-run/features/session-recording/
- WebMCP (pages exposing tools to agents) needs the experimental "Lab" pool or Kitesurf. https://developers.cloudflare.com/browser-run/features/webmcp/
- Kitesurf (beta, free, per-account limits): a stateless Workers-native browser, no WebGL/video/real-TLS bot handshakes/persistent authenticated sessions. https://developers.cloudflare.com/browser-run/kitesurf/

### Session reuse and keep-alive
- Default: each launch creates a new browser; it closes after 1 min idle. `keep_alive` up to 20 min. No fixed maximum lifetime if kept active (send a command within the window). Sessions also close on Browser Run releases. https://developers.cloudflare.com/browser-run/limits/ , https://developers.cloudflare.com/browser-run/puppeteer/
- Two reuse patterns: shared browser with one incognito browser context per request (isolates cookies/storage), or a Durable Object that holds the browser. https://developers.cloudflare.com/browser-run/features/reuse-sessions/ , https://developers.cloudflare.com/browser-run/how-to/browser-run-with-do/
- Dashboard-created sessions default to 5 min keep-alive. https://developers.cloudflare.com/browser-run/features/live-view/
- Concurrent-browser pricing counts these long-lived sessions: per-user kept-alive browsers consume concurrency (200 default cap on Paid, raisable by request form). https://developers.cloudflare.com/browser-run/limits/

### Persistent profiles / cookies
- No documented profile/context persistence. Quick Actions can take cookies and HTTP basic auth per request ("How do I render authenticated pages using Quick Actions?"), which is per-call injection, not persistence. https://developers.cloudflare.com/browser-run/faq/
- **Unconfirmed:** whether a reconnected session retains logins across a Cloudflare release rollout (docs say sessions close on rollout). Practical design implication (inference): to give an org member a "stay logged in" browser, Commissary would store cookies/storage itself (encrypted, per org/member) and re-inject them over CDP on session start.

### Live View and human-in-the-loop
- Live View is available for any Browser Session. Opened from dashboard (Live Sessions tab) or via a generated `devtoolsFrontendUrl` on `live.browser.run`; three modes: `tab`, `full`, `devtools`. Native Chrome DevTools works by swapping the URL prefix. https://developers.cloudflare.com/browser-run/features/live-view/
- URL validity: 5 min default start-deadline, max 1 h (`expiresInMs` / `liveViewUrlExpiresInMs`). An established connection lasts as long as the session. The URL carries a JWT, so it is a bearer link. https://developers.cloudflare.com/browser-run/features/live-view/ , https://developers.cloudflare.com/browser-run/cdp/session-management/
- Structured handoff (2026-07-28): subscribe to `Cloudflare.handoffComplete`; `Cloudflare.getLiveView` (mode `tab`); `Cloudflare.handoff` with instructions and optional timeout (max 30 min). The human clicks "Done" or "Failed". https://developers.cloudflare.com/browser-run/features/human-in-the-loop/ , https://developers.cloudflare.com/browser-run/changelog/
- Cloudflare explicitly lists "sensitive credentials you do not want to pass to an automation script" as a handoff use: the human types the password in the live view, so the secret never reaches the model or Commissary. https://developers.cloudflare.com/browser-run/features/human-in-the-loop/

### Pricing and limits (Workers plans)
| | Workers Free | Workers Paid |
|---|---|---|
| Browser time | 10 min/day | 10 h/month incl., then $0.09/h |
| Concurrent browsers (Sessions) | 3 | 10 incl. (monthly avg of daily peak), then $2.00 each; hard cap 200 (raisable on request) |
| New instances | 1 per 20 s | 3 per s |
| Quick Actions rate | 1 per 10 s | 30 per s |
| Idle timeout | 60 s, up to 20 min with `keep_alive` | same |
Billing rounds the month's total browser seconds to the nearest hour. Failed Quick Actions with `waitForTimeout` are not billed. Quick Actions responses expose `X-Browser-Ms-Used`. https://developers.cloudflare.com/browser-run/pricing/ , https://developers.cloudflare.com/browser-run/limits/
- Implication for Commissary Cloud: the browser cost lands on **the operator's own Cloudflare account** (the hosted deployment), so a free tier means eating browser-hours and concurrency; a Cloudflare-side cap is account-wide, not per Commissary org. A per-org spend limit or concurrency cap must be enforced by Commissary (I found no per-tenant quota feature in Browser Run).

### Playwright MCP
- `@cloudflare/playwright-mcp` (v1.1.1, synced to upstream Playwright MCP v0.0.30) exposes MCP over `/mcp` and `/sse` from a Worker with a Durable Object (`createMcpAgent(env.BROWSER)`). LLMs work from accessibility snapshots, no vision model required. https://developers.cloudflare.com/browser-run/playwright/playwright-mcp/
- Alternative: `chrome-devtools-mcp` pointed at the CDP WebSocket with `--wsEndpoint`/`--wsHeaders`. This needs a Cloudflare API token in the client config (token scope "Browser Rendering - Edit"). https://developers.cloudflare.com/browser-run/cdp/mcp-clients/
- Both are fit for a Tools-area MCP gateway: Commissary could proxy either and keep Cloudflare's token server-side. (Inference.)

## Detail: 1Password for agents

### Service accounts and SDKs
- Created in 1Password.com > Developer. Scoped to chosen vaults/Environments and permissions (read, write, share); can't touch built-in Personal/Private/Employee vaults. Token rotation with a grace expiry; revocation; usage reports per service account. Max 100 service accounts. https://developer.1password.com/docs/service-accounts/ , https://developer.1password.com/docs/service-accounts/manage-service-accounts/
- SDKs: Go, JavaScript (`@1password/sdk`), Python. Two auth modes: desktop-app prompt (human approves; access lapses after 10 min idle) or service account. https://developer.1password.com/docs/sdks/concepts/
- Limits (above). A hosted multi-tenant service would hit the **per-1Password-account daily cap** if all customers shared one account; the model is "each customer brings their own service account token", which then makes Commissary a holder of a powerful per-customer token (treat as a **shared/private credential** that needs encryption at rest, per the glossary).
- Pricing for 1Password itself is a separate subscription; I did not extract per-seat prices (the Developer pricing URL 404'd).

### How a secret reaches a page without the model seeing it
1. **Human types it** (Cloudflare handoff / Live View, Browserbase Live View). Secret never leaves the human's browser path. (Cloudflare docs above.)
2. **Your code fetches it and fills the page** (service account + SDK + Playwright `page.fill`). The model sees only a placeholder/alias if you design the tool that way. 1Password's tutorial warns about passing raw values to the model. https://docs.browserbase.com/integrations/1password/quickstart , https://developer.1password.com/docs/sdks/ai-agent.md
3. **Platform injects it** (Steel Credentials, Hyperbrowser credential fill, Anchor secret values / 1Password-backed Identities, Browser Use 1Password vault binding). Values stay out of API responses and agent text; Steel also blurs filled fields so vision agents can't read them. Browser Use itself notes injection "does not make it inaccessible to the agent: once entered, it is available to the page and to browser/CDP access." https://docs.steel.dev/overview/credentials-api/overview , https://hyperbrowser.ai/docs/sessions/credentials.md , https://docs.anchorbrowser.io/agentic-browser-control/secret-values.md , https://docs.anchorbrowser.io/integrations/1password.md , https://docs.browser-use.com/cloud/guides/1password.md
4. **1Password extension fills in the remote browser with human approval** (Agentic Autofill). Strongest model, but human-per-fill and Browserbase-only as far as published. 1Password notes Browserbase "may be able to tell when an item matching an autofill request exists, even if the request is denied." https://developer.1password.com/docs/agentic-autofill (as retrieved in search; page now reorganized)
5. **Outbound Worker injection** (Cloudflare-specific, not a documented credential feature): route a hostname through a Worker that adds a header/cookie. Works for token/cookie auth, not for form logins. https://developers.cloudflare.com/browser-run/features/outbound-workers/

Caveat for 3 and 4: once the value is in the page, a CDP-capable agent can still read it (e.g. via DOM evaluation) unless the platform blocks that. Only 1 truly avoids exposure to a script-capable agent.

## Detail: hosted-browser vendors

### Browserbase
- Sessions start with a fresh user-data-dir. **Contexts** persist the Chromium user data dir (cookies, localStorage, IndexedDB, service workers, form data), encrypted at rest, never expire until deleted; `persist: true` on a session saves on close; avoid simultaneous sessions on one context; one context per site per login. https://docs.browserbase.com/platform/browser/core-features/contexts.md
- `keepAlive` (paid plans only) lets a session survive disconnects; must be released explicitly. https://docs.browserbase.com/platform/browser/long-sessions/keep-alive.md
- Live View is for debugging, human-in-the-loop, and embedding in an app; "delegate credentials - give control to the end user". https://docs.browserbase.com/features/session-live-view
- Identity: Verified browsers (Scale plan only), proxies, auto CAPTCHA, Web Bot Auth (beta). "Web Bot Auth doesn't sign your agent into a user account." https://docs.browserbase.com/welcome/identity-and-access.md
- Secrets are for Browserbase Functions only (`context.secrets`), not browser logins. https://docs.browserbase.com/platform/secrets/overview.md
- Pricing as in the table; Free plan sessions up to 15 min. https://www.browserbase.com/pricing

### Steel
- Open source browser API. Sessions are isolated; **Profiles API** stores a user-data-dir snapshot (cookies, extensions, credentials, settings): created with `persistProfile`, reused with `profileId`; 300 MB cap; auto-deleted after 30 days unused; suggested one profile + one dedicated IP per account. https://docs.steel.dev/overview/profiles-api/overview.md
- **Credentials API** (beta, free during beta): stored per org, optional `namespace` to separate users of the same origin, `exactOrigin`, `autoSubmit`, `blurFields`, TOTP seed; envelope encryption (AES-256-GCM key per credential, org-specific KMS key, AAD binds org ID + origin); injected within ~2 s of the login page loading. https://docs.steel.dev/overview/credentials-api/overview
- Max session: 15 min Launch, 1 h Scale, up to 24 h Enterprise. https://steel.dev/pricing

### Hyperbrowser
- Profiles: saved snapshot of the user-data-dir, attach by id; `persistChanges` on first use. https://docs.hyperbrowser.ai/sessions/profiles
- Credential fill (public preview, on request): secrets with 1–20 allowed origins, vaults, TOTP; values encrypted on your machine before upload and the API never returns them; decrypted on the browser host and typed in. Allowed origins limit fills only; the same secret passed to a sandbox is delivered as a value. https://hyperbrowser.ai/docs/sessions/credentials.md
- Also lists WebMCP page tools and CAPTCHA/stealth/proxy options. https://docs.hyperbrowser.ai/llms.txt
- Pricing: 1 000 credits = $1; browser 100 credits/h; proxy $10/GB. https://www.hyperbrowser.ai/pricing

### Anchor Browser
- Two persistence models: **browser profiles** (cookies/local storage/cache; you log in once manually; no stored credentials, no auto re-login) and **Applications + Identities** (managed auth: credentials or guided login stored on an identity, Anchor re-authenticates when the session expires; email OTP, TOTP, 1Password, custom MFA). https://docs.anchorbrowser.io/essentials/managed-authentication.md
- 1Password: either inject vault secrets into sessions or back an Identity with a 1Password service account token ("domain discovery" finds the login item by site). Values "never exposed to the AI agent, logs, API responses". https://docs.anchorbrowser.io/integrations/1password.md
- HITL: agent pauses and queues an intervention request; webhooks `intervention.requested` (with `live_view_url`) and `intervention.resolved`. https://docs.anchorbrowser.io/agentic-browser-control/human-in-the-loop.md
- Volumes: persistent file storage mountable by sessions. https://docs.anchorbrowser.io/advanced/volumes.md
- Pricing page is a usage calculator with $0.09/h browser time, $8/GB proxy, $0.01/AI step; I did not find a published plan table. https://www.anchorbrowser.io/pricing

### Related
- Browser Use Cloud supports 1Password vaults for API runs via a service account token and `opVaultId` plus a required `opVaultAllowedDomains`; max 10 bindings per run. https://docs.browser-use.com/cloud/guides/1password.md

## Options and trade-offs for Commissary Browser (not decided)

1. **Cloudflare Browser Run only.** Fits the Workers stack (binding, Durable Objects, no extra vendor). Cost lands on Commissary's own account and is shared across all orgs; per-org limits need Commissary enforcement. Gaps: no profile persistence, no credential injection, no CAPTCHA/residential proxy, bot-identifying headers that can't be removed.
2. **Cloudflare + Commissary-built state layer.** Store encrypted cookies/storage per org/member (credential **shared/private** semantics apply), re-inject on session start; secrets via human handoff, or fetched by a server-side tool from 1Password and never returned to the model. Gives a path for "stay logged in" without a second vendor, at the cost of building and securing it.
3. **Resell/front a hosted vendor** (Browserbase/Steel/Hyperbrowser/Anchor) for stateful, logged-in, anti-bot work, keeping Cloudflare for stateless fetch/screenshot. These have profiles, credential injection, and CAPTCHA built in; Steel is open source (self-hostable per its tagline; I did not verify the self-host docs). Each adds a vendor key per org to manage as a credential.
4. **Self-hosters bring their own** Cloudflare account/binding (their `browser` binding) or a CDP URL; Cloud uses option 1/2/3. The CDP WebSocket URL plus token is the one provider-agnostic seam all four vendors and Cloudflare share (Cloudflare docs; Steel docs show `wss://connect.steel.dev?...`; Anchor and Hyperbrowser document CDP/Playwright).

Questions the grilling ticket may need to settle:
- Is there a per-org browser-hour/concurrency **spend limit**, and does it need to hold across a session left on `keep_alive` (Cloudflare bills concurrent browsers by daily peak, not per session)?
- Should a **proxy key** (Commissary-issued) authorize browser sessions, and does a live view link, which is a bearer JWT, need to be mediated by Commissary?
- Who may use a stored login: whole org, a team, or one member (**grant** model)? 1Password service accounts are vault-scoped, which maps cleanly to a per-credential or per-team grant.
- Agentic Autofill needs a human approval per fill; is that acceptable for unattended hosted Agents?

## Gaps and ambiguities
- 1Password Agentic Autofill availability beyond Browserbase Director and the Claude Mac flow: not confirmed; the primary announcement (2025-10-08) says Early Access.
- `@1password/sdk` on Workers: not confirmed.
- Browser Run: no documented extension support, no per-tenant quota, no documented cookie persistence. Absence in docs is not proof of absence in product.
- Steel and Browserbase Live View docs: I did not read Steel's live view or Browserbase's embedding limits.
- Pricing numbers are vendor list prices read on 2026-10-15 and change; Anchor's plan tiers were not found.
