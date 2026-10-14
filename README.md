# cf-llm-proxy

**Your own LLM gateway on Cloudflare Workers.** Pool your Claude, ChatGPT/Codex, Gemini/Vertex, Antigravity, xAI, Kimi
and other accounts and API keys behind one endpoint that speaks the OpenAI, Anthropic and Gemini APIs, with clients on
proxy keys and a built-in control panel behind Cloudflare Access.

- **One endpoint, every client.** Claude Code, Codex CLI, the OpenAI/Anthropic/Gemini SDKs and anything else that
  speaks those APIs; requests are translated between protocols, so Claude Code can run on a GPT model and vice versa.
- **Use the subscriptions you already pay for.** Log in with OAuth (Claude, Codex, Antigravity, xAI, Kimi, Devin, …) or
  add API keys; credentials rotate round-robin with cooldowns on rate limits and automatic token refresh.
- **Nothing to run.** A single Worker with Durable Objects, KV and D1. No servers, no containers, and it scales to zero.
- **Zero-trust by default.** People sign in to the control panel and management API through Cloudflare Access with
  your identity provider; tools send a proxy key each member creates in the panel, stored only as a hash and
  revocable at once; scripts use management keys or Access service tokens. The Worker stores no client passwords.
- **Or host it for others.** With `PROXY_MODE=hosted` the Worker signs people in itself with GitHub or Google, anyone
  may sign up and gets a Personal org, and platform admins limit and suspend people and orgs
  ([DEPLOY.md](docs/DEPLOY.md#hosted-proxy)).
- **Control panel.** Connect accounts, manage API keys, watch quotas and usage, shape model routing and edit the
  config at `/`.
- **Infrastructure as code.** The Worker, storage, Access application, policies and service tokens are declared in
  [`alchemy.run.ts`](alchemy.run.ts) and deployed with one command.

```text
 Claude Code / Codex / SDKs ─────(proxy key)─────► cf-llm-proxy Worker ──► Claude, OpenAI, Gemini, xAI, …
 Browser (control panel) ──► Cloudflare Access ──►  (translate, pick an     (your OAuth logins and
                            (your IdP + tokens)      account, refresh)       API keys)
```

## Contents

- [Deploy](#deploy)
- [Connect a client](#connect-a-client)
- [Configuration](#configuration)
- [Updating and removing](#updating-and-removing)
- [Troubleshooting](#troubleshooting)
- [Provider support](#provider-support)
- [Known limitations](#known-limitations)
- [Local development](#local-development)
- [Documentation](#documentation)
- [Acknowledgements](#acknowledgements)

## Deploy

### Prerequisites

- A Cloudflare account on the **Workers Paid** plan (requests may use up to 300 s of CPU; see `CF_LLM_PROXY_CPU_MS`).
- A domain (zone) in that account. The proxy gets its own hostname on it, e.g. `llm.example.com`.
- **Zero Trust** enabled on the account, with an identity provider (the built-in one-time PIN works). Note your team
  name: `<team>.cloudflareaccess.com`.
- Node.js 22+ and pnpm 12 (the version pinned in `package.json` `devEngines`).

### 1. Clone and install

```bash
git clone https://github.com/ian-pascoe/cf-llm-proxy.git
cd cf-llm-proxy
pnpm install
```

`pnpm install` also clones the upstream Go server into `.repos/` (a read-only reference for development; the deploy
does not use it).

### 2. Log in to Cloudflare

```bash
pnpm exec alchemy profile edit --add Cloudflare
```

Choose browser OAuth or paste an API token. The profile is stored in `~/.alchemy/profiles.json`.

### 3. Configure

```bash
cp .env.example .env
```

Fill in at least these (`.env` is git-ignored; shell variables override it):

| Variable                                          | Example           | Purpose                                                                                                           |
| ------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `CF_LLM_PROXY_DOMAIN`                             | `llm.example.com` | Hostname of the proxy; its zone must be in the account                                                            |
| `ACCESS_TEAM_DOMAIN`                              | `myteam`          | Your Zero Trust team name                                                                                         |
| `ACCESS_ALLOW_EMAILS` / `_EMAIL_DOMAINS`          | `you@example.com` | Who may sign in through the browser                                                                               |
| `ACCESS_SERVICE_TOKENS`                           | `laptop,ci`       | One Access service token is created per name, for scripts that use the management API                             |
| `PLATFORM_ADMIN_EMAILS` / `_ADMIN_SERVICE_TOKENS` | `you@example.com` | Platform admins: who may open the control panel and management API, and create orgs (emails, service token names) |

Every other setting is optional; see [Configuration](#configuration). The Worker needs **no provider secrets** in
`.env`: accounts and API keys are added later through the control panel and stored in a Durable Object.

### 4. Build and deploy

```bash
pnpm web:build                  # build the control panel into public/
pnpm run deploy --stage prod    # shows the plan, asks for confirmation, deploys
```

The first deploy asks to bootstrap Alchemy's state store (a small Worker and Secrets Store in your account that keeps
the deploy state, shared by every machine that deploys; set `ALCHEMY_STATE=local` to keep it in `.alchemy/` instead).
Use the same `--stage` for every later deploy (`pnpm plan --stage prod` previews changes).

The deploy prints the URL, the Access AUD tag and each service token's Client ID. Cloudflare returns the Client
Secrets only once: they are written to `.alchemy/access-service-tokens.json` (mode 0600) on the deploying machine.

### 5. Verify

```bash
export CF_ACCESS_CLIENT_ID='<id>.access'          # from .alchemy/access-service-tokens.json
export CF_ACCESS_CLIENT_SECRET='<secret>'

curl https://llm.example.com/healthz \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
# {"status":"ok"}
```

### 6. Add accounts

Open `https://llm.example.com/` and sign in through Access with an admin email. Then:

- **Connect account** (top bar) logs in to Claude, Codex, Antigravity, xAI, Kimi, … or uploads existing auth files;
- **API keys** adds provider keys (Claude, OpenAI-compatible upstreams, Gemini, Vertex, OpenCode Zen/Go, …);
- **Proxy keys** creates the key your clients send (shown once: copy it).

Coming from the Go CLIProxyAPI server? [MIGRATION.md](docs/MIGRATION.md) imports your config and auth files.

## Connect a client

Clients send a proxy key (control panel, **Proxy keys**) where they send a provider API key: `Authorization: Bearer`,
`x-api-key` or `x-goog-api-key`/`?key=`. The proxy routes are not behind Access, so no Access headers are needed.

```bash
export PROXY_KEY='cfp_…'
H=(-H "Authorization: Bearer $PROXY_KEY")

curl "${H[@]}" https://llm.example.com/v1/models
curl "${H[@]}" https://llm.example.com/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"<model id from /v1/models>","messages":[{"role":"user","content":"hi"}]}'
```

**Claude Code:**

```bash
export ANTHROPIC_BASE_URL=https://llm.example.com
export ANTHROPIC_AUTH_TOKEN="$PROXY_KEY"
claude
```

[CLIENTS.md](docs/CLIENTS.md) covers Codex CLI, the OpenAI, Anthropic and Gemini SDKs and browser use. Clients that
signed in through Access before proxy keys: [MIGRATION.md](docs/MIGRATION.md#5-move-clients-to-proxy-keys).

**Endpoints.** `POST /v1/chat/completions`, `/v1/completions`, `/v1/messages`, `/v1/messages/count_tokens`,
`/v1/responses` (+ `/compact`, and a `GET` WebSocket upgrade), `GET /v1/models`, `/v1beta/models/*`
(`:generateContent`, `:streamGenerateContent`, …), `POST /v1beta/interactions`, images, videos and speech under `/v1`,
plus `/openai/v1/videos` and `/backend-api/codex/{responses,responses/compact,alpha/search}`. `/chat/completions`,
`/completions` and `/responses` are also served without `/v1`, so one base URL fits clients that append
`/v1/messages` for Anthropic models and `/chat/completions` for OpenAI models.

## Configuration

Deploy settings live in `.env` (template with comments: [`.env.example`](.env.example)). Runtime settings (routing,
model aliases, retries, …) are edited in the control panel and stored in the Worker as config entries; a Go `config.yaml`
(payload rules included) is imported with `POST /v8/management/settings/import` ([docs/MIGRATION.md](docs/MIGRATION.md)).

| Variable                         | Default    | Purpose                                                                                                                            |
| -------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `CF_LLM_PROXY_DOMAIN`            | (required) | Custom hostname of the Worker and of its Access application                                                                        |
| `CF_LLM_PROXY_API_DOMAIN`        |            | A second hostname that alone serves the proxy routes, outside Access ([docs/DEPLOY.md](docs/DEPLOY.md#api-host))                   |
| `ACCESS_TEAM_DOMAIN`             | (required) | Zero Trust team name or `<team>.cloudflareaccess.com`                                                                              |
| `ACCESS_ALLOW_EMAILS`            |            | Emails allowed to sign in (comma separated)                                                                                        |
| `ACCESS_ALLOW_EMAIL_DOMAINS`     |            | Email domains allowed to sign in                                                                                                   |
| `ACCESS_SERVICE_TOKENS`          |            | Names of the service tokens to create, one per script or machine using the management API                                          |
| `ACCESS_ALLOW_SERVICE_TOKEN_IDS` |            | Service tokens managed elsewhere (by token ID) to admit as well, e.g. CI's                                                         |
| `PLATFORM_ADMIN_EMAILS`          |            | Platform admins of the control panel and management API (replaces `ACCESS_ADMIN_EMAILS`, still read)                               |
| `PLATFORM_ADMIN_SERVICE_TOKENS`  |            | Service token names (from `ACCESS_SERVICE_TOKENS`) or Client IDs that are platform admins (replaces `ACCESS_ADMIN_SERVICE_TOKENS`) |
| `ACCESS_SESSION_DURATION`        | `24h`      | Access session length for browser sign-ins                                                                                         |
| `ACCESS_SERVICE_TOKEN_HEADER`    |            | Accept service tokens as JSON in one header (e.g. `x-api-key`) for management scripts without custom headers                       |
| `ACCESS_AUD`                     |            | Use an Access application you manage yourself instead of creating one                                                              |
| `CF_LLM_PROXY_CPU_MS`            | `300000`   | CPU limit per request in ms; lower it on plans with smaller limits                                                                 |
| `PROXY_MODE`                     |            | `hosted` for a hosted proxy (own sign-in, no Access; its settings: [DEPLOY.md](docs/DEPLOY.md#hosted-proxy))                       |

[ACCESS.md](docs/ACCESS.md) explains what each Access setting creates, how the Worker validates requests, and how to
extend the policies (IdP groups, device posture).

## Updating and removing

```bash
git pull && pnpm install && pnpm web:build && pnpm run deploy --stage prod   # update
pnpm logs --stage prod --tail                                               # stream Worker logs
pnpm destroy --stage prod                                                   # remove everything
```

D1 migrations run on every deploy. `destroy` deletes the Durable Objects holding your credentials and the usage
history: export accounts from the panel first if you want to keep them.

A cron trigger (`0 */3 * * *`) refreshes the model catalog from [models.dev](https://models.dev) (also on demand from
the Models page), prunes old usage rows and re-arms credential refresh alarms.

**Continuous deployment.** `.github/workflows/ci.yml` deploys `main` to production and, once set up, to a hosted proxy on
its own domain (stage `hosted`), and every pull request to its own preview stage on `workers.dev`. The CI credentials are code too (`stacks/github.ts`, `pnpm ci:setup`); see
[DEPLOY.md](docs/DEPLOY.md).

## Troubleshooting

| Symptom                                     | Fix                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Deploy fails on the custom domain           | `CF_LLM_PROXY_DOMAIN` must be a hostname on a zone in the same Cloudflare account           |
| Client gets 401 `Missing API key`           | Send a proxy key (`Authorization: Bearer cfp_…`, `x-api-key` or `x-goog-api-key`)           |
| Client gets 401 `Invalid API key`           | The proxy key is wrong, revoked or expired: create a new one on the Proxy keys page         |
| Client gets a 302 to `cloudflareaccess.com` | Its path is not a proxy route, or the deploy's bypass application is missing (`ACCESS_AUD`) |
| Client gets 404 `Not found: …`              | With `CF_LLM_PROXY_API_DOMAIN` set, send the proxy routes to the API host the message names |
| 500 `Authentication service error`          | `ACCESS_TEAM_DOMAIN` is wrong                                                               |
| 403 `Forbidden` on the control panel        | Your email or token is not in `PLATFORM_ADMIN_EMAILS` / `PLATFORM_ADMIN_SERVICE_TOKENS`     |
| A model is missing from `/v1/models`        | No connected account or API key serves it; check the Accounts and Models pages              |
| Responses WebSocket closes with 1011/1012   | It hit the Worker CPU limit; clients reconnect, or use HTTP/SSE                             |

More Access-specific answers: [ACCESS.md#troubleshooting](docs/ACCESS.md#troubleshooting).

## Provider support

| Provider (credential)                                      | Client protocols served                                  | Notes                                                                                                      |
| ---------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Claude (OAuth login, API key)                              | OpenAI, Responses, Claude, Gemini, Interactions          | Claude Code cloaking and body signing; no uTLS (see limitations)                                           |
| Codex / ChatGPT (OAuth browser or device, API key)         | OpenAI, Responses (HTTP + WebSocket), Claude, Gemini     | `/backend-api/codex/*` aliases; no Codex live/realtime                                                     |
| Gemini (API key), Vertex (API key, service account upload) | OpenAI, Claude, Gemini, Responses, Interactions          | No Gemini OAuth: Gemini-CLI auth files are rejected on import                                              |
| Antigravity (OAuth)                                        | OpenAI, Claude, Gemini, Interactions                     |                                                                                                            |
| xAI (device login, API key)                                | OpenAI, Responses (HTTP + WebSocket), images, video, TTS |                                                                                                            |
| Kimi / Kimi.ai (device login), Meta, Devin                 | OpenAI, Claude, Responses                                | Devin: authorization-code login                                                                            |
| OpenCode Zen / OpenCode Go (API key)                       | every client protocol                                    | Chat, Responses, Messages (and Zen Gemini) per model; Go keys show their usage quotas on the Accounts page |
| OpenAI-compatible upstreams (API key)                      | every client protocol                                    | Configured as `api-keys.openai-compatibility` groups                                                       |

The matrix is indicative: which (client protocol, provider) pairs work follows the registered translators in
`src/translator/builtin.ts`; an unsupported pair answers with a 4xx/501 error.

## Known limitations

- **No TLS fingerprint impersonation.** Workers `fetch` cannot control the TLS ClientHello or HTTP/2 settings, so
  `wire-policy`/`tls-fingerprint` settings are ignored. Claude Code header and body cloaking still applies; providers
  that fingerprint TLS may treat the traffic differently.
- **Egress IPs are Cloudflare's.** Requests leave from Cloudflare data-centre addresses, not your own IP, and cannot be
  pinned. Providers that bind sessions to an IP or block cloud ranges may reject or challenge them.
- **No outbound proxies.** `proxy-url` (global, per credential, per key group) is read but not applied.
- **WebSocket CPU limit.** A Responses WebSocket lives in the invocation that accepted it and is bounded by the CPU
  limit (`CF_LLM_PROXY_CPU_MS`). There are no ping keep-alives (`streaming.keepalive-seconds` is ignored).
- **Not supported:** plugins, TUI, mDNS discovery, pprof, git/Postgres/object-store config backends, request-log files,
  Codex live/realtime (WebRTC/SIP), the AI Studio `wsrelay` gateway, `/v0/management` and the Go server's client API keys
  (proxy keys replace them). `/v1/responses/compact` answers 501 for Gemini/Vertex credentials.

Per-provider details: [ARCHITECTURE.md](docs/ARCHITECTURE.md); config keys without effect:
[MIGRATION.md](docs/MIGRATION.md).

## Local development

```bash
pnpm install
pnpm web:build                     # or `pnpm web:dev` for the panel with hot reload on :5173
ALCHEMY_STATE=local pnpm dev       # Worker on http://localhost:1337 with hot reload
```

`alchemy dev` runs the Worker in local workerd with emulated KV, D1 and Durable Objects. No Cloudflare resources are
created, and with `ALCHEMY_STATE=local` no Cloudflare login is needed. Access is not provisioned in dev: every request
to a loopback host is treated as the admin `dev@example.com` (override with `ACCESS_DEV_BYPASS`). The bypass is ignored
for any other host, refused whenever `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` is set, and never reaches a deployed Worker.

Open `http://localhost:1337/`, connect an account, then:

```bash
curl localhost:1337/v1/models
curl 'localhost:1337/cdn-cgi/handler/scheduled?cron=0+*/3+*+*+*'   # run the cron jobs
```

Before sending a change: `pnpm typecheck && pnpm lint && pnpm test && pnpm smoke`. Scripts, module layout and
conventions are in [DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Documentation

| Guide                                   | Contents                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| [ACCESS.md](docs/ACCESS.md)             | Access application, policies, service tokens, management keys, hosted sign-in, security model |
| [CLIENTS.md](docs/CLIENTS.md)           | Claude Code, Codex CLI, SDKs, curl                                                            |
| [DEPLOY.md](docs/DEPLOY.md)             | CI deploys, preview stages, hosted proxy, operations                                          |
| [MIGRATION.md](docs/MIGRATION.md)       | Moving from the Go CLIProxyAPI server                                                         |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md)   | Scripts, module layout, conventions                                                           |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Design decisions and per-subsystem behaviour                                                  |
| [GLOSSARY.md](GLOSSARY.md)              | Domain terms                                                                                  |

## Acknowledgements

cf-llm-proxy began as a TypeScript + [Effect](https://effect.website) port of
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) by Router-For.ME, and still uses it as the reference for
translators, thinking, payload rules and provider behaviour. Thanks to its authors and contributors.

## License

[MIT](LICENSE), including the original CLIProxyAPI copyright notice.
